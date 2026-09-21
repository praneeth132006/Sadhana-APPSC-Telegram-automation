// ============================================================================
// Direct Google Sheets client (src/sheets-direct.js)
// ============================================================================
// Talks to the Google Sheets API with a service account instead of going
// through each sheet's Apps Script Web App.
//
// Why: the Web App took 3–35s a call, now and then answered a good request
// with a 404 for minutes at a time, and every fix meant pasting a script into
// five sheets. The Sheets API answers in well under a second and needs nothing
// pasted anywhere. This file covers the posting path — the part that has to be
// fast and reliable — and writes exactly what the Apps Script writes, to the
// same columns, so either can read what the other wrote:
//
//   readConfig, getUnpostedQuestions, claimQuestions, releaseQuestions,
//   markAsPosted, holdQuestions, recoverStaleClaims, listPosted,
//   unpostQuestions, addQuestions (the dashboard's "Send to Sheet"), and the
//   curation queue: scheduleQuestions, unscheduleQuestions, bulkStatus
//
// Everything else (analytics, members, support) still goes through
// the Apps Script, unchanged.
//
// Setup: GOOGLE_SERVICE_ACCOUNT_JSON holds the service account key (the JSON
// itself, or the same base64-encoded), each sheet is shared with the service
// account's email as Editor, and SHEET_ID_<PREFIX> holds each sheet's id.
// No new dependencies: the token is a JWT signed with node:crypto.
// ============================================================================

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const REQUEST_TIMEOUT_MS = 20000;
const ATTEMPTS = 3;

/** The 30 canonical question columns, in order (A..AD). Mirrors QUESTION_HEADERS. */
const QUESTION_HEADERS = [
  'S.No', 'Question ID', 'Date', 'Newspaper', 'Subject', 'Topic', 'Question',
  'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Explanation',
  'Difficulty', 'Tags', 'Source URL', 'Status', 'Posted', 'Posted At',
  'Scheduled For', 'Thread ID', 'Telegram Msg ID', 'Poll ID', 'Times Posted',
  'Added At', 'Added By', 'Updated At', 'Updated By', 'Dup Hash', 'Review Notes'
];

/** Other names a column may carry in an older sheet. Mirrors headerAliases. */
const HEADER_ALIASES = {
  'S.No': ['s no', 'sno', 'sl no', 'serial'],
  'Question ID': ['question id', 'qid', 'id'],
  'Date': ['date'],
  'Newspaper': ['newspaper', 'source'],
  'Subject': ['subject'],
  'Topic': ['topic', 'sub topic', 'subtopic'],
  'Question': ['question', 'question text', 'prompt'],
  'Option A': ['option a', 'opt a'],
  'Option B': ['option b', 'opt b'],
  'Option C': ['option c', 'opt c'],
  'Option D': ['option d', 'opt d'],
  'Correct Answer': ['correct answer', 'answer', 'correct'],
  'Explanation': ['explanation', 'exp'],
  'Difficulty': ['difficulty', 'level'],
  'Tags': ['tags', 'keywords'],
  'Source URL': ['source url', 'url', 'link', 'reference'],
  'Status': ['status', 'workflow'],
  'Posted': ['posted'],
  'Posted At': ['posted at'],
  'Scheduled For': ['scheduled for', 'schedule at'],
  'Thread ID': ['thread id', 'topic thread id'],
  'Telegram Msg ID': ['telegram msg id', 'message id', 'msg id'],
  'Poll ID': ['poll id'],
  'Times Posted': ['times posted', 'post count'],
  'Added At': ['added at'],
  'Added By': ['added by', 'uploader'],
  'Updated At': ['updated at', 'modified at'],
  'Updated By': ['updated by', 'modified by'],
  'Dup Hash': ['dup hash', 'hash', 'fingerprint'],
  'Review Notes': ['review notes', 'notes', 'remarks']
};

const STATUS_VALUES = ['Draft', 'Review', 'Approved', 'Scheduled', 'Sending', 'Posted', 'Rejected', 'Archived', 'Deleted'];

/** Statuses the poster owns. Mirrors MACHINE_OWNED_STATUSES in the Apps Script.
 *  "Deleted" is one of them: it is not an opinion about a question, it is
 *  something the sweep saw in the channel, and it is written together with a
 *  Posted column that must stay YES. */
const MACHINE_OWNED_STATUSES = ['Posted', 'Sending', 'Deleted'];
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// ---------------------------------------------------------------------------
// Credentials and transport
// ---------------------------------------------------------------------------

let cachedKey;

/** The service account key from the environment, or null when not set up. */
function serviceAccount() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  cachedKey = null;
  if (!raw) return null;
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const key = JSON.parse(text);
    if (key.client_email && key.private_key) {
      // Some tools store the key with literal "\n" sequences.
      key.private_key = String(key.private_key).replace(/\\n/g, '\n');
      cachedKey = key;
    }
  } catch (err) {
    console.error('[sheets-direct] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', err.message);
  }
  return cachedKey;
}

/** True when the service account is configured. */
function isConfigured() {
  return Boolean(serviceAccount());
}

/** The address each sheet has to be shared with. */
function serviceAccountEmail() {
  const key = serviceAccount();
  return key ? key.client_email : null;
}

let token = { value: null, expiresAt: 0 };

/** An OAuth access token for the service account, cached until near expiry. */
async function accessToken() {
  if (token.value && Date.now() < token.expiresAt - 60000) return token.value;
  const key = serviceAccount();
  if (!key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');

  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' +
    b64({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error('Google refused the service account sign-in: ' +
      (body.error_description || body.error || `HTTP ${res.status}`));
  }
  token = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return token.value;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One Sheets API call. Every call this file makes is safe to repeat — reads,
 * and writes of absolute values to fixed cells — so 429 and 5xx are retried.
 */
async function call(method, path, body) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(API + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + (await accessToken()),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;

      const message = (json.error && json.error.message) || `HTTP ${res.status}`;
      if (res.status === 403 || res.status === 404) {
        throw Object.assign(new Error(
          `Google Sheets API: ${message}. Share the sheet with ${serviceAccountEmail()} as Editor, ` +
          'and check SHEET_ID_<GROUP> is the id from the sheet\'s link.'
        ), { permanent: true });
      }
      if (res.status === 401) token = { value: null, expiresAt: 0 };
      lastError = new Error(`Google Sheets API: ${message}`);
      if (res.status < 500 && res.status !== 429 && res.status !== 401) throw Object.assign(lastError, { permanent: true });
    } catch (err) {
      if (err.permanent) throw err;
      lastError = err.name === 'AbortError'
        ? new Error(`Google Sheets API did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`)
        : err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < ATTEMPTS) await sleepMs(500 * attempt * attempt);
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Sheet helpers (mirrors of the Apps Script ones)
// ---------------------------------------------------------------------------

/** 'Tab name' quoted for A1 notation. */
function quoteTab(tab) {
  return `'${String(tab).replace(/'/g, "''")}'`;
}

/** 1 → A, 27 → AA. */
function columnLetter(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function normaliseHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s._-]+/g, ' ');
}

/** Canonical header → 0-based column, found by name. -1 when absent. */
function headerMap(headerRow) {
  const normalised = (headerRow || []).map(normaliseHeader);
  const map = {};
  QUESTION_HEADERS.forEach((canonical) => {
    let found = -1;
    for (const alias of HEADER_ALIASES[canonical]) {
      found = normalised.indexOf(alias);
      if (found !== -1) break;
    }
    map[canonical] = found;
  });
  return map;
}

/** 1-based column to write a header to: where it is, or where it belongs. */
function colNum(map, header) {
  const idx = map[header];
  return (idx === undefined || idx < 0 ? QUESTION_HEADERS.indexOf(header) : idx) + 1;
}

/** Columns a curator may hold as real date cells rather than text. */
const DATE_COLUMNS = new Set(['Date', 'Posted At', 'Scheduled For', 'Added At', 'Updated At']);

/** A Sheets date serial (days since 30-12-1899) as dd-MM-yyyy. */
function serialToDate(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/**
 * One cell as the Apps Script's cell() returns it. Values are read
 * unformatted, as getValues() does, and a date cell (which arrives as a
 * serial number) becomes dd-MM-yyyy — what the Apps Script produced from the
 * Date object, and what the #Date hashtags are built from.
 */
function cell(row, map, header) {
  const idx = map[header];
  if (idx === undefined || idx < 0 || idx >= row.length) return '';
  const v = row[idx];
  if (typeof v === 'number' && DATE_COLUMNS.has(header) && v > 20000 && v < 80000) return serialToDate(v);
  return String(v === null || v === undefined ? '' : v).trim();
}

const isPostedValue = (v) => /^\s*yes\b/i.test(String(v == null ? '' : v));
const isClaimedValue = (v) => /^\s*(sending|check)\b/i.test(String(v == null ? '' : v));
const isHeldValue = (v) => /^\s*check\b/i.test(String(v == null ? '' : v));

function normaliseChoice(value, allowed, fallback) {
  const v = String(value || '').trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === v) || fallback;
}

const claimedAtFrom = (v) => {
  const parts = String(v == null ? '' : v).split('|');
  return parts.length > 1 ? parts[1].trim() : '';
};
const claimedStatusFrom = (v) => {
  const parts = String(v == null ? '' : v).split('|');
  return normaliseChoice(parts.length > 2 ? parts[2].trim() : '', STATUS_VALUES, 'Approved');
};

/** "18-09-2026, 03:16:05 PM IST" — the exact stamp istNow() writes. */
function istNow(date = new Date()) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}, ` +
    `${pad(h12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h24 < 12 ? 'AM' : 'PM'} IST`;
}

/** Reads an istNow() stamp back as a Date. Mirrors parseIstDate. */
function parseIstDate(value) {
  const m = String(value || '').trim()
    .match(/^(\d{2})-(\d{2})-(\d{4})(?:,\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM))?/i);
  if (!m) return null;
  let hour = m[4] ? parseInt(m[4], 10) : 23;
  const minute = m[5] ? parseInt(m[5], 10) : 59;
  const second = m[6] ? parseInt(m[6], 10) : 59;
  if (m[7]) {
    const mer = m[7].toUpperCase();
    if (mer === 'PM' && hour < 12) hour += 12;
    if (mer === 'AM' && hour === 12) hour = 0;
  }
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], hour, minute, second) - IST_OFFSET_MS);
}

function rowToQuestion(row, map, subject, dataIndex) {
  const c = (h) => cell(row, map, h);
  return {
    s_no: c('S.No') || (dataIndex + 1),
    question_id: c('Question ID'),
    date: c('Date'),
    newspaper: c('Newspaper'),
    subject: c('Subject') || subject,
    topic: c('Topic'),
    question_text: c('Question'),
    option_a: c('Option A'),
    option_b: c('Option B'),
    option_c: c('Option C'),
    option_d: c('Option D'),
    correct_answer: c('Correct Answer').toUpperCase() || 'A',
    explanation: c('Explanation'),
    difficulty: c('Difficulty') || 'Medium',
    tags: c('Tags'),
    source_url: c('Source URL'),
    status: c('Status') || 'Draft',
    posted: isPostedValue(c('Posted')) ? 'YES' : 'NO',
    claimed: isClaimedValue(c('Posted')),
    held: isHeldValue(c('Posted')),
    posted_raw: c('Posted'),
    posted_at: c('Posted At'),
    scheduled_for: c('Scheduled For'),
    thread_id: c('Thread ID'),
    telegram_msg_id: c('Telegram Msg ID'),
    poll_id: c('Poll ID'),
    times_posted: Number(c('Times Posted')) || 0,
    added_at: c('Added At'),
    added_by: c('Added By'),
    updated_at: c('Updated At'),
    updated_by: c('Updated By'),
    dup_hash: c('Dup Hash'),
    review_notes: c('Review Notes'),
    row_index: dataIndex,
    excel_row: dataIndex + 2
  };
}

/** Reads one tab: its header map and every data row. */
async function readTab(ctx, tab) {
  const range = encodeURIComponent(`${quoteTab(tab)}!A1:AZ`);
  let body;
  try {
    body = await call('GET', `/${ctx.spreadsheetId}/values/${range}` +
      '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
  } catch (err) {
    if (/Unable to parse range/i.test(err.message)) throw new Error(`Sheet tab "${tab}" not found.`);
    throw err;
  }
  const values = body.values || [];
  return { map: headerMap(values[0] || []), rows: values.slice(1) };
}

/** Writes single cells. `cells` is [{ tab, row, col, value }], 1-based. */
async function writeCells(ctx, cells) {
  if (!cells.length) return;
  await call('POST', `/${ctx.spreadsheetId}/values:batchUpdate`, {
    // RAW: stored exactly as given, so "SENDING | …" or a leading "=" is never
    // interpreted.
    valueInputOption: 'RAW',
    data: cells.map((c) => ({
      range: `${quoteTab(c.tab)}!${columnLetter(c.col)}${c.row}`,
      values: [[c.value]]
    }))
  });
}

/** Valid, de-duplicated data row numbers for a tab of `rowCount` data rows. */
function validRows(rowNumbers, rowCount) {
  const seen = new Set();
  const out = [];
  for (const r of rowNumbers || []) {
    const n = Number(r);
    if (!Number.isInteger(n) || n < 2 || n > rowCount + 1 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The posting path
// ---------------------------------------------------------------------------

async function readConfig(ctx) {
  const range = encodeURIComponent(`${quoteTab('Config')}!A2:F`);
  const body = await call('GET', `/${ctx.spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
  return (body.values || [])
    .map((row) => ({
      subject: String(row[0] || '').trim(),
      emoji: String(row[1] || '').trim(),
      topic_thread_id: Number(row[2]) || null,
      schedule_cron: String(row[3] || '').trim(),
      questions_per_batch: Number(row[4]) || 5,
      active: String(row[5] || '').trim().toUpperCase() === 'YES'
    }))
    .filter((item) => item.subject.length > 0);
}

async function getUnpostedQuestions(ctx, subject, count = 1, requireApproved = true) {
  const limit = Math.min(Math.max(Number(count) || 1, 1), 100);
  const { map, rows } = await readTab(ctx, subject);
  const out = [];
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    const q = rowToQuestion(rows[i], map, subject, i);
    if (!q.question_text) continue;
    if (q.posted === 'YES' || q.claimed) continue;
    if (q.status === 'Rejected' || q.status === 'Archived') continue;
    if (requireApproved && q.status !== 'Approved' && q.status !== 'Scheduled') continue;
    out.push(q);
  }
  return out;
}

/**
 * Reserves rows before anything is sent. The Apps Script did this under a
 * script lock; the API has none, so each claim carries a run token and is read
 * back — a row whose marker is not ours was taken by a run that wrote after
 * us, and is reported skipped instead of being sent twice.
 */
async function claimQuestions(ctx, subject, rowNumbers) {
  const { map, rows } = await readTab(ctx, subject);
  const postedCol = colNum(map, 'Posted');
  const statusCol = colNum(map, 'Status');
  const now = istNow();
  const run = crypto.randomBytes(4).toString('hex');
  const skipped = [];
  const wanted = [];
  const cells = [];

  for (const r of rowNumbers || []) {
    const n = Number(r);
    if (!Number.isInteger(n) || n < 2 || n > rows.length + 1) skipped.push({ row: r, reason: 'no such row' });
  }
  for (const n of validRows(rowNumbers, rows.length)) {
    const row = rows[n - 2];
    const current = row[postedCol - 1];
    if (isPostedValue(current)) { skipped.push({ row: n, reason: 'already posted' }); continue; }
    if (isClaimedValue(current)) { skipped.push({ row: n, reason: 'already sending' }); continue; }
    let previous = normaliseChoice(row[statusCol - 1], STATUS_VALUES, 'Approved');
    if (previous === 'Sending' || previous === 'Posted') previous = 'Approved';
    wanted.push(n);
    cells.push({ tab: subject, row: n, col: postedCol, value: `SENDING | ${now} | ${previous} | ${run}` });
    cells.push({ tab: subject, row: n, col: statusCol, value: 'Sending' });
  }
  await writeCells(ctx, cells);

  const claimed = [];
  if (wanted.length) {
    const after = await readTab(ctx, subject);
    for (const n of wanted) {
      const value = String((after.rows[n - 2] || [])[postedCol - 1] || '');
      if (value.includes(`| ${run}`)) claimed.push(n);
      else skipped.push({ row: n, reason: 'already sending' });
    }
  }
  return { claimed, skipped };
}

async function releaseQuestions(ctx, subject, rowNumbers, status) {
  const { map, rows } = await readTab(ctx, subject);
  const postedCol = colNum(map, 'Posted');
  const statusCol = colNum(map, 'Status');
  const restore = normaliseChoice(status || 'Approved', STATUS_VALUES, 'Approved');
  const cells = [];
  let released = 0;
  for (const n of validRows(rowNumbers, rows.length)) {
    // Never clear a row that reached Posted in the meantime.
    if (!isClaimedValue(rows[n - 2][postedCol - 1])) continue;
    cells.push({ tab: subject, row: n, col: postedCol, value: 'NO' });
    cells.push({ tab: subject, row: n, col: statusCol, value: restore });
    released++;
  }
  await writeCells(ctx, cells);
  return released;
}

async function markAsPosted(ctx, subject, rowIndices, messageId = null, threadId = null, pollIds = null) {
  if (!rowIndices || !rowIndices.length) return 0;
  const { map, rows } = await readTab(ctx, subject);
  const now = istNow();
  const cells = [];
  let updated = 0;
  for (const n of validRows(rowIndices, rows.length)) {
    const prior = Number(cell(rows[n - 2], map, 'Times Posted')) || 0;
    const set = (header, value) => cells.push({ tab: subject, row: n, col: colNum(map, header), value });
    set('Posted', 'YES');
    set('Posted At', now);
    set('Status', 'Posted');
    set('Times Posted', prior + 1);
    if (threadId) set('Thread ID', Number(threadId) || String(threadId));
    if (messageId) set('Telegram Msg ID', Number(messageId) || String(messageId));
    if (pollIds && pollIds[String(n)]) set('Poll ID', String(pollIds[String(n)]));
    updated++;
  }
  await writeCells(ctx, cells);
  if (!updated) {
    throw new Error(
      `The sheet marked none of row(s) ${rowIndices.join(', ')} in "${subject}" as posted — ` +
      'the row numbers may no longer exist in that tab.'
    );
  }
  return updated;
}

async function holdQuestions(ctx, subject, rowNumbers, note) {
  if (!rowNumbers || !rowNumbers.length) return 0;
  const { map, rows } = await readTab(ctx, subject);
  const now = istNow();
  const cells = [];
  let held = 0;
  for (const n of validRows(rowNumbers, rows.length)) {
    const row = rows[n - 2];
    if (isPostedValue(row[colNum(map, 'Posted') - 1])) continue;
    cells.push({ tab: subject, row: n, col: colNum(map, 'Posted'), value: `CHECK | ${now}` });
    cells.push({ tab: subject, row: n, col: colNum(map, 'Status'), value: 'Sending' });
    if (note) {
      const existing = cell(row, map, 'Review Notes');
      const line = `[${now}] ${note}`;
      cells.push({ tab: subject, row: n, col: colNum(map, 'Review Notes'), value: existing ? `${existing}\n${line}` : line });
    }
    held++;
  }
  await writeCells(ctx, cells);
  return held;
}

async function recoverStaleClaims(ctx, subject, minutes) {
  const olderThan = Math.max(1, Number(minutes) || 15);
  const { map, rows } = await readTab(ctx, subject);
  const postedCol = colNum(map, 'Posted');
  const cutoff = Date.now() - olderThan * 60 * 1000;
  const recovered = [];
  const cells = [];
  let held = 0;
  rows.forEach((row, i) => {
    const value = row[postedCol - 1];
    if (!isClaimedValue(value)) return;
    if (isHeldValue(value)) { held++; return; }
    const claimedAt = parseIstDate(claimedAtFrom(value));
    if (claimedAt && claimedAt.getTime() > cutoff) return;
    const n = i + 2;
    const restore = claimedStatusFrom(value);
    cells.push({ tab: subject, row: n, col: postedCol, value: 'NO' });
    cells.push({ tab: subject, row: n, col: colNum(map, 'Status'), value: restore });
    recovered.push({ row: n, question_id: cell(row, map, 'Question ID'), status: restore, claimed_at: claimedAtFrom(value) });
  });
  await writeCells(ctx, cells);
  return { recovered, held };
}

async function listPosted(ctx, subject) {
  const { map, rows } = await readTab(ctx, subject);
  const out = [];
  rows.forEach((row, i) => {
    const q = rowToQuestion(row, map, subject, i);
    if (!q.question_text || q.posted !== 'YES' || !q.telegram_msg_id) return;
    // A row already marked Deleted is settled. Leaving it in would have every
    // sweep ask Telegram about a message everyone agrees is gone, re-mark it,
    // and spend part of its budget doing so — for ever, and at the expense of
    // the rows that have not been checked yet.
    if (q.status === 'Deleted') return;
    out.push({ row: q.excel_row, question_id: q.question_id, message_id: q.telegram_msg_id, status: q.status });
  });
  return out;
}

/**
 * markDeleted — records that a poll is no longer in the channel.
 *
 * Posted is deliberately left at YES. The question WAS posted; that is a fact
 * about the past and this does not undo it. It also keeps the row out of the
 * posting queue, which is the whole point: a question someone deleted from the
 * channel must not quietly go back out. Putting it back is a separate decision
 * a person makes, with unpostQuestions.
 *
 * @param {string} note What to record in Review Notes
 * @returns {Promise<number>} Rows marked
 */
async function markDeleted(ctx, subject, rowNumbers, note) {
  if (!rowNumbers || !rowNumbers.length) return 0;
  const { map, rows } = await readTab(ctx, subject);
  const now = istNow();
  const cells = [];
  let marked = 0;

  for (const n of validRows(rowNumbers, rows.length)) {
    const row = rows[n - 2];
    // Only a row that is actually posted can have been deleted. Anything else
    // means the sheet moved under the sweep while it was asking Telegram.
    if (!isPostedValue(row[colNum(map, 'Posted') - 1])) continue;
    if (cell(row, map, 'Status') === 'Deleted') continue;

    const set = (header, value) => cells.push({ tab: subject, row: n, col: colNum(map, header), value });
    set('Status', 'Deleted');
    set('Updated At', now);
    set('Updated By', 'Deleted-poll check');
    if (note) {
      const existing = cell(row, map, 'Review Notes');
      const line = `[${now}] ${note}`;
      set('Review Notes', existing ? `${existing}\n${line}` : line);
    }
    marked++;
  }

  await writeCells(ctx, cells);
  return marked;
}

async function unpostQuestions(ctx, subject, rowNumbers, status) {
  if (!rowNumbers || !rowNumbers.length) return 0;
  const { map, rows } = await readTab(ctx, subject);
  const restore = normaliseChoice(status || 'Approved', STATUS_VALUES, 'Approved');
  const cells = [];
  const targets = validRows(rowNumbers, rows.length);
  for (const n of targets) {
    const set = (header, value) => cells.push({ tab: subject, row: n, col: colNum(map, header), value });
    set('Posted', 'NO');
    set('Status', restore);
    set('Posted At', '');
    set('Telegram Msg ID', '');
    set('Poll ID', '');
  }
  await writeCells(ctx, cells);
  return targets.length;
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------
// Two tabs, on the family's primary sheet:
//
//   Referrals     — one row per inviter: their code, who they are, when it was
//                   made. The code is the primary key.
//   Referral Log  — one row per successful referred payment: who invited whom,
//                   what was paid, what was taken off, what was earned, and
//                   whether that has been paid out. This is the tab that
//                   answers "who joined using whose code", and it is append
//                   only apart from the payout status.
//
// Both live here rather than in the Apps Script because the whole point of
// this route is that a new feature does not mean pasting a script into five
// sheets by hand. The tabs are created on first use.

// Everything here is written with valueInputOption RAW, as the rest of this
// file is, so a username of "=IMPORTXML(...)" is stored as that text and never
// run as a formula. The Apps Script needs its safeCell() because it writes
// through setValue(), which does interpret a leading "=".
const REFERRAL_TAB = 'Referrals';
const REFERRAL_HEADERS = [
  'Code',           // A  REF + 6 characters, the primary key
  'Telegram ID',    // B  Who owns it
  'Username',       // C  @handle, may be blank
  'Name',           // D  Display name from Telegram
  'Status',         // E  active | disabled
  'Created At',     // F  IST stamp
  'Notes'           // G  Free text, for an admin
];

const REFERRAL_LOG_TAB = 'Referral Log';
const REFERRAL_LOG_HEADERS = [
  'Timestamp',           // A  When the payment was recorded
  'Code',                // B  The code that was used
  'Referrer ID',         // C  Who invited
  'Referrer Username',   // D
  'Referred ID',         // E  Who joined
  'Referred Username',   // F
  'Referred Name',       // G
  'Group',               // H  Which group they bought
  'Payment ID',          // I  Razorpay's id — also what makes this idempotent
  'Original Amount',     // J  Rupees, before the referral discount
  'Discount',            // K  Rupees taken off for the person who joined
  'Paid Amount',         // L  Rupees actually paid
  'Commission',          // M  Rupees earned by the inviter
  'Status',              // N  pending | paid | cancelled
  'Paid At',             // O  IST stamp, when the inviter was paid
  'Notes'                // P
];

/** Reads a tab, creating it with its headers the first time. */
async function readOrCreate(ctx, tab, headers) {
  try {
    return await readTab(ctx, tab);
  } catch (err) {
    if (!/not found/i.test(err.message)) throw err;
    await call('POST', `/${ctx.spreadsheetId}:batchUpdate`, {
      requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }]
    });
    await call('PUT',
      `/${ctx.spreadsheetId}/values/${encodeURIComponent(`${quoteTab(tab)}!A1`)}?valueInputOption=RAW`,
      { values: [headers] });
    return { map: headerMap(headers), rows: [] };
  }
}

/** A tab's own header map: these tabs are not the 30-column question layout. */
function plainHeaderMap(headers) {
  const map = {};
  headers.forEach((h, i) => { map[h] = i; });
  return map;
}

/** One row as an object keyed by the lower_snake_case of its header. */
function rowToObject(row, headers) {
  const out = {};
  headers.forEach((header, i) => {
    const key = header.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const value = row[i];
    out[key] = value === null || value === undefined ? '' : String(value).trim();
  });
  return out;
}

/** Appends rows to a tab, then puts them back to the plain body style. */
async function appendRows(ctx, tab, values) {
  const appended = await call('POST',
    `/${ctx.spreadsheetId}/values/${encodeURIComponent(`${quoteTab(tab)}!A1`)}:append` +
    '?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values });
  const firstRow = Number(((appended.updates || {}).updatedRange || '').match(/![A-Z]+(\d+)/)?.[1]);
  // The same inheritance that once turned a whole question tab navy.
  if (firstRow) await resetAppendedRows(ctx, tab, firstRow, values.length);
  return firstRow;
}

/** Every referral code on this sheet. */
async function listReferrals(ctx) {
  const { rows } = await readOrCreate(ctx, REFERRAL_TAB, REFERRAL_HEADERS);
  return rows
    .map((row) => rowToObject(row, REFERRAL_HEADERS))
    .filter((r) => r.code);
}

/** One code's row, or null. */
async function getReferral(ctx, code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  const all = await listReferrals(ctx);
  return all.find((r) => r.code.toUpperCase() === wanted) || null;
}

/** The code a person already owns, or null. */
async function getReferralFor(ctx, telegramId) {
  const wanted = String(telegramId || '').trim();
  if (!wanted) return null;
  const all = await listReferrals(ctx);
  return all.find((r) => String(r.telegram_id) === wanted) || null;
}

/**
 * createReferral — issues a code, or returns the one this person already has.
 *
 * Idempotent on purpose: a student who taps "my referral code" twice must not
 * end up with two codes, because the second would split their earnings from
 * the first and neither would ever reach a payout.
 *
 * @param {{telegram_id: string, username: string, name: string, code: string}} referral
 */
async function createReferral(ctx, referral) {
  const existing = await getReferralFor(ctx, referral.telegram_id);
  if (existing) return existing;

  const taken = await getReferral(ctx, referral.code);
  if (taken) {
    const err = new Error(`Referral code ${referral.code} is already taken.`);
    err.codeTaken = true;
    throw err;
  }

  const row = REFERRAL_HEADERS.map(() => '');
  const map = plainHeaderMap(REFERRAL_HEADERS);
  row[map['Code']] = String(referral.code || '').toUpperCase();
  row[map['Telegram ID']] = String(referral.telegram_id || '');
  row[map['Username']] = String(referral.username || '');
  row[map['Name']] = String(referral.name || '');
  row[map['Status']] = 'active';
  row[map['Created At']] = istNow();
  row[map['Notes']] = '';

  await readOrCreate(ctx, REFERRAL_TAB, REFERRAL_HEADERS);
  await appendRows(ctx, REFERRAL_TAB, [row]);
  return rowToObject(row, REFERRAL_HEADERS);
}

/** Turns a code on or off without destroying its earnings history. */
async function setReferralStatus(ctx, code, status) {
  const { map, rows } = await readOrCreate(ctx, REFERRAL_TAB, REFERRAL_HEADERS);
  void map;
  const plain = plainHeaderMap(REFERRAL_HEADERS);
  const wanted = String(code || '').trim().toUpperCase();
  const clean = status === 'disabled' ? 'disabled' : 'active';

  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][plain['Code']] || '').trim().toUpperCase() !== wanted) continue;
    await writeCells(ctx, [{ tab: REFERRAL_TAB, row: i + 2, col: plain['Status'] + 1, value: clean }]);
    return 1;
  }
  return 0;
}

/** Every earning row, newest last. `code` narrows it to one inviter. */
async function listReferralEarnings(ctx, code) {
  const { rows } = await readOrCreate(ctx, REFERRAL_LOG_TAB, REFERRAL_LOG_HEADERS);
  const wanted = String(code || '').trim().toUpperCase();

  return rows
    .map((row) => {
      const o = rowToObject(row, REFERRAL_LOG_HEADERS);
      return {
        timestamp: o.timestamp,
        code: o.code.toUpperCase(),
        referrer_telegram_id: o.referrer_id,
        referrer_username: o.referrer_username,
        referred_telegram_id: o.referred_id,
        referred_username: o.referred_username,
        referred_name: o.referred_name,
        group: o.group,
        payment_id: o.payment_id,
        original_paise: Math.round(Number(o.original_amount || 0) * 100),
        discount_paise: Math.round(Number(o.discount || 0) * 100),
        paid_paise: Math.round(Number(o.paid_amount || 0) * 100),
        commission_paise: Math.round(Number(o.commission || 0) * 100),
        status: (o.status || 'pending').toLowerCase(),
        paid_at: o.paid_at,
        notes: o.notes
      };
    })
    .filter((r) => r.code && (!wanted || r.code === wanted));
}

/**
 * recordReferralEarning — one successful referred payment.
 *
 * Idempotent on the payment id. Razorpay retries a webhook on any non-2xx, so
 * the same sale can arrive more than once; without this an inviter would be
 * paid twice — or ten times — for one purchase.
 *
 * @returns {Promise<{recorded: boolean, reason?: string, commission_paise: number}>}
 */
async function recordReferralEarning(ctx, earning) {
  const paymentId = String(earning.payment_id || '').trim();
  const existing = await listReferralEarnings(ctx);
  if (paymentId && existing.some((r) => r.payment_id === paymentId)) {
    return { recorded: false, reason: 'already recorded', commission_paise: 0 };
  }

  const map = plainHeaderMap(REFERRAL_LOG_HEADERS);
  const row = REFERRAL_LOG_HEADERS.map(() => '');
  const put = (header, value) => { row[map[header]] = value; };

  put('Timestamp', istNow());
  put('Code', String(earning.code || '').toUpperCase());
  put('Referrer ID', String(earning.referrer_telegram_id || ''));
  put('Referrer Username', String(earning.referrer_username || ''));
  put('Referred ID', String(earning.referred_telegram_id || ''));
  put('Referred Username', String(earning.referred_username || ''));
  put('Referred Name', String(earning.referred_name || ''));
  put('Group', String(earning.group || ''));
  put('Payment ID', paymentId);
  put('Original Amount', (Number(earning.original_paise) || 0) / 100);
  put('Discount', (Number(earning.discount_paise) || 0) / 100);
  put('Paid Amount', (Number(earning.paid_paise) || 0) / 100);
  put('Commission', (Number(earning.commission_paise) || 0) / 100);
  put('Status', 'pending');
  put('Paid At', '');
  put('Notes', String(earning.notes || ''));

  await readOrCreate(ctx, REFERRAL_LOG_TAB, REFERRAL_LOG_HEADERS);
  await appendRows(ctx, REFERRAL_LOG_TAB, [row]);
  return { recorded: true, commission_paise: Number(earning.commission_paise) || 0 };
}

/**
 * settleReferralEarnings — marks one inviter's pending earnings paid.
 *
 * Takes the rows as they were read, so a payment recorded between the admin
 * looking and the admin paying is not silently marked paid along with them.
 *
 * @param {string} code Whose earnings
 * @param {string[]} [paymentIds] Only these rows; omitted means all pending
 * @returns {Promise<{settled: number, paise: number}>}
 */
async function settleReferralEarnings(ctx, code, paymentIds, note) {
  const { rows } = await readOrCreate(ctx, REFERRAL_LOG_TAB, REFERRAL_LOG_HEADERS);
  const map = plainHeaderMap(REFERRAL_LOG_HEADERS);
  const wanted = String(code || '').trim().toUpperCase();
  const only = Array.isArray(paymentIds) && paymentIds.length
    ? new Set(paymentIds.map((id) => String(id)))
    : null;

  const now = istNow();
  const cells = [];
  let settled = 0;
  let paise = 0;

  rows.forEach((row, i) => {
    if (String(row[map['Code']] || '').trim().toUpperCase() !== wanted) return;
    if (String(row[map['Status']] || 'pending').trim().toLowerCase() !== 'pending') return;
    if (only && !only.has(String(row[map['Payment ID']] || '').trim())) return;

    const n = i + 2;
    cells.push({ tab: REFERRAL_LOG_TAB, row: n, col: map['Status'] + 1, value: 'paid' });
    cells.push({ tab: REFERRAL_LOG_TAB, row: n, col: map['Paid At'] + 1, value: now });
    if (note) cells.push({ tab: REFERRAL_LOG_TAB, row: n, col: map['Notes'] + 1, value: String(note) });
    settled++;
    paise += Math.round(Number(row[map['Commission']] || 0) * 100);
  });

  await writeCells(ctx, cells);
  return { settled, paise };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
// A tab written through this client used to come out unreadable: solid navy,
// bold white, top to bottom.
//
// `values:append` with insertDataOption=INSERT_ROWS does what inserting a row
// in the UI does — the new row inherits the formatting of the row above it.
// The row above the first upload is the header: bold white on #1a237e. Every
// later upload then inherited that from the row before, so one tab at a time
// the whole sheet turned into header.
//
// The Apps Script never hit this because it wrote into rows that already
// existed and styled the sheet as it created it. So this file has to do the
// same two things: style a tab it creates, and put appended rows back to the
// body style afterwards. The values below mirror formatSheetHeaders and
// applyConditionalFormatting in google_apps_script.js exactly — a curator
// should not be able to tell which route filled their sheet.

const HEADER_BACKGROUND = '#1a237e';
const HEADER_FOREGROUND = '#ffffff';

/** Per-column widths tuned for readability of long APPSC statements. */
const COLUMN_WIDTHS = [
  55, 140, 100, 130, 130, 150, 460, 190, 190, 190,
  190, 110, 420, 95, 180, 200, 110, 80, 180, 150,
  90, 140, 140, 100, 180, 220, 180, 200, 130, 240
];

/** 1-based columns whose text wraps: the question, the options, the notes. */
const WRAP_COLUMNS = [7, 8, 9, 10, 11, 13, 30];

/** Colour codes so state is readable at a glance. [header, value, bg, fg]. */
const CELL_COLOURS = [
  ['Posted', 'YES', '#c8e6c9', '#1b5e20'],
  ['Posted', 'NO', '#ffcdd2', '#b71c1c'],
  ['Status', 'Approved', '#c8e6c9', '#1b5e20'],
  ['Status', 'Posted', '#bbdefb', '#0d47a1'],
  ['Status', 'Scheduled', '#fff9c4', '#f57f17'],
  ['Status', 'Review', '#ffe0b2', '#e65100'],
  ['Status', 'Rejected', '#ffcdd2', '#b71c1c'],
  ['Status', 'Archived', '#eceff1', '#455a64'],
  ['Status', 'Deleted', '#f8bbd0', '#880e4f'],
  ['Difficulty', 'Easy', '#dcedc8', '#33691e'],
  ['Difficulty', 'Medium', '#fff9c4', '#f57f17'],
  ['Difficulty', 'Hard', '#ffccbc', '#bf360c']
];

/** "#rrggbb" as the 0..1 colour the Sheets API takes. */
function rgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

/** The numeric sheetId of one tab, which every formatting request needs. */
async function sheetIdOf(ctx, tab) {
  const body = await call('GET', `/${ctx.spreadsheetId}?fields=sheets.properties(sheetId,title)`);
  const found = (body.sheets || []).find((sh) => sh.properties && sh.properties.title === tab);
  if (!found) throw new Error(`Sheet tab "${tab}" not found.`);
  return found.properties.sheetId;
}

/** Every cell format an ordinary data row carries. */
const BODY_FORMAT_FIELDS =
  'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,horizontalAlignment,wrapStrategy)';

/**
 * bodyFormatRequests — puts a range of rows back to the plain body style.
 *
 * Written out in full rather than as a "clear formatting": the wrapped columns
 * have a style of their own, and clearing would take that with it.
 *
 * @param {number} startRow 1-based first row to reset
 * @param {number} endRow 1-based last row, inclusive
 */
function bodyFormatRequests(sheetId, startRow, endRow) {
  const range = {
    sheetId,
    startRowIndex: startRow - 1,
    endRowIndex: endRow,
    startColumnIndex: 0,
    endColumnIndex: QUESTION_HEADERS.length
  };

  const requests = [{
    repeatCell: {
      range,
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb('#ffffff'),
          textFormat: { bold: false, foregroundColor: rgb('#000000') },
          verticalAlignment: 'TOP',
          horizontalAlignment: 'LEFT',
          wrapStrategy: 'CLIP'
        }
      },
      fields: BODY_FORMAT_FIELDS
    }
  }];

  // The long-form columns wrap; the rest stay on one line so the row does not
  // grow to the height of its longest cell.
  for (const column of WRAP_COLUMNS) {
    requests.push({
      repeatCell: {
        range: Object.assign({}, range, { startColumnIndex: column - 1, endColumnIndex: column }),
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)'
      }
    });
  }
  return requests;
}

/**
 * resetAppendedRows — undoes the header style an append inherited.
 *
 * Best effort: the questions are already safely in the sheet, and refusing an
 * upload that worked because its rows came out the wrong colour would be the
 * worse failure of the two.
 */
async function resetAppendedRows(ctx, subject, firstRow, count) {
  if (!firstRow || !count) return;
  try {
    const sheetId = await sheetIdOf(ctx, subject);
    await call('POST', `/${ctx.spreadsheetId}:batchUpdate`, {
      requests: bodyFormatRequests(sheetId, firstRow, firstRow + count - 1)
    });
  } catch (err) {
    console.warn(`[sheets] could not restore row formatting in "${subject}": ${err.message}`);
  }
}

/**
 * formatQuestions — puts one subject tab back to the canonical layout.
 *
 * Header style, column widths, frozen panes, row height, the dropdowns and the
 * colour coding. Safe to run on a tab that is already correct, and the way back
 * for any tab an earlier upload turned navy from top to bottom.
 *
 * @returns {Promise<{subject: string, rows: number}>}
 */
async function formatQuestions(ctx, subject) {
  const sheetId = await sheetIdOf(ctx, subject);
  const { rows } = await readTab(ctx, subject);
  const columns = QUESTION_HEADERS.length;

  // At least one row, so a tab with no questions yet still gets its styling and
  // its dropdowns rather than being skipped for being empty.
  const lastRow = Math.max(rows.length + 1, 2);
  const map = headerMap(QUESTION_HEADERS);
  const dataRange = (header) => ({
    sheetId,
    startRowIndex: 1,
    endRowIndex: lastRow,
    startColumnIndex: colNum(map, header) - 1,
    endColumnIndex: colNum(map, header)
  });

  const requests = [
    {
      updateSheetProperties: {
        // S.No and Question ID stay visible while scrolling right.
        properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } },
        fields: 'gridProperties(frozenRowCount,frozenColumnCount)'
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columns },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb(HEADER_BACKGROUND),
            textFormat: { bold: true, foregroundColor: rgb(HEADER_FOREGROUND) },
            verticalAlignment: 'MIDDLE',
            horizontalAlignment: 'CENTER',
            wrapStrategy: 'WRAP'
          }
        },
        fields: BODY_FORMAT_FIELDS
      }
    },
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 44 },
        fields: 'pixelSize'
      }
    },
    ...bodyFormatRequests(sheetId, 2, lastRow)
  ];

  COLUMN_WIDTHS.forEach((pixelSize, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize },
        fields: 'pixelSize'
      }
    });
  });

  // Posted is not a two-value column any more — it also carries "SENDING | …"
  // while a question is with Telegram. The dropdown is a convenience for the
  // two values a curator would pick by hand, and must not reject what the
  // poster writes, so invalid values are allowed through with a warning.
  const dropdown = (header, values, strict) => ({
    setDataValidation: {
      range: dataRange(header),
      rule: {
        condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict
      }
    }
  });
  requests.push(dropdown('Posted', ['YES', 'NO'], false));
  requests.push(dropdown('Status', STATUS_VALUES, false));
  requests.push(dropdown('Difficulty', DIFFICULTY_VALUES, true));

  // Replace the colour rules rather than adding to them: running this twice
  // would otherwise leave two of every rule behind.
  const existing = await call('GET',
    `/${ctx.spreadsheetId}?fields=sheets(properties.sheetId,conditionalFormats)`);
  const current = ((existing.sheets || [])
    .find((sh) => sh.properties && sh.properties.sheetId === sheetId) || {}).conditionalFormats || [];
  for (let i = current.length - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }

  CELL_COLOURS.forEach(([header, value, bg, fg], index) => {
    requests.push({
      addConditionalFormatRule: {
        index,
        rule: {
          ranges: [dataRange(header)],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
            format: { backgroundColor: rgb(bg), textFormat: { foregroundColor: rgb(fg) } }
          }
        }
      }
    });
  });

  await call('POST', `/${ctx.spreadsheetId}:batchUpdate`, { requests });
  return { subject, rows: rows.length };
}

// ---------------------------------------------------------------------------
// The curation queue
// ---------------------------------------------------------------------------
// Queueing, unqueueing and bulk status changes used to be the Apps Script's
// job. They were also the operations most likely to answer "0 updated" with
// no explanation: a stale deployment, a renamed tab, or an id that is simply
// not in this subject all look identical from the dashboard. Doing them here
// makes them fast, and — because the ids that matched nothing are named —
// makes a zero say why it is a zero.

/** Question ID (trimmed, case-insensitive) → 1-based row number. */
function rowsByQuestionId(map, rows) {
  const index = new Map();
  rows.forEach((row, i) => {
    const id = cell(row, map, 'Question ID').toLowerCase();
    // First match wins: a duplicated id is a sheet problem, and silently
    // preferring the later row would edit whichever one the reader cannot see.
    if (id && !index.has(id)) index.set(id, i + 2);
  });
  return index;
}

/**
 * resolveIds — splits the ids asked for into rows that exist and ids that do not.
 *
 * @returns {{targets: Array<{id: string, row: number}>, notFound: string[]}}
 */
function resolveIds(map, rows, questionIds) {
  const index = rowsByQuestionId(map, rows);
  const targets = [];
  const notFound = [];
  const seen = new Set();
  for (const raw of questionIds || []) {
    const id = String(raw == null ? '' : raw).trim();
    if (!id) continue;
    const row = index.get(id.toLowerCase());
    if (!row) { notFound.push(id); continue; }
    if (seen.has(row)) continue;
    seen.add(row);
    targets.push({ id, row });
  }
  return { targets, notFound };
}

/**
 * queueSkipReason — why this row must not be re-statused from the dashboard.
 *
 * A claimed row is mid-flight: a posting run is holding it and will write the
 * Posted column itself, so changing Status underneath is a race with a public
 * channel on the other end. A row that is already posted only blocks
 * *queueing* — marking a posted question Scheduled would set it up to go out
 * a second time — while archiving or rejecting one is an ordinary thing to do.
 *
 * @param {boolean} skipPosted Whether an already-posted row is off limits
 */
function queueSkipReason(row, map, skipPosted) {
  const posted = row[colNum(map, 'Posted') - 1];
  if (isHeldValue(posted)) return 'held for checking';
  if (isClaimedValue(posted)) return 'being sent right now';
  if (skipPosted && isPostedValue(posted)) return 'already posted';
  return null;
}

/**
 * writeQueueChange — the one body behind queueing, unqueueing and bulkStatus.
 *
 * @param {string} status Status to write
 * @param {string|null} scheduledFor Text for Scheduled For, or null to leave it
 * @returns {Promise<{updatedCount: number, notFound: string[], skipped: Array}>}
 */
async function writeQueueChange(ctx, subject, questionIds, { status, scheduledFor, updatedBy, skipPosted }) {
  const { map, rows } = await readTab(ctx, subject);
  const { targets, notFound } = resolveIds(map, rows, questionIds);
  const now = istNow();
  const cells = [];
  const skipped = [];
  let updated = 0;

  for (const target of targets) {
    const row = rows[target.row - 2];
    const reason = queueSkipReason(row, map, skipPosted !== false);
    if (reason) { skipped.push({ questionId: target.id, row: target.row, reason }); continue; }

    const set = (header, value) => cells.push({ tab: subject, row: target.row, col: colNum(map, header), value });
    set('Status', status);
    if (scheduledFor !== null) set('Scheduled For', scheduledFor);
    set('Updated At', now);
    set('Updated By', String(updatedBy || 'Dashboard User'));
    updated++;
  }

  await writeCells(ctx, cells);
  return { updatedCount: updated, notFound, skipped };
}

/** Stamps Scheduled For and flips Status to Scheduled. */
async function scheduleQuestions(ctx, subject, questionIds, scheduledFor, updatedBy) {
  return writeQueueChange(ctx, subject, questionIds, {
    status: 'Scheduled',
    scheduledFor: String(scheduledFor == null ? '' : scheduledFor),
    updatedBy
  });
}

/**
 * unscheduleQuestions — takes questions back out of the queue.
 *
 * Clearing Scheduled For is the point: leaving yesterday's target time on a
 * row that is no longer queued is how a sheet starts lying about its own plan.
 */
async function unscheduleQuestions(ctx, subject, questionIds, status, updatedBy) {
  return writeQueueChange(ctx, subject, questionIds, {
    status: normaliseChoice(status || 'Approved', STATUS_VALUES, 'Approved'),
    scheduledFor: '',
    updatedBy
  });
}

/**
 * Sets Status on many questions at once, leaving Scheduled For alone.
 *
 * Posted and Sending are refused for the same reason the Apps Script refuses
 * them: they are written by the poster alongside the Posted column, the
 * message id and the poll id. Setting one by hand leaves Status saying
 * "Posted" while Posted still says NO, so the question stays eligible and
 * goes out again with the dashboard insisting it was already sent.
 */
async function bulkStatus(ctx, subject, questionIds, status, updatedBy) {
  const clean = normaliseChoice(status, STATUS_VALUES, 'Draft');
  if (MACHINE_OWNED_STATUSES.includes(clean)) {
    throw new Error(
      `"${clean}" is set by the poster, not by hand. Use the Automation page ` +
      'to post, or "Check the channel for deleted polls" to undo one.'
    );
  }
  return writeQueueChange(ctx, subject, questionIds, {
    status: clean,
    scheduledFor: null,
    updatedBy,
    // Archiving or rejecting a question that has already gone out is ordinary
    // curation, so unlike queueing this does not refuse a posted row.
    skipPosted: false
  });
}

// ---------------------------------------------------------------------------
// Adding questions
// ---------------------------------------------------------------------------

/** Characters the duplicate check ignores. Mirrors COSMETIC_CHARS. */
const COSMETIC_CHARS = /[\s!-\/:-@\[-`{-~ «»।॥‐-⁞　-〿！-／：-＠]+/g;
const LEGACY_HASH_MIN_CHARS = 24;
const DIFFICULTY_VALUES = ['Easy', 'Medium', 'Hard'];

/** First 8 bytes of a SHA-256 as hex — the shape of every Dup Hash. */
const shortDigest = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);

function hashQuestion(text) {
  let normalised = String(text || '').toLowerCase().replace(COSMETIC_CHARS, '').substring(0, 4000);
  if (!normalised) normalised = String(text || '').toLowerCase().substring(0, 4000);
  return shortDigest(normalised);
}

function legacyHashQuestion(text) {
  const normalised = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 4000);
  return normalised.length < LEGACY_HASH_MIN_CHARS ? '' : shortDigest(normalised);
}

/** The three-letter code in a Question ID. Mirrors subjectCode's fallback. */
function subjectCode(subject, rows, map) {
  // The Apps Script can take codes from a SUBJECTS_JSON property this side
  // cannot read, so the tab's own ids win: new ones then match the old.
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = cell(rows[i], map, 'Question ID').match(/^([A-Z]{1,6})-\d{8}-\d+$/);
    if (m) return m[1];
  }
  return String(subject || 'GEN').toUpperCase().replace(/[^A-Z]/g, '').substring(0, 3) || 'GEN';
}

/** yyyyMMdd in IST. */
function istStamp(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/** Creates a missing subject tab with the canonical header row. */
async function createTab(ctx, tab) {
  await call('POST', `/${ctx.spreadsheetId}:batchUpdate`, {
    requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }]
  });
  await call('PUT', `/${ctx.spreadsheetId}/values/${encodeURIComponent(`${quoteTab(tab)}!A1`)}?valueInputOption=RAW`,
    { values: [QUESTION_HEADERS] });

  // Styled as the Apps Script styles a tab it creates, so a subject added from
  // the dashboard is not visibly a second-class one. Best effort: the tab and
  // its headers exist either way, and the upload that created it must not fail
  // because a column came out the wrong width.
  try {
    await formatQuestions(ctx, tab);
  } catch (err) {
    console.warn(`[sheets] created "${tab}" but could not style it: ${err.message}`);
  }
}

/**
 * Adds a batch of questions — what the Apps Script's appendQuestionsToSheet
 * does, row for row: same Question IDs, same Dup Hash, same duplicate rules.
 * Rows are appended with values:append, so two uploads at once never write
 * over each other; ids are checked afterwards and any collision is re-issued.
 */
async function addQuestions(ctx, subject, questions, addedBy, skipDuplicates = true) {
  let tab;
  try {
    tab = await readTab(ctx, subject);
  } catch (err) {
    if (!/not found/.test(err.message)) throw err;
    await createTab(ctx, subject);
    tab = { map: headerMap(QUESTION_HEADERS), rows: [] };
  }
  const { map, rows } = tab;
  // A tab laid out without the canonical columns needs the Apps Script's
  // migration first; writing blind would put values in the wrong columns.
  const missing = ['Question', 'Question ID', 'Dup Hash', 'Status', 'Posted'].filter((h) => map[h] < 0);
  if (missing.length) {
    throw Object.assign(new Error(`The "${subject}" tab has no ${missing.join(', ')} column.`), { needsAppsScript: true });
  }

  const broken = shortDigest('');
  const existingHashes = new Set();
  const existingIds = new Set();
  const repairs = [];
  rows.forEach((row, i) => {
    let h = cell(row, map, 'Dup Hash');
    if (h === broken) {
      // Written while non-Latin text hashed to nothing — recompute, as the Apps Script does.
      const text = cell(row, map, 'Question');
      if (text) {
        h = hashQuestion(text);
        repairs.push({ tab: subject, row: i + 2, col: colNum(map, 'Dup Hash'), value: h });
      }
    }
    if (h) existingHashes.add(h);
    // Stored hashes were made by whichever script version wrote the row, and
    // not all of them can be reproduced here. Hashing the question text itself
    // catches a repeat regardless of how its stored hash was made.
    const text = cell(row, map, 'Question');
    if (text) existingHashes.add(hashQuestion(text));
    const id = cell(row, map, 'Question ID');
    if (id) existingIds.add(id);
  });
  const isKnown = (text) => existingHashes.has(hashQuestion(text)) ||
    Boolean(legacyHashQuestion(text) && existingHashes.has(legacyHashQuestion(text)));

  const lastSNo = rows.length ? Number(cell(rows[rows.length - 1], map, 'S.No')) : 0;
  let nextSNo = (lastSNo || rows.length) + 1;
  const now = istNow();
  const uploader = String(addedBy || 'Dashboard User').trim();
  const code = subjectCode(subject, rows, map);
  const stamp = istStamp();
  const width = Math.max(QUESTION_HEADERS.length, ...Object.values(map).map((i) => i + 1));

  const out = [];
  const ids = [];
  const skipped = [];
  const seen = new Set();
  const makeId = (n) => `${code}-${stamp}-${String(n).padStart(4, '0')}`;

  for (const q of questions || []) {
    const text = String((q && (q.question || q.question_text)) || '').trim();
    if (!text) continue;
    const hash = hashQuestion(text);
    if (skipDuplicates && (seen.has(hash) || isKnown(text))) {
      skipped.push({ question: text.substring(0, 90), reason: 'duplicate' });
      continue;
    }
    seen.add(hash);

    let sNo = nextSNo;
    while (existingIds.has(makeId(sNo))) sNo++;
    const id = makeId(sNo);
    existingIds.add(id);
    ids.push(id);
    nextSNo = sNo + 1;

    const row = new Array(width).fill('');
    const put = (h, v) => { row[colNum(map, h) - 1] = v; };
    const s = (v) => String(v || '').trim();
    put('S.No', sNo);
    put('Question ID', id);
    put('Date', s(q.date));
    put('Newspaper', s(q.newspaper));
    put('Subject', subject);
    put('Topic', s(q.topic));
    put('Question', text);
    put('Option A', s(q.option_a));
    put('Option B', s(q.option_b));
    put('Option C', s(q.option_c));
    put('Option D', s(q.option_d));
    put('Correct Answer', (s(q.correct_answer) || 'A').toUpperCase());
    put('Explanation', s(q.explanation));
    put('Difficulty', normaliseChoice(q.difficulty, DIFFICULTY_VALUES, 'Medium'));
    put('Tags', s(q.tags));
    put('Source URL', s(q.source_url || q.sourceUrl));
    put('Status', normaliseChoice(q.status, STATUS_VALUES, 'Approved'));
    put('Posted', 'NO');
    put('Scheduled For', s(q.scheduled_for));
    put('Times Posted', 0);
    put('Added At', now);
    put('Added By', uploader);
    put('Updated At', now);
    put('Updated By', uploader);
    put('Dup Hash', hash);
    put('Review Notes', s(q.review_notes));
    out.push(row);
  }

  await writeCells(ctx, repairs);
  if (out.length) {
    const range = encodeURIComponent(`${quoteTab(subject)}!A1`);
    // RAW: a question starting with "=" is stored as text, never run as a formula.
    const appended = await call('POST', `/${ctx.spreadsheetId}/values/${range}:append` +
      '?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { values: out });
    const firstRow = Number(((appended.updates || {}).updatedRange || '').match(/![A-Z]+(\d+)/)?.[1]);
    if (firstRow) {
      // The rows Sheets just inserted inherited the formatting of the row
      // above — the header, for the first upload into a tab. Left alone, one
      // upload at a time turns the whole sheet bold white on navy.
      await resetAppendedRows(ctx, subject, firstRow, out.length);
      await reissueCollidingIds(ctx, subject, firstRow, out.length, code, stamp, ids);
    }
  }

  return {
    addedCount: out.length,
    skippedCount: skipped.length,
    skipped,
    ids,
    message: `${out.length} question(s) added to "${subject}"` + (skipped.length ? `, ${skipped.length} duplicate(s) skipped` : '')
  };
}

/**
 * Another upload running at the same moment read the same last S.No and may
 * have issued the same ids. Every edit and delete finds a question by its id,
 * so a repeat must not stand: ours step past anything already taken.
 */
async function reissueCollidingIds(ctx, subject, firstRow, count, code, stamp, ids) {
  const { map, rows } = await readTab(ctx, subject);
  const idIdx = map['Question ID'];
  const ours = new Set();
  for (let r = firstRow; r < firstRow + count; r++) ours.add(r);
  const taken = new Set();
  rows.forEach((row, i) => { if (!ours.has(i + 2)) taken.add(String(row[idIdx] || '').trim()); });
  if (!ids.some((id) => taken.has(id))) return;

  const used = new Set([...taken, ...ids]);
  let n = Math.max(...[...used].map((id) => Number(String(id).split('-')[2]) || 0)) + 1;
  const cells = [];
  for (let r = firstRow; r < firstRow + count; r++) {
    const k = r - firstRow;
    if (!taken.has(ids[k])) continue;
    while (used.has(`${code}-${stamp}-${String(n).padStart(4, '0')}`)) n++;
    ids[k] = `${code}-${stamp}-${String(n).padStart(4, '0')}`;
    used.add(ids[k]);
    cells.push({ tab: subject, row: r, col: idIdx + 1, value: ids[k] });
    cells.push({ tab: subject, row: r, col: colNum(map, 'S.No'), value: n });
  }
  await writeCells(ctx, cells);
}

/** The operations served directly when a group is set up for it. */
const DIRECT = {
  readConfig, getUnpostedQuestions, claimQuestions, releaseQuestions, markAsPosted,
  holdQuestions, recoverStaleClaims, listPosted, unpostQuestions, addQuestions, markDeleted,
  scheduleQuestions, unscheduleQuestions, bulkStatus, formatQuestions,
  listReferrals, getReferral, getReferralFor, createReferral, setReferralStatus,
  listReferralEarnings, recordReferralEarning, settleReferralEarnings
};

/** Operations that change the sheet (they clear the Apps Script read cache). */
const WRITES = new Set(['claimQuestions', 'releaseQuestions', 'markAsPosted', 'holdQuestions',
  'recoverStaleClaims', 'unpostQuestions', 'addQuestions', 'markDeleted',
  'scheduleQuestions', 'unscheduleQuestions', 'bulkStatus', 'formatQuestions',
  'createReferral', 'setReferralStatus', 'recordReferralEarning', 'settleReferralEarnings']);

module.exports = {
  DIRECT,
  WRITES,
  isConfigured,
  serviceAccountEmail,
  // Exposed for tests.
  _internal: { istNow, hashQuestion, parseIstDate, headerMap, columnLetter, quoteTab, rowToQuestion, resolveIds, rgb, bodyFormatRequests, resetForTests() { cachedKey = undefined; token = { value: null, expiresAt: 0 }; } }
};
