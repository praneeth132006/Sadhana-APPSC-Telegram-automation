// ============================================================================
// The lifetime pass (test/lifetime.test.js)
// ============================================================================
// The two newspaper groups sell a pass you pay for once and keep for ever.
// Every other group keeps selling its exam pass, exactly as before.
//
// The second half of that sentence is the one most likely to break quietly,
// so it is asserted as hard as the first: a change meant for two groups that
// leaked into the other three would turn a paid-until-exam pass into a free
// lifetime one for everybody.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.EXAM_PASS_END_DATE = '30-11-2026';

const groups = require('../src/groups');
const plans = require('../src/plans');
const pricing = require('../src/pricing');
const membership = require('../src/membership');

const NEWSPAPER = ['appsc_news_en', 'appsc_news_te'];
const UNCHANGED = ['appsc_q_en', 'appsc_q_te', 'upsc'];

// ---------------------------------------------------------------------------
// What is on sale
// ---------------------------------------------------------------------------

test('both newspaper groups sell the lifetime pass', () => {
  for (const id of NEWSPAPER) {
    const pass = pricing.currentPass(id, {});
    assert.equal(pass.id, 'lifetime_pass', `${id} is not selling the lifetime pass`);
    assert.equal(pass.lifetime, true);
    assert.equal(pass.validUntil, '', 'a lifetime pass has no end date');
    assert.equal(pass.amountPaise, 19900);
  }
});

test('every other group still sells the exam pass, with its end date', () => {
  for (const id of UNCHANGED) {
    const pass = pricing.currentPass(id, {});
    assert.equal(pass.id, 'exam_pass', `${id} was changed — it was meant to be left alone`);
    assert.equal(pass.lifetime, false, `${id} became a lifetime pass`);
    assert.equal(pass.validUntil, '30-11-2026', `${id} lost its exam end date`);
    assert.equal(pass.amountPaise, 19900);
  }
});

test('the other groups\' configuration is untouched', () => {
  // Not just what they sell today: nothing was added to them at all.
  for (const id of UNCHANGED) {
    const group = groups.requireGroup(id);
    assert.equal(group.passPlanId, undefined, `${id} gained a passPlanId`);
    assert.deepEqual(Object.keys(group.plans), ['sprint_30', 'autopay_monthly', 'exam_pass'],
      `${id}'s plans were changed`);
  }
});

test('a lifetime pass ignores any end date an admin or the environment sets', () => {
  // Either would silently turn "pay once, keep it for life" back into
  // "valid until the exam" — and the student would only find out when they
  // were removed from the group.
  const pass = pricing.currentPass('appsc_news_en', { pass_valid_until: '31-12-2026' });
  assert.equal(pass.validUntil, '');
  assert.equal(pass.lifetime, true);

  // The same setting still applies where it should.
  assert.equal(pricing.currentPass('appsc_q_en', { pass_valid_until: '31-12-2026' }).validUntil, '31-12-2026');
});

test('an admin can still rename and reprice the lifetime pass', () => {
  const pass = pricing.currentPass('appsc_news_te', { pass_name: 'Newspaper Lifetime', pass_price: '299' });
  assert.equal(pass.label, 'Newspaper Lifetime');
  assert.equal(pass.amountPaise, 29900);
  assert.equal(pass.lifetime, true, 'renaming it must not change what it is');
});

// ---------------------------------------------------------------------------
// When it ends
// ---------------------------------------------------------------------------

test('a lifetime pass is given an expiry decades out, not a real one', () => {
  const plan = groups.getPlanFor('appsc_news_en', 'lifetime_pass');
  const expiry = plans.computeExpiry(plan, new Date('2026-09-21T10:00:00Z'));
  assert.equal(expiry.getTime(), plans.LIFETIME_EXPIRY.getTime());
  assert.ok(plans.daysUntil(expiry) > 365 * 70, 'the lifetime expiry is not far enough out');
});

test('buying lifetime on top of an exam pass replaces the exam date, not extends it', () => {
  const plan = groups.getPlanFor('appsc_news_en', 'lifetime_pass');
  const examEnd = new Date('2026-11-30T18:29:59Z');
  const expiry = plans.computeExpiry(plan, new Date('2026-09-21T10:00:00Z'), examEnd);
  assert.equal(expiry.getTime(), plans.LIFETIME_EXPIRY.getTime());
});

test('the exam pass still ends on exam day', () => {
  const plan = groups.getPlanFor('appsc_q_en', 'exam_pass');
  const expiry = plans.computeExpiry(plan);
  assert.equal(membership.formatIst(expiry).slice(0, 10), '30-11-2026');
});

// ---------------------------------------------------------------------------
// Who counts as lifetime
// ---------------------------------------------------------------------------

test('lifetime is read from the pass they bought, not the group they are in', () => {
  // Somebody who bought the exam pass in a newspaper group before the change
  // still holds an exam pass. The group going lifetime does not upgrade them
  // for free — that would be giving away what others are paying for.
  assert.equal(membership.isLifetimeSubscriber({ plan: 'lifetime_pass' }), true);
  assert.equal(membership.isLifetimeSubscriber({ plan: 'exam_pass' }), false);
  assert.equal(membership.isLifetimeSubscriber({ plan: '' }), false);
  assert.equal(membership.isLifetimeSubscriber(null), false);
});

test('/status says lifetime, not "26765 days remaining"', () => {
  const text = membership.describeStatus({
    status: 'active', plan: 'lifetime_pass', plan_label: 'Lifetime Pass',
    expiry_date: '31-12-2099, 11:59:59 PM IST', total_paid: 199
  });
  assert.match(text, /Lifetime access/);
  assert.match(text, /nothing to renew/);
  assert.ok(!/Days remaining/.test(text), 'a lifetime pass was given a countdown');
  assert.ok(!/2099/.test(text), 'the placeholder expiry leaked into what the student reads');
});

test('/status for an exam pass is unchanged', () => {
  const text = membership.describeStatus({
    status: 'active', plan: 'exam_pass', plan_label: 'Target 2026 Pass',
    expiry_date: '30-11-2099, 11:59:59 PM IST', total_paid: 199
  });
  assert.match(text, /Expires:/);
  assert.match(text, /Days remaining/);
});

// ---------------------------------------------------------------------------
// The daily sweep — the one job that takes paying students out of the group
// ---------------------------------------------------------------------------

/**
 * sweep — runs the REAL runDailyCheck against a sheet holding `members`, with
 * Telegram replaced by a recorder. Returns who was removed and reminded.
 */
async function sweep(groupId, members) {
  const sheets = require('../src/sheets');
  const paybot = require('../src/paybot');
  process.env[`TELEGRAM_GROUP_${groups.requireGroup(groupId).envPrefix}`] =
    process.env[`TELEGRAM_GROUP_${groups.requireGroup(groupId).envPrefix}`] || '-1001234567890';
  groups.reset();

  const removed = [];
  const messaged = [];
  const originalForGroup = sheets.forGroup;
  const originalRemove = paybot.removeFromChat;
  const originalDm = paybot.sendDirectMessage;

  sheets.forGroup = () => ({
    getExpiring: async () => members,
    upsertSubscriber: async (row) => row
  });
  paybot.removeFromChat = async (botEnv, chatId, telegramId) => { removed.push(String(telegramId)); };
  paybot.sendDirectMessage = async (botEnv, telegramId, text) => { messaged.push({ id: String(telegramId), text }); };

  try {
    const summary = await membership.runDailyCheck({ groupId });
    return { summary, removed, messaged };
  } finally {
    sheets.forGroup = originalForGroup;
    paybot.removeFromChat = originalRemove;
    paybot.sendDirectMessage = originalDm;
  }
}

/** A stored member whose pass ended `daysAgo` days ago (negative: ends in future). */
function member(id, plan, daysAgo) {
  const at = new Date(Date.now() - daysAgo * 86400000);
  return {
    telegram_id: id, username: 'user' + id, plan, plan_label: plan,
    status: 'active', expiry_date: membership.formatIst(at), reminder_sent: ''
  };
}

test('a lifetime member is never removed — even if their date somehow passed', async () => {
  // Their real expiry is decades away, so the date alone would keep them in.
  // This is the belt-and-braces case: a mistyped or corrupted date must not be
  // what throws out someone who paid for life.
  const { removed, messaged, summary } = await sweep('appsc_news_en', [
    member('111', 'lifetime_pass', 5)
  ]);
  assert.deepEqual(removed, [], 'a lifetime member was removed from the group');
  assert.deepEqual(messaged, [], 'a lifetime member was told their pass ended');
  assert.equal(summary.removed.length, 0);
});

test('a lifetime member is never sent a renewal reminder', async () => {
  const { messaged, summary } = await sweep('appsc_news_en', [
    member('111', 'lifetime_pass', -2)   // two days "before expiry"
  ]);
  assert.deepEqual(messaged, []);
  assert.equal(summary.reminded.length, 0);
});

test('an exam-pass holder in a newspaper group still expires on time', async () => {
  // Bought before the change. They hold an exam pass, not a lifetime one, and
  // the group going lifetime does not upgrade them for free.
  const { removed } = await sweep('appsc_news_en', [member('222', 'exam_pass', 1)]);
  assert.deepEqual(removed, ['222'], 'an expired exam pass was left in the group');
});

test('in the other groups, expired members are still removed exactly as before', async () => {
  for (const id of UNCHANGED) {
    const { removed } = await sweep(id, [member('333', 'exam_pass', 1)]);
    assert.deepEqual(removed, ['333'], `${id} stopped removing expired members`);
  }
});

test('one sweep handles both kinds side by side', async () => {
  const { removed } = await sweep('appsc_news_te', [
    member('444', 'lifetime_pass', 3),
    member('555', 'exam_pass', 3)
  ]);
  assert.deepEqual(removed, ['555'], 'only the expired exam pass should go');
});
