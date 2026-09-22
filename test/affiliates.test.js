// ============================================================================
// The influencer programme's rules (test/affiliates.test.js)
// ============================================================================
// Pure rules, no sheet and no Telegram: which exams can be promoted, what an
// admin may approve, whether a student may use a code in THIS bot, what the
// influencer earns, and when they may withdraw.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LEGACY_GROUP_ID = '';
for (const prefix of ['APPSC_NEWS_EN', 'APPSC_NEWS_TE', 'APPSC_Q_EN', 'APPSC_Q_TE', 'UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + prefix.length;
}
process.env.TELEGRAM_PAYBOT_NEWS = '111:TEST';
process.env.TELEGRAM_PAYBOT_SADHANA = '222:TEST';
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
process.env.TELEGRAM_PAYBOT_EPFO = '444:TEST';

const affiliates = require('../src/affiliates');

const DAY = 24 * 60 * 60 * 1000;

/** A UPSC code as the Codes tab stores it. */
function upscCode(overrides = {}) {
  return Object.assign({
    code: 'RAVIUPSC27', exam: 'upsc', exam_bot: 'TELEGRAM_PAYBOT_UPSC', telegram_id: '501', status: 'active',
    discount_type: 'percent', discount_value: '10', commission_type: 'percent', commission_value: '20',
    payout_cycle: 'weekly', min_payout: '0', expires_on: '', max_uses: '', one_per_student: 'yes'
  }, overrides);
}

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

test('there are four exams to promote, one per payment bot, named without the language', () => {
  const exams = affiliates.listExams();
  assert.deepEqual(exams.map((e) => e.id), ['news', 'sadhana', 'upsc', 'epfo']);
  assert.deepEqual(exams.map((e) => e.label), ['APPSC Newspaper', 'Sadhana APPSC', 'UPSC', 'EPFO']);
  // Both languages of an exam are sold by its one bot, so its code covers both.
  assert.deepEqual(exams[0].groups.map((g) => g.id), ['appsc_news_en', 'appsc_news_te']);
});

test('an exam whose bot has no token is not offered', () => {
  const saved = process.env.TELEGRAM_PAYBOT_EPFO;
  delete process.env.TELEGRAM_PAYBOT_EPFO;
  try {
    assert.ok(!affiliates.listExams().some((e) => e.id === 'epfo'));
    assert.equal(affiliates.getExam('epfo'), null);
  } finally {
    process.env.TELEGRAM_PAYBOT_EPFO = saved;
  }
});

// ---------------------------------------------------------------------------
// Codes and links
// ---------------------------------------------------------------------------

test('a code is suggested from the name and the exam', () => {
  assert.equal(affiliates.suggestCode({ name: 'Ravi Kumar' }, 'upsc', () => 0.17), 'RAVIKUUPSC25');
  assert.equal(affiliates.suggestCode({ username: 'priya_edu' }, 'epfo', () => 0), 'PRIYAEEPFO10');
  assert.match(affiliates.suggestCode({ name: '😀' }, 'news'), /^PROMONEWS\d{2}$/);
});

test('an influencer link opens the exam bot with the code', () => {
  assert.equal(affiliates.shareLink('@prelimspaymentbot', 'ravi10'), 'https://t.me/prelimspaymentbot?start=promo_RAVI10');
  assert.equal(affiliates.shareLink('', 'RAVI10'), '');
  assert.equal(affiliates.codeFromStartPayload('promo_ravi10'), 'RAVI10');
  assert.equal(affiliates.codeFromStartPayload('ref_REFAJMXPQ'), '', 'old referral links are not promo codes');
  assert.equal(affiliates.codeFromStartPayload('promo_x'), '', 'too short to be a code');
  assert.equal(affiliates.codeFromStartPayload(undefined), '');
});

// ---------------------------------------------------------------------------
// What an admin can approve
// ---------------------------------------------------------------------------

const GOOD = {
  discount_type: 'percent', discount_value: '10', commission_type: 'flat', commission_value: '30',
  payout_cycle: 'monthly', min_payout: '100', code: 'ravi-10', expires_on: '31-12-2099', max_uses: '500',
  one_per_student: true, note: 'YouTube'
};

test('valid terms are accepted and normalised', () => {
  const out = affiliates.validateTerms(GOOD, { pricePaise: 19900 });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.value, {
    code: 'RAVI-10', discount_type: 'percent', discount_value: 10, commission_type: 'flat', commission_value: 30,
    payout_cycle: 'monthly', min_payout: 100, expires_on: '31-12-2099', max_uses: 500, one_per_student: true, note: 'YouTube'
  });
});

test('every term is checked, with a reason an admin can act on', () => {
  const bad = (patch) => affiliates.validateTerms(Object.assign({}, GOOD, patch), { pricePaise: 19900 });
  assert.match(bad({ discount_type: 'free' }).error, /percent or a flat/);
  assert.match(bad({ discount_value: '95' }).error, /1 to 90/);
  assert.match(bad({ discount_value: '10.5' }).error, /1 to 90/);
  assert.match(bad({ discount_type: 'flat', discount_value: '0' }).error, /at least ₹1/);
  assert.match(bad({ commission_type: 'percent', commission_value: '101' }).error, /1 to 100/);
  assert.match(bad({ commission_type: '' }).error, /Commission/);
  assert.match(bad({ payout_cycle: 'daily' }).error, /weekly or monthly/);
  assert.match(bad({ min_payout: '-1' }).error, /Minimum withdrawal/);
  assert.match(bad({ code: 'has space' }).error, /3–20 characters/);
  assert.match(bad({ expires_on: '31/12/2099' }).error, /dd-mm-yyyy/);
  assert.match(bad({ expires_on: '01-01-2020' }).error, /already passed/);
  assert.match(bad({ max_uses: '0' }).error, /Max uses/);
  // A flat ₹199 off a ₹199 pass would make it unpayable.
  assert.match(bad({ discount_type: 'flat', discount_value: '199' }).error, /below/);
});

test('blank optional terms mean "no limit" and "suggest a code"', () => {
  const out = affiliates.validateTerms({ discount_type: 'flat', discount_value: '20', commission_type: 'percent',
    commission_value: '15', payout_cycle: 'weekly' });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.value.code, '');
  assert.equal(out.value.min_payout, 0);
  assert.equal(out.value.max_uses, '');
  assert.equal(out.value.expires_on, '');
  assert.equal(out.value.one_per_student, true, 'one use per student unless the admin says otherwise');
});

// ---------------------------------------------------------------------------
// A student using a code
// ---------------------------------------------------------------------------

const buying = (overrides = {}) => Object.assign({
  payBotEnv: 'TELEGRAM_PAYBOT_UPSC', amountPaise: 19900, studentId: '900', uses: 0, usesByStudent: 0
}, overrides);

test('a code gives its discount and carries the commission on what is paid', () => {
  const out = affiliates.evaluatePromo(upscCode(), buying());
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.kind, 'promo');
  assert.equal(out.code, 'RAVIUPSC27');
  assert.equal(out.discountPaise, 1990);
  assert.equal(out.finalPaise, 17910);
  assert.equal(out.commissionPaise, 3582, '20% of ₹179.10, not of ₹199');
  assert.equal(out.affiliateId, '501');
  assert.equal(out.label, '10% off');
});

test('a UPSC code is refused by every other bot, and says which exam it is for', () => {
  for (const bot of ['TELEGRAM_PAYBOT_NEWS', 'TELEGRAM_PAYBOT_SADHANA', 'TELEGRAM_PAYBOT_EPFO']) {
    const out = affiliates.evaluatePromo(upscCode(), buying({ payBotEnv: bot }));
    assert.equal(out.ok, false, `${bot} accepted a UPSC code`);
    assert.match(out.reason, /for UPSC and cannot be used here/);
  }
});

test('a paused, expired or used-up code is refused', () => {
  assert.match(affiliates.evaluatePromo(upscCode({ status: 'paused' }), buying()).reason, /not active/);
  assert.match(affiliates.evaluatePromo(upscCode({ expires_on: '01-01-2020' }), buying()).reason, /expired/);
  assert.match(affiliates.evaluatePromo(upscCode({ max_uses: '5' }), buying({ uses: 5 })).reason, /maximum/);
  assert.equal(affiliates.evaluatePromo(upscCode({ max_uses: '5' }), buying({ uses: 4 })).ok, true);
});

test('one use per student, unless the admin allowed more', () => {
  assert.match(affiliates.evaluatePromo(upscCode(), buying({ usesByStudent: 1 })).reason, /already used/);
  assert.equal(affiliates.evaluatePromo(upscCode({ one_per_student: 'no' }), buying({ usesByStudent: 1 })).ok, true);
});

test('an influencer cannot use their own code', () => {
  assert.match(affiliates.evaluatePromo(upscCode(), buying({ studentId: '501' })).reason, /your own/);
});

test('a flat discount and a flat commission, capped at what was paid', () => {
  const out = affiliates.evaluatePromo(upscCode({ discount_type: 'flat', discount_value: '50',
    commission_type: 'flat', commission_value: '500' }), buying());
  assert.equal(out.finalPaise, 14900);
  assert.equal(out.commissionPaise, 14900, 'a sale can never cost more in commission than it brought in');
  assert.equal(affiliates.commissionFor({ commission_type: 'flat', commission_value: '30' }, 17910), 3000);
});

test('a code that would take the pass below ₹1 is refused rather than charged at nothing', () => {
  const out = affiliates.evaluatePromo(upscCode({ discount_type: 'flat', discount_value: '199' }), buying());
  assert.equal(out.ok, false);
  assert.match(out.reason, /cannot be used on this pass/);
});

test('an unknown code is refused', () => {
  assert.match(affiliates.evaluatePromo(null, buying()).reason, /does not exist/);
});

// ---------------------------------------------------------------------------
// Earnings and withdrawals
// ---------------------------------------------------------------------------

const sale = (status, commission = 3582) => ({ status, commission_paise: commission, paid_paise: 17910, discount_paise: 1990 });

test('earnings are split into available, requested and paid', () => {
  const stats = affiliates.summarise([sale('earned'), sale('earned'), sale('requested'), sale('paid'), sale('cancelled')]);
  assert.deepEqual(stats, {
    uses: 4, revenuePaise: 71640, discountPaise: 7960, earnedPaise: 14328,
    availablePaise: 7164, requestedPaise: 3582, paidPaise: 3582
  });
});

test('a withdrawal needs something to withdraw, the minimum, the cycle, and a UPI ID', () => {
  const now = new Date('2026-10-10T10:00:00Z');
  const code = upscCode({ min_payout: '50' });
  const upi = 'ravi@okicici';

  assert.match(affiliates.withdrawal(code, [], [], { upi, now }).reason, /Nothing is waiting/);
  assert.match(affiliates.withdrawal(code, [sale('earned')], [], { upi, now }).reason, /₹14\.18 to go/);
  assert.equal(affiliates.withdrawal(code, [sale('earned'), sale('earned')], [], { upi, now }).ok, true);
  assert.match(affiliates.withdrawal(code, [sale('earned'), sale('earned')], [], { upi: 'nope', now }).reason, /UPI ID/);

  const lastWeek = { status: 'paid', requested_at: new Date(now.getTime() - 3 * DAY).toISOString() };
  const tooSoon = affiliates.withdrawal(code, [sale('earned'), sale('earned')], [lastWeek], { upi, now });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.nextAt.getTime(), new Date(lastWeek.requested_at).getTime() + 7 * DAY);

  const monthly = upscCode({ payout_cycle: 'monthly' });
  const tenDaysAgo = { status: 'paid', requested_at: new Date(now.getTime() - 10 * DAY).toISOString() };
  assert.equal(affiliates.withdrawal(monthly, [sale('earned')], [tenDaysAgo], { upi, now }).ok, false);
  assert.equal(affiliates.withdrawal(code, [sale('earned'), sale('earned')], [tenDaysAgo], { upi, now }).ok, true);

  // A rejected request does not start the clock; an open one blocks another.
  const rejected = { status: 'rejected', requested_at: new Date(now.getTime() - DAY).toISOString() };
  assert.equal(affiliates.withdrawal(code, [sale('earned'), sale('earned')], [rejected], { upi, now }).ok, true);
  const open = { status: 'requested', payout_id: 'WD-1', requested_at: now.toISOString() };
  assert.match(affiliates.withdrawal(code, [sale('earned')], [open], { upi, now }).reason, /WD-1 is still with the admin/);
});
