// ============================================================================
// Influencer promo codes in the payment bots (test/promo-bot.test.js)
// ============================================================================
// A student meets an influencer's code two ways: by typing it at checkout, or
// by opening the influencer's link, which starts the bot with it applied. In
// both, the code must be honoured only by the bot of the exam it was approved
// for, and what reaches Razorpay's notes is what the influencer is later paid
// from — so that is asserted most carefully.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret';
process.env.LEGACY_GROUP_ID = '';
process.env.EXAM_PASS_END_DATE = '30-11-2099';
for (const prefix of ['UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + (prefix === 'UPSC' ? '11' : '22');
}
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
process.env.TELEGRAM_PAYBOT_EPFO = '444:TEST';
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
const { createPaymentBot } = require('../src/botapp');
// Code tracking off: a local .env would otherwise point it at the real sheets.
require('../src/code-tracking').isConfigured = () => false;

const STUDENT = { id: 900, is_bot: false, first_name: 'Kiran', username: 'kiran' };

/** Ravi's UPSC code, as the Codes tab holds it. */
const RAVI_UPSC = {
  code: 'RAVIUPSC27', exam: 'upsc', exam_bot: 'TELEGRAM_PAYBOT_UPSC', telegram_id: '501', status: 'active',
  discount_type: 'percent', discount_value: '10', commission_type: 'percent', commission_value: '20',
  payout_cycle: 'weekly', min_payout: '0', expires_on: '', max_uses: '', one_per_student: 'yes'
};

function makeBot(payBotEnv, { codes = [RAVI_UPSC], usage = { uses: 0, usesByStudent: 0 }, coupons = {} } = {}) {
  sheets.forGroup = () => ({
    getBotSettings: async () => ({}),
    getSubscriber: async () => null,
    getCoupon: async (code) => coupons[code] || null
  });
  store.isConfigured = () => true;
  store.getCode = async (code) => codes.find((c) => c.code === String(code).toUpperCase()) || null;
  store.usageOf = async () => usage;

  const app = createPaymentBot({ payBotEnv, polling: false });
  const sent = [];
  let id = 1000;
  const record = (method) => async (...args) => { sent.push({ method, args }); return { message_id: id++ }; };
  ['sendMessage', 'sendChatAction', 'answerCallbackQuery', 'editMessageText', 'editMessageReplyMarkup']
    .forEach((m) => { app.bot[m] = record(m); });
  app.bot.getMe = async () => ({ id: 1, is_bot: true, username: 'test_pay_bot' });

  let seq = 1;
  const deliver = async (update) => {
    const before = sent.length;
    app.bot.processUpdate(Object.assign({ update_id: seq++ }, update));
    await app.settle();
    return sent.slice(before).filter((s) => s.method === 'sendMessage');
  };
  const say = (text, extra = {}) => deliver({ message: Object.assign({
    message_id: seq++, date: 1, from: STUDENT, chat: { id: STUDENT.id, type: 'private' }, text }, extra) });
  const tap = (data) => deliver({ callback_query: { id: 'cb' + seq++, from: STUDENT, data,
    message: { message_id: 1, date: 1, chat: { id: STUDENT.id, type: 'private' }, text: '…' } } });
  /** A reply to the "Coupon code for …" prompt. */
  const typeCode = (groupShortName, code) => say(code, { reply_to_message: {
    // The bot only reads replies to its OWN prompts: its id is the token's prefix.
    message_id: 5, from: { id: Number(String(process.env[payBotEnv]).split(':')[0]), is_bot: true, username: 'test_pay_bot' },
    chat: { id: STUDENT.id, type: 'private' }, text: `🎟 Coupon code for ${groupShortName}\n\nType your coupon or promo code…` } });
  return { app, sent, say, tap, typeCode };
}

const buttons = (messages) => messages.flatMap((m) =>
  ((m.args[2] && m.args[2].reply_markup && m.args[2].reply_markup.inline_keyboard) || []).flat());

test('a promo code typed at checkout is applied, with the new price shown before paying', async () => {
  const { typeCode } = makeBot('TELEGRAM_PAYBOT_UPSC');
  const out = await typeCode('UPSC Prelims', 'raviupsc27');
  assert.equal(out.length, 1);
  assert.match(out[0].args[1], /Promo code <b>RAVIUPSC27<\/b> applied — 10% off/);
  assert.match(out[0].args[1], /<s>₹199<\/s> <b>₹179\.10<\/b>/);
  const pay = buttons(out).find((b) => /^buy:/.test(b.callback_data));
  assert.equal(pay.callback_data, 'buy:upsc:exam_pass:RAVIUPSC27');
  assert.ok(buttons(out).some((b) => b.text === '✖️ Remove promo code'));
});

test('the UPSC influencer\'s code is refused by the EPFO bot, saying which exam it is for', async () => {
  const { typeCode } = makeBot('TELEGRAM_PAYBOT_EPFO');
  const out = await typeCode('EPFO', 'RAVIUPSC27');
  assert.match(out[0].args[1], /RAVIUPSC27<\/b>: That code is for UPSC and cannot be used here/);
  assert.ok(!buttons(out).some((b) => /^buy:.*RAVIUPSC27/.test(b.callback_data)), 'a Pay button carried the refused code');
});

test('paying with a promo code puts the influencer\'s commission in the payment\'s notes', async () => {
  const created = [];
  const real = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (options) => { created.push(options); return { short_url: 'https://rzp.io/i/x' }; };
  try {
    const { tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
    const out = await tap('buy:upsc:exam_pass:RAVIUPSC27');
    assert.equal(created.length, 1);
    assert.equal(created[0].plan.amountPaise, 17910, 'the student is charged the discounted price');
    assert.deepEqual(
      Object.fromEntries(['promo_code', 'affiliate_id', 'commission_amount', 'original_amount', 'discount_amount']
        .map((k) => [k, created[0].extraNotes[k]])),
      { promo_code: 'RAVIUPSC27', affiliate_id: '501', commission_amount: '35.82', original_amount: '199', discount_amount: '19.9' });
    assert.equal(created[0].extraNotes.coupon_code, undefined, 'a promo code is not recorded as a coupon');
    assert.match(out.at(-1).args[1], /promo code RAVIUPSC27, you save ₹19\.90/);
  } finally {
    razorpay.createPaymentLink = real;
  }
});

test('a promo code paused after the price was shown is re-checked at Pay', async () => {
  const created = [];
  const real = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (options) => { created.push(options); return { short_url: 'x' }; };
  try {
    const { tap } = makeBot('TELEGRAM_PAYBOT_UPSC', { codes: [Object.assign({}, RAVI_UPSC, { status: 'paused' })] });
    const out = await tap('buy:upsc:exam_pass:RAVIUPSC27');
    assert.equal(created.length, 0, 'a link was created with a paused code');
    assert.match(out.at(-1).args[1], /not active/);
  } finally {
    razorpay.createPaymentLink = real;
  }
});

test('an influencer\'s link starts the bot with their code applied on the price screen', async () => {
  const { say, tap } = makeBot('TELEGRAM_PAYBOT_UPSC');
  const welcome = await say('/start promo_RAVIUPSC27');
  assert.match(welcome[0].args[1], /Promo code <b>RAVIUPSC27<\/b> will be applied/);
  const pass = await tap('go:plans');
  assert.match(pass[0].args[1], /RAVIUPSC27<\/b> applied/);
  assert.match(pass[0].args[1], /₹179\.10/);
});

test('an influencer\'s link for another exam is refused out loud, not silently ignored', async () => {
  const { say, tap } = makeBot('TELEGRAM_PAYBOT_EPFO');
  await say('/start promo_RAVIUPSC27');
  const pass = await tap('go:plans');
  assert.match(pass[0].args[1], /₹199/);
  assert.doesNotMatch(pass[0].args[1], /applied/);
  assert.match(pass[1].args[1], /promo link you followed could not be used: That code is for UPSC/);
});

test('a code that is not an influencer\'s still works as a coupon', async () => {
  const { typeCode } = makeBot('TELEGRAM_PAYBOT_UPSC', {
    coupons: { DIWALI20: { code: 'DIWALI20', discount_type: 'flat', discount_value: 20, active: true, one_per_student: true, used_by_student: 0 } }
  });
  const out = await typeCode('UPSC Prelims', 'diwali20');
  assert.match(out[0].args[1], /Coupon <b>DIWALI20<\/b> applied/);
  assert.match(out[0].args[1], /₹179/);
});

test('without the influencer sheet, coupons carry on working', async () => {
  const { typeCode } = makeBot('TELEGRAM_PAYBOT_UPSC', {
    coupons: { DIWALI20: { code: 'DIWALI20', discount_type: 'flat', discount_value: 20, active: true, used_by_student: 0 } }
  });
  store.isConfigured = () => false;
  store.getCode = async () => { throw new Error('the store was asked while not configured'); };
  const out = await typeCode('UPSC Prelims', 'DIWALI20');
  assert.match(out[0].args[1], /Coupon <b>DIWALI20<\/b> applied/);
});

test('member referrals are gone: /referral is an unknown command, and old buttons say so', async () => {
  const { say, tap, sent } = makeBot('TELEGRAM_PAYBOT_UPSC');
  const out = await say('/referral');
  assert.match(out[0].args[1], /do not know that command/);
  assert.doesNotMatch(out[0].args[1], /\/referral/);
  await tap('ref:card');
  const ack = sent.filter((s) => s.method === 'answerCallbackQuery').at(-1);
  assert.match(ack.args[1].text, /referrals have ended/i);
  const welcome = await say('/start');
  assert.ok(!buttons(welcome).some((b) => /referral/i.test(b.text)), 'the welcome still offers referrals');
});
