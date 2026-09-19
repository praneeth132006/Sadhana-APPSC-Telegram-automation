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
    // Sheet metadata: every formatting request needs the numeric sheetId. It
    // hangs off the spreadsheet itself, so it is matched before the path is
    // stripped — there is no path left once the id is taken off.
    if (init.method !== 'POST' && /\?fields=sheets/.test(u)) {
      log.metaReads = (log.metaReads || 0) + 1;
      return reply(200, {
        sheets: Object.keys(book).map((title, i) => ({
          properties: { sheetId: i + 100, title },
          conditionalFormats: log.existingRules || []
        }))
      });
    }
    const path = u.replace(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/:?]+/, '');
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
      const requests = JSON.parse(init.body).requests;
      log.formatRequests = (log.formatRequests || []).concat(requests);
      const add = requests[0].addSheet;
      if (add) book[add.properties.title] = [];
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

// ---------------------------------------------------------------------------
// The curation queue
// ---------------------------------------------------------------------------
// The bug these cover: the dashboard printed a line per question saying it had
// been queued, then "0 question(s) queued" underneath. A count on its own
// cannot tell an id that is not in the tab from a row the poster is holding,
// so both are now named.

test('queueing marks the rows Scheduled, stamps the time, and names what it missed', async () => {
  const book = { Physics: [HEADERS,
    question(1, { 'Question ID': 'POL-0001' }),
    question(2, { 'Question ID': 'POL-0002', Status: 'Draft' })] };
  fakeSheets(book);

  const res = await DIRECT.scheduleQuestions(
    ctx, 'Physics', ['POL-0001', 'POL-0002', 'POL-9999'], '07-09-2026 09:00 IST', 'Curator (c@x)');

  assert.equal(res.updatedCount, 2);
  assert.deepEqual(res.notFound, ['POL-9999'], 'an id that is not in this tab is named, not counted as done');
  assert.deepEqual(res.skipped, []);

  assert.equal(book.Physics[1][col('Status')], 'Scheduled');
  assert.equal(book.Physics[1][col('Scheduled For')], '07-09-2026 09:00 IST');
  assert.equal(book.Physics[1][col('Updated By')], 'Curator (c@x)');
  assert.match(book.Physics[1][col('Updated At')], /IST$/);
  assert.equal(book.Physics[2][col('Status')], 'Scheduled', 'a Draft can be queued');
});

test('queueing refuses a posted, sending or held row rather than setting it up to go out twice', async () => {
  const book = { Physics: [HEADERS,
    question(1, { 'Question ID': 'A', Posted: 'YES', Status: 'Posted' }),
    question(2, { 'Question ID': 'B', Posted: 'SENDING | x | Approved', Status: 'Sending' }),
    question(3, { 'Question ID': 'C', Posted: 'CHECK | x', Status: 'Sending' }),
    question(4, { 'Question ID': 'D' })] };
  fakeSheets(book);

  const res = await DIRECT.scheduleQuestions(ctx, 'Physics', ['A', 'B', 'C', 'D'], '', 'Curator');

  assert.equal(res.updatedCount, 1);
  assert.deepEqual(
    res.skipped.map((s) => [s.questionId, s.reason]),
    [['A', 'already posted'], ['B', 'being sent right now'], ['C', 'held for checking']]
  );
  assert.equal(book.Physics[1][col('Status')], 'Posted', 'the posted row is untouched');
  assert.equal(book.Physics[4][col('Status')], 'Scheduled');
});

test('unqueueing restores the status and clears the target time', async () => {
  const book = { Physics: [HEADERS,
    question(1, { 'Question ID': 'A', Status: 'Scheduled', 'Scheduled For': '07-09-2026 09:00 IST' })] };
  fakeSheets(book);

  const res = await DIRECT.unscheduleQuestions(ctx, 'Physics', ['A'], 'Approved', 'Curator');

  assert.equal(res.updatedCount, 1);
  assert.equal(book.Physics[1][col('Status')], 'Approved');
  assert.equal(book.Physics[1][col('Scheduled For')], '',
    'a stale target time left behind is how a sheet starts lying about its own plan');
});

test('unqueueing falls back to Approved for a status that is not a real one', async () => {
  const book = { Physics: [HEADERS, question(1, { 'Question ID': 'A', Status: 'Scheduled' })] };
  fakeSheets(book);
  await DIRECT.unscheduleQuestions(ctx, 'Physics', ['A'], 'Nonsense', 'Curator');
  assert.equal(book.Physics[1][col('Status')], 'Approved');
});

test('bulkStatus refuses the statuses the poster owns, and leaves Scheduled For alone', async () => {
  const book = { Physics: [HEADERS,
    question(1, { 'Question ID': 'A', Status: 'Scheduled', 'Scheduled For': 'keep me' })] };
  fakeSheets(book);

  await assert.rejects(DIRECT.bulkStatus(ctx, 'Physics', ['A'], 'Posted', 'C'), /set by the poster/);
  await assert.rejects(DIRECT.bulkStatus(ctx, 'Physics', ['A'], 'Sending', 'C'), /set by the poster/);

  const res = await DIRECT.bulkStatus(ctx, 'Physics', ['A'], 'Archived', 'C');
  assert.equal(res.updatedCount, 1);
  assert.equal(book.Physics[1][col('Status')], 'Archived');
  assert.equal(book.Physics[1][col('Scheduled For')], 'keep me');
});

test('bulkStatus may archive a question that has already been posted', async () => {
  // Unlike queueing: archiving something that went out is ordinary curation,
  // while marking it Scheduled would set it up to be sent a second time.
  const book = { Physics: [HEADERS, question(1, { 'Question ID': 'A', Posted: 'YES', Status: 'Posted' })] };
  fakeSheets(book);
  assert.equal((await DIRECT.bulkStatus(ctx, 'Physics', ['A'], 'Archived', 'C')).updatedCount, 1);
  assert.equal(book.Physics[1][col('Status')], 'Archived');
});

test('an id repeated in one request is written once', async () => {
  const book = { Physics: [HEADERS, question(1, { 'Question ID': 'A' })] };
  const log = fakeSheets(book);
  const res = await DIRECT.scheduleQuestions(ctx, 'Physics', ['A', 'a', ' A '], '', 'C');
  assert.equal(res.updatedCount, 1, 'ids match case-insensitively and a repeat is not counted twice');
  assert.equal(log.writes.filter((w) => w.header === 'Status').length, 1);
});

test('a queue write with nothing to do touches the sheet not at all', async () => {
  const book = { Physics: [HEADERS, question(1, { 'Question ID': 'A' })] };
  const log = fakeSheets(book);
  const res = await DIRECT.scheduleQuestions(ctx, 'Physics', ['NOPE'], '', 'C');
  assert.equal(res.updatedCount, 0);
  assert.deepEqual(res.notFound, ['NOPE']);
  assert.equal(log.writes.length, 0);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
// The bug these cover: a tab filled through this client came out solid navy,
// bold white, top to bottom. `values:append` with insertDataOption=INSERT_ROWS
// does what inserting a row in the UI does — the new row inherits the
// formatting of the row above. The row above the first upload is the header.

/** Every repeatCell in a batch that sets a background, as [row range, colour]. */
function backgroundWrites(requests) {
  return (requests || [])
    .filter((r) => r.repeatCell && r.repeatCell.cell.userEnteredFormat.backgroundColor)
    .map((r) => ({
      startRowIndex: r.repeatCell.range.startRowIndex,
      endRowIndex: r.repeatCell.range.endRowIndex,
      background: r.repeatCell.cell.userEnteredFormat.backgroundColor,
      bold: r.repeatCell.cell.userEnteredFormat.textFormat.bold
    }));
}

test('appended rows are put back to the body style instead of inheriting the header', async () => {
  const book = { Physics: [HEADERS] };
  const log = fakeSheets(book);

  await DIRECT.addQuestions(ctx, 'Physics', [
    { question: 'New one?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'a' }
  ], 'Tester', true);

  const reset = backgroundWrites(log.formatRequests).find((w) => w.startRowIndex === 1);
  assert.ok(reset, 'the appended row was left with whatever formatting it inherited');
  assert.deepEqual(reset.background, { red: 1, green: 1, blue: 1 }, 'the row must go back to white');
  assert.equal(reset.bold, false);
  assert.equal(reset.endRowIndex, 2, 'exactly the one row that was appended');
});

test('the reset covers every appended row and no row that was already there', async () => {
  const book = { Physics: [HEADERS, question(1), question(2)] };
  const log = fakeSheets(book);

  await DIRECT.addQuestions(ctx, 'Physics', [
    { question: 'Third?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd' },
    { question: 'Fourth?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd' }
  ], 'Tester', true);

  const reset = backgroundWrites(log.formatRequests).find((w) => w.background.red === 1);
  assert.equal(reset.startRowIndex, 3, 'rows 4 and 5, which is where the append landed');
  assert.equal(reset.endRowIndex, 5);
});

test('an upload still succeeds when the formatting reset fails', async () => {
  // The questions are already safely in the sheet. Refusing an upload that
  // worked because its rows came out the wrong colour is the worse failure.
  const book = { Physics: [HEADERS] };
  const log = fakeSheets(book);
  const realFetchInner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/\?fields=sheets/.test(String(url))) throw new Error('metadata unavailable');
    return realFetchInner(url, init);
  };

  const res = await DIRECT.addQuestions(ctx, 'Physics', [
    { question: 'Still added?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd' }
  ], 'Tester', true);

  assert.equal(res.addedCount, 1);
  assert.equal(book.Physics[1][col('Question')], 'Still added?');
  assert.ok(log.appends === 1);
});

test('a new tab is styled as it is created, not left plain', async () => {
  const book = {};
  const log = fakeSheets(book);
  await DIRECT.addQuestions(ctx, 'Art and Culture',
    [{ question: 'New?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd' }], 'T', true);

  const header = backgroundWrites(log.formatRequests)
    .find((w) => w.startRowIndex === 0 && w.endRowIndex === 1);
  assert.ok(header, 'the header row was never styled');
  assert.equal(header.bold, true);
  assert.deepEqual(header.background, _internal.rgb('#1a237e'));
});

test('repairing a tab restores the header, the widths, the panes and the colour coding', async () => {
  const book = { Physics: [HEADERS, question(1), question(2)] };
  const log = fakeSheets(book);

  const res = await DIRECT.formatQuestions(ctx, 'Physics');
  assert.deepEqual(res, { subject: 'Physics', rows: 2 });

  const requests = log.formatRequests;
  const kinds = new Set(requests.map((r) => Object.keys(r)[0]));
  assert.ok(kinds.has('updateSheetProperties'), 'the frozen panes were not restored');
  assert.ok(kinds.has('updateDimensionProperties'), 'the column widths were not restored');
  assert.ok(kinds.has('setDataValidation'), 'the dropdowns were not restored');
  assert.ok(kinds.has('addConditionalFormatRule'), 'the colour coding was not restored');

  const frozen = requests.find((r) => r.updateSheetProperties).updateSheetProperties.properties;
  assert.equal(frozen.gridProperties.frozenRowCount, 1);
  assert.equal(frozen.gridProperties.frozenColumnCount, 2, 'S.No and Question ID stay visible');

  const widths = requests.filter((r) => r.updateDimensionProperties &&
    r.updateDimensionProperties.range.dimension === 'COLUMNS');
  assert.equal(widths.length, 30, 'every one of the 30 columns gets its width');

  // The body must come back white and unbold — the whole point of the repair.
  const body = backgroundWrites(requests).find((w) => w.startRowIndex === 1);
  assert.deepEqual(body.background, { red: 1, green: 1, blue: 1 });
  assert.equal(body.bold, false);

  // The rules a curator reads state by: Posted, Status and Difficulty.
  const rules = requests.filter((r) => r.addConditionalFormatRule)
    .map((r) => r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue);
  assert.deepEqual(rules, ['YES', 'NO', 'Approved', 'Posted', 'Scheduled', 'Review',
    'Rejected', 'Archived', 'Easy', 'Medium', 'Hard']);
});

test('repairing twice does not leave two of every colour rule behind', async () => {
  const book = { Physics: [HEADERS, question(1)] };
  const log = fakeSheets(book);
  // What the sheet already carries from the first repair.
  log.existingRules = new Array(11).fill({});

  await DIRECT.formatQuestions(ctx, 'Physics');

  const deletes = log.formatRequests.filter((r) => r.deleteConditionalFormatRule);
  assert.equal(deletes.length, 11, 'the rules already there were not cleared first');
  // Highest index first: deleting index 0 first would renumber the rest.
  assert.deepEqual(deletes.map((d) => d.deleteConditionalFormatRule.index),
    [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('an empty tab is still styled rather than skipped for having no rows', async () => {
  const book = { Physics: [HEADERS] };
  const log = fakeSheets(book);
  const res = await DIRECT.formatQuestions(ctx, 'Physics');
  assert.equal(res.rows, 0);
  assert.ok(log.formatRequests.some((r) => r.setDataValidation),
    'a tab with no questions yet still needs its dropdowns');
});

test('the long-form columns wrap and the rest stay on one line', async () => {
  // Without this every row would grow to the height of its longest cell.
  const requests = _internal.bodyFormatRequests(100, 2, 10);
  const wrapped = requests
    .filter((r) => r.repeatCell.cell.userEnteredFormat.wrapStrategy === 'WRAP')
    .map((r) => r.repeatCell.range.startColumnIndex + 1);
  assert.deepEqual(wrapped, [7, 8, 9, 10, 11, 13, 30], 'Question, the four options, Explanation, Review Notes');
  assert.equal(requests[0].repeatCell.cell.userEnteredFormat.wrapStrategy, 'CLIP');
});

test('repairing a tab that is not there says which one', async () => {
  fakeSheets({ Physics: [HEADERS] });
  await assert.rejects(DIRECT.formatQuestions(ctx, 'Nope'), /Sheet tab "Nope" not found/);
});
