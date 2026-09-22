// ============================================================================
// Influencers dashboard (dashboard/influencers.js)
// ============================================================================
// The admin side of the influencer programme. Influencers apply through the
// affiliate bot; everything they cannot decide for themselves is decided here:
//
//   an application  → approved with the terms chosen below (the code is made
//                     and sent to them), or rejected with a reason
//   a withdrawal    → marked paid with the UPI reference once the money has
//                     actually been sent, or rejected (its sales go back)
//   a code          → paused, resumed, or given new terms
//
// Nothing on this page moves money. It records what a person did.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, statCard, emptyState, pill, num, showToast, panel, $
} from './shared.js';

/** Latest /api/affiliates payload. */
let data = null;

/** Which code rows are open, and which request/payout has a form open. */
const openCodes = new Set();
let openForm = null;

/** The section on screen, and the filters inside it. */
let activeTab = null;
const filters = { codeStatus: 'all', saleStatus: 'all' };

/** Paise as "₹1,250.00". */
function rupees(paise) {
  return '₹' + ((Number(paise) || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function who(name, username, telegramId) {
  const label = String(name || '').trim();
  const handle = String(username || '').trim().replace(/^@/, '');
  if (label && handle) return `${label} (@${handle})`;
  if (label) return label;
  if (handle) return '@' + handle;
  return telegramId ? `ID ${telegramId}` : '—';
}

function copyable(value) {
  const text = String(value || '').trim();
  if (!text) return el('span', { class: 'inf-sub', text: '—' });
  const button = el('button', { class: 'inf-copy', type: 'button', text: 'copy', title: 'Copy ' + text });
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'copied';
      setTimeout(() => { button.textContent = 'copy'; }, 1200);
    } catch (err) {
      showToast('error', 'Could not copy — select it and copy by hand.');
    }
  });
  return el('span', {}, el('span', { class: 'inf-id', text }), button);
}

function table(headers, rows) {
  return el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h })))),
    el('tbody', {}, ...rows));
}

const haystack = (...fields) => fields.map((f) => String(f || '').toLowerCase()).join(' ');

function examLabel(id) {
  const exam = (data.exams || []).find((e) => e.id === id);
  return exam ? exam.label : String(id || '').toUpperCase();
}

function describeDiscount(t) {
  return t.discount_type === 'percent' ? `${t.discount_value}% off` : `₹${t.discount_value} off`;
}
function describeCommission(t) {
  return t.commission_type === 'percent' ? `${t.commission_value}% of paid` : `₹${t.commission_value} / sale`;
}

async function busy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function post(path, body, button, label) {
  return busy(button, label, async () => {
    try {
      const result = await api(path, { method: 'POST', body });
      showToast('success', result.message || 'Done.', 7000);
      openForm = null;
      await load({ quiet: true });
      return result;
    } catch (err) {
      showToast('error', err.message, 9000);
      return null;
    }
  });
}

function field(label, input, hint) {
  return el('div', { class: 'support-field' }, [
    el('label', { for: input.id, text: label }),
    input,
    hint ? el('div', { class: 'hint-text', text: hint }) : null
  ]);
}

const toInputDate = (text) => {
  const m = String(text || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const fromInputDate = (value) => {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

// ---------------------------------------------------------------------------
// The terms form — used to approve an application and to edit a code
// ---------------------------------------------------------------------------

/**
 * termsForm — every term an admin sets, with a live preview of what a student
 * pays and what the influencer earns on one sale.
 *
 * @param {Object} options { initial, examId, codeEditable, submitLabel, onSubmit }
 */
function termsForm({ initial, examId, codeEditable, submitLabel, onSubmit, onCancel }) {
  const t = Object.assign({
    code: '', discount_type: 'percent', discount_value: 10, commission_type: 'percent', commission_value: 20,
    payout_cycle: 'monthly', min_payout: 100, expires_on: '', max_uses: '', one_per_student: 'yes', note: ''
  }, initial || {});
  const uid = Math.random().toString(36).slice(2, 8);
  const input = (id, attrs, value) => {
    const node = el('input', Object.assign({ id: `${id}-${uid}`, class: 'field-input' }, attrs));
    node.value = value === undefined || value === null ? '' : value;
    return node;
  };
  const select = (id, options, value) => {
    const node = el('select', { id: `${id}-${uid}`, class: 'field-select' },
      options.map(([v, text]) => el('option', { value: v, text })));
    node.value = value;
    return node;
  };

  const code = input('code', { type: 'text', maxlength: '20', autocomplete: 'off', spellcheck: 'false', class: 'field-input pc-code-input' }, t.code);
  code.disabled = !codeEditable;
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/\s+/g, ''); });
  const discountType = select('dtype', [['percent', '% off'], ['flat', '₹ off']], t.discount_type);
  const discountValue = input('dval', { type: 'number', min: '1', step: '1', inputmode: 'numeric' }, t.discount_value);
  const commissionType = select('ctype', [['percent', '% of paid'], ['flat', '₹ per sale']], t.commission_type);
  const commissionValue = input('cval', { type: 'number', min: '1', step: '1', inputmode: 'numeric' }, t.commission_value);
  const cycle = select('cycle', [['weekly', 'Weekly'], ['monthly', 'Monthly']], t.payout_cycle);
  const minPayout = input('min', { type: 'number', min: '0', step: '1', inputmode: 'numeric' }, t.min_payout);
  const expires = input('exp', { type: 'date' }, toInputDate(t.expires_on));
  const maxUses = input('max', { type: 'number', min: '1', step: '1', inputmode: 'numeric', placeholder: 'Unlimited' }, t.max_uses);
  const once = el('input', { id: `once-${uid}`, type: 'checkbox' });
  once.checked = !/^(no|false)$/i.test(String(t.one_per_student));
  const note = input('note', { type: 'text', maxlength: '500', placeholder: 'Only admins see this' }, t.note);

  const exam = (data.exams || []).find((e) => e.id === examId);
  const pricePaise = exam && exam.pricePaise ? exam.pricePaise : 19900;
  const preview = el('div', { class: 'pc-coupon-preview', 'aria-live': 'polite' });
  const renderPreview = () => {
    const dv = Number(discountValue.value) || 0;
    const discount = discountType.value === 'percent' ? Math.round(pricePaise * dv / 100) : dv * 100;
    const paid = pricePaise - discount;
    const cv = Number(commissionValue.value) || 0;
    const earn = Math.min(commissionType.value === 'percent' ? Math.round(paid * cv / 100) : cv * 100, Math.max(paid, 0));
    replaceChildren(preview, paid < 100
      ? el('span', { class: 'pc-warn', text: `⚠️ That discount takes the ${rupees(pricePaise)} pass below ₹1.` })
      : el('span', {}, [
        'On one sale: the student pays ', el('s', { text: rupees(pricePaise) }), ' ', el('strong', { text: rupees(paid) }),
        ', the influencer earns ', el('strong', { text: rupees(earn) }),
        ', you keep ', el('strong', { text: rupees(paid - earn) }), '.'
      ]));
  };
  [discountType, discountValue, commissionType, commissionValue].forEach((node) => node.addEventListener('input', renderPreview));
  renderPreview();

  const submit = el('button', { class: 'btn btn-primary', text: submitLabel });
  submit.addEventListener('click', () => onSubmit({
    code: code.value, discount_type: discountType.value, discount_value: discountValue.value,
    commission_type: commissionType.value, commission_value: commissionValue.value,
    payout_cycle: cycle.value, min_payout: minPayout.value, expires_on: fromInputDate(expires.value),
    max_uses: maxUses.value, one_per_student: once.checked, note: note.value
  }, submit));
  const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: onCancel });

  return el('div', { class: 'pc-form' }, [
    el('div', { class: 'support-fields' }, [
      field('Promo code', code, codeEditable ? 'Suggested from their name. Change it if you like — 3–20 letters or numbers.' : 'A code cannot be renamed.'),
      field('Student discount', el('div', { class: 'inf-pair' }, discountType, discountValue), `On the ${rupees(pricePaise)} ${examLabel(examId)} pass.`),
      field('Influencer commission', el('div', { class: 'inf-pair' }, commissionType, commissionValue), 'Worked out on what the student actually pays.'),
      field('Withdrawals', cycle, 'How often they can ask to be paid.'),
      field('Minimum withdrawal (₹)', minPayout, '0 for no minimum.'),
      field('Code valid until', expires, 'Blank: no end date.'),
      field('Max uses', maxUses, 'Blank: unlimited.'),
      field('Admin note', note)
    ]),
    el('label', { class: 'pc-checks' }, once, ' One use per student'),
    preview,
    el('div', { class: 'support-actions end' }, cancel, submit)
  ]);
}

// ---------------------------------------------------------------------------
// Filters shared by every section
// ---------------------------------------------------------------------------

function examMatches(examId) {
  const exam = $('examFilter').value;
  return !exam || exam === 'all' || examId === exam;
}

function searchMatches(...fields) {
  const q = $('searchInput').value.trim().toLowerCase();
  return !q || haystack(...fields).includes(q);
}

function filterBar(items) {
  return el('div', { class: 'filter-bar' }, items.map(([label, input]) =>
    el('div', { class: 'filter-item' }, [el('label', { text: label }), input])));
}

function statusSelect(key, options) {
  const select = el('select', { class: 'field-select', 'aria-label': 'Status' },
    options.map(([value, text]) => el('option', { value, text })));
  select.value = filters[key];
  select.addEventListener('change', () => { filters[key] = select.value; renderActiveTab(); });
  return select;
}

// ---------------------------------------------------------------------------
// Around the sections: notices, headline numbers, how it works, tabs
// ---------------------------------------------------------------------------

function banner(tone, title, text) {
  return el('div', { class: `banner tone-${tone}` }, el('div', { class: 'banner-body' }, [
    el('strong', { text: title + ' ' }), el('span', {}, text)
  ]));
}

function renderNotices() {
  const s = data.status || {};
  const notes = [];
  if (!s.sheet) {
    notes.push(banner('warn', 'No influencer sheet.', [
      'Create a blank Google Sheet, share it with ', el('code', { text: s.serviceAccount || 'the service account' }),
      ' as an Editor, and set AFFILIATE_SHEET_ID to its link.'
    ]));
  }
  if (!s.bot) notes.push(banner('warn', 'No influencer bot.', 'Create it with @BotFather and set TELEGRAM_AFFILIATE_BOT.'));
  if (s.bot && !s.adminChat) {
    notes.push(banner('info', 'No admin chat.', 'New applications and withdrawals only appear on this page. Set SUPPORT_CHAT_ID and add the influencer bot to it.'));
  }
  replaceChildren($('notices'), notes.length ? el('div', { class: 'sp-notices' }, notes) : null);

  $('botBadge').textContent = data.botUsername ? `@${data.botUsername}` : '';
  const link = $('sheetLink');
  link.hidden = !s.sheetUrl;
  if (s.sheetUrl) link.href = s.sheetUrl;
}

function renderHowItWorks() {
  const steps = (items) => el('ol', {}, items.map((t) => el('li', { text: t })));
  replaceChildren($('howItWorks'), el('div', { class: 'panel-body inf-howto' }, [
    el('div', {}, [el('h3', { text: 'What an influencer does' }), steps([
      `Opens ${data && data.botUsername ? '@' + data.botUsername : 'the influencer bot'}, taps Apply, picks an exam and says where they will promote it.`,
      'Gets their promo code and link the moment you approve — the link opens that exam\'s payment bot with the code applied.',
      'Is messaged on every sale, and taps Withdraw when their weekly or monthly cycle comes round.'
    ])]),
    el('div', {}, [el('h3', { text: 'What you do here' }), steps([
      'Applications: approve with the student discount, their commission, the payout cycle and minimum — or reject with a reason.',
      'Withdrawals: send the money over UPI first, then mark it paid with the UPI reference. Rejecting puts it back in their balance.',
      'Promo codes: pause a code to stop it being used, or change its terms. Past sales keep what they earned.'
    ])]),
    el('div', {}, [el('h3', { text: 'Rules the bots enforce' }), steps([
      'A code works only in the payment bot of the exam it was approved for.',
      'An influencer cannot use their own code, and a code can never clash with a coupon.',
      'Commission is counted once per payment, on what the student actually paid.'
    ])])
  ]));
}

function renderStats() {
  const t = data.totals || {};
  replaceChildren($('statGrid'),
    statCard('Influencers', num(t.influencers || 0), { tone: 'info', sub: `${num(t.activeCodes || 0)} active code(s)` }),
    statCard('Applications Waiting', num(t.pendingRequests || 0), { tone: t.pendingRequests ? 'warn' : 'ok', sub: 'need a decision' }),
    statCard('Students via Codes', num(t.uses || 0), { tone: 'ok', sub: `paid ${rupees(t.revenuePaise)}` }),
    statCard('Commission Earned', rupees(t.earnedPaise), { tone: 'info', sub: `students saved ${rupees(t.discountPaise)}` }),
    statCard('Owed to Influencers', rupees((t.availablePaise || 0) + (t.requestedPaise || 0)), {
      tone: t.requestedPaise ? 'warn' : 'ok', sub: `${rupees(t.requestedPaise)} requested (${num(t.openPayouts || 0)})`
    }),
    statCard('Paid Out', rupees(t.paidPaise), { tone: 'muted', sub: 'withdrawals sent' })
  );
}

const TABS = [
  { id: 'requests', label: 'Applications', count: () => pendingRequests().length, alert: true },
  { id: 'payouts', label: 'Withdrawals', count: () => openPayouts().length, alert: true },
  { id: 'codes', label: 'Promo codes', count: () => (data.codes || []).length },
  { id: 'sales', label: 'Sales', count: () => (data.sales || []).length },
  { id: 'history', label: 'History', count: () => historyRows().length }
];

function renderTabs() {
  replaceChildren($('tabs'), TABS.map((tab) => {
    const count = data.notReady ? 0 : tab.count();
    return el('button', {
      id: `tab-${tab.id}`,
      class: 'sp-tab' + (activeTab === tab.id ? ' active' : ''),
      role: 'tab',
      'aria-selected': activeTab === tab.id ? 'true' : 'false',
      onclick: () => { activeTab = tab.id; openForm = null; renderTabs(); renderActiveTab(); }
    }, [
      el('span', { text: tab.label }),
      el('span', { class: 'sp-tab-count' + (tab.alert && count ? ' alert' : ''), text: num(count) })
    ]);
  }));
}

function renderActiveTab() {
  const host = $('tabBody');
  if (data.notReady) {
    replaceChildren(host, panel('Nothing to show yet', 'Finish the setup above, then refresh',
      emptyState('⚙️', 'The influencer programme is not set up yet.', 'Once the sheet and the bot are in place, applications appear here.')));
    return;
  }
  const view = {
    requests: requestsPanel, payouts: payoutsPanel, codes: codesPanel, sales: salesPanel, history: historyPanel
  }[activeTab] || requestsPanel;
  replaceChildren(host, view());
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

function pendingRequests() {
  return (data.requests || []).filter((r) => r.status === 'pending');
}

function requestsPanel() {
  const pending = pendingRequests().filter((r) => examMatches(r.exam) &&
    searchMatches(r.name, r.username, r.telegram_id, r.details, r.request_id));
  const title = '📝 Applications waiting';
  const subtitle = 'Approve with the terms you choose — the code is created and sent to the influencer — or reject';
  if (!pending.length) {
    return panel(title, subtitle, emptyState('✅', pendingRequests().length ? 'No application matches the filters.' : 'No applications waiting.',
      data.botUsername ? `Influencers apply in @${data.botUsername}.` : 'Influencers apply through the influencer bot.'));
  }
  const rows = [];
  for (const r of pending) {
    const approve = el('button', { class: 'btn btn-primary', text: 'Approve…' });
    const reject = el('button', { class: 'btn btn-ghost', text: 'Reject…' });
    approve.addEventListener('click', () => { openForm = `approve:${r.request_id}`; renderActiveTab(); });
    reject.addEventListener('click', () => { openForm = `reject:${r.request_id}`; renderActiveTab(); });
    rows.push(el('tr', {},
      el('td', {}, el('div', { text: who(r.name, r.username, '') }), el('div', { class: 'inf-sub' }, copyable(r.telegram_id))),
      el('td', {}, pill(examLabel(r.exam), 'info')),
      el('td', {}, el('div', { class: 'inf-details', text: r.details })),
      el('td', {}, el('div', { text: r.created_at }), el('div', { class: 'inf-sub inf-id', text: r.request_id })),
      el('td', {}, el('div', { class: 'inf-actions' }, approve, reject))));

    if (openForm === `approve:${r.request_id}`) {
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '5' }, termsForm({
        initial: { code: r.suggested_code }, examId: r.exam, codeEditable: true,
        submitLabel: 'Approve and send the code',
        onCancel: () => { openForm = null; renderActiveTab(); },
        onSubmit: (terms, button) => post('/api/affiliates/approve', { requestId: r.request_id, terms }, button, 'Approving…')
      }))));
    }
    if (openForm === `reject:${r.request_id}`) {
      const reason = el('input', { id: `reason-${r.request_id}`, class: 'field-input', type: 'text', maxlength: '500',
        placeholder: 'Shown to the influencer, e.g. "Audience too small for now"' });
      const confirm = el('button', { class: 'btn btn-primary', text: 'Reject application' });
      confirm.addEventListener('click', () => post('/api/affiliates/reject', { requestId: r.request_id, reason: reason.value }, confirm, 'Rejecting…'));
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '5' }, el('div', { class: 'pc-form' },
        field('Reason (optional)', reason),
        el('div', { class: 'support-actions end' },
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => { openForm = null; renderActiveTab(); } }), confirm)))));
    }
  }
  return panel(title, subtitle, el('div', { class: 'table-wrap' }, table(['Influencer', 'Exam', 'Where they will promote', 'Applied', ''], rows)));
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

function openPayouts() {
  return (data.payouts || []).filter((p) => p.status === 'requested');
}

function payoutsPanel() {
  const open = openPayouts().filter((p) => examMatches(p.exam) &&
    searchMatches(p.name, p.username, p.influencer_id, p.code, p.upi_id, p.payout_id));
  const title = '💸 Withdrawals to pay';
  const subtitle = 'Send the money over UPI first, then mark it paid with the reference — the influencer is told';
  if (!open.length) {
    return panel(title, subtitle, emptyState('✅', openPayouts().length ? 'No withdrawal matches the filters.' : 'No withdrawals waiting.',
      'Influencers request them from the bot once their cycle comes round.'));
  }
  const rows = [];
  for (const p of open) {
    const paid = el('button', { class: 'btn btn-primary', text: 'Mark paid…' });
    const reject = el('button', { class: 'btn btn-ghost', text: 'Reject…' });
    paid.addEventListener('click', () => { openForm = `paid:${p.payout_id}`; renderActiveTab(); });
    reject.addEventListener('click', () => { openForm = `rejectpay:${p.payout_id}`; renderActiveTab(); });
    rows.push(el('tr', {},
      el('td', {}, el('div', { text: who(p.name, p.username, '') }), el('div', { class: 'inf-sub' }, copyable(p.influencer_id))),
      el('td', {}, el('code', { class: 'pc-code', text: p.code }), el('div', { class: 'inf-sub', text: examLabel(p.exam) })),
      el('td', {}, copyable(p.upi_id)),
      el('td', {}, el('div', { class: 'inf-money', text: rupees(p.amount_paise) }), el('div', { class: 'inf-sub', text: `${p.sales} sale(s)` })),
      el('td', {}, el('div', { text: p.requested_at }), el('div', { class: 'inf-sub inf-id', text: p.payout_id })),
      el('td', {}, el('div', { class: 'inf-actions' }, paid, reject))));

    if (openForm === `paid:${p.payout_id}` || openForm === `rejectpay:${p.payout_id}`) {
      const isPaid = openForm.startsWith('paid:');
      const input = el('input', { id: `pay-${p.payout_id}`, class: 'field-input', type: 'text', maxlength: isPaid ? '100' : '500',
        placeholder: isPaid ? 'UPI reference / UTR of the transfer' : 'Shown to the influencer, e.g. "UPI ID is wrong"' });
      const confirm = el('button', { class: 'btn btn-primary', text: isPaid ? `I have sent ${rupees(p.amount_paise)} — mark paid` : 'Reject withdrawal' });
      confirm.addEventListener('click', () => post('/api/affiliates/payout', {
        payoutId: p.payout_id, decision: isPaid ? 'paid' : 'rejected', reference: isPaid ? input.value : '', reason: isPaid ? '' : input.value
      }, confirm, 'Saving…'));
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '6' }, el('div', { class: 'pc-form' },
        field(isPaid ? `UPI reference for ${rupees(p.amount_paise)} to ${p.upi_id}` : 'Reason', input,
          isPaid ? 'Required. The influencer is sent this so they can find the payment.' : 'Its sales go back to their balance.'),
        el('div', { class: 'support-actions end' },
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => { openForm = null; renderActiveTab(); } }), confirm)))));
    }
  }
  return panel(title, subtitle, el('div', { class: 'table-wrap' }, table(['Influencer', 'Code', 'UPI ID', 'Amount', 'Requested', ''], rows)));
}

// ---------------------------------------------------------------------------
// Promo codes and sales
// ---------------------------------------------------------------------------

function saleStatusPill(status) {
  return pill(status === 'earned' ? 'available' : status, status === 'paid' ? 'ok' : status === 'requested' ? 'warn' : status === 'cancelled' ? 'muted' : 'info');
}

function saleRows(sales) {
  return sales.map((s) => el('tr', {},
    el('td', {}, el('div', { text: s.timestamp }), el('div', { class: 'inf-sub inf-id', text: s.sale_id })),
    el('td', {}, el('code', { class: 'pc-code', text: s.code })),
    el('td', { text: s.group || examLabel(s.exam) }),
    el('td', {}, el('div', { text: who(s.student_name, s.student_username, '') }), el('div', { class: 'inf-sub' }, copyable(s.student_id))),
    el('td', {}, copyable(s.payment_id)),
    el('td', { text: rupees(s.list_price_paise) }),
    el('td', { text: rupees(s.discount_paise) }),
    el('td', { text: rupees(s.paid_paise) }),
    el('td', {}, el('span', { class: 'inf-money', text: rupees(s.commission_paise) })),
    el('td', {}, saleStatusPill(s.status), s.payout_id ? el('div', { class: 'inf-sub inf-id', text: s.payout_id }) : null)));
}
const SALE_HEADERS = ['When', 'Code', 'Group', 'Student', 'Payment ID', 'List', 'Discount', 'Paid', 'Commission', 'Status'];

function codesPanel() {
  const all = data.codes || [];
  const codes = all.filter((c) => examMatches(c.exam) &&
    searchMatches(c.code, c.name, c.username, c.telegram_id, c.upi_id) &&
    (filters.codeStatus === 'all' || (filters.codeStatus === 'owed'
      ? c.stats.availablePaise + c.stats.requestedPaise > 0 : c.status === filters.codeStatus)));
  const bar = filterBar([['Status', statusSelect('codeStatus', [
    ['all', 'Any status'], ['active', 'Active'], ['paused', 'Paused'], ['owed', 'Money owed']])]]);
  const title = '🎁 Promo codes';
  const subtitle = 'Click a code to see its sales. Pause a code to stop it being used — its history stays.';

  if (!all.length) return panel(title, subtitle, emptyState('🎁', 'No promo codes yet.', 'A code is created when you approve an application.'));
  if (!codes.length) return panel(title, subtitle, [bar, emptyState('🔍', 'No code matches those filters.')]);

  const rows = [];
  for (const c of codes) {
    const isOpen = openCodes.has(c.code);
    const toggle = el('button', { class: 'btn btn-ghost', text: c.status === 'active' ? 'Pause' : 'Resume' });
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      post('/api/affiliates/code', { code: c.code, status: c.status === 'active' ? 'paused' : 'active' }, toggle, '…');
    });
    const edit = el('button', { class: 'btn btn-ghost', text: 'Edit terms' });
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openForm = openForm === `edit:${c.code}` ? null : `edit:${c.code}`;
      renderActiveTab();
    });

    const row = el('tr', { class: 'inf-row' + (isOpen ? ' open' : '') },
      el('td', {}, el('span', { class: 'chev', text: '▸' }), ' ', el('code', { class: 'pc-code', text: c.code })),
      el('td', {}, pill(examLabel(c.exam), 'info')),
      el('td', {}, el('div', { text: who(c.name, c.username, '') }), el('div', { class: 'inf-sub' }, copyable(c.telegram_id))),
      el('td', {}, el('div', { text: describeDiscount(c) }), el('div', { class: 'inf-sub', text: describeCommission(c) })),
      el('td', {}, el('div', { text: c.payout_cycle }), el('div', { class: 'inf-sub', text: Number(c.min_payout) ? `min ₹${c.min_payout}` : 'no minimum' })),
      el('td', { text: num(c.stats.uses) }),
      el('td', { text: rupees(c.stats.revenuePaise) }),
      el('td', {}, el('div', { class: 'inf-money', text: rupees(c.stats.availablePaise + c.stats.requestedPaise) }),
        el('div', { class: 'inf-sub', text: `paid ${rupees(c.stats.paidPaise)}` })),
      el('td', {}, pill(c.status, c.status === 'active' ? 'ok' : 'muted')),
      el('td', {}, el('div', { class: 'inf-actions' }, edit, toggle)));
    row.addEventListener('click', () => {
      if (isOpen) openCodes.delete(c.code); else openCodes.add(c.code);
      renderActiveTab();
    });
    rows.push(row);

    if (openForm === `edit:${c.code}`) {
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '10' }, termsForm({
        initial: c, examId: c.exam, codeEditable: false, submitLabel: 'Save new terms',
        onCancel: () => { openForm = null; renderActiveTab(); },
        onSubmit: (terms, button) => post('/api/affiliates/code', { code: c.code, terms }, button, 'Saving…')
      }))));
    }
    if (isOpen) {
      const sales = (data.sales || []).filter((s) => String(s.code).toUpperCase() === String(c.code).toUpperCase());
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '10' },
        el('div', { class: 'inf-detail-meta' },
          el('span', {}, 'UPI: ', copyable(c.upi_id)),
          el('span', {}, 'Link: ', copyable(c.share_link)),
          el('span', { text: c.expires_on ? `Valid until ${c.expires_on}` : 'No end date' }),
          el('span', { text: c.max_uses ? `Up to ${c.max_uses} uses` : 'Unlimited uses' })),
        sales.length ? el('div', { class: 'table-wrap' }, table(SALE_HEADERS, saleRows(sales)))
          : el('p', { class: 'hint-text', text: 'No sales with this code yet.' }))));
    }
  }
  return panel(title, subtitle, [bar, el('div', { class: 'table-wrap' },
    table(['Code', 'Exam', 'Influencer', 'Terms', 'Payouts', 'Uses', 'Revenue', 'Owed', 'Status', ''], rows))]);
}

function salesPanel() {
  const all = data.sales || [];
  const sales = all.filter((s) => examMatches(s.exam) &&
    searchMatches(s.code, s.student_name, s.student_username, s.student_id, s.payment_id, s.influencer_name, s.sale_id) &&
    (filters.saleStatus === 'all' || s.status === filters.saleStatus));
  const bar = filterBar([['Status', statusSelect('saleStatus', [
    ['all', 'Any status'], ['earned', 'Available'], ['requested', 'Requested'], ['paid', 'Paid']])]]);
  return panel('🧾 Every sale', 'One row per payment made with a promo code, newest first', [
    bar,
    sales.length ? el('div', { class: 'table-wrap' }, table(SALE_HEADERS, saleRows(sales)))
      : emptyState('🧾', all.length ? 'No sale matches those filters.' : 'No sales with promo codes yet.')
  ]);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function historyRows() {
  const decided = (data.requests || []).filter((r) => r.status !== 'pending').map((r) => ({
    exam: r.exam, at: r.decided_at, id: r.request_id, by: r.decided_by, who: who(r.name, r.username, r.telegram_id),
    what: r.status === 'approved' ? `✅ Approved → ${r.code}` : `❌ Rejected${r.reason ? ': ' + r.reason : ''}`
  }));
  const payouts = (data.payouts || []).filter((p) => p.status !== 'requested').map((p) => ({
    exam: p.exam, at: p.decided_at, id: p.payout_id, by: p.decided_by, who: who(p.name, p.username, p.influencer_id),
    what: p.status === 'paid' ? `💸 Paid ${rupees(p.amount_paise)} (ref ${p.reference})` : `↩️ Withdrawal rejected${p.reason ? ': ' + p.reason : ''}`
  }));
  return decided.concat(payouts);
}

function historyPanel() {
  const rows = historyRows().filter((h) => examMatches(h.exam) && searchMatches(h.who, h.id, h.what, h.by));
  return panel('🗂 History', 'What was approved, rejected and paid, and by whom', rows.length
    ? el('div', { class: 'table-wrap' }, table(['What', 'Influencer', 'Exam', 'By', 'When', 'Reference'], rows.map((h) => el('tr', {},
      el('td', { text: h.what }), el('td', { text: h.who }), el('td', { text: examLabel(h.exam) }), el('td', { text: h.by }),
      el('td', { text: h.at }), el('td', { class: 'inf-id', text: h.id })))))
    : emptyState('🗂', 'Nothing decided yet.'));
}

function fillExamFilter() {
  const select = $('examFilter');
  const current = select.value;
  replaceChildren(select, el('option', { value: 'all', text: 'Every exam' }),
    (data.exams || []).map((e) => el('option', { value: e.id, text: e.label })));
  select.value = (data.exams || []).some((e) => e.id === current) ? current : 'all';
}

function exportCsv() {
  const cell = (v) => {
    let text = String(v === undefined || v === null ? '' : v);
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['Sale ID', 'Timestamp', 'Code', 'Exam', 'Group', 'Influencer ID', 'Influencer Name', 'Student ID',
    'Student Username', 'Student Name', 'Payment ID', 'List (Rs)', 'Discount (Rs)', 'Paid (Rs)', 'Commission (Rs)',
    'Status', 'Payout ID', 'Paid At'];
  const rows = data.sales.map((s) => [s.sale_id, s.timestamp, s.code, examLabel(s.exam), s.group, s.influencer_id,
    s.influencer_name, s.student_id, s.student_username, s.student_name, s.payment_id,
    s.list_price_paise / 100, s.discount_paise / 100, s.paid_paise / 100, s.commission_paise / 100, s.status, s.payout_id, s.paid_at]);
  const csv = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: `influencer-sales-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('success', `${rows.length} sale(s) exported.`);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load({ quiet = false } = {}) {
  const button = $('refreshBtn');
  button.disabled = true;
  if (!quiet) {
    replaceChildren($('tabBody'), el('div', { class: 'loading-row' },
      [el('div', { class: 'spinner' }), el('span', { text: 'Loading the influencer programme…' })]));
  }
  try {
    const result = await api('/api/affiliates');
    data = result.data || result;
    // The first view is whatever needs a decision.
    if (!activeTab) activeTab = pendingRequests().length || data.notReady ? 'requests' : openPayouts().length ? 'payouts' : 'codes';
    renderNotices();
    renderHowItWorks();
    renderStats();
    fillExamFilter();
    renderTabs();
    renderActiveTab();
  } catch (err) {
    showToast('error', err.message, 9000);
    replaceChildren($('tabBody'), emptyState('⚠️', 'Could not load the influencer programme.', err.message));
  } finally {
    button.disabled = false;
  }
}

initDashboard({
  page: 'influencers',
  onReady: async () => {
    $('refreshBtn').addEventListener('click', () => load());
    $('exportBtn').addEventListener('click', () => { if (data && data.sales) exportCsv(); });
    $('helpBtn').addEventListener('click', () => {
      const box = $('howItWorks');
      box.hidden = !box.hidden;
      $('helpBtn').setAttribute('aria-expanded', String(!box.hidden));
    });
    $('examFilter').addEventListener('change', () => data && !data.notReady && renderActiveTab());
    $('searchInput').addEventListener('input', () => data && !data.notReady && renderActiveTab());
    await load();
  }
});
