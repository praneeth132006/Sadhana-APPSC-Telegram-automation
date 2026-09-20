// ============================================================================
// Autopilot (src/autopilot.js)
// ============================================================================
// The scheduler behind "every 5 minutes, post the next 20 questions until the
// queue runs out". Everything it does to the world is injected, so these tests
// run the real scheduling decisions against a fake clock and a fake poster —
// no Telegram, no Sheets, and no waiting five minutes to see what happens.
//
// The cases that matter are the ones a curator would only discover in
// production: two runs overlapping, a job that keeps waking up to find an
// empty queue, a Telegram outage being mistaken for an empty queue, and a
// restart forgetting (or stampeding) the jobs it was running.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutopilot, normaliseSettings, EMPTY_RUNS_BEFORE_STOP } = require('../src/autopilot');

const MINUTE = 60 * 1000;
const quiet = { log() {}, warn() {}, error() {} };

/**
 * harness — an autopilot on a clock the test moves by hand.
 *
 * @param {Object} [options] { post, reconcile, statePath }
 */
function harness(options = {}) {
  let clock = 1_000_000;
  const runs = [];

  const auto = createAutopilot({
    now: () => clock,
    statePath: options.statePath || '',
    log: quiet,
    postBatch: async (job) => {
      runs.push(job);
      const reply = options.post ? await options.post(job, runs.length) : {};
      if (reply instanceof Error) throw reply;
      return Object.assign({ postedCount: 1, eligibleCount: 1, failedCount: 0, message: '' }, reply);
    },
    reconcile: options.reconcile
  });

  return {
    auto,
    runs,
    now: () => clock,
    advance: (ms) => { clock += ms; },
    tick: () => auto.tick()
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('settings are clamped rather than refused, and default to something safe', () => {
  // Called straight from an HTTP route: a slider that sent 0 should mean "as
  // often as allowed", not a 400 the curator has to decode.
  assert.deepEqual(normaliseSettings({}), {
    intervalMinutes: 5, batchSize: 1, requireApproved: true,
    stopWhenEmpty: true, reconcileEveryRuns: 0
  });

  const wild = normaliseSettings(
    { intervalMinutes: 0, batchSize: 9999, reconcileEveryRuns: -4 }, { maxBatch: 20 });
  assert.equal(wild.intervalMinutes, 1);
  assert.equal(wild.batchSize, 20, 'never more than one request may post');
  assert.equal(wild.reconcileEveryRuns, 0);

  assert.equal(normaliseSettings({ intervalMinutes: 99999 }).intervalMinutes, 1440);
  assert.equal(normaliseSettings({ requireApproved: false }).requireApproved, false,
    'only an explicit false includes Drafts');
  assert.equal(normaliseSettings({ requireApproved: 'no' }).requireApproved, true);
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

test('the first batch goes out at once, then one per interval', async () => {
  const h = harness();
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 20 }, 'Curator');

  // Asking for "every 5 minutes" and watching nothing happen for 5 minutes
  // reads as a broken button, so the first run is due immediately.
  await h.tick();
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0], { groupId: 'g1', subject: 'Polity', count: 20, requireApproved: true });

  await h.tick();
  assert.equal(h.runs.length, 1, 'a tick before the next run is due does nothing');

  h.advance(5 * MINUTE);
  await h.tick();
  assert.equal(h.runs.length, 2);

  h.advance(5 * MINUTE - 1);
  await h.tick();
  assert.equal(h.runs.length, 2, 'one millisecond early is still early');
});

test('the next run is timed from when the last one finished, not when it started', async () => {
  // A batch of 20 takes minutes. Counting from the start would queue the next
  // run on top of a job that is already behind.
  const h = harness({ post: async () => { h.advance(4 * MINUTE); return {}; } });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 1 });

  await h.tick();
  const job = h.auto.get('g1', 'Polity');
  assert.equal(job.nextRunAt - h.now(), 5 * MINUTE,
    'five minutes after it finished, not one minute after it overran');
});

test('a run still in flight is never started a second time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ post: async () => { await gate; return {}; } });

  h.auto.start('g1', 'Polity', { intervalMinutes: 1, batchSize: 1 });
  const first = h.tick();
  await Promise.resolve();

  h.advance(10 * MINUTE);
  await h.tick();
  assert.equal(h.runs.length, 1, 'the second tick found the job busy and left it alone');

  release();
  await first;
  assert.equal(h.auto.get('g1', 'Polity').busy, false);
});

test('two subjects each get their own job, run one after the other', async () => {
  // Sequential on purpose: both post through the same bot, and two batches at
  // once is the quickest way to a 429 that stalls both.
  const order = [];
  const h = harness({ post: async (job) => { order.push(job.subject); return {}; } });

  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 1 });
  h.auto.start('g1', 'History', { intervalMinutes: 5, batchSize: 1 });

  await h.tick();
  assert.deepEqual(order, ['Polity', 'History']);
  assert.equal(h.auto.list().length, 2);
});

test('starting a subject that is already running changes its settings in place', async () => {
  // Rather than stop-then-start: between those two calls a curator's queue is
  // silently not being posted.
  const h = harness();
  h.auto.start('g1', 'Polity', { intervalMinutes: 30, batchSize: 5 });
  await h.tick();

  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 20 });
  assert.equal(h.auto.list().length, 1, 'not a second job for the same subject');

  await h.tick();
  assert.equal(h.runs.length, 2, 'restarting makes the next batch due at once');
  assert.equal(h.runs[1].count, 20);
});

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

test('an empty queue stops the job, but only after it is convincingly empty', async () => {
  // One empty run is normal — a batch can land exactly on the end of the
  // queue. Three in a row means there is genuinely nothing left.
  const h = harness({ post: async () => ({ postedCount: 0, eligibleCount: 0 }) });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 20 });

  for (let i = 0; i < EMPTY_RUNS_BEFORE_STOP; i++) {
    await h.tick();
    h.advance(5 * MINUTE);
  }

  const job = h.auto.get('g1', 'Polity');
  assert.equal(job.running, false);
  assert.match(job.stoppedReason, /nothing left to post/);
  assert.equal(h.runs.length, EMPTY_RUNS_BEFORE_STOP, 'it stops rather than waking up for ever');

  await h.tick();
  assert.equal(h.runs.length, EMPTY_RUNS_BEFORE_STOP, 'a stopped job is not due again');
});

test('a run that posts something resets the empty count', async () => {
  let eligible = 0;
  const h = harness({ post: async () => ({ postedCount: eligible, eligibleCount: eligible }) });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 20 });

  await h.tick();                       // empty
  h.advance(5 * MINUTE);
  eligible = 3;
  await h.tick();                       // a curator approved more
  h.advance(5 * MINUTE);
  eligible = 0;
  await h.tick();                       // empty again, but the count restarted

  assert.equal(h.auto.get('g1', 'Polity').running, true);
});

test('a failing Telegram is never read as an empty queue', async () => {
  // The difference that matters: an outage must not switch the job off and
  // leave a curator wondering why their questions stopped going out.
  const h = harness({ post: async () => new Error('Telegram is down') });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 20 });

  for (let i = 0; i < EMPTY_RUNS_BEFORE_STOP + 2; i++) {
    await h.tick();
    h.advance(5 * MINUTE);
  }

  const job = h.auto.get('g1', 'Polity');
  assert.equal(job.running, true, 'it keeps trying');
  assert.equal(job.totals.posted, 0);
  assert.equal(job.totals.failed, EMPTY_RUNS_BEFORE_STOP + 2);
  assert.equal(job.history[0].ok, false);
  assert.match(job.history[0].message, /Telegram is down/);
});

test('"keep checking" leaves an empty job running', async () => {
  const h = harness({ post: async () => ({ postedCount: 0, eligibleCount: 0 }) });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 20, stopWhenEmpty: false });

  for (let i = 0; i < EMPTY_RUNS_BEFORE_STOP + 1; i++) {
    await h.tick();
    h.advance(5 * MINUTE);
  }
  assert.equal(h.auto.get('g1', 'Polity').running, true);
});

test('stopping keeps the record, and stopping nothing says so', async () => {
  const h = harness();
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 1 });
  await h.tick();

  const stopped = h.auto.stop('g1', 'Polity', 'Stopped by Curator.');
  assert.equal(stopped.running, false);
  assert.equal(stopped.totals.posted, 1, 'the history survives the stop');
  assert.equal(stopped.nextRunInSeconds, null);

  assert.equal(h.auto.stop('g1', 'Polity'), null, 'stopping it twice is not an error, just nothing');
  assert.equal(h.auto.stop('g1', 'Nothing'), null);

  h.advance(10 * MINUTE);
  await h.tick();
  assert.equal(h.runs.length, 1);
});

// ---------------------------------------------------------------------------
// The deleted-poll check
// ---------------------------------------------------------------------------

test('the deleted-poll check runs on its own cadence and never fails the run', async () => {
  const checks = [];
  const h = harness({
    reconcile: async (job) => {
      checks.push(job.subject);
      if (checks.length === 1) return { marked: 2 };
      throw new Error('Telegram refused the check');
    }
  });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 1, reconcileEveryRuns: 2 });

  for (let i = 0; i < 4; i++) { await h.tick(); h.advance(5 * MINUTE); }

  assert.equal(checks.length, 2, 'every second run, not every run');
  const job = h.auto.get('g1', 'Polity');
  assert.equal(job.totals.deleted, 2);
  assert.equal(job.totals.runs, 4);
  // The posting is the job; this is housekeeping, so its failure is reported
  // rather than recorded as a failed batch.
  assert.equal(job.history[0].ok, true);
  assert.match(job.history[0].message, /deleted-poll check failed/);
});

test('the deleted-poll check is off when it is set to never', async () => {
  const checks = [];
  const h = harness({ reconcile: async () => { checks.push(1); return { restored: 0 }; } });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 1, reconcileEveryRuns: 0 });

  for (let i = 0; i < 5; i++) { await h.tick(); h.advance(5 * MINUTE); }
  assert.equal(checks.length, 0);
});

// ---------------------------------------------------------------------------
// Surviving a restart
// ---------------------------------------------------------------------------

test('running jobs come back after a restart, without firing every missed run at once', async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-')), 'state.json');

  const first = harness({ statePath });
  first.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 7 }, 'Curator');
  await first.tick();
  first.auto.stop('g1', 'History');      // never started: nothing to persist

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.jobs.length, 1);
  assert.equal(saved.jobs[0].subject, 'Polity');

  // A new process, an hour later.
  let clock = 9_999_999_999;
  const runs = [];
  const revived = createAutopilot({
    now: () => clock, statePath, log: quiet,
    postBatch: async (job) => { runs.push(job); return { postedCount: 1, eligibleCount: 1 }; }
  });

  const job = revived.get('g1', 'Polity');
  assert.equal(job.running, true);
  assert.equal(job.settings.batchSize, 7);
  assert.equal(job.startedBy, 'Curator');
  assert.equal(job.totals.posted, 1, 'what it had already done comes back too');

  // The run that came due while the server was down is not replayed twelve
  // times over — it is simply due now.
  await revived.tick();
  assert.equal(runs.length, 1);
  await revived.tick();
  assert.equal(runs.length, 1);
  revived.shutdown();
});

test('a stopped job is not resurrected by a restart', async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-')), 'state.json');
  const first = harness({ statePath });
  first.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 1 });
  await first.tick();
  first.auto.stop('g1', 'Polity', 'Stopped by Curator.');

  const revived = createAutopilot({ statePath, log: quiet, postBatch: async () => ({}) });
  assert.equal(revived.list().length, 0);
  revived.shutdown();
});

test('an unreadable state file is ignored rather than fatal', () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-')), 'state.json');
  fs.writeFileSync(statePath, 'this is not json');

  // A dashboard that will not start because it could not read a cache file
  // would be a worse failure than forgetting which jobs were running.
  const auto = createAutopilot({ statePath, log: quiet, postBatch: async () => ({}) });
  assert.deepEqual(auto.list(), []);
  auto.shutdown();
});

test('nothing is written when no state file is configured', async () => {
  // Which is the case on a serverless deployment: a /tmp that vanishes between
  // invocations would be a source of stale jobs rather than a memory.
  const h = harness({ statePath: '' });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 1 });
  await h.tick();
  assert.equal(h.auto._internal.statePath, '');
  assert.equal(h.auto.get('g1', 'Polity').running, true);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('a job reports enough to explain itself days later', async () => {
  const h = harness({ post: async (job, n) => ({ postedCount: n, eligibleCount: n, failedCount: 1, message: `run ${n}` }) });
  h.auto.start('g1', 'Polity', { intervalMinutes: 5, batchSize: 3 }, 'Curator (c@x)');

  await h.tick();
  h.advance(5 * MINUTE);
  await h.tick();

  const job = h.auto.get('g1', 'Polity');
  assert.equal(job.totals.runs, 2);
  assert.equal(job.totals.posted, 3, '1 + 2');
  assert.equal(job.totals.failed, 2);
  assert.equal(job.startedBy, 'Curator (c@x)');
  assert.equal(job.nextRunInSeconds, 5 * 60);
  assert.equal(job.history.length, 2);
  assert.equal(job.history[0].message, 'run 2', 'newest first');
  assert.equal(typeof job.history[0].tookMs, 'number');
});

test('the run history does not grow without limit', async () => {
  const h = harness();
  h.auto.start('g1', 'Polity', { intervalMinutes: 1, batchSize: 1 });
  for (let i = 0; i < 40; i++) { await h.tick(); h.advance(MINUTE); }
  assert.equal(h.auto.get('g1', 'Polity').history.length, 20);
  assert.equal(h.auto.get('g1', 'Polity').totals.runs, 40, 'the totals still count them all');
});
