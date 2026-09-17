// ============================================================================
// Payment and membership tests (test/payments.test.js)
// ============================================================================
// The webhook is the only path from money to group access, so most of this
// suite is about proving it cannot be tricked: a forged signature must never
// grant a seat, a replayed webhook must not double-charge or double-extend,
// and identity must come from Razorpay's echoed notes rather than anything a
// payer can set.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_for_tests';
process.env.EXAM_PASS_END_DATE = '30-11-2026';
process.env.TELEGRAM_BOT_TOKEN = '123:TEST';
process.env.TELEGRAM_GROUP_ID = '-1001234567890';

// Tests configure their own groups. Without this the suite would pass or fail
// depending on which groups happen to be set up in the developer's .env.
process.env.LEGACY_GROUP_ID = '';
['APPSC_NEWS_EN', 'APPSC_Q_EN', 'UPSC'].forEach((prefix, i) => {
  process.env[`SHEET_URL_${prefix}`] =
    `https://script.google.com/macros/s/test-${prefix.toLowerCase()}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = `-100${1000 + i}`;
});

const razorpay = require('../src/razorpay');
const plans = require('../src/plans');

// ===========================================================================
// Plans and expiry arithmetic
// ===========================================================================

test('the three sellable passes are defined with sane prices', () => {
  const all = plans.listPlans();
  assert.equal(all.length, 3, 'the test pass must not be sellable by default');

  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  assert.equal(byId.sprint_30.amountPaise, 29900);
  assert.equal(byId.autopay_monthly.amountPaise, 24900);
  assert.equal(byId.exam_pass.amountPaise, 79900);

  // Amounts are in paise. A plan priced in rupees by mistake would charge 1/100th.
  all.forEach((p) => {
    assert.equal(p.amountPaise % 100, 0, `${p.id} is not a whole rupee amount`);
    assert.ok(p.amountPaise >= 10000, `${p.id} looks like rupees, not paise`);
  });
});



test('formatAmount renders paise as rupees', () => {
  assert.equal(plans.formatAmount(29900), '₹299');
  assert.equal(plans.formatAmount(24900), '₹249');
  assert.equal(plans.formatAmount(79900), '₹799');
  assert.equal(plans.formatAmount(150), '₹1.50');
});

test('a 30-day pass expires 30 days out', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const expiry = plans.computeExpiry(plans.getPlan('sprint_30'), now);
  assert.equal(Math.round((expiry - now) / 86400000), 30);
});

test('exactly three passes are sold, and the 5-minute test pass is gone', () => {
  // It could be bought by any student who found the bot, and it existed only to
  // make the expiry sweep watchable. Test-stage pricing does that job now
  // without a pass that hands out five minutes of access for a rupee.
  assert.deepEqual(plans.listPlans().map((p) => p.id), ['sprint_30', 'autopay_monthly', 'exam_pass']);
  assert.equal(plans.getPlan('test_5min'), null);

  for (const group of groups.listGroups()) {
    const sold = groups.plansFor(group.id).map((p) => p.id);
    assert.deepEqual(sold, ['sprint_30', 'autopay_monthly', 'exam_pass'], `${group.id} sells the wrong set`);
  }
});

test('every group is on test-stage pricing: Rs 1, Rs 2, Rs 3', () => {
  for (const group of groups.listGroups()) {
    const priced = Object.fromEntries(groups.plansFor(group.id).map((p) => [p.id, p.amountPaise]));
    assert.deepEqual(priced, { sprint_30: 100, autopay_monthly: 200, exam_pass: 300 },
      `${group.id} is not on test-stage pricing`);
  }
});

test('a timestamp survives a round trip whatever timezone the server is in', () => {
  // formatIst writes an IST wall-clock reading; parseIst used to rebuild it
  // from LOCAL parts, so on Vercel (UTC) every expiry read back 5h30m late.
  // Reminders fired late, lapsed members kept an extra evening of access, and
  // the 5-minute test pass never expired inside the window it exists to prove.
  const membershipModule = require('../src/membership');
  const instants = [
    new Date('2026-09-07T12:00:00Z'),
    new Date('2026-01-01T18:45:12Z'),   // crosses midnight IST
    new Date('2026-06-30T18:29:59Z'),   // one second before an IST day rolls
    new Date('2026-12-31T23:59:00Z')
  ];

  for (const instant of instants) {
    const roundTripped = membershipModule.parseIst(membershipModule.formatIst(instant));
    assert.ok(roundTripped, `${instant.toISOString()} did not parse back`);
    // Seconds granularity is all the format carries, so compare at that.
    assert.equal(
      Math.floor(roundTripped.getTime() / 1000),
      Math.floor(instant.getTime() / 1000),
      `${instant.toISOString()} drifted by ` +
      `${(roundTripped.getTime() - instant.getTime()) / 60000} minutes`
    );
  }
});


test('the exam pass expires at the end of the exam day in IST', () => {
  // Asserted in IST rather than in the process's local calendar: the students
  // are in India, so "the 30th" has to mean the 30th there whatever timezone
  // the server runs in. Reading expiry.getDate() would pass in Asia/Kolkata and
  // fail on Vercel, which is the bug this replaced.
  const expiry = plans.computeExpiry(plans.getPlan('exam_pass'), new Date('2026-09-05T12:00:00Z'));

  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(expiry);

  assert.equal(ist, '30/11/2026, 23:59');
});

test('renewing early extends from the existing expiry, not from today', () => {
  // A student with 15 days left who renews must end up with 45, not 30 —
  // otherwise paying early silently destroys the days they already bought.
  const now = new Date('2026-09-05T00:00:00Z');
  const currentExpiry = new Date('2026-09-20T00:00:00Z');

  const renewed = plans.computeExpiry(plans.getPlan('sprint_30'), now, currentExpiry);
  assert.equal(Math.round((renewed - currentExpiry) / 86400000), 30);
  assert.ok(renewed > currentExpiry);
});

test('renewing after lapsing starts a fresh term from today', () => {
  const now = new Date('2026-09-05T00:00:00Z');
  const lapsed = new Date('2026-08-01T00:00:00Z');

  const renewed = plans.computeExpiry(plans.getPlan('sprint_30'), now, lapsed);
  assert.equal(Math.round((renewed - now) / 86400000), 30,
    'an expired member should not be charged for days already gone');
});

test('a missing exam date still grants access rather than nothing', () => {
  const original = process.env.EXAM_PASS_END_DATE;
  process.env.EXAM_PASS_END_DATE = '';
  try {
    const now = new Date('2026-09-05T00:00:00Z');
    const expiry = plans.computeExpiry(plans.getPlan('exam_pass'), now);
    assert.ok(expiry > now, 'a paid student must never get zero access from a config typo');
  } finally {
    process.env.EXAM_PASS_END_DATE = original;
  }
});

test('daysUntil counts whole days and goes negative after expiry', () => {
  const from = new Date('2026-09-05T00:00:00Z');
  assert.equal(plans.daysUntil(new Date('2026-09-08T00:00:00Z'), from), 3);
  assert.equal(plans.daysUntil(new Date('2026-09-05T00:00:00Z'), from), 0);
  assert.ok(plans.daysUntil(new Date('2026-09-01T00:00:00Z'), from) < 0);
});

// ===========================================================================
// Webhook signature verification
// ===========================================================================

/** Signs a body the way Razorpay does. */
function sign(body, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('a correctly signed webhook is accepted', () => {
  const body = JSON.stringify({ event: 'payment_link.paid' });
  assert.equal(razorpay.verifyWebhookSignature(body, sign(body)), true);
});

test('a forged or altered webhook is rejected', () => {
  const body = JSON.stringify({ event: 'payment_link.paid', amount: 29900 });
  const signature = sign(body);

  // The exact attack this guards against: claim a payment that never happened.
  const forged = JSON.stringify({ event: 'payment_link.paid', amount: 1 });
  assert.equal(razorpay.verifyWebhookSignature(forged, signature), false,
    'an altered body kept the original signature and was accepted');

  assert.equal(razorpay.verifyWebhookSignature(body, 'f'.repeat(64)), false);
  assert.equal(razorpay.verifyWebhookSignature(body, ''), false);
  assert.equal(razorpay.verifyWebhookSignature(body, undefined), false);
  assert.equal(razorpay.verifyWebhookSignature(body, signature.slice(0, -1) + '0'), false);
});

test('a webhook signed with the wrong secret is rejected', () => {
  const body = JSON.stringify({ event: 'payment_link.paid' });
  assert.equal(razorpay.verifyWebhookSignature(body, sign(body, 'someone_elses_secret')), false);
});

test('with no webhook secret configured, everything is rejected', () => {
  // Failing open here would mean any POST grants free access.
  const original = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = '';
  try {
    const body = JSON.stringify({ event: 'payment_link.paid' });
    assert.equal(razorpay.verifyWebhookSignature(body, sign(body, 'anything')), false);
    assert.equal(razorpay.verifyWebhookSignature(body, ''), false);
  } finally {
    process.env.RAZORPAY_WEBHOOK_SECRET = original;
  }
});

test('signature comparison tolerates length mismatches without throwing', () => {
  const body = '{}';
  assert.equal(razorpay.verifyWebhookSignature(body, 'short'), false);
  assert.equal(razorpay.verifyWebhookSignature(body, 'x'.repeat(500)), false);
});

test('safeCompare is exact', () => {
  assert.equal(razorpay.safeCompare('abc123', 'abc123'), true);
  assert.equal(razorpay.safeCompare('abc123', 'abc124'), false);
  assert.equal(razorpay.safeCompare('abc', 'abcd'), false);
  assert.equal(razorpay.safeCompare('', ''), true);
});

// ===========================================================================
// Webhook event handling
// ===========================================================================

test('handlePaymentEvent grants access from a paid payment link', async () => {
  const { handler, calls } = loadServerWithStubs();

  const result = await handler({
    event: 'payment_link.paid',
    payload: {
      payment_link: {
        entity: {
          id: 'plink_1',
          notes: { telegram_id: '555', plan_id: 'sprint_30', telegram_username: 'student', group_id: 'appsc_news_en' }
        }
      },
      payment: { entity: { id: 'pay_1', amount: 29900 } }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(calls.grantAccess.length, 1);

  const granted = calls.grantAccess[0];
  // The group must come from the notes we set, never from anything the payer
  // supplies, or a payment could be recorded against the wrong group's sheet.
  assert.equal(granted.groupId, 'appsc_news_en');
  assert.equal(granted.telegramId, '555');
  assert.equal(granted.planId, 'sprint_30');
  assert.equal(granted.paymentId, 'pay_1');
  assert.equal(granted.amountPaise, 29900);
});

test('a webhook with no telegram_id in notes grants nothing', async () => {
  // Without notes we cannot know who paid, and guessing would hand a seat to
  // the wrong person.
  const { handler, calls } = loadServerWithStubs();

  const result = await handler({
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: 'plink_2', notes: {} } }, payment: { entity: { id: 'pay_2' } } }
  });

  assert.equal(result.handled, false);
  assert.match(result.reason, /notes/);
  assert.equal(calls.grantAccess.length, 0, 'access was granted without knowing who paid');
});

test('a subscription charge extends the same member', async () => {
  const { handler, calls } = loadServerWithStubs();

  const result = await handler({
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: 'sub_1', notes: { telegram_id: '777', plan_id: 'autopay_monthly', group_id: 'appsc_news_en' } } },
      payment: { entity: { id: 'pay_3', amount: 24900 } }
    }
  });

  assert.equal(result.handled, true);
  assert.equal(calls.grantAccess[0].telegramId, '777');
  assert.equal(calls.grantAccess[0].subscriptionId, 'sub_1');
});

test('cancelling a subscription does not revoke access immediately', async () => {
  // They paid for the current period; the nightly sweep removes them when it
  // actually ends.
  const { handler, calls } = loadServerWithStubs();

  const result = await handler({
    event: 'subscription.cancelled',
    payload: { subscription: { entity: { id: 'sub_2', notes: { telegram_id: '888', group_id: 'appsc_news_en' } } } }
  });

  assert.equal(result.handled, true);
  assert.equal(calls.grantAccess.length, 0);
  assert.equal(calls.upsert.length, 1);
  assert.equal(calls.upsert[0].status, 'cancelled');
  assert.equal(calls.upsert[0].is_payment, false, 'a cancellation must not count as revenue');
});

test('an unrelated event is acknowledged but changes nothing', async () => {
  const { handler, calls } = loadServerWithStubs();

  const result = await handler({ event: 'payment.authorized', payload: {} });
  assert.equal(result.handled, false);
  assert.equal(calls.grantAccess.length, 0);
  assert.equal(calls.upsert.length, 0);
});

/**
 * loadServerWithStubs — loads server.js with membership and sheets stubbed,
 * and returns its exported handlePaymentEvent plus a record of what it called.
 */
function loadServerWithStubs() {
  // Fresh module instances so recorded calls do not leak between tests.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('server.js') || key.includes('membership.js') || key.includes('sheets.js')) {
      delete require.cache[key];
    }
  }

  const membership = require('../src/membership');
  const sheets = require('../src/sheets');
  const calls = { grantAccess: [], upsert: [] };

  membership.grantAccess = async (options) => {
    calls.grantAccess.push(options);
    return { subscriber: { telegram_id: options.telegramId }, inviteLink: 'https://t.me/+stub', alreadyProcessed: false };
  };
  membership.formatIst = () => '05-09-2026, 10:00:00 AM IST';
  // The cancellation branch writes through the group-bound client, so the stub
  // has to sit on what forGroup returns rather than on the module.
  const upsert = async (subscriber) => {
    calls.upsert.push(subscriber);
    return subscriber;
  };
  sheets.upsertSubscriber = upsert;
  sheets.forGroup = (groupId) => ({ groupId, upsertSubscriber: upsert });

  const server = require('../server');
  return { handler: server.handlePaymentEvent, calls };
}

// ===========================================================================
// Who is allowed into the group
// ===========================================================================
// A Telegram invite link cannot be bound to an account: whoever opens it first
// gets in. That let a buyer forward their link to someone else, who joined in
// their place — and because the expiry sweep bans the id recorded on the sheet,
// the person actually sitting in the group was never removed. A free seat,
// permanently, invisible on the dashboard.
//
// Admission is now decided per-account at the moment of joining, so these
// tests are about identity rather than about links.

const membership = require('../src/membership');
const sheets = require('../src/sheets');
const paybot = require('../src/paybot');

const TEST_GROUP = 'appsc_q_en';

/** Runs `fn` with the bound sheets client stubbed to return `row`. */
async function withSubscriber(row, fn) {
  const original = sheets.forGroup;
  sheets.forGroup = (groupId) => {
    const real = original(groupId);
    return Object.assign({}, real, {
      getSubscriber: async () => row,
      upsertSubscriber: async (data) => data
    });
  };
  try {
    return await fn();
  } finally {
    sheets.forGroup = original;
  }
}

/** Captures approve/decline/remove calls instead of hitting Telegram. */
function stubPaybot() {
  const calls = [];
  const originals = {
    approveJoinRequest: paybot.approveJoinRequest,
    declineJoinRequest: paybot.declineJoinRequest,
    removeFromChat: paybot.removeFromChat
  };
  paybot.approveJoinRequest = async (env, c, u) => { calls.push(['approve', String(u), env]); };
  paybot.declineJoinRequest = async (env, c, u) => { calls.push(['decline', String(u), env]); };
  paybot.removeFromChat = async (env, c, u) => { calls.push(['remove', String(u), env]); };
  return {
    calls,
    restore() { Object.assign(paybot, originals); }
  };
}

const activeRow = {
  telegram_id: '111', status: 'active',
  expiry_date: '31-12-2030, 11:59:00 PM IST', plan: 'sprint_30'
};

test('the paying account is approved when it asks to join', async () => {
  const stub = stubPaybot();
  try {
    const result = await withSubscriber(activeRow, () => membership.handleJoinRequest(TEST_GROUP, '111'));
    assert.equal(result.approved, true);
    assert.deepEqual(stub.calls.map((c) => c.slice(0, 2)), [['approve', '111']]);
    assert.equal(stub.calls[0][2], 'TELEGRAM_PAYBOT_SADHANA', 'wrong payment bot for this group');
  } finally {
    stub.restore();
  }
});

test('a forwarded invite does not admit someone who never paid', async () => {
  // The exact hole: the buyer hands their link to a friend, the friend taps it.
  const stub = stubPaybot();
  try {
    const result = await withSubscriber(null, () => membership.handleJoinRequest(TEST_GROUP, '999'));
    assert.equal(result.approved, false);
    assert.deepEqual(stub.calls.map((c) => c.slice(0, 2)), [['decline', '999']]);
  } finally {
    stub.restore();
  }
});

test('an expired subscription is turned away at the door', async () => {
  const stub = stubPaybot();
  const expired = Object.assign({}, activeRow, {
    expiry_date: '01-01-2020, 12:00:00 AM IST'
  });
  try {
    const result = await withSubscriber(expired, () => membership.handleJoinRequest(TEST_GROUP, '111'));
    assert.equal(result.approved, false);
    assert.match(result.reason, /expired/);
  } finally {
    stub.restore();
  }
});

test('a cancelled subscription that has not yet run out still gets in', async () => {
  // Cancelling stops renewal; it does not forfeit days already paid for.
  const stub = stubPaybot();
  const cancelled = Object.assign({}, activeRow, { status: 'cancelled' });
  try {
    const result = await withSubscriber(cancelled, () => membership.handleJoinRequest(TEST_GROUP, '111'));
    // status is the record of intent, so a cancelled row is not active access.
    assert.equal(result.approved, false);
  } finally {
    stub.restore();
  }
});

test('someone added to the group by hand without paying is removed', async () => {
  // The net behind join requests: an admin adding a friend never triggers one.
  const stub = stubPaybot();
  try {
    const result = await withSubscriber(null, () => membership.enforceMembership(TEST_GROUP, '777'));
    assert.equal(result.removed, true);
    assert.deepEqual(stub.calls.map((c) => c.slice(0, 2)), [['remove', '777']]);
  } finally {
    stub.restore();
  }
});

test('a paying member is never removed by the guard', async () => {
  const stub = stubPaybot();
  try {
    const result = await withSubscriber(activeRow, () => membership.enforceMembership(TEST_GROUP, '111'));
    assert.equal(result.removed, false);
    assert.deepEqual(stub.calls, []);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// Text sent to Razorpay
// ===========================================================================

test('emoji are stripped from anything sent to Razorpay', () => {
  // Razorpay answers HTTP 400 "Error 3988: Conversion from collation
  // utf8mb3_general_ci into utf8mb4_0900_ai_ci impossible" if any string holds
  // a character outside the Basic Multilingual Plane. Telegram display names
  // routinely do, and the bot could only report "could not create your payment
  // link" — the buyer had no way to know their own name was the problem.
  assert.equal(razorpay.bmpOnly('Praneeth \u{1F3AF}\u{1F525}'), 'Praneeth');
  assert.equal(razorpay.bmpOnly('user\u{1F680}name'), 'username');

  // Ordinary non-English text is inside the BMP and must survive untouched.
  assert.equal(razorpay.bmpOnly('\u0C38\u0C3E\u0C27\u0C28'), '\u0C38\u0C3E\u0C27\u0C28');
  assert.equal(razorpay.bmpOnly('Rs 299 \u2014 pass'), 'Rs 299 \u2014 pass');

  // A name of nothing but emoji collapses to empty, so the caller can drop it
  // rather than sending an empty customer object.
  assert.equal(razorpay.bmpOnly('\u{1F600}\u{1F601}'), '');

  assert.equal(razorpay.bmpOnly('abcdef', 3), 'abc');
});

test('a payment link body carries no astral-plane characters', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = opts.body;
    const payload = JSON.stringify({ id: 'plink_x', short_url: 'https://rzp.io/x' });
    return {
      ok: true,
      status: 200,
      text: async () => payload,
      json: async () => JSON.parse(payload)
    };
  };

  try {
    await razorpay.createPaymentLink({
      plan: groups.getPlanFor('appsc_q_en', 'sprint_30'),
      telegramId: '4242',
      name: 'Praneeth \u{1F3AF}',
      username: 'user\u{1F680}name',
      callbackUrl: 'https://example.com/done'
    });

    const body = JSON.parse(sentBody);
    const asText = JSON.stringify(body);
    assert.equal(
      Array.from(asText).some((ch) => ch.codePointAt(0) > 0xFFFF), false,
      'an emoji reached Razorpay'
    );
    assert.equal(body.customer.name, 'Praneeth');
    assert.equal(body.notes.telegram_username, 'username');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ===========================================================================
// Checkout can never be created in a way the webhook will refuse
// ===========================================================================
// handlePaymentEvent drops any event whose notes lack group_id, so a checkout
// built from a plan that has no group takes the student's money and grants
// nothing. These are the regression tests for that.

test('a checkout for a plan with no group is refused before any money moves', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should never be reached'); };

  try {
    // plans.getPlan() is the legacy global table: correct wording, no group.
    await assert.rejects(
      razorpay.createPaymentLink({ plan: plans.getPlan('sprint_30'), telegramId: '4242' }),
      /not scoped to a group/
    );
    await assert.rejects(
      razorpay.createSubscription({
        plan: plans.getPlan('autopay_monthly'), razorpayPlanId: 'plan_x', telegramId: '4242'
      }),
      /not scoped to a group/
    );
    assert.equal(called, false, 'Razorpay was called for a sale nobody could be credited with');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the checkout describes the group being bought, not one hardcoded name', async () => {
  // The description is on the Razorpay checkout page and on the payer's
  // receipt. It was hardcoded to "APPSC Premium Group", so a UPSC student paid
  // for a product name belonging to a different group entirely.
  const originalFetch = globalThis.fetch;
  const seen = {};
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.razorpay.com')) return originalFetch(url, opts);
    const body = JSON.parse(opts.body);
    seen[body.notes.group_id] = body.description;
    const payload = JSON.stringify({ id: 'plink_x', short_url: 'https://rzp.io/x' });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    for (const group of groups.listGroups()) {
      await razorpay.createPaymentLink({
        plan: groups.getPlanFor(group.id, 'sprint_30'), telegramId: '4242'
      });
      assert.ok(
        seen[group.id].includes(group.displayName),
        `${group.id} is sold as "${seen[group.id]}"`
      );
      assert.ok(!seen[group.id].includes('APPSC Premium Group'));
    }

    // And the five descriptions are distinct, which the hardcoded one was not.
    assert.equal(new Set(Object.values(seen)).size, groups.listGroups().length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a group-scoped payment link carries the group id the webhook needs', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = opts.body;
    const payload = JSON.stringify({ id: 'plink_x', short_url: 'https://rzp.io/x' });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    await razorpay.createPaymentLink({
      plan: groups.getPlanFor('appsc_q_te', 'sprint_30'),
      telegramId: '4242'
    });
    const notes = JSON.parse(sentBody).notes;
    assert.equal(notes.group_id, 'appsc_q_te');
    assert.equal(notes.plan_id, 'sprint_30');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a subscription is refused when the Razorpay plan charges a different price', async () => {
  // Razorpay cannot re-price a plan, so one created before a price change keeps
  // charging the old amount while the button advertises the new one.
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(`${opts.method} ${url}`);
    const payload = url.includes('/plans/')
      ? JSON.stringify({ id: 'plan_stale', item: { amount: 24900 } })
      : JSON.stringify({ id: 'sub_x', short_url: 'https://rzp.io/s' });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    const plan = groups.getPlanFor('appsc_q_en', 'autopay_monthly');
    await assert.rejects(
      razorpay.createSubscription({ plan, razorpayPlanId: 'plan_stale', telegramId: '4242' }),
      /no subscription was started/
    );
    assert.equal(calls.some((c) => c.startsWith('POST')), false, 'a mispriced subscription was created');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a subscription goes through when the plan charges the advertised price', async () => {
  const originalFetch = globalThis.fetch;
  let subscriptionBody = null;
  const plan = groups.getPlanFor('upsc', 'autopay_monthly');

  globalThis.fetch = async (url, opts) => {
    if (url.includes('/plans/')) {
      const payload = JSON.stringify({ id: 'plan_ok', item: { amount: plan.amountPaise } });
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    }
    subscriptionBody = opts.body;
    const payload = JSON.stringify({ id: 'sub_x', short_url: 'https://rzp.io/s' });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    await razorpay.createSubscription({ plan, razorpayPlanId: 'plan_ok', telegramId: '4242' });
    assert.equal(JSON.parse(subscriptionBody).notes.group_id, 'upsc');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('every group that sells auto-pay is checked for its own Razorpay plan', () => {
  // Auto-pay used to read process.env[plan.razorpayPlanIdEnv], a field group
  // plans do not have, so it failed everywhere with "undefined is not set".
  for (const group of groups.listGroups()) {
    const autopay = groups.getPlanFor(group.id, 'autopay_monthly');
    if (!autopay) continue;
    assert.equal(typeof group.autopayReady, 'boolean');
    assert.equal(group.autopayReady, Boolean(autopay.razorpayPlanId),
      `${group.id} disagrees with itself about whether auto-pay is configured`);
    if (!group.autopayReady) {
      assert.equal(group.autopayMissing, `RAZORPAY_PLAN_${group.envPrefix}`);
    }
  }
});

// ===========================================================================
// End to end: a rupee leaves a student's account and access arrives
// ===========================================================================
// Everything between the checkout call and the invite DM runs for real here —
// the plan lookup, the Razorpay request body, the HMAC signature check, the
// webhook handler, grantAccess, the expiry maths and the round trip through
// the IST timestamp format. Only the two things outside this codebase are
// stubbed: Razorpay's HTTP API and Telegram's.
//
// This is the test that would have caught all three payment bugs at once: the
// missing group_id, the auto-pay plan id read from a field that does not
// exist, and an expiry that drifted 5h30m on a UTC server.

test('a student pays and ends up with access, start to finish', async () => {
  const GROUP = 'appsc_q_te';

  // Other tests in this file reload server.js with its collaborators stubbed,
  // which leaves the cache holding a server bound to modules this test never
  // sees. Clear them and require the set together, so the server under test and
  // the sheet being stubbed are the same objects.
  for (const key of Object.keys(require.cache)) {
    if (/server\.js|membership\.js|sheets\.js|paybot\.js/.test(key)) delete require.cache[key];
  }
  const sheetsModule = require('../src/sheets');
  const paybotModule = require('../src/paybot');
  const membershipModule = require('../src/membership');
  const serverModule = require('../server');

  const plan = groups.getPlanFor(GROUP, 'sprint_30');
  assert.ok(plan, 'the group does not sell the pass being bought');

  // ---- The sheet and Telegram, in memory --------------------------------
  const sheetRows = {};
  const dms = [];
  const originalForGroup = sheetsModule.forGroup;
  const originalInvite = paybotModule.createJoinRequestInvite;
  const originalDm = paybotModule.sendDirectMessage;
  const originalFetch = globalThis.fetch;

  sheetsModule.forGroup = (groupId) => ({
    groupId,
    getSubscriber: async (id) => sheetRows[`${groupId}:${id}`] || null,
    upsertSubscriber: async (row) => {
      const saved = Object.assign({}, sheetRows[`${groupId}:${row.telegram_id}`], row);
      sheetRows[`${groupId}:${row.telegram_id}`] = saved;
      return saved;
    }
  });
  paybotModule.createJoinRequestInvite = async () => 'https://t.me/+invite-for-one';
  paybotModule.sendDirectMessage = async (botEnv, userId, text) => { dms.push({ userId, text }); };

  // Razorpay's API, answering the way the real one does.
  let checkoutBody = null;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('api.razorpay.com')) return originalFetch(url, opts);
    checkoutBody = JSON.parse(opts.body);
    const payload = JSON.stringify({
      id: 'plink_e2e', short_url: 'https://rzp.io/i/e2e', amount: checkoutBody.amount
    });
    return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
  };

  try {
    // ---- 1. The bot hands the student a checkout link -------------------
    const checkout = await serverModule.createCheckoutForStudent({
      plan, telegramId: '90901', username: 'student', name: 'A Student'
    });
    assert.equal(checkout.url, 'https://rzp.io/i/e2e');
    assert.equal(checkoutBody.amount, plan.amountPaise, 'the student is charged the advertised price');
    assert.equal(checkoutBody.notes.group_id, GROUP, 'the sale could not be credited to any group');
    assert.equal(checkoutBody.notes.telegram_id, '90901');

    // ---- 2. They pay. Razorpay signs the webhook it sends us ------------
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_e2e', notes: checkoutBody.notes } },
        payment: { entity: { id: 'pay_e2e', amount: plan.amountPaise } }
      }
    });
    const signature = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(body).digest('hex');

    // The signature check is the whole security model, so it runs for real.
    assert.equal(razorpay.verifyWebhookSignature(body, signature), true);
    assert.equal(razorpay.verifyWebhookSignature(body, signature.replace(/.$/, '0')), false,
      'a tampered signature was accepted');

    const before = Date.now();
    const handled = await serverModule.handlePaymentEvent(JSON.parse(body));
    assert.equal(handled.handled, true, handled.reason || 'the webhook did nothing');

    // ---- 3. The sale is on the books, in the right group -----------------
    const row = sheetRows[`${GROUP}:90901`];
    assert.ok(row, 'nothing was written to the sheet');
    assert.equal(row.status, 'active');
    assert.equal(row.plan, 'sprint_30');
    assert.equal(row.amount, plan.amountPaise / 100);
    assert.equal(row.payment_id, 'pay_e2e');
    assert.ok(!sheetRows[`appsc_q_en:90901`], 'the sale leaked into the sibling group');

    // ---- 4. The expiry is right, read back the way the sweep reads it ----
    const expiry = membershipModule.parseIst(row.expiry_date);
    assert.ok(expiry, `expiry_date "${row.expiry_date}" could not be parsed back`);
    const days = (expiry.getTime() - before) / 86400000;
    assert.ok(Math.abs(days - 30) < 0.01,
      `a 30-day pass expires in ${days.toFixed(3)} days — timestamps are drifting`);

    // ---- 5. They are told, and they can get in --------------------------
    assert.equal(dms.length, 1, 'the student was never told they were in');
    assert.match(dms[0].text, /t\.me\/\+invite-for-one/);
    assert.equal(dms[0].userId, '90901');

    // ---- 6. Razorpay retries the same webhook ---------------------------
    const replayed = await serverModule.handlePaymentEvent(JSON.parse(body));
    assert.equal(replayed.handled, true);
    assert.equal(dms.length, 1, 'a retried webhook sent a second invite');
    assert.equal(
      sheetRows[`${GROUP}:90901`].expiry_date, row.expiry_date,
      'a retried webhook extended the pass a second time'
    );
  } finally {
    sheetsModule.forGroup = originalForGroup;
    paybotModule.createJoinRequestInvite = originalInvite;
    paybotModule.sendDirectMessage = originalDm;
    globalThis.fetch = originalFetch;
  }
});

// ===========================================================================
// Group isolation
// ===========================================================================
// Five groups, five sheets, and the promise that nothing is mixed. That
// promise rests on one rule — there is no default group — so these tests are
// about what happens when a caller forgets to say which group it means.

const groups = require('../src/groups');
const sheetsModule = require('../src/sheets');

test('every configured group has a unique id and an envPrefix', () => {
  const all = groups.listGroups();
  assert.ok(all.length >= 2, 'expected several groups');

  const ids = all.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'two groups share an id');
  all.forEach((g) => assert.ok(g.envPrefix, `${g.id} has no envPrefix`));
});

test('a data call with no group id is refused, not defaulted', () => {
  // The whole isolation guarantee is this line. Falling back to "the first
  // group" or "the legacy group" here is how one group's questions end up in
  // another group's paid channel.
  assert.throws(() => groups.requireGroup(''), /must name its group/);
  assert.throws(() => groups.requireGroup(null), /must name its group/);
});

test('an unknown group id is refused and the error lists the real ones', () => {
  assert.throws(() => groups.requireGroup('not_a_group'), (err) => {
    assert.match(err.message, /Unknown group "not_a_group"/);
    assert.match(err.message, /Configured groups:/);
    return true;
  });
});

test('two groups never resolve to the same sheet', () => {
  // Same URL for two groups would silently merge them, and every guarantee
  // above would still pass while the data was already mixed.
  const configured = groups.listGroups().filter((g) => g.sheetUrl);
  const urls = configured.map((g) => g.sheetUrl);
  assert.equal(new Set(urls).size, urls.length,
    'two groups point at the same Apps Script URL');
});

test('prices are per group, not shared', () => {
  // Asserted against each group's own entry in groups.config.json rather than
  // "UPSC costs more than APPSC": while every group is on test-stage pricing
  // the amounts coincide, and a difference-based assertion would then be
  // testing the price list instead of the lookup.
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'groups.config.json'), 'utf8')
  );

  for (const configured of config.groups) {
    for (const plan of groups.plansFor(configured.id)) {
      assert.equal(plan.groupId, configured.id, `${plan.id} is not tagged with its group`);
      assert.equal(
        plan.amountPaise, configured.plans[plan.id],
        `${configured.id}/${plan.id} is not priced from its own group entry`
      );
    }
  }

  // And the shape still comes from the shared planShapes block, so the wording
  // is not five copies drifting apart.
  const a = groups.getPlanFor('appsc_q_en', 'sprint_30');
  const b = groups.getPlanFor('upsc', 'sprint_30');
  assert.equal(a.label, b.label);
});


test('a sheets client is bound to one group and exposes the whole API', () => {
  const client = sheetsModule.forGroup('appsc_q_en');
  assert.equal(client.groupId, 'appsc_q_en');
  sheetsModule.API_NAMES.forEach((name) => {
    assert.equal(typeof client[name], 'function', `${name} missing from the bound client`);
  });
});

// ===========================================================================
// One payment bot per family
// ===========================================================================
// Each bot sells only its own groups. The UPSC bot cannot sell a newspaper
// pass and the Sadhana bot cannot hand out a UPSC invite — not by choosing not
// to, but because those groups are not in its list at all.

/** The groups one payment bot serves. Mirrors familyGroups() in bot.js. */
function familyOf(botEnv) {
  return groups.listGroups().filter((g) => g.paymentBotEnv === botEnv);
}

test('every group belongs to exactly one payment bot', () => {
  groups.listGroups().forEach((g) => {
    assert.ok(g.paymentBotEnv, `${g.id} has no paymentBotEnv`);
  });

  // A group listed under two bots would be sellable twice, and a student could
  // be admitted by one bot and removed by the other.
  const families = {};
  groups.listGroups().forEach((g) => {
    families[g.paymentBotEnv] = (families[g.paymentBotEnv] || 0) + 1;
  });
  assert.ok(Object.keys(families).length >= 2, 'expected several payment bots');
});

test('a payment bot sees only its own groups', () => {
  const upsc = familyOf('TELEGRAM_PAYBOT_UPSC').map((g) => g.id);
  const sadhana = familyOf('TELEGRAM_PAYBOT_SADHANA').map((g) => g.id);
  const news = familyOf('TELEGRAM_PAYBOT_NEWS').map((g) => g.id);

  assert.deepEqual(upsc, ['upsc']);
  assert.deepEqual(sadhana.sort(), ['appsc_q_en', 'appsc_q_te']);
  assert.deepEqual(news.sort(), ['appsc_news_en', 'appsc_news_te']);

  // No group appears under two bots.
  const all = [...upsc, ...sadhana, ...news];
  assert.equal(new Set(all).size, all.length);
});

test('the two languages in a family cost the same but are separate groups', () => {
  // Same price, different chat: paying for English must not open Telugu.
  const [en, te] = familyOf('TELEGRAM_PAYBOT_SADHANA');
  const price = (g) => groups.plansFor(g.id).find((p) => p.id === 'sprint_30').amountPaise;

  assert.equal(price(en), price(te), 'the two languages should cost the same');
  assert.notEqual(en.telegramGroupId, te.telegramGroupId,
    'the two languages must be different Telegram groups');
});

test('each family prices from its own group entry', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'groups.config.json'), 'utf8')
  );
  const configured = (id) => config.groups.find((g) => g.id === id);

  for (const env of ['TELEGRAM_PAYBOT_UPSC', 'TELEGRAM_PAYBOT_NEWS', 'TELEGRAM_PAYBOT_SADHANA']) {
    for (const group of familyOf(env)) {
      const price = groups.plansFor(group.id).find((p) => p.id === 'sprint_30').amountPaise;
      assert.equal(price, configured(group.id).plans.sprint_30, `${group.id} is mispriced`);
    }
  }
});

// ===========================================================================
// Admission fails closed
// ===========================================================================
// isEligible is the single check between a stranger and a paid group. Every
// case that is not provably "still valid" has to be a refusal.

/** Runs isEligible against one stubbed subscriber row. */
async function eligibilityFor(row) {
  const sheetsModule = require('../src/sheets');
  const membershipModule = require('../src/membership');
  const original = sheetsModule.forGroup;
  sheetsModule.forGroup = () => ({ getSubscriber: async () => row });
  try {
    return await membershipModule.isEligible(TEST_GROUP, '999');
  } finally {
    sheetsModule.forGroup = original;
  }
}

test('an unreadable expiry date is refused, not waved through', () => {
  // The regression: parseIst returning null fell through to "eligible", so one
  // blank or hand-mangled expiry cell granted access that never ended — and
  // the nightly sweep could not see it either, because it skips rows it
  // cannot read.
  const cases = ['', '   ', '-', 'soon', 'next monday', '2026-11-30', null, undefined];

  return Promise.all(cases.map(async (expiry_date) => {
    const verdict = await eligibilityFor({
      telegram_id: '999', status: 'active', plan_label: 'Sprint', expiry_date
    });
    assert.equal(verdict.ok, false, `admitted on expiry_date ${JSON.stringify(expiry_date)}`);
    assert.match(verdict.reason, /could not be read/);
  }));
});

test('a live pass is admitted and a lapsed one is not', async () => {
  const future = await eligibilityFor({
    telegram_id: '999', status: 'active', expiry_date: '31-12-2030, 11:59:00 PM IST'
  });
  assert.equal(future.ok, true);

  const past = await eligibilityFor({
    telegram_id: '999', status: 'active', expiry_date: '01-01-2020, 11:59:00 PM IST'
  });
  assert.equal(past.ok, false);
  assert.match(past.reason, /expired/);
});

test('any status other than active is refused whatever the date says', async () => {
  for (const status of ['pending', 'cancelled', 'expired', 'removed', '']) {
    const verdict = await eligibilityFor({
      telegram_id: '999', status, expiry_date: '31-12-2030, 11:59:00 PM IST'
    });
    assert.equal(verdict.ok, false, `admitted someone whose status is "${status}"`);
  }
});

test('someone with no row at all is refused', async () => {
  const verdict = await eligibilityFor(null);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no subscription/);
});

test('a pass for one group does not admit its sibling', async () => {
  // The exact case: an English buyer taps their link on the Telugu group. The
  // check runs against the chat being joined, not against "any group they hold".
  const [en, te] = familyOf('TELEGRAM_PAYBOT_SADHANA');

  const original = sheets.forGroup;
  sheets.forGroup = (groupId) => ({
    groupId,
    // Active in English only.
    getSubscriber: async () => (groupId === en.id
      ? { telegram_id: '321', status: 'active', expiry_date: '31-12-2030, 11:59:00 PM IST' }
      : null),
    upsertSubscriber: async (d) => d
  });

  const stub = stubPaybot();
  try {
    const intoEnglish = await membership.handleJoinRequest(en.id, '321');
    assert.equal(intoEnglish.approved, true, 'the group they paid for should admit them');

    const intoTelugu = await membership.handleJoinRequest(te.id, '321');
    assert.equal(intoTelugu.approved, false, 'the other language must not admit them');
  } finally {
    stub.restore();
    sheets.forGroup = original;
  }
});

// ===========================================================================
// Resending an invite from support
// ===========================================================================
// For the student who paid and never got in. It must never become a way to
// hand an invite to someone without a live pass.

test('resendInvite makes a fresh link for an active member and records it', async () => {
  const originalInvite = paybot.createJoinRequestInvite;
  const originalForGroup = sheets.forGroup;
  const invited = [];
  const written = [];
  paybot.createJoinRequestInvite = async (env, chatId, telegramId) => {
    invited.push({ env, chatId, telegramId: String(telegramId) });
    return 'https://t.me/+fresh-one';
  };
  sheets.forGroup = (groupId) => Object.assign({}, originalForGroup(groupId), {
    getSubscriber: async () => ({ telegram_id: '555', status: 'active', expiry_date: '30-11-2099' }),
    upsertSubscriber: async (data, event) => { written.push({ data, event }); return data; }
  });
  try {
    const result = await membership.resendInvite(TEST_GROUP, 555);
    assert.equal(result.sent, true);
    assert.equal(result.inviteLink, 'https://t.me/+fresh-one');
    assert.equal(invited.length, 1);
    assert.equal(invited[0].env, 'TELEGRAM_PAYBOT_SADHANA', 'the invite must come from this group\'s own bot');

    assert.equal(written.length, 1);
    assert.deepEqual(written[0].data, { telegram_id: '555', invite_link: 'https://t.me/+fresh-one', is_payment: false });
    assert.equal(written[0].event, 'invite.resent');
    assert.equal(written[0].data.status, undefined, 'a resend must not change the pass itself');
    assert.equal(written[0].data.expiry_date, undefined);
  } finally {
    paybot.createJoinRequestInvite = originalInvite;
    sheets.forGroup = originalForGroup;
  }
});

test('resendInvite refuses anyone without an active pass', async () => {
  const originalInvite = paybot.createJoinRequestInvite;
  let invited = 0;
  paybot.createJoinRequestInvite = async () => { invited++; return 'https://t.me/+nope'; };
  try {
    const refused = [
      null,
      { status: 'expired', expiry_date: '30-11-2099' },
      { status: 'removed', expiry_date: '30-11-2099' },
      { status: 'pending', expiry_date: '30-11-2099' },
      // Marked active but already past expiry: the join request would decline it.
      { status: 'active', expiry_date: '01-01-2020' },
      { status: 'active', expiry_date: '' }
    ];
    for (const row of refused) {
      const result = await withSubscriber(row, () => membership.resendInvite(TEST_GROUP, 555));
      assert.equal(result.sent, false, `sent an invite for ${JSON.stringify(row)}`);
      assert.ok(result.reason, 'a refusal must say why');
    }
    assert.equal(invited, 0);
  } finally {
    paybot.createJoinRequestInvite = originalInvite;
  }
});
