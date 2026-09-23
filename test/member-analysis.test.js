// ============================================================================
// The Members page's pie charts, as numbers (test/member-analysis.test.js)
// ============================================================================
// Every chart is a whole split into parts. These pin down that each part is
// counted once, adds up to the whole it claims, and means what its label says.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LEGACY_GROUP_ID = '';
const { analyseMembers } = require('../src/member-analysis');
const { formatIst } = require('../src/membership');

const NOW = new Date('2026-09-23T06:30:00Z'); // 12:00 IST
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => formatIst(new Date(NOW.getTime() + days * DAY));

const PRICES = { exam_pass: 19900, lifetime_pass: 19900, test_5min: 100 };
const priceFor = (s) => PRICES[s.plan] || 0;
const isLifetime = (s) => s.plan === 'lifetime_pass';

function member(overrides) {
  return Object.assign({
    telegram_id: String(Math.random()).slice(2, 10), plan: 'exam_pass', plan_label: 'Target 2026 Pass', status: 'active',
    amount: 199, total_paid: 199, renewals: 1, joined_at: at(-3), start_date: at(-3), expiry_date: at(60)
  }, overrides);
}

const ROWS = [
  member({ expiry_date: at(3) }),                                             // ends within a week
  member({ expiry_date: at(20) }),                                            // 8–30 days
  member({ amount: 179.1, total_paid: 179.1, expiry_date: at(200) }),         // discounted, 3+ months
  member({ plan: 'lifetime_pass', plan_label: 'Lifetime', expiry_date: '' }), // never ends
  member({ status: 'expired', expiry_date: at(-5), joined_at: at(-40) }),
  member({ status: 'removed', expiry_date: at(-2), renewals: 2, total_paid: 398 }),
  member({ status: 'cancelled', expiry_date: at(10) }),
  member({ plan: 'test_5min', plan_label: 'Test Pass', amount: 1, total_paid: 1, status: 'expired', joined_at: at(-60) }),
  member({ amount: 0, total_paid: 0, notes: 'granted by admin' }),            // free
  member({ status: 'pending', amount: 0, total_paid: 0 }),
  // A free preview is not a member.
  member({ plan: 'trial', status: 'trial_expired', amount: 0, total_paid: 0 })
];

const sum = (slices) => slices.reduce((s, x) => s + x.count, 0);
const byKey = (slices) => Object.fromEntries(slices.map((s) => [s.key, s.count]));

test('free previews are counted apart, never as members', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  assert.equal(a.totals.members, 10);
  assert.equal(a.totals.previews, 1);
});

test('where members stand: every member in exactly one slice', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  assert.deepEqual(byKey(a.status), { active: 5, expired: 2, removed: 1, cancelled: 1, pending: 1 });
  assert.equal(sum(a.status), a.totals.members);
  assert.equal(a.status[0].key, 'active', 'largest slice first');
  assert.equal(a.status[0].percent, 50);
  assert.match(a.status.find((s) => s.key === 'cancelled').label, /access until expiry/);
});

test('which pass, and the money per pass, add up to the totals', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  assert.equal(sum(a.passes), a.totals.members);
  assert.deepEqual(byKey(a.passes), { exam_pass: 8, lifetime_pass: 1, test_5min: 1 });
  const revenue = a.revenueByPass.reduce((s, p) => s + p.value, 0);
  assert.equal(Math.round(revenue * 100) / 100, a.totals.revenue);
  assert.equal(a.totals.revenue, 199 * 5 + 179.1 + 398 + 1);
  assert.equal(a.revenueByPass[0].key, 'exam_pass');
  assert.equal(a.revenueByPass.find((p) => p.key === 'test_5min').members, 1);
});

test('what they paid: measured against the price of THEIR pass, so a test pass is not a "discount"', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  const paid = byKey(a.price);
  assert.equal(paid.discounted, 1, 'only the ₹179.10 buyer used a code');
  assert.equal(paid.free, 1);
  assert.equal(paid.full, 7);
  assert.equal(sum(a.price), 9, 'a pending payment has not paid anything yet');
  assert.equal(a.totals.discountGiven, 19.9);
});

test('when access ends, for active members only, with lifetime passes on their own', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  assert.equal(sum(a.expiry), a.totals.active);
  const ends = byKey(a.expiry);
  assert.equal(ends.week, 1);
  assert.equal(ends.month, 1);
  assert.equal(ends.later, 1);
  assert.equal(ends.lifetime, 1);
  assert.equal(ends.quarter, 1, 'the free member with the default 60-day expiry');
});

test('new or returning', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  assert.deepEqual(byKey(a.loyalty), { once: 8, again: 1 });
});

test('new members per week: 12 weeks, oldest first, each member in the week they joined', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  assert.equal(a.weekly.length, 12);
  assert.equal(a.weekly[11].count, 8, 'eight joined three days ago');
  assert.equal(a.weekly.reduce((s, w) => s + w.count, 0), 10, 'the 40- and 60-day joiners are in older weeks');
  assert.match(a.weekly[11].label, /^\d{2}-\d{2} – 23-09$/);
  assert.equal(a.totals.joinedLast30Days, 8);
});

test('no members: empty charts, no division by zero', () => {
  const a = analyseMembers([], { now: NOW });
  assert.equal(a.totals.members, 0);
  assert.equal(a.totals.averagePaid, 0);
  for (const key of ['status', 'passes', 'revenueByPass', 'price', 'expiry', 'loyalty']) assert.deepEqual(a[key], []);
  assert.equal(a.weekly.length, 12);
});

test('percentages are of the chart\'s own whole', () => {
  const a = analyseMembers(ROWS, { priceFor, isLifetime, now: NOW });
  for (const key of ['status', 'passes', 'price', 'expiry', 'loyalty']) {
    const total = a[key].reduce((s, x) => s + x.percent, 0);
    assert.ok(Math.abs(total - 100) <= 0.5, `${key} percentages add to ${total}`);
  }
});
