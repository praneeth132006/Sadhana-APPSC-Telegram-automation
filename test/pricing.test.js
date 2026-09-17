// ============================================================================
// Pass pricing and coupon rules (test/pricing.test.js)
// ============================================================================
// One pass is sold; its name, price and date can be changed by an admin.
// Coupons are checked here and only here, so the bot, the checkout and the
// dashboard cannot disagree about what a code takes off.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHEET_URL_UPSC = process.env.SHEET_URL_UPSC || 'https://script.google.com/macros/s/test-upsc/exec';
process.env.SHEET_TOKEN_UPSC = process.env.SHEET_TOKEN_UPSC || 'token-for-tests';
process.env.TELEGRAM_GROUP_UPSC = process.env.TELEGRAM_GROUP_UPSC || '-1009999999999';

const pricing = require('../src/pricing');

test('the pass defaults to Rs 199 and the built-in name when nothing is set', () => {
  const saved = process.env.EXAM_PASS_END_DATE;
  process.env.EXAM_PASS_END_DATE = '30-11-2099';
  try {
    const pass = pricing.currentPass('upsc', {});
    assert.equal(pass.id, 'exam_pass');
    assert.equal(pass.amountPaise, 19900);
    assert.equal(pass.label, 'Target 2026 Pass');
    assert.equal(pass.validUntil, '30-11-2099');
    assert.equal(pass.groupId, 'upsc', 'the checkout needs the group on the plan');
  } finally {
    if (saved === undefined) delete process.env.EXAM_PASS_END_DATE;
    else process.env.EXAM_PASS_END_DATE = saved;
  }
});

test('admin settings override the name, price, date and description', () => {
  const pass = pricing.currentPass('upsc', {
    pass_name: 'Target UPSC Prelims 2027', pass_price: '249', pass_valid_until: '31-05-2099', pass_description: 'All subjects'
  });
  assert.equal(pass.label, 'Target UPSC Prelims 2027');
  assert.equal(pass.amountPaise, 24900);
  assert.equal(pass.validUntil, '31-05-2099');
  assert.equal(pass.description, 'All subjects');
});

test('a broken price or date setting falls back instead of selling at a wrong price', () => {
  const pass = pricing.currentPass('upsc', { pass_price: '0', pass_valid_until: '31-02-2099' });
  assert.equal(pass.amountPaise, 19900);
  assert.notEqual(pass.validUntil, '31-02-2099');
  assert.equal(pricing.currentPass('upsc', { pass_price: '12.50' }).amountPaise, 19900);
});

test('endOfDayIst reads the last moment of that day in India and rejects impossible dates', () => {
  assert.equal(pricing.endOfDayIst('30-11-2026').toISOString(), '2026-11-30T18:29:59.999Z');
  for (const bad of ['31-02-2026', '2026-11-30', '30/11/2026', '', '00-01-2026']) {
    assert.equal(pricing.endOfDayIst(bad), null, bad);
  }
});

function coupon(overrides) {
  return Object.assign({
    code: 'save50', discount_type: 'flat', discount_value: 50, active: true, expires_on: '',
    max_uses: null, times_used: 0, one_per_student: true, used_by_student: 0
  }, overrides || {});
}

test('a flat and a percent coupon take the right amount off', () => {
  assert.deepEqual(pricing.evaluateCoupon(coupon(), { amountPaise: 19900 }),
    { ok: true, code: 'SAVE50', discountPaise: 5000, finalPaise: 14900, label: '₹50 off' });
  assert.deepEqual(pricing.evaluateCoupon(coupon({ discount_type: 'percent', discount_value: 25 }), { amountPaise: 19900 }),
    { ok: true, code: 'SAVE50', discountPaise: 4975, finalPaise: 14925, label: '25% off' });
});

test('each reason a coupon cannot be used is explained to the student', () => {
  const now = new Date('2026-09-17T10:00:00Z');
  const cases = [
    [null, /does not exist/],
    [coupon({ active: false }), /no longer active/],
    [coupon({ expires_on: '16-09-2026' }), /has expired/],
    [coupon({ max_uses: 10, times_used: 10 }), /maximum number of times/],
    [coupon({ used_by_student: 1 }), /already used/],
    [coupon({ discount_value: 199 }), /cannot be used on this pass/],
    [coupon({ discount_value: 0 }), /does not give a discount/]
  ];
  for (const [c, reason] of cases) {
    const result = pricing.evaluateCoupon(c, { amountPaise: 19900, now });
    assert.equal(result.ok, false);
    assert.match(result.reason, reason);
  }
});

test('a coupon is still valid on its expiry day, and a per-student limit can be switched off', () => {
  const lastDay = new Date('2026-09-17T18:00:00Z'); // 11:30 PM IST on the 17th
  assert.equal(pricing.evaluateCoupon(coupon({ expires_on: '17-09-2026' }), { amountPaise: 19900, now: lastDay }).ok, true);
  assert.equal(pricing.evaluateCoupon(coupon({ one_per_student: false, used_by_student: 3 }), { amountPaise: 19900 }).ok, true);
  assert.equal(pricing.evaluateCoupon(coupon({ max_uses: 10, times_used: 9 }), { amountPaise: 19900 }).ok, true);
});

test('validateCouponInput accepts a sensible coupon and normalises it', () => {
  const checked = pricing.validateCouponInput({
    code: ' diwali-25 ', discount_type: 'PERCENT', discount_value: '25', active: 'yes',
    expires_on: '10-11-2026', max_uses: '100', one_per_student: false, note: ' festival '
  });
  assert.deepEqual(checked, {
    ok: true,
    value: {
      code: 'DIWALI-25', discount_type: 'percent', discount_value: 25, active: true,
      expires_on: '10-11-2026', max_uses: 100, one_per_student: false, note: 'festival'
    }
  });
  assert.equal(pricing.validateCouponInput({ code: 'FREE', discount_type: 'flat', discount_value: 10 }).value.max_uses, '');
});

test('validateCouponInput refuses what could never work', () => {
  const base = { code: 'OK123', discount_type: 'flat', discount_value: 10 };
  const bad = [
    [{ code: 'no spaces' }, /Code must be/],
    [{ code: 'AB' }, /Code must be/],
    [{ discount_type: 'free' }, /percent or flat/],
    [{ discount_value: '10.5' }, /whole number/],
    [{ discount_type: 'percent', discount_value: 100 }, /between 1 and 99/],
    [{ discount_value: 0 }, /at least ₹1/],
    [{ expires_on: '31-02-2026' }, /real date/],
    [{ max_uses: '0' }, /at least 1/]
  ];
  for (const [patch, error] of bad) {
    const result = pricing.validateCouponInput(Object.assign({}, base, patch));
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.match(result.error, error);
  }
});

test('validatePassInput turns the form into settings and refuses bad values', () => {
  assert.deepEqual(pricing.validatePassInput({ name: ' Target 2027 ', price: '199', validUntil: '31-05-2099', description: '' }), {
    ok: true,
    value: { pass_name: 'Target 2027', pass_price: '199', pass_valid_until: '31-05-2099', pass_description: '' }
  });
  assert.match(pricing.validatePassInput({ price: '0' }).error, /at least ₹1/);
  assert.match(pricing.validatePassInput({ price: '99.5' }).error, /whole number/);
  assert.match(pricing.validatePassInput({ validUntil: '2099-05-31' }).error, /dd-mm-yyyy/);
  assert.match(pricing.validatePassInput({ name: 'x'.repeat(81) }).error, /80 characters/);
});

test('a valid-until date in the past is refused, from the dashboard and from /set', () => {
  const now = new Date('2026-09-17T10:00:00Z');
  assert.match(pricing.validatePassInput({ validUntil: '16-09-2026' }, now).error, /in the past/);
  assert.equal(pricing.validatePassInput({ validUntil: '17-09-2026' }, now).ok, true, 'today is allowed');

  const support = require('../src/support');
  assert.match(support.validateSettingsPatch({ pass_valid_until: '01-01-2020' }).error, /in the past/);
  assert.equal(support.validateSettingsPatch({ pass_valid_until: '31-12-2099' }).ok, true);
  assert.match(support.validateSettingsPatch({ pass_price: '0' }).error, /at least 1/);
});
