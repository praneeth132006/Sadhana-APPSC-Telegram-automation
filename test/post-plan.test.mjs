import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// dashboard/post-plan.js is a browser ES module in a CommonJS package, so load
// it from its source rather than relying on Node's module-type detection.
const src = fs.readFileSync('dashboard/post-plan.js', 'utf8');
const {
  availableToPost, resolvePostCount, estimateDuration, runPostBatches, SERVER_BATCH_LIMIT
} = await import('data:text/javascript,' + encodeURIComponent(src));

// ---------------------------------------------------------------------------
// availableToPost
// ---------------------------------------------------------------------------

const polity = { total: 1358, posted: 676, pending: 682, approved: 600, scheduled: 82, draft: 0, rejected: 0 };

test('approved-only stock is Approved plus Scheduled', () => {
  assert.equal(availableToPost(polity, true), 682);
});

test('drafts are added only when eligibility allows them', () => {
  const entry = { pending: 50, approved: 10, scheduled: 5, draft: 20, rejected: 15 };
  assert.equal(availableToPost(entry, true), 15);
  assert.equal(availableToPost(entry, false), 35, 'rejected rows must never count');
});

test('stock never exceeds the unposted count', () => {
  // A status count that still includes posted rows must not overstate what can go out.
  assert.equal(availableToPost({ pending: 3, approved: 10, scheduled: 0, draft: 0 }, true), 3);
});

test('a missing or malformed entry has nothing to post', () => {
  assert.equal(availableToPost(undefined, true), 0);
  assert.equal(availableToPost({}, false), 0);
  assert.equal(availableToPost({ pending: 'x', approved: -4, scheduled: null }, true), 0);
});

// ---------------------------------------------------------------------------
// resolvePostCount
// ---------------------------------------------------------------------------

test('presets pass through unchanged', () => {
  for (const n of ['1', '3', '5', '10', '20']) {
    assert.deepEqual(resolvePostCount(n, '', 682), { ok: true, count: Number(n) });
  }
});

test('a preset above the stock still posts what there is', () => {
  // The server explains the shortfall; refusing here would hide that message.
  assert.deepEqual(resolvePostCount('20', '', 4), { ok: true, count: 20 });
});

test('"all" resolves to every eligible question', () => {
  assert.deepEqual(resolvePostCount('all', '', 682), { ok: true, count: 682 });
  assert.deepEqual(resolvePostCount('all', '999', 7), { ok: true, count: 7 }, 'custom text is ignored for "all"');
});

test('custom accepts any whole number from 1 to the stock', () => {
  assert.deepEqual(resolvePostCount('custom', '1', 682), { ok: true, count: 1 });
  assert.deepEqual(resolvePostCount('custom', '25', 682), { ok: true, count: 25 });
  assert.deepEqual(resolvePostCount('custom', ' 682 ', 682), { ok: true, count: 682 });
});

test('custom refuses a number above the stock', () => {
  const r = resolvePostCount('custom', '683', 682);
  assert.equal(r.ok, false);
  assert.match(r.error, /Only 682 questions are eligible/);
  assert.match(resolvePostCount('custom', '2', 1).error, /Only 1 question is eligible/);
});

test('custom refuses empty, zero, negative, decimal and non-numeric input', () => {
  for (const bad of ['', '   ', '0', '-5', '2.5', '1e3', 'abc', '10abc', null, undefined]) {
    const r = resolvePostCount('custom', bad, 682);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.ok(r.error);
  }
});

test('nothing resolves when the subject has no eligible questions', () => {
  for (const choice of ['all', 'custom', '5']) {
    assert.equal(resolvePostCount(choice, '1', 0).ok, false);
  }
});

test('an unknown choice is refused', () => {
  assert.equal(resolvePostCount('lots', '', 10).ok, false);
});

// ---------------------------------------------------------------------------
// estimateDuration
// ---------------------------------------------------------------------------

test('duration estimate reads naturally', () => {
  assert.equal(estimateDuration(4), 'under a minute');
  assert.equal(estimateDuration(5), 'about 1 minute');
  assert.equal(estimateDuration(20), 'about 4 minutes');
  assert.equal(estimateDuration(682), 'about 2 hours 17 minutes');
});

// ---------------------------------------------------------------------------
// runPostBatches
// ---------------------------------------------------------------------------

/** A fake server holding `stock` eligible questions, honouring the batch cap. */
function fakeServer(stock, { failOnBatch = 0 } = {}) {
  const requests = [];
  const postBatch = async (size) => {
    requests.push(size);
    assert.ok(size >= 1 && size <= SERVER_BATCH_LIMIT, `requested an out-of-range batch of ${size}`);
    const eligible = Math.min(size, stock);
    if (requests.length === failOnBatch) {
      stock -= eligible - 1;
      return { postedCount: eligible - 1, failedCount: 1, eligibleCount: eligible, results: [], message: 'one failed' };
    }
    stock -= eligible;
    return { postedCount: eligible, failedCount: 0, eligibleCount: eligible, results: [], message: `${eligible} posted` };
  };
  return { postBatch, requests, left: () => stock };
}

test('a small run is a single request', async () => {
  const server = fakeServer(100);
  const out = await runPostBatches({ total: 7, postBatch: server.postBatch });
  assert.deepEqual(server.requests, [7]);
  assert.deepEqual(out, { posted: 7, failed: 0, batches: 1, stopReason: 'done' });
});

test('"all" of 682 splits into batches of at most 20 and posts exactly 682', async () => {
  const server = fakeServer(682);
  const seen = [];
  const out = await runPostBatches({
    total: 682, postBatch: server.postBatch, onBatch: (_r, info) => seen.push(info.postedSoFar)
  });
  assert.equal(out.posted, 682);
  assert.equal(out.batches, 35);
  assert.equal(out.stopReason, 'done');
  assert.equal(server.requests.reduce((a, b) => a + b, 0), 682);
  assert.equal(server.requests.at(-1), 2);
  assert.equal(server.left(), 0);
  assert.equal(seen.at(-1), 682);
});

test('a custom 45 posts 20 + 20 + 5 and never over-posts', async () => {
  const server = fakeServer(682);
  const out = await runPostBatches({ total: 45, postBatch: server.postBatch });
  assert.deepEqual(server.requests, [20, 20, 5]);
  assert.equal(out.posted, 45);
  assert.equal(server.left(), 637);
});

test('stops when the queue runs dry mid-run', async () => {
  // Someone else posted in the meantime: 30 were expected, 25 were left.
  const server = fakeServer(25);
  const out = await runPostBatches({ total: 30, postBatch: server.postBatch });
  assert.deepEqual(server.requests, [20, 10]);
  assert.equal(out.posted, 25);
  assert.equal(out.stopReason, 'exhausted');
});

test('stops when a batch posts nothing', async () => {
  const server = fakeServer(0);
  const out = await runPostBatches({ total: 40, postBatch: server.postBatch });
  assert.deepEqual(server.requests, [20]);
  assert.deepEqual(out, { posted: 0, failed: 0, batches: 1, stopReason: 'exhausted' });
});

test('stops on the first batch with a failure', async () => {
  const server = fakeServer(682, { failOnBatch: 2 });
  const out = await runPostBatches({ total: 100, postBatch: server.postBatch });
  assert.deepEqual(server.requests, [20, 20]);
  assert.equal(out.posted, 39);
  assert.equal(out.failed, 1);
  assert.equal(out.stopReason, 'failed');
});

test('a stop request is honoured between batches, never before the first', async () => {
  const server = fakeServer(682);
  let stop = true;
  const out1 = await runPostBatches({ total: 60, postBatch: server.postBatch, shouldStop: () => stop });
  assert.deepEqual(server.requests, [20], 'the first batch must still be sent once confirmed');
  assert.equal(out1.stopReason, 'stopped');

  const server2 = fakeServer(682);
  stop = false;
  const out2 = await runPostBatches({
    total: 60,
    postBatch: server2.postBatch,
    onBatch: (_r, info) => { if (info.batch === 2) stop = true; },
    shouldStop: () => stop
  });
  assert.deepEqual(server2.requests, [20, 20]);
  assert.equal(out2.posted, 40);
  assert.equal(out2.stopReason, 'stopped');
});

test('a network error propagates so the page can report it', async () => {
  let calls = 0;
  await assert.rejects(
    runPostBatches({
      total: 50,
      postBatch: async () => { if (++calls === 2) throw new Error('offline'); return { postedCount: 20, failedCount: 0, eligibleCount: 20 }; }
    }),
    /offline/
  );
  assert.equal(calls, 2);
});

test('a 409 "already running" style empty response ends the run instead of looping', async () => {
  let calls = 0;
  const out = await runPostBatches({ total: 50, postBatch: async () => { calls++; return {}; } });
  assert.equal(calls, 1);
  assert.equal(out.stopReason, 'exhausted');
});

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------

const html = fs.readFileSync('dashboard/automation.html', 'utf8');
const pageJs = fs.readFileSync('dashboard/automation.js', 'utf8');

test('the How many select offers All and Custom', () => {
  const select = html.slice(html.indexOf('id="postCount"'), html.indexOf('</select>', html.indexOf('id="postCount"')));
  assert.match(select, /<option value="all">All eligible questions<\/option>/);
  assert.match(select, /<option value="custom">Custom number…<\/option>/);
  assert.match(select, /<option value="5" selected>/, 'the default must stay 5');
});

test('the custom input exists, starts hidden and only takes whole numbers from 1', () => {
  assert.match(html, /<div id="postCustomField"[^>]*hidden>/);
  assert.match(html, /<input id="postCustomCount"[^>]*type="number"[^>]*min="1"[^>]*step="1"/);
  assert.match(html, /id="postStopBtn"[^>]*hidden/);
});

test('the hidden attribute is not overridden by component display rules', () => {
  // .btn and .editor-field set display, which made the Stop button and the
  // custom input visible even while hidden.
  const css = fs.readFileSync('dashboard/shared.css', 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('the page validates through post-plan.js and posts in batches', () => {
  assert.match(pageJs, /from '\.\/post-plan\.js'/);
  assert.match(pageJs, /runPostBatches\(/);
  assert.match(pageJs, /resolvePostCount\(/);
  assert.match(pageJs, /\$\('postCustomCount'\)\.addEventListener\('input', renderPostCount\)/);
});

test('the client batch limit matches the server cap', () => {
  const server = fs.readFileSync('server.js', 'utf8');
  const cap = Number(server.match(/const MAX_POST_BATCH = (\d+);/)[1]);
  assert.equal(SERVER_BATCH_LIMIT, cap);
});
