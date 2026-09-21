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
    settleReferralEarnings: record('settleReferralEarnings', async () => ({ settled: 0, paise: 0 })),
    recordReferralOpen: record('recordReferralOpen', async () => ({ recorded: true, opens: 1 }))
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
  assert.match(lastText(messages, STUDENT.id), /reached <b>₹1,?000<\/b>/);

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

// ---------------------------------------------------------------------------
// The rules, stated
// ---------------------------------------------------------------------------
// These four are what was asked for in words, pinned so a later change cannot
// quietly undo one of them.

test('one member has exactly one code, however many times they ask', async () => {
  const { deliver, sheet } = makeBot();
  for (let i = 0; i < 5; i++) await deliver(privateMessage('/referral'));
  assert.equal(sheet.codes.length, 1, 'a second code would split their earnings in two');
  assert.equal(sheet.codes[0].telegram_id, '42');
});

test('any number of people can join on one code', async () => {
  // The limit is one referral per BUYER, never a cap on the code itself.
  const many = Array.from({ length: 25 }, (_, i) => ({
    code: 'REFAJMXPQ', referrer_telegram_id: '42',
    referred_telegram_id: String(1000 + i), commission_paise: 3582, status: 'pending'
  }));
  const { deliver, messages } = makeBot({ codes: [ASHA_CODE], earnings: many });

  await deliver(privateMessage('/referral'));
  assert.match(lastText(messages, STUDENT.id), /Joined using your code: <b>25<\/b>/);

  // And a twenty-sixth buyer is still allowed to use it.
  const result = referrals.evaluateReferral(ASHA_CODE, {
    amountPaise: 19900, buyerTelegramId: '9999', buyerReferredCount: 0
  });
  assert.equal(result.ok, true);
});

test('the claim button appears at ₹1000 and not a rupee before', async () => {
  const cardFor = async (paise) => {
    const { deliver, messages } = makeBot({
      codes: [ASHA_CODE],
      earnings: [{ code: 'REFAJMXPQ', commission_paise: paise, status: 'pending' }]
    });
    await deliver(privateMessage('/referral'));
    const all = messages(STUDENT.id);
    return all[all.length - 1].args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  };

  assert.ok(!(await cardFor(99999)).includes('ref:payout'), '₹999.99 offered a claim');
  assert.ok((await cardFor(100000)).includes('ref:payout'), '₹1000 did not offer a claim');
  assert.ok((await cardFor(250000)).includes('ref:payout'));
});

test('the member can see how many joined and what each state is worth', async () => {
  const { deliver, messages } = makeBot({
    codes: [ASHA_CODE],
    earnings: [
      { code: 'REFAJMXPQ', commission_paise: 60000, status: 'pending' },
      { code: 'REFAJMXPQ', commission_paise: 60000, status: 'pending' },
      { code: 'REFAJMXPQ', commission_paise: 40000, status: 'paid' },
      { code: 'REFAJMXPQ', commission_paise: 99999, status: 'cancelled' }
    ]
  });
  await deliver(privateMessage('/referral'));

  const text = lastText(messages, STUDENT.id);
  assert.match(text, /Joined using your code: <b>3<\/b>/, 'a cancelled earning is not a join');
  assert.match(text, /Earned so far: <b>₹1600<\/b>/);
  assert.match(text, /Waiting to be paid: <b>₹1200<\/b>/);
  assert.match(text, /Already paid to you: <b>₹400<\/b>/);
});

// ---------------------------------------------------------------------------
// The second way to reach a human
// ---------------------------------------------------------------------------

test('the support email is offered when a ticket is raised', async () => {
  const { deliver, messages } = makeBot();

  // Free text asks before it opens anything, so the ticket is confirmed first.
  const typed = privateMessage('My payment failed');
  await deliver(typed);
  assert.match(lastText(messages, STUDENT.id), /send this message to our support team/);

  // "Send to support" acts on the message it was offered under, so the tap has
  // to carry it the way Telegram does.
  await deliver({
    callback_query: {
      id: 'cb-send', from: STUDENT, data: 'sup:send',
      message: {
        message_id: seq++, chat: { id: STUDENT.id, type: 'private' }, from: BOT,
        text: 'Would you like to send this message to our support team?',
        reply_to_message: typed.message
      }
    }
  });

  const texts = messages(STUDENT.id).map((m) => m.args[1]).join('\n');
  assert.match(texts, /appscsadhana@gmail\.com/);
  assert.match(texts, /If you do not hear back/);
});

test('the support menu carries the email too', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/support'));
  assert.match(lastText(messages, STUDENT.id), /appscsadhana@gmail\.com/);
});

test('a follow-up nobody has answered offers the email more insistently', async () => {
  // The case the email exists for: they have asked twice and had nothing back.
  const { deliver, messages } = makeBot({
    methods: {
      getTicket: async () => ({
        ticket_id: 'T-260921-AB2C', telegram_id: '42', status: 'open',
        admin_replies: 0, updated_at: new Date().toISOString()
      }),
      listTickets: async () => ({
        total: 1, counts: {},
        tickets: [{ ticket_id: 'T-260921-AB2C', telegram_id: '42', status: 'open', admin_replies: 0,
          updated_at: new Date().toISOString() }]
      }),
      appendTicketMessage: async (id) => ({ ticket_id: id, status: 'open', admin_replies: 0, waiting_on: 'admin' })
    }
  });

  await deliver(privateMessage('Still nothing?'));
  const text = messages(STUDENT.id).map((m) => m.args[1]).join('\n');
  assert.match(text, /Still waiting\?/);
  assert.match(text, /appscsadhana@gmail\.com/);
});

test('a follow-up on a ticket an admin HAS answered does not nag about email', async () => {
  const { deliver, messages } = makeBot({
    methods: {
      getTicket: async () => ({
        ticket_id: 'T-260921-AB2C', telegram_id: '42', status: 'in_progress',
        admin_replies: 2, updated_at: new Date().toISOString()
      }),
      listTickets: async () => ({
        total: 1, counts: {},
        tickets: [{ ticket_id: 'T-260921-AB2C', telegram_id: '42', status: 'in_progress', admin_replies: 2,
          updated_at: new Date().toISOString() }]
      }),
      appendTicketMessage: async (id) => ({ ticket_id: id, status: 'in_progress', admin_replies: 2, waiting_on: 'admin' })
    }
  });

  await deliver(privateMessage('One more thing'));
  const text = messages(STUDENT.id).map((m) => m.args[1]).join('\n');
  assert.ok(!/Still waiting\?/.test(text), 'an answered ticket was told it was being ignored');
});

test('/help and /about both carry the email', async () => {
  for (const command of ['/help', '/about']) {
    const { deliver, messages } = makeBot();
    await deliver(privateMessage(command));
    assert.match(lastText(messages, STUDENT.id), /appscsadhana@gmail\.com/, `${command} omits the email`);
  }
});

test('an admin can change the support email, and a blank cell keeps the default', async () => {
  const { deliver, messages } = makeBot({ settings: { support_email: 'help@example.org' } });
  await deliver(privateMessage('/help'));
  assert.match(lastText(messages, STUDENT.id), /help@example\.org/);
  assert.ok(!/appscsadhana/.test(lastText(messages, STUDENT.id)));

  // Not optional on purpose: the second door is a standing promise, so an
  // empty cell falls back to the default rather than quietly removing it.
  const blank = makeBot({ settings: { support_email: '' } });
  await blank.deliver(privateMessage('/help'));
  assert.match(lastText(blank.messages, STUDENT.id), /appscsadhana@gmail\.com/);
});

// ---------------------------------------------------------------------------
// Two groups in one family
// ---------------------------------------------------------------------------
// Found by running the real bot: the news family sells two groups, so Continue
// shows a picker rather than a pass. Choosing a group used the same callback as
// "remove what is applied", which dropped the code the student had arrived
// with — referrals could never work at all in a two-group family.

/** A bot for the two-group news family, wired to a fake sheet. */
function makeNewsBot(sheetOptions = {}) {
  const sheet = fakeSheet(sheetOptions);
  sheets.forGroup = () => sheet;
  process.env.TELEGRAM_PAYBOT_NEWS = process.env.TELEGRAM_PAYBOT_NEWS || '124:TEST';

  const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_NEWS', polling: false });
  const sent = [];
  let nextId = 5000;
  ['sendMessage', 'answerCallbackQuery', 'copyMessage', 'editMessageText', 'deleteMessage']
    .forEach((method) => {
      app.bot[method] = async (...args) => { sent.push({ method, args }); return { message_id: nextId++ }; };
    });
  app.bot.getMe = async () => BOT;
  app.bot.getChatMember = async () => ({ status: 'left' });

  const deliver = async (update) => {
    app.bot.processUpdate(Object.assign({ update_id: nextId++ }, update));
    await app.settle();
  };
  const messages = (chatId) => sent.filter((s) => s.method === 'sendMessage' &&
    (chatId === undefined || String(s.args[0]) === String(chatId)));
  const groups = app.familyGroups();
  return { app, sheet, deliver, messages, groups };
}

test('a referral survives the group picker in a two-group family', async () => {
  const { deliver, messages, groups } = makeNewsBot({ codes: [ASHA_CODE] });
  assert.ok(groups.length > 1, 'this family should sell more than one group');

  await deliver(privateMessage('/start ref_REFAJMXPQ', FRIEND));
  await deliver(tap('go:plans', FRIEND));
  assert.match(lastText(messages, FRIEND.id), /Which group/);

  // The moment the code used to be lost.
  await deliver(tap(`pick:${groups[0].id}`, FRIEND));
  const pass = lastText(messages, FRIEND.id);
  assert.match(pass, /Referral <b>REFAJMXPQ<\/b> applied/,
    'picking a group dropped the code the student arrived with');
  assert.match(pass, /₹179\.10/);
});

test('"Remove referral" clears it, and picking a group afterwards does not bring it back', async () => {
  const { deliver, messages, groups } = makeNewsBot({ codes: [ASHA_CODE] });

  await deliver(privateMessage('/start ref_REFAJMXPQ', FRIEND));
  await deliver(tap(`pick:${groups[0].id}`, FRIEND));
  assert.match(lastText(messages, FRIEND.id), /Referral <b>REFAJMXPQ<\/b> applied/);

  await deliver(tap(`plain:${groups[0].id}`, FRIEND));
  const plain = lastText(messages, FRIEND.id);
  assert.ok(!/Referral <b>/.test(plain), 'Remove did not remove it');
  assert.match(plain, /₹199/);
});

test('a code that cannot be used is not re-offered on every screen', async () => {
  const { deliver, messages, groups } = makeNewsBot({ codes: [ASHA_CODE] });

  // Asha following her own link, in a two-group family.
  await deliver(privateMessage('/start ref_REFAJMXPQ', STUDENT));
  await deliver(tap(`pick:${groups[0].id}`, STUDENT));
  const first = messages(STUDENT.id).map((m) => m.args[1]).join('\n');
  assert.match(first, /could not be used/);
  assert.match(first, /your own referral code/);

  // Looking at the other group must not repeat the refusal.
  const before = messages(STUDENT.id).length;
  await deliver(tap(`pick:${groups[1].id}`, STUDENT));
  const after = messages(STUDENT.id).slice(before).map((m) => m.args[1]).join('\n');
  assert.ok(!/could not be used/.test(after), 'the refusal was repeated on the next screen');
});

// ---------------------------------------------------------------------------
// The lifetime pass, as a student sees it
// ---------------------------------------------------------------------------

test('the newspaper bot offers lifetime access, with no end date', async () => {
  const { deliver, messages, groups } = makeNewsBot();
  await deliver(tap(`pick:${groups[0].id}`, FRIEND));

  const card = lastText(messages, FRIEND.id);
  assert.match(card, /Lifetime access/);
  assert.match(card, /pay once, never renew/);
  assert.ok(!/Valid until/.test(card), 'a lifetime pass was shown an end date');
});

test('the other bots still show the exam pass and its end date', async () => {
  // Deliberately the UPSC bot: the change is for the newspaper groups only.
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/plans', FRIEND));

  const card = lastText(messages, FRIEND.id);
  assert.match(card, /Valid until/, 'the UPSC pass lost its end date');
  assert.ok(!/Lifetime/.test(card), 'the UPSC bot started offering lifetime access');
});

test('what reaches Razorpay for a lifetime pass names it, and carries no end date', async () => {
  const { deliver, groups } = makeNewsBot();
  const created = [];
  const realCreate = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (o) => { created.push(o); return { short_url: 'https://rzp.io/i/x' }; };
  try {
    await deliver(tap(`buy:${groups[0].id}:lifetime_pass`, FRIEND));
  } finally {
    razorpay.createPaymentLink = realCreate;
  }

  assert.equal(created.length, 1, 'no payment link was created');
  assert.equal(created[0].plan.id, 'lifetime_pass');
  assert.equal(created[0].plan.amountPaise, 19900);
  // With no valid_until in the notes, the webhook falls back to the plan
  // itself — which for a lifetime pass means no end.
  assert.equal(created[0].extraNotes.valid_until, undefined);
});

test('an old exam-pass button in the newspaper bot is refused rather than sold', async () => {
  // A tap on a message sent before the change must not sell the pass that is
  // no longer on offer.
  const { deliver, messages, groups } = makeNewsBot();
  const created = [];
  const realCreate = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (o) => { created.push(o); return { short_url: 'x' }; };
  try {
    await deliver(tap(`buy:${groups[0].id}:exam_pass`, FRIEND));
  } finally {
    razorpay.createPaymentLink = realCreate;
  }
  assert.equal(created.length, 0, 'a retired exam-pass button still sold a pass');
  assert.ok(messages(FRIEND.id).some((m) => /Lifetime access/.test(m.args[1])),
    'the student was not shown what IS on sale');
});

test('someone who already has lifetime access is not charged again', async () => {
  const { deliver, messages, groups } = makeNewsBot({
    subscriber: { status: 'active', plan: 'lifetime_pass', plan_label: 'Lifetime Pass',
      expiry_date: '31-12-2099, 11:59:59 PM IST', payment_id: 'pay_1' }
  });
  const created = [];
  const realCreate = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (o) => { created.push(o); return { short_url: 'x' }; };
  try {
    await deliver(tap(`buy:${groups[0].id}:lifetime_pass`, FRIEND));
  } finally {
    razorpay.createPaymentLink = realCreate;
  }
  assert.equal(created.length, 0, 'a lifetime member was sold a second lifetime pass');
  assert.match(lastText(messages, FRIEND.id), /already have <b>lifetime access<\/b>/);
});

test('an exam-pass holder in the newspaper group can upgrade to lifetime', async () => {
  // Their exam pass runs out on exam day. Lifetime is genuinely more, so this
  // is a real purchase — the "you already own this" guard must not block it.
  const { deliver, groups } = makeNewsBot({
    subscriber: { status: 'active', plan: 'exam_pass', plan_label: 'Target 2026 Pass',
      expiry_date: '30-11-2026, 11:59:59 PM IST', payment_id: 'pay_1' }
  });
  const created = [];
  const realCreate = razorpay.createPaymentLink;
  razorpay.createPaymentLink = async (o) => { created.push(o); return { short_url: 'x' }; };
  try {
    await deliver(tap(`buy:${groups[0].id}:lifetime_pass`, FRIEND));
  } finally {
    razorpay.createPaymentLink = realCreate;
  }
  assert.equal(created.length, 1, 'an exam-pass holder could not upgrade to lifetime');
  assert.equal(created[0].plan.id, 'lifetime_pass');
});

test('/help in the newspaper bot does not promise an expiry reminder', async () => {
  const { deliver, messages } = makeNewsBot();
  await deliver(privateMessage('/help', FRIEND));
  const text = lastText(messages, FRIEND.id);
  assert.match(text, /for life/);
  assert.ok(!/reminder before your pass ends/.test(text));
});

// ---------------------------------------------------------------------------
// /referral as its own section
// ---------------------------------------------------------------------------

test('the welcome screen has its own referral button, separate from buying', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/start'));
  const buttons = messages(STUDENT.id)[0].args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['go:plans', 'ref:card']);
});

test('the payment card no longer carries the referral button', async () => {
  // Tucked under Pay, it read as part of buying and members could not find
  // their own code again afterwards.
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/plans'));
  const buttons = messages(STUDENT.id).pop().args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!buttons.includes('ref:card'), 'referral is still inside the payment card');
});

test('the referral card shows the code to copy, the numbers, and who joined', async () => {
  const { deliver, messages } = makeBot({
    codes: [Object.assign({}, ASHA_CODE, { link_opens: '5' })],
    earnings: [
      { code: 'REFAJMXPQ', referred_name: 'Ravi Teja', referred_telegram_id: '222',
        timestamp: '19-09-2026, 10:00:00 AM IST', commission_paise: 3582, status: 'paid' },
      { code: 'REFAJMXPQ', referred_name: 'Meena', referred_telegram_id: '333',
        timestamp: '21-09-2026, 11:30:00 AM IST', commission_paise: 3582, status: 'pending' }
    ]
  });
  await deliver(privateMessage('/referral'));
  const text = lastText(messages, STUDENT.id);

  assert.match(text, /<code>REFAJMXPQ<\/code>/, 'the code is not tap-to-copy');
  assert.match(text, /Opened your link: <b>5<\/b>/);
  assert.match(text, /Joined using your code: <b>2<\/b>/);
  assert.match(text, /Who joined/);
  // Newest first, first names only — never another person's Telegram id.
  assert.match(text, /1\. Meena · 21-09-2026 · ₹35\.82 ⏳ pending/);
  assert.match(text, /2\. Ravi · 19-09-2026 · ₹35\.82 ✅ paid/);
  assert.ok(!/222|333/.test(text), 'a friend\'s Telegram id was shown to another member');
});

test('the card says how far a member is from being able to claim', async () => {
  const { deliver, messages } = makeBot({
    codes: [ASHA_CODE],
    earnings: [{ code: 'REFAJMXPQ', commission_paise: 60000, status: 'pending' }]
  });
  await deliver(privateMessage('/referral'));
  assert.match(lastText(messages, STUDENT.id), /₹400 to go/);
});

test('a long list of joins is cut short rather than filling the chat', async () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    code: 'REFAJMXPQ', referred_name: 'Friend' + i, commission_paise: 3582, status: 'pending',
    timestamp: '21-09-2026, 10:00:00 AM IST'
  }));
  const { deliver, messages } = makeBot({ codes: [ASHA_CODE], earnings: many });
  await deliver(privateMessage('/referral'));
  const text = lastText(messages, STUDENT.id);
  assert.match(text, /…and 4 more/);
  assert.ok(!/11\. /.test(text), 'more than ten joins were listed');
});

test('opening a friend\'s link is recorded, without holding up the welcome', async () => {
  const { deliver, messages, sheet } = makeBot({ codes: [ASHA_CODE] });
  await deliver(privateMessage('/start ref_REFAJMXPQ', FRIEND));
  assert.match(lastText(messages, FRIEND.id), /A friend invited you/);

  // Give the fire-and-forget write a moment to land.
  await new Promise((r) => setImmediate(r));
  const opens = sheet.calls.filter((c) => c.name === 'recordReferralOpen');
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0].args, ['REFAJMXPQ', FRIEND.id]);
});

test('a sheet that cannot record the open never costs the student their welcome', async () => {
  const { deliver, messages } = makeBot({
    codes: [ASHA_CODE],
    methods: { recordReferralOpen: () => { throw new Error('sheet unreachable'); } }
  });
  const error = console.error;
  console.error = () => {};
  try {
    await deliver(privateMessage('/start ref_REFAJMXPQ', FRIEND));
  } finally {
    console.error = error;
  }
  assert.match(lastText(messages, FRIEND.id), /Welcome to/);
});
