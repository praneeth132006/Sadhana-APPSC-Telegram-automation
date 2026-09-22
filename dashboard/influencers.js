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
  initDashboard, api, el, replaceChildren, statCard, emptyState, pill, num, showToast, $
} from './shared.js';

/** Latest /api/affiliates payload. */
let data = null;

/** Which code rows are open, and which request/payout has a form open. */
const openCodes = new Set();
let openForm = null;

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
      await load();
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
  const commissionType = select('ctype', [['percent', '% of what the student pays'], ['flat', '₹ per sale']], t.commission_type);
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
      field('Student discount', el('div', { class: 'inf-actions' }, discountType, discountValue), `On the ${rupees(pricePaise)} ${examLabel(examId)} pass.`),
      field('Influencer commission', el('div', { class: 'inf-actions' }, commissionType, commissionValue), 'Worked out on what the student actually pays.'),
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
// Rendering
// ---------------------------------------------------------------------------

function renderSetup() {
  const s = data.status || {};
  const missing = [];
  if (!s.sheet) {
    missing.push(el('li', {}, 'Create a blank Google Sheet, share it with ', el('code', { text: s.serviceAccount || 'the service account' }),
      ' as an Editor, and set ', el('code', { text: 'AFFILIATE_SHEET_ID' }), ' to its link.'));
  }
  if (!s.bot) missing.push(el('li', {}, 'Create the influencer bot with @BotFather and set ', el('code', { text: 'TELEGRAM_AFFILIATE_BOT' }), '.'));
  if (!s.adminChat) missing.push(el('li', {}, 'No admin chat for alerts: set SUPPORT_CHAT_ID (or AFFILIATE_ADMIN_CHAT_ID) and add the influencer bot to it.'));

  $('botBadge').textContent = data.botUsername ? `Influencer bot: @${data.botUsername}` : '';
  const link = $('sheetLink');
  if (s.sheetUrl) { link.href = s.sheetUrl; link.style.display = ''; } else link.style.display = 'none';

  replaceChildren($('setupArea'), missing.length
    ? el('section', { class: 'panel' }, el('div', { class: 'panel-body inf-setup' },
      el('strong', { text: '⚙️ Finish setting up the influencer programme' }), el('ul', {}, missing)))
    : null);
}

function renderStats() {
  const t = data.totals;
  replaceChildren($('statGrid'),
    statCard('Influencers', num(t.influencers), { tone: 'info', sub: `${num(t.activeCodes)} active code(s)` }),
    statCard('Applications Waiting', num(t.pendingRequests), { tone: t.pendingRequests ? 'warn' : 'ok', sub: 'need a decision' }),
    statCard('Students via Codes', num(t.uses), { tone: 'ok', sub: `paid ${rupees(t.revenuePaise)}` }),
    statCard('Commission Earned', rupees(t.earnedPaise), { tone: 'info', sub: `students saved ${rupees(t.discountPaise)}` }),
    statCard('Owed to Influencers', rupees(t.availablePaise + t.requestedPaise), {
      tone: t.requestedPaise ? 'warn' : 'ok', sub: `${rupees(t.requestedPaise)} requested (${num(t.openPayouts)})`
    }),
    statCard('Paid Out', rupees(t.paidPaise), { tone: 'muted', sub: 'withdrawals sent' })
  );
}

function renderRequests() {
  const pending = data.requests.filter((r) => r.status === 'pending');
  if (!pending.length) {
    replaceChildren($('requestsArea'), emptyState('✅', 'No applications waiting.',
      data.botUsername ? `Influencers apply in @${data.botUsername}.` : 'Influencers apply through the influencer bot.'));
    return;
  }
  const rows = [];
  for (const r of pending) {
    const approve = el('button', { class: 'btn btn-primary', text: 'Approve…' });
    const reject = el('button', { class: 'btn btn-ghost', text: 'Reject…' });
    approve.addEventListener('click', () => { openForm = `approve:${r.request_id}`; renderRequests(); });
    reject.addEventListener('click', () => { openForm = `reject:${r.request_id}`; renderRequests(); });
    rows.push(el('tr', {},
      el('td', {}, el('div', { text: who(r.name, r.username, '') }), copyable(r.telegram_id)),
      el('td', {}, el('strong', { text: examLabel(r.exam) })),
      el('td', {}, el('div', { class: 'inf-details', text: r.details })),
      el('td', {}, el('div', { text: r.created_at }), el('div', { class: 'inf-sub inf-id', text: r.request_id })),
      el('td', {}, el('div', { class: 'inf-actions' }, approve, reject))));

    if (openForm === `approve:${r.request_id}`) {
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '5' }, termsForm({
        initial: { code: r.suggested_code }, examId: r.exam, codeEditable: true,
        submitLabel: `Approve and send the code`,
        onCancel: () => { openForm = null; renderRequests(); },
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
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => { openForm = null; renderRequests(); } }), confirm)))));
    }
  }
  replaceChildren($('requestsArea'), table(['Influencer', 'Exam', 'Where they will promote', 'Applied', ''], rows));
}

function renderPayouts() {
  const open = data.payouts.filter((p) => p.status === 'requested');
  if (!open.length) {
    replaceChildren($('payoutsArea'), emptyState('✅', 'No withdrawals waiting.', 'Influencers request them from the bot once their cycle comes round.'));
    return;
  }
  const rows = [];
  for (const p of open) {
    const paid = el('button', { class: 'btn btn-primary', text: 'Mark paid…' });
    const reject = el('button', { class: 'btn btn-ghost', text: 'Reject…' });
    paid.addEventListener('click', () => { openForm = `paid:${p.payout_id}`; renderPayouts(); });
    reject.addEventListener('click', () => { openForm = `rejectpay:${p.payout_id}`; renderPayouts(); });
    rows.push(el('tr', {},
      el('td', {}, el('div', { text: who(p.name, p.username, '') }), copyable(p.influencer_id)),
      el('td', {}, el('code', { text: p.code }), el('div', { class: 'inf-sub', text: examLabel(p.exam) })),
      el('td', {}, copyable(p.upi_id)),
      el('td', {}, el('strong', { text: rupees(p.amount_paise) }), el('div', { class: 'inf-sub', text: `${p.sales} sale(s)` })),
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
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => { openForm = null; renderPayouts(); } }), confirm)))));
    }
  }
  replaceChildren($('payoutsArea'), table(['Influencer', 'Code', 'UPI ID', 'Amount', 'Requested', ''], rows));
}

function saleRows(sales) {
  return sales.map((s) => el('tr', {},
    el('td', {}, el('div', { text: s.timestamp }), el('div', { class: 'inf-sub inf-id', text: s.sale_id })),
    el('td', {}, el('code', { text: s.code })),
    el('td', { text: s.group || examLabel(s.exam) }),
    el('td', {}, el('div', { text: who(s.student_name, s.student_username, '') }), copyable(s.student_id)),
    el('td', {}, copyable(s.payment_id)),
    el('td', { text: rupees(s.list_price_paise) }),
    el('td', { text: rupees(s.discount_paise) }),
    el('td', { text: rupees(s.paid_paise) }),
    el('td', {}, el('strong', { text: rupees(s.commission_paise) })),
    el('td', {}, pill(s.status === 'earned' ? 'available' : s.status, s.status === 'paid' ? 'ok' : s.status === 'requested' ? 'warn' : 'info'),
      s.payout_id ? el('div', { class: 'inf-sub inf-id', text: s.payout_id }) : null)));
}
const SALE_HEADERS = ['When', 'Code', 'Group', 'Student', 'Payment ID', 'List', 'Discount', 'Paid', 'Commission', 'Status'];

function renderCodes() {
  const q = $('codeSearch').value.trim().toLowerCase();
  const exam = $('codeExam').value;
  const status = $('codeStatus').value;
  const codes = data.codes.filter((c) =>
    (!q || haystack(c.code, c.name, c.username, c.telegram_id).includes(q)) &&
    (exam === 'all' || c.exam === exam) &&
    (status === 'all' || (status === 'owed' ? c.stats.availablePaise + c.stats.requestedPaise > 0 : c.status === status)));

  if (!data.codes.length) {
    replaceChildren($('codesArea'), emptyState('🎁', 'No promo codes yet.', 'A code is created when you approve an application.'));
    return;
  }
  if (!codes.length) {
    replaceChildren($('codesArea'), emptyState('🔍', 'No code matches those filters.'));
    return;
  }

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
      renderCodes();
    });

    const row = el('tr', { class: 'inf-row' + (isOpen ? ' open' : '') },
      el('td', {}, el('span', { class: 'chev', text: '▸' }), ' ', el('code', { text: c.code })),
      el('td', { text: examLabel(c.exam) }),
      el('td', {}, el('div', { text: who(c.name, c.username, '') }), copyable(c.telegram_id)),
      el('td', {}, el('div', { text: describeDiscount(c) }), el('div', { class: 'inf-sub', text: describeCommission(c) })),
      el('td', {}, el('div', { text: c.payout_cycle }), el('div', { class: 'inf-sub', text: Number(c.min_payout) ? `min ₹${c.min_payout}` : 'no minimum' })),
      el('td', { text: num(c.stats.uses) }),
      el('td', { text: rupees(c.stats.revenuePaise) }),
      el('td', {}, el('strong', { text: rupees(c.stats.availablePaise + c.stats.requestedPaise) }),
        el('div', { class: 'inf-sub', text: `paid ${rupees(c.stats.paidPaise)}` })),
      el('td', {}, pill(c.status, c.status === 'active' ? 'ok' : 'muted')),
      el('td', {}, el('div', { class: 'inf-actions' }, edit, toggle)));
    row.addEventListener('click', () => {
      if (isOpen) openCodes.delete(c.code); else openCodes.add(c.code);
      renderCodes();
    });
    rows.push(row);

    if (openForm === `edit:${c.code}`) {
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '10' }, termsForm({
        initial: c, examId: c.exam, codeEditable: false, submitLabel: 'Save new terms',
        onCancel: () => { openForm = null; renderCodes(); },
        onSubmit: (terms, button) => post('/api/affiliates/code', { code: c.code, terms }, button, 'Saving…')
      }))));
    }
    if (isOpen) {
      const sales = data.sales.filter((s) => String(s.code).toUpperCase() === String(c.code).toUpperCase());
      rows.push(el('tr', { class: 'inf-form-row' }, el('td', { colspan: '10' },
        el('div', { class: 'inf-sub' }, 'UPI: ', copyable(c.upi_id), '   Link: ', copyable(c.share_link)),
        sales.length ? table(SALE_HEADERS, saleRows(sales)) : el('p', { class: 'inf-sub', text: 'No sales with this code yet.' }))));
    }
  }
  replaceChildren($('codesArea'), table(['Code', 'Exam', 'Influencer', 'Terms', 'Payouts', 'Uses', 'Revenue', 'Owed', 'Status', ''], rows));
}

function renderSales() {
  const q = $('saleSearch').value.trim().toLowerCase();
  const status = $('saleStatus').value;
  const sales = data.sales.filter((s) =>
    (!q || haystack(s.code, s.student_name, s.student_username, s.student_id, s.payment_id, s.influencer_name).includes(q)) &&
    (status === 'all' || s.status === status));
  replaceChildren($('salesArea'), sales.length
    ? table(SALE_HEADERS, saleRows(sales))
    : emptyState('🧾', data.sales.length ? 'No sale matches those filters.' : 'No sales with promo codes yet.'));
}

function renderHistory() {
  const decided = data.requests.filter((r) => r.status !== 'pending').map((r) => ({
    at: r.decided_at, what: r.status === 'approved' ? `✅ Approved → ${r.code}` : `❌ Rejected${r.reason ? ': ' + r.reason : ''}`,
    who: who(r.name, r.username, r.telegram_id), exam: examLabel(r.exam), by: r.decided_by, id: r.request_id
  }));
  const payouts = data.payouts.filter((p) => p.status !== 'requested').map((p) => ({
    at: p.decided_at, what: p.status === 'paid' ? `💸 Paid ${rupees(p.amount_paise)} (ref ${p.reference})` : `↩️ Withdrawal rejected${p.reason ? ': ' + p.reason : ''}`,
    who: who(p.name, p.username, p.influencer_id), exam: examLabel(p.exam), by: p.decided_by, id: p.payout_id
  }));
  const all = decided.concat(payouts);
  replaceChildren($('historyArea'), all.length
    ? table(['What', 'Influencer', 'Exam', 'By', 'When', 'Reference'], all.map((h) => el('tr', {},
      el('td', { text: h.what }), el('td', { text: h.who }), el('td', { text: h.exam }), el('td', { text: h.by }),
      el('td', { text: h.at }), el('td', { class: 'inf-id', text: h.id }))))
    : emptyState('🗂', 'Nothing decided yet.'));
}

function fillExamFilter() {
  const select = $('codeExam');
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

async function load() {
  const button = $('refreshBtn');
  button.disabled = true;
  try {
    const result = await api('/api/affiliates');
    data = result.data || result;
    renderSetup();
    if (data.notReady) {
      ['statGrid', 'requestsArea', 'payoutsArea', 'codesArea', 'salesArea', 'historyArea'].forEach((id) => replaceChildren($(id)));
      return;
    }
    renderStats();
    renderRequests();
    renderPayouts();
    fillExamFilter();
    renderCodes();
    renderSales();
    renderHistory();
  } catch (err) {
    showToast('error', err.message, 9000);
    replaceChildren($('requestsArea'), emptyState('⚠️', 'Could not load the influencer programme.', err.message));
  } finally {
    button.disabled = false;
  }
}

initDashboard({
  page: 'influencers',
  onReady: async () => {
    $('refreshBtn').addEventListener('click', load);
    $('exportBtn').addEventListener('click', () => { if (data && data.sales) exportCsv(); });
    $('codeSearch').addEventListener('input', () => data && data.codes && renderCodes());
    ['codeExam', 'codeStatus'].forEach((id) => $(id).addEventListener('change', () => data && data.codes && renderCodes()));
    $('saleSearch').addEventListener('input', () => data && data.sales && renderSales());
    $('saleStatus').addEventListener('change', () => data && data.sales && renderSales());
    await load();
  }
});
