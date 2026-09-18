// ============================================================================
// Automation dashboard (dashboard/automation.js)
// ============================================================================
// The "upload the questions directly in the web app / automate the task" page:
// publish quiz polls to Telegram without dropping to the CLI, queue batches for
// a planned time, and see each subject's cadence and remaining runway.
//
// Posting is the most consequential action in this whole app — it writes to a
// public channel — so the button confirms first, the server re-checks the
// curator's identity, and the default eligibility is Approved-only.
// ============================================================================

import {
  initDashboard, api, apiStream, el, replaceChildren, statCard, emptyState, pill,
  num, showToast, $, SUBJECTS
} from './shared.js';
import {
  availableToPost, resolvePostCount, estimateDuration, runPostBatches
} from './post-plan.js';

/** Latest analytics payload, used for runway and pending counts. */
let analytics = null;

/** True while a posting run is in progress. */
let posting = false;

/** Set by the Stop button. */
let stopRequested = false;

/** Telegram bot connection state from /api/telegram/status. */
let botState = { configured: false, connected: false };

// ---------------------------------------------------------------------------
// Logging panel
// ---------------------------------------------------------------------------

/** Appends a line to one of the two on-page log panels. */
function log(target, text, tone = 'muted') {
  const box = $(target);
  box.style.display = 'block';
  box.append(el('div', { class: 'log-line ' + tone, text }));
  box.scrollTop = box.scrollHeight;
}

/** Clears a log panel before a new run. */
function clearLog(target) {
  const box = $(target);
  replaceChildren(box);
  box.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Headline tiles: what is ready to go out right now. */
function renderStats() {
  if (!analytics) return;
  const t = analytics.totals;

  const readyNow = analytics.subjects.reduce((sum, s) => sum + s.approved + s.scheduled, 0);
  const dry = analytics.subjects.filter((s) => s.active && s.pending === 0).length;
  const urgent = analytics.subjects.filter((s) => s.daysOfRunway !== null && s.daysOfRunway < 2).length;

  replaceChildren($('statGrid'),
    statCard('Ready to Post', num(readyNow), { tone: 'ok', sub: 'Approved or Scheduled, not yet sent' }),
    statCard('Pending Total', num(t.pending), { tone: 'info', sub: 'all unposted questions' }),
    statCard('Posted All Time', num(t.posted), { tone: 'ok' }),
    statCard('Subjects Out of Stock', num(dry), { tone: dry ? 'danger' : 'ok', sub: 'active but nothing left to post' }),
    statCard('Running Dry Soon', num(urgent), { tone: urgent ? 'warn' : 'ok', sub: 'under 2 days of runway' }),
    statCard('Telegram Bot',
      botState.connected ? 'Online' : botState.configured ? 'Error' : 'Not set',
      { tone: botState.connected ? 'ok' : 'danger', sub: botState.botUsername ? '@' + botState.botUsername : '' })
  );
}

/** Fills both subject dropdowns and keeps the summary line in sync. */
function initSubjectSelects() {
  [$('postSubject'), $('scheduleSubject')].forEach((select) => {
    replaceChildren(select, ...SUBJECTS.map((s) => el('option', { value: s, text: s })));
  });

  $('postSubject').addEventListener('change', renderSubjectSummary);
  renderSubjectSummary();
}

/** One-line description of the selected subject's current stock. */
function renderSubjectSummary() {
  const target = $('subjectSummary');
  if (!analytics) { target.textContent = ''; return; }

  const subject = $('postSubject').value;
  const entry = analytics.subjects.find((s) => s.subject === subject);

  if (!entry || entry.total === 0) {
    target.textContent = `"${subject}" has no questions yet — upload some on the Upload dashboard first.`;
    return;
  }

  const ready = entry.approved + entry.scheduled;
  target.textContent =
    `"${subject}": ${num(entry.total)} total · ${num(entry.posted)} posted · ${num(entry.pending)} pending · ` +
    `${num(ready)} Approved/Scheduled and eligible right now` +
    (entry.threadId ? ` · topic thread #${entry.threadId}` : ' · ⚠️ no Telegram topic configured');
}

/** Eligible stock for the currently selected subject and eligibility. */
function currentAvailable() {
  if (!analytics) return 0;
  const entry = analytics.subjects.find((s) => s.subject === $('postSubject').value);
  return availableToPost(entry, $('requireApproved').value === 'true');
}

/**
 * renderPostCount — shows the custom input when needed, caps it at the
 * eligible stock, and explains what the current choice will do.
 * Returns the resolved count so callers can reuse the validation.
 */
function renderPostCount() {
  const choice = $('postCount').value;
  const custom = $('postCustomCount');
  const hint = $('postCountHint');
  const available = currentAvailable();

  $('postCustomField').hidden = choice !== 'custom';
  custom.max = String(Math.max(1, available));

  if (!analytics) { hint.textContent = ''; return { ok: false, error: 'Subject data is still loading.' }; }

  const resolved = resolvePostCount(choice, custom.value, available);
  custom.setAttribute('aria-invalid', String(choice === 'custom' && !resolved.ok && custom.value !== ''));

  if (!resolved.ok) {
    hint.textContent = choice === 'custom' && custom.value === ''
      ? `Enter a number from 1 to ${available}.`
      : resolved.error;
    hint.style.color = choice === 'custom' && custom.value === '' ? '' : 'var(--accent-danger)';
  } else {
    hint.style.color = '';
    hint.textContent = choice === 'all' || choice === 'custom'
      ? `Will post ${num(resolved.count)} of ${num(available)} eligible question(s) — ${estimateDuration(resolved.count)}.`
      : '';
  }

  if (!posting) $('postNowBtn').disabled = !resolved.ok && (choice === 'all' || choice === 'custom');
  return resolved;
}

/** Table of cron cadence, batch size and runway per subject. */
function renderCadence() {
  const area = $('cadenceArea');
  if (!analytics) return;

  const subjects = analytics.subjects.slice().sort((a, b) => {
    // Most urgent first: anything with a runway, shortest at the top.
    const av = a.daysOfRunway === null ? Infinity : a.daysOfRunway;
    const bv = b.daysOfRunway === null ? Infinity : b.daysOfRunway;
    return av - bv;
  });

  if (!subjects.length) {
    replaceChildren(area, emptyState('📭', 'No subjects configured yet.'));
    return;
  }

  replaceChildren(area, el('table', { class: 'data-table' }, [
    el('thead', {}, [el('tr', {},
      ['Subject', 'Active', 'Cron', 'Runs/Day', 'Batch', 'Pending', 'Approved', 'Runway', 'Thread', 'Last Posted']
        .map((h) => el('th', { text: h })))]),
    el('tbody', {}, subjects.map((s) => el('tr', {}, [
      el('td', { text: s.subject, style: 'font-weight:600' }),
      el('td', {}, [pill(s.active ? 'Active' : 'Paused', s.active ? 'ok' : 'muted')]),
      el('td', {}, [s.cron ? el('span', { class: 'inline-code', text: s.cron }) : el('span', { class: 'muted', text: '—' })]),
      el('td', { class: 'num', text: num(s.postsPerDay) }),
      el('td', { class: 'num', text: num(s.batchSize) }),
      el('td', { class: 'num', text: num(s.pending) }),
      el('td', { class: 'num', text: num(s.approved) }),
      el('td', {}, [
        s.daysOfRunway === null
          ? el('span', { class: 'muted', text: '—' })
          : pill(s.daysOfRunway < 1 ? '<1 day' : `${s.daysOfRunway} days`,
                 s.daysOfRunway < 2 ? 'danger' : s.daysOfRunway < 7 ? 'warn' : 'ok')
      ]),
      el('td', {}, [
        s.threadId
          ? el('span', { class: 'inline-code', text: '#' + s.threadId })
          : pill('not set', 'danger')
      ]),
      el('td', { class: 'muted', style: 'font-size:0.78rem', text: s.lastPostedAt || '—' })
    ])))
  ]));
}

/** Reference list of the equivalent CLI commands. */
function renderCliList() {
  const commands = [
    ['🚀', 'node send.js --subject Polity --count 5', 'Send five pending Polity questions right now.'],
    ['🌐', 'node send.js --all --count 3', 'Send three questions from every active subject.'],
    ['📊', 'node send.js --stats', 'Print total / posted / pending per subject in the terminal.'],
    ['⏰', 'node schedule.js', 'Run the cron scheduler in the foreground using the Config tab cadence.'],
    ['🔍', 'node schedule.js --dry-run', 'Show what the scheduler would do without sending anything.'],
    ['🧵', 'node setup.js', 'Create the Telegram forum topics and write the thread ids into Config.'],
    ['🩺', 'node send.js --test', 'Verify the bot token and group id are working.']
  ];

  replaceChildren($('cliList'), ...commands.map(([icon, command, detail]) => el('div', { class: 'check-item' }, [
    el('span', { class: 'check-icon', text: icon }),
    el('div', {}, [
      el('div', { class: 'check-title' }, [el('span', { class: 'inline-code', text: command })]),
      el('div', { class: 'check-detail', text: detail })
    ]),
    null
  ])));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Posting progress
// ---------------------------------------------------------------------------
// A run is minutes of Telegram sends and sheet writes. The server streams a
// line for every step and every question, and this panel turns them into a
// bar, a count, the step in progress, elapsed time and an estimate of what is
// left — so a slow run is visibly moving and a stuck one is visibly stuck.

/** Questions asked of the server per request. Twelve seconds each keeps a
 *  request well inside the server's four-minute posting budget. */
const POST_REQUEST_SIZE = 10;

const progress = { total: 0, done: 0, posted: 0, failed: 0, startedAt: 0, timer: null };

/** m:ss for the elapsed / remaining readout. */
function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderProgress() {
  const { total, done, posted, failed, startedAt } = progress;
  const pctDone = total ? Math.min(100, Math.round((done / total) * 100)) : 0;

  $('postProgressCount').textContent =
    `${num(posted)} of ${num(total)} posted` + (failed ? ` · ${num(failed)} failed` : '');
  $('postProgressFill').style.width = pctDone + '%';
  $('postProgressFill').classList.toggle('has-failures', failed > 0);
  $('postProgressTrack').setAttribute('aria-valuenow', String(pctDone));

  const elapsed = Date.now() - startedAt;
  let time = `${clock(elapsed)} elapsed`;
  if (done > 0 && done < total) {
    time += ` · ~${clock((elapsed / done) * (total - done))} left`;
  }
  $('postProgressTime').textContent = time;
}

function setStage(text, { indeterminate } = {}) {
  $('postProgressStage').textContent = text;
  if (indeterminate !== undefined) {
    $('postProgressTrack').classList.toggle('indeterminate', indeterminate);
  }
}

function startProgress(total, subject) {
  Object.assign(progress, { total, done: 0, posted: 0, failed: 0, startedAt: Date.now() });
  $('postProgress').hidden = false;
  $('postProgressTitle').textContent = `Posting to "${subject}"`;
  setStage('Connecting to the sheet…', { indeterminate: true });
  renderProgress();
  clearInterval(progress.timer);
  progress.timer = setInterval(renderProgress, 1000);
}

function endProgress(title, stage) {
  clearInterval(progress.timer);
  progress.timer = null;
  $('postProgressTitle').textContent = title;
  setStage(stage, { indeterminate: false });
  renderProgress();
  $('postProgressTime').textContent = `took ${clock(Date.now() - progress.startedAt)}`;
}

/** Applies one streamed line from /api/telegram/post. */
function onPostEvent(event) {
  if (event.type === 'stage') {
    // Only the pre-send steps leave the bar without a percentage.
    setStage(event.text, { indeterminate: progress.done === 0 });
  } else if (event.type === 'sending') {
    setStage(`Sending ${num(progress.done + 1)} of ${num(progress.total)}: ${event.questionId} — ${event.preview}`,
      { indeterminate: false });
  } else if (event.type === 'result') {
    progress.done++;
    if (event.ok) progress.posted++; else progress.failed++;
    log('postLog',
      (event.ok ? '✅ ' : '❌ ') + (event.questionId || '') + ' — ' + (event.ok ? event.preview : event.error),
      event.ok ? 'ok' : 'fail');
    renderProgress();
  }
}

/** Set while a run is in flight; Stop aborts it. */
let postAbort = null;

/**
 * Posts the selected number of questions to Telegram after an explicit
 * confirmation. Large runs go as consecutive requests of POST_REQUEST_SIZE that
 * stop on the first failure. Stop takes effect after the question in hand: the
 * server puts every question it had not reached back in the queue.
 */
async function postNow() {
  if (posting) return;
  const subject = $('postSubject').value;
  const choice = $('postCount').value;
  const requireApproved = $('requireApproved').value === 'true';
  const button = $('postNowBtn');
  const stopButton = $('postStopBtn');

  const resolved = renderPostCount();
  if (!resolved.ok) {
    showToast('error', resolved.error);
    if (choice === 'custom') $('postCustomCount').focus();
    return;
  }
  const count = resolved.count;

  if (!botState.connected) {
    showToast('error', botState.configured
      ? 'The Telegram bot is configured but not reachable — check the Health dashboard.'
      : 'Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_GROUP_ID in .env.');
    return;
  }

  // Posting is public and irreversible, so it always asks first.
  const confirmed = window.confirm(
    (choice === 'all'
      ? `Post ALL ${count} eligible question(s) from "${subject}" to Telegram now?`
      : `Post up to ${count} question(s) from "${subject}" to Telegram now?`) +
    `\n\nThis takes ${estimateDuration(count)}. You can watch each question go out, and stop at any time.` +
    '\n\n' +
    (requireApproved
      ? 'Only Approved or Scheduled questions will be sent.'
      : '⚠️ Draft questions are included — they may not have been reviewed.') +
    '\n\nThis publishes to your live channel and cannot be undone from here.'
  );
  if (!confirmed) return;

  clearLog('postLog');
  startProgress(count, subject);

  posting = true;
  stopRequested = false;
  postAbort = new AbortController();
  button.disabled = true;
  button.textContent = 'Posting…';
  stopButton.hidden = false;
  stopButton.disabled = false;
  stopButton.textContent = '⏹ Stop posting';

  let outcome = null;
  let failure = null;
  try {
    outcome = await runPostBatches({
      total: count,
      batchLimit: POST_REQUEST_SIZE,
      shouldStop: () => stopRequested,
      postBatch: (size) => apiStream('/api/telegram/post', {
        body: { subject, count: size, requireApproved },
        signal: postAbort.signal,
        onEvent: onPostEvent
      }),
      onBatch: (result) => {
        if ((result.recoveredRows || []).length) {
          log('postLog',
            `♻️ ${result.recoveredRows.length} question(s) left behind by an interrupted run were put back in the queue.`,
            'muted');
        }
        log('postLog', result.message, result.failedCount ? 'fail' : (result.postedCount ? 'ok' : 'muted'));
      }
    });
  } catch (err) {
    failure = err;
  }

  const stoppedByUser = stopRequested && (!failure || failure.name === 'AbortError');
  let title;
  let summary;
  let tone;
  if (stoppedByUser) {
    title = 'Stopped';
    summary = `Stopped as asked — ${progress.posted} of ${count} question(s) posted to "${subject}". ` +
      'The question being sent when you pressed Stop may still go out; the rest are back in the queue.';
    tone = 'info';
  } else if (failure) {
    title = 'Posting failed';
    summary = `Failed after ${progress.posted} posted: ${failure.message}`;
    tone = 'error';
  } else {
    summary = {
      done: `Done — ${outcome.posted} of ${count} question(s) posted to "${subject}".`,
      stopped: `Stopped as asked — ${outcome.posted} of ${count} question(s) posted to "${subject}".`,
      failed: `Stopped after a failure — ${outcome.posted} of ${count} posted. Check the errors above before posting more.`,
      exhausted: `Queue empty — ${outcome.posted} of ${count} question(s) posted; nothing else was eligible.`
    }[outcome.stopReason];
    title = { done: 'Done', stopped: 'Stopped', failed: 'Stopped after a failure', exhausted: 'Queue empty' }[outcome.stopReason];
    tone = outcome.stopReason === 'failed' ? 'warn' : outcome.posted === 0 ? 'info' : 'success';
  }

  endProgress(title, summary);
  log('postLog', summary, tone === 'error' || tone === 'warn' ? 'fail' : 'ok');
  showToast(tone, summary, tone === 'error' ? 9000 : 5000);

  posting = false;
  postAbort = null;
  button.disabled = false;
  button.textContent = '🚀 Post to Telegram';
  stopButton.hidden = true;
  // Refresh the counts so runway, pending totals and the custom cap reflect
  // what just went out. renderPostCount() re-applies the button state.
  try { await loadAnalytics(); } catch (refreshErr) { console.error(refreshErr); }
  renderPostCount();
}

/**
 * reconcileChannel — finds posted questions whose poll is no longer in Telegram.
 *
 * Runs read-only first and reports what it found, because putting a question
 * back in the queue means it will be posted again — a decision that belongs to
 * a person, not to a background check.
 */
async function reconcileChannel() {
  const subject = $('postSubject').value;
  const button = $('reconcileBtn');

  clearLog('reconcileLog');
  log('reconcileLog', `Checking every posted question in "${subject}" is still in the channel…`);
  log('reconcileLog', 'Each one is a separate Telegram call, so this is not instant.', 'muted');

  button.disabled = true;
  button.textContent = 'Checking…';

  try {
    const found = await api('/api/telegram/reconcile', {
      method: 'POST',
      body: { subject, apply: false }
    });

    (found.unknown || []).forEach((id) =>
      log('reconcileLog', `• ${id} — could not be checked, left alone`, 'muted'));

    if (!found.missing.length) {
      log('reconcileLog', `All ${found.checked} posted question(s) are still in the channel.`, 'ok');
      showToast('success', 'Nothing missing — the sheet matches the channel.');
      return;
    }

    // The message id is shown because it is how you spot a row whose id is
    // wrong rather than whose poll is gone — re-queueing one of those would
    // post a question that is already live.
    found.missing.forEach((m) =>
      log('reconcileLog', `• ${m.questionId} (row ${m.row}, msg ${m.messageId}) — not in the channel`, 'fail'));

    const confirmed = window.confirm(
      `${found.missing.length} posted question(s) are no longer in the channel.\n\n` +
      'Put them back in the queue as Approved?\n\n' +
      'They will be eligible to post again, and their old message id is cleared.'
    );
    if (!confirmed) {
      log('reconcileLog', 'Left as they are. Nothing changed.', 'muted');
      return;
    }

    const applied = await api('/api/telegram/reconcile', {
      method: 'POST',
      body: { subject, apply: true }
    });
    log('reconcileLog', applied.message, 'ok');
    showToast('success', applied.message);
    await loadAnalytics();
  } catch (err) {
    log('reconcileLog', 'Failed: ' + err.message, 'fail');
    showToast('error', err.message, 9000);
  } finally {
    button.disabled = false;
    button.textContent = '🔍 Check the channel for deleted polls';
  }
}

/** Marks the next N pending questions of a subject as Scheduled. */
async function queueForLater() {
  const subject = $('scheduleSubject').value;
  const count = Number($('scheduleCount').value);
  const when = $('scheduleWhen').value.trim();
  const button = $('scheduleBtn');

  clearLog('scheduleLog');
  button.disabled = true;
  button.textContent = 'Queueing…';

  try {
    // Find the next pending question ids for this subject, oldest first.
    log('scheduleLog', `Finding the next ${count} pending question(s) in "${subject}"…`);
    const page = await api('/api/questions', {
      query: { subject, posted: 'NO', page: 1, pageSize: count }
    });

    const candidates = (page.questions || [])
      .filter((q) => q.status !== 'Rejected' && q.status !== 'Archived')
      .map((q) => q.question_id)
      .filter(Boolean);

    if (!candidates.length) {
      log('scheduleLog', `Nothing pending in "${subject}".`, 'muted');
      showToast('info', `No pending questions to queue in "${subject}".`);
      return;
    }

    const result = await api('/api/questions/schedule', {
      method: 'POST',
      body: { subject, questionIds: candidates, scheduledFor: when }
    });

    candidates.forEach((id) => log('scheduleLog', '📅 ' + id + ' → Scheduled' + (when ? ' for ' + when : ''), 'ok'));
    log('scheduleLog', `${result.updatedCount} question(s) queued.`, 'ok');
    showToast('success', `${result.updatedCount} question(s) queued in "${subject}".`);

    await loadAnalytics();
  } catch (err) {
    log('scheduleLog', 'Failed: ' + err.message, 'fail');
    showToast('error', err.message, 9000);
  } finally {
    button.disabled = false;
    button.textContent = '📅 Queue Questions';
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Reloads analytics and repaints everything that depends on it. */
async function loadAnalytics() {
  analytics = await api('/api/analytics');
  renderStats();
  renderSubjectSummary();
  renderPostCount();
  renderCadence();
}

/** Checks whether the Telegram bot is reachable. */
async function loadBotStatus() {
  try {
    botState = await api('/api/telegram/status');
  } catch (err) {
    botState = { configured: false, connected: false, error: err.message };
  }

  const label = $('botStatus');
  if (botState.connected) {
    label.textContent = `🤖 Bot online: @${botState.botUsername}`;
  } else if (botState.configured) {
    label.textContent = '⚠️ Bot configured but unreachable';
  } else {
    label.textContent = '❌ Telegram not configured in .env';
  }
}

/** Full page load. */
async function load() {
  const button = $('refreshBtn');
  button.disabled = true;
  try {
    await loadBotStatus();
    await loadAnalytics();
  } catch (err) {
    showToast('error', err.message, 9000);
    replaceChildren($('cadenceArea'), emptyState('⚠️', 'Could not load subject data.', err.message));
  } finally {
    button.disabled = false;
  }
}

initDashboard({
  page: 'automation',
  onReady: async () => {
    initSubjectSelects();
    renderCliList();
    $('postNowBtn').addEventListener('click', postNow);
    $('postStopBtn').addEventListener('click', () => {
      stopRequested = true;
      $('postStopBtn').disabled = true;
      $('postStopBtn').textContent = 'Stopping…';
      setStage('Stopping — finishing the question in hand, then putting the rest back in the queue…');
      // Closing the stream is the signal: the server stops after the current
      // question and releases everything it had not reached.
      if (postAbort) postAbort.abort();
    });
    ['postSubject', 'requireApproved', 'postCount'].forEach((id) =>
      $(id).addEventListener('change', renderPostCount));
    $('postCustomCount').addEventListener('input', renderPostCount);
    $('postCustomCount').addEventListener('keydown', (e) => { if (e.key === 'Enter') postNow(); });
    window.addEventListener('beforeunload', (e) => {
      if (posting) { e.preventDefault(); e.returnValue = ''; }
    });
  $('reconcileBtn').addEventListener('click', reconcileChannel);
    $('scheduleBtn').addEventListener('click', queueForLater);
    $('refreshBtn').addEventListener('click', load);
    await load();
  }
});
