// ============================================================================
// Autopilot (src/autopilot.js)
// ============================================================================
// Keeps posting on its own: "every 5 minutes, send the next 20 questions in
// Polity, until there are none left".
//
// Before this, the only unattended posting was `node schedule.js` on a laptop
// (a cron expression in the Config tab, a terminal that has to stay open) or
// pressing "Post to Telegram" and waiting. Neither survives closing the tab,
// and neither can be started, watched or stopped from the dashboard.
//
// The design is deliberately dull:
//
//   - One job per group+subject. Two jobs for the same subject would race each
//     other for the same rows, and the posting lock would simply refuse the
//     second one every time.
//   - A polling tick, not one timer per job. `tick(now)` runs whatever is due
//     and returns what it did, so the in-process timer and a serverless cron
//     endpoint are the same code path — the second is the only way this can
//     work on Vercel, where nothing survives between requests.
//   - Runs never overlap. A job that is still posting is not started again, and
//     the next run is scheduled from when the last one FINISHED. A batch of 20
//     takes minutes; counting from the start would queue runs on top of a job
//     that is already behind.
//   - Every run is recorded. A job that stops posting has to be able to say
//     why, days later, without anyone having watched it happen.
//
// State lives in memory and, when a path is configured, in a small JSON file
// so a restart picks its jobs back up. Nothing here talks to Telegram or to
// Sheets directly: the work is injected, which is also what makes it testable
// without either.
// ============================================================================

const fs = require('fs');
const path = require('path');

/** Floor on the gap between runs. Telegram rate limits are per minute. */
const MIN_INTERVAL_MINUTES = 1;

/** Ceiling, so a typo cannot park a job a year out. */
const MAX_INTERVAL_MINUTES = 24 * 60;

/** How often the in-process timer looks for due jobs. */
const TICK_MS = Number(process.env.AUTOPILOT_TICK_MS) || 15000;

/** Runs kept per job for the dashboard's history. */
const HISTORY_LIMIT = 20;

/**
 * Consecutive runs that post nothing before a job stops itself.
 *
 * One empty run is normal — a batch can land exactly on the end of the queue.
 * Three in a row means the queue is genuinely empty, and a job that keeps
 * waking up to find nothing is just noise in the log and calls to Sheets.
 */
const EMPTY_RUNS_BEFORE_STOP = 3;

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * number — a whole number from whatever the dashboard sent.
 *
 * The fallback applies only when there is no usable value. `|| fallback` would
 * also swallow a deliberate 0, which is how "as often as allowed" would have
 * quietly become "every five minutes".
 */
function number(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

/** The key a group+subject pair is stored under. */
function jobKey(groupId, subject) {
  return `${groupId}::${subject}`;
}

/**
 * normaliseSettings — turns whatever the dashboard sent into a usable job.
 *
 * Every field is clamped rather than rejected: this is called from an HTTP
 * route, and a slider that sent 0 should become "as often as allowed", not a
 * 400 the curator has to decode.
 */
function normaliseSettings(raw = {}, { maxBatch = 20 } = {}) {
  return {
    intervalMinutes: clamp(number(raw.intervalMinutes, 5), MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES),
    batchSize: clamp(number(raw.batchSize, 1), 1, maxBatch),
    requireApproved: raw.requireApproved !== false,
    stopWhenEmpty: raw.stopWhenEmpty !== false,
    // 0 turns the deleted-poll check off. Otherwise it runs every Nth run,
    // because it costs one Telegram call per posted question and would
    // otherwise dominate a job that posts every five minutes.
    reconcileEveryRuns: clamp(number(raw.reconcileEveryRuns, 0), 0, 100)
  };
}

/**
 * createAutopilot — the scheduler.
 *
 * @param {Object} deps
 * @param {Function} deps.postBatch async ({ groupId, subject, count, requireApproved }) =>
 *   { postedCount, eligibleCount, failedCount, message }
 * @param {Function} [deps.reconcile] async ({ groupId, subject }) => { restored, checked }
 * @param {Function} [deps.now] Clock, injected so tests do not have to wait
 * @param {string} [deps.statePath] Where to persist jobs, or '' for memory only
 * @param {number} [deps.maxBatch] Largest batch a job may ask for
 */
function createAutopilot(deps = {}) {
  const postBatch = deps.postBatch;
  const reconcile = deps.reconcile || null;
  const now = deps.now || (() => Date.now());
  const maxBatch = deps.maxBatch || 20;
  const statePath = deps.statePath === undefined ? defaultStatePath() : deps.statePath;
  const log = deps.log || console;

  /** key -> job */
  const jobs = new Map();
  let timer = null;
  let ticking = false;

  // ---- Persistence --------------------------------------------------------
  // Best effort, always. A dashboard that will not start because it could not
  // write a cache file would be a worse failure than forgetting the jobs.

  function save() {
    if (!statePath) return;
    try {
      const rows = [...jobs.values()]
        .filter((job) => job.running)
        .map((job) => ({
          groupId: job.groupId,
          subject: job.subject,
          settings: job.settings,
          startedAt: job.startedAt,
          nextRunAt: job.nextRunAt,
          totals: job.totals,
          startedBy: job.startedBy
        }));
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ version: 1, jobs: rows }, null, 2));
    } catch (err) {
      log.warn(`[autopilot] could not save state to ${statePath}: ${err.message}`);
    }
  }

  function load() {
    if (!statePath) return;
    let parsed;
    try {
      if (!fs.existsSync(statePath)) return;
      parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (err) {
      log.warn(`[autopilot] ignoring unreadable state at ${statePath}: ${err.message}`);
      return;
    }

    for (const row of (parsed && parsed.jobs) || []) {
      if (!row || !row.groupId || !row.subject) continue;
      const job = blankJob(row.groupId, row.subject, normaliseSettings(row.settings, { maxBatch }));
      job.running = true;
      job.startedAt = row.startedAt || now();
      job.startedBy = row.startedBy || 'a previous run of this server';
      job.totals = Object.assign(job.totals, row.totals || {});
      // Never replay a run that was due while the server was down: that would
      // fire every missed interval at once the moment it comes back.
      job.nextRunAt = Math.max(Number(row.nextRunAt) || 0, now());
      jobs.set(jobKey(job.groupId, job.subject), job);
    }
    if (jobs.size) log.log(`[autopilot] resumed ${jobs.size} job(s) from ${statePath}`);
  }

  function blankJob(groupId, subject, settings) {
    return {
      groupId,
      subject,
      settings,
      running: false,
      busy: false,
      startedAt: null,
      startedBy: null,
      nextRunAt: null,
      stoppedReason: null,
      consecutiveEmptyRuns: 0,
      totals: { runs: 0, posted: 0, failed: 0, restored: 0 },
      history: []
    };
  }

  // ---- Commands -----------------------------------------------------------

  /**
   * start — begins (or reconfigures) the job for one group+subject.
   *
   * Reconfiguring a running job on the spot is deliberate: the alternative is
   * stop-then-start, and between those two calls a curator's queue is silently
   * not being posted.
   */
  function start(groupId, subject, rawSettings, startedBy) {
    const key = jobKey(groupId, subject);
    const settings = normaliseSettings(rawSettings, { maxBatch });
    const job = jobs.get(key) || blankJob(groupId, subject, settings);

    job.settings = settings;
    job.running = true;
    job.stoppedReason = null;
    job.consecutiveEmptyRuns = 0;
    job.startedAt = job.startedAt || now();
    job.startedBy = startedBy || job.startedBy || 'the dashboard';
    // The first batch goes out immediately. Asking for "every 5 minutes" and
    // then watching nothing happen for 5 minutes reads as a broken button.
    job.nextRunAt = now();

    jobs.set(key, job);
    save();
    ensureTimer();
    return describe(job);
  }

  /** stop — leaves the record in place so the history stays readable. */
  function stop(groupId, subject, reason) {
    const job = jobs.get(jobKey(groupId, subject));
    if (!job || !job.running) return null;
    job.running = false;
    job.nextRunAt = null;
    job.stoppedReason = reason || 'Stopped from the dashboard.';
    save();
    return describe(job);
  }

  /** stopAll — used when the process is going down. */
  function stopAll(reason) {
    const stopped = [];
    for (const job of jobs.values()) {
      if (!job.running) continue;
      job.running = false;
      job.nextRunAt = null;
      job.stoppedReason = reason || 'Stopped.';
      stopped.push(describe(job));
    }
    return stopped;
  }

  // ---- Running ------------------------------------------------------------

  /** Jobs that are running, due, and not already mid-batch. */
  function dueJobs(at) {
    return [...jobs.values()].filter((job) =>
      job.running && !job.busy && job.nextRunAt !== null && job.nextRunAt <= at);
  }

  /**
   * runJob — one batch for one job.
   *
   * Never throws. A job that cannot reach Sheets for a minute must not take
   * the whole scheduler down with it; the failure is recorded, and the job
   * tries again at its normal interval.
   */
  async function runJob(job) {
    job.busy = true;
    const startedAt = now();
    const run = { at: startedAt, posted: 0, failed: 0, restored: 0, ok: true, message: '' };

    try {
      const result = await postBatch({
        groupId: job.groupId,
        subject: job.subject,
        count: job.settings.batchSize,
        requireApproved: job.settings.requireApproved
      });

      run.posted = Number(result && result.postedCount) || 0;
      run.failed = Number(result && result.failedCount) || 0;
      run.message = String((result && result.message) || '');
      job.totals.posted += run.posted;
      job.totals.failed += run.failed;

      // The queue is empty when a run had nothing eligible to send, not when
      // it merely failed to send what it had — a Telegram outage must not be
      // read as "you are out of questions" and switch the job off.
      const eligible = Number(result && result.eligibleCount) || 0;
      if (eligible === 0) job.consecutiveEmptyRuns++;
      else job.consecutiveEmptyRuns = 0;

      // Deleted-poll check, on its own cadence. Its failure is reported but
      // never fails the run: the posting is the job, this is housekeeping.
      const every = job.settings.reconcileEveryRuns;
      if (reconcile && every > 0 && (job.totals.runs + 1) % every === 0) {
        try {
          const checked = await reconcile({ groupId: job.groupId, subject: job.subject });
          run.restored = Number(checked && checked.restored) || 0;
          job.totals.restored += run.restored;
        } catch (err) {
          run.message += ` (the deleted-poll check failed: ${err.message})`;
        }
      }
    } catch (err) {
      run.ok = false;
      run.message = err.message;
      job.totals.failed += 1;
      log.error(`[autopilot] ${job.groupId}/${job.subject}: ${err.message}`);
    } finally {
      job.busy = false;
      job.totals.runs++;
      run.tookMs = now() - startedAt;
      job.history.unshift(run);
      job.history.length = Math.min(job.history.length, HISTORY_LIMIT);

      if (job.running) {
        if (job.settings.stopWhenEmpty && job.consecutiveEmptyRuns >= EMPTY_RUNS_BEFORE_STOP) {
          job.running = false;
          job.nextRunAt = null;
          job.stoppedReason =
            `Stopped on its own: ${EMPTY_RUNS_BEFORE_STOP} runs in a row found nothing left to post ` +
            `in "${job.subject}". Approve more questions and start it again.`;
          log.log(`[autopilot] ${job.groupId}/${job.subject}: queue empty, stopping.`);
        } else {
          // From when this run FINISHED, so a batch that overran its own
          // interval does not immediately trigger the next one.
          job.nextRunAt = now() + job.settings.intervalMinutes * 60 * 1000;
        }
      }
      save();
    }

    return run;
  }

  /**
   * tick — runs everything that is due.
   *
   * Sequential on purpose. Every job posts to the same Telegram bot, and
   * running two batches at once is the quickest way to a 429 that stalls both.
   *
   * @returns {Promise<Array>} One entry per job that ran
   */
  async function tick(at) {
    const when = at === undefined ? now() : at;
    const ran = [];
    for (const job of dueJobs(when)) {
      const run = await runJob(job);
      ran.push({ groupId: job.groupId, subject: job.subject, run });
    }
    return ran;
  }

  // ---- The in-process timer ----------------------------------------------

  function ensureTimer() {
    if (timer || !TICK_MS) return;
    timer = setInterval(() => {
      // A tick that is still running must not be started again: `busy` already
      // protects each job, but this keeps the queue of pending ticks at one.
      if (ticking) return;
      ticking = true;
      tick().catch((err) => log.error(`[autopilot] tick failed: ${err.message}`))
        .finally(() => { ticking = false; });
    }, TICK_MS);
    // Never hold the process open on the scheduler's account.
    if (timer.unref) timer.unref();
  }

  function shutdown() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // ---- Reporting ----------------------------------------------------------

  function describe(job) {
    return {
      groupId: job.groupId,
      subject: job.subject,
      running: job.running,
      busy: job.busy,
      settings: job.settings,
      startedAt: job.startedAt,
      startedBy: job.startedBy,
      nextRunAt: job.nextRunAt,
      nextRunInSeconds: job.nextRunAt === null ? null : Math.max(0, Math.round((job.nextRunAt - now()) / 1000)),
      stoppedReason: job.stoppedReason,
      totals: job.totals,
      history: job.history
    };
  }

  /** Every job this server knows about, running or finished. */
  function list() {
    return [...jobs.values()].map(describe);
  }

  function get(groupId, subject) {
    const job = jobs.get(jobKey(groupId, subject));
    return job ? describe(job) : null;
  }

  load();
  if (jobs.size) ensureTimer();

  return {
    start, stop, stopAll, tick, list, get, shutdown,
    // Exposed for tests and for the cron route.
    _internal: { jobs, dueJobs, runJob, save, statePath }
  };
}

/**
 * defaultStatePath — where jobs are remembered between restarts.
 *
 * Nowhere, on a serverless platform: the filesystem is read-only apart from
 * /tmp, and a /tmp that vanishes between invocations would make the file a
 * source of stale jobs rather than a memory. There, the cron route is the
 * scheduler and the sheet is the state.
 */
function defaultStatePath() {
  if (process.env.AUTOPILOT_STATE_FILE !== undefined) {
    return String(process.env.AUTOPILOT_STATE_FILE).trim();
  }
  if (process.env.VERCEL) return '';
  return path.join(process.cwd(), '.autopilot-state.json');
}

module.exports = {
  createAutopilot,
  normaliseSettings,
  jobKey,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  EMPTY_RUNS_BEFORE_STOP,
  TICK_MS
};
