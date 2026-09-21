// ============================================================================
// Referrals through the bot (test/referral-bot.test.js)
// ============================================================================
// The student side of "invite a friend": the welcome screen, /about, getting a
// code, following a friend's link, and what actually reaches Razorpay's notes
// when a referred student pays. That last one is what the commission is later
// calculated from, so it is the assertion that matters most here.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret';
process.env.SHEET_URL_UPSC = 'https://script.google.com/macros/s/test-upsc/exec';
process.env.SHEET_TOKEN_UPSC = 'token-for-tests';
process.env.TELEGRAM_GROUP_UPSC = '-1009999999999';
process.env.TELEGRAM_PAYBOT_UPSC = '123:TEST';
delete process.env.SUPPORT_CHAT_ID;
delete process.env.SUPPORT_THREAD_ID;

const STUDENT = { id: 42, is_bot: false, first_name: 'Asha', username: 'asha' };
const FRIEND = { id: 77, is_bot: false, first_name: 'Ravi', username: 'ravi' };
const BOT = { id: 123, is_bot: true, first_name: 'Pay bot', username: 'upsc_pay_bot' };

const sheets = require('../src/sheets');
const razorpay = require('../src/razorpay');
const referrals = require('../src/referrals');
const { createPaymentBot } = require('../src/botapp');

require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};
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

/** Asha's code, owned by 42. */
const ASHA_CODE = { code: 'REFAJMXPQ', telegram_id: '42', username: 'asha', name: 'Asha K', status: 'active' };

/**
 * A sheet standing in for the family's primary sheet, with a referral store
 * that behaves like the real one: one code per member, idempotent on payment id.
 */
function fakeSheet(overrides = {}) {
  const codes = (overrides.codes || []).slice();
  const earnings = (overrides.earnings || []).slice();
  const calls = [];
  const record = (name, fn) => async (...args) => {
    calls.push({ name, args });
    return fn(...args);
  };

  const client = {
    calls, codes, earnings,
    getBotSettings: record('getBotSettings', async () => overrides.settings || {}),
    getSubscriber: record('getSubscriber', async () => overrides.subscriber || null),
    getCoupon: record('getCoupon', async () => null),
    createTicket: record('createTicket', async (t) => Object.assign({ status: 'open' }, t)),
    setTicketGroup: record('setTicketGroup', async () => ({})),
    listTickets: record('listTickets', async () => ({ total: 0, tickets: [], counts: {} })),
    getTicket: record('getTicket', async () => null),
    logTicketEvent: record('logTicketEvent', async () => ({})),
    listSubscribers: record('listSubscribers', async () => ({ total: 0, subscribers: [] })),
    findPayment: record('findPayment', async () => null),
    listCoupons: record('listCoupons', async () => []),

    listReferrals: record('listReferrals', async () => codes.slice()),
    getReferral: record('getReferral', async (code) =>
      codes.find((c) => c.code.toUpperCase() === String(code).toUpperCase()) || null),
    getReferralFor: record('getReferralFor', async (id) =>
      codes.find((c) => String(c.telegram_id) === String(id)) || null),
    createReferral: record('createReferral', async (r) => {
      const existing = codes.find((c) => String(c.telegram_id) === String(r.telegram_id));
      if (existing) return existing;
      const made = Object.assign({ status: 'active', created_at: 'now' }, r);
      codes.push(made);
      return made;
    }),
    listReferralEarnings: record('listReferralEarnings', async (code) =>
      earnings.filter((e) => !code || e.code === String(code).toUpperCase())),
    recordReferralEarning: record('recordReferralEarning', async (e) => {
      if (earnings.some((x) => x.payment_id === e.payment_id)) return { recorded: false };
      earnings.push(e);
      return { recorded: true };
    }),
    settleReferralEarnings: record('settleReferralEarnings', async () => ({ settled: 0, paise: 0 }))
  };
  Object.entries(overrides.methods || {}).forEach(([name, fn]) => { client[name] = record(name, fn); });
  return client;
}

/** A bot wired to a fake sheet, with every Telegram call recorded. */
function makeBot(sheetOptions = {}) {
  const sheet = fakeSheet(sheetOptions);
  sheets.forGroup = () => sheet;

  const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_UPSC', polling: false });
  const sent = [];
  let nextId = 1000;
  ['sendMessage', 'answerCallbackQuery', 'copyMessage', 'editMessageText', 'deleteMessage']
    .forEach((method) => {
      app.bot[method] = async (...args) => {
        sent.push({ method, args });
        return { message_id: nextId++, chat: { id: args[0] } };
      };
    });
  app.bot.getMe = async () => BOT;
  app.bot.getChatMember = async () => ({ status: 'left' });

  const deliver = async (update) => {
    app.bot.processUpdate(Object.assign({ update_id: nextId++ }, update));
    await app.settle();
  };
  const messages = (chatId) => sent.filter((s) => s.method === 'sendMessage' &&
    (chatId === undefined || String(s.args[0]) === String(chatId)));

  return { app, sheet, sent, deliver, messages };
}

let seq = 1;
const privateMessage = (text, from = STUDENT) => ({
  message: { message_id: seq++, date: 1, from, chat: { id: from.id, type: 'private' }, text }
});
const tap = (data, from = STUDENT) => ({
  callback_query: {
    id: 'cb' + seq++, from, data,
    message: { message_id: seq++, chat: { id: from.id, type: 'private' }, from: BOT, text: 'x' }
  }
});

/** The text of the last message sent to a chat. */
const lastText = (messages, chatId) => {
  const all = messages(chatId);
  return all.length ? all[all.length - 1].args[1] : '';
};

// ---------------------------------------------------------------------------
// The welcome screen
// ---------------------------------------------------------------------------

test('/start is one welcome message with a Continue button, not a wall of text', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/start'));

  const all = messages(STUDENT.id);
  assert.equal(all.length, 1, 'the pass is shown after Continue, not unasked');
  assert.match(all[0].args[1], /Welcome to/);
  assert.match(all[0].args[1], /Hello Asha/);
  // The paragraph the admin gave, word for word.
  assert.match(all[0].args[1], /daily practice questions from Eenadu, Sakshi &amp; Nipuna in poll format/);
  assert.match(all[0].args[1], /Telugu and English mediums/);
  assert.equal(all[0].args[2].reply_markup.inline_keyboard[0][0].text, 'Continue →');
  assert.equal(all[0].args[2].reply_markup.inline_keyboard[0][0].callback_data, 'go:plans');
});

test('Continue shows the pass', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/start'));
  await deliver(tap('go:plans'));

  assert.match(lastText(messages, STUDENT.id), /Price/);
});

test('/about says the same thing and lists the commands', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/about'));

  const text = lastText(messages, STUDENT.id);
  assert.match(text, /daily practice questions from Eenadu, Sakshi &amp; Nipuna in poll format/);
  assert.match(text, /Telugu and English mediums/);
  assert.match(text, /\/referral/);
  assert.match(text, /\/support/);
});

// ---------------------------------------------------------------------------
// Getting a code
// ---------------------------------------------------------------------------

test('/referral issues a code on first use and shows the terms', async () => {
  const { deliver, messages, sheet } = makeBot();
  await deliver(privateMessage('/referral'));

  const text = lastText(messages, STUDENT.id);
  assert.equal(sheet.codes.length, 1, 'a code was made');
  assert.ok(referrals.isCode(sheet.codes[0].code));
  assert.equal(sheet.codes[0].telegram_id, '42');
  assert.match(text, /10% off/);
  assert.match(text, /20%/);
  assert.match(text, new RegExp(sheet.codes[0].code));
  assert.match(text, /t\.me\/upsc_pay_bot\?start=ref_/, 'the share link is theirs to send');
});

test('/referral twice does not make a second code', async () => {
  const { deliver, sheet } = makeBot({ codes: [ASHA_CODE] });
  await deliver(privateMessage('/referral'));
  await deliver(privateMessage('/referral'));
  assert.equal(sheet.codes.length, 1);
});

test('the referral card counts what has been earned and what is owed', async () => {
  const { deliver, messages } = makeBot({
    codes: [ASHA_CODE],
    earnings: [
      { code: 'REFAJMXPQ', commission_paise: 3582, status: 'pending' },
      { code: 'REFAJMXPQ', commission_paise: 3582, status: 'paid' }
    ]
  });
  await deliver(privateMessage('/referral'));

  const text = lastText(messages, STUDENT.id);
  assert.match(text, /Joined using your code: <b>2<\/b>/);
  assert.match(text, /Earned so far: <b>₹71\.64<\/b>/);
  assert.match(text, /Waiting to be paid: <b>₹35\.82<\/b>/);
  assert.match(text, /Already paid to you: <b>₹35\.82<\/b>/);
  assert.match(text, /₹1,?000/, 'the payout threshold is stated');
});

test('a member over the threshold can ask to be paid', async () => {
  const { deliver, messages, sheet } = makeBot({
    codes: [ASHA_CODE],
    earnings: [{ code: 'REFAJMXPQ', commission_paise: 120000, status: 'pending' }]
  });
  await deliver(privateMessage('/referral'));
  assert.match(lastText(messages, STUDENT.id), /reached ₹1,?000/);

  await deliver(tap('ref:payout'));
  // A ticket, not an automatic transfer: money leaving the business is a
  // decision a person makes.
  const ticket = sheet.calls.find((c) => c.name === 'createTicket');
  assert.ok(ticket, 'no ticket was raised for the payout request');
  assert.match(ticket.args[0].message, /Referral payout requested/);
  assert.match(ticket.args[0].message, /REFAJMXPQ/);
  assert.match(lastText(messages, STUDENT.id), /₹1,?200(\.00)?/);
});

test('asking for a payout with nothing owed says so instead of raising a ticket', async () => {
  const { deliver, messages, sheet } = makeBot({ codes: [ASHA_CODE] });
  await deliver(tap('ref:payout'));
  assert.match(lastText(messages, STUDENT.id), /nothing waiting to be paid/);
  assert.equal(sheet.calls.filter((c) => c.name === 'createTicket').length, 0);
});

// ---------------------------------------------------------------------------
// Following a friend's link
// ---------------------------------------------------------------------------

test('a share link applies the discount on the first screen the friend sees', async () => {
  const { deliver, messages } = makeBot({ codes: [ASHA_CODE] });

  await deliver(privateMessage('/start ref_REFAJMXPQ', FRIEND));
  assert.match(lastText(messages, FRIEND.id), /A friend invited you/);

  await deliver(tap('go:plans', FRIEND));
  const pass = lastText(messages, FRIEND.id);
  assert.match(pass, /Referral <b>REFAJMXPQ<\/b> applied/);
  // ₹199 becomes ₹179.10, and the student is shown both.
  assert.match(pass, /₹179\.10/);
  assert.match(pass, /you save ₹19\.90/);
});

test('a link to a code that cannot be used charges full price and says why', async () => {
  // Silently charging full price after someone followed a friend's link is
  // indistinguishable from a bug.
  const { deliver, messages } = makeBot({ codes: [ASHA_CODE] });

  // Asha following her own link.
  await deliver(privateMessage('/start ref_REFAJMXPQ', STUDENT));
  await deliver(tap('go:plans', STUDENT));

  const texts = messages(STUDENT.id).map((m) => m.args[1]);
  assert.ok(texts.some((t) => /₹199/.test(t) && !/Referral <b>/.test(t)), 'the pass was discounted anyway');
  assert.ok(texts.some((t) => /could not be used/.test(t) && /your own referral code/.test(t)));
});

test('a referral is refused for somebody who has already paid', async () => {
  const { deliver, messages } = makeBot({
    codes: [ASHA_CODE],
    subscriber: { status: 'active', expiry_date: '30-11-2099', payment_id: 'pay_OLD' }
  });
  await deliver(privateMessage('/start ref_REFAJMXPQ', FRIEND));
  await deliver(tap('go:plans', FRIEND));

  const texts = messages(FRIEND.id).map((m) => m.args[1]);
  assert.ok(texts.some((t) => /could not be used/.test(t) && /first pass/.test(t)));
});

test('an unknown code in a link is reported, not silently swallowed', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/start ref_REFWMXD9N', FRIEND));
  await deliver(tap('go:plans', FRIEND));
  assert.ok(messages(FRIEND.id).some((m) => /does not exist/.test(m.args[1])));
});

// ---------------------------------------------------------------------------
// Paying with a referral
// ---------------------------------------------------------------------------

test('what reaches Razorpay carries the code, the inviter and the commission', async () => {
  // This is what the webhook later credits from, so it is the assertion that
  // decides whether anyone is ever paid the right amount.
  const { deliver } = makeBot({ codes: [ASHA_CODE] });
  const created = [];
  const realCreate = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (options) => {
    created.push(options);
    return { short_url: 'https://rzp.io/i/test' };
  };

  try {
    await deliver(tap('buy:upsc:exam_pass:REFAJMXPQ', FRIEND));
  } finally {
    razorpay.createPaymentLink = realCreate;
  }

  assert.equal(created.length, 1, 'no payment link was created');
  const notes = created[0].extraNotes;
  assert.equal(notes.referral_code, 'REFAJMXPQ');
  assert.equal(notes.referrer_telegram_id, '42');
  assert.equal(notes.original_amount, '199');
  assert.equal(notes.discount_amount, '19.9');
  // 20% of ₹179.10, not 20% of ₹199.
  assert.equal(notes.commission_amount, '35.82');
  assert.equal(notes.coupon_code, undefined, 'a referral is not a coupon');
  // And the student is charged the discounted price, not the sticker price.
  assert.equal(created[0].plan.amountPaise, 17910);
});

test('a referral on the button is re-checked, never trusted', async () => {
  // A tap on yesterday's message must not buy at yesterday's terms — by then
  // the code may have been switched off, or the student may have bought a pass.
  const { deliver, messages } = makeBot({
    codes: [Object.assign({}, ASHA_CODE, { status: 'disabled' })]
  });
  const created = [];
  const realCreate = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (o) => { created.push(o); return { short_url: 'x' }; };

  try {
    await deliver(tap('buy:upsc:exam_pass:REFAJMXPQ', FRIEND));
  } finally {
    razorpay.createPaymentLink = realCreate;
  }

  assert.equal(created.length, 0, 'a disabled code still bought at a discount');
  assert.match(lastText(messages, FRIEND.id), /no longer active/);
});
