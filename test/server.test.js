// ============================================================================
// Integration tests for the dashboard server (test/server.test.js)
// ============================================================================
// Run with: npm test
//
// These exercise the real HTTP server. Two collaborators are stubbed so the
// tests neither need a live Google Sheet nor a real Firebase login:
//   - src/auth.js  — `authorize` is replaced with a fake that accepts the
//                    token "valid-token" and rejects everything else. The
//                    genuine JWT verification has its own unit tests below.
//   - src/sheets.js — every method is replaced with a recorder, so we can
//                    assert exactly what the server would have sent upstream.
//
// The security cases at the bottom are the regression tests for the findings
// from the red/blue review: unauthenticated access, SSRF, path traversal,
// oversized bodies, cross-origin access and forged authorship.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Configure the environment BEFORE server.js is required, since it reads
// process.env at module load time.
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.GOOGLE_SHEET_WEBAPP_URL = 'https://script.google.com/macros/s/TEST/exec';
process.env.SHEET_API_TOKEN = 'test-sheet-token';
process.env.TELEGRAM_BOT_TOKEN = '123:TEST';
process.env.TELEGRAM_GROUP_ID = '-1001234567890';


// Posting paces itself against Telegram's per-group rate limit. Real spacing
// would make a five-question test take fifteen seconds for no extra coverage.
process.env.POST_SPACING_MS = '1';

// These tests exercise the server through its transitional single-group API,
// so they configure one group of their own rather than inheriting whatever the
// developer happens to have set up.
process.env.SHEET_URL_APPSC_NEWS_EN = 'https://script.google.com/macros/s/test-news-en/exec';
process.env.SHEET_TOKEN_APPSC_NEWS_EN = 'token-for-tests';
process.env.TELEGRAM_GROUP_APPSC_NEWS_EN = '-1001234567890';
process.env.LEGACY_GROUP_ID = 'appsc_news_en';
process.env.CURATOR_EMAILS = '';
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_for_tests';
process.env.EXAM_PASS_END_DATE = '30-11-2026';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const auth = require('../src/auth');
const sheets = require('../src/sheets');
const telegram = require('../src/telegram');

/** Records every sheets call so tests can assert on the arguments. */
const calls = [];

/** Replaces a module method with a recorder returning `result`. */
// Stubs for the group-bound sheets client. The server reaches every sheet
// through sheets.forGroup(id), so replacing sheets.ping no longer intercepts
// anything — the stub has to live on what forGroup hands back.
const clientStubs = {};

function stub(module, name, result) {
  const fn = async (...args) => {
    calls.push({ name, args });
    return typeof result === 'function' ? result(...args) : result;
  };
  module[name] = fn;
  clientStubs[name] = fn;
}

stub(sheets, 'ping', { status: 'ok', version: 'v6 (30 columns + membership)', tokenRequired: true });
stub(sheets, 'getAnalytics', { totals: { total: 10, posted: 4, pending: 6 }, subjects: [] });
stub(sheets, 'getStats', [{ subject: 'Polity', total: 10, posted: 4, pending: 6 }]);
stub(sheets, 'listQuestions', { total: 1, page: 1, totalPages: 1, questions: [{ question_id: 'POL-1' }] });
stub(sheets, 'readConfig', [{ subject: 'Polity', topic_thread_id: 12, active: true, questions_per_batch: 5 }]);
stub(sheets, 'addQuestions', { addedCount: 1, skippedCount: 0, ids: ['POL-20260905-0001'], message: '1 added' });
stub(sheets, 'updateQuestion', { message: 'updated' });
stub(sheets, 'deleteQuestion', { message: 'deleted' });
stub(sheets, 'bulkStatus', 2);
stub(sheets, 'bulkDelete', { deletedCount: 2, notFound: [] });
stub(sheets, 'scheduleQuestions', 3);
stub(sheets, 'getUnpostedQuestions', [
  { question_id: 'POL-1', question_text: 'Q1', row_index: 0, excel_row: 2 }
]);
stub(sheets, 'markAsPosted', 1);
stub(sheets, 'claimQuestions', { claimed: [2], skipped: [] });
stub(sheets, 'releaseQuestions', 1);
stub(sheets, 'listPosted', []);
stub(sheets, 'unpostQuestions', 0);

// Telegram: pretend the bot is healthy and every send succeeds.
telegram.init = () => {};
telegram.getBotInfo = async () => ({ username: 'testbot', firstName: 'Test', groupTitle: 'G', groupReachable: true, isForum: true });
telegram.sendQuizPoll = async () => ({ message_id: 999, poll: { id: 'poll-1' } });

// Auth: accept exactly one token.
auth.authorize = async (token) => {
  if (token !== 'valid-token') throw new Error('Token signature is invalid.');
  return {
    uid: 'uid-1', email: 'curator@example.com', name: 'Test Curator',
    emailVerified: true, signInProvider: 'google.com'
  };
};

// Payments: record what the webhook would do rather than calling Razorpay or
// Telegram for real.
const membership = require('../src/membership');
const paymentCalls = [];
membership.grantAccess = async (options) => {
  paymentCalls.push(options);
  return { subscriber: { telegram_id: options.telegramId }, inviteLink: 'https://t.me/+stub' };
};
membership.runDailyCheck = async ({ dryRun }) => ({
  checked: 2, reminded: [{ telegram_id: '1', daysLeft: 2 }], removed: [], failed: [], dryRun
});
stub(sheets, 'listSubscribers', { total: 1, page: 1, totalPages: 1, subscribers: [{ telegram_id: '555' }] });
stub(sheets, 'getRevenue', { totalMembers: 1, active: 1, totalRevenue: 299, byPlan: {} });
stub(sheets, 'upsertSubscriber', { telegram_id: '555' });

const server = require('../server');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // localhost, not 127.0.0.1: the server canonicalises the latter, and
  // localhost is the origin Firebase authorises and users actually load.
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(() => server.close());

/**
 * call — issues a request against the test server.
 *
 * @param {string} pathname Path including any query string
 * @param {Object} [options] { method, body, token, headers, rawBody }
 */
async function call(pathname, options = {}) {
  const { method = 'GET', body, token, headers = {}, rawBody } = options;
  const finalHeaders = { ...headers };
  if (token) finalHeaders['Authorization'] = 'Bearer ' + token;
  if (body || rawBody) finalHeaders['Content-Type'] = 'application/json';

  const res = await fetch(baseUrl + pathname, {
    method,
    headers: finalHeaders,
    body: rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : undefined),
    redirect: 'manual'
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — fine for static assets */ }
  return { status: res.status, headers: res.headers, text, json };
}

// Any group id resolves to the same stubbed client: these tests are about the
// routes, not about which sheet a group points at. The group-isolation tests
// live in payments.test.js and use the real registry.
const groupRegistry = require('../src/groups');
sheets.forGroup = (groupId) => {
  // Still runs the real lookup, so an unknown group is rejected here exactly as
  // it would be in production. Stubbing that away would make the isolation
  // tests pass against a server that had stopped checking.
  groupRegistry.requireGroup(groupId);
  return Object.assign({ groupId }, clientStubs);
};

/** The group these tests operate on. Data routes now require one. */
const TEST_GROUP = 'appsc_news_en';

/**
 * Shorthand for an authenticated request against the test group.
 *
 * The group is appended here rather than typed into every path, so a test that
 * forgets it is testing the missing-group behaviour on purpose — see
 * 'a data route refuses a request that names no group'.
 */
const authed = (pathname, options = {}) => {
  const joiner = pathname.includes('?') ? '&' : '?';
  const path = pathname.startsWith('/api/') && !pathname.includes('group=')
    ? `${pathname}${joiner}group=${TEST_GROUP}`
    : pathname;
  return call(path, { ...options, token: 'valid-token' });
};

// ===========================================================================
// Public endpoints
// ===========================================================================

test('GET /api/config reports capability flags and no secrets', async () => {
  const res = await call('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.json.firebaseProjectId, 'test-project');
  assert.equal(res.json.authEnforced, true);
  assert.equal(res.json.sheetConfigured, true);

  // The Web App URL and both tokens must never reach the browser.
  assert.ok(!res.text.includes('script.google.com'), 'sheet URL leaked to client');
  assert.ok(!res.text.includes('test-sheet-token'), 'sheet API token leaked to client');
  assert.ok(!res.text.includes('123:TEST'), 'telegram bot token leaked to client');
});

test('GET /api/ping probes the sheet without accepting a caller-supplied URL', async () => {
  const res = await call('/api/ping?url=http://169.254.169.254/latest/meta-data/');
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.outdated, false);

  // The attacker-supplied url must have been ignored entirely.
  const pings = calls.filter((c) => c.name === 'ping');
  assert.ok(pings.length > 0, 'ping was not delegated to the sheets client');
  assert.equal(pings[pings.length - 1].args.length, 0, 'ping accepted an argument from the query string');
});

test('the health report and the ping route agree about the deployed version', async () => {
  // These two once carried separate copies of the version test. One was updated
  // and the other was not, so Health called a current deployment outdated
  // against the very version it was asking for.
  const original = sheets.ping;
  sheets.ping = async () => ({ status: 'ok', version: 'v6 (30 columns + membership)', boundToSpreadsheet: true });
  try {
    const ping = await call('/api/ping');
    const health = await authed('/api/health');
    assert.equal(ping.json.outdated, false);
    assert.equal(health.json.data.sheets.current, true, 'health disagreed with ping about the same version');
  } finally {
    sheets.ping = original;
  }
});

test('a version newer than the one required is not called outdated', async () => {
  const original = sheets.ping;
  sheets.ping = async () => ({ status: 'ok', version: 'v7 (a later release)', boundToSpreadsheet: true });
  try {
    const res = await call('/api/ping');
    assert.equal(res.json.outdated, false);
  } finally {
    sheets.ping = original;
  }
});

test('GET /api/ping flags an outdated Apps Script deployment', async () => {
  const original = sheets.ping;
  sheets.ping = async () => ({ status: 'ok', version: 'v2 (10 columns)' });
  try {
    const res = await call('/api/ping');
    assert.equal(res.json.outdated, true);
    assert.match(res.json.upgradeHint, /upgradeSpreadsheet/);
  } finally {
    sheets.ping = original;
  }
});

// ===========================================================================
// Authentication
// ===========================================================================

test('every data route refuses an unauthenticated caller', async () => {
  const routes = [
    ['GET', '/api/analytics'], ['GET', '/api/stats'], ['GET', '/api/questions'],
    ['GET', '/api/subjects'], ['GET', '/api/health'], ['GET', '/api/telegram/status'],
    ['POST', '/api/questions'], ['POST', '/api/questions/update'],
    ['POST', '/api/questions/delete'], ['POST', '/api/questions/status'],
    ['POST', '/api/questions/schedule'], ['POST', '/api/telegram/post'],
    ['POST', '/api/send']
  ];

  for (const [method, route] of routes) {
    const res = await call(route, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${route} did not require authentication`);
    assert.equal(res.json.success, false);
  }
});

test('an invalid token is rejected with 403', async () => {
  const res = await call('/api/analytics', { token: 'forged-token' });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /signature/i);
});

test('a valid token is accepted', async () => {
  const res = await authed('/api/analytics');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.totals.total, 10);
});

// ===========================================================================
// Reads
// ===========================================================================

test('GET /api/questions forwards the filters it is given', async () => {
  calls.length = 0;
  const res = await authed('/api/questions?subject=Polity&status=Approved&posted=NO&search=preamble&page=2&pageSize=50');
  assert.equal(res.status, 200);

  const filters = calls.find((c) => c.name === 'listQuestions').args[0];
  assert.equal(filters.subject, 'Polity');
  assert.equal(filters.status, 'Approved');
  assert.equal(filters.posted, 'NO');
  assert.equal(filters.search, 'preamble');
  assert.equal(filters.page, '2');
});

test('GET /api/health reports every subsystem', async () => {
  const res = await authed('/api/health');
  assert.equal(res.status, 200);

  const health = res.json.data;
  assert.equal(health.server.ok, true);
  assert.equal(health.auth.enforced, true);
  assert.equal(health.sheets.reachable, true);
  assert.equal(health.telegram.reachable, true);
  assert.equal(health.telegram.botUsername, 'testbot');
  assert.equal(health.you.email, 'curator@example.com');
});

// ===========================================================================
// Question upload validation
// ===========================================================================

/** A question object that passes every validation rule. */
function validQuestion(overrides = {}) {
  return {
    question: 'Which of the statements given above is correct?',
    option_a: 'A only', option_b: 'B only', option_c: 'C only', option_d: 'All',
    correct_answer: 'C',
    explanation: 'Because.',
    ...overrides
  };
}

test('POST /api/questions accepts a well-formed batch', async () => {
  calls.length = 0;
  const res = await authed('/api/questions', {
    method: 'POST',
    body: { subject: 'Polity', questions: [validQuestion()] }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.addedCount, 1);

  const [subject, questions, addedBy] = calls.find((c) => c.name === 'addQuestions').args;
  assert.equal(subject, 'Polity');
  assert.equal(questions.length, 1);
  assert.equal(addedBy, 'Test Curator (curator@example.com)');
});

test('POST /api/questions rejects malformed batches', async () => {
  const cases = [
    [{ subject: '', questions: [validQuestion()] }, /subject/i],
    [{ subject: 'Polity', questions: [] }, /no questions/i],
    [{ subject: 'Polity', questions: [validQuestion({ correct_answer: 'E' })] }, /correct answer/i],
    [{ subject: 'Polity', questions: [validQuestion({ question: '   ' })] }, /empty question/i],
    [{ subject: 'Polity', questions: [validQuestion({ option_b: '' })] }, /missing one or more options/i],
    [{ subject: 'Polity', questions: Array(101).fill(validQuestion()) }, /too many/i],
    [{ subject: '../../etc/passwd', questions: [validQuestion()] }, /unsupported characters/i]
  ];

  for (const [body, pattern] of cases) {
    const res = await authed('/api/questions', { method: 'POST', body });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
    assert.match(res.json.error, pattern);
  }
});

test('a client cannot forge authorship or the posted flag', async () => {
  calls.length = 0;
  await authed('/api/questions', {
    method: 'POST',
    body: {
      subject: 'Polity',
      // Everything below is an attempt to write columns the client must not control.
      added_by: 'attacker@evil.example',
      questions: [validQuestion({
        posted: 'YES',
        posted_at: '01-01-2020',
        added_by: 'attacker@evil.example',
        question_id: 'POL-FORGED-0001',
        times_posted: 99
      })]
    }
  });

  const [, questions, addedBy] = calls.find((c) => c.name === 'addQuestions').args;

  // Attribution comes from the verified token, not the body.
  assert.equal(addedBy, 'Test Curator (curator@example.com)');

  // The sanitiser keeps only allowlisted fields.
  const sent = questions[0];
  assert.equal(sent.posted, undefined);
  assert.equal(sent.posted_at, undefined);
  assert.equal(sent.added_by, undefined);
  assert.equal(sent.question_id, undefined);
  assert.equal(sent.times_posted, undefined);
});

test('a javascript: source URL is dropped rather than stored', async () => {
  calls.length = 0;
  await authed('/api/questions', {
    method: 'POST',
    body: { subject: 'Polity', questions: [validQuestion({ source_url: 'javascript:alert(1)' })] }
  });

  const sent = calls.find((c) => c.name === 'addQuestions').args[1][0];
  assert.equal(sent.source_url, '', 'a non-http URL was written into the sheet');
});

test('oversized field values are truncated, not rejected outright', async () => {
  calls.length = 0;
  await authed('/api/questions', {
    method: 'POST',
    body: { subject: 'Polity', questions: [validQuestion({ explanation: 'x'.repeat(50000) })] }
  });

  const sent = calls.find((c) => c.name === 'addQuestions').args[1][0];
  assert.equal(sent.explanation.length, 4000);
});

// ===========================================================================
// Edit / delete / bulk
// ===========================================================================

test('POST /api/questions/update forwards the field patch with the real actor', async () => {
  calls.length = 0;
  const res = await authed('/api/questions/update', {
    method: 'POST',
    body: { subject: 'Polity', questionId: 'POL-1', fields: { topic: 'Preamble' } }
  });

  assert.equal(res.status, 200);
  const [subject, questionId, fields, actor] = calls.find((c) => c.name === 'updateQuestion').args;
  assert.equal(subject, 'Polity');
  assert.equal(questionId, 'POL-1');
  assert.deepEqual(fields, { topic: 'Preamble' });
  assert.equal(actor, 'Test Curator (curator@example.com)');
});

test('edit and delete require a questionId', async () => {
  for (const route of ['/api/questions/update', '/api/questions/delete']) {
    const res = await authed(route, { method: 'POST', body: { subject: 'Polity' } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /questionId/);
  }
});

test('bulk status caps the number of ids', async () => {
  const res = await authed('/api/questions/status', {
    method: 'POST',
    body: { subject: 'Polity', questionIds: Array(201).fill('POL-1'), status: 'Approved' }
  });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /max 200/);
});

test('bulk status applies to a valid selection', async () => {
  const res = await authed('/api/questions/status', {
    method: 'POST',
    body: { subject: 'Polity', questionIds: ['POL-1', 'POL-2'], status: 'Approved' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.updatedCount, 2);
});

test('bulk delete removes a whole selection in one call', async () => {
  calls.length = 0;
  const res = await authed('/api/questions/bulk-delete', {
    method: 'POST',
    body: { subject: 'Polity', questionIds: ['POL-1', 'POL-2'] }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.deletedCount, 2);
  assert.deepEqual(res.json.notFound, []);

  const [subject, ids] = calls.find((c) => c.name === 'bulkDelete').args;
  assert.equal(subject, 'Polity');
  assert.deepEqual(ids, ['POL-1', 'POL-2']);
});

test('bulk delete validates its input the way bulk status does', async () => {
  const bad = [
    [{ subject: 'Polity', questionIds: [] }, /No questionIds/],
    [{ subject: 'Polity' }, /No questionIds/],
    // 201 DISTINCT ids: the cap is applied after deduplication, because it
    // exists to limit how many rows one mistaken click destroys, and 201 copies
    // of one id destroys exactly one row.
    [{ subject: 'Polity', questionIds: Array.from({ length: 201 }, (_, i) => `POL-${i}`) }, /max 200/],
    [{ subject: '../secrets', questionIds: ['POL-1'] }, /.+/]
  ];

  for (const [body, pattern] of bad) {
    const res = await authed('/api/questions/bulk-delete', { method: 'POST', body });
    assert.equal(res.status, 400, `accepted ${JSON.stringify(body).slice(0, 60)}`);
    assert.match(res.json.error, pattern);
  }
});

test('bulk delete deduplicates ids before deleting', async () => {
  // A duplicate id would delete the row and then delete whatever slid into its
  // place. The sheet guards this too; sending it clean costs nothing.
  calls.length = 0;
  await authed('/api/questions/bulk-delete', {
    method: 'POST',
    body: { subject: 'Polity', questionIds: ['POL-1', 'POL-1', 'POL-2', 'POL-1'] }
  });

  const [, ids] = calls.find((c) => c.name === 'bulkDelete').args;
  assert.deepEqual(ids, ['POL-1', 'POL-2']);
});

test('bulk delete names the ids it could not find', async () => {
  // "Deleted 27 of 29" with no names leaves a curator no way to find the two.
  const original = clientStubs.bulkDelete;
  clientStubs.bulkDelete = async () => ({ deletedCount: 1, notFound: ['POL-2'] });
  try {
    const res = await authed('/api/questions/bulk-delete', {
      method: 'POST',
      body: { subject: 'Polity', questionIds: ['POL-1', 'POL-2'] }
    });
    assert.deepEqual(res.json.notFound, ['POL-2']);
  } finally {
    clientStubs.bulkDelete = original;
  }
});

// ===========================================================================
// Telegram posting
// ===========================================================================

test('POST /api/telegram/post sends and records the posting trail', async () => {
  calls.length = 0;
  const res = await authed('/api/telegram/post', {
    method: 'POST',
    body: { subject: 'Polity', count: 1 }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.postedCount, 1);

  const [subject, rows, messageId, threadId, pollIds] = calls.find((c) => c.name === 'markAsPosted').args;
  assert.equal(subject, 'Polity');
  // The 1-based sheet row, never the 0-based row_index — the sheet must not
  // have to guess which one it was handed.
  assert.deepEqual(rows, [2]);
  assert.equal(messageId, 999);
  assert.equal(threadId, 12);
  assert.deepEqual(pollIds, { 2: 'poll-1' });
});

test('posting defaults to Approved-only eligibility', async () => {
  calls.length = 0;
  await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });

  const [, , requireApproved] = calls.find((c) => c.name === 'getUnpostedQuestions').args;
  assert.equal(requireApproved, true, 'draft questions were eligible by default');
});

test('the data layer only publishes reviewed questions unless told otherwise', async () => {
  // send.js and schedule.js relied on this default. It used to be false, so the
  // dashboard published only Approved/Scheduled rows while the CLI and the cron
  // pushed unreviewed Drafts into the same paid channel.
  const data = require('../src/data');
  // data.js calls the module-level export, not a bound client, so that is what
  // has to be stubbed here.
  const original = sheets.getUnpostedQuestions;
  const seen = [];
  sheets.getUnpostedQuestions = async (subject, count, requireApproved) => {
    seen.push(requireApproved);
    return [];
  };

  try {
    await data.getUnpostedQuestions('Polity', 1);
    await data.getUnpostedQuestions('Polity', 1, false);
    assert.deepEqual(seen, [true, false], 'the omitted argument is not the safe one');
  } finally {
    sheets.getUnpostedQuestions = original;
  }
});

// ===========================================================================
// A sheet running an older Apps Script says so
// ===========================================================================
// Apps Script is pasted into each sheet by hand — merging a PR and deploying
// the site do not touch it. So the dashboard routinely runs ahead of the
// script, and the sheet answers "Unknown POST action: bulkDelete". That came
// back as a bare 500 and a red toast naming the action, which told a curator
// nothing about the manual step they had missed.

test('an action the sheet has never heard of is a 409, not a 500', async () => {
  const original = clientStubs.bulkDelete;
  clientStubs.bulkDelete = async () => {
    // Exactly what src/sheets.js raises for this reply.
    const err = new Error('This sheet\'s Apps Script does not know the "bulkDelete" action…');
    err.statusCode = 409;
    err.staleScript = true;
    err.missingAction = 'bulkDelete';
    throw err;
  };

  try {
    const res = await authed('/api/questions/bulk-delete', {
      method: 'POST', body: { subject: 'Polity', questionIds: ['POL-1'] }
    });
    assert.equal(res.status, 409, 'a missing manual step was reported as a server fault');
    assert.match(res.json.error, /Apps Script does not know/);
  } finally {
    clientStubs.bulkDelete = original;
  }
});

test('the stale-script message says what to do, not just what failed', () => {
  // Reconstructed the way src/sheets.js builds it, so the wording is asserted
  // rather than assumed.
  const sheetsModule = require('../src/sheets');
  assert.equal(typeof sheetsModule.forGroup, 'function');

  const raw = { success: false, error: 'Unknown POST action: bulkDelete' };
  const stale = String(raw.error).match(/^Unknown (?:POST|GET) action: (\w+)/);
  assert.ok(stale, 'the reply shape the sheet actually sends is no longer recognised');
  assert.equal(stale[1], 'bulkDelete');
});

// ===========================================================================
// A question is reserved before it is sent
// ===========================================================================
// Telegram can accept a poll and still leave this process with a timeout. A row
// marked only after a confirmed send is then delivered and still looks
// unposted, and goes out again on every run after — which is what put two real
// questions into an endless re-post loop.

test('rows are claimed before anything is sent', async () => {
  calls.length = 0;
  await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });

  const order = calls.map((c) => c.name);
  const claimAt = order.indexOf('claimQuestions');
  const markAt = order.indexOf('markAsPosted');

  assert.ok(claimAt !== -1, 'nothing was claimed before sending');
  assert.ok(claimAt < markAt, 'the row was marked before it was claimed');

  const [subject, rows] = calls.find((c) => c.name === 'claimQuestions').args;
  assert.equal(subject, 'Polity');
  assert.deepEqual(rows, [2]);
});

test('a question another run already claimed is skipped, not sent', async () => {
  const original = clientStubs.claimQuestions;
  clientStubs.claimQuestions = async () => ({
    claimed: [], skipped: [{ row: 2, reason: 'already sending' }]
  });

  try {
    calls.length = 0;
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });

    assert.equal(res.status, 200);
    assert.equal(res.json.postedCount, 0);
    assert.match(res.json.results[0].error, /already sending/);
    assert.equal(calls.filter((c) => c.name === 'markAsPosted').length, 0);
  } finally {
    clientStubs.claimQuestions = original;
  }
});

test('a send with no answer keeps the claim rather than risking a duplicate', async () => {
  // A timeout is not proof of non-delivery. The poll may be in the channel.
  const originalSend = telegram.sendQuizPoll;
  telegram.sendQuizPoll = async () => { throw new Error('ETIMEDOUT'); };

  try {
    calls.length = 0;
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });

    assert.equal(res.json.postedCount, 0);
    assert.equal(calls.filter((c) => c.name === 'releaseQuestions').length, 0,
      'a row that may have been delivered was handed back for re-sending');
    assert.deepEqual(res.json.strandedRows, [2]);
    assert.match(res.json.results[0].error, /held as "Sending"/);
  } finally {
    telegram.sendQuizPoll = originalSend;
  }
});

test('a send Telegram refused outright hands the row back', async () => {
  // A 400 means nothing was delivered, so the question must not be stranded.
  const originalSend = telegram.sendQuizPoll;
  telegram.sendQuizPoll = async () => {
    const err = new Error('Bad Request: poll question is too long');
    err.response = { body: { error_code: 400, description: 'poll question is too long' } };
    throw err;
  };

  try {
    calls.length = 0;
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });

    const released = calls.find((c) => c.name === 'releaseQuestions');
    assert.ok(released, 'a refused question was left stranded');
    assert.deepEqual(released.args[1], [2]);
    assert.deepEqual(res.json.strandedRows, []);
    assert.match(res.json.results[0].error, /Telegram refused it/);
  } finally {
    telegram.sendQuizPoll = originalSend;
  }
});

test('a flood wait is never treated as proof the poll was not delivered', async () => {
  // 429 can arrive after Telegram accepted the message.
  const originalSend = telegram.sendQuizPoll;
  telegram.sendQuizPoll = async () => {
    const err = new Error('Too Many Requests');
    err.response = { body: { error_code: 429, parameters: { retry_after: 5 } } };
    throw err;
  };

  try {
    calls.length = 0;
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });
    assert.equal(calls.filter((c) => c.name === 'releaseQuestions').length, 0);
    assert.deepEqual(res.json.strandedRows, [2]);
  } finally {
    telegram.sendQuizPoll = originalSend;
  }
});

test('asking for more than are ready explains why, instead of looking broken', async () => {
  // "2 of 2 posted" after asking for 5 reads like a failure. It is usually a
  // full queue, and the answer belongs in the message.
  const originalList = clientStubs.listQuestions;
  clientStubs.listQuestions = async () => ({
    total: 4, page: 1, totalPages: 1,
    questions: [
      { question_id: 'A', posted: 'YES', status: 'Posted', claimed: false },
      { question_id: 'B', posted: 'YES', status: 'Posted', claimed: false },
      { question_id: 'C', posted: 'NO', status: 'Draft', claimed: false },
      { question_id: 'D', posted: 'NO', status: 'Approved', claimed: false }
    ]
  });

  try {
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 5 } });

    assert.equal(res.json.requestedCount, 5);
    assert.equal(res.json.eligibleCount, 1);
    assert.match(res.json.message, /you asked for 5/);
    assert.match(res.json.message, /2 already posted/);
    assert.match(res.json.message, /1 not approved yet/);
  } finally {
    clientStubs.listQuestions = originalList;
  }
});

// ===========================================================================
// Reconciling the sheet against the channel
// ===========================================================================

test('reconcile reports deleted polls and changes nothing until asked', async () => {
  const originalPosted = clientStubs.listPosted;
  const originalExists = telegram.pollStillExists;
  clientStubs.listPosted = async () => ([
    { row: 2, question_id: 'POL-1', message_id: '900', status: 'Posted' },
    { row: 3, question_id: 'POL-2', message_id: '901', status: 'Posted' }
  ]);
  telegram.pollStillExists = async (id) => String(id) !== '901';

  try {
    calls.length = 0;
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity' }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.applied, false);
    assert.equal(res.json.missing.length, 1);
    assert.equal(res.json.missing[0].questionId, 'POL-2');
    assert.equal(calls.filter((c) => c.name === 'unpostQuestions').length, 0,
      'a read-only check wrote to the sheet');
  } finally {
    clientStubs.listPosted = originalPosted;
    telegram.pollStillExists = originalExists;
  }
});

test('reconcile puts deleted polls back in the queue when applied', async () => {
  const originalPosted = clientStubs.listPosted;
  const originalExists = telegram.pollStillExists;
  const originalUnpost = clientStubs.unpostQuestions;
  clientStubs.listPosted = async () => ([
    { row: 7, question_id: 'POL-9', message_id: '909', status: 'Posted' }
  ]);
  telegram.pollStillExists = async () => false;
  // Captured here rather than through the shared recorder: replacing a stub
  // directly bypasses it.
  const unpostArgs = [];
  clientStubs.unpostQuestions = async (...args) => { unpostArgs.push(args); return 1; };

  try {
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity', apply: true }
    });

    assert.equal(res.json.restored, 1);
    assert.equal(unpostArgs.length, 1);
    assert.equal(unpostArgs[0][0], 'Polity');
    assert.deepEqual(unpostArgs[0][1], [7]);
  } finally {
    clientStubs.listPosted = originalPosted;
    telegram.pollStillExists = originalExists;
    clientStubs.unpostQuestions = originalUnpost;
  }
});

test('reconcile leaves a poll alone when it cannot tell', async () => {
  // Guessing "deleted" would put a live question back in the queue and post it
  // a second time, which is the opposite of the point.
  const originalPosted = clientStubs.listPosted;
  const originalExists = telegram.pollStillExists;
  clientStubs.listPosted = async () => ([
    { row: 2, question_id: 'POL-1', message_id: '900', status: 'Posted' }
  ]);
  telegram.pollStillExists = async () => null;

  try {
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity', apply: true }
    });
    assert.equal(res.json.missing.length, 0);
    assert.deepEqual(res.json.unknown, ['POL-1']);
    assert.equal(res.json.restored, 0);
  } finally {
    clientStubs.listPosted = originalPosted;
    telegram.pollStillExists = originalExists;
  }
});

test('the posting batch size is capped at 20', async () => {
  calls.length = 0;
  await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 5000 } });

  const [, count] = calls.find((c) => c.name === 'getUnpostedQuestions').args;
  assert.equal(count, 20);
});

test('every question in a batch is marked against its own sheet row', async () => {
  // The regression this guards: rows used to be sent as 0-based indices and the
  // sheet guessed, which collapsed the 3rd, 4th and 5th rows of a batch onto
  // rows 2, 3 and 4. Five questions were posted, three rows were marked, and
  // the two survivors went out a second time on the next run.
  const original = clientStubs.getUnpostedQuestions;
  const originalClaim = clientStubs.claimQuestions;
  clientStubs.getUnpostedQuestions = async () => [0, 1, 2, 3, 4].map((i) => ({
    question_id: `POL-${i + 1}`, question_text: `Q${i + 1}`, row_index: i, excel_row: i + 2
  }));
  // The rows must be claimed before they can be sent.
  clientStubs.claimQuestions = async (subject, rows) => ({ claimed: rows, skipped: [] });

  try {
    calls.length = 0;
    const res = await authed('/api/telegram/post', {
      method: 'POST',
      body: { subject: 'Polity', count: 5 }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.postedCount, 5);

    const marked = calls.filter((c) => c.name === 'markAsPosted').flatMap((c) => c.args[1]);
    assert.deepEqual(marked, [2, 3, 4, 5, 6]);
  } finally {
    clientStubs.getUnpostedQuestions = original;
    clientStubs.claimQuestions = originalClaim;
  }
});

test('a question posted but not marked stays claimed, and says so', async () => {
  // The poll is public and the sheet does not know. The row keeps its claim so
  // it cannot go out again, and the message says which row needs a person.
  const original = clientStubs.markAsPosted;
  const originalRelease = clientStubs.releaseQuestions;
  let released = 0;
  clientStubs.markAsPosted = async () => { throw new Error('sheet unreachable'); };
  clientStubs.releaseQuestions = async () => { released++; return 1; };

  try {
    const res = await authed('/api/telegram/post', {
      method: 'POST',
      body: { subject: 'Polity', count: 1 }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.postedCount, 0);
    assert.equal(res.json.results[0].ok, false);
    assert.match(res.json.results[0].error, /Posted to Telegram, but the sheet did not record it/);
    assert.match(res.json.results[0].error, /Row 2 is held as "Sending"/);
    assert.deepEqual(res.json.strandedRows, [2]);
    assert.equal(released, 0, 'a live poll was handed back for re-sending');
  } finally {
    clientStubs.markAsPosted = original;
    clientStubs.releaseQuestions = originalRelease;
  }
});

test('a second posting batch for the same subject is refused while one runs', async () => {
  // Two overlapping batches read the same unposted rows and send both copies.
  const originalSend = telegram.sendQuizPoll;
  telegram.sendQuizPoll = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { message_id: 999, poll: { id: 'poll-1' } };
  };

  try {
    const [first, second] = await Promise.all([
      authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } }),
      // Started once the first is already inside its loop.
      new Promise((resolve) => setTimeout(
        () => resolve(authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } })), 20
      ))
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
    assert.match(second.json.error, /already running/);
  } finally {
    telegram.sendQuizPoll = originalSend;
  }
});

test('posting to a subject with no configured thread is refused', async () => {
  // Override on the bound client, which is what the route actually reads.
  const original = clientStubs.readConfig;
  clientStubs.readConfig = async () => [{ subject: 'Polity', topic_thread_id: null, active: true }];
  try {
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /topic thread/i);
  } finally {
    clientStubs.readConfig = original;
  }
});

// ===========================================================================
// Security regressions
// ===========================================================================

test('path traversal cannot escape the dashboard directory', async () => {
  const attempts = [
    '/../server.js',
    '/../.env',
    '/../../../../etc/passwd',
    '/%2e%2e/server.js',
    '/%2e%2e%2f%2e%2e%2f.env',
    '/..%2f..%2f.env',
    '/....//server.js',
    '/subdir/../../.env'
  ];

  for (const attempt of attempts) {
    const res = await call(attempt);
    assert.notEqual(res.status, 200, `${attempt} was served`);
    assert.ok(!res.text.includes('TELEGRAM_BOT_TOKEN'), `${attempt} leaked .env`);
    assert.ok(!res.text.includes('require(\'./src/sheets\')'), `${attempt} leaked server source`);
  }
});

test('only allowlisted file extensions are served', async () => {
  // A real file inside dashboard/ with a disallowed extension must not be served.
  const res = await call('/notes.md');
  assert.equal(res.status, 404);
});

test('static assets inside dashboard/ are served normally', async () => {
  for (const asset of ['/', '/index.html', '/analytics.html', '/questions.html', '/automation.html', '/health.html', '/shared.js', '/post-plan.js', '/style.css', '/shared.css']) {
    const res = await call(asset);
    assert.equal(res.status, 200, `${asset} was not served`);
  }
});

// ===========================================================================
// Payments
// ===========================================================================

/** Signs a webhook body the way Razorpay does. */
function signWebhook(body) {
  return require('node:crypto')
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(body).digest('hex');
}

test('the plan catalogue is public and exposes no secrets', async () => {
  const res = await call('/api/plans');
  assert.equal(res.status, 200);
  // Every group's real catalogue, not one global price list. Serving a single
  // list here is what let the page advertise prices no group charged.
  assert.ok(res.json.data.groups.length >= 2);
  res.json.data.groups.forEach((g) => assert.ok(g.plans.length >= 1, `${g.id} has no plans`));

  // A price list is fine to publish; keys are not.
  assert.ok(!res.text.includes(process.env.RAZORPAY_KEY_SECRET), 'the Razorpay key secret leaked');
  assert.ok(!res.text.includes(process.env.RAZORPAY_WEBHOOK_SECRET), 'the webhook secret leaked');
});

test('the plan catalogue prices each group from its own config entry', async () => {
  const config = JSON.parse(
    require('node:fs').readFileSync(path.join(__dirname, '..', 'groups.config.json'), 'utf8')
  );

  for (const configured of config.groups) {
    const res = await call(`/api/plans?group=${configured.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.data.group, configured.id);
    assert.ok(res.json.data.plans.length >= 1);
    for (const plan of res.json.data.plans) {
      assert.equal(
        plan.amountPaise, configured.plans[plan.id],
        `${configured.id}/${plan.id} is advertised at a price the group does not charge`
      );
    }
  }
});

test('the plan catalogue refuses an unknown group rather than inventing one', async () => {
  const res = await call('/api/plans?group=not_a_group');
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Unknown group/);
});

// ===========================================================================
// The payment bots, served over Telegram webhooks
// ===========================================================================
// They used to be three long-running laptop processes started by hand. In
// practice one ran and two did not, so two of the three bots answered nobody,
// and the one that ran had been started before the prices changed and kept
// quoting the old ones from memory. These cover the route that replaced them.

/** The secret Telegram must echo back, derived the way server.js derives it. */
function botWebhookSecret() {
  return require('node:crypto')
    .createHash('sha256')
    .update('telegram-webhook:' + process.env.CRON_SECRET)
    .digest('hex').slice(0, 48);
}

async function botWebhook(payBotEnv, update, secret) {
  const res = await fetch(`${baseUrl}/api/telegram/bot/${encodeURIComponent(payBotEnv)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret === undefined ? botWebhookSecret() : secret
    },
    body: JSON.stringify(update)
  });
  return { status: res.status, json: await res.json() };
}

test('a bot webhook without the secret token is refused', async () => {
  // The only thing between this endpoint and anyone who guesses the URL. It
  // drives a bot that hands out paid-group invite links.
  for (const offered of ['', 'wrong', botWebhookSecret().slice(0, -1) + 'x']) {
    const res = await botWebhook('TELEGRAM_PAYBOT_NEWS', { update_id: 1 }, offered);
    assert.equal(res.status, 401, `accepted the secret "${offered}"`);
  }
});

test('a bot webhook for an unconfigured family is refused', async () => {
  const res = await botWebhook('TELEGRAM_PAYBOT_NOT_A_THING', { update_id: 1 });
  assert.equal(res.status, 404);
  assert.match(res.json.error, /No payment bot is configured/);
});

test('a signed bot webhook is accepted and answered once the work is done', async () => {
  // This used to answer before dispatching the update, so that Telegram never
  // retried and never issued a second payment link for one tap. On the
  // deployment that froze the instance mid-reply and every bot went silent, so
  // the 200 now goes out after the handlers have settled. See
  // test/botapp.test.js.
  const res = await botWebhook('TELEGRAM_PAYBOT_NEWS', {
    update_id: 7,
    message: { message_id: 1, date: 0, chat: { id: 4242, type: 'private' }, from: { id: 4242 }, text: '/nothing' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
});

test('every configured family has a webhook endpoint that accepts updates', async () => {
  // The regression this exists for: two of the three bots answering nobody.
  const groupsModule = require('../src/groups');
  const families = [...new Set(
    groupsModule.listGroups().filter((g) => g.ready && g.paymentBotEnv).map((g) => g.paymentBotEnv)
  )].filter((env) => String(process.env[env] || '').trim());

  assert.ok(families.length >= 2, 'expected several payment bot families');

  for (const payBotEnv of families) {
    const res = await botWebhook(payBotEnv, { update_id: 1 });
    assert.equal(res.status, 200, `${payBotEnv} does not answer its webhook`);
  }
});

// ===========================================================================
// The thank-you page's confirmation
// ===========================================================================
// Public, because the payer is a student in a browser. It grants nothing — it
// only says what was bought — but it must still refuse to answer about a
// payment link whose redirect signature does not check out.

/** Signs a payment-link redirect the way Razorpay does. */
function signRedirect({ linkId, paymentId, referenceId, status }) {
  return require('node:crypto')
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${linkId}|${referenceId}|${status}|${paymentId}`)
    .digest('hex');
}

function confirmQuery(parts, signature) {
  return new URLSearchParams({
    razorpay_payment_link_id: parts.linkId,
    razorpay_payment_id: parts.paymentId,
    razorpay_payment_link_reference_id: parts.referenceId,
    razorpay_payment_link_status: parts.status,
    razorpay_signature: signature
  }).toString();
}

test('the payment confirmation refuses an unsigned or forged redirect', async () => {
  const parts = { linkId: 'plink_x', paymentId: 'pay_x', referenceId: 'ref_x', status: 'paid' };
  const good = signRedirect(parts);

  const bad = [
    confirmQuery(parts, ''),
    confirmQuery(parts, 'not-a-signature'),
    confirmQuery(parts, good.slice(0, -1) + (good.endsWith('0') ? '1' : '0')),
    // Right signature, different link: the HMAC covers the id, so this fails.
    confirmQuery(Object.assign({}, parts, { linkId: 'plink_someone_else' }), good)
  ];

  for (const query of bad) {
    const res = await call('/api/payments/confirm?' + query);
    assert.ok(res.status === 400 || res.status === 401,
      `answered ${res.status} for a redirect it should not trust`);
  }
});

test('the payment confirmation describes the pass, and leaks no secrets', async () => {
  const parts = { linkId: 'plink_ok', paymentId: 'pay_ok', referenceId: 'ref_ok', status: 'paid' };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.razorpay.com')) return originalFetch(url, opts);
    const payload = JSON.stringify({
      id: 'plink_ok', status: 'paid', amount: 100,
      notes: { group_id: 'appsc_news_en', plan_id: 'sprint_30', telegram_id: '4242' }
    });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    const res = await call('/api/payments/confirm?' + confirmQuery(parts, signRedirect(parts)));
    assert.equal(res.status, 200);

    const d = res.json.data;
    assert.equal(d.paid, true);
    assert.equal(d.planLabel, '30-Day Sprint Pass');
    assert.equal(d.amountPaise, 100);
    assert.equal(d.recurring, false);
    assert.match(d.groupName, /APPSC Newspaper/);

    // It is a public endpoint reached with no login.
    assert.ok(!res.text.includes(process.env.RAZORPAY_KEY_SECRET), 'the Razorpay secret leaked');
    assert.ok(!res.text.includes(process.env.SHEET_API_TOKEN), 'the sheet token leaked');
    assert.ok(!res.text.includes('4242'), 'the buyer telegram id leaked to the browser');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the payment confirmation reports an unpaid link as unpaid', async () => {
  const parts = { linkId: 'plink_no', paymentId: '', referenceId: 'ref_no', status: 'expired' };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.razorpay.com')) return originalFetch(url, opts);
    const payload = JSON.stringify({
      id: 'plink_no', status: 'expired', amount: 100,
      notes: { group_id: 'appsc_news_en', plan_id: 'sprint_30' }
    });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    const res = await call('/api/payments/confirm?' + confirmQuery(parts, signRedirect(parts)));
    assert.equal(res.status, 200);
    assert.equal(res.json.data.paid, false, 'an unpaid link was reported as paid');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a webhook with a valid signature is processed', async () => {
  paymentCalls.length = 0;
  const body = JSON.stringify({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: 'plink_x', notes: { telegram_id: '4242', plan_id: 'sprint_30', group_id: 'appsc_news_en' } } },
      payment: { entity: { id: 'pay_x', amount: 29900 } }
    }
  });

  const res = await fetch(baseUrl + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signWebhook(body) },
    body
  });

  assert.equal(res.status, 200);
  assert.equal(paymentCalls.length, 1);
  assert.equal(paymentCalls[0].telegramId, '4242');
  assert.equal(paymentCalls[0].groupId, 'appsc_news_en');
});

test('a webhook with a forged signature grants nothing', async () => {
  // The whole paywall rests on this: without it, anyone who finds the URL can
  // POST "payment captured" and be handed a paid seat for free.
  paymentCalls.length = 0;
  const body = JSON.stringify({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: 'plink_evil', notes: { telegram_id: '666', plan_id: 'exam_pass' } } },
      payment: { entity: { id: 'pay_evil', amount: 79900 } }
    }
  });

  for (const signature of ['deadbeef', 'f'.repeat(64), '']) {
    const res = await fetch(baseUrl + '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
      body
    });
    assert.equal(res.status, 401, `signature "${signature.slice(0, 12)}" was accepted`);
  }

  // And with no signature header at all.
  const bare = await fetch(baseUrl + '/api/payments/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  });
  assert.equal(bare.status, 401);

  assert.equal(paymentCalls.length, 0, 'a forged webhook granted group access');
});

test('a webhook body altered after signing is rejected', async () => {
  paymentCalls.length = 0;
  const original = JSON.stringify({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: 'p1', notes: { telegram_id: '1', plan_id: 'sprint_30' } } },
      payment: { entity: { id: 'pay1', amount: 29900 } }
    }
  });
  const signature = signWebhook(original);

  // Same signature, upgraded plan — the classic tamper.
  const tampered = original.replace('sprint_30', 'exam_pass');

  const res = await fetch(baseUrl + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature },
    body: tampered
  });

  assert.equal(res.status, 401);
  assert.equal(paymentCalls.length, 0);
});

test('the webhook is not behind the Firebase auth gate', async () => {
  // Razorpay cannot present a Firebase token. Its credential is the signature,
  // so a signed call must succeed with no Authorization header at all.
  const body = JSON.stringify({ event: 'payment.authorized', payload: {} });
  const res = await fetch(baseUrl + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signWebhook(body) },
    body
  });
  assert.equal(res.status, 200);
});

test('member endpoints require authentication', async () => {
  for (const [method, route] of [
    ['GET', '/api/members'], ['GET', '/api/members/revenue'],
    ['POST', '/api/payments/link'], ['POST', '/api/members/run-check']
  ]) {
    const res = await call(route, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${route} did not require authentication`);
  }
});

test('a payment link is priced and tagged for the group that was selected', async () => {
  // The regression: the route read plans.getPlan(), the legacy global table,
  // whose plans carry no groupId. Razorpay then wrote an empty notes.group_id
  // and the webhook dropped the event as "notes lacked group_id" — the student
  // paid and got nothing back.
  const config = JSON.parse(
    require('node:fs').readFileSync(path.join(__dirname, '..', 'groups.config.json'), 'utf8')
  );
  const expected = config.groups.find((g) => g.id === 'appsc_news_en').plans.sprint_30;

  const originalFetch = globalThis.fetch;
  let sentBody = null;
  // Only Razorpay is intercepted: `authed` reaches the server under test over
  // fetch too, and swallowing that would make this pass against nothing.
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.razorpay.com')) return originalFetch(url, opts);
    sentBody = opts.body;
    const payload = JSON.stringify({ id: 'plink_x', short_url: 'https://rzp.io/x' });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    const res = await authed('/api/payments/link', {
      method: 'POST',
      body: { planId: 'sprint_30', telegramId: '4242' }
    });

    assert.equal(res.status, 200);
    const body = JSON.parse(sentBody);
    assert.equal(body.notes.group_id, 'appsc_news_en', 'the sale is not credited to any group');
    assert.equal(body.amount, expected, 'the student is charged a price this group does not advertise');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('creating a payment link validates the plan and telegram id', async () => {
  const bad = [
    [{ planId: 'not_a_plan', telegramId: '123' }, /not a pass sold for this group/],
    [{ planId: 'sprint_30', telegramId: 'abc' }, /numeric/],
    [{ planId: 'sprint_30', telegramId: '' }, /numeric/],
    [{ planId: 'sprint_30', telegramId: "1; DROP TABLE" }, /numeric/]
  ];

  for (const [body, pattern] of bad) {
    const res = await authed('/api/payments/link', { method: 'POST', body });
    assert.equal(res.status, 400, `accepted ${JSON.stringify(body)}`);
    assert.match(res.json.error, pattern);
  }
});

test('the expiry sweep defaults to a dry run', async () => {
  // An admin clicking "preview" must never actually remove anyone.
  const res = await authed('/api/members/run-check', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.dryRun, true);
});

test('members list is returned to an authenticated curator', async () => {
  const res = await authed('/api/members');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.subscribers.length, 1);
});

test('a 127.0.0.1 page load is redirected to localhost', async () => {
  // Firebase treats localhost and 127.0.0.1 as different domains and only
  // localhost is authorised by default, so signing in from 127.0.0.1 fails —
  // often as an opaque 500 from accounts.google.com.
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/analytics.html`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `http://localhost:${port}/analytics.html`);
});

test('the redirect preserves the path and query string', async () => {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/questions.html?subject=Polity&page=2`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `http://localhost:${port}/questions.html?subject=Polity&page=2`);
});

test('API calls are never redirected — only page loads', async () => {
  // Redirecting an API call would break the fetch that carries the auth token.
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('location'), null);
});

test('a localhost page load is served directly, not redirected', async () => {
  const res = await call('/index.html');
  assert.equal(res.status, 200);
});

test('the redirect can be disabled for a deliberate 127.0.0.1 setup', async () => {
  process.env.CANONICAL_HOST_REDIRECT = 'false';
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/index.html`, { redirect: 'manual' });
    assert.equal(res.status, 200);
  } finally {
    delete process.env.CANONICAL_HOST_REDIRECT;
  }
});

test('no permissive CORS header is ever sent', async () => {
  const responses = [
    await call('/api/config'),
    await authed('/api/analytics'),
    await call('/index.html')
  ];
  for (const res of responses) {
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      'a cross-origin page could read this response');
  }
});

test('CORS preflight is refused, so cross-origin API calls cannot proceed', async () => {
  const res = await call('/api/questions', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('security headers are present on every response', async () => {
  const res = await call('/index.html');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(res.headers.get('content-security-policy'), /object-src 'none'/);
});

test('an oversized request body is rejected rather than buffered', async () => {
  const res = await authed('/api/questions', {
    method: 'POST',
    rawBody: 'x'.repeat(3 * 1024 * 1024)
  });
  assert.equal(res.status, 413);
});

test('a malformed JSON body produces a clean 400', async () => {
  const res = await authed('/api/questions', { method: 'POST', rawBody: '{not json' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /valid JSON/);
});

test('a JSON array body is rejected — endpoints expect an object', async () => {
  const res = await authed('/api/questions', { method: 'POST', rawBody: '[1,2,3]' });
  assert.equal(res.status, 400);
});

test('static paths reject non-GET methods', async () => {
  const res = await call('/index.html', { method: 'POST', body: {} });
  assert.equal(res.status, 405);
});

test('an unknown API route 404s instead of falling through to index.html', async () => {
  const res = await authed('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.json.success, false);
  assert.ok(!res.text.includes('<!DOCTYPE'), 'an API path served HTML');
});

// ===========================================================================
// The scheduled expiry sweep
// ===========================================================================
// Removing lapsed members is the half of this that must keep working when
// nobody is watching, so it runs on a schedule Vercel owns rather than on a
// laptop. That makes the endpoint reachable from the internet, and the secret
// is the only thing standing between a stranger and a mass removal.

test('the cron sweep refuses to run without a secret configured', async () => {
  const before = process.env.CRON_SECRET;
  try {
    delete process.env.CRON_SECRET;
    const res = await call('/api/cron/sweep', { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(res.json.success, false);
  } finally {
    if (before === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = before;
  }
});

test('the cron sweep rejects a caller with no or wrong credentials', async () => {
  const before = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'a-secret-for-tests';
  try {
    const none = await call('/api/cron/sweep', { method: 'POST' });
    assert.equal(none.status, 401);

    const wrong = await call('/api/cron/sweep', {
      method: 'POST',
      headers: { Authorization: 'Bearer not-the-secret' }
    });
    assert.equal(wrong.status, 401);
  } finally {
    if (before === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = before;
  }
});

test('the cron sweep runs for real when the secret matches', async () => {
  const before = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'a-secret-for-tests';

  const membership = require('../src/membership');
  const original = membership.runDailyCheckAllGroups;
  let ranWith = null;
  // The scheduled sweep must cover every group, not one. A cron that swept a
  // single group would leave the other four full of expired members while
  // reporting success.
  membership.runDailyCheckAllGroups = async (opts) => {
    ranWith = opts;
    return { groups: [], totals: { reminded: 0, removed: 0 }, dryRun: opts.dryRun };
  };

  try {
    const res = await call('/api/cron/sweep', {
      method: 'POST',
      headers: { Authorization: 'Bearer a-secret-for-tests' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    // A scheduled run must actually remove people, not rehearse.
    assert.equal(ranWith.dryRun, false);
  } finally {
    membership.runDailyCheckAllGroups = original;
    if (before === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = before;
  }
});

// ===========================================================================
// Group scoping on the API
// ===========================================================================

test('a data route refuses a request that names no group', async () => {
  // The isolation guarantee in one assertion. If this ever defaults instead of
  // refusing, a curator with no group selected silently reads — or writes —
  // whichever group the server picked, and nothing in the response says so.
  const res = await call('/api/questions', { token: 'valid-token' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /must name a group/i);
});

test('a data route refuses an unknown group', async () => {
  const res = await call('/api/questions?group=not_a_real_group', { token: 'valid-token' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Unknown group/i);
});

test('GET /api/groups lists the groups without leaking their secrets', async () => {
  const res = await authed('/api/groups');
  assert.equal(res.status, 200);

  const list = res.json.data;
  assert.ok(Array.isArray(list) && list.length >= 2);
  list.forEach((g) => {
    assert.ok(g.id && g.displayName);
    assert.ok(Array.isArray(g.plans));
  });

  // Sheet URLs and tokens must never reach the browser: the dashboard talks to
  // this server, and the server talks to the sheets.
  assert.ok(!res.text.includes('script.google.com'), 'a sheet URL reached the client');
  assert.ok(!res.text.includes('token-for-tests'), 'a sheet token reached the client');
});

test('the group picker prices every group from its own config entry', async () => {
  // Not "these two differ": on test-stage pricing they legitimately match, and
  // that assertion would then be checking the price list rather than the wiring.
  const config = JSON.parse(
    require('node:fs').readFileSync(path.join(__dirname, '..', 'groups.config.json'), 'utf8')
  );
  const res = await authed('/api/groups');
  const byId = Object.fromEntries(res.json.data.map((g) => [g.id, g]));

  for (const configured of config.groups) {
    const shown = byId[configured.id];
    assert.ok(shown, `${configured.id} is missing from the picker`);
    for (const plan of shown.plans) {
      assert.equal(
        plan.amountPaise, configured.plans[plan.id],
        `${configured.id}/${plan.id} is shown at the wrong price`
      );
    }
  }
});

// ===========================================================================
// Health checks that were reporting on themselves rather than the system
// ===========================================================================

test('dedicatedPaymentBot reflects the per-family tokens actually in use', async () => {
  // The regression: this read paybot.hasDedicatedBot() with no argument, which
  // looks up process.env[undefined] and is therefore false no matter how the
  // bots are configured. The Health page showed "One bot is doing both jobs"
  // permanently, and told the curator to set TELEGRAM_PAYMENT_BOT_TOKEN — the
  // legacy single-bot fallback, not the token the group actually uses.
  const groupsModule = require('../src/groups');
  const before = process.env.TELEGRAM_PAYBOT_NEWS;

  try {
    process.env.TELEGRAM_PAYBOT_NEWS = '999:DEDICATED';
    groupsModule.reset();

    const res = await authed('/api/health');
    const payments = res.json.data.payments;

    assert.equal(payments.dedicatedPaymentBot, true,
      'a group whose payment bot has its own token still reported as sharing one');
    assert.deepEqual(payments.sharedPaymentBotGroups, []);
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_PAYBOT_NEWS;
    else process.env.TELEGRAM_PAYBOT_NEWS = before;
    groupsModule.reset();
  }
});

test('a group with no payment-bot token of its own is named, not just counted', async () => {
  const groupsModule = require('../src/groups');
  const before = process.env.TELEGRAM_PAYBOT_NEWS;

  try {
    delete process.env.TELEGRAM_PAYBOT_NEWS;
    groupsModule.reset();

    const res = await authed('/api/health');
    const payments = res.json.data.payments;

    assert.equal(payments.dedicatedPaymentBot, false);
    assert.ok(payments.sharedPaymentBotGroups.length >= 1,
      'the group falling back to another token was not reported');
    // The Health page prints this variable, so it has to be the real one.
    assert.ok(payments.sharedPaymentBotGroups.every((g) => g.env && g.label),
      'each shared group needs the env var to set and a label to show');
    assert.ok(payments.sharedPaymentBotGroups.some((g) => g.env === 'TELEGRAM_PAYBOT_NEWS'));
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_PAYBOT_NEWS;
    else process.env.TELEGRAM_PAYBOT_NEWS = before;
    groupsModule.reset();
  }
});

test('health says whether the server is serverless, so 0.0.0.0 can be judged', async () => {
  // Binding 0.0.0.0 is a real warning on a laptop and correct on Vercel, where
  // the container requires it and there is no LAN. Without this flag the Health
  // page warned about network exposure on the deployment and advised unsetting
  // HOST, which would stop it accepting requests at all.
  const res = await authed('/api/health');
  assert.equal(typeof res.json.data.server.serverless, 'boolean');
  assert.equal(res.json.data.server.serverless, false, 'tests do not run on Vercel');
  assert.equal(res.json.data.server.host, '127.0.0.1');
});
