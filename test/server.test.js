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
// A second group with its own supergroup, so posting can be checked to go to
// the selected group's chat and not the default TELEGRAM_GROUP_ID.
process.env.SHEET_URL_APPSC_NEWS_TE = 'https://script.google.com/macros/s/test-news-te/exec';
process.env.SHEET_TOKEN_APPSC_NEWS_TE = 'token-for-tests';
process.env.TELEGRAM_GROUP_APPSC_NEWS_TE = '-1009876543210';
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

// The suite makes more requests in a minute than one curator's browser ever
// would, and a 429 halfway through says nothing about the route under test.
// The limiter has its own test below, which does not rely on this.
process.env.RATE_LIMIT_MAX = '100000';

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
stub(sheets, 'bulkStatus', { updatedCount: 2, notFound: [], skipped: [] });
stub(sheets, 'bulkDelete', { deletedCount: 2, notFound: [] });
stub(sheets, 'scheduleQuestions', { updatedCount: 3, notFound: [], skipped: [] });
stub(sheets, 'unscheduleQuestions', { updatedCount: 3, notFound: ['POL-9'], skipped: [] });
stub(sheets, 'getUnpostedQuestions', [
  { question_id: 'POL-1', question_text: 'Q1', row_index: 0, excel_row: 2 }
]);
stub(sheets, 'markAsPosted', 1);
stub(sheets, 'claimQuestions', { claimed: [2], skipped: [] });
stub(sheets, 'releaseQuestions', 1);
stub(sheets, 'recoverStaleClaims', { recovered: [], held: 0 });
stub(sheets, 'holdQuestions', 1);
stub(sheets, 'listPosted', []);
stub(sheets, 'unpostQuestions', 0);
stub(sheets, 'formatQuestions', (subject) => ({ subject, rows: 12 }));
stub(sheets, 'markDeleted', 1);
stub(sheets, 'listReferrals', [
  { code: 'REFAJMXPQ', telegram_id: '111', username: 'asha', name: 'Asha K', status: 'active', created_at: 'then' },
  { code: 'REFWMXD9N', telegram_id: '222', username: 'ravi', name: 'Ravi T', status: 'disabled', created_at: 'then' }
]);
stub(sheets, 'listReferralEarnings', [
  { code: 'REFAJMXPQ', referrer_telegram_id: '111', referrer_username: 'asha',
    referred_telegram_id: '333', referred_username: 'kiran', group: 'G', payment_id: 'pay_1',
    original_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582, status: 'pending' },
  { code: 'REFAJMXPQ', referrer_telegram_id: '111', referrer_username: 'asha',
    referred_telegram_id: '444', referred_username: 'meena', group: 'G', payment_id: 'pay_2',
    original_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582, status: 'paid' },
  { code: 'REFWMXD9N', referrer_telegram_id: '222', referrer_username: 'ravi',
    referred_telegram_id: '555', referred_username: 'sai', group: 'G', payment_id: 'pay_3',
    original_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582, status: 'cancelled' }
]);
stub(sheets, 'settleReferralEarnings', { settled: 1, paise: 3582 });
stub(sheets, 'setReferralStatus', 1);
stub(sheets, 'rebuildReferralSummaries', { rebuilt: 2 });

// Telegram: pretend the bot is healthy and every send succeeds.
telegram.init = () => {};
telegram.getBotInfo = async () => ({ username: 'testbot', firstName: 'Test', groupTitle: 'G', groupReachable: true, isForum: true });
telegram.sendQuizPoll = async () => ({ message_id: 999, poll: { id: 'poll-1' } });

// Auth: accept exactly one token.
auth.authorize = async (token) => {
  // Refused the way the real one refuses, so the routes see the same shapes:
  // a bad token asks for a new one (401), a refused identity does not (403).
  if (token === 'not-a-curator') {
    throw auth.authError('Account nobody@example.com is not on the curator allowlist.', 'forbidden');
  }
  if (token !== 'valid-token') throw auth.authError('Token signature is invalid.', 'reauth');
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

// .env names the real support chat. Tests that want one set it themselves.
delete process.env.SUPPORT_CHAT_ID;
delete process.env.SUPPORT_THREAD_ID;

// No test may reach the real Telegram API. The server reads .env, which holds
// real bot tokens and the real SUPPORT_CHAT_ID; without this, any code path a
// test forgot to stub would post into the live support group. A test that
// wants Telegram replaces the specific method it needs, which runs instead.
require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};

// Nor the live Google Sheets or Razorpay: .env points at real ones.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(url, ...rest) {
    const target = String(url && url.url ? url.url : url);
    if (/^https:\/\/(script\.google(usercontent)?\.com|api\.razorpay\.com|api\.telegram\.org)\//.test(target)) {
      return Promise.reject(new Error(`Network call to ${target.split('?')[0]} attempted in a test — stub it`));
    }
    return realFetch.call(this, url, ...rest);
  };
}

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
    ['POST', '/api/questions/schedule'], ['POST', '/api/questions/unschedule'],
    ['POST', '/api/questions/format'], ['GET', '/api/referrals'],
    ['POST', '/api/referrals/settle'], ['POST', '/api/referrals/status'], ['POST', '/api/referrals/rebuild'],
    ['POST', '/api/telegram/post'], ['POST', '/api/telegram/reconcile'],
    ['GET', '/api/automation/autopilot'], ['POST', '/api/automation/autopilot'],
    ['POST', '/api/automation/autopilot/stop'],
    ['POST', '/api/send']
  ];

  for (const [method, route] of routes) {
    const res = await call(route, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${route} did not require authentication`);
    assert.equal(res.json.success, false);
  }
});

test('a bad token asks the browser to sign in again, rather than reading as a ban', async () => {
  // 401 and not 403. Both used to be 403, so a session that had simply lapsed
  // reached the dashboard as a permissions problem and told the curator to add
  // themselves to CURATOR_EMAILS when all they had to do was sign in again.
  const res = await call('/api/analytics', { token: 'forged-token' });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /signature/i);
});

test('an identity that is refused stays 403, because a new token would not help', async () => {
  const res = await call('/api/analytics', { token: 'not-a-curator' });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /allowlist/i);
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

test('a streamed post reports each step and question as it happens', async () => {
  // The dashboard's progress bar is driven by these lines. Without them a run
  // that takes minutes showed only "Posting…", indistinguishable from a hang.
  calls.length = 0;
  const res = await authed('/api/telegram/post', {
    method: 'POST',
    body: { subject: 'Polity', count: 1, stream: true }
  });

  assert.equal(res.status, 200);
  const events = res.text.trim().split('\n').map((line) => JSON.parse(line));
  const types = events.map((e) => e.type);

  assert.ok(types.includes('stage'), 'no progress stages were streamed');
  assert.deepEqual(events.find((e) => e.type === 'plan'), { type: 'plan', total: 1, eligible: 1, skipped: 0 });
  const sending = events.find((e) => e.type === 'sending');
  assert.equal(sending.index, 1);
  assert.equal(sending.total, 1);
  assert.equal(events.find((e) => e.type === 'result').ok, true);

  const done = events[events.length - 1];
  assert.equal(done.type, 'done', 'the stream must end with the summary');
  assert.equal(done.success, true);
  assert.equal(done.postedCount, 1);
  assert.ok(types.indexOf('sending') < types.indexOf('result'));
});

test('a streamed post that fails mid-run ends the stream with the error', async () => {
  const original = clientStubs.getUnpostedQuestions;
  clientStubs.getUnpostedQuestions = async () => { throw new Error('Google Sheets answered 404 Not Found'); };
  try {
    const res = await authed('/api/telegram/post', {
      method: 'POST',
      body: { subject: 'Polity', count: 1, stream: true }
    });
    const events = res.text.trim().split('\n').map((line) => JSON.parse(line));
    const done = events[events.length - 1];
    assert.equal(done.type, 'done');
    assert.equal(done.success, false);
    assert.match(done.error, /404/);
  } finally {
    clientStubs.getUnpostedQuestions = original;
  }
});

test('each group posts into its own Telegram group, never the default one', async () => {
  // The bug: every group posted to TELEGRAM_GROUP_ID (the English newspaper
  // group). Telugu Physics is topic 33 of the Telugu group, which does not
  // exist in the English one, so every Telugu question failed with
  // "message thread not found".
  const originalSend = telegram.sendQuizPoll;
  const chats = [];
  telegram.sendQuizPoll = async (threadId, q, chatId) => {
    chats.push(chatId);
    return { message_id: 999, poll: { id: 'poll-1' } };
  };
  try {
    const te = await call('/api/telegram/post?group=appsc_news_te', {
      method: 'POST', token: 'valid-token', body: { subject: 'Polity', count: 1 }
    });
    assert.equal(te.status, 200);
    const en = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });
    assert.equal(en.status, 200);
    assert.deepEqual(chats, ['-1009876543210', '-1001234567890']);
  } finally {
    telegram.sendQuizPoll = originalSend;
  }
});

test('a group with no Telegram group of its own refuses to post rather than use another', async () => {
  const saved = process.env.TELEGRAM_GROUP_APPSC_NEWS_TE;
  delete process.env.TELEGRAM_GROUP_APPSC_NEWS_TE;
  try {
    const res = await call('/api/telegram/post?group=appsc_news_te', {
      method: 'POST', token: 'valid-token', body: { subject: 'Polity', count: 1 }
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /TELEGRAM_GROUP_APPSC_NEWS_TE/);
  } finally {
    process.env.TELEGRAM_GROUP_APPSC_NEWS_TE = saved;
  }
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
    assert.match(res.json.results[0].error, /held for checking/);
    const held = calls.find((c) => c.name === 'holdQuestions');
    assert.ok(held, 'a row that may be in the channel must be held, not left as a plain claim');
    assert.deepEqual(held.args[1], [2]);
    assert.match(held.args[2], /No answer from Telegram/);
  } finally {
    telegram.sendQuizPoll = originalSend;
  }
});

test('rows left claimed by an interrupted run are put back before posting', async () => {
  const original = clientStubs.recoverStaleClaims;
  clientStubs.recoverStaleClaims = async (subject, minutes) => {
    calls.push({ name: 'recoverStaleClaims', args: [subject, minutes] });
    return { recovered: [{ row: 7, question_id: 'POL-7', status: 'Approved' }], held: 0 };
  };

  try {
    calls.length = 0;
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });

    const recovery = calls.find((c) => c.name === 'recoverStaleClaims');
    assert.ok(recovery, 'abandoned claims were never looked for');
    assert.equal(recovery.args[0], 'Polity');
    assert.ok(Number(recovery.args[1]) >= 10, 'a claim must be well clear of a running batch before it is taken back');

    // And it happens before the queue is read, or the recovered rows could not
    // be part of this run.
    const names = calls.map((c) => c.name);
    assert.ok(names.indexOf('recoverStaleClaims') < names.indexOf('getUnpostedQuestions'));

    assert.deepEqual(res.json.recoveredRows, [7]);
    assert.match(res.json.message, /put back in the queue/);
  } finally {
    clientStubs.recoverStaleClaims = original;
  }
});

test('a sheet whose Apps Script cannot recover claims still posts', async () => {
  const original = clientStubs.recoverStaleClaims;
  clientStubs.recoverStaleClaims = async () => {
    const err = new Error('This sheet\'s Apps Script does not know the "recoverStaleClaims" action');
    err.staleScript = true;
    throw err;
  };

  try {
    const res = await authed('/api/telegram/post', { method: 'POST', body: { subject: 'Polity', count: 1 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.postedCount, 1, 'an out-of-date sheet must not stop posting');
    assert.deepEqual(res.json.recoveredRows, []);
  } finally {
    clientStubs.recoverStaleClaims = original;
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

test('reconcile puts deleted polls back in the queue when that is asked for', async () => {
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
      method: 'POST', body: { subject: 'Polity', apply: true, action: 'requeue' }
    });

    assert.equal(res.json.restored, 1);
    assert.equal(res.json.action, 'requeue');
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
    assert.match(res.json.results[0].error, /Row 2 is held for checking/);
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

// ===========================================================================
// Support tickets and bot settings
// ===========================================================================

const TelegramBotClient = require('node-telegram-bot-api');

const SAMPLE_TICKET = {
  ticket_id: 'T-260917-AB2C', telegram_id: '4242', username: 'asha', name: 'Asha',
  category: 'payment', status: 'open', bot: 'TELEGRAM_PAYBOT_NEWS',
  last_message: 'paid, no link', conversation: '[now] @asha:\npaid, no link'
};

stub(sheets, 'listTickets', { total: 1, page: 1, totalPages: 1, counts: { open: 1 }, tickets: [SAMPLE_TICKET] });
stub(sheets, 'getTicket', (ctxOrId, maybeId) => {
  const id = maybeId === undefined ? ctxOrId : maybeId;
  return id === SAMPLE_TICKET.ticket_id ? SAMPLE_TICKET : null;
});
stub(sheets, 'appendTicketMessage', (id) => Object.assign({}, SAMPLE_TICKET, { ticket_id: id, status: 'answered' }));
stub(sheets, 'setTicketStatus', (id, status) => Object.assign({}, SAMPLE_TICKET, { ticket_id: id, status }));
stub(sheets, 'getBotSettings', { support_hours: '24x7', not_a_setting: 'x' });
stub(sheets, 'updateBotSettings', (patch) => patch);

/** Runs `fn` with a payment bot token set and Telegram sends recorded, not made. */
async function withRecordedBot(fn) {
  const savedToken = process.env.TELEGRAM_PAYBOT_NEWS;
  const savedSend = TelegramBotClient.prototype.sendMessage;
  const sends = [];
  process.env.TELEGRAM_PAYBOT_NEWS = savedToken || '123:TEST';
  TelegramBotClient.prototype.sendMessage = async function (chatId, text, options) {
    sends.push({ chatId: String(chatId), text, options });
    return { message_id: 1 };
  };
  try {
    return await fn(sends);
  } finally {
    TelegramBotClient.prototype.sendMessage = savedSend;
    if (savedToken === undefined) delete process.env.TELEGRAM_PAYBOT_NEWS;
    else process.env.TELEGRAM_PAYBOT_NEWS = savedToken;
  }
}

test('the support routes refuse an unauthenticated caller', async () => {
  for (const [method, path] of [
    ['GET', '/api/support/tickets'], ['GET', '/api/support/ticket?id=T-260917-AB2C'],
    ['POST', '/api/support/reply'], ['POST', '/api/support/status'],
    ['GET', '/api/support/settings'], ['POST', '/api/support/settings']
  ]) {
    const res = await call(`${path}${path.includes('?') ? '&' : '?'}group=${TEST_GROUP}`, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path} answered without sign-in`);
  }
});

test('GET /api/support/tickets lists tickets with where they are stored', async () => {
  calls.length = 0;
  const res = await authed('/api/support/tickets?status=nonsense&search=refund');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.tickets[0].ticket_id, 'T-260917-AB2C');
  assert.equal(res.json.data.context.primaryGroupId, 'appsc_news_en');
  assert.equal(res.json.data.context.isPrimary, true);

  const forwarded = calls.find((c) => c.name === 'listTickets').args[0];
  assert.equal(forwarded.status, '', 'an unknown status must not reach the sheet');
  assert.equal(forwarded.search, 'refund');
});

test('the second group of a family is told which sheet holds its tickets', async () => {
  const res = await call('/api/support/tickets?group=appsc_news_te', { token: 'valid-token' });
  // appsc_news_te may not be configured in every environment; when it is not,
  // the route must still refuse cleanly rather than crash.
  if (res.status === 200) {
    assert.equal(res.json.data.context.isPrimary, false);
    assert.equal(res.json.data.context.primaryGroupId, 'appsc_news_en');
  } else {
    assert.equal(res.status, 400);
  }
});

test('GET /api/support/ticket validates the id and reports a missing ticket', async () => {
  assert.equal((await authed('/api/support/ticket?id=../../etc')).status, 400);
  assert.equal((await authed('/api/support/ticket?id=T-260917-ZZZZ')).status, 404);
  const found = await authed('/api/support/ticket?id=T-260917-AB2C');
  assert.equal(found.status, 200);
  assert.match(found.json.data.conversation, /paid, no link/);
});

test('POST /api/support/reply validates before sending anything', async () => {
  await withRecordedBot(async (sends) => {
    assert.equal((await authed('/api/support/reply', { method: 'POST', body: { ticketId: 'bad', text: 'hi' } })).status, 400);
    assert.equal((await authed('/api/support/reply', { method: 'POST', body: { ticketId: 'T-260917-AB2C', text: '   ' } })).status, 400);
    assert.equal((await authed('/api/support/reply', { method: 'POST', body: { ticketId: 'T-260917-AB2C', text: 'x'.repeat(3501) } })).status, 400);
    assert.equal((await authed('/api/support/reply', { method: 'POST', body: { ticketId: 'T-260917-ZZZZ', text: 'hi' } })).status, 404);
    assert.equal(sends.length, 0, 'an invalid reply reached Telegram');
  });
});

test('POST /api/support/reply sends through the ticket\'s bot and records the real actor', async () => {
  await withRecordedBot(async (sends) => {
    calls.length = 0;
    const res = await authed('/api/support/reply', {
      method: 'POST',
      body: { ticketId: 'T-260917-AB2C', text: 'Resent <b>your</b> link', actor: 'forged@evil.com' }
    });
    assert.equal(res.status, 200, res.json && res.json.error);

    const toStudent = sends.find((s) => s.chatId === '4242');
    assert.ok(toStudent, 'the student was not messaged');
    assert.match(toStudent.text, /^💬 Support reply · T-260917-AB2C/);
    assert.match(toStudent.text, /Resent &lt;b&gt;your&lt;\/b&gt; link/, 'dashboard text must be escaped');

    const appended = calls.find((c) => c.name === 'appendTicketMessage');
    assert.equal(appended.args[1].status, undefined, 'the sheet decides the status from who wrote');
    assert.equal(appended.args[1].handledBy, 'Test Curator (curator@example.com)');
  });
});

test('a reply for a ticket whose bot is not configured is a 409, not a silent drop', async () => {
  const original = clientStubs.getTicket;
  clientStubs.getTicket = async () => Object.assign({}, SAMPLE_TICKET, { bot: 'TELEGRAM_PAYBOT_NOT_A_THING' });
  try {
    const res = await authed('/api/support/reply', { method: 'POST', body: { ticketId: 'T-260917-AB2C', text: 'hi' } });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /not configured/);
  } finally {
    clientStubs.getTicket = original;
  }
});

test('a Telegram refusal is reported, and the ticket is not marked answered', async () => {
  const savedToken = process.env.TELEGRAM_PAYBOT_NEWS;
  const savedSend = TelegramBotClient.prototype.sendMessage;
  process.env.TELEGRAM_PAYBOT_NEWS = savedToken || '123:TEST';
  TelegramBotClient.prototype.sendMessage = async () => { throw new Error('Forbidden: bot was blocked by the user'); };
  try {
    calls.length = 0;
    const res = await authed('/api/support/reply', { method: 'POST', body: { ticketId: 'T-260917-AB2C', text: 'hi' } });
    assert.equal(res.status, 502);
    assert.match(res.json.error, /blocked/);
    assert.equal(calls.filter((c) => c.name === 'appendTicketMessage').length, 0);
  } finally {
    TelegramBotClient.prototype.sendMessage = savedSend;
    if (savedToken === undefined) delete process.env.TELEGRAM_PAYBOT_NEWS;
    else process.env.TELEGRAM_PAYBOT_NEWS = savedToken;
  }
});

test('POST /api/support/status closes a ticket and tells the student', async () => {
  await withRecordedBot(async (sends) => {
    assert.equal((await authed('/api/support/status', { method: 'POST', body: { ticketId: 'T-260917-AB2C', status: 'deleted' } })).status, 400);

    calls.length = 0;
    const res = await authed('/api/support/status', { method: 'POST', body: { ticketId: 'T-260917-AB2C', status: 'closed' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.notified, true);
    assert.deepEqual(calls.find((c) => c.name === 'setTicketStatus').args,
      ['T-260917-AB2C', 'closed', 'Test Curator (curator@example.com)']);
    assert.ok(sends.some((s) => s.chatId === '4242' && /marked as resolved/.test(s.text)));
  });
});

test('GET /api/support/settings returns every known setting and drops unknown ones', async () => {
  const res = await authed('/api/support/settings');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.settings.support_hours, '24x7');
  assert.equal(res.json.data.settings.not_a_setting, undefined);
  assert.ok(res.json.data.definitions.some((d) => d.key === 'faq_payment'));
  assert.ok(res.json.data.categories.length >= 5);
});

test('POST /api/support/settings validates and saves with the real actor', async () => {
  assert.equal((await authed('/api/support/settings', { method: 'POST', body: { settings: { bank_details: 'x' } } })).status, 400);
  assert.equal((await authed('/api/support/settings', { method: 'POST', body: { settings: { support_enabled: 'maybe' } } })).status, 400);
  assert.equal((await authed('/api/support/settings', { method: 'POST', body: {} })).status, 400);

  calls.length = 0;
  const res = await authed('/api/support/settings', {
    method: 'POST', body: { settings: { support_enabled: 'No', welcome_note: 'Hello' } }
  });
  assert.equal(res.status, 200);
  const saved = calls.find((c) => c.name === 'updateBotSettings');
  assert.deepEqual(saved.args, [{ support_enabled: 'no', welcome_note: 'Hello' }, 'Test Curator (curator@example.com)']);
  assert.equal(res.json.data.settings.support_enabled, 'no');
});

test('an unknown support route is a 404', async () => {
  assert.equal((await authed('/api/support/nope')).status, 404);
});

test('the Support page is served and linked from the navigation', async () => {
  const page = await call('/support.html');
  assert.equal(page.status, 200);
  assert.match(page.text, /support\.js/);
  const shared = await call('/shared.js');
  assert.match(shared.text, /href: 'support\.html'/);
});

// ---- Resending an invite from the dashboard --------------------------------

test('POST /api/support/resend-invite sends through the ticket\'s bot and reports each group', async () => {
  const savedChat = process.env.SUPPORT_CHAT_ID;
  const originalResend = membership.resendInvite;
  const asked = [];
  membership.resendInvite = async (groupId, telegramId) => {
    asked.push({ groupId, telegramId: String(telegramId) });
    return groupId === 'appsc_news_en'
      ? { sent: true, inviteLink: 'https://t.me/+fresh', subscriber: { status: 'active' } }
      : { sent: false, reason: 'no subscription on record', subscriber: null };
  };
  process.env.SUPPORT_CHAT_ID = '-1007777777777';
  try {
    await withRecordedBot(async (sends) => {
      assert.equal((await authed('/api/support/resend-invite', { method: 'POST', body: { ticketId: 'nope' } })).status, 400);
      assert.equal((await authed('/api/support/resend-invite', { method: 'POST', body: { ticketId: 'T-260917-ZZZZ' } })).status, 404);

      calls.length = 0;
      const res = await authed('/api/support/resend-invite', { method: 'POST', body: { ticketId: 'T-260917-AB2C' } });
      assert.equal(res.status, 200, res.json && res.json.error);

      assert.ok(asked.every((a) => a.telegramId === '4242'), 'the invite must be for the ticket\'s student');
      const byGroup = Object.fromEntries(res.json.data.results.map((r) => [r.group, r]));
      const sentEntry = res.json.data.results.find((r) => r.sent);
      assert.ok(sentEntry && sentEntry.delivered, 'the active group should report a delivered invite');
      assert.equal(sentEntry.inviteLink, '', 'a delivered link is not echoed back to the browser');
      assert.ok(Object.values(byGroup).some((r) => !r.sent && r.reason === 'no subscription on record'));

      const toStudent = sends.find((s) => s.chatId === '4242');
      assert.equal(toStudent.options.reply_markup.inline_keyboard[0][0].url, 'https://t.me/+fresh');

      const mirrored = sends.find((s) => s.chatId === '-1007777777777');
      assert.ok(mirrored, 'the support chat should hear about it');
      assert.match(mirrored.text, /Resend invite<\/b> from the dashboard · by Test Curator/);
      assert.ok(mirrored.options.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'adm:i:T-260917-AB2C:4242'),
        'a mirrored post carries the admin buttons');

      const appended = calls.find((c) => c.name === 'appendTicketMessage');
      assert.ok(appended, 'the resend should be recorded on the ticket');
      assert.match(appended.args[1].text, /Sent a fresh invite link/);
    });
  } finally {
    membership.resendInvite = originalResend;
    if (savedChat === undefined) delete process.env.SUPPORT_CHAT_ID;
    else process.env.SUPPORT_CHAT_ID = savedChat;
  }
});

test('POST /api/support/resend-invite requires sign-in', async () => {
  const res = await call(`/api/support/resend-invite?group=${TEST_GROUP}`, { method: 'POST', body: { ticketId: 'T-260917-AB2C' } });
  assert.equal(res.status, 401);
});

// ---- The pass and coupons in the payment webhook ---------------------------

test('a paid link grants the promised date and name and counts its coupon once', async () => {
  paymentCalls.length = 0;
  calls.length = 0;
  stub(sheets, 'recordRedemption', { recorded: true, times_used: 1 });
  const body = JSON.stringify({
    event: 'payment_link.paid',
    payload: {
      payment_link: { entity: { id: 'plink_c', notes: {
        telegram_id: '4242', telegram_username: 'asha', plan_id: 'exam_pass', group_id: 'appsc_news_en',
        valid_until: '31-05-2099', plan_label: 'Target APPSC 2026',
        coupon_code: 'SAVE50', original_amount: '199', discount_amount: '50'
      } } },
      payment: { entity: { id: 'pay_coupon1', amount: 14900 } }
    }
  });

  const res = await fetch(baseUrl + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signWebhook(body) },
    body
  });
  assert.equal(res.status, 200);

  assert.equal(paymentCalls.length, 1);
  assert.equal(paymentCalls[0].validUntil, '31-05-2099');
  assert.equal(paymentCalls[0].planLabel, 'Target APPSC 2026');
  assert.equal(paymentCalls[0].amountPaise, 14900, 'the amount actually paid is recorded');

  const redemption = calls.find((c) => c.name === 'recordRedemption');
  assert.ok(redemption, 'the coupon use was not recorded');
  assert.deepEqual(redemption.args[0], {
    code: 'SAVE50', telegram_id: '4242', username: 'asha', group: 'Newspaper · English',
    original_amount: 199, discount: 50, paid_amount: 149, payment_id: 'pay_coupon1'
  });
});

test('a coupon tally that cannot be written never blocks the student\'s access', async () => {
  paymentCalls.length = 0;
  const original = clientStubs.recordRedemption;
  clientStubs.recordRedemption = async () => { throw new Error('Unknown POST action: recordRedemption'); };
  const quiet = console.error;
  console.error = () => {};
  try {
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_d', notes: {
          telegram_id: '4243', plan_id: 'exam_pass', group_id: 'appsc_news_en', coupon_code: 'SAVE50'
        } } },
        payment: { entity: { id: 'pay_coupon2', amount: 14900 } }
      }
    });
    const res = await fetch(baseUrl + '/api/payments/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signWebhook(body) },
      body
    });
    assert.equal(res.status, 200, 'a coupon bookkeeping failure must not make Razorpay retry the grant');
    assert.equal(paymentCalls.length, 1);
  } finally {
    clientStubs.recordRedemption = original;
    console.error = quiet;
  }
});

// ===========================================================================
// Pass & Coupons API
// ===========================================================================

stub(sheets, 'listCoupons', [
  { code: 'SAVE50', discount_type: 'flat', discount_value: 50, active: true, expires_on: '', max_uses: null, times_used: 3, one_per_student: true },
  { code: 'OLD10', discount_type: 'percent', discount_value: 10, active: true, expires_on: '01-01-2020', max_uses: null, times_used: 0, one_per_student: true },
  { code: 'FULL', discount_type: 'flat', discount_value: 20, active: true, expires_on: '', max_uses: 5, times_used: 5, one_per_student: false },
  { code: 'PAUSED', discount_type: 'flat', discount_value: 20, active: false, expires_on: '', max_uses: null, times_used: 0, one_per_student: true }
]);
stub(sheets, 'listRedemptions', { total: 1, redemptions: [{ code: 'SAVE50', telegram_id: '1', paid_amount: 149 }] });
stub(sheets, 'getCoupon', (code) => (code === 'SAVE50' ? { code: 'SAVE50', times_used: 3 } : null));
stub(sheets, 'upsertCoupon', (coupon) => Object.assign({ times_used: 0 }, coupon));
stub(sheets, 'deleteCoupon', (code) => (code === 'UNUSED1' ? { deleted: true }
  : code === 'SAVE50' ? { deleted: false, reason: 'This code has been used 3 time(s). Switch it off instead.' }
    : { deleted: false, reason: 'not found' }));
stub(sheets, 'logTicketEvent', (id) => ({ ticket_id: id }));

test('the pricing routes require sign-in', async () => {
  for (const [method, path] of [['GET', '/api/pricing'], ['POST', '/api/pricing/pass'], ['POST', '/api/pricing/coupon'],
    ['POST', '/api/pricing/coupon/delete'], ['GET', '/api/pricing/redemptions']]) {
    const res = await call(`${path}?group=${TEST_GROUP}`, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path} answered without sign-in`);
  }
});

test('GET /api/pricing shows the pass with admin overrides and each coupon\'s state', async () => {
  const original = clientStubs.getBotSettings;
  clientStubs.getBotSettings = async () => ({ pass_name: 'Target APPSC 2026', pass_price: '249', pass_valid_until: '31-05-2099' });
  try {
    // A group whose pass has an end date. The newspaper groups sell a lifetime
    // pass, where "valid until" is deliberately ignored — see the test below.
    const res = await authed('/api/pricing?group=appsc_q_en');
    assert.equal(res.status, 200);
    const { pass, coupons, redemptions, passSettings } = res.json.data;
    assert.equal(pass.name, 'Target APPSC 2026');
    assert.equal(pass.price, 249);
    assert.equal(pass.priceText, '₹249');
    assert.equal(pass.validUntil, '31-05-2099');
    assert.equal(pass.defaults.price, 199, 'the built-in default is shown alongside');
    assert.equal(passSettings.price, '249');
    assert.deepEqual(coupons.map((c) => [c.code, c.state, c.discountText]), [
      ['SAVE50', 'live', '₹50 off'], ['OLD10', 'expired', '10% off'], ['FULL', 'used_up', '₹20 off'], ['PAUSED', 'off', '₹20 off']
    ]);
    assert.equal(redemptions.total, 1);
  } finally {
    clientStubs.getBotSettings = original;
  }
});

test('POST /api/pricing/pass validates and saves the pass as settings, with the real actor', async () => {
  assert.equal((await authed('/api/pricing/pass', { method: 'POST', body: { price: '0' } })).status, 400);
  assert.equal((await authed('/api/pricing/pass', { method: 'POST', body: { validUntil: '01-01-2020' } })).status, 400);

  calls.length = 0;
  const res = await authed('/api/pricing/pass', {
    method: 'POST', body: { name: 'Target Group 2', price: '199', validUntil: '31-05-2099', description: '' }
  });
  assert.equal(res.status, 200, res.json && res.json.error);
  const saved = calls.find((c) => c.name === 'updateBotSettings');
  assert.deepEqual(saved.args, [
    { pass_name: 'Target Group 2', pass_price: '199', pass_valid_until: '31-05-2099', pass_description: '' },
    'Test Curator (curator@example.com)'
  ]);
});

test('POST /api/pricing/coupon creates, refuses a duplicate create, and validates', async () => {
  assert.equal((await authed('/api/pricing/coupon', { method: 'POST', body: { coupon: { code: 'x y', discount_type: 'flat', discount_value: 10 } } })).status, 400);
  assert.equal((await authed('/api/pricing/coupon', { method: 'POST', body: { coupon: { code: 'BIG', discount_type: 'percent', discount_value: 100 } } })).status, 400);

  const dup = await authed('/api/pricing/coupon', { method: 'POST', body: { mode: 'create', coupon: { code: 'save50', discount_type: 'flat', discount_value: 10 } } });
  assert.equal(dup.status, 409);
  assert.match(dup.json.error, /already exists/);

  calls.length = 0;
  const created = await authed('/api/pricing/coupon', {
    method: 'POST',
    body: { mode: 'create', coupon: { code: 'diwali25', discount_type: 'percent', discount_value: '25', expires_on: '10-11-2099', max_uses: '100' } }
  });
  assert.equal(created.status, 200, created.json && created.json.error);
  const upsert = calls.find((c) => c.name === 'upsertCoupon');
  assert.equal(upsert.args[0].code, 'DIWALI25');
  assert.equal(upsert.args[0].max_uses, 100);
  assert.equal(upsert.args[1], 'Test Curator (curator@example.com)');
  assert.equal(created.json.data.state, 'live');
  assert.equal(created.json.data.discountText, '25% off');

  // Editing an existing code is allowed.
  const edited = await authed('/api/pricing/coupon', { method: 'POST', body: { mode: 'edit', coupon: { code: 'SAVE50', discount_type: 'flat', discount_value: 60, active: false } } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.state, 'off');
});

test('POST /api/pricing/coupon/delete deletes an unused code and explains a refusal', async () => {
  assert.equal((await authed('/api/pricing/coupon/delete', { method: 'POST', body: { code: 'unused1' } })).status, 200);
  const used = await authed('/api/pricing/coupon/delete', { method: 'POST', body: { code: 'SAVE50' } });
  assert.equal(used.status, 409);
  assert.match(used.json.error, /Switch it off/);
  assert.equal((await authed('/api/pricing/coupon/delete', { method: 'POST', body: { code: 'NOPE99' } })).status, 404);
  assert.equal((await authed('/api/pricing/coupon/delete', { method: 'POST', body: { code: '' } })).status, 400);
});

// ---- Support: student details, payment check and grant ---------------------

test('GET /api/support/student reports passes and a suggestion for the ticket\'s student', async () => {
  await withRecordedBot(async () => {
    const originalEligible = membership.isEligible;
    const originalMember = TelegramBotClient.prototype.getChatMember;
    membership.isEligible = async () => ({ ok: true, reason: 'active subscription',
      subscriber: { status: 'active', plan_label: 'Target 2026', expiry_date: '31-05-2099, 11:59:59 PM IST', total_paid: 199, payment_id: 'pay_OLD000000001' } });
    TelegramBotClient.prototype.getChatMember = async () => ({ status: 'left' });
    try {
      assert.equal((await authed('/api/support/student?ticketId=bad')).status, 400);
      const res = await authed('/api/support/student?ticketId=T-260917-AB2C');
      assert.equal(res.status, 200, res.json && res.json.error);
      const first = res.json.data.passes[0];
      assert.equal(first.valid, true);
      assert.equal(first.inGroup, 'no');
      assert.equal(first.paymentId, 'pay_OLD000000001');
      assert.match(res.json.data.suggestion, /not in .* → tap "🔗 Send new invite link"/);
    } finally {
      membership.isEligible = originalEligible;
      TelegramBotClient.prototype.getChatMember = originalMember;
    }
  });
});

test('POST /api/support/check-payment asks Razorpay and logs the check', async () => {
  const razorpayModule = require('../src/razorpay');
  const original = razorpayModule.getPayment;
  razorpayModule.getPayment = async (id) => ({ id, status: 'captured', amount: 19900, method: 'upi', created_at: 1789000000, notes: { telegram_id: '4242' } });
  try {
    await withRecordedBot(async () => {
      assert.equal((await authed('/api/support/check-payment', { method: 'POST', body: { ticketId: 'T-260917-AB2C', paymentId: 'notapay' } })).status, 400);

      calls.length = 0;
      const res = await authed('/api/support/check-payment', { method: 'POST', body: { ticketId: 'T-260917-AB2C', paymentId: 'pay_TZ8ciB8Yng8WE3' } });
      assert.equal(res.status, 200, res.json && res.json.error);
      assert.equal(res.json.data.captured, true);
      assert.equal(res.json.data.payment.amount, '₹199');
      assert.equal(res.json.data.payment.belongsTo, 'this student');
      assert.ok(res.json.data.groups.length >= 1);
      const logged = calls.find((c) => c.name === 'logTicketEvent');
      assert.equal(logged.args[1].action, 'payment_checked');
      assert.equal(logged.args[1].who, 'Test Curator (curator@example.com)');
    });
  } finally {
    razorpayModule.getPayment = original;
  }
});

test('POST /api/support/grant-pass needs a group from the ticket\'s bot and reports the outcome', async () => {
  const razorpayModule = require('../src/razorpay');
  const original = razorpayModule.getPayment;
  razorpayModule.getPayment = async (id) => ({ id, status: 'failed', amount: 19900 });
  try {
    await withRecordedBot(async () => {
      const noGroup = await authed('/api/support/grant-pass', { method: 'POST', body: { ticketId: 'T-260917-AB2C', paymentId: 'pay_TZ8ciB8Yng8WE3', groupId: 'upsc' } });
      assert.equal(noGroup.status, 400, 'a group from another bot must be refused');

      const res = await authed('/api/support/grant-pass', { method: 'POST', body: { ticketId: 'T-260917-AB2C', paymentId: 'pay_TZ8ciB8Yng8WE3', groupId: 'appsc_news_en' } });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.granted, false);
      assert.match(res.json.data.message, /Not granted\. Razorpay does not show this payment as captured/);
    });
  } finally {
    razorpayModule.getPayment = original;
  }
});


// ---- Ticket lifecycle over the API ----------------------------------------

test('reopening from the dashboard always asks the sheet for in_progress', async () => {
  for (const requested of ['open', 'in_progress', 'answered']) {
    calls.length = 0;
    const res = await authed('/api/support/status', { method: 'POST', body: { ticketId: 'T-260917-AB2C', status: requested } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.find((c) => c.name === 'setTicketStatus').args,
      ['T-260917-AB2C', 'in_progress', 'Test Curator (curator@example.com)'], `"${requested}" was not mapped to in_progress`);
  }
});

test('closing a ticket that was already closed does not message the student again', async () => {
  const original = clientStubs.setTicketStatus;
  clientStubs.setTicketStatus = async (id) => Object.assign({}, SAMPLE_TICKET, { ticket_id: id, status: 'closed', previous_status: 'closed' });
  try {
    await withRecordedBot(async (sends) => {
      const res = await authed('/api/support/status', { method: 'POST', body: { ticketId: 'T-260917-AB2C', status: 'closed' } });
      assert.equal(res.status, 200);
      assert.equal(res.json.changed, false);
      assert.equal(res.json.notified, false);
      assert.equal(sends.filter((m) => m.chatId === '4242').length, 0);
    });
  } finally {
    clientStubs.setTicketStatus = original;
  }
});

test('GET /api/support/tickets passes the queue filters and drops anything else', async () => {
  calls.length = 0;
  await authed('/api/support/tickets?status=answered&waitingOn=admin&sort=waiting');
  let forwarded = calls.find((c) => c.name === 'listTickets').args[0];
  assert.equal(forwarded.status, 'in_progress');
  assert.equal(forwarded.waitingOn, 'admin');
  assert.equal(forwarded.sort, 'waiting');

  calls.length = 0;
  await authed('/api/support/tickets?status=deleted&waitingOn=everyone&sort=random');
  forwarded = calls.find((c) => c.name === 'listTickets').args[0];
  assert.equal(forwarded.status, '');
  assert.equal(forwarded.waitingOn, '');
  assert.equal(forwarded.sort, '');
});

test('GET /api/support/stats returns the sheet\'s analysis for the chosen period', async () => {
  stub(sheets, 'getSupportStats', (opts) => ({ period_days: Number(opts.days), counts: { needs_reply: 2 } }));
  calls.length = 0;
  const res = await authed('/api/support/stats?days=7');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.period_days, 7);
  assert.equal(res.json.data.counts.needs_reply, 2);
  assert.ok(res.json.data.context);

  await authed('/api/support/stats?days=abc');
  assert.equal(calls.filter((c) => c.name === 'getSupportStats').at(-1).args[0].days, '30');
  assert.equal((await call(`/api/support/stats?group=${TEST_GROUP}`)).status, 401);
});

// ---- Rate limiting ----------------------------------------------------------

test('signed webhooks are never rate limited, so a busy minute cannot drop a payment', async () => {
  // Back to a real ceiling: with the suite-wide limit in force, 260 requests
  // would prove nothing about whether the exemption is there.
  const limit = process.env.RATE_LIMIT_MAX;
  process.env.RATE_LIMIT_MAX = '240';
  test.after(() => { process.env.RATE_LIMIT_MAX = limit; });

  const statuses = new Set();
  const body = JSON.stringify({ event: 'noop' });
  const requests = [];
  for (let i = 0; i < 260; i++) {
    requests.push(fetch(baseUrl + '/api/payments/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'bad' }, body
    }).then((r) => statuses.add(r.status)));
  }
  await Promise.all(requests);
  assert.ok(!statuses.has(429), 'the payment webhook was rate limited');
  assert.ok(statuses.has(401));
});

test('the scheduled routes are never rate limited, so a run is never silently skipped', async () => {
  // A 429 to Vercel Cron is not a retry — that run simply does not happen, and
  // nothing says why. Each of these is refused without CRON_SECRET anyway, so
  // the limiter is not what is protecting them.
  const original = process.env.CRON_SECRET;
  const limit = process.env.RATE_LIMIT_MAX;
  process.env.CRON_SECRET = 'cron-secret';
  process.env.RATE_LIMIT_MAX = '240';
  const statuses = new Set();

  try {
    const requests = [];
    for (const route of ['/api/cron/sweep', '/api/cron/autopilot', '/api/cron/reconcile']) {
      for (let i = 0; i < 120; i++) {
        requests.push(fetch(baseUrl + route, {
          method: 'POST', headers: { Authorization: 'Bearer wrong' }
        }).then((r) => statuses.add(r.status)));
      }
    }
    await Promise.all(requests);

    assert.ok(!statuses.has(429), 'a scheduled route was rate limited');
    assert.ok(statuses.has(401), 'and the wrong secret is still refused');
  } finally {
    process.env.RATE_LIMIT_MAX = limit;
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test('behind Vercel the client address comes from the platform headers, elsewhere from the socket', () => {
  const req = { headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } };
  const saved = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    assert.equal(server.clientAddress(req), '10.0.0.1', 'headers must not be trusted outside Vercel');
    process.env.VERCEL = '1';
    assert.equal(server.clientAddress(req), '203.0.113.9');
    assert.equal(server.clientAddress({ headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }, socket: {} }), '198.51.100.1');
  } finally {
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  }
});

test('the daily job posts a support summary to each bot\'s support chat, and can be switched off', async () => {
  const before = { secret: process.env.CRON_SECRET, chat: process.env.SUPPORT_CHAT_ID, daily: process.env.SUPPORT_DAILY_SUMMARY };
  process.env.CRON_SECRET = 'a-secret-for-tests';
  process.env.SUPPORT_CHAT_ID = '-1007777777777';
  const membershipModule = require('../src/membership');
  const originalSweep = membershipModule.runDailyCheckAllGroups;
  membershipModule.runDailyCheckAllGroups = async () => ({ groups: [], totals: { reminded: 0, removed: 0 } });
  stub(sheets, 'getSupportStats', { period_days: 7, counts: { needs_reply: 3, open: 1, in_progress: 2, closed: 5, total: 8 }, by_category: {}, by_admin: {} });
  try {
    await withRecordedBot(async (sends) => {
      delete process.env.SUPPORT_DAILY_SUMMARY;
      const res = await call('/api/cron/sweep', { method: 'POST', headers: { Authorization: 'Bearer a-secret-for-tests' } });
      assert.equal(res.status, 200);
      const posted = sends.filter((m) => m.chatId === '-1007777777777');
      assert.ok(posted.length >= 1, 'no summary reached the support chat');
      assert.match(posted[0].text, /support summary[\s\S]*Needs reply: <b>3<\/b>/);
      assert.ok(res.json.data.supportSummaries.every((r) => r.posted));

      sends.length = 0;
      process.env.SUPPORT_DAILY_SUMMARY = 'off';
      const off = await call('/api/cron/sweep', { method: 'POST', headers: { Authorization: 'Bearer a-secret-for-tests' } });
      assert.equal(off.status, 200);
      assert.equal(sends.length, 0);
    });
  } finally {
    membershipModule.runDailyCheckAllGroups = originalSweep;
    for (const [key, env] of [['secret', 'CRON_SECRET'], ['chat', 'SUPPORT_CHAT_ID'], ['daily', 'SUPPORT_DAILY_SUMMARY']]) {
      if (before[key] === undefined) delete process.env[env];
      else process.env[env] = before[key];
    }
  }
});

// ===========================================================================
// Taking questions back out of the queue
// ===========================================================================

test('unqueue restores the status and reports the ids it could not find', async () => {
  calls.length = 0;
  const res = await authed('/api/questions/unschedule', {
    method: 'POST', body: { subject: 'Polity', questionIds: ['POL-1', 'POL-2'] }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.updatedCount, 3);
  // A count on its own cannot tell an id that is not in the tab from a row the
  // poster is holding, which is what made "0 question(s) queued" unexplainable.
  assert.deepEqual(res.json.notFound, ['POL-9']);

  const [subject, ids, status, actor] = calls.find((c) => c.name === 'unscheduleQuestions').args;
  assert.equal(subject, 'Polity');
  assert.deepEqual(ids, ['POL-1', 'POL-2']);
  assert.equal(status, 'Approved', 'a question ready enough to queue is still ready');
  assert.match(actor, /curator@example\.com/, 'the sheet records who did it, from the token');
});

test('unqueue passes through a status the curator chose', async () => {
  calls.length = 0;
  await authed('/api/questions/unschedule', {
    method: 'POST', body: { subject: 'Polity', questionIds: ['POL-1'], status: 'Draft' }
  });
  assert.equal(calls.find((c) => c.name === 'unscheduleQuestions').args[2], 'Draft');
});

test('unqueue refuses an empty, oversized or subject-less selection', async () => {
  const empty = await authed('/api/questions/unschedule', {
    method: 'POST', body: { subject: 'Polity', questionIds: [] }
  });
  assert.equal(empty.status, 400);

  const tooMany = await authed('/api/questions/unschedule', {
    method: 'POST',
    body: { subject: 'Polity', questionIds: Array.from({ length: 201 }, (_, i) => `POL-${i}`) }
  });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.json.error, /max 200/);

  const noSubject = await authed('/api/questions/unschedule', {
    method: 'POST', body: { questionIds: ['POL-1'] }
  });
  assert.equal(noSubject.status, 400);
});

test('queueing answers with what it skipped as well as what it changed', async () => {
  const original = clientStubs.scheduleQuestions;
  clientStubs.scheduleQuestions = async () => ({
    updatedCount: 1, notFound: ['POL-404'],
    skipped: [{ questionId: 'POL-2', row: 3, reason: 'already posted' }]
  });
  try {
    const res = await authed('/api/questions/schedule', {
      method: 'POST', body: { subject: 'Polity', questionIds: ['POL-1', 'POL-2', 'POL-404'] }
    });
    assert.equal(res.json.updatedCount, 1);
    assert.deepEqual(res.json.notFound, ['POL-404']);
    assert.equal(res.json.skipped[0].reason, 'already posted');
  } finally {
    clientStubs.scheduleQuestions = original;
  }
});

// ===========================================================================
// Autopilot
// ===========================================================================

/** Stops whatever a test started, so the next one begins from nothing. */
async function stopAutopilot(subject) {
  await authed('/api/automation/autopilot/stop', { method: 'POST', body: { subject } });
}

test('autopilot starts, reports itself, and stops', async () => {
  const started = await authed('/api/automation/autopilot', {
    method: 'POST',
    body: { subject: 'Polity', intervalMinutes: 5, batchSize: 20, reconcileEveryRuns: 5 }
  });

  try {
    assert.equal(started.status, 200);
    assert.equal(started.json.data.running, true);
    assert.equal(started.json.data.settings.intervalMinutes, 5);
    assert.equal(started.json.data.settings.batchSize, 20);
    assert.match(started.json.data.startedBy, /curator@example\.com/);

    const listed = await authed('/api/automation/autopilot');
    const job = listed.json.data.jobs.find((j) => j.subject === 'Polity');
    assert.ok(job, 'the job it just started is not in the list');
    assert.equal(listed.json.data.maxBatch, 20);
    assert.equal(typeof listed.json.data.persistent, 'boolean');

    const stopped = await authed('/api/automation/autopilot/stop', {
      method: 'POST', body: { subject: 'Polity' }
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.data.running, false);
    assert.match(stopped.json.data.stoppedReason, /curator@example\.com/);
  } finally {
    await stopAutopilot('Polity');
  }
});

test('autopilot clamps a batch larger than one request may post', async () => {
  try {
    const res = await authed('/api/automation/autopilot', {
      method: 'POST', body: { subject: 'Polity', intervalMinutes: 5, batchSize: 5000 }
    });
    assert.equal(res.json.data.settings.batchSize, 20);
  } finally {
    await stopAutopilot('Polity');
  }
});

test('autopilot refuses a subject that is not in the configured list', async () => {
  const res = await authed('/api/automation/autopilot', {
    method: 'POST', body: { subject: '../../etc/passwd', intervalMinutes: 5, batchSize: 1 }
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.success, false);
});

test('stopping a job that is not running says so rather than pretending', async () => {
  const res = await authed('/api/automation/autopilot/stop', {
    method: 'POST', body: { subject: 'History' }
  });
  assert.equal(res.status, 404);
  assert.match(res.json.error, /Nothing is running/);
});

test('one group never sees another group\'s autopilot jobs', async () => {
  await authed('/api/automation/autopilot', {
    method: 'POST', body: { subject: 'Polity', intervalMinutes: 60, batchSize: 1 }
  });
  try {
    const other = await call(`/api/automation/autopilot?group=appsc_q_en`, { token: 'valid-token' });
    assert.equal(other.status, 200);
    assert.equal(other.json.data.jobs.length, 0,
      'another group\'s job is not this curator\'s business');
  } finally {
    await stopAutopilot('Polity');
  }
});

// ===========================================================================
// Scheduled routes
// ===========================================================================

test('the autopilot and deleted-poll crons refuse an unauthorised caller', async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  try {
    for (const route of ['/api/cron/autopilot', '/api/cron/reconcile']) {
      const none = await call(route, { method: 'POST' });
      assert.equal(none.status, 401, `${route} ran without a secret`);

      const wrong = await call(route, {
        method: 'POST', headers: { Authorization: 'Bearer nope' }
      });
      assert.equal(wrong.status, 401, `${route} accepted the wrong secret`);
    }
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test('the scheduled routes refuse to run at all when no secret is set', async () => {
  const original = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    for (const route of ['/api/cron/autopilot', '/api/cron/reconcile', '/api/cron/sweep']) {
      const res = await call(route, { method: 'POST' });
      assert.equal(res.status, 503, `${route} ran with no secret configured`);
      assert.match(res.json.error, /CRON_SECRET/);
    }
  } finally {
    if (original !== undefined) process.env.CRON_SECRET = original;
  }
});

test('the autopilot cron runs the due jobs and reports them', async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  const cron = { method: 'POST', headers: { Authorization: 'Bearer cron-secret' } };

  try {
    // Every 12 hours, so only the immediate first run is ever due here.
    await authed('/api/automation/autopilot', {
      method: 'POST', body: { subject: 'Polity', intervalMinutes: 720, batchSize: 1 }
    });

    const first = await call('/api/cron/autopilot', cron);
    assert.equal(first.status, 200);
    assert.equal(first.json.data.ran.length, 1);
    assert.equal(first.json.data.ran[0].subject, 'Polity');
    assert.equal(first.json.data.ran[0].run.posted, 1, 'the stubbed batch posted its one question');

    const second = await call('/api/cron/autopilot', cron);
    assert.equal(second.json.data.ran.length, 0, 'the next run is not due for twelve hours');
  } finally {
    await stopAutopilot('Polity');
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test('the deleted-poll cron marks questions Deleted across every ready group', async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  const originalPosted = clientStubs.listPosted;
  const originalUnpost = clientStubs.unpostQuestions;
  const originalExists = telegram.pollStillExists;

  const originalMark = clientStubs.markDeleted;
  clientStubs.listPosted = async () => ([
    { row: 4, question_id: 'POL-4', message_id: '904', status: 'Posted' }
  ]);
  telegram.pollStillExists = async () => false;
  const unposted = [];
  const markedRows = [];
  clientStubs.unpostQuestions = async (...args) => { unposted.push(args); return 1; };
  clientStubs.markDeleted = async (...args) => { markedRows.push(args); return 1; };

  try {
    const res = await call('/api/cron/reconcile', {
      method: 'POST', headers: { Authorization: 'Bearer cron-secret' }
    });

    assert.equal(res.status, 200);
    assert.ok(res.json.data.marked >= 1, 'a deleted poll was not marked Deleted');
    assert.ok(markedRows.length >= 1);
    assert.deepEqual(markedRows[0][1], [4]);
    assert.match(markedRows[0][2], /Deleted from the Telegram group/);
    // The unattended path must never put a question back on its own: it would
    // be posted again within the interval, with nobody watching.
    assert.equal(unposted.length, 0, 'the nightly sweep re-queued a deleted question');
  } finally {
    clientStubs.listPosted = originalPosted;
    clientStubs.unpostQuestions = originalUnpost;
    clientStubs.markDeleted = originalMark;
    telegram.pollStillExists = originalExists;
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test('a partial deleted-poll sweep says how much is left rather than implying it checked everything', async () => {
  const originalPosted = clientStubs.listPosted;
  const originalExists = telegram.pollStillExists;
  clientStubs.listPosted = async () => Array.from({ length: 6 }, (_, i) => ({
    row: i + 2, question_id: `POL-${i}`, message_id: String(900 + i), status: 'Posted'
  }));
  const asked = [];
  telegram.pollStillExists = async (messageId) => { asked.push(String(messageId)); return true; };

  try {
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity', limit: 2 }
    });
    assert.equal(res.json.checked, 2);
    assert.equal(res.json.totalPosted, 6);
    assert.equal(res.json.complete, false);
    assert.match(res.json.message, /4 more will be checked on the next pass/);
    assert.deepEqual(asked, ['900', '901']);

    // Each later pass continues where the last one stopped. Without the
    // cursor, every automatic sweep re-checked these same first rows for ever
    // and the newest posts — the ones most likely to have just been deleted —
    // were never reached at all.
    asked.length = 0;
    await authed('/api/telegram/reconcile', { method: 'POST', body: { subject: 'Polity', limit: 2 } });
    assert.deepEqual(asked, ['902', '903']);

    asked.length = 0;
    const last = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity', limit: 2 }
    });
    assert.deepEqual(asked, ['904', '905']);

    // Having reached the end, the next pass starts again from the top.
    asked.length = 0;
    await authed('/api/telegram/reconcile', { method: 'POST', body: { subject: 'Polity', limit: 2 } });
    assert.deepEqual(asked, ['900', '901']);
    assert.equal(last.json.checked, 2);
  } finally {
    clientStubs.listPosted = originalPosted;
    telegram.pollStillExists = originalExists;
  }
});

// ===========================================================================
// Repairing a tab's formatting
// ===========================================================================
// Rows appended through the Sheets API inherit the formatting of the row above
// them, and the row above the first upload is the header. Sheets filled before
// that was fixed are bold white on navy from top to bottom.

test('repairing formatting covers every subject in the group', async () => {
  calls.length = 0;
  const res = await authed('/api/questions/format', {
    method: 'POST', body: { allSubjects: true }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.formattedCount, 1, 'the stubbed Config tab holds one subject');
  assert.deepEqual(res.json.results, [{ subject: 'Polity', ok: true, rows: 12 }]);
  assert.equal(calls.filter((c) => c.name === 'formatQuestions').length, 1);
});

test('repairing one subject validates it like every other route', async () => {
  const ok = await authed('/api/questions/format', {
    method: 'POST', body: { subject: 'Polity' }
  });
  assert.equal(ok.json.formattedCount, 1);

  const bad = await authed('/api/questions/format', {
    method: 'POST', body: { subject: '../../etc/passwd' }
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.success, false);
});

test('one tab that cannot be repaired does not abandon the others', async () => {
  // A curator asking for the whole group wants every tab it could reach fixed,
  // not the run stopped at the first missing one.
  const originalConfig = clientStubs.readConfig;
  const originalFormat = clientStubs.formatQuestions;
  clientStubs.readConfig = async () => ([
    { subject: 'Polity' }, { subject: 'History' }, { subject: 'Geography' }
  ]);
  clientStubs.formatQuestions = async (subject) => {
    if (subject === 'History') throw new Error('Sheet tab "History" not found.\nSecond line');
    return { subject, rows: 4 };
  };

  try {
    const res = await authed('/api/questions/format', {
      method: 'POST', body: { allSubjects: true }
    });

    assert.equal(res.status, 200, 'one missing tab must not fail the whole request');
    assert.equal(res.json.formattedCount, 2);
    const failed = res.json.results.find((r) => !r.ok);
    assert.equal(failed.subject, 'History');
    assert.equal(failed.error, 'Sheet tab "History" not found.', 'only the first line reaches the browser');
    assert.match(res.json.message, /2 of 3/);
  } finally {
    clientStubs.readConfig = originalConfig;
    clientStubs.formatQuestions = originalFormat;
  }
});

test('repairing a group with no configured subjects says so', async () => {
  const original = clientStubs.readConfig;
  clientStubs.readConfig = async () => [];
  try {
    const res = await authed('/api/questions/format', {
      method: 'POST', body: { allSubjects: true }
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /No subjects are configured/);
  } finally {
    clientStubs.readConfig = original;
  }
});

// ===========================================================================
// Deleting a question in Telegram, reflected in the sheet
// ===========================================================================

/** A subject with `n` posted questions, and control over which polls survive. */
function postedChannel(gone = []) {
  const restore = {
    listPosted: clientStubs.listPosted,
    markDeleted: clientStubs.markDeleted,
    unpostQuestions: clientStubs.unpostQuestions,
    pollStillExists: telegram.pollStillExists
  };
  const marked = [];
  const unposted = [];

  clientStubs.listPosted = async () => ([
    { row: 2, question_id: 'POL-1', message_id: '901', status: 'Posted' },
    { row: 3, question_id: 'POL-2', message_id: '902', status: 'Posted' },
    { row: 4, question_id: 'POL-3', message_id: '903', status: 'Posted' }
  ]);
  telegram.pollStillExists = async (id) => !gone.includes(String(id));
  clientStubs.markDeleted = async (...args) => { marked.push(args); return args[1].length; };
  clientStubs.unpostQuestions = async (...args) => { unposted.push(args); return args[1].length; };

  return {
    marked,
    unposted,
    done: () => Object.assign(clientStubs, {
      listPosted: restore.listPosted,
      markDeleted: restore.markDeleted,
      unpostQuestions: restore.unpostQuestions
    }) && (telegram.pollStillExists = restore.pollStillExists)
  };
}

test('a question deleted in Telegram is marked Deleted in the sheet', async () => {
  const channel = postedChannel(['902']);
  try {
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity', apply: true }
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.action, 'mark', 'marking is the default');
    assert.equal(res.json.marked, 1);
    assert.equal(res.json.restored, 0);

    assert.equal(channel.marked.length, 1);
    const [subject, rows, note] = channel.marked[0];
    assert.equal(subject, 'Polity');
    assert.deepEqual(rows, [3], 'only the row whose poll is gone');
    assert.match(note, /no longer there/);
    assert.match(note, /curator@example\.com/, 'the sheet records who noticed');

    assert.equal(channel.unposted.length, 0, 'marking must not also re-queue');
    assert.match(res.json.message, /will be posted again/);
  } finally {
    channel.done();
  }
});

test('marking is what happens unless re-queueing is asked for by name', async () => {
  // The old default put the question back as Approved, so a poll a curator
  // had deliberately deleted went out again on the very next run.
  const channel = postedChannel(['903']);
  try {
    for (const action of [undefined, '', 'nonsense', 'mark']) {
      channel.marked.length = 0;
      await authed('/api/telegram/reconcile', {
        method: 'POST', body: { subject: 'Polity', apply: true, action }
      });
      assert.equal(channel.marked.length, 1, `action ${JSON.stringify(action)} did not mark`);
    }
    assert.equal(channel.unposted.length, 0);
  } finally {
    channel.done();
  }
});

test('re-queueing stays available for a poll deleted by accident', async () => {
  const channel = postedChannel(['901']);
  try {
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity', apply: true, action: 'requeue' }
    });

    assert.equal(res.json.action, 'requeue');
    assert.equal(res.json.restored, 1);
    assert.equal(res.json.marked, 0);
    assert.deepEqual(channel.unposted[0][1], [2]);
    assert.equal(channel.unposted[0][2], 'Approved');
    assert.equal(channel.marked.length, 0);
  } finally {
    channel.done();
  }
});

test('a check that is only looking writes nothing either way', async () => {
  const channel = postedChannel(['901', '902']);
  try {
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity' }
    });

    assert.equal(res.json.applied, false);
    assert.equal(res.json.missing.length, 2);
    assert.equal(res.json.marked, 0);
    assert.equal(channel.marked.length, 0);
    assert.equal(channel.unposted.length, 0);
  } finally {
    channel.done();
  }
});

test('a poll Telegram will not answer about is never marked Deleted', async () => {
  // Guessing "deleted" would retire a question that is live in the channel.
  const restore = {
    listPosted: clientStubs.listPosted,
    markDeleted: clientStubs.markDeleted,
    exists: telegram.pollStillExists
  };
  const marked = [];
  clientStubs.listPosted = async () => ([
    { row: 2, question_id: 'POL-1', message_id: '901', status: 'Posted' }
  ]);
  telegram.pollStillExists = async () => null;
  clientStubs.markDeleted = async (...args) => { marked.push(args); return 1; };

  try {
    const res = await authed('/api/telegram/reconcile', {
      method: 'POST', body: { subject: 'Polity', apply: true }
    });
    assert.deepEqual(res.json.unknown, ['POL-1']);
    assert.equal(res.json.marked, 0);
    assert.equal(marked.length, 0);
  } finally {
    clientStubs.listPosted = restore.listPosted;
    clientStubs.markDeleted = restore.markDeleted;
    telegram.pollStillExists = restore.exists;
  }
});

test('the autopilot check marks and never re-queues, because nobody is watching', async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  const channel = postedChannel(['902']);

  try {
    // reconcileEveryRuns: 1 — the check runs on the very first batch.
    await authed('/api/automation/autopilot', {
      method: 'POST',
      body: { subject: 'Polity', intervalMinutes: 720, batchSize: 1, reconcileEveryRuns: 1 }
    });

    const res = await call('/api/cron/autopilot', {
      method: 'POST', headers: { Authorization: 'Bearer cron-secret' }
    });

    assert.equal(res.json.data.ran.length, 1);
    assert.equal(res.json.data.ran[0].run.deleted, 1, 'the run did not record the deletion');
    assert.equal(channel.marked.length, 1);
    assert.equal(channel.unposted.length, 0,
      'an unattended run put a deliberately deleted question back in the queue');
  } finally {
    await authed('/api/automation/autopilot/stop', { method: 'POST', body: { subject: 'Polity' } });
    channel.done();
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

// ===========================================================================
// Referrals — the admin side
// ===========================================================================

test('the referrals page gets every code, every join, and what is owed', async () => {
  const res = await authed('/api/referrals');
  assert.equal(res.status, 200);
  const data = res.json.data;

  // The scheme, so the page can state the terms rather than hardcode them.
  assert.equal(data.settings.discountPercent, 10);
  assert.equal(data.settings.commissionPercent, 20);
  assert.equal(data.settings.payoutThresholdPaise, 100000);

  // Each code with its own standing, worked out the same way the bot does it.
  const asha = data.codes.find((c) => c.code === 'REFAJMXPQ');
  assert.equal(asha.joined, 2);
  assert.equal(asha.pendingPaise, 3582);
  assert.equal(asha.paidPaise, 3582);
  assert.equal(asha.totalPaise, 7164);
  assert.equal(asha.payable, false, '₹35.82 is under the ₹1000 threshold');

  // A cancelled earning is neither money nor a join.
  const ravi = data.codes.find((c) => c.code === 'REFWMXD9N');
  assert.equal(ravi.joined, 0);
  assert.equal(ravi.totalPaise, 0);
  assert.equal(ravi.status, 'disabled');

  // The whole picture, for the tiles.
  assert.equal(data.totals.joined, 2);
  assert.equal(data.totals.revenuePaise, 35820);
  assert.equal(data.totals.discountPaise, 3980);
  assert.equal(data.totals.pendingPaise, 3582);
  assert.equal(data.totals.paidPaise, 3582);
});

test('who joined using whose code is answered by Telegram id, not by handle', async () => {
  // A handle can be changed; an id cannot. "Who invited whom" has to survive
  // somebody renaming themselves.
  const res = await authed('/api/referrals');
  const joins = res.json.data.earnings;

  assert.equal(joins.length, 3);
  const first = joins.find((e) => e.payment_id === 'pay_1');
  assert.equal(first.referrer_telegram_id, '111');
  assert.equal(first.referred_telegram_id, '333');
  assert.equal(first.commission_paise, 3582);
  // Newest first: the question is almost always "who joined just now".
  assert.equal(joins[0].payment_id, 'pay_3');
});

test('a payout run names the exact payments it would close', async () => {
  const res = await authed('/api/referrals');
  // Nothing is over ₹1000 here, so nothing is due — which is the point: the
  // page must not offer to settle a balance that has not reached the bar.
  assert.deepEqual(res.json.data.due, []);
});

test('settling records that a payout was made, and who recorded it', async () => {
  calls.length = 0;
  const res = await authed('/api/referrals/settle', {
    method: 'POST', body: { code: 'REFAJMXPQ', paymentIds: ['pay_1'] }
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.settled, 1);
  assert.match(res.json.message, /₹35\.82/);

  const [code, ids, note] = calls.find((c) => c.name === 'settleReferralEarnings').args;
  assert.equal(code, 'REFAJMXPQ');
  // The payments the admin was looking at, so one recorded in between is not
  // silently closed with them.
  assert.deepEqual(ids, ['pay_1']);
  assert.match(note, /curator@example\.com/);
});

test('settling refuses anything that is not a referral code', async () => {
  for (const code of ['', 'NOTACODE', 'REF123', '../../etc/passwd', 'SAVE20']) {
    const res = await authed('/api/referrals/settle', { method: 'POST', body: { code } });
    assert.equal(res.status, 400, `"${code}" was accepted as a referral code`);
  }
});

test('a code can be switched off and back on', async () => {
  calls.length = 0;
  const off = await authed('/api/referrals/status', {
    method: 'POST', body: { code: 'REFAJMXPQ', status: 'disabled' }
  });
  assert.equal(off.status, 200);
  assert.equal(off.json.status, 'disabled');
  assert.deepEqual(calls.find((c) => c.name === 'setReferralStatus').args, ['REFAJMXPQ', 'disabled']);

  calls.length = 0;
  await authed('/api/referrals/status', { method: 'POST', body: { code: 'REFAJMXPQ', status: 'active' } });
  assert.equal(calls.find((c) => c.name === 'setReferralStatus').args[1], 'active');

  // Anything that is not "disabled" means active, rather than writing a status
  // nothing else in the system understands.
  calls.length = 0;
  await authed('/api/referrals/status', { method: 'POST', body: { code: 'REFAJMXPQ', status: 'banana' } });
  assert.equal(calls.find((c) => c.name === 'setReferralStatus').args[1], 'active');
});

test('a code that is not in the sheet cannot be switched off', async () => {
  const original = clientStubs.setReferralStatus;
  clientStubs.setReferralStatus = async () => 0;
  try {
    const res = await authed('/api/referrals/status', {
      method: 'POST', body: { code: 'REFWMXD9N', status: 'disabled' }
    });
    assert.equal(res.status, 404);
    assert.match(res.json.error, /not in the sheet/);
  } finally {
    clientStubs.setReferralStatus = original;
  }
});

test('a member over the threshold shows as due, with their payments listed', async () => {
  const original = clientStubs.listReferralEarnings;
  clientStubs.listReferralEarnings = async () => ([
    { code: 'REFAJMXPQ', referrer_telegram_id: '111', referrer_username: 'asha',
      referred_telegram_id: '333', payment_id: 'pay_1', paid_paise: 17910,
      discount_paise: 1990, commission_paise: 60000, status: 'pending' },
    { code: 'REFAJMXPQ', referrer_telegram_id: '111', referrer_username: 'asha',
      referred_telegram_id: '444', payment_id: 'pay_2', paid_paise: 17910,
      discount_paise: 1990, commission_paise: 60000, status: 'pending' }
  ]);
  try {
    const res = await authed('/api/referrals');
    const due = res.json.data.due;
    assert.equal(due.length, 1);
    assert.equal(due[0].code, 'REFAJMXPQ');
    assert.equal(due[0].pendingPaise, 120000);
    assert.equal(due[0].count, 2);
    assert.deepEqual(due[0].paymentIds, ['pay_1', 'pay_2']);
  } finally {
    clientStubs.listReferralEarnings = original;
  }
});

test('the Pass & Coupons page is told when a pass is lifetime, and has no end date to show', async () => {
  // The newspaper groups (TEST_GROUP is one) sell a lifetime pass. Without
  // `lifetime` the page would offer a "Valid until" box that does nothing.
  const original = clientStubs.getBotSettings;
  clientStubs.getBotSettings = async () => ({ pass_valid_until: '31-05-2099' });
  try {
    const news = await authed('/api/pricing');
    assert.equal(news.json.data.pass.lifetime, true);
    assert.equal(news.json.data.pass.validUntil, '', 'a stored end date leaked onto a lifetime pass');

    const exam = await authed('/api/pricing?group=appsc_q_en');
    assert.equal(exam.json.data.pass.lifetime, false);
    assert.equal(exam.json.data.pass.validUntil, '31-05-2099');
  } finally {
    clientStubs.getBotSettings = original;
  }
});

// ===========================================================================
// Analytics lists subjects only; referrals show every person
// ===========================================================================

test('Analytics never shows the referral tabs as subjects', async () => {
  const original = clientStubs.getAnalytics;
  clientStubs.getAnalytics = async () => ({
    totals: { total: 10, subjects: 3, emptySubjects: 2, activeSubjects: 1, lowStockSubjects: 0 },
    subjects: [
      { subject: 'Polity', total: 10, pending: 10, active: true },
      { subject: 'Referrals', total: 0, pending: 0, active: false },
      { subject: 'Referral Log', total: 0, pending: 0, active: false }
    ]
  });
  try {
    const res = await authed('/api/analytics');
    assert.deepEqual(res.json.data.subjects.map((s) => s.subject), ['Polity']);
    assert.equal(res.json.data.totals.subjects, 1, 'the headline still counts the referral tabs');
    assert.equal(res.json.data.totals.emptySubjects, 0);
    assert.equal(res.json.data.totals.total, 10, 'question totals must not change');
  } finally {
    clientStubs.getAnalytics = original;
  }
});

test('each referrer carries everyone who joined and everyone who opened the link', async () => {
  const original = clientStubs.listReferrals;
  clientStubs.listReferrals = async () => ([{
    code: 'REFAJMXPQ', telegram_id: '111', username: 'asha', name: 'Asha K', status: 'active',
    opened_by_ids: '333, 999', share_link: 'https://t.me/x?start=ref_REFAJMXPQ'
  }]);
  try {
    const res = await authed('/api/referrals');
    const asha = res.json.data.codes[0];
    assert.equal(asha.linkOpens, 2);
    assert.deepEqual(asha.openedBy, [{ telegramId: '333', joined: true }, { telegramId: '999', joined: false }]);
    assert.equal(asha.joins.length, 2);
    assert.deepEqual(asha.joins.map((j) => j.telegramId), ['333', '444']);
    assert.equal(asha.joins[0].paymentId, 'pay_1');
    assert.equal(asha.shareLink, 'https://t.me/x?start=ref_REFAJMXPQ');
    assert.equal(res.json.data.totals.linkOpens, 2);
  } finally {
    clientStubs.listReferrals = original;
  }
});

test('the sheet summaries can be rebuilt from the dashboard', async () => {
  const res = await authed('/api/referrals/rebuild', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.json.rebuilt, 2);
});
