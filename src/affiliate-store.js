// ============================================================================
// src/affiliate-store.js — the influencer programme's spreadsheet
// ============================================================================
// One Google Sheet of its own (AFFILIATE_SHEET_ID), shared with the service
// account, holding every record of the programme:
//
//   Influencers — one row per person: who they are and where to pay them
//   Requests    — every application, per exam, and what the admin decided
//   Codes       — every approved code: its exam, its terms, and live totals
//   Sales       — one row per paid use of a code: who paid, what they saved,
//                 what the influencer earned, and whether it has been paid
//   Payouts     — every withdrawal request and how it ended
//   Log         — who did what, when
//
// It is not a group's question sheet and has no Apps Script: everything goes
// through the Sheets API, with the same authenticated, retrying calls the
// question sheets use. Tabs are created on first use, so a blank sheet shared
// with the service account is all the setup it needs.
//
// Money is written in rupees, because a person reads this sheet. It is read
// back into paise, because arithmetic happens in code.
// ============================================================================

const crypto = require('crypto');

const direct = require('./sheets-direct');
const affiliates = require('./affiliates');

const { call, quoteTab, writeHeaderRow, formatPlainTab, appendRows, istNow, parseIstDate } = direct.tabs;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABLES = {
  influencers: {
    tab: 'Influencers',
    headers: ['Telegram ID', 'Username', 'Name', 'UPI ID', 'Joined At', 'Updated At', 'Status', 'Notes',
      'Legal Name', 'Phone', 'Email', 'Payout Method', 'Account Holder', 'Account Number', 'IFSC', 'PAN',
      'Details Complete', 'Applying For'],
    widths: [130, 150, 180, 200, 190, 190, 90, 260, 190, 120, 220, 110, 190, 170, 120, 120, 120, 120]
  },
  requests: {
    tab: 'Requests',
    headers: ['Request ID', 'Created At', 'Telegram ID', 'Username', 'Name', 'Exam', 'Exam Bot', 'Details',
      'Status', 'Decided At', 'Decided By', 'Reason', 'Code'],
    widths: [170, 190, 130, 150, 180, 150, 200, 380, 100, 190, 220, 260, 140]
  },
  codes: {
    tab: 'Codes',
    headers: ['Code', 'Exam', 'Exam Bot', 'Telegram ID', 'Username', 'Name', 'Request ID',
      'Discount Type', 'Discount Value', 'Commission Type', 'Commission Value', 'Payout Cycle', 'Min Payout',
      'Expires On', 'Max Uses', 'One Per Student', 'Status', 'Created At', 'Created By', 'Note',
      'Uses', 'Revenue', 'Commission Earned', 'Commission Paid', 'Share Link', 'Updated At'],
    widths: [140, 140, 200, 130, 150, 180, 170, 110, 110, 130, 130, 110, 110, 110, 90, 110, 90, 190, 220,
      260, 70, 100, 140, 140, 320, 190]
  },
  sales: {
    tab: 'Sales',
    headers: ['Sale ID', 'Timestamp', 'Code', 'Exam', 'Group', 'Influencer ID', 'Influencer Name',
      'Student ID', 'Student Username', 'Student Name', 'Payment ID', 'List Price', 'Discount', 'Paid',
      'Commission', 'Status', 'Payout ID', 'Paid At'],
    widths: [170, 190, 130, 140, 170, 130, 180, 130, 150, 180, 190, 90, 90, 90, 110, 100, 170, 190]
  },
  payouts: {
    tab: 'Payouts',
    headers: ['Payout ID', 'Requested At', 'Code', 'Exam', 'Influencer ID', 'Username', 'Name', 'UPI ID',
      'Amount', 'Sales', 'Sale IDs', 'Status', 'Decided At', 'Decided By', 'Reference', 'Reason',
      'Legal Name', 'Phone', 'Email', 'Payout Method', 'Account Holder', 'Account Number', 'IFSC', 'PAN'],
    widths: [170, 190, 130, 140, 130, 150, 180, 200, 100, 70, 320, 100, 190, 220, 200, 260,
      190, 120, 220, 110, 190, 170, 120, 120]
  },
  opens: {
    tab: 'Link Opens',
    headers: ['Timestamp', 'Code', 'Exam', 'Student ID', 'Student Username', 'Student Name'],
    widths: [190, 130, 140, 130, 160, 180]
  },
  log: {
    tab: 'Log',
    headers: ['Timestamp', 'Actor', 'Action', 'Target', 'Details'],
    widths: [190, 240, 170, 170, 480]
  }
};

/** "Commission Earned" → "commission_earned": how a row is read back. */
function keyOf(header) {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** The spreadsheet id from AFFILIATE_SHEET_ID — the bare id or the whole link. */
function spreadsheetId() {
  const raw = String(process.env.AFFILIATE_SHEET_ID || '').trim();
  return (raw.match(/\/d\/([A-Za-z0-9_-]{20,})/) || [null, raw])[1] || '';
}

/** True when there is a sheet to write to and a service account to write with. */
function isConfigured() {
  return Boolean(spreadsheetId()) && direct.isConfigured();
}

function ctx() {
  const id = spreadsheetId();
  if (!id) throw new Error('AFFILIATE_SHEET_ID is not set, so there is nowhere to keep influencer records.');
  if (!direct.isConfigured()) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  return { spreadsheetId: id };
}

/**
 * read — every row of a tab as objects, each with `_row` (its 1-based row in
 * the sheet). Creates the tab, styled, if it is not there yet.
 *
 * Columns are found by header name, so an admin who reorders or adds columns
 * in the sheet does not scramble what the code reads.
 */
async function read(table) {
  const { tab, headers, widths } = TABLES[table];
  const c = ctx();
  let values;
  try {
    const body = await call('GET',
      `/${c.spreadsheetId}/values/${encodeURIComponent(`${quoteTab(tab)}!A1:ZZ`)}?valueRenderOption=UNFORMATTED_VALUE`);
    values = body.values || [];
  } catch (err) {
    if (!/Unable to parse range|not found/i.test(err.message)) throw err;
    await call('POST', `/${c.spreadsheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }]
    });
    await writeHeaderRow(c, tab, headers);
    await formatPlainTab(c, tab, headers.length, widths);
    return { rows: [], columns: headers.slice() };
  }

  let columns = (values[0] || []).map((h) => String(h || '').trim());
  if (!columns.filter(Boolean).length) {
    await writeHeaderRow(c, tab, headers);
    await formatPlainTab(c, tab, headers.length, widths);
    columns = headers.slice();
  } else {
    // A column this version expects but the sheet lacks goes on the end,
    // rather than writes landing under the wrong heading.
    const missing = headers.filter((h) => !columns.includes(h));
    if (missing.length) {
      columns = columns.concat(missing);
      await writeHeaderRow(c, tab, columns);
    }
  }

  const rows = values.slice(1).map((row, i) => {
    const out = { _row: i + 2 };
    columns.forEach((header, col) => {
      if (!header) return;
      const value = row[col];
      out[keyOf(header)] = value === null || value === undefined ? '' : String(value).trim();
    });
    return out;
  }).filter((row) => Object.keys(row).some((k) => k !== '_row' && row[k] !== ''));
  return { rows, columns };
}

/** An object as a row, in the sheet's own column order. */
function toRow(columns, object) {
  return columns.map((header) => {
    const value = object[keyOf(header)];
    return value === undefined || value === null ? '' : value;
  });
}

async function append(table, objects, columns) {
  const cols = columns || (await read(table)).columns;
  await appendRows(ctx(), TABLES[table].tab, objects.map((o) => toRow(cols, o)));
}

/** Rewrites whole rows in one call. `updates` is [{ row, object }]. */
async function update(table, columns, updates) {
  if (!updates.length) return;
  const c = ctx();
  const tab = TABLES[table].tab;
  const last = direct._internal.columnLetter(columns.length);
  await call('POST', `/${c.spreadsheetId}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: updates.map(({ row, object }) => ({
      range: `${quoteTab(tab)}!A${row}:${last}${row}`,
      values: [toRow(columns, object)]
    }))
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** "REQ-20260922-7K3Q": sortable by day, unguessable enough to not collide. */
function newId(prefix, now = new Date()) {
  const day = istNow(now).replace(/^(\d{2})-(\d{2})-(\d{4}).*/, '$3$2$1');
  return `${prefix}-${day}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);
const toRupees = (paise) => Math.round(Number(paise) || 0) / 100;

/** A sale row with its money in paise, the shape affiliates.summarise reads. */
function saleWithPaise(sale) {
  return Object.assign({}, sale, {
    list_price_paise: toPaise(sale.list_price),
    discount_paise: toPaise(sale.discount),
    paid_paise: toPaise(sale.paid),
    commission_paise: toPaise(sale.commission)
  });
}

/**
 * One operation at a time per key, inside this process. Two taps on
 * Withdraw arriving together must not become two withdrawal requests.
 */
const locks = new Map();
async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function log(actor, action, target, details) {
  try {
    await append('log', [{ timestamp: istNow(), actor, action, target, details }]);
  } catch (err) {
    // The log is a record, not a gate: failing to write it never undoes what happened.
    console.error(`[affiliates] could not write the log: ${err.message}`);
  }
}

function personName(user) {
  return [user && user.first_name, user && user.last_name].filter(Boolean).join(' ') || (user && user.name) || '';
}

// ---------------------------------------------------------------------------
// Influencers
// ---------------------------------------------------------------------------

async function getInfluencer(telegramId) {
  const { rows } = await read('influencers');
  return rows.find((r) => r.telegram_id === String(telegramId)) || null;
}

/**
 * upsertInfluencer — the person's row, created on first contact and kept
 * current. Only the fields given are changed.
 */
async function upsertInfluencer(user, patch = {}) {
  const id = String(user.id || user.telegram_id);
  return withLock(`influencer:${id}`, async () => {
    const { rows, columns } = await read('influencers');
    const existing = rows.find((r) => r.telegram_id === id);
    const now = istNow();
    const fields = {
      username: user.username !== undefined ? String(user.username || '') : undefined,
      name: personName(user) || undefined
    };
    if (existing) {
      const next = Object.assign({}, existing, ...Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => ({ [k]: v })), patch, { updated_at: now });
      await update('influencers', columns, [{ row: existing._row, object: next }]);
      return next;
    }
    const created = Object.assign({
      telegram_id: id, username: fields.username || '', name: fields.name || '', upi_id: '',
      joined_at: now, updated_at: now, status: 'active', notes: ''
    }, patch);
    await append('influencers', [created], columns);
    return created;
  });
}

/**
 * setPayoutField — one payout detail (legal name, phone, email, UPI ID,
 * PAN…), checked before it is stored. `Details Complete` is kept current so
 * the sheet alone says who can be paid.
 */
async function setPayoutField(user, field, raw) {
  const checked = affiliates.checkPayoutField(field, raw);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const current = (await getInfluencer(user.id || user.telegram_id)) || {};
  const patch = { [field]: checked.value };
  // Giving a UPI ID or bank account also says how they want to be paid,
  // unless they already chose the other with its details in place.
  if (field === 'upi_id' && !current.payout_method) patch.payout_method = 'upi';
  const next = Object.assign({}, current, patch);
  patch.details_complete = affiliates.payoutDetails(next).complete ? 'yes' : 'no';
  const saved = await upsertInfluencer(user, patch);
  await log(`Influencer ${saved.telegram_id}`, `${field}_set`, saved.telegram_id,
    field === 'account_number' ? affiliates.maskAccount(checked.value) : checked.value);
  return { ok: true, influencer: saved, value: checked.value };
}

/** Kept for the /upi command and older callers. */
async function setUpi(user, upi) {
  return setPayoutField(user, 'upi_id', upi);
}

/** A bank account in one go: holder, number and IFSC, all checked first. */
async function setBankAccount(user, { holder, number, ifsc }) {
  const checks = [['account_holder', holder], ['account_number', number], ['ifsc', ifsc]]
    .map(([field, raw]) => [field, affiliates.checkPayoutField(field, raw)]);
  const bad = checks.find(([, c]) => !c.ok);
  if (bad) return { ok: false, reason: bad[1].reason };
  const current = (await getInfluencer(user.id || user.telegram_id)) || {};
  const patch = Object.fromEntries(checks.map(([field, c]) => [field, c.value]));
  patch.payout_method = 'bank';
  patch.details_complete = affiliates.payoutDetails(Object.assign({}, current, patch)).complete ? 'yes' : 'no';
  const saved = await upsertInfluencer(user, patch);
  await log(`Influencer ${saved.telegram_id}`, 'bank_set', saved.telegram_id,
    `${patch.account_holder}, ${affiliates.maskAccount(patch.account_number)}, ${patch.ifsc}`);
  return { ok: true, influencer: saved };
}

/** UPI or bank — only to a method whose details are already given. */
async function setPayoutMethod(user, method) {
  const wanted = method === 'bank' ? 'bank' : 'upi';
  const current = (await getInfluencer(user.id || user.telegram_id)) || {};
  const next = Object.assign({}, current, { payout_method: wanted });
  const status = affiliates.payoutDetails(next);
  const own = wanted === 'bank' ? ['account_holder', 'account_number', 'ifsc'] : ['upi_id'];
  if (own.some((f) => status.missing.includes(f))) {
    return { ok: false, reason: wanted === 'bank' ? 'Add your bank account first.' : 'Add your UPI ID first.' };
  }
  const saved = await upsertInfluencer(user, { payout_method: wanted, details_complete: status.complete ? 'yes' : 'no' });
  return { ok: true, influencer: saved };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

async function listRequests() {
  return (await read('requests')).rows;
}

/**
 * createRequest — an influencer asks to promote one exam.
 *
 * Refused while one is already waiting for that exam, or while they already
 * hold an active code for it: a second application would only be a second
 * thing for the admin to turn down.
 */
async function createRequest(user, examId, details) {
  const exam = affiliates.getExam(examId);
  if (!exam || !affiliates.isExamOpen(examId)) {
    return { ok: false, reason: 'That exam is not open for promotion right now.' };
  }
  const text = String(details || '').trim();
  if (text.length < 10) {
    return { ok: false, reason: 'Please tell us a little more — your name, where you will promote, and your audience.' };
  }
  const id = String(user.id);

  return withLock(`apply:${id}:${exam.id}`, async () => {
    const [{ rows, columns }, codes] = await Promise.all([read('requests'), listCodes()]);
    if (rows.some((r) => r.telegram_id === id && r.exam === exam.id && r.status === 'pending')) {
      return { ok: false, reason: `Your application for ${exam.label} is already with the admin.` };
    }
    const held = codes.find((c) => c.telegram_id === id && c.exam === exam.id && c.status === 'active');
    if (held) {
      return { ok: false, reason: `You already have the code ${held.code} for ${exam.label}. Send /codes to see it.` };
    }

    await upsertInfluencer(user);
    const request = {
      request_id: newId('REQ'), created_at: istNow(), telegram_id: id, username: user.username || '',
      name: personName(user), exam: exam.id, exam_bot: exam.botEnv, details: text.slice(0, 1500),
      status: 'pending', decided_at: '', decided_by: '', reason: '', code: ''
    };
    await append('requests', [request], columns);
    await log(`Influencer ${id}`, 'applied', request.request_id, `${exam.label}: ${text.slice(0, 200)}`);
    return { ok: true, request, exam };
  });
}

/**
 * approveRequest — the admin says yes, with terms. Creates the code.
 *
 * @param {string} requestId
 * @param {Object} terms Already through affiliates.validateTerms
 * @param {string} actor Who approved, for the log
 * @param {Object} [options]
 * @param {Function} [options.codeTaken] async (code) => true when a coupon
 *   already uses it, so a promo code can never shadow one
 * @param {string} [options.botUsername] The exam bot's @name, for the share link
 */
async function approveRequest(requestId, terms, actor, { codeTaken = async () => false, botUsername = '' } = {}) {
  return withLock(`request:${requestId}`, async () => {
    const [{ rows, columns }, codesTable] = await Promise.all([read('requests'), read('codes')]);
    const request = rows.find((r) => r.request_id === requestId);
    if (!request) return { ok: false, error: `No request ${requestId}.` };
    if (request.status !== 'pending') return { ok: false, error: `${requestId} was already ${request.status}.` };

    const taken = new Set(codesTable.rows.map((r) => String(r.code).toUpperCase()));
    let code = terms.code;
    if (code) {
      if (taken.has(code) || await codeTaken(code)) return { ok: false, error: `The code ${code} is already in use.` };
    } else {
      for (let attempt = 0; attempt < 20 && !code; attempt++) {
        const candidate = affiliates.suggestCode(request, request.exam);
        if (!taken.has(candidate) && !(await codeTaken(candidate))) code = candidate;
      }
      if (!code) return { ok: false, error: 'Could not find a free code. Type one in instead.' };
    }

    const now = istNow();
    const row = {
      code, exam: request.exam, exam_bot: request.exam_bot, telegram_id: request.telegram_id,
      username: request.username, name: request.name, request_id: request.request_id,
      discount_type: terms.discount_type, discount_value: terms.discount_value,
      commission_type: terms.commission_type, commission_value: terms.commission_value,
      payout_cycle: terms.payout_cycle, min_payout: terms.min_payout,
      expires_on: terms.expires_on, max_uses: terms.max_uses, one_per_student: terms.one_per_student ? 'yes' : 'no',
      status: 'active', created_at: now, created_by: actor, note: terms.note,
      uses: 0, revenue: 0, commission_earned: 0, commission_paid: 0,
      share_link: affiliates.shareLink(botUsername, code), updated_at: now
    };
    await append('codes', [row], codesTable.columns);
    await update('requests', columns, [{
      row: request._row,
      object: Object.assign({}, request, { status: 'approved', decided_at: now, decided_by: actor, code })
    }]);
    await log(actor, 'approved', requestId,
      `${code} for ${request.exam}: ${affiliates.describeDiscount(row)} to students, ` +
      `${affiliates.describeCommission(row)} to ${request.telegram_id}, ${row.payout_cycle}`);
    return { ok: true, code: row, request };
  });
}

async function rejectRequest(requestId, reason, actor) {
  return withLock(`request:${requestId}`, async () => {
    const { rows, columns } = await read('requests');
    const request = rows.find((r) => r.request_id === requestId);
    if (!request) return { ok: false, error: `No request ${requestId}.` };
    if (request.status !== 'pending') return { ok: false, error: `${requestId} was already ${request.status}.` };
    const next = Object.assign({}, request, {
      status: 'rejected', decided_at: istNow(), decided_by: actor, reason: String(reason || '').slice(0, 500)
    });
    await update('requests', columns, [{ row: request._row, object: next }]);
    await log(actor, 'rejected', requestId, next.reason);
    return { ok: true, request: next };
  });
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

async function listCodes() {
  return (await read('codes')).rows;
}

async function getCode(code) {
  const wanted = affiliates.normaliseCode(code);
  return (await listCodes()).find((r) => String(r.code).toUpperCase() === wanted) || null;
}

/** Pauses or resumes a code. Its history stays; a paused code is refused. */
async function setCodeStatus(code, status, actor) {
  const wanted = affiliates.normaliseCode(code);
  const next = status === 'paused' ? 'paused' : 'active';
  return withLock(`code:${wanted}`, async () => {
    const { rows, columns } = await read('codes');
    const row = rows.find((r) => String(r.code).toUpperCase() === wanted);
    if (!row) return { ok: false, error: `No code ${wanted}.` };
    await update('codes', columns, [{ row: row._row, object: Object.assign({}, row, { status: next, updated_at: istNow() }) }]);
    await log(actor, next === 'paused' ? 'code_paused' : 'code_resumed', wanted, '');
    return { ok: true, code: Object.assign({}, row, { status: next }) };
  });
}

/** Changes an active code's terms. Sales already made keep what they earned. */
async function updateCodeTerms(code, terms, actor) {
  const wanted = affiliates.normaliseCode(code);
  return withLock(`code:${wanted}`, async () => {
    const { rows, columns } = await read('codes');
    const row = rows.find((r) => String(r.code).toUpperCase() === wanted);
    if (!row) return { ok: false, error: `No code ${wanted}.` };
    const next = Object.assign({}, row, {
      discount_type: terms.discount_type, discount_value: terms.discount_value,
      commission_type: terms.commission_type, commission_value: terms.commission_value,
      payout_cycle: terms.payout_cycle, min_payout: terms.min_payout, expires_on: terms.expires_on,
      max_uses: terms.max_uses, one_per_student: terms.one_per_student ? 'yes' : 'no',
      note: terms.note, updated_at: istNow()
    });
    await update('codes', columns, [{ row: row._row, object: next }]);
    await log(actor, 'terms_changed', wanted,
      `${affiliates.describeDiscount(next)}; ${affiliates.describeCommission(next)}; ${next.payout_cycle}`);
    return { ok: true, code: next };
  });
}

/** Rewrites a code's Uses / Revenue / Commission columns from its sales. */
async function refreshCodeSummary(code) {
  const wanted = affiliates.normaliseCode(code);
  const [{ rows, columns }, sales] = await Promise.all([read('codes'), listSales()]);
  const row = rows.find((r) => String(r.code).toUpperCase() === wanted);
  if (!row) return;
  const stats = affiliates.summarise(sales.filter((s) => String(s.code).toUpperCase() === wanted));
  await update('codes', columns, [{
    row: row._row,
    object: Object.assign({}, row, {
      uses: stats.uses, revenue: toRupees(stats.revenuePaise),
      commission_earned: toRupees(stats.earnedPaise), commission_paid: toRupees(stats.paidPaise),
      updated_at: istNow()
    })
  }]);
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

async function listSales() {
  return (await read('sales')).rows.map(saleWithPaise);
}

/** Paid uses of a code, overall and by one student — what evaluatePromo needs. */
async function usageOf(code, studentId) {
  const wanted = affiliates.normaliseCode(code);
  const sales = (await listSales()).filter((s) => String(s.code).toUpperCase() === wanted && s.status !== 'cancelled');
  return { uses: sales.length, usesByStudent: sales.filter((s) => s.student_id === String(studentId)).length };
}

/**
 * recordSale — credits the influencer for one paid use of their code.
 *
 * Idempotent on the payment id: Razorpay redelivers webhooks, and a
 * redelivery must not pay the same commission twice.
 *
 * @returns {Promise<{recorded: boolean, sale: Object, code: Object|null}>}
 */
async function recordSale(sale) {
  return withLock(`sale:${sale.payment_id}`, async () => {
    const { rows, columns } = await read('sales');
    const existing = rows.find((r) => r.payment_id === String(sale.payment_id));
    if (existing) return { recorded: false, sale: saleWithPaise(existing), code: await getCode(existing.code) };

    // Credited only against a code that exists: a payment naming a code that is
    // not in the Codes tab (deleted, or typed into the sheet by hand) must not
    // pay whoever the notes happen to name.
    const code = await getCode(sale.code);
    if (!code) {
      console.error(`[affiliates] promo ${sale.code} on ${sale.payment_id} is not in the Codes tab — nothing credited`);
      return { recorded: false, reason: 'unknown code', sale: null, code: null };
    }
    const row = {
      sale_id: newId('SALE'), timestamp: istNow(), code: affiliates.normaliseCode(sale.code),
      exam: code.exam, group: sale.group || '',
      influencer_id: code.telegram_id,
      influencer_name: code.name,
      student_id: String(sale.student_id || ''), student_username: sale.student_username || '',
      student_name: sale.student_name || '', payment_id: String(sale.payment_id),
      list_price: toRupees(sale.list_price_paise), discount: toRupees(sale.discount_paise),
      paid: toRupees(sale.paid_paise), commission: toRupees(sale.commission_paise),
      status: 'earned', payout_id: '', paid_at: ''
    };
    await append('sales', [row], columns);
    await refreshCodeSummary(row.code).catch((err) =>
      console.error(`[affiliates] could not refresh ${row.code}'s totals: ${err.message}`));
    await log('Razorpay', 'sale', row.code,
      `${row.payment_id}: student ${row.student_id} paid ₹${row.paid}, commission ₹${row.commission}`);
    return { recorded: true, sale: saleWithPaise(row), code };
  });
}

// ---------------------------------------------------------------------------
// Link opens
// ---------------------------------------------------------------------------

/**
 * recordLinkOpen — someone opened an influencer's link. Once per student per
 * code, never the code's own influencer, and only for a code that exists.
 * So the admin can see who looked, not only who paid.
 */
async function recordLinkOpen(codeText, user) {
  const wanted = affiliates.normaliseCode(codeText);
  const id = String(user.id);
  return withLock(`open:${wanted}:${id}`, async () => {
    const code = await getCode(wanted);
    if (!code || code.telegram_id === id) return { recorded: false };
    const { rows, columns } = await read('opens');
    if (rows.some((r) => String(r.code).toUpperCase() === wanted && r.student_id === id)) return { recorded: false };
    await append('opens', [{
      timestamp: istNow(), code: wanted, exam: code.exam, student_id: id,
      student_username: user.username || '', student_name: personName(user)
    }], columns);
    return { recorded: true };
  });
}

async function listOpens() {
  return (await read('opens')).rows;
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

async function listPayouts() {
  return (await read('payouts')).rows.map((p) => Object.assign({}, p, { amount_paise: toPaise(p.amount) }));
}

/** Where a code stands for withdrawing: balances plus whether it can go now. */
async function withdrawalStatus(code, influencer, now = new Date()) {
  const wanted = affiliates.normaliseCode(code.code);
  const [sales, payouts] = await Promise.all([listSales(), listPayouts()]);
  const mine = sales.filter((s) => String(s.code).toUpperCase() === wanted);
  const myPayouts = payouts.filter((p) => String(p.code).toUpperCase() === wanted);
  return {
    stats: affiliates.summarise(mine),
    check: affiliates.withdrawal(code, mine, myPayouts, { influencer, now, parseDate: parseIstDate }),
    sales: mine,
    payouts: myPayouts
  };
}

/**
 * requestPayout — an influencer asks for a code's available earnings.
 *
 * Every sale it covers is marked "requested" with the payout's id, so the
 * same rupee can never be in two withdrawals, and so the admin marks paid
 * exactly the sales the influencer was shown.
 */
async function requestPayout(codeText, telegramId, now = new Date()) {
  const wanted = affiliates.normaliseCode(codeText);
  return withLock(`payout:${wanted}`, async () => {
    const code = await getCode(wanted);
    if (!code || code.telegram_id !== String(telegramId)) return { ok: false, reason: 'That is not one of your codes.' };
    const influencer = await getInfluencer(telegramId);
    const { check } = await withdrawalStatus(code, influencer, now);
    if (!check.ok) return { ok: false, reason: check.reason, nextAt: check.nextAt || null };

    const salesTable = await read('sales');
    const covering = salesTable.rows.filter((s) =>
      String(s.code).toUpperCase() === wanted && (s.status === 'earned' || s.status === ''));
    const amountPaise = covering.reduce((sum, s) => sum + toPaise(s.commission), 0);
    if (amountPaise <= 0) return { ok: false, reason: 'Nothing is waiting to be withdrawn yet.' };

    const payout = {
      payout_id: newId('WD', now), requested_at: istNow(now), code: wanted, exam: code.exam,
      influencer_id: code.telegram_id, username: influencer.username || code.username, name: influencer.name || code.name,
      upi_id: influencer.upi_id, amount: toRupees(amountPaise), sales: covering.length,
      // What the admin pays to, as it was when the withdrawal was asked for:
      // a change of UPI ID afterwards must not redirect money already requested.
      legal_name: influencer.legal_name || '', phone: influencer.phone || '', email: influencer.email || '',
      payout_method: affiliates.payoutDetails(influencer).method,
      account_holder: influencer.account_holder || '', account_number: influencer.account_number || '',
      ifsc: influencer.ifsc || '', pan: influencer.pan || '',
      sale_ids: covering.map((s) => s.sale_id).join(', '), status: 'requested',
      decided_at: '', decided_by: '', reference: '', reason: ''
    };
    await append('payouts', [payout]);
    await update('sales', salesTable.columns, covering.map((s) => ({
      row: s._row, object: Object.assign({}, s, { status: 'requested', payout_id: payout.payout_id })
    })));
    await log(`Influencer ${telegramId}`, 'withdrawal_requested', payout.payout_id,
      `${wanted}: ₹${payout.amount} by ${payout.payout_method} to ` +
      `${payout.payout_method === 'bank' ? `${payout.ifsc} ${affiliates.maskAccount(payout.account_number)}` : payout.upi_id}` +
      ` (${payout.sales} sale(s))`);
    return { ok: true, payout: Object.assign({}, payout, { amount_paise: amountPaise }), code };
  });
}

/**
 * decidePayout — the admin marks a withdrawal paid (after sending the money,
 * with the UPI reference) or rejects it (its sales go back to available).
 */
async function decidePayout(payoutId, decision, { reference = '', reason = '', actor }) {
  return withLock(`payoutdecision:${payoutId}`, async () => {
    const { rows, columns } = await read('payouts');
    const payout = rows.find((p) => p.payout_id === payoutId);
    if (!payout) return { ok: false, error: `No withdrawal ${payoutId}.` };
    if (payout.status !== 'requested') return { ok: false, error: `${payoutId} was already ${payout.status}.` };

    const paid = decision === 'paid';
    if (paid && !String(reference).trim()) {
      return { ok: false, error: 'Enter the UPI reference (UTR) of the transfer, so it can be traced.' };
    }
    const now = istNow();
    const next = Object.assign({}, payout, {
      status: paid ? 'paid' : 'rejected', decided_at: now, decided_by: actor,
      reference: paid ? String(reference).trim().slice(0, 100) : '',
      reason: paid ? '' : String(reason || '').trim().slice(0, 500)
    });
    await update('payouts', columns, [{ row: payout._row, object: next }]);

    const salesTable = await read('sales');
    const covered = salesTable.rows.filter((s) => s.payout_id === payoutId);
    await update('sales', salesTable.columns, covered.map((s) => ({
      row: s._row,
      object: Object.assign({}, s, paid
        ? { status: 'paid', paid_at: now }
        : { status: 'earned', payout_id: '' })
    })));
    await refreshCodeSummary(payout.code).catch((err) =>
      console.error(`[affiliates] could not refresh ${payout.code}'s totals: ${err.message}`));
    await log(actor, paid ? 'withdrawal_paid' : 'withdrawal_rejected', payoutId,
      paid ? `₹${payout.amount} to ${payout.upi_id}, ref ${next.reference}` : next.reason);
    return { ok: true, payout: Object.assign({}, next, { amount_paise: toPaise(next.amount) }) };
  });
}

// ---------------------------------------------------------------------------
// Everything, for the dashboard
// ---------------------------------------------------------------------------

async function overview() {
  const [influencers, requests, codes, sales, payouts, opens] = await Promise.all([
    read('influencers').then((t) => t.rows), listRequests(), listCodes(), listSales(), listPayouts(), listOpens()
  ]);
  return { influencers, requests, codes, sales, payouts, opens };
}

// ---------------------------------------------------------------------------
// Making the sheet readable
// ---------------------------------------------------------------------------

/** Money columns, shown as ₹1,234.50. */
const MONEY_COLUMNS = {
  codes: ['Min Payout', 'Revenue', 'Commission Earned', 'Commission Paid'],
  sales: ['List Price', 'Discount', 'Paid', 'Commission'],
  payouts: ['Amount']
};

/** Every value a Status column can hold, and its colours — the Subscribers tab's palette. */
const STATUS_COLOURS = {
  influencers: { active: 'ok', blocked: 'bad' },
  requests: { pending: 'wait', approved: 'ok', rejected: 'bad' },
  codes: { active: 'ok', paused: 'off' },
  sales: { earned: 'info', requested: 'wait', paid: 'ok', cancelled: 'off' },
  payouts: { requested: 'wait', paid: 'ok', rejected: 'bad' }
};
const TONES = {
  ok: ['#c8e6c9', '#1b5e20'],
  wait: ['#fff9c4', '#f57f17'],
  bad: ['#ffcdd2', '#b71c1c'],
  off: ['#eceff1', '#455a64'],
  info: ['#e3f2fd', '#0d47a1']
};

function colour(hex) {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255
  };
}

/**
 * styleWorkbook — ₹ formatting on money, a coloured dropdown on every Status
 * column, and the blank "Sheet1" a new spreadsheet starts with removed.
 *
 * Safe to run again: it clears the conditional rules on these tabs before
 * adding its own, so they never pile up. Best effort — a formatting failure
 * never costs a record.
 */
async function styleWorkbook() {
  const c = ctx();
  const columnsOf = {};
  for (const table of Object.keys(TABLES)) columnsOf[table] = (await read(table)).columns;

  const meta = await call('GET', `/${c.spreadsheetId}?fields=sheets(properties(sheetId,title),conditionalFormats)`);
  const sheetsByTitle = new Map((meta.sheets || []).map((sh) => [sh.properties.title, sh]));
  const requests = [];

  for (const [table, { tab }] of Object.entries(TABLES)) {
    const sheet = sheetsByTitle.get(tab);
    if (!sheet) continue;
    const sheetId = sheet.properties.sheetId;
    const columns = columnsOf[table];

    // Old rules first, last to first so the indexes stay valid.
    for (let i = (sheet.conditionalFormats || []).length - 1; i >= 0; i--) {
      requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
    }

    for (const header of MONEY_COLUMNS[table] || []) {
      const col = columns.indexOf(header);
      if (col === -1) continue;
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"₹"#,##0.00' } } },
          fields: 'userEnteredFormat.numberFormat'
        }
      });
    }

    const statusCol = columns.indexOf('Status');
    const statuses = STATUS_COLOURS[table];
    if (statusCol !== -1 && statuses) {
      const range = { sheetId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 };
      Object.entries(statuses).forEach(([value, tone], index) => {
        requests.push({
          addConditionalFormatRule: {
            index,
            rule: {
              ranges: [range],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
                format: { backgroundColor: colour(TONES[tone][0]), textFormat: { foregroundColor: colour(TONES[tone][1]), bold: true } }
              }
            }
          }
        });
      });
      // A dropdown, so a status typed by hand is one the code understands.
      // Not strict: a warning, never a refused write.
      requests.push({
        setDataValidation: {
          range,
          rule: {
            condition: { type: 'ONE_OF_LIST', values: Object.keys(statuses).map((v) => ({ userEnteredValue: v })) },
            strict: false,
            showCustomUi: true
          }
        }
      });
    }
  }

  // The empty tab every new spreadsheet starts with, removed only if empty.
  const blank = ['Sheet1', 'Sheet 1'].map((t) => sheetsByTitle.get(t)).find(Boolean);
  if (blank && !Object.values(TABLES).some((t) => t.tab === blank.properties.title)) {
    let empty = false;
    try {
      const body = await call('GET', `/${c.spreadsheetId}/values/${encodeURIComponent(`${quoteTab(blank.properties.title)}!A1:Z50`)}`);
      empty = !(body.values || []).some((row) => row.some((v) => String(v || '').trim()));
    } catch (err) {
      empty = false;
    }
    if (empty) requests.push({ deleteSheet: { sheetId: blank.properties.sheetId } });
  }

  if (requests.length) {
    try {
      await call('POST', `/${c.spreadsheetId}:batchUpdate`, { requests });
    } catch (err) {
      console.warn(`[affiliates] could not style the sheet: ${err.message}`);
      return false;
    }
  }
  return true;
}

/** Creates every tab, styled, for a freshly shared sheet. Safe to run again. */
async function ensureTabs() {
  for (const table of Object.keys(TABLES)) await read(table);
  await styleWorkbook();
  return Object.values(TABLES).map((t) => t.tab);
}

module.exports = {
  TABLES,
  isConfigured,
  spreadsheetId,
  ensureTabs,
  styleWorkbook,
  getInfluencer,
  upsertInfluencer,
  setUpi,
  setPayoutField,
  setBankAccount,
  setPayoutMethod,
  recordLinkOpen,
  listOpens,
  listRequests,
  createRequest,
  approveRequest,
  rejectRequest,
  listCodes,
  getCode,
  setCodeStatus,
  updateCodeTerms,
  refreshCodeSummary,
  listSales,
  usageOf,
  recordSale,
  listPayouts,
  withdrawalStatus,
  requestPayout,
  decidePayout,
  overview,
  _internal: { keyOf, toRow, newId }
};
