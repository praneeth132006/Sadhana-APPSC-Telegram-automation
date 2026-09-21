// ============================================================================
// Referrals dashboard (dashboard/referrals.js)
// ============================================================================
// The admin side of "invite a friend": who invited whom, what each join was
// worth, what is still owed to each member, and marking a payout as made.
//
// Nothing on this page moves money. Settling records that a person sent it —
// the sending happens in a bank app, by a human, on purpose. The page is
// built around that: the numbers are read-only until you press Settle, and
// Settle names the exact payments it is closing.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, statCard, emptyState, pill,
  num, truncate, showToast, $
} from './shared.js';

/** Latest payload from /api/referrals. */
let data = null;

/** Free-text filter over the joins table. */
let search = '';

/** Paise as "₹1,250.00". */
function rupees(paise) {
  return '₹' + ((Number(paise) || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

/** A member, as "Name (@handle)" or just their Telegram id. */
function who(name, username, telegramId) {
  const label = String(name || '').trim();
  const handle = String(username || '').trim();
  if (label && handle) return `${label} (@${handle})`;
  if (label) return label;
  if (handle) return '@' + handle;
  return String(telegramId || '—');
}

/** Appends a line to the on-page log. */
function log(text, tone = 'muted') {
  const box = $('referralLog');
  box.style.display = 'block';
  box.append(el('div', { class: 'log-line ' + tone, text }));
  box.scrollTop = box.scrollHeight;
}

/** A simple table from headers and row arrays. */
function table(headers, rows) {
  return el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))),
    el('tbody', {}, ...rows));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStats() {
  const t = data.totals;
  const config = data.settings;

  $('schemeBadge').textContent = config.enabled
    ? `${config.discountPercent}% off for them · ${config.commissionPercent}% to the inviter · ` +
      `payout at ${rupees(config.payoutThresholdPaise)}`
    : '⚠️ Referrals are switched off';

  replaceChildren($('statGrid'),
    statCard('Joined via Referral', num(t.joined), { tone: 'ok', sub: 'paid members brought in by a member' }),
    statCard('Revenue from Referrals', rupees(t.revenuePaise), { tone: 'ok', sub: 'what those members actually paid' }),
    statCard('Discount Given', rupees(t.discountPaise), { tone: 'info', sub: 'taken off for the people who joined' }),
    statCard('Owed to Members', rupees(t.pendingPaise), {
      tone: t.pendingPaise > 0 ? 'warn' : 'ok', sub: 'earned, not yet paid out'
    }),
    statCard('Paid Out', rupees(t.paidPaise), { tone: 'muted', sub: 'commission already sent' }),
    statCard('Active Codes', num(data.codes.filter((c) => c.status !== 'disabled').length), {
      tone: 'info', sub: `${data.codes.length} issued in total`
    })
  );
}

/** Members with money waiting, and the button that closes it out. */
function renderDue() {
  const due = data.due || [];
  if (!due.length) {
    replaceChildren($('dueArea'), emptyState('✅', 'Nobody is waiting to be paid.',
      `Earnings show here once someone passes ${rupees(data.settings.payoutThresholdPaise)}.`));
    return;
  }

  const rows = due.map((entry) => {
    const button = el('button', { class: 'btn btn-primary', text: 'Mark paid' });
    button.addEventListener('click', () => settle(entry));
    return el('tr', {},
      el('td', {}, el('code', { text: entry.code })),
      el('td', { text: who(entry.name, entry.username, entry.telegramId) }),
      el('td', { text: String(entry.telegramId || '—') }),
      el('td', { text: num(entry.count) }),
      el('td', {}, el('strong', { text: rupees(entry.pendingPaise) })),
      el('td', {}, button));
  });

  replaceChildren($('dueArea'),
    table(['Code', 'Member', 'Telegram ID', 'Referrals', 'Owed', ''], rows));
}

/** The answer to "who joined using whose code". */
function renderJoins() {
  const term = search.trim().toLowerCase();
  const all = data.earnings || [];
  const rows = all.filter((e) => !term ||
    [e.code, e.referrer_username, e.referred_username, e.referred_name,
      e.referrer_telegram_id, e.referred_telegram_id]
      .some((v) => String(v || '').toLowerCase().includes(term)));

  if (!rows.length) {
    replaceChildren($('joinsArea'), all.length
      ? emptyState('🔍', 'No referral matches that.', 'Try a code, a name or a Telegram id.')
      : emptyState('🎁', 'Nobody has joined through a referral yet.',
        'Members get their code from the bot with /referral.'));
    return;
  }

  replaceChildren($('joinsArea'), table(
    ['When', 'Code', 'Inviter', 'Who joined', 'Group', 'Paid', 'Discount', 'Commission', 'Status'],
    rows.map((e) => el('tr', {},
      el('td', { text: truncate(e.timestamp, 24) }),
      el('td', {}, el('code', { text: e.code })),
      // Both sides carry their Telegram id: a handle can be changed, an id cannot,
      // and "who invited whom" has to survive someone renaming themselves.
      el('td', {}, el('div', { text: who('', e.referrer_username, e.referrer_telegram_id) }),
        el('div', { class: 'hint-text', text: String(e.referrer_telegram_id || '') })),
      el('td', {}, el('div', { text: who(e.referred_name, e.referred_username, e.referred_telegram_id) }),
        el('div', { class: 'hint-text', text: String(e.referred_telegram_id || '') })),
      el('td', { text: e.group || '—' }),
      el('td', { text: rupees(e.paid_paise) }),
      el('td', { text: rupees(e.discount_paise) }),
      el('td', {}, el('strong', { text: rupees(e.commission_paise) })),
      el('td', {}, pill(e.status, e.status === 'paid' ? 'ok' : e.status === 'cancelled' ? 'muted' : 'warn'))))));
}

/** Every code, whether or not it has earned anything. */
function renderCodes() {
  const codes = data.codes || [];
  if (!codes.length) {
    replaceChildren($('codesArea'), emptyState('🎟', 'No referral codes yet.',
      'A code is made the first time a member sends /referral to the bot.'));
    return;
  }

  replaceChildren($('codesArea'), table(
    ['Code', 'Member', 'Telegram ID', 'Made', 'Referrals', 'Earned', 'Owed', 'Status', ''],
    codes.map((c) => {
      const toggle = el('button', {
        class: 'btn btn-ghost',
        text: c.status === 'disabled' ? 'Enable' : 'Disable'
      });
      toggle.addEventListener('click', () => setStatus(c, c.status === 'disabled' ? 'active' : 'disabled'));

      return el('tr', {},
        el('td', {}, el('code', { text: c.code })),
        el('td', { text: who(c.name, c.username, c.telegramId) }),
        el('td', { text: String(c.telegramId || '—') }),
        el('td', { text: truncate(c.createdAt, 24) }),
        el('td', { text: num(c.joined) }),
        el('td', { text: rupees(c.totalPaise) }),
        el('td', { text: rupees(c.pendingPaise) }),
        el('td', {}, pill(c.status, c.status === 'disabled' ? 'muted' : 'ok')),
        el('td', {}, toggle));
    })));
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * settle — records that this member has been paid.
 *
 * The exact payment ids the page was showing are sent, so an earning recorded
 * between looking and pressing the button is not silently marked paid along
 * with them. That one would simply still be owed, which is the safe way round.
 */
async function settle(entry) {
  const confirmed = confirm(
    `Mark ${rupees(entry.pendingPaise)} as paid to ${who(entry.name, entry.username, entry.telegramId)}?\n\n` +
    `This records that you have ALREADY sent the money. It does not send anything.\n\n` +
    `${entry.count} referral(s), code ${entry.code}.`
  );
  if (!confirmed) return;

  try {
    const result = await api('/api/referrals/settle', {
      method: 'POST',
      body: { code: entry.code, paymentIds: entry.paymentIds || [] }
    });
    log(`✅ ${entry.code} — ${result.message}`, 'ok');
    showToast('success', result.message);
    await load();
  } catch (err) {
    log(`Failed to settle ${entry.code}: ${err.message}`, 'fail');
    showToast('error', err.message, 9000);
  }
}

/** Turns a code off (or back on) without touching what it has earned. */
async function setStatus(code, status) {
  if (status === 'disabled' && !confirm(
    `Disable ${code.code}?\n\nNobody will be able to use it for a new purchase. ` +
    `What it has already earned (${rupees(code.pendingPaise)} owed) is untouched.`)) return;

  try {
    await api('/api/referrals/status', { method: 'POST', body: { code: code.code, status } });
    log(`${code.code} is now ${status}.`, 'ok');
    showToast('success', `${code.code} is now ${status}.`);
    await load();
  } catch (err) {
    showToast('error', err.message, 9000);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load() {
  const button = $('refreshBtn');
  button.disabled = true;
  try {
    const result = await api('/api/referrals');
    data = result.data || result;
    renderStats();
    renderDue();
    renderJoins();
    renderCodes();
  } catch (err) {
    showToast('error', err.message, 9000);
    replaceChildren($('joinsArea'), emptyState('⚠️', 'Could not load referrals.', err.message));
  } finally {
    button.disabled = false;
  }
}

initDashboard({
  page: 'referrals',
  onReady: async () => {
    $('refreshBtn').addEventListener('click', load);
    $('search').addEventListener('input', (e) => {
      search = e.target.value;
      if (data) renderJoins();
    });
    await load();
  }
});
