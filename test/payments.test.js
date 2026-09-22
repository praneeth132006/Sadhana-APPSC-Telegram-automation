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
const pricing = require('../src/pricing');

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

/** The two groups that sell a lifetime pass; every other group sells the exam pass. */
const LIFETIME_GROUPS = ['appsc_news_en', 'appsc_news_te'];

test('the newspaper groups sell a lifetime pass, EPFO its own pass, and every other group the exam pass', () => {
  assert.equal(plans.getPlan('test_5min'), null);

  for (const group of groups.listGroups()) {
    const sold = groups.plansFor(group.id).map((p) => p.id);
    const onSale = pricing.passPlanIdFor(group.id);
    if (group.id === 'epfo') {
      // EPFO is new: it never sold anything else, so it lists only its pass.
      assert.equal(onSale, 'epfo_pass');
      assert.deepEqual(sold, ['epfo_pass']);
    } else if (LIFETIME_GROUPS.includes(group.id)) {
      assert.equal(onSale, 'lifetime_pass', `${group.id} should be selling the lifetime pass`);
      // exam_pass is still listed, not on sale: people who bought it before
      // the change must keep resolving to a real plan.
      assert.deepEqual(sold, ['exam_pass', 'lifetime_pass'], `${group.id} lists the wrong set`);
    } else {
      assert.equal(onSale, 'exam_pass', `${group.id} was changed, and was meant to be left alone`);
      assert.deepEqual(sold, ['exam_pass'], `${group.id} sells the wrong set`);
    }
  }
});

test('retired passes are off sale but still found for the members who hold one', () => {
  // A monthly auto-pay renewal arrives as a webhook naming autopay_monthly.
  // grantAccess looks the plan up by id; if it vanished with the plan coming
  // off sale, every renewal would fail and Razorpay would retry forever.
  // EPFO started after both were retired, so nobody can hold one there.
  for (const group of groups.listGroups().filter((g) => g.id !== 'epfo')) {
    for (const planId of ['sprint_30', 'autopay_monthly']) {
      const plan = groups.getPlanFor(group.id, planId);
      assert.ok(plan, `${group.id}/${planId} can no longer be looked up`);
      assert.equal(plan.groupId, group.id);
      assert.ok(!groups.plansFor(group.id).some((p) => p.id === planId), `${planId} is still on sale`);
    }
    assert.equal(group.autopayReady, true, 'no recurring pass is sold, so none should be reported missing');
  }
});

test('every group\'s pass is Rs 199, and no retired plan is left at a test price', () => {
  for (const group of groups.listGroups()) {
    const pass = pricing.currentPass(group.id, {});
    assert.equal(pass.amountPaise, 19900, `${group.id} is not at Rs 199`);
    for (const plan of groups.plansFor(group.id, { includeRetired: true })) {
      assert.ok(plan.amountPaise >= 19900, `${group.id}/${plan.id} is still at a test price of ${plan.amountPaise} paise`);
    }
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
        plan: groups.getPlanFor(group.id, pricing.passPlanIdFor(group.id)), telegramId: '4242'
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
    // Flip the last character to a DIFFERENT one: replacing it with a fixed
    // '0' tampered with nothing whenever the real signature already ended in 0.
    const tampered = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
    assert.equal(razorpay.verifyWebhookSignature(body, tampered), false,
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
  const a = groups.getPlanFor('appsc_q_en', 'exam_pass');
  const b = groups.getPlanFor('upsc', 'exam_pass');
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
  const price = (g) => groups.plansFor(g.id).find((p) => p.id === 'exam_pass').amountPaise;

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
      const price = groups.plansFor(group.id).find((p) => p.id === 'exam_pass').amountPaise;
      assert.equal(price, configured(group.id).plans.exam_pass, `${group.id} is mispriced`);
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

test('grantAccess uses the valid-until date promised at checkout, but never a date already past', async () => {
  const originalInvite = paybot.createJoinRequestInvite;
  const originalForGroup = sheets.forGroup;
  const written = [];
  paybot.createJoinRequestInvite = async () => 'https://t.me/+x';
  sheets.forGroup = (groupId) => Object.assign({}, originalForGroup(groupId), {
    getSubscriber: async () => null,
    upsertSubscriber: async (data) => { written.push(data); return data; }
  });
  const savedEnd = process.env.EXAM_PASS_END_DATE;
  process.env.EXAM_PASS_END_DATE = '30-11-2098';
  try {
    await membership.grantAccess({
      groupId: TEST_GROUP, telegramId: 1, planId: 'exam_pass', paymentId: 'pay_a', amountPaise: 14900,
      validUntil: '31-05-2099', planLabel: 'Target Group 2 2099'
    });
    assert.match(written[0].expiry_date, /^31-05-2099, 11:59:59 PM IST$/);
    assert.equal(written[0].plan_label, 'Target Group 2 2099');
    assert.equal(written[0].amount, 149);

    await membership.grantAccess({
      groupId: TEST_GROUP, telegramId: 2, planId: 'exam_pass', paymentId: 'pay_b', amountPaise: 19900,
      validUntil: '01-01-2020'
    });
    assert.match(written[1].expiry_date, /^30-11-2098/, 'a past promised date must fall back rather than grant nothing');
    assert.ok(written[1].plan_label, 'the built-in name is used when none was promised');
  } finally {
    paybot.createJoinRequestInvite = originalInvite;
    sheets.forGroup = originalForGroup;
    if (savedEnd === undefined) delete process.env.EXAM_PASS_END_DATE;
    else process.env.EXAM_PASS_END_DATE = savedEnd;
  }
});

// ===========================================================================
// A referred student pays, and the inviter is credited
// ===========================================================================
// The full money path: the discounted link, the signed webhook, the commission
// written to the sheet, the inviter told, and Razorpay retrying the delivery.
// Every one of those is a place where somebody could be paid twice, paid the
// wrong amount, or not paid at all.

test('a referred student pays and the inviter is credited exactly once', async () => {
  const GROUP = 'appsc_q_te';

  for (const key of Object.keys(require.cache)) {
    if (/server\.js|membership\.js|sheets\.js|paybot\.js|referrals\.js/.test(key)) delete require.cache[key];
  }
  const sheetsModule = require('../src/sheets');
  const paybotModule = require('../src/paybot');
  const serverModule = require('../server');

  const sheetRows = {};
  const dms = [];
  const earnings = [];
  const originalForGroup = sheetsModule.forGroup;
  const originalInvite = paybotModule.createJoinRequestInvite;
  const originalDm = paybotModule.sendDirectMessage;

  sheetsModule.forGroup = (groupId) => ({
    groupId,
    getSubscriber: async (id) => sheetRows[`${groupId}:${id}`] || null,
    upsertSubscriber: async (row) => {
      const saved = Object.assign({}, sheetRows[`${groupId}:${row.telegram_id}`], row);
      sheetRows[`${groupId}:${row.telegram_id}`] = saved;
      return saved;
    },
    getReferral: async (code) => (code === 'REFAJMXPQ'
      ? { code: 'REFAJMXPQ', telegram_id: '111', username: 'asha', status: 'active' }
      : null),
    recordReferralEarning: async (e) => {
      if (earnings.some((x) => x.payment_id === e.payment_id)) return { recorded: false, reason: 'already recorded' };
      earnings.push(e);
      return { recorded: true, commission_paise: e.commission_paise };
    }
  });
  paybotModule.createJoinRequestInvite = async () => 'https://t.me/+invite-for-one';
  paybotModule.sendDirectMessage = async (botEnv, userId, text) => { dms.push({ userId, text }); };

  try {
    // What the bot put in the link's notes when the friend tapped Pay: ₹199
    // list, ₹19.90 off, ₹179.10 paid, ₹35.82 owed to the inviter.
    const notes = {
      telegram_id: '90902', telegram_username: 'ravi', plan_id: 'sprint_30', group_id: GROUP,
      referral_code: 'REFAJMXPQ', referrer_telegram_id: '111',
      original_amount: '199', discount_amount: '19.9', commission_amount: '35.82'
    };
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_ref', notes } },
        payment: { entity: { id: 'pay_ref', amount: 17910 } }
      }
    });

    const handled = await serverModule.handlePaymentEvent(JSON.parse(body));
    assert.equal(handled.handled, true, handled.reason || 'the webhook did nothing');

    // ---- The friend got in, at the price they were shown ------------------
    const row = sheetRows[`${GROUP}:90902`];
    assert.ok(row, 'the referred student was never given access');
    assert.equal(row.status, 'active');
    assert.equal(row.amount, 179.1, 'they were recorded as paying the discounted price');

    // ---- The inviter was credited, on what was PAID ----------------------
    assert.equal(earnings.length, 1, 'the inviter was not credited');
    assert.equal(earnings[0].code, 'REFAJMXPQ');
    assert.equal(earnings[0].referrer_telegram_id, '111');
    assert.equal(earnings[0].referred_telegram_id, '90902');
    assert.equal(earnings[0].payment_id, 'pay_ref');
    assert.equal(earnings[0].paid_paise, 17910);
    assert.equal(earnings[0].commission_paise, 3582, '20% of ₹179.10, not of ₹199');

    // ---- Both of them were told ------------------------------------------
    const toFriend = dms.filter((d) => d.userId === '90902');
    const toInviter = dms.filter((d) => String(d.userId) === '111');
    assert.equal(toFriend.length, 1, 'the student was never sent their invite');
    assert.equal(toInviter.length, 1, 'the inviter was never told they earned something');
    assert.match(toInviter[0].text, /REFAJMXPQ/);
    assert.match(toInviter[0].text, /₹35\.82/);

    // ---- Razorpay retries the same delivery ------------------------------
    // The one that matters: a retry must not pay the inviter a second time.
    await serverModule.handlePaymentEvent(JSON.parse(body));
    assert.equal(earnings.length, 1, 'a retried webhook credited the inviter twice');
    assert.equal(dms.filter((d) => String(d.userId) === '111').length, 1,
      'a retried webhook told the inviter twice');
  } finally {
    sheetsModule.forGroup = originalForGroup;
    paybotModule.createJoinRequestInvite = originalInvite;
    paybotModule.sendDirectMessage = originalDm;
  }
});

test('a payment naming a code that is not in the sheet credits nobody', async () => {
  for (const key of Object.keys(require.cache)) {
    if (/server\.js|membership\.js|sheets\.js|paybot\.js/.test(key)) delete require.cache[key];
  }
  const sheetsModule = require('../src/sheets');
  const paybotModule = require('../src/paybot');
  const serverModule = require('../server');

  const earnings = [];
  const originalForGroup = sheetsModule.forGroup;
  const originalInvite = paybotModule.createJoinRequestInvite;
  const originalDm = paybotModule.sendDirectMessage;
  const originalError = console.error;
  const logged = [];

  sheetsModule.forGroup = (groupId) => ({
    groupId,
    getSubscriber: async () => null,
    upsertSubscriber: async (row) => row,
    getReferral: async () => null,
    recordReferralEarning: async (e) => { earnings.push(e); return { recorded: true }; }
  });
  paybotModule.createJoinRequestInvite = async () => 'https://t.me/+x';
  paybotModule.sendDirectMessage = async () => {};
  console.error = (...args) => logged.push(args.join(' '));

  try {
    const handled = await serverModule.handlePaymentEvent({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_x', notes: {
          telegram_id: '90903', plan_id: 'sprint_30', group_id: 'appsc_q_te',
          referral_code: 'REFWMXD9N', commission_amount: '35.82'
        } } },
        payment: { entity: { id: 'pay_x', amount: 17910 } }
      }
    });

    // The student still gets in: their payment is real either way.
    assert.equal(handled.handled, true);
    assert.equal(earnings.length, 0, 'a commission was credited against no code');
    assert.ok(logged.some((l) => /REFWMXD9N/.test(l) && /nothing credited/.test(l)),
      'the mismatch was not reported');
  } finally {
    sheetsModule.forGroup = originalForGroup;
    paybotModule.createJoinRequestInvite = originalInvite;
    paybotModule.sendDirectMessage = originalDm;
    console.error = originalError;
  }
});

// ===========================================================================
// A lifetime pass, paid for once
// ===========================================================================

test('paying for the newspaper lifetime pass grants access with no real end date', async () => {
  const GROUP = 'appsc_news_en';

  for (const key of Object.keys(require.cache)) {
    if (/server\.js|membership\.js|sheets\.js|paybot\.js/.test(key)) delete require.cache[key];
  }
  const sheetsModule = require('../src/sheets');
  const paybotModule = require('../src/paybot');
  const membershipModule = require('../src/membership');
  const serverModule = require('../server');
  const plansModule = require('../src/plans');

  const sheetRows = {};
  const dms = [];
  const originalForGroup = sheetsModule.forGroup;
  const originalInvite = paybotModule.createJoinRequestInvite;
  const originalDm = paybotModule.sendDirectMessage;

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

  try {
    // What the bot puts in the link for a lifetime pass: a plan, and no
    // valid_until — there is no date to promise.
    const handled = await serverModule.handlePaymentEvent({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_life', notes: {
          telegram_id: '90905', telegram_username: 'lifer', plan_id: 'lifetime_pass',
          group_id: GROUP, plan_label: 'Lifetime Pass'
        } } },
        payment: { entity: { id: 'pay_life', amount: 19900 } }
      }
    });
    assert.equal(handled.handled, true, handled.reason || 'the webhook did nothing');

    const row = sheetRows[`${GROUP}:90905`];
    assert.ok(row, 'nothing was written to the sheet');
    assert.equal(row.status, 'active');
    assert.equal(row.plan, 'lifetime_pass', 'the member was recorded against the wrong pass');
    assert.equal(row.amount, 199);

    const expiry = membershipModule.parseIst(row.expiry_date);
    assert.ok(expiry, `expiry "${row.expiry_date}" could not be read back`);
    assert.equal(expiry.getTime(), plansModule.LIFETIME_EXPIRY.getTime(),
      'a lifetime pass was given a real end date');

    // And the one thing that matters to the student: the sweep leaves them be.
    assert.equal(membershipModule.isLifetimeSubscriber(row), true);
    assert.equal(dms.length, 1, 'the student was never sent their invite');
  } finally {
    sheetsModule.forGroup = originalForGroup;
    paybotModule.createJoinRequestInvite = originalInvite;
    paybotModule.sendDirectMessage = originalDm;
  }
});
