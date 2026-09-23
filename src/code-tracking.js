// ============================================================================
// src/code-tracking.js — who came in on a code, and how far they got
// ============================================================================
// A coupon in an ad, or an influencer's promo code, is only worth what it
// brings in. This keeps one row per student per code in the "Code Tracking"
// tab of the payment bot's first group sheet (where its Coupons already live),
// so the dashboard can say, for every code:
//
//   clicked      — opened the bot from the code's link (t.me/<bot>?start=promo_CODE)
//   applied      — saw the discounted price (from the link, or by typing it)
//   refused      — the code was real but could not be used (expired, used up…)
//   link created — made a Razorpay payment link at the discounted price
//   paid         — the payment went through (from the Razorpay webhook)
//
// and, most usefully, who created a payment link and never paid.
//
// A row only ever moves forward: each event fills in its own columns and never
// clears another's, so a student who clicked, applied, created a link and paid
// shows all four times. Stage is worked out from those columns when read, so a
// link that expired overnight shows as expired without anything being written.
//
// Everything here is best effort by design. Tracking must never slow down or
// break a student's purchase: callers fire and forget, and every failure is a
// log line, not an error the student sees.
// ============================================================================

const direct = require('./sheets-direct');
const groups = require('./groups');

const { call, quoteTab, writeHeaderRow, formatPlainTab, appendRows, istNow, parseIstDate } = direct.tabs;

const TAB = 'Code Tracking';
const HEADERS = ['Code', 'Kind', 'Student ID', 'Username', 'Name', 'Group', 'Source', 'Stage',
  'First Seen', 'Last Activity', 'Clicked At', 'Clicks', 'Applied At', 'Refused At', 'Refused Reason',
  'Link Created At', 'Links Created', 'Amount', 'Link ID', 'Link Status', 'Failed Attempts',
  'Paid At', 'Payment ID', 'Paid Amount', 'Checked At'];
const WIDTHS = [120, 80, 120, 150, 170, 170, 80, 150, 190, 190, 190, 60, 190, 190, 240,
  190, 70, 80, 200, 100, 80, 190, 200, 90, 190];

/** A Razorpay payment link lives this long (src/razorpay.js sets expire_by). */
const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Stages, furthest first. `label` is what the dashboard and the sheet show.
 * paid_unrecorded is a warning: Razorpay says paid but no webhook reached us,
 * so the student may have paid without being let in.
 */
const STAGES = {
  paid: { order: 7, label: 'Paid' },
  paid_unrecorded: { order: 6, label: 'Paid on Razorpay — not recorded' },
  link_pending: { order: 5, label: 'Payment link created — not paid yet' },
  link_expired: { order: 4, label: 'Payment link expired — did not pay' },
  applied: { order: 3, label: 'Applied code — no payment link' },
  refused: { order: 2, label: 'Code refused' },
  clicked: { order: 1, label: 'Clicked link only' }
};

/** "Link Created At" → "link_created_at". */
function keyOf(header) {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function toRow(columns, object) {
  return columns.map((header) => {
    const value = object[keyOf(header)];
    return value === undefined || value === null ? '' : value;
  });
}

const normaliseCode = (code) => String(code || '').trim().toUpperCase();

// ---------------------------------------------------------------------------
// Where the tab lives
// ---------------------------------------------------------------------------

/** The first ready group of a payment bot's family: where its coupons live. */
function primaryGroupFor(payBotEnv) {
  const family = groups.listGroups().filter((g) => g.paymentBotEnv === payBotEnv);
  return family.find((g) => g.ready) || family[0] || null;
}

function contextFor(payBotEnv) {
  const group = primaryGroupFor(payBotEnv);
  if (!group) throw new Error(`No group is sold by ${payBotEnv}.`);
  if (!group.sheetId) throw new Error(`SHEET_ID_${group.envPrefix} is not set, so there is nowhere to keep code tracking.`);
  if (!direct.isConfigured()) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  return { spreadsheetId: group.sheetId };
}

/** True when this bot's code tracking can be written. */
function isConfigured(payBotEnv) {
  try {
    contextFor(payBotEnv);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * read — every row, each with `_row`. Creates the tab on first use and adds
 * any column a newer version expects, like src/affiliate-store.js.
 */
async function read(payBotEnv) {
  const c = contextFor(payBotEnv);
  let values;
  try {
    const body = await call('GET',
      `/${c.spreadsheetId}/values/${encodeURIComponent(`${quoteTab(TAB)}!A1:ZZ`)}?valueRenderOption=UNFORMATTED_VALUE`);
    values = body.values || [];
  } catch (err) {
    if (!/Unable to parse range|not found/i.test(err.message)) throw err;
    await call('POST', `/${c.spreadsheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } } }]
    });
    await writeHeaderRow(c, TAB, HEADERS);
    await formatPlainTab(c, TAB, HEADERS.length, WIDTHS);
    return { rows: [], columns: HEADERS.slice() };
  }

  let columns = (values[0] || []).map((h) => String(h || '').trim());
  if (!columns.filter(Boolean).length) {
    await writeHeaderRow(c, TAB, HEADERS);
    await formatPlainTab(c, TAB, HEADERS.length, WIDTHS);
    columns = HEADERS.slice();
  } else {
    const missing = HEADERS.filter((h) => !columns.includes(h));
    if (missing.length) {
      columns = columns.concat(missing);
      await writeHeaderRow(c, TAB, columns);
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
  }).filter((row) => row.code && row.student_id);
  return { rows, columns };
}

async function writeRow(payBotEnv, columns, row, object) {
  const c = contextFor(payBotEnv);
  const last = direct._internal.columnLetter(columns.length);
  await call('POST', `/${c.spreadsheetId}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: [{ range: `${quoteTab(TAB)}!A${row}:${last}${row}`, values: [toRow(columns, object)] }]
  });
}

// One write at a time per bot within this process: two events for the same
// student (a click and an apply a second apart) must not both append a row.
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

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

/**
 * stageOf — where a row stands now. Worked out, not stored, because a link
 * that was pending last night has expired this morning without any event.
 */
function stageOf(row, now = new Date()) {
  if (row.paid_at) return 'paid';
  const status = String(row.link_status || '').toLowerCase();
  if (row.link_created_at) {
    if (status === 'paid') return 'paid_unrecorded';
    if (status === 'expired' || status === 'cancelled') return 'link_expired';
    const created = parseIstDate(row.link_created_at);
    if (created && now.getTime() - created.getTime() > LINK_LIFETIME_MS) return 'link_expired';
    return 'link_pending';
  }
  if (row.applied_at) return 'applied';
  if (row.refused_at) return 'refused';
  return 'clicked';
}

function withStage(row, now) {
  const stage = stageOf(row, now);
  return Object.assign({}, row, { stage, stage_label: STAGES[stage].label });
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * record — one event for one student and one code.
 *
 * @param {string} payBotEnv The bot the student is talking to
 * @param {Object} event
 * @param {string} event.type clicked | applied | refused | link_created | paid
 * @param {string} event.code
 * @param {Object} event.student { id, username, first_name, last_name } or { id, username, name }
 * @param {string} [event.kind] coupon | promo
 * @param {string} [event.group] The group's short name
 * @param {string} [event.source] link | typed
 * @param {string} [event.reason] Why a code was refused
 * @param {number} [event.amountPaise] The price on the payment link
 * @param {string} [event.linkId] Razorpay payment link id
 * @param {string} [event.paymentId]
 * @param {number} [event.paidPaise]
 * @param {Date}   [event.now]
 * @returns {Promise<Object>} The row as written
 */
async function record(payBotEnv, event) {
  const code = normaliseCode(event.code);
  const student = event.student || {};
  const id = String(student.id || student.telegram_id || '').trim();
  if (!code || !id) throw new Error('A code and a student id are needed to track a code.');
  const when = istNow(event.now || new Date());

  return withLock(`tracking:${payBotEnv}`, async () => {
    const { rows, columns } = await read(payBotEnv);
    const existing = rows.find((r) => normaliseCode(r.code) === code && r.student_id === id);
    const row = Object.assign({
      code, kind: '', student_id: id, username: '', name: '', group: '', source: '', stage: '',
      first_seen: when, clicks: '', links_created: '', failed_attempts: ''
    }, existing || {});

    // Who they are, refreshed from whatever this event knows.
    const name = student.name || [student.first_name, student.last_name].filter(Boolean).join(' ');
    if (student.username) row.username = String(student.username).replace(/^@/, '');
    if (name) row.name = name;
    if (event.kind) row.kind = event.kind;
    if (event.group) row.group = event.group;
    // The first way in is the one that counts: an ad click that is later
    // re-typed still came from the ad.
    if (event.source && !row.source) row.source = event.source;
    row.last_activity = when;

    switch (event.type) {
      case 'clicked':
        if (!row.clicked_at) row.clicked_at = when;
        row.clicks = (Number(row.clicks) || 0) + 1;
        break;
      case 'applied':
        row.applied_at = when;
        break;
      case 'refused':
        row.refused_at = when;
        row.refused_reason = String(event.reason || '').slice(0, 300);
        break;
      case 'link_created':
        if (!row.applied_at) row.applied_at = when;
        row.link_created_at = when;
        row.links_created = (Number(row.links_created) || 0) + 1;
        row.amount = (Number(event.amountPaise) || 0) / 100;
        row.link_id = event.linkId || '';
        row.link_status = 'created';
        break;
      case 'paid':
        row.paid_at = when;
        row.payment_id = event.paymentId || '';
        row.paid_amount = (Number(event.paidPaise) || 0) / 100;
        row.link_status = 'paid';
        break;
      default:
        throw new Error(`Unknown tracking event "${event.type}".`);
    }
    row.stage = STAGES[stageOf(row)].label;

    const clean = Object.assign({}, row);
    delete clean._row;
    if (existing) await writeRow(payBotEnv, columns, existing._row, clean);
    else await appendRows(contextFor(payBotEnv), TAB, [toRow(columns, clean)]);
    return clean;
  });
}

/**
 * safeRecord — record, but never throws: for the bot and the webhook, where
 * a tracking failure must not reach the student.
 */
async function safeRecord(payBotEnv, event) {
  if (!isConfigured(payBotEnv)) return null;
  try {
    return await record(payBotEnv, event);
  } catch (err) {
    console.error(`[tracking] ${payBotEnv}: could not record ${event && event.type} for ` +
      `${event && event.code} — ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading, for the dashboard
// ---------------------------------------------------------------------------

/** Every tracked row, newest activity first, each with its current stage. */
async function list(payBotEnv, { code = '', now = new Date() } = {}) {
  const wanted = normaliseCode(code);
  const { rows } = await read(payBotEnv);
  const time = (text) => {
    const d = parseIstDate(text);
    return d ? d.getTime() : 0;
  };
  return rows
    .filter((r) => !wanted || normaliseCode(r.code) === wanted)
    .map((r) => withStage(r, now))
    .sort((a, b) => time(b.last_activity) - time(a.last_activity));
}

/**
 * summarise — the funnel for a set of rows. Each count is of people, and a
 * person counts in every step they reached: someone who paid also clicked (if
 * they came by link), applied and created a link.
 */
function summarise(rows) {
  const out = {
    people: rows.length, clicked: 0, clicks: 0, applied: 0, refused: 0, linkCreated: 0, links: 0,
    paid: 0, notPaid: 0, pending: 0, expired: 0, unrecorded: 0, appliedNoLink: 0, clickedOnly: 0,
    revenue: 0, fromLink: 0, typed: 0
  };
  for (const r of rows) {
    const stage = r.stage || stageOf(r);
    if (r.clicked_at) out.clicked++;
    out.clicks += Number(r.clicks) || 0;
    if (r.applied_at || r.link_created_at || r.paid_at) out.applied++;
    if (r.refused_at && !r.applied_at) out.refused++;
    if (r.link_created_at) out.linkCreated++;
    out.links += Number(r.links_created) || 0;
    if (stage === 'paid') {
      out.paid++;
      out.revenue += Number(r.paid_amount) || 0;
    }
    if (stage === 'link_pending') out.pending++;
    if (stage === 'link_expired') out.expired++;
    if (stage === 'paid_unrecorded') out.unrecorded++;
    if (stage === 'applied') out.appliedNoLink++;
    if (stage === 'clicked') out.clickedOnly++;
    if (r.source === 'link') out.fromLink++;
    if (r.source === 'typed') out.typed++;
  }
  out.notPaid = out.pending + out.expired;
  out.revenue = Math.round(out.revenue * 100) / 100;
  out.conversion = out.people ? Math.round((out.paid / out.people) * 1000) / 10 : 0;
  return out;
}

/** One summary per code, most people first. */
function summariseByCode(rows) {
  const byCode = new Map();
  for (const r of rows) {
    const code = normaliseCode(r.code);
    if (!byCode.has(code)) byCode.set(code, { code, kind: r.kind || '', rows: [] });
    const entry = byCode.get(code);
    if (!entry.kind && r.kind) entry.kind = r.kind;
    entry.rows.push(r);
  }
  return [...byCode.values()]
    .map(({ code, kind, rows: mine }) => Object.assign({ code, kind }, summarise(mine)))
    .sort((a, b) => b.people - a.people || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// Checking unpaid links with Razorpay
// ---------------------------------------------------------------------------

/**
 * refreshFromRazorpay — asks Razorpay about every link that has not been
 * recorded as paid: whether it expired, was cancelled, had failed payment
 * attempts, or was in fact paid without our webhook hearing of it.
 *
 * @param {string} payBotEnv
 * @param {Object} options
 * @param {Function} options.getPaymentLink async (linkId) => Razorpay link
 * @param {string} [options.code] Only this code's rows
 * @param {number} [options.limit] At most this many links per run
 * @returns {Promise<{checked: number, changed: number, failed: number, unrecorded: Array}>}
 */
async function refreshFromRazorpay(payBotEnv, { getPaymentLink, code = '', limit = 40, now = new Date() }) {
  const wanted = normaliseCode(code);
  return withLock(`tracking:${payBotEnv}`, async () => {
    const { rows, columns } = await read(payBotEnv);
    const open = rows.filter((r) => r.link_id && !r.paid_at &&
      (!wanted || normaliseCode(r.code) === wanted) &&
      !['expired', 'cancelled'].includes(String(r.link_status).toLowerCase()));
    const result = { checked: 0, changed: 0, failed: 0, unrecorded: [] };
    for (const r of open.slice(0, limit)) {
      let link;
      try {
        link = await getPaymentLink(r.link_id);
      } catch (err) {
        result.failed++;
        console.error(`[tracking] could not fetch payment link ${r.link_id}: ${err.message}`);
        continue;
      }
      result.checked++;
      const payments = Array.isArray(link.payments) ? link.payments : [];
      const next = Object.assign({}, r, {
        link_status: String(link.status || r.link_status || ''),
        failed_attempts: payments.filter((p) => String(p.status).toLowerCase() === 'failed').length || '',
        checked_at: istNow(now)
      });
      delete next._row;
      next.stage = STAGES[stageOf(next, now)].label;
      if (stageOf(next, now) === 'paid_unrecorded') {
        result.unrecorded.push({ code: r.code, student_id: r.student_id, username: r.username, link_id: r.link_id });
      }
      if (next.link_status !== r.link_status || String(next.failed_attempts) !== String(r.failed_attempts || '') ||
          next.stage !== r.stage) {
        result.changed++;
      }
      await writeRow(payBotEnv, columns, r._row, next);
    }
    result.remaining = Math.max(open.length - limit, 0);
    return result;
  });
}

module.exports = {
  TAB,
  HEADERS,
  STAGES,
  LINK_LIFETIME_MS,
  isConfigured,
  primaryGroupFor,
  record,
  safeRecord,
  list,
  stageOf,
  summarise,
  summariseByCode,
  refreshFromRazorpay
};
