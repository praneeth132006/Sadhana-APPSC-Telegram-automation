// ============================================================================
// Referrals (src/referrals.js)
// ============================================================================
// The arithmetic behind "they get 10% off, you earn 20%". Every number here
// ends up as money either taken off a sale or paid out to a member, so these
// cover the cases that cost real rupees when they are wrong: commission on the
// wrong base, a code used on a sale that never happened, a sale counted twice,
// and somebody inviting themselves.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const referrals = require('../src/referrals');

/** A code owned by member 111, active. */
const CODE = { code: 'REFAJMXPQ', telegram_id: '111', username: 'inviter', status: 'active' };

/** ₹199, the default pass. */
const PRICE = 19900;

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

test('a generated code is recognised, and avoids characters people misread', () => {
  for (let i = 0; i < 200; i++) {
    const code = referrals.generateCode();
    assert.ok(referrals.isCode(code), `${code} is not recognised as a code`);
    // No 0/O, 1/I/L, 2/Z, 5/S, 8/B, 6/G: a code is read off a screen and typed
    // into another phone, and those are the pairs that get typed wrong.
    assert.ok(!/[01258BGIOSZ]/.test(code.slice(3)), `${code} contains an easily misread character`);
  }
});

test('a code is recognised however it was pasted', () => {
  const code = 'REFAJMXPQ';
  for (const typed of [
    code, code.toLowerCase(), `  ${code}  `, 'ref_' + code, 'REF_' + code,
    `https://t.me/mybot?start=ref_${code}`, `https://t.me/mybot?start=ref_${code.toLowerCase()}`
  ]) {
    assert.equal(referrals.normaliseCode(typed), code, `"${typed}" did not resolve to the code`);
  }
});

test('a start payload only yields a code when it is one', () => {
  assert.equal(referrals.codeFromStartPayload('ref_REFAJMXPQ'), 'REFAJMXPQ');
  assert.equal(referrals.codeFromStartPayload('REFAJMXPQ'), '', 'a bare code is not a referral payload');
  assert.equal(referrals.codeFromStartPayload('ref_NOTACODE'), '');
  assert.equal(referrals.codeFromStartPayload(''), '');
  assert.equal(referrals.codeFromStartPayload(undefined), '');
});

test('the share link carries the code, with or without an @', () => {
  assert.equal(referrals.shareLink('mybot', 'REFAJMXPQ'), 'https://t.me/mybot?start=ref_REFAJMXPQ');
  assert.equal(referrals.shareLink('@mybot', 'refajmxpq'), 'https://t.me/mybot?start=ref_REFAJMXPQ');
  assert.equal(referrals.shareLink('', 'REFAJMXPQ'), '', 'no username means no link to offer');
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('the defaults are 10% off, 20% commission and a ₹1000 payout', () => {
  const config = referrals.settingsFrom({});
  assert.equal(config.discountPercent, 10);
  assert.equal(config.commissionPercent, 20);
  assert.equal(config.payoutThresholdPaise, 100000);
  assert.equal(config.enabled, true);
});

test('an admin can change the numbers, and nonsense lands somewhere sane', () => {
  const changed = referrals.settingsFrom({
    referral_discount_percent: '15', referral_commission_percent: '25', referral_payout_threshold: '500'
  });
  assert.equal(changed.discountPercent, 15);
  assert.equal(changed.commissionPercent, 25);
  assert.equal(changed.payoutThresholdPaise, 50000);

  // A discount of 100% is a free pass that still costs a seat; a commission
  // above 100% pays out more than the sale brought in.
  assert.equal(referrals.settingsFrom({ referral_discount_percent: '100' }).discountPercent, 90);
  assert.equal(referrals.settingsFrom({ referral_commission_percent: '400' }).commissionPercent, 100);
  assert.equal(referrals.settingsFrom({ referral_discount_percent: 'lots' }).discountPercent, 10,
    'an unreadable value falls back rather than becoming zero');
  assert.equal(referrals.settingsFrom({ referral_discount_percent: '0' }).discountPercent, 0,
    'but a deliberate zero is honoured');
});

test('referrals can be switched off without deleting anyone\'s code', () => {
  assert.equal(referrals.settingsFrom({ referral_enabled: 'no' }).enabled, false);
  const result = referrals.evaluateReferral(CODE, {
    amountPaise: PRICE, buyerTelegramId: '222', settings: { referral_enabled: 'no' }
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not being accepted/);
});

// ---------------------------------------------------------------------------
// Using a code
// ---------------------------------------------------------------------------

test('a valid code takes 10% off and earns the inviter 20% of what was PAID', () => {
  const result = referrals.evaluateReferral(CODE, { amountPaise: PRICE, buyerTelegramId: '222' });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'referral');
  assert.equal(result.discountPaise, 1990, '10% of ₹199');
  assert.equal(result.finalPaise, 17910, '₹179.10');
  // The number that matters: 20% of ₹179.10, not 20% of ₹199. Paying on the
  // sticker price would pay out ₹39.80 on a sale worth ₹179.10.
  assert.equal(result.commissionPaise, 3582, '20% of what was actually paid');
  assert.equal(result.referrerTelegramId, '111');
  assert.ok(result.commissionPaise < referrals.percentOf(PRICE, 20));
});

test('the business keeps more than it gives away', () => {
  // A sanity check on the scheme itself, not on one number: at the defaults a
  // referred sale must still leave more than half the list price behind.
  const result = referrals.evaluateReferral(CODE, { amountPaise: PRICE, buyerTelegramId: '222' });
  const kept = result.finalPaise - result.commissionPaise;
  assert.ok(kept > PRICE / 2, `a referred sale keeps only ${kept} of ${PRICE}`);
  assert.equal(kept, 14328, '₹143.28 of a ₹199 pass');
});

test('you cannot invite yourself', () => {
  const result = referrals.evaluateReferral(CODE, { amountPaise: PRICE, buyerTelegramId: '111' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /your own referral code/);
});

test('a code that is unknown or switched off is refused', () => {
  assert.match(referrals.evaluateReferral(null,
    { amountPaise: PRICE, buyerTelegramId: '222' }).reason, /does not exist/);
  assert.match(referrals.evaluateReferral(Object.assign({}, CODE, { status: 'disabled' }),
    { amountPaise: PRICE, buyerTelegramId: '222' }).reason, /no longer active/);
});

test('a referral is for a first pass only', () => {
  // Otherwise a member renewing every month would earn their friend a
  // commission every month for one introduction.
  const alreadyPaid = referrals.evaluateReferral(CODE,
    { amountPaise: PRICE, buyerTelegramId: '222', buyerHasPaid: true });
  assert.equal(alreadyPaid.ok, false);
  assert.match(alreadyPaid.reason, /first pass/);

  const alreadyReferred = referrals.evaluateReferral(CODE,
    { amountPaise: PRICE, buyerTelegramId: '222', buyerReferredCount: 1 });
  assert.equal(alreadyReferred.ok, false);
});

test('a tiny price never falls below what Razorpay will take', () => {
  // ₹1 with 10% off is 90 paise, which Razorpay refuses — the sale would fail
  // rather than be discounted.
  const result = referrals.evaluateReferral(CODE,
    { amountPaise: 100, buyerTelegramId: '222', minPayablePaise: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.finalPaise, 100);
  assert.equal(result.discountPaise, 0, 'the discount gives way, the sale does not');
});

test('rounding lands on whole paise and never over-pays', () => {
  // ₹99.99: 10% is 999.9 paise. Both numbers must be whole, and the
  // commission must never exceed what the scheme promises.
  const result = referrals.evaluateReferral(CODE, { amountPaise: 9999, buyerTelegramId: '222' });
  assert.equal(result.discountPaise, 1000);
  assert.equal(result.finalPaise, 8999);
  assert.equal(result.commissionPaise, 1800);
  assert.ok(Number.isInteger(result.discountPaise) && Number.isInteger(result.commissionPaise));
  assert.equal(result.discountPaise + result.finalPaise, 9999, 'the money adds up');
});

// ---------------------------------------------------------------------------
// What a member is owed
// ---------------------------------------------------------------------------

const earning = (over = {}) => Object.assign({
  code: 'REFAJMXPQ', referrer_telegram_id: '111', commission_paise: 3582, status: 'pending'
}, over);

test('a member\'s standing adds up pending and paid separately', () => {
  const stats = referrals.summarise([
    earning(), earning(), earning({ status: 'paid' })
  ]);
  assert.equal(stats.joined, 3);
  assert.equal(stats.pendingPaise, 7164);
  assert.equal(stats.paidPaise, 3582);
  assert.equal(stats.totalPaise, 10746);
});

test('a cancelled earning counts as neither money nor a join', () => {
  // A refund or a chargeback. The row is kept so the history still explains
  // itself, but it must not be paid out and must not flatter the count.
  const stats = referrals.summarise([earning(), earning({ status: 'cancelled' })]);
  assert.equal(stats.joined, 1);
  assert.equal(stats.pendingPaise, 3582);
  assert.equal(stats.totalPaise, 3582);
});

test('a payout becomes available at the threshold, not before', () => {
  assert.equal(referrals.summarise([earning({ commission_paise: 99999 })]).payable, false);
  assert.equal(referrals.summarise([earning({ commission_paise: 100000 })]).payable, true);
  assert.equal(referrals.summarise([earning({ commission_paise: 150000 })]).payable, true);
  assert.equal(referrals.summarise([]).payable, false, 'nothing earned is not a payout');
  assert.equal(referrals.summarise([earning({ commission_paise: 100000, status: 'paid' })]).payable, false,
    'money already paid is not owed again');
});

test('a lower threshold makes smaller balances payable', () => {
  const stats = referrals.summarise([earning({ commission_paise: 60000 })],
    { referral_payout_threshold: '500' });
  assert.equal(stats.thresholdPaise, 50000);
  assert.equal(stats.payable, true);
});

// ---------------------------------------------------------------------------
// The monthly run
// ---------------------------------------------------------------------------

test('a payout run groups by code, largest owed first, and skips what is paid', () => {
  const due = referrals.payoutDue([
    earning({ code: 'REFAAAAAA', referrer_telegram_id: '1', commission_paise: 1000, payment_id: 'pay_1' }),
    earning({ code: 'REFAAAAAA', referrer_telegram_id: '1', commission_paise: 2000, payment_id: 'pay_2' }),
    earning({ code: 'REFCCCCCC', referrer_telegram_id: '3', commission_paise: 9000, payment_id: 'pay_3' }),
    earning({ code: 'REFDDDDDD', referrer_telegram_id: '4', commission_paise: 5000, status: 'paid' })
  ]);

  assert.deepEqual(due.map((d) => d.code), ['REFCCCCCC', 'REFAAAAAA']);
  assert.equal(due[1].pendingPaise, 3000, 'two earnings on one code are one payout');
  assert.equal(due[1].count, 2);
  // The exact payments being settled, so an earning recorded between looking
  // and paying is not silently closed along with them.
  assert.deepEqual(due[1].paymentIds, ['pay_1', 'pay_2']);
});

test('a payout run can be limited to those over the threshold', () => {
  const rows = [
    earning({ code: 'REFAAAAAA', commission_paise: 20000, payment_id: 'a' }),
    earning({ code: 'REFCCCCCC', commission_paise: 120000, payment_id: 'b' })
  ];
  assert.deepEqual(referrals.payoutDue(rows, { thresholdPaise: 100000 }).map((d) => d.code),
    ['REFCCCCCC']);
  // The monthly run pays everyone with anything pending, whatever the total.
  assert.equal(referrals.payoutDue(rows).length, 2);
});

test('a payout run takes the freshest handle it has seen', () => {
  const due = referrals.payoutDue([
    earning({ code: 'REFAAAAAA', referrer_username: 'old_handle', payment_id: 'a' }),
    earning({ code: 'REFAAAAAA', referrer_username: 'new_handle', payment_id: 'b' })
  ]);
  assert.equal(due[0].username, 'new_handle');
});
