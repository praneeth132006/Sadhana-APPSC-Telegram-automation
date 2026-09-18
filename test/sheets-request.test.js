// ============================================================================
// Apps Script transport (src/sheets.js request layer)
// ============================================================================
// Apps Script answers a good request with a 404 from its redirect host, a 5xx
// or a timeout often enough that the dashboards showed "404" on a normal day.
// These pin what is retried, what never is (a write that may already have
// run), and the short read cache that keeps page loads from re-reading the
// whole sheet every time.
// ============================================================================

process.env.SHEET_RETRY_DELAY_MS = '0';

const test = require('node:test');
const assert = require('node:assert');
const sheets = require('../src/sheets');

const EXEC = 'https://script.google.com/macros/s/TEST/exec';
const ECHO = 'https://script.googleusercontent.com/macros/echo?user_content_key=k';

/** A fetch Response-alike. */
function reply(status, body = '', location = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
    text: async () => body
  };
}

const ok = (data) => reply(200, JSON.stringify({ success: true, data }));

/**
 * Installs a fake fetch driven by a script of replies. Each exec call takes the
 * next scripted outcome; 'redirect' goes via the echo host, which then gives
 * the scripted echo reply.
 */
function fakeGoogle(script) {
  const calls = [];
  let n = 0;
  let pendingEcho = null;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).startsWith(ECHO)) {
      const r = pendingEcho; pendingEcho = null; return r;
    }
    const step = script[Math.min(n++, script.length - 1)];
    if (step.echo) { pendingEcho = step.echo; return reply(302, '', ECHO); }
    if (step.throws) throw step.throws;
    return step.exec;
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; sheets.clearReadCache(); });

let seq = 0;
/** A fresh sheet per test so the read cache never leaks between them. */
const ctx = () => ({ url: EXEC.replace('TEST', 'T' + (++seq)), token: 't' });

test('a read that meets Google\'s intermittent 404 is retried and succeeds', async () => {
  const calls = fakeGoogle([{ echo: reply(404, 'Not Found') }, { echo: ok(['Polity']) }]);
  const subjects = await sheets._getSubjects(ctx());
  assert.deepEqual(subjects, ['Polity']);
  assert.equal(calls.filter((c) => !c.url.startsWith(ECHO)).length, 2);
});

test('a read that keeps failing says what happened, not just "404"', async () => {
  fakeGoogle([{ echo: reply(404) }]);
  await assert.rejects(sheets._getSubjects(ctx()), /404 Not Found \(tried 3 times\).*overloaded/);
});

test('a write whose script already ran is never sent twice', async () => {
  // /exec answered with its redirect, so the script executed; only fetching
  // the answer failed. Sending again could post or mark a row twice.
  const calls = fakeGoogle([{ echo: reply(404) }, { echo: ok(null) }]);
  await assert.rejects(sheets._markAsPosted(ctx(), 'Polity', [2], 1, 6, null), /404/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('a write Google refused before running is retried once', async () => {
  const calls = fakeGoogle([
    { exec: reply(429) },
    { echo: reply(200, JSON.stringify({ success: true, claimed: [2], skipped: [] })) }
  ]);
  const claim = await sheets._claimQuestions(ctx(), 'Polity', [2]);
  assert.deepEqual(claim.claimed, [2]);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2);
});

test('repeated dashboard reads are served from the short cache', async () => {
  const calls = fakeGoogle([{ echo: ok([{ subject: 'Polity', total: 1 }]) }]);
  const c = ctx();
  await Promise.all([sheets._getStats(c), sheets._getStats(c)]);
  await sheets._getStats(c);
  assert.equal(calls.filter((x) => !x.url.startsWith(ECHO)).length, 1,
    'three reads, one trip to Apps Script');
});

test('a write clears the cache so the next read is fresh', async () => {
  const calls = fakeGoogle([
    { echo: ok([]) },
    { echo: reply(200, JSON.stringify({ success: true, updatedCount: 1 })) },
    { echo: ok([]) }
  ]);
  const c = ctx();
  await sheets._getStats(c);
  await sheets._markAsPosted(c, 'Polity', [2], 1, 6, null);
  await sheets._getStats(c);
  assert.equal(calls.filter((x) => !x.url.startsWith(ECHO) && x.method === 'GET').length, 2);
});

test('the posting queue is never cached', async () => {
  const calls = fakeGoogle([{ echo: ok([]) }]);
  const c = ctx();
  await sheets._getUnpostedQuestions(c, 'Polity', 5);
  await sheets._getUnpostedQuestions(c, 'Polity', 5);
  assert.equal(calls.filter((x) => !x.url.startsWith(ECHO)).length, 2);
});
