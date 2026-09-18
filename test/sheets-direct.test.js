// ============================================================================
// Direct Sheets API client (src/sheets-direct.js)
// ============================================================================
// Runs the posting path against an in-memory spreadsheet behind a fake
// Sheets API, and checks it reads and writes exactly what the Apps Script
// does — the two share every sheet, so each must understand the other's marks.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'bot@test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
});

const direct = require('../src/sheets-direct');
const { DIRECT, _internal } = direct;

const HEADERS = ['S.No', 'Question ID', 'Date', 'Newspaper', 'Subject', 'Topic', 'Question',
  'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Explanation', 'Difficulty',
  'Tags', 'Source URL', 'Status', 'Posted', 'Posted At', 'Scheduled For', 'Thread ID',
  'Telegram Msg ID', 'Poll ID', 'Times Posted', 'Added At', 'Added By', 'Updated At',
  'Updated By', 'Dup Hash', 'Review Notes'];
const col = (h) => HEADERS.indexOf(h);

function question(n, overrides = {}) {
  const row = HEADERS.map(() => '');
  Object.assign(row, {
    [col('S.No')]: n, [col('Question ID')]: `PHY-${n}`, [col('Date')]: 46151, // 09-05-2026
    [col('Question')]: `Question ${n}?`, [col('Option A')]: 2005, [col('Option B')]: 'b',
    [col('Option C')]: 'c', [col('Option D')]: 'd', [col('Correct Answer')]: 'a',
    [col('Status')]: 'Approved', [col('Posted')]: 'NO'
  });
  Object.entries(overrides).forEach(([h, v]) => { row[col(h)] = v; });
  return row;
}

/** A fake Sheets API over { tabName: rows[][] }. */
function fakeSheets(book) {
  const log = { writes: [] };
  const letterToIndex = (letters) => letters.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const parse = (range) => {
    const m = decodeURIComponent(range).match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/);
    return { tab: m[1].replace(/''/g, "'"), col: letterToIndex(m[2]), row: Number(m[3]) };
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'tok', expires_in: 3600 });
    const path = u.replace(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/:]+/, '');
    if (init.method === 'POST' && path.startsWith('/values:batchUpdate')) {
      const body = JSON.parse(init.body);
      assert.equal(body.valueInputOption, 'RAW');
      for (const d of body.data) {
        const r = parse(d.range);
        const rows = book[r.tab];
        while (rows.length < r.row) rows.push([]);
        rows[r.row - 1][r.col] = d.values[0][0];
        log.writes.push({ tab: r.tab, row: r.row, header: book[r.tab][0][r.col], value: d.values[0][0] });
      }
      if (log.afterWrite) log.afterWrite();
      return reply(200, {});
    }
    if (init.method === 'POST' && path.startsWith(':batchUpdate')) {
      const add = JSON.parse(init.body).requests[0].addSheet;
      book[add.properties.title] = [];
      return reply(200, {});
    }
    const append = path.match(/^\/values\/([^?:]+):append/);
    if (init.method === 'POST' && append) {
      const tab = parse(append[1]).tab;
      const first = book[tab].length + 1;
      JSON.parse(init.body).values.forEach((v) => book[tab].push(v.slice()));
      log.appends = (log.appends || 0) + 1;
      return reply(200, { updates: { updatedRange: `'${tab}'!A${first}:AD${book[tab].length}` } });
    }
    if (init.method === 'PUT') {
      const r = parse(path.match(/^\/values\/([^?]+)/)[1]);
      book[r.tab][r.row - 1] = JSON.parse(init.body).values[0].slice();
      return reply(200, {});
    }
    const m = path.match(/^\/values\/([^?]+)/);
    const r = parse(m[1]);
    if (!book[r.tab]) return reply(400, { error: { message: 'Unable to parse range' } });
    return reply(200, { values: book[r.tab].slice(r.row - 1) });
  };
  return log;
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });
const ctx = { spreadsheetId: 'SHEET', url: 'x' };

test('IST stamps round-trip exactly as the Apps Script writes them', () => {
  const at = new Date(Date.UTC(2026, 8, 18, 9, 46, 5));
  assert.equal(_internal.istNow(at), '18-09-2026, 03:16:05 PM IST');
  assert.equal(_internal.parseIstDate('18-09-2026, 03:16:05 PM IST').getTime(), at.getTime());
  assert.equal(_internal.istNow(new Date(Date.UTC(2026, 0, 1, 18, 45))), '02-01-2026, 12:15:00 AM IST');
  assert.equal(_internal.columnLetter(30), 'AD');
  assert.equal(_internal.quoteTab("Rahul's"), "'Rahul''s'");
});

test('the posting queue skips posted, claimed, rejected and draft rows, like the Apps Script', async () => {
  fakeSheets({ Physics: [HEADERS,
    question(1, { Posted: 'YES' }),
    question(2, { Posted: 'SENDING | 18-09-2026, 03:16:05 PM IST | Approved' }),
    question(3, { Status: 'Rejected' }),
    question(4, { Status: 'Draft' }),
    question(5),
    question(6, { Status: 'Scheduled' })
  ] });
  const qs = await DIRECT.getUnpostedQuestions(ctx, 'Physics', 10, true);
  assert.deepEqual(qs.map((q) => q.excel_row), [6, 7]);
  assert.equal(qs[0].date, '09-05-2026', 'a date cell reads as dd-MM-yyyy, as the Apps Script gives it');
  assert.equal(qs[0].option_a, '2005');
  assert.equal(qs[0].correct_answer, 'A');
  const withDrafts = await DIRECT.getUnpostedQuestions(ctx, 'Physics', 10, false);
  assert.deepEqual(withDrafts.map((q) => q.excel_row), [5, 6, 7]);
});

test('a claim writes the Apps Script marker and a second claim is refused', async () => {
  const book = { Physics: [HEADERS, question(1, { Status: 'Scheduled' }), question(2, { Posted: 'YES' })] };
  fakeSheets(book);
  const first = await DIRECT.claimQuestions(ctx, 'Physics', [2, 3, 99]);
  assert.deepEqual(first.claimed, [2]);
  assert.deepEqual(first.skipped.map((s) => s.reason).sort(), ['already posted', 'no such row']);
  assert.match(book.Physics[1][col('Posted')], /^SENDING \| \d{2}-\d{2}-\d{4}, .* IST \| Scheduled \| [0-9a-f]{8}$/);
  assert.equal(book.Physics[1][col('Status')], 'Sending');

  const second = await DIRECT.claimQuestions(ctx, 'Physics', [2]);
  assert.deepEqual(second.claimed, []);
  assert.deepEqual(second.skipped, [{ row: 2, reason: 'already sending' }]);
});

test('a run that loses the race for a row does not send it', async () => {
  // Two runs read the row as free at the same moment. The one whose marker is
  // not in the cell afterwards must report it skipped, never send it.
  const book = { Physics: [HEADERS, question(1)] };
  const log = fakeSheets(book);
  log.afterWrite = () => { book.Physics[1][col('Posted')] = 'SENDING | 18-09-2026, 03:16:05 PM IST | Approved | other'; };
  const result = await DIRECT.claimQuestions(ctx, 'Physics', [2]);
  assert.deepEqual(result.claimed, []);
  assert.deepEqual(result.skipped, [{ row: 2, reason: 'already sending' }]);
});

test('marking posted records the full trail and counts the post', async () => {
  const book = { Physics: [HEADERS, question(1, { 'Times Posted': 1, Posted: 'SENDING | x | Approved' })] };
  fakeSheets(book);
  assert.equal(await DIRECT.markAsPosted(ctx, 'Physics', [2], 901, 33, { 2: 'poll-9' }), 1);
  const row = book.Physics[1];
  assert.equal(row[col('Posted')], 'YES');
  assert.equal(row[col('Status')], 'Posted');
  assert.equal(row[col('Times Posted')], 2);
  assert.equal(row[col('Thread ID')], 33);
  assert.equal(row[col('Telegram Msg ID')], 901);
  assert.equal(row[col('Poll ID')], 'poll-9');
  assert.match(row[col('Posted At')], /IST$/);
  await assert.rejects(DIRECT.markAsPosted(ctx, 'Physics', [50], 1, 1, null), /marked none/);
});

test('release restores the status and never touches a posted row', async () => {
  const book = { Physics: [HEADERS,
    question(1, { Posted: 'SENDING | x | Scheduled', Status: 'Sending' }),
    question(2, { Posted: 'YES', Status: 'Posted' })] };
  fakeSheets(book);
  assert.equal(await DIRECT.releaseQuestions(ctx, 'Physics', [2, 3], 'Scheduled'), 1);
  assert.equal(book.Physics[1][col('Posted')], 'NO');
  assert.equal(book.Physics[1][col('Status')], 'Scheduled');
  assert.equal(book.Physics[2][col('Posted')], 'YES');
});

test('stale claims are handed back with their own status; held and fresh ones are not', async () => {
  const fresh = _internal.istNow();
  const book = { Physics: [HEADERS,
    question(1, { Posted: 'SENDING | 01-01-2020, 10:00:00 AM IST | Scheduled', Status: 'Sending' }),
    question(2, { Posted: `SENDING | ${fresh} | Approved | abcd1234`, Status: 'Sending' }),
    question(3, { Posted: 'CHECK | 01-01-2020, 10:00:00 AM IST', Status: 'Sending' })] };
  fakeSheets(book);
  const result = await DIRECT.recoverStaleClaims(ctx, 'Physics', 10);
  assert.deepEqual(result.recovered.map((r) => [r.row, r.status]), [[2, 'Scheduled']]);
  assert.equal(result.held, 1);
  assert.equal(book.Physics[1][col('Status')], 'Scheduled');
  assert.match(book.Physics[2][col('Posted')], /^SENDING/);
});

test('holding a row marks it for checking and keeps the reason', async () => {
  const book = { Physics: [HEADERS, question(1, { Posted: 'SENDING | x | Approved', 'Review Notes': 'old note' })] };
  fakeSheets(book);
  assert.equal(await DIRECT.holdQuestions(ctx, 'Physics', [2], 'No answer from Telegram'), 1);
  assert.match(book.Physics[1][col('Posted')], /^CHECK \| .* IST$/);
  assert.match(book.Physics[1][col('Review Notes')], /^old note\n\[.* IST\] No answer from Telegram$/);
});

test('config is read from the Config tab', async () => {
  fakeSheets({ Config: [['Subject', 'Emoji', 'Thread', 'Cron', 'Batch', 'Active'],
    ['Physics', '⚛️', 33, '0 */3 * * *', 5, 'YES'], ['', '', '', '', '', '']] });
  assert.deepEqual(await DIRECT.readConfig(ctx), [{
    subject: 'Physics', emoji: '⚛️', topic_thread_id: 33, schedule_cron: '0 */3 * * *',
    questions_per_batch: 5, active: true
  }]);
});

test('a missing tab says so', async () => {
  fakeSheets({});
  await assert.rejects(DIRECT.getUnpostedQuestions(ctx, 'Nope', 1), /Sheet tab "Nope" not found/);
});

test('a group with a sheet id posts through the direct client', () => {
  process.env.SHEET_URL_APPSC_NEWS_TE = 'https://script.google.com/macros/s/x/exec';
  process.env.SHEET_TOKEN_APPSC_NEWS_TE = 't';
  process.env.SHEET_ID_APPSC_NEWS_TE = 'https://docs.google.com/spreadsheets/d/1K2N990WsFK9zXP5XipQj-XTrk80JAwYiPjDVtTPJrnM/edit#gid=0';
  const sheets = require('../src/sheets');
  const client = sheets.forGroup('appsc_news_te');
  assert.equal(client.direct, true);
  assert.equal(sheets.contextFor('appsc_news_te').spreadsheetId, '1K2N990WsFK9zXP5XipQj-XTrk80JAwYiPjDVtTPJrnM',
    'a pasted link is reduced to the id');
  delete process.env.SHEET_ID_APPSC_NEWS_TE;
  assert.equal(sheets.forGroup('appsc_news_te').direct, false, 'without an id it stays on the Apps Script');
});

test('adding questions issues the next ids, skips repeats and stores text as text', async () => {
  const book = { Physics: [HEADERS,
    question(1, { 'Question ID': 'PHY-20260918-0001', 'Dup Hash': 'made-by-an-old-script' }),
    question(2, { 'Question ID': 'PHY-20260918-0002' })] };
  const log = fakeSheets(book);
  const res = await DIRECT.addQuestions(ctx, 'Physics', [
    { question: 'Question 1?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'b' },
    { question: '=HYPERLINK("x")', option_a: '1-D, 2-C', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'c', date: '09-05-2026' },
    { question: '=HYPERLINK("x")', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd' }
  ], 'Tester (t@x)', true);
  assert.equal(res.addedCount, 1);
  assert.equal(res.skippedCount, 2, 'a repeat of an existing question and a repeat inside the batch');
  assert.match(res.ids[0], /^PHY-\d{8}-0003$/);
  const row = book.Physics[3];
  assert.equal(row[col('Question')], '=HYPERLINK("x")');
  assert.equal(row[col('S.No')], 3);
  assert.equal(row[col('Status')], 'Approved');
  assert.equal(row[col('Posted')], 'NO');
  assert.equal(row[col('Correct Answer')], 'C');
  assert.equal(row[col('Dup Hash')], _internal.hashQuestion('=HYPERLINK("x")'));
  assert.equal(row[col('Added By')], 'Tester (t@x)');
  assert.ok(log.appends === 1);
});

test('adding to a subject with no tab creates it', async () => {
  const book = {};
  fakeSheets(book);
  const res = await DIRECT.addQuestions(ctx, 'Art and Culture', [{ question: 'New?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd' }], 'T', true);
  assert.equal(res.addedCount, 1);
  assert.equal(book['Art and Culture'][0][col('Question')], 'Question');
  assert.match(res.ids[0], /^ART-\d{8}-0001$/);
  assert.equal(book['Art and Culture'][1][col('Question')], 'New?');
});
