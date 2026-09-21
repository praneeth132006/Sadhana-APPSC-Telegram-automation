// ============================================================================
// Referrals dashboard (dashboard/referrals.js)
// ============================================================================
// Every referral code, who opened it, who joined using it, what each join was
// worth and what is owed — down to each person's Telegram id and payment id.
//
// The first version showed one flat log and a table of codes, and it could not
// answer the question an admin actually asks: "who did THIS person bring in?".
// Now every referrer is a row that opens into exactly that.
//
// Nothing on this page moves money. Settling records that a person sent it,
// and names the exact payments it is closing.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, statCard, emptyState, pill,
  num, showToast, $
} from './shared.js';

/** Latest payload from /api/referrals. */
let data = null;

/** Which referrer rows are open, by code — kept across a refresh. */
const open = new Set();

/** Paise as "₹1,250.00". */
function rupees(paise) {
  return '₹' + ((Number(paise) || 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}

/** "Name (@handle)", or whichever of the two exists, or the id. */
function who(name, username, telegramId) {
  const label = String(name || '').trim();
  const handle = String(username || '').trim().replace(/^@/, '');
  if (label && handle) return `${label} (@${handle})`;
  if (label) return label;
  if (handle) return '@' + handle;
  return telegramId ? `ID ${telegramId}` : '—';
}

/** A Telegram id (or any value) with a copy button beside it. */
function copyable(value) {
  const text = String(value || '').trim();
  if (!text) return el('span', { class: 'ref-sub', text: '—' });
  const button = el('button', { class: 'ref-copy', type: 'button', text: 'copy', title: 'Copy ' + text });
  button.addEventListener('click', async (event) => {
    event.stopPropagation();   // a copy inside a referrer row must not toggle it
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'copied';
      setTimeout(() => { button.textContent = 'copy'; }, 1200);
    } catch (err) {
      showToast('error', 'Could not copy — select it and copy by hand.');
    }
  });
  return el('span', {}, el('span', { class: 'ref-id', text }), button);
}

function statusPill(status) {
  return pill(status, status === 'paid' ? 'ok' : status === 'cancelled' ? 'muted' : 'warn');
}

function log(text, tone = 'muted') {
  const box = $('referralLog');
  box.style.display = 'block';
  box.append(el('div', { class: 'log-line ' + tone, text }));
  box.scrollTop = box.scrollHeight;
}

function table(headers, rows) {
  return el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))),
    el('tbody', {}, ...rows));
}

/** Everything in a list of fields, lower-cased, for a free-text filter. */
const haystack = (...fields) => fields.map((f) => String(f || '').toLowerCase()).join(' ');

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStats() {
  const t = data.totals;
  const config = data.settings;

  $('schemeBadge').textContent = config.enabled
    ? `${config.discountPercent}% off · ${config.commissionPercent}% to the inviter · claim at ${rupees(config.payoutThresholdPaise)}`
    : '⚠️ Referrals are switched off';

  replaceChildren($('statGrid'),
    statCard('Referral Codes', num(data.codes.length), {
      tone: 'info', sub: `${num(t.activeReferrers || 0)} have brought someone in`
    }),
    statCard('Link Opens', num(t.linkOpens || 0), { tone: 'info', sub: 'different people who opened a link' }),
    statCard('Joined via Referral', num(t.joined), { tone: 'ok', sub: 'paid, using someone’s code' }),
    statCard('Revenue from Referrals', rupees(t.revenuePaise), { tone: 'ok', sub: 'what they actually paid' }),
    statCard('Owed to Members', rupees(t.pendingPaise), {
      tone: t.pendingPaise > 0 ? 'warn' : 'ok', sub: 'earned, not yet paid out'
    }),
    statCard('Paid Out', rupees(t.paidPaise), { tone: 'muted', sub: 'commission already sent' })
  );
}

function renderDue() {
  const due = data.due || [];
  if (!due.length) {
    replaceChildren($('dueArea'), emptyState('✅', 'Nobody has reached the payout amount yet.',
      `A member appears here once they pass ${rupees(data.settings.payoutThresholdPaise)}.`));
    return;
  }
  replaceChildren($('dueArea'), table(['Code', 'Member', 'Telegram ID', 'Referrals', 'Owed', ''],
    due.map((entry) => {
      const button = el('button', { class: 'btn btn-primary', text: 'Mark paid' });
      button.addEventListener('click', () => settle(entry));
      return el('tr', {},
        el('td', {}, el('code', { text: entry.code })),
        el('td', { text: who(entry.name, entry.username, entry.telegramId) }),
        el('td', {}, copyable(entry.telegramId)),
        el('td', { text: num(entry.count) }),
        el('td', {}, el('strong', { text: rupees(entry.pendingPaise) })),
        el('td', {}, button));
    })));
}

/** The drill-down under one referrer: everyone who joined, everyone who looked. */
function referrerDetail(code) {
  const parts = [];

  parts.push(el('h4', { text: `👥 Joined using ${code.code} (${code.joins.length})` }));
  parts.push(code.joins.length
    ? table(['Ref ID', 'When', 'Who joined', 'Telegram ID', 'Group', 'Pass', 'Paid', 'Discount', 'Commission', 'Status', 'Payment ID'],
      code.joins.slice().reverse().map((j) => el('tr', {},
        el('td', { class: 'ref-id', text: j.referralId || '—' }),
        el('td', { text: j.at || '—' }),
        el('td', { text: who(j.name, j.username, '') }),
        el('td', {}, copyable(j.telegramId)),
        el('td', { text: j.group || '—' }),
        el('td', { text: j.plan || '—' }),
        el('td', { text: rupees(j.paidPaise) }),
        el('td', { text: rupees(j.discountPaise) }),
        el('td', {}, el('strong', { text: rupees(j.commissionPaise) })),
        el('td', {}, statusPill(j.status),
          j.paidAt ? el('div', { class: 'ref-sub', text: 'paid ' + j.paidAt }) : el('span')),
        el('td', {}, copyable(j.paymentId)))))
    : el('p', { class: 'hint-text', text: 'Nobody has paid using this code yet.' }));

  parts.push(el('h4', { text: `👀 Opened the link (${code.linkOpens})` }));
  parts.push(code.openedBy.length
    ? el('div', { class: 'ref-chips' }, ...code.openedBy.map((o) => el('span', {
      class: 'ref-chip' + (o.joined ? ' joined' : ''),
      text: o.telegramId + (o.joined ? ' ✓ joined' : ''),
      title: o.joined ? 'Opened the link and paid' : 'Opened the link, has not paid'
    })))
    : el('p', { class: 'hint-text', text: 'Nobody has opened this link yet.' }));

  if (code.shareLink) {
    parts.push(el('h4', { text: '🔗 Share link' }));
    parts.push(copyable(code.shareLink));
  }
  return parts;
}

function codeMatches(code, term, filter) {
  if (term && !haystack(code.code, code.name, code.username, code.telegramId,
    ...code.joins.flatMap((j) => [j.telegramId, j.username, j.name])).includes(term)) return false;
  switch (filter) {
    case 'joined': return code.joined > 0;
    case 'owed': return code.pendingPaise > 0;
    case 'payable': return code.payable;
    case 'none': return code.joined === 0;
    case 'disabled': return code.status === 'disabled';
    default: return true;
  }
}

function renderCodes() {
  const term = $('codeSearch').value.trim().toLowerCase();
  const filter = $('codeFilter').value;
  const codes = (data.codes || []).filter((c) => codeMatches(c, term, filter));

  if (!data.codes.length) {
    replaceChildren($('codesArea'), emptyState('🎁', 'No referral codes yet.',
      'A member gets a code the first time they open 🎁 My referral in the bot.'));
    return;
  }
  if (!codes.length) {
    replaceChildren($('codesArea'), emptyState('🔍', 'No referrer matches that.', 'Try another name, code or ID.'));
    return;
  }

  const headers = ['', 'Member', 'Telegram ID', 'Code', 'Opens', 'Joined', 'Earned', 'Owed', 'Paid out', 'Last joined', 'Status', ''];
  const rows = [];
  for (const c of codes) {
    const toggle = el('button', {
      class: 'btn btn-ghost',
      text: c.status === 'disabled' ? 'Enable' : 'Disable'
    });
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setStatus(c, c.status === 'disabled' ? 'active' : 'disabled');
    });

    const row = el('tr', { class: 'ref-row' + (open.has(c.code) ? ' open' : '') },
      el('td', {}, el('span', { class: 'chev', text: '▸' })),
      el('td', {}, el('div', { text: who(c.name, c.username, '') }),
        el('div', { class: 'ref-sub', text: 'since ' + (c.createdAt || '—') })),
      el('td', {}, copyable(c.telegramId)),
      el('td', {}, el('code', { text: c.code })),
      el('td', { text: num(c.linkOpens) }),
      el('td', {}, el('strong', { text: num(c.joined) })),
      el('td', { text: rupees(c.totalPaise) }),
      el('td', {}, c.pendingPaise ? el('strong', { text: rupees(c.pendingPaise) }) : el('span', { text: rupees(0) })),
      el('td', { text: rupees(c.paidPaise) }),
      el('td', { class: 'ref-sub', text: c.lastJoinedAt || '—' }),
      el('td', {}, pill(c.status, c.status === 'disabled' ? 'muted' : 'ok')),
      el('td', {}, toggle));

    row.addEventListener('click', () => {
      if (open.has(c.code)) open.delete(c.code); else open.add(c.code);
      renderCodes();
    });
    rows.push(row);

    if (open.has(c.code)) {
      rows.push(el('tr', { class: 'ref-detail' },
        el('td', { colspan: String(headers.length) }, ...referrerDetail(c))));
    }
  }
  replaceChildren($('codesArea'), table(headers, rows));
}

function renderJoins() {
  const term = $('joinSearch').value.trim().toLowerCase();
  const status = $('joinStatus').value;
  const group = $('joinGroup').value;
  const all = data.earnings || [];
  const rows = all.filter((e) =>
    (status === 'all' || e.status === status) &&
    (group === 'all' || e.group === group) &&
    (!term || haystack(e.code, e.referral_id, e.referrer_username, e.referrer_name, e.referrer_telegram_id,
      e.referred_username, e.referred_name, e.referred_telegram_id, e.payment_id).includes(term)));

  if (!rows.length) {
    replaceChildren($('joinsArea'), all.length
      ? emptyState('🔍', 'No payment matches that.', 'Try a code, a name, an ID or a payment ID.')
      : emptyState('🎁', 'Nobody has joined through a referral yet.', 'Members share their code with 🎁 My referral.'));
    return;
  }

  replaceChildren($('joinsArea'), table(
    ['Ref ID', 'When', 'Code', 'Inviter', 'Inviter ID', 'Who joined', 'Joined ID', 'Group', 'Paid', 'Commission', 'Status', 'Payment ID'],
    rows.map((e) => el('tr', {},
      el('td', { class: 'ref-id', text: e.referral_id || '—' }),
      el('td', { text: e.timestamp || '—' }),
      el('td', {}, el('code', { text: e.code })),
      el('td', { text: who(e.referrer_name, e.referrer_username, '') }),
      el('td', {}, copyable(e.referrer_telegram_id)),
      el('td', { text: who(e.referred_name, e.referred_username, '') }),
      el('td', {}, copyable(e.referred_telegram_id)),
      el('td', { text: e.group || '—' }),
      el('td', { text: rupees(e.paid_paise) }),
      el('td', {}, el('strong', { text: rupees(e.commission_paise) })),
      el('td', {}, statusPill(e.status)),
      el('td', {}, copyable(e.payment_id))))));
}

/** The group filter lists only groups that actually appear. */
function fillGroupFilter() {
  const select = $('joinGroup');
  const chosen = select.value;
  const groups = [...new Set((data.earnings || []).map((e) => e.group).filter(Boolean))].sort();
  replaceChildren(select, el('option', { value: 'all', text: 'Any group' }),
    ...groups.map((g) => el('option', { value: g, text: g })));
  select.value = groups.includes(chosen) ? chosen : 'all';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function settle(entry) {
  const confirmed = confirm(
    `Mark ${rupees(entry.pendingPaise)} as paid to ${who(entry.name, entry.username, entry.telegramId)}?\n\n` +
    'This records that you have ALREADY sent the money. It does not send anything.\n\n' +
    `${entry.count} referral(s), code ${entry.code}.`);
  if (!confirmed) return;
  try {
    const result = await api('/api/referrals/settle', {
      method: 'POST', body: { code: entry.code, paymentIds: entry.paymentIds || [] }
    });
    log(`✅ ${entry.code} — ${result.message}`, 'ok');
    showToast('success', result.message);
    await load();
  } catch (err) {
    log(`Failed to settle ${entry.code}: ${err.message}`, 'fail');
    showToast('error', err.message, 9000);
  }
}

async function setStatus(code, status) {
  if (status === 'disabled' && !confirm(
    `Disable ${code.code}?\n\nNobody will be able to use it for a new purchase. ` +
    `What it has already earned (${rupees(code.pendingPaise)} owed) is untouched.`)) return;
  try {
    await api('/api/referrals/status', { method: 'POST', body: { code: code.code, status } });
    showToast('success', `${code.code} is now ${status}.`);
    await load();
  } catch (err) {
    showToast('error', err.message, 9000);
  }
}

async function rebuildSheet() {
  const button = $('rebuildBtn');
  button.disabled = true;
  button.textContent = 'Rebuilding…';
  try {
    const result = await api('/api/referrals/rebuild', { method: 'POST' });
    showToast('success', result.message);
    await load();
  } catch (err) {
    showToast('error', err.message, 9000);
  } finally {
    button.disabled = false;
    button.textContent = '🔁 Rebuild sheet';
  }
}

/**
 * exportCsv — every referred payment, with both sides' ids, as a file.
 *
 * Built from what the page already holds, so the file is exactly what the
 * admin was looking at — and a leading "=" is neutralised, because a name
 * someone chose for their Telegram account ends up in a spreadsheet here.
 */
function exportCsv() {
  const cell = (v) => {
    let text = String(v === undefined || v === null ? '' : v);
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Referral ID', 'Timestamp', 'Code', 'Referrer ID', 'Referrer Username', 'Referrer Name',
    'Referred ID', 'Referred Username', 'Referred Name', 'Group', 'Plan', 'Payment ID',
    'Original (Rs)', 'Discount (Rs)', 'Paid (Rs)', 'Commission (Rs)', 'Status', 'Paid At'];
  const rows = (data.earnings || []).slice().reverse().map((e) => [
    e.referral_id, e.timestamp, e.code, e.referrer_telegram_id, e.referrer_username, e.referrer_name,
    e.referred_telegram_id, e.referred_username, e.referred_name, e.group, e.plan, e.payment_id,
    (e.original_paise || 0) / 100, (e.discount_paise || 0) / 100, (e.paid_paise || 0) / 100,
    (e.commission_paise || 0) / 100, e.status, e.paid_at
  ]);
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `referrals-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('success', `${rows.length} referral(s) exported.`);
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
    fillGroupFilter();
    renderCodes();
    renderJoins();
  } catch (err) {
    showToast('error', err.message, 9000);
    replaceChildren($('codesArea'), emptyState('⚠️', 'Could not load referrals.', err.message));
  } finally {
    button.disabled = false;
  }
}

initDashboard({
  page: 'referrals',
  onReady: async () => {
    $('refreshBtn').addEventListener('click', load);
    $('rebuildBtn').addEventListener('click', rebuildSheet);
    $('exportBtn').addEventListener('click', () => { if (data) exportCsv(); });
    $('codeSearch').addEventListener('input', () => data && renderCodes());
    $('codeFilter').addEventListener('change', () => data && renderCodes());
    ['joinSearch', 'joinStatus', 'joinGroup'].forEach((id) =>
      $(id).addEventListener(id === 'joinSearch' ? 'input' : 'change', () => data && renderJoins()));
    await load();
  }
});
