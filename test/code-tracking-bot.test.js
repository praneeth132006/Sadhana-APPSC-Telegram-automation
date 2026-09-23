// ============================================================================
// Code tracking in the payment bots (test/code-tracking-bot.test.js)
// ============================================================================
// An admin puts a coupon in an ad as t.me/<bot>?start=promo_CODE. These follow
// a student from that click to a payment link, through the real bot, and check
// two things at every step: what the student sees, and what is recorded for
// the Code Tracking page.
//
// They also pin down the bug this work uncovered: the code from the link was
// held only in one server instance's memory, so on the deployment a tap that
// landed on another instance lost the discount. Every step here that matters
// is replayed on a brand-new bot to prove the code survives.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.EXAM_PASS_END_DATE = '30-11-2099';
process.env.LEGACY_GROUP_ID = '';
for (const prefix of ['APPSC_NEWS_EN', 'APPSC_NEWS_TE', 'UPSC']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + prefix.length;
}
process.env.TELEGRAM_PAYBOT_NEWS = '111:TEST';
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
delete process.env.SUPPORT_CHAT_ID;

require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(url, ...rest) {
    const target = String(url && url.url ? url.url : url);
    if (/^https:\/\/(script\.google(usercontent)?\.com|api\.razorpay\.com|api\.telegram\.org|sheets\.googleapis\.com)\//.test(target)) {
      return Promise.reject(new Error(`Network call to ${target.split('?')[0]} attempted in a test — stub it`));
    }
    return realFetch.call(this, url, ...rest);
  };
}

const sheets = require('../src/sheets');
const razorpay = require('../src/razorpay');
const store = require('../src/affiliate-store');
const tracking = require('../src/code-tracking');
const { createPaymentBot } = require('../src/botapp');

const STUDENT = { id: 900, is_bot: false, first_name: 'Kiran', last_name: 'Rao', username: 'kiran' };

const AD10 = { code: 'AD10', discount_type: 'flat', discount_value: 10, active: true, one_per_student: true, used_by_student: 0 };
const OLD = { code: 'OLDAD', discount_type: 'flat', discount_value: 10, active: true, expires_on: '01-01-2020', used_by_student: 0 };
const RAVI = {
  code: 'RAVIUPSC27', exam: 'upsc', exam_bot: 'TELEGRAM_PAYBOT_UPSC', telegram_id: '501', status: 'active',
  discount_type: 'percent', discount_value: '10', commission_type: 'percent', commission_value: '20',
  payout_cycle: 'weekly', min_payout: '0', expires_on: '', max_uses: '', one_per_student: 'yes'
};
const QUESTIONS = [1, 2].map((n) => ({
  question_id: `POL-${n}`, subject: 'Polity', question_text: `Sample question ${n}?`,
  option_a: 'One', option_b: 'Two', option_c: 'Three', option_d: 'Four', correct_answer: 'B', explanation: 'x'
}));

/** Every tracking event the bot asked for, in order. */
let events = [];
let links = [];

function stubWorld({ coupons = { AD10, OLDAD: OLD }, questions = [], promoCodes = [RAVI] } = {}) {
  events = [];
  links = [];
  sheets.forGroup = (groupId) => ({
    groupId,
    getBotSettings: async () => ({}),
    getSubscriber: async () => null,
    getCoupon: async (code) => coupons[code] || null,
    readConfig: async () => [{ subject: 'Polity' }],
    sampleQuestions: async (subject, count) => questions.slice(0, count)
  });
  store.isConfigured = () => true;
  store.getCode = async (code) => promoCodes.find((c) => c.code === String(code).toUpperCase()) || null;
  store.usageOf = async () => ({ uses: 0, usesByStudent: 0 });
  store.recordLinkOpen = async () => ({ recorded: true });
  tracking.isConfigured = () => true;
  tracking.safeRecord = async (env, event) => { events.push(Object.assign({ env }, event)); return event; };
  razorpay.createPaymentLink = async (options) => {
    links.push(options);
    return { id: 'plink_' + links.length, short_url: 'https://rzp.io/i/' + links.length };
  };
}

/** A fresh bot: a fresh server instance, with nothing in memory. */
function makeBot(payBotEnv) {
  const app = createPaymentBot({ payBotEnv, polling: false });
  const sent = [];
  const record = (method) => async (...args) => { sent.push({ method, args }); return { message_id: sent.length }; };
  ['sendMessage', 'sendPoll', 'sendChatAction', 'answerCallbackQuery'].forEach((m) => { app.bot[m] = record(m); });
  app.bot.getMe = async () => ({ id: 1, is_bot: true, username: 'test_pay_bot' });

  let seq = 1;
  const deliver = async (update) => {
    const before = sent.length;
    app.bot.processUpdate(Object.assign({ update_id: seq++ }, update));
    await app.settle();
    return sent.slice(before);
  };
  const say = (text, extra = {}) => deliver({ message: Object.assign({
    message_id: seq++, date: 1, from: STUDENT, chat: { id: STUDENT.id, type: 'private' }, text }, extra) });
  const tap = (data) => deliver({ callback_query: { id: 'cb' + seq++, from: STUDENT, data,
    message: { message_id: 1, date: 1, chat: { id: STUDENT.id, type: 'private' }, text: '…' } } });
  const typeCode = (groupShortName, code) => say(code, { reply_to_message: {
    message_id: 5, from: { id: Number(String(process.env[payBotEnv]).split(':')[0]), is_bot: true, username: 'test_pay_bot' },
    chat: { id: STUDENT.id, type: 'private' }, text: `🎟 Coupon code for ${groupShortName}\n\nType your coupon or promo code…` } });
  return { app, sent, say, tap, typeCode };
}

const messages = (out) => out.filter((s) => s.method === 'sendMessage');
const textOf = (out) => messages(out).map((m) => m.args[1]).join('\n---\n');
const buttons = (out) => messages(out).flatMap((m) =>
  ((m.args[2] && m.args[2].reply_markup && m.args[2].reply_markup.inline_keyboard) || []).flat());
const types = () => events.map((e) => e.type);

// ---------------------------------------------------------------------------
// The click
// ---------------------------------------------------------------------------

test('opening the ad link records a click, with who clicked', async () => {
  stubWorld();
  const { say } = makeBot('TELEGRAM_PAYBOT_UPSC');
  const out = await say('/start promo_AD10');
  assert.match(textOf(out), /Promo code <b>AD10<\/b> will be applied/);
  assert.equal(events.length, 1);
  assert.deepEqual(
    { env: events[0].env, type: events[0].type, code: events[0].code, source: events[0].source, id: events[0].student.id },
    { env: 'TELEGRAM_PAYBOT_UPSC', type: 'clicked', code: 'AD10', source: 'link', id: 900 });
  assert.equal(events[0].student.username, 'kiran');
});

test('a plain /start records nothing', async () => {
  stubWorld();
  const { say } = makeBot('TELEGRAM_PAYBOT_UPSC');
  await say('/start');
  await say('/start something_else');
  assert.equal(events.length, 0);
});

test('the welcome\'s Continue button carries the code', async () => {
  stubWorld();
  const { say } = makeBot('TELEGRAM_PAYBOT_UPSC');
  const out = await say('/start promo_ad10');
  assert.equal(buttons(out)[0].callback_data, 'go:plans:AD10');
  const plain = await say('/start');
  assert.equal(buttons(plain)[0].callback_data, 'go:plans');
});

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

test('Continue on the same instance shows the discount and records it as applied from the link', async () => {
  stubWorld();
  const { say, tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
  await say('/start promo_AD10');
  const pass = await tap('go:plans:AD10');
  assert.match(textOf(pass), /Coupon <b>AD10<\/b> applied/);
  assert.match(textOf(pass), /<s>₹199<\/s> <b>₹189<\/b>/);
  assert.deepEqual(types(), ['clicked', 'applied']);
  assert.equal(events[1].source, 'link');
  assert.equal(events[1].kind, 'coupon');
  assert.equal(events[1].group, 'UPSC Prelims');
});

test('Continue that lands on ANOTHER instance still applies the code (it rode on the button)', async () => {
  stubWorld();
  await makeBot('TELEGRAM_PAYBOT_UPSC').say('/start promo_AD10');
  // A different server instance: nothing in memory.
  const pass = await makeBot('TELEGRAM_PAYBOT_UPSC').tap('go:plans:AD10');
  assert.match(textOf(pass), /Coupon <b>AD10<\/b> applied/, 'the discount was lost between instances');
  assert.match(textOf(pass), /₹189/);
  assert.deepEqual(types(), ['clicked', 'applied']);
});

test('an old Continue button without a code still works, at the full price', async () => {
  stubWorld();
  const pass = await makeBot('TELEGRAM_PAYBOT_UPSC').tap('go:plans');
  assert.match(textOf(pass), /Price: <b>₹199<\/b>/);
  assert.equal(events.length, 0);
});

test('a two-language bot: the language buttons and every Next carry the code across instances', async () => {
  stubWorld({ questions: QUESTIONS });
  const welcome = await makeBot('TELEGRAM_PAYBOT_NEWS').say('/start promo_AD10');
  assert.equal(buttons(welcome)[0].callback_data, 'go:plans:AD10');

  const languages = await makeBot('TELEGRAM_PAYBOT_NEWS').tap('go:plans:AD10');
  const picks = buttons(languages).map((b) => b.callback_data);
  assert.deepEqual(picks, ['pick:appsc_news_en:AD10', 'pick:appsc_news_te:AD10']);

  const first = await makeBot('TELEGRAM_PAYBOT_NEWS').tap('pick:appsc_news_te:AD10');
  assert.equal(first.filter((s) => s.method === 'sendPoll').length, 1);
  assert.deepEqual(buttons(first).map((b) => b.callback_data), ['smp:appsc_news_te:1:AD10']);

  const last = await makeBot('TELEGRAM_PAYBOT_NEWS').tap('smp:appsc_news_te:1:AD10');
  assert.match(textOf(last), /Coupon <b>AD10<\/b> applied/, 'the code was lost somewhere between the welcome and the price');
  assert.match(textOf(last), /₹189/);
  assert.ok(buttons(last).some((b) => b.callback_data === 'buy:appsc_news_te:lifetime_pass:AD10'));
  const applied = events.filter((e) => e.type === 'applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].group, 'Newspaper · Telugu');
});

test('"Remove coupon" still removes it, even though the code rides on buttons', async () => {
  stubWorld();
  const { say, tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
  await say('/start promo_AD10');
  const plain = await tap('plain:upsc');
  assert.match(textOf(plain), /Price: <b>₹199<\/b>/);
  assert.doesNotMatch(textOf(plain), /applied/);
});

test('a code typed at checkout is recorded as typed', async () => {
  stubWorld();
  const out = await makeBot('TELEGRAM_PAYBOT_UPSC').typeCode('UPSC Prelims', 'ad10');
  assert.match(textOf(out), /Coupon <b>AD10<\/b> applied/);
  assert.deepEqual(types(), ['applied']);
  assert.equal(events[0].source, 'typed');
  assert.equal(events[0].code, 'AD10');
});

test('a real code that cannot be used is recorded as refused, with the reason', async () => {
  stubWorld();
  const out = await makeBot('TELEGRAM_PAYBOT_UPSC').typeCode('UPSC Prelims', 'OLDAD');
  assert.match(textOf(out), /expired/);
  assert.deepEqual(types(), ['refused']);
  assert.match(events[0].reason, /expired/);
});

test('a code that does not exist is not tracked: a typo is not a campaign', async () => {
  stubWorld();
  await makeBot('TELEGRAM_PAYBOT_UPSC').typeCode('UPSC Prelims', 'NOSUCHCODE');
  assert.equal(events.length, 0);
});

test('an influencer\'s promo link is tracked too, as a promo', async () => {
  stubWorld();
  const { say, tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
  await say('/start promo_RAVIUPSC27');
  await tap('go:plans:RAVIUPSC27');
  assert.deepEqual(types(), ['clicked', 'applied']);
  assert.equal(events[1].kind, 'promo');
});

// ---------------------------------------------------------------------------
// The payment link
// ---------------------------------------------------------------------------

test('tapping Pay with the code records the payment link, its amount and id', async () => {
  stubWorld();
  const { tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
  const out = await tap('buy:upsc:exam_pass:AD10');
  assert.match(textOf(out), /You pay <b>₹189<\/b>/);
  assert.equal(links.length, 1);
  assert.equal(links[0].extraNotes.coupon_code, 'AD10');
  assert.equal(links[0].extraNotes.student_name, 'Kiran Rao', 'the webhook needs the name to say who paid');
  assert.deepEqual(types(), ['link_created'], 'the re-check at Pay must not count as a second apply');
  assert.deepEqual(
    { code: events[0].code, kind: events[0].kind, amountPaise: events[0].amountPaise, linkId: events[0].linkId },
    { code: 'AD10', kind: 'coupon', amountPaise: 18900, linkId: 'plink_1' });
});

test('paying full price records nothing', async () => {
  stubWorld();
  await makeBot('TELEGRAM_PAYBOT_UPSC').tap('buy:upsc:exam_pass');
  assert.equal(links.length, 1);
  assert.equal(events.length, 0);
});

test('a code that stopped working before Pay makes no link and records nothing new', async () => {
  stubWorld();
  await makeBot('TELEGRAM_PAYBOT_UPSC').tap('buy:upsc:exam_pass:OLDAD');
  assert.equal(links.length, 0);
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// Tracking must never get in the student's way
// ---------------------------------------------------------------------------

test('when tracking fails outright, the student notices nothing', async () => {
  stubWorld();
  let attempts = 0;
  tracking.safeRecord = async () => {
    attempts++;
    throw new Error('Google Sheets API: quota exceeded');
  };
  const { say, tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
  const welcome = await say('/start promo_AD10');
  assert.match(textOf(welcome), /will be applied/);
  const pass = await tap('go:plans:AD10');
  assert.match(textOf(pass), /AD10<\/b> applied/);
  const pay = await tap('buy:upsc:exam_pass:AD10');
  assert.match(textOf(pay), /You pay <b>₹189<\/b>/);
  assert.equal(attempts, 3, 'click, apply and link were each attempted');
  assert.ok(!/Something went wrong/.test(textOf(welcome) + textOf(pass) + textOf(pay)));
});

test('with tracking not set up, nothing is attempted and the bot works as before', async () => {
  stubWorld();
  tracking.isConfigured = () => false;
  const { say, tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
  await say('/start promo_AD10');
  const pass = await tap('go:plans:AD10');
  assert.match(textOf(pass), /AD10<\/b> applied/);
  assert.equal(events.length, 0);
});

test('a slow tracking sheet does not hold up the reply', async () => {
  stubWorld();
  let finished = false;
  tracking.safeRecord = async () => {
    await new Promise((r) => setTimeout(r, 200));
    finished = true;
  };
  const { app, sent } = makeBot('TELEGRAM_PAYBOT_UPSC');
  app.bot.processUpdate({ update_id: 1, message: { message_id: 1, date: 1, from: STUDENT, chat: { id: STUDENT.id, type: 'private' }, text: '/start promo_AD10' } });
  // The welcome goes out before the tracking write finishes...
  for (let i = 0; i < 50 && !sent.some((s) => s.method === 'sendMessage'); i++) await new Promise((r) => setImmediate(r));
  assert.ok(sent.some((s) => s.method === 'sendMessage'), 'the welcome waited on tracking');
  assert.equal(finished, false);
  // ...and settle() still waits for it, so the deployment does not freeze it half-written.
  await app.settle();
  assert.equal(finished, true);
});
