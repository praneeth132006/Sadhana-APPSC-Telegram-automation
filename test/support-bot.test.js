// ============================================================================
// Payment bot support flow (test/support-bot.test.js)
// ============================================================================
// Drives real Telegram update shapes through the bot's handlers with Telegram
// and the sheet replaced by recorders. Covers the student side (/support, the
// instant answers, raising and following up a ticket), the admin side (replies,
// /close, /set in the support chat), and the guards: nothing answered in the
// paid groups, nothing relayed from messages this bot did not send.
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

const SUPPORT_CHAT = '-1005555555555';
const STUDENT = { id: 42, is_bot: false, first_name: 'Asha', username: 'asha' };
const ADMIN = { id: 7, is_bot: false, first_name: 'Ravi', username: 'ravi_admin' };
const BOT = { id: 123, is_bot: true, first_name: 'Pay bot', username: 'upsc_pay_bot' };

const sheets = require('../src/sheets');
const support = require('../src/support');
const { createPaymentBot } = require('../src/botapp');

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
const membership = require('../src/membership');

// botapp loads .env when required, which may name a real support chat. These
// tests decide the support chat themselves.
delete process.env.SUPPORT_CHAT_ID;
delete process.env.SUPPORT_THREAD_ID;

/** A recorder standing in for one group's sheet. */
function fakeSheet(overrides = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    return typeof result === 'function' ? result(...args) : result;
  };
  const client = {
    calls,
    getBotSettings: record('getBotSettings', {}),
    updateBotSettings: record('updateBotSettings', (patch) => patch),
    createTicket: record('createTicket', (t) => Object.assign({ status: 'open' }, t)),
    appendTicketMessage: record('appendTicketMessage', (id) => ({ ticket_id: id })),
    setTicketStatus: record('setTicketStatus', (id, status) => ({ ticket_id: id, status })),
    setTicketGroup: record('setTicketGroup', (id, group) => ({ ticket_id: id, group })),
    listTickets: record('listTickets', { total: 0, tickets: [], counts: { open: 0 } }),
    getSubscriber: record('getSubscriber', { status: 'active', expiry_date: '30-11-2099', plan_label: 'Target 2026 Pass', total_paid: 199, payment_id: 'pay_OLDPAYMENT0001' }),
    getTicket: record('getTicket', null),
    logTicketEvent: record('logTicketEvent', (id) => ({ ticket_id: id })),
    listSubscribers: record('listSubscribers', { total: 0, subscribers: [] }),
    getCoupon: record('getCoupon', null),
    findPayment: record('findPayment', null),
    getSupportStats: record('getSupportStats', null),
    listCoupons: record('listCoupons', [])
  };
  Object.entries(overrides).forEach(([name, result]) => { client[name] = record(name, result); });
  return client;
}

/** A bot wired to a fake sheet, with every Telegram call recorded. */
function makeBot({ sheet = fakeSheet(), supportChat = SUPPORT_CHAT, memberStatus = 'left' } = {}) {
  if (supportChat) process.env.SUPPORT_CHAT_UPSC = supportChat;
  else delete process.env.SUPPORT_CHAT_UPSC;
  sheets.forGroup = () => sheet;

  const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_UPSC', polling: false });
  const sent = [];
  let nextId = 1000;
  const record = (method) => async (...args) => {
    sent.push({ method, args });
    return { message_id: nextId++, chat: { id: args[0] } };
  };
  ['sendMessage', 'copyMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText', 'deleteMessage']
    .forEach((method) => { app.bot[method] = record(method); });
  app.bot.getMe = async () => BOT;
  app.bot.getChatMember = async (chatId, userId) => {
    sent.push({ method: 'getChatMember', args: [chatId, userId] });
    return { status: memberStatus };
  };

  const deliver = async (update) => {
    app.bot.processUpdate(Object.assign({ update_id: nextId++ }, update));
    await app.settle();
  };
  const messages = (chatId) => sent
    .filter((s) => s.method === 'sendMessage' && (chatId === undefined || String(s.args[0]) === String(chatId)));

  return { app, sheet, sent, deliver, messages };
}

let messageSeq = 1;
function privateMessage(text, extra = {}) {
  return {
    message: Object.assign({
      message_id: messageSeq++, date: 1, from: STUDENT,
      chat: { id: STUDENT.id, type: 'private' }, text
    }, extra)
  };
}

function supportChatMessage(text, extra = {}) {
  return {
    message: Object.assign({
      message_id: messageSeq++, date: 1, from: ADMIN,
      chat: { id: Number(SUPPORT_CHAT), type: 'supergroup' }, text
    }, extra)
  };
}

function tap(data, message) {
  return {
    callback_query: {
      id: 'cb' + messageSeq++, from: STUDENT, data,
      message: message || { message_id: messageSeq++, chat: { id: STUDENT.id, type: 'private' }, from: BOT, text: 'x' }
    }
  };
}

test.after(() => {
  delete process.env.SUPPORT_CHAT_UPSC;
});

// ---------------------------------------------------------------------------
// Student side
// ---------------------------------------------------------------------------

test('/support shows one button per issue type', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/support'));

  const [menu] = messages(STUDENT.id);
  assert.match(menu.args[1], /What do you need help with/);
  const buttons = menu.args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, support.MENU_CATEGORIES.map((c) => `sup:faq:${c.id}`));
  assert.ok(!buttons.includes('sup:faq:renewal'), 'auto-pay is no longer sold, so it is not offered');
});

test('an issue button answers instantly, with the text admins set in the sheet', async () => {
  const sheet = fakeSheet({ getBotSettings: { faq_invite: 'Custom invite answer <b>' } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(tap('sup:faq:invite'));

  const [answer] = messages(STUDENT.id);
  assert.match(answer.args[1], /Custom invite answer &lt;b&gt;/, 'admin text must be shown, and escaped');
  const buttons = answer.args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['sup:ask:invite', 'sup:solved']);
});

test('"I still need help" asks for details as a message the student replies to', async () => {
  const { deliver, messages } = makeBot();
  await deliver(tap('sup:ask:payment'));

  const [prompt] = messages(STUDENT.id);
  assert.equal(support.parsePrompt(prompt.args[1]).id, 'payment');
  assert.equal(prompt.args[2].reply_markup.force_reply, true);
});

test('replying to the prompt opens a ticket in the sheet and in the admin chat', async () => {
  const { deliver, sheet, messages } = makeBot();
  const prompt = { message_id: 900, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('payment')) + '\n\nDescribe the problem…' };

  await deliver(privateMessage('Paid 10 minutes ago, pay_ABC123', { reply_to_message: prompt }));

  const created = sheet.calls.find((c) => c.name === 'createTicket');
  assert.ok(created, 'no ticket was written to the sheet');
  const ticket = created.args[0];
  assert.match(ticket.ticket_id, /^T-\d{6}-[A-Z0-9]{4}$/);
  assert.equal(ticket.telegram_id, '42');
  assert.equal(ticket.category, 'payment');
  assert.equal(ticket.bot, 'TELEGRAM_PAYBOT_UPSC');
  assert.equal(ticket.message, 'Paid 10 minutes ago, pay_ABC123');

  const [toAdmins] = messages(SUPPORT_CHAT);
  assert.deepEqual(support.parseTicketHeader(toAdmins.args[1]), { ticketId: ticket.ticket_id, telegramId: '42' });
  const card = toAdmins.args[1];
  assert.match(card, /New ticket<\/b>\n<b>Status:<\/b> 🆕 Open · 🔴 Needs reply/);
  assert.match(card, /<b>Issue:<\/b> 💳 Paid, but no invite link/);
  assert.match(card, /<b>Group:<\/b> UPSC Prelims/, 'a bot with one group files every ticket under it');
  assert.match(card, /✅ <b>UPSC Prelims<\/b>\n\s+Valid until 30-11-2099 · <b>not in the group<\/b>/,
    'admins should see the pass and that the student is not in the group');
  assert.match(card, /₹199 · <code>pay_OLDPAYMENT0001<\/code>/);
  assert.match(card, /pay_ABC123/);
  assert.match(card, /Next step:<\/b> Pass is valid but they are not in UPSC Prelims → tap "🔗 Send new invite link"/);
  assert.match(card, /^🎫 <code>T-/, 'ids are code-formatted so Telegram does not link them as phone numbers');
  assert.equal(ticket.group, 'upsc');

  const [confirmation] = messages(STUDENT.id);
  assert.equal(support.parseReplyLine(confirmation.args[1]), ticket.ticket_id);
});

test('a screenshot reply is copied to the admin chat under the ticket header', async () => {
  const { deliver, sent } = makeBot();
  const prompt = { message_id: 901, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('payment')) };

  await deliver(privateMessage(undefined, { photo: [{ file_id: 'f' }], caption: 'receipt', reply_to_message: prompt }));

  const copy = sent.find((s) => s.method === 'copyMessage');
  assert.ok(copy, 'the screenshot never reached the admins');
  assert.equal(copy.args[0], SUPPORT_CHAT);
  assert.ok(support.parseTicketHeader(copy.args[3].caption), 'the copy must carry the header so admins can reply to it');
  assert.equal(copy.args[3].parse_mode, undefined, 'captions are plain text');
});

test('a free-typed message is offered to support, and tapping Send raises it', async () => {
  const { deliver, sheet, messages } = makeBot();
  const typed = privateMessage('my link does not work');
  await deliver(typed);

  const [offer] = messages(STUDENT.id);
  assert.equal(offer.args[2].reply_to_message_id, typed.message.message_id);
  assert.ok(offer.args[2].reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'sup:send'));

  await deliver(tap('sup:send', {
    message_id: 555, from: BOT, chat: { id: STUDENT.id, type: 'private' }, text: 'Would you like…',
    reply_to_message: typed.message
  }));

  const created = sheet.calls.find((c) => c.name === 'createTicket');
  assert.equal(created.args[0].message, 'my link does not work');
  assert.equal(created.args[0].category, 'other');
});

test('Send refuses a message that belongs to someone else', async () => {
  const { deliver, sheet, sent } = makeBot();
  await deliver(tap('sup:send', {
    message_id: 556, from: BOT, chat: { id: STUDENT.id, type: 'private' }, text: 'Would you like…',
    reply_to_message: { message_id: 1, from: { id: 999 }, chat: { id: 999 }, text: 'not yours' }
  }));

  assert.equal(sheet.calls.filter((c) => c.name === 'createTicket').length, 0);
  const ack = sent.find((s) => s.method === 'answerCallbackQuery');
  assert.match(ack.args[1].text, /no longer available/);
});

test('an unknown command is answered with the command list, not offered to support', async () => {
  // Silence here is what got the bot's Telegram ad rejected: "Bots must
  // respond to commands properly".
  const { deliver, messages, sheet } = makeBot();
  await deliver(privateMessage('/nonsense'));
  const replies = messages(STUDENT.id);
  assert.equal(replies.length, 1);
  assert.match(replies[0].args[1], /do not know that command/);
  assert.match(replies[0].args[1], /\/plans/);
  assert.equal(sheet.calls.filter((c) => c.name === 'createTicket').length, 0);
});

test('nothing is answered in the paid group, even though the bot sees every message there', async () => {
  const { deliver, sent } = makeBot();
  await deliver({
    message: {
      message_id: messageSeq++, date: 1, from: STUDENT,
      chat: { id: -1009999999999, type: 'supergroup' }, text: 'anyone else not getting questions?'
    }
  });
  assert.equal(sent.length, 0);
});

test('replying to an admin answer adds to the ticket and shows admins what came before', async () => {
  const conversation =
    '[17-09-2026, 10:12:03 AM IST] Asha (@asha):\nPaid but no link\n\n' +
    '[17-09-2026, 11:40:10 AM IST] Admin @ravi_admin:\nTry again now\n\n' +
    '[17-09-2026, 11:50:00 AM IST] Asha (@asha):\nStill not working';
  const sheet = fakeSheet({ appendTicketMessage: (id) => ({ ticket_id: id, status: 'in_progress', waiting_on: 'admin', conversation }) });
  const { deliver, messages } = makeBot({ sheet });
  const answer = { message_id: 902, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.replyLine('T-260917-AB2C') + '\n\nTry again now' };

  await deliver(privateMessage('Still not working', { reply_to_message: answer }));

  const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
  assert.equal(appended.args[0], 'T-260917-AB2C');
  assert.equal(appended.args[1].status, undefined, 'status rules live in the sheet; the bot must not dictate one');
  assert.equal(appended.args[1].text, 'Still not working');

  const [toAdmins] = messages(SUPPORT_CHAT);
  const text = toAdmins.args[1];
  assert.ok(support.parseTicketHeader(text));
  assert.match(text, /Student replied<\/b>/);
  assert.match(text, /Status:<\/b> 🟡 In progress · 🔴 Needs reply/);
  assert.match(text, /Earlier in this ticket[\s\S]*Paid but no link[\s\S]*Admin @ravi_admin:\nTry again now/);
  assert.equal((text.match(/Still not working/g) || []).length, 1, 'the new message should not also appear in the history');
  assert.ok(toAdmins.args[2].reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'adm:i:T-260917-AB2C:42'),
    'every ticket post needs the admin buttons');
});

test('a student who just types again goes into their open ticket, not a new one', async () => {
  const sheet = fakeSheet({
    listTickets: { total: 1, tickets: [{ ticket_id: 'T-260917-AB2C', status: 'answered', updated_at: '' }] }
  });
  const { deliver, messages } = makeBot({ sheet });

  await deliver(privateMessage('still no link'));

  assert.equal(sheet.calls.filter((c) => c.name === 'createTicket').length, 0);
  const lookup = sheet.calls.find((c) => c.name === 'listTickets');
  assert.equal(lookup.args[0].telegramId, '42');
  const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
  assert.equal(appended.args[0], 'T-260917-AB2C');
  assert.match(messages(STUDENT.id)[0].args[1], /Added to your ticket/);
  assert.equal(messages(SUPPORT_CHAT).length, 1);
});

test('a recently closed ticket is reopened when the student types again; a stale one is not', async () => {
  const recentlyClosed = fakeSheet({
    listTickets: { total: 1, tickets: [{ ticket_id: 'T-260917-AAAA', status: 'closed', updated_at: '' }] },
    appendTicketMessage: (id) => ({ ticket_id: id, status: 'in_progress', waiting_on: 'admin', reopened: true })
  });
  const reopen = makeBot({ sheet: recentlyClosed });
  await reopen.deliver(privateMessage('it broke again'));
  assert.equal(recentlyClosed.calls.find((c) => c.name === 'appendTicketMessage').args[0], 'T-260917-AAAA');
  assert.match(reopen.messages(STUDENT.id)[0].args[1], /earlier ticket has been reopened/);
  assert.match(reopen.messages(SUPPORT_CHAT)[0].args[1], /Reopened — the student wrote on a closed ticket[\s\S]*Status:<\/b> 🟡 In progress · 🔴 Needs reply/);

  const stale = fakeSheet({
    listTickets: { total: 1, tickets: [{ ticket_id: 'T-260801-BBBB', status: 'open', updated_at: '01-08-2020, 10:00:00 AM IST' }] }
  });
  const fresh = makeBot({ sheet: stale });
  await fresh.deliver(privateMessage('new problem'));
  assert.equal(stale.calls.filter((c) => c.name === 'appendTicketMessage').length, 0);
  assert.match(fresh.messages(STUDENT.id)[0].args[1], /send this message to our support team/);
});

test('an open ticket is preferred over a recently closed one', async () => {
  const sheet = fakeSheet({
    listTickets: { total: 2, tickets: [
      { ticket_id: 'T-260917-CLOS', status: 'closed', updated_at: '' },
      { ticket_id: 'T-260917-OPEN', status: 'in_progress', updated_at: '' }
    ] }
  });
  const { deliver } = makeBot({ sheet });
  await deliver(privateMessage('any update?'));
  assert.equal(sheet.calls.find((c) => c.name === 'appendTicketMessage').args[0], 'T-260917-OPEN');
});
test('if the sheet cannot say whether a ticket is open, the student is still offered support', async () => {
  const sheet = fakeSheet({ listTickets: () => { throw new Error('Unknown GET action: listTickets'); } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(privateMessage('hello'));
  assert.match(messages(STUDENT.id)[0].args[1], /send this message to our support team/);
});

test('a reply to a message some other bot sent is not treated as a ticket', async () => {
  const { deliver, sheet } = makeBot();
  const forged = { message_id: 903, from: { id: 555, is_bot: true }, chat: { id: STUDENT.id, type: 'private' },
    text: support.replyLine('T-260917-AB2C') };
  await deliver(privateMessage('hi', { reply_to_message: forged }));
  assert.equal(sheet.calls.filter((c) => c.name === 'appendTicketMessage').length, 0);
});

test('with tickets switched off, the student is pointed at the fallback contact instead', async () => {
  const sheet = fakeSheet({ getBotSettings: { support_enabled: 'no', support_contact: '@helpdesk' } });
  const { deliver, messages } = makeBot({ sheet });
  const prompt = { message_id: 904, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('other')) };

  await deliver(privateMessage('help', { reply_to_message: prompt }));

  assert.equal(sheet.calls.filter((c) => c.name === 'createTicket').length, 0);
  assert.match(messages(STUDENT.id)[0].args[1], /not being taken[\s\S]*@helpdesk/);
});

test('a ticket still goes through when the sheet is down but the admin chat works', async () => {
  const sheet = fakeSheet({ createTicket: () => { throw new Error('Unknown POST action: createTicket'); } });
  const { deliver, messages } = makeBot({ sheet });
  const prompt = { message_id: 905, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('other')) };

  const originalError = console.error;
  console.error = () => {};
  try {
    await deliver(privateMessage('help', { reply_to_message: prompt }));
  } finally {
    console.error = originalError;
  }

  assert.equal(messages(SUPPORT_CHAT).length, 1);
  assert.match(messages(STUDENT.id)[0].args[1], /^📨 Ticket received/);
});

test('when neither the sheet nor an admin chat can take it, the student is told to retry', async () => {
  const sheet = fakeSheet({ createTicket: () => { throw new Error('Sheets down'); } });
  const { deliver, messages } = makeBot({ sheet, supportChat: null });
  const prompt = { message_id: 906, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('other')) };

  const originalError = console.error;
  console.error = () => {};
  try {
    await deliver(privateMessage('help', { reply_to_message: prompt }));
  } finally {
    console.error = originalError;
  }

  assert.match(messages(STUDENT.id)[0].args[1], /Could not submit your ticket/);
});

test('one student cannot flood the admin chat', async () => {
  const { deliver, sheet, messages } = makeBot();
  const prompt = { message_id: 907, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('other')) };

  for (let i = 0; i < 7; i++) await deliver(privateMessage('help ' + i, { reply_to_message: prompt }));

  assert.equal(sheet.calls.filter((c) => c.name === 'createTicket').length, 5);
  assert.match(messages(STUDENT.id).at(-1).args[1], /several support messages/);
});

test('/start still greets when the settings sheet fails, and includes the welcome note when set', async () => {
  const failing = makeBot({ sheet: fakeSheet({ getBotSettings: () => { throw new Error('down'); } }) });
  const originalError = console.error;
  console.error = () => {};
  try {
    await failing.deliver(privateMessage('/start'));
  } finally {
    console.error = originalError;
  }
  assert.match(failing.messages(STUDENT.id)[0].args[1], /Hello Asha[\s\S]*\/support/);
  // The greeting is one message with a Continue button, as the welcome screen
  // is meant to be — not a wall of text followed by the pass unasked.
  assert.equal(failing.messages(STUDENT.id).length, 1);
  assert.equal(failing.messages(STUDENT.id)[0].args[2].reply_markup.inline_keyboard[0][0].callback_data,
    'go:plans');

  const noted = makeBot({ sheet: fakeSheet({ getBotSettings: { welcome_note: 'Exam special this week' } }) });
  await noted.deliver(privateMessage('/start'));
  assert.match(noted.messages(STUDENT.id)[0].args[1], /Exam special this week/);
});

test('/help points at support with a button', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/help'));
  const [help] = messages(STUDENT.id);
  assert.match(help.args[1], /\/support/);
  assert.equal(help.args[2].reply_markup.inline_keyboard[0][0].callback_data, 'sup:menu');
});

// ---------------------------------------------------------------------------
// Admin side
// ---------------------------------------------------------------------------

function ticketMessage(ticketId = 'T-260917-AB2C', from = BOT) {
  return { message_id: 950, from, chat: { id: Number(SUPPORT_CHAT), type: 'supergroup' },
    text: support.ticketHeader(ticketId, STUDENT.id) + '\nNew ticket\n\nhelp' };
}

test('an admin reply to a ticket reaches the student and marks it answered', async () => {
  const { deliver, sheet, messages } = makeBot();
  await deliver(supportChatMessage('Your link is resent <3', { reply_to_message: ticketMessage() }));

  const [toStudent] = messages(STUDENT.id);
  assert.equal(support.parseReplyLine(toStudent.args[1]), 'T-260917-AB2C');
  assert.match(toStudent.args[1], /Your link is resent &lt;3/);

  const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
  assert.equal(appended.args[1].status, undefined);
  assert.equal(appended.args[1].handledBy, '@ravi_admin', 'an admin message is recorded as the admin, which picks the ticket up');

  const [confirmation] = messages(SUPPORT_CHAT);
  assert.match(confirmation.args[1], /Delivered to the student[\s\S]*Status: 🟡 In progress · ⏳ Waiting for student/);
});

test('an admin replying to a ticket another bot posted is left to that bot', async () => {
  const { deliver, sent } = makeBot();
  await deliver(supportChatMessage('hello', { reply_to_message: ticketMessage('T-260917-AB2C', { id: 456, is_bot: true }) }));
  assert.equal(sent.length, 0);
});

test('an admin screenshot is copied to the student', async () => {
  const { deliver, sent } = makeBot();
  await deliver(supportChatMessage(undefined, {
    photo: [{ file_id: 'x' }], caption: 'see this', reply_to_message: ticketMessage()
  }));
  const copy = sent.find((s) => s.method === 'copyMessage');
  assert.equal(String(copy.args[0]), String(STUDENT.id));
  assert.equal(support.parseReplyLine(copy.args[3].caption), 'T-260917-AB2C');
});

test('a failed delivery is reported in the admin chat and not recorded as answered', async () => {
  const { app, deliver, sheet, messages } = makeBot();
  const send = app.bot.sendMessage;
  app.bot.sendMessage = async (chatId, ...rest) => {
    if (String(chatId) === String(STUDENT.id)) throw new Error('Forbidden: bot was blocked by the user');
    return send(chatId, ...rest);
  };

  await deliver(supportChatMessage('hello', { reply_to_message: ticketMessage() }));

  assert.equal(sheet.calls.filter((c) => c.name === 'appendTicketMessage').length, 0);
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Not delivered<\/b>: Forbidden/);
});

test('/close on a ticket closes it and tells the student', async () => {
  const { deliver, sheet, messages } = makeBot();
  await deliver(supportChatMessage('/close', { reply_to_message: ticketMessage() }));

  const closed = sheet.calls.find((c) => c.name === 'setTicketStatus');
  assert.deepEqual(closed.args, ['T-260917-AB2C', 'closed', '@ravi_admin']);
  assert.match(messages(STUDENT.id)[0].args[1], /marked as resolved/);
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Closed<\/b> by @ravi_admin[\s\S]*Status: ✅ Closed/);
});

test('/set changes a setting, and refuses one that does not exist', async () => {
  const { deliver, sheet, messages } = makeBot();

  await deliver(supportChatMessage('/set support_hours 10 AM – 6 PM IST'));
  const update = sheet.calls.find((c) => c.name === 'updateBotSettings');
  assert.deepEqual(update.args, [{ support_hours: '10 AM – 6 PM IST' }, '@ravi_admin']);

  await deliver(supportChatMessage('/set bank_details 1234'));
  assert.equal(sheet.calls.filter((c) => c.name === 'updateBotSettings').length, 1);
  assert.match(messages(SUPPORT_CHAT).at(-1).args[1], /Unknown setting/);
});

test('a command addressed to a different bot is ignored', async () => {
  const { deliver, sheet } = makeBot();
  await deliver(supportChatMessage('/set@some_other_bot support_hours never'));
  assert.equal(sheet.calls.filter((c) => c.name === 'updateBotSettings').length, 0);
});

test('admin commands only work in the support chat', async () => {
  const { deliver, sheet } = makeBot();
  await deliver({
    message: {
      message_id: messageSeq++, date: 1, from: STUDENT,
      chat: { id: -1009999999999, type: 'supergroup' }, text: '/set support_hours hacked'
    }
  });
  await deliver(privateMessage('/set support_hours hacked'));
  assert.equal(sheet.calls.filter((c) => c.name === 'updateBotSettings').length, 0);
});

test('ordinary chatter in the support chat is ignored', async () => {
  const { deliver, sent } = makeBot();
  await deliver(supportChatMessage('lunch?'));
  assert.equal(sent.length, 0);
});

test('/tickets lists the tickets that need a reply, longest waiting first, each with buttons', async () => {
  const sheet = fakeSheet({
    listTickets: {
      total: 2, counts: { open: 1, in_progress: 2, closed: 3, needs_reply: 2, waiting_student: 1 },
      tickets: [
        { ticket_id: 'T-260917-AB2C', telegram_id: '42', username: 'asha', category: 'invite', status: 'open', waiting_on: 'admin', last_message: 'link broken', updated_at: 'x' },
        { ticket_id: 'T-260916-ZZ99', telegram_id: '43', name: 'Ravi', category: 'payment', status: 'in_progress', waiting_on: 'admin', picked_up_by: '@sita', last_message: 'still no', updated_at: 'y' }
      ]
    }
  });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/tickets'));

  const query = sheet.calls.find((c) => c.name === 'listTickets').args[0];
  assert.deepEqual(query, { pageSize: 10, waitingOn: 'admin', sort: 'waiting' });

  const posts = messages(SUPPORT_CHAT);
  assert.match(posts[0].args[1], /Needs reply — longest waiting first<\/b> — 2 tickets\n\n🔴 Needs reply: <b>2<\/b>\n🆕 Open: 1\n🟡 In progress: 2\n⏳ Waiting for student: 1\n✅ Closed: 3/);
  assert.equal(posts.length, 3, 'a heading plus one post per ticket');
  assert.match(posts[1].args[1], /^🎫 <code>T-260917-AB2C<\/code> · user <code>42<\/code>\n🆕 Open · 🔴 Needs reply[\s\S]*not picked up yet[\s\S]*link broken/);
  assert.match(posts[2].args[1], /🟡 In progress · 🔴 Needs reply[\s\S]*picked up by @sita/);
  assert.ok(posts[1].args[2].reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'adm:c:T-260917-AB2C:42'));
});

test('/tickets takes a queue name', async () => {
  for (const [arg, expected] of [['open', { status: 'open', sort: 'waiting' }], ['progress', { status: 'in_progress' }],
    ['student', { waitingOn: 'student' }], ['closed', { status: 'closed' }], ['nonsense', { waitingOn: 'admin', sort: 'waiting' }]]) {
    const sheet = fakeSheet();
    const { deliver } = makeBot({ sheet });
    await deliver(supportChatMessage(`/tickets ${arg}`));
    assert.deepEqual(sheet.calls.find((c) => c.name === 'listTickets').args[0], Object.assign({ pageSize: 10 }, expected), arg);
  }
});

const SAMPLE_STATS = {
  period_days: 7,
  counts: { open: 1, in_progress: 3, closed: 12, total: 16, needs_reply: 2, waiting_student: 2 },
  not_picked_up: 1, opened_today: 4, closed_today: 2,
  first_reply_minutes: { average: 95, median: 40, samples: 9 },
  oldest_needs_reply: { ticket_id: 'T-260917-AB2C', name: 'Asha', category: 'payment', minutes: 185 },
  by_category: { payment: { open: 1, in_progress: 2, closed: 5, total: 8 }, coupon: { open: 0, in_progress: 0, closed: 3, total: 3 } },
  by_admin: { '@ravi_admin': { replies: 5, quick_replies: 2, closed: 4, invites_sent: 1, passes_granted: 1, picked_up: 3, payments_checked: 2 } }
};

test('/summary shows the queues, today, reply time, longest waiting, issues and admins, with buttons', async () => {
  const sheet = fakeSheet({ getSupportStats: SAMPLE_STATS });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/summary'));

  assert.deepEqual(sheet.calls.find((c) => c.name === 'getSupportStats').args[0], { days: 7 });
  const [post] = messages(SUPPORT_CHAT);
  const text = post.args[1];
  assert.match(text, /support summary/);
  assert.match(text, /🔴 Needs reply: <b>2<\/b>\n🆕 Open \(not picked up\): 1\n🟡 In progress: 3\n⏳ Waiting for student: 2\n✅ Closed: 12\n📁 All tickets: 16/);
  assert.match(text, /Today: 4 opened · 2 closed/);
  assert.match(text, /average 1 h 35 min · median 40 min/);
  assert.match(text, /Longest waiting: Asha — <b>3 h 5 min<\/b>/);
  assert.match(text, /Paid, but no invite link: <b>3<\/b>/);
  assert.ok(!/Coupon code not working: <b>/.test(text), 'an issue with nothing open is left out');
  assert.match(text, /@ravi_admin: 7 replies · 4 closed · 1 invites · 1 passes granted/);

  const buttons = post.args[2].reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.callback_data), ['sum:needs', 'sum:open', 'sum:progress', 'sum:student', 'sum:closed', 'sum:refresh']);
  assert.equal(buttons[0].text, '🔴 Needs reply (2)');
});

test('/stats is the same as /summary', async () => {
  const sheet = fakeSheet({ getSupportStats: SAMPLE_STATS });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/stats'));
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /support summary/);
});

test('a summary button lists that queue, and Refresh updates the summary in place', async () => {
  const sheet = fakeSheet({ getSupportStats: SAMPLE_STATS });
  const { deliver, sent } = makeBot({ sheet });
  const summaryMessage = { message_id: 777, from: BOT, chat: { id: Number(SUPPORT_CHAT), type: 'supergroup' }, text: 'summary' };

  await deliver({ callback_query: { id: 'cb1', from: ADMIN, data: 'sum:progress', message: summaryMessage } });
  assert.deepEqual(sheet.calls.find((c) => c.name === 'listTickets').args[0], { pageSize: 10, status: 'in_progress' });

  sent.length = 0;
  await deliver({ callback_query: { id: 'cb2', from: ADMIN, data: 'sum:refresh', message: summaryMessage } });
  const edit = sent.find((s) => s.method === 'editMessageText');
  assert.ok(edit, 'refresh should edit the summary, not post a new one');
  assert.equal(edit.args[1].message_id, 777);
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 0);
});

test('summary buttons do nothing outside the support chat', async () => {
  const sheet = fakeSheet({ getSupportStats: SAMPLE_STATS });
  const { deliver, sent } = makeBot({ sheet });
  await deliver({ callback_query: { id: 'cb3', from: STUDENT, data: 'sum:needs',
    message: { message_id: 5, from: BOT, chat: { id: STUDENT.id, type: 'private' }, text: 'x' } } });
  assert.equal(sheet.calls.filter((c) => c.name === 'listTickets' || c.name === 'getSupportStats').length, 0);
  assert.match(sent.find((s) => s.method === 'answerCallbackQuery').args[1].text, /only works in the support chat/);
});

test('/summary reports a sheet problem instead of staying silent', async () => {
  const sheet = fakeSheet({ getSupportStats: () => { throw new Error('Unknown GET action: getSupportStats'); } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/summary'));
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Could not read the support numbers/);
});
test('closing an already-closed ticket does not message the student again', async () => {
  const sheet = fakeSheet({ setTicketStatus: (id) => ({ ticket_id: id, status: 'closed', previous_status: 'closed', closed_by: '@sita' }) });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(adminTap('adm:c:T-260917-AB2C:42'));
  assert.equal(messages(STUDENT.id).length, 0);
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Already closed<\/b> by @sita/);
});

test('if the sheet cannot close the ticket, the admin is told and the student is not', async () => {
  const sheet = fakeSheet({ setTicketStatus: () => { throw new Error('Sheets down'); } });
  const { deliver, messages } = makeBot({ sheet });
  const quiet = console.error;
  console.error = () => {};
  try {
    await deliver(adminTap('adm:c:T-260917-AB2C:42'));
  } finally {
    console.error = quiet;
  }
  assert.equal(messages(STUDENT.id).length, 0, 'never tell a student it is resolved when it was not recorded');
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Not changed<\/b>/);
});

test('reopen from a button asks the sheet for in_progress, never open', async () => {
  const sheet = fakeSheet({ setTicketStatus: (id, status) => ({ ticket_id: id, status: 'in_progress', waiting_on: 'admin', previous_status: 'closed' }) });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(adminTap('adm:o:T-260917-AB2C:42'));
  assert.deepEqual(sheet.calls.find((c) => c.name === 'setTicketStatus').args, ['T-260917-AB2C', 'in_progress', '@ravi_admin']);
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Reopened<\/b> by @ravi_admin\nStatus: 🟡 In progress · 🔴 Needs reply/);
});

// ---------------------------------------------------------------------------
// Admin buttons
// ---------------------------------------------------------------------------

function adminTap(data, { chatId = SUPPORT_CHAT, from = ADMIN } = {}) {
  return {
    callback_query: {
      id: 'cb' + messageSeq++, from, data,
      message: { message_id: 960, from: BOT, chat: { id: Number(chatId), type: 'supergroup' },
        text: support.ticketHeader('T-260917-AB2C', STUDENT.id) }
    }
  };
}

/** Replaces membership.resendInvite for one test. */
async function withResendInvite(impl, fn) {
  const original = membership.resendInvite;
  membership.resendInvite = impl;
  try {
    return await fn();
  } finally {
    membership.resendInvite = original;
  }
}

test('🔗 Resend invite sends the student a fresh link and records it on the ticket', async () => {
  await withResendInvite(async (groupId, telegramId) => ({
    sent: true, inviteLink: 'https://t.me/+fresh', subscriber: { status: 'active', expiry_date: '30-11-2026' }
  }), async () => {
    const { deliver, sheet, messages, sent } = makeBot();
    await deliver(adminTap('adm:i:T-260917-AB2C:42'));

    const [toStudent] = messages(STUDENT.id);
    assert.match(toStudent.args[1], /new invite link/);
    assert.equal(toStudent.args[2].reply_markup.inline_keyboard[0][0].url, 'https://t.me/+fresh');

    const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
    assert.equal(appended.args[0], 'T-260917-AB2C');
    assert.match(appended.args[1].text, /Sent a fresh invite link/);
    assert.equal(appended.args[1].handledBy, '@ravi_admin');

    const [report] = messages(SUPPORT_CHAT);
    assert.match(report.args[1], /✅ .*new invite link sent to the student/);
    assert.equal(report.args[2].reply_to_message_id, 960, 'the report should thread under the ticket');
    assert.match(sent.find((s) => s.method === 'answerCallbackQuery').args[1].text, /fresh invite/);
  });
});

test('🔗 Resend invite refuses a student without an active pass and says why', async () => {
  await withResendInvite(async () => ({ sent: false, reason: 'subscription has expired', subscriber: { status: 'active', expiry_date: '01-09-2026' } }), async () => {
    const { deliver, sheet, messages } = makeBot();
    await deliver(adminTap('adm:i:T-260917-AB2C:42'));

    assert.equal(messages(STUDENT.id).length, 0, 'no link may be sent without an active pass');
    assert.equal(sheet.calls.filter((c) => c.name === 'appendTicketMessage').length, 0);
    assert.match(messages(SUPPORT_CHAT)[0].args[1], /no invite sent — subscription has expired[\s\S]*needs a valid pass/);
  });
});

test('🔗 Resend invite gives the admin the link when the student has blocked the bot', async () => {
  await withResendInvite(async () => ({ sent: true, inviteLink: 'https://t.me/+manual', subscriber: { status: 'active' } }), async () => {
    const { app, deliver, messages } = makeBot();
    const send = app.bot.sendMessage;
    app.bot.sendMessage = async (chatId, ...rest) => {
      if (String(chatId) === String(STUDENT.id)) throw new Error('Forbidden: bot was blocked by the user');
      return send(chatId, ...rest);
    };
    await deliver(adminTap('adm:i:T-260917-AB2C:42'));
    assert.match(messages(SUPPORT_CHAT)[0].args[1], /could not be messaged[\s\S]*https:\/\/t\.me\/\+manual/);
  });
});

test('admin buttons do nothing outside the support chat', async () => {
  let called = false;
  await withResendInvite(async () => { called = true; return { sent: false, subscriber: null }; }, async () => {
    const { deliver, sent, sheet } = makeBot();
    await deliver(adminTap('adm:i:T-260917-AB2C:42', { chatId: STUDENT.id, from: STUDENT }));
    await deliver(adminTap('adm:c:T-260917-AB2C:42', { chatId: '-1009999999999', from: STUDENT }));

    assert.equal(called, false);
    assert.equal(sheet.calls.filter((c) => c.name === 'setTicketStatus').length, 0);
    assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 0);
    assert.match(sent.find((s) => s.method === 'answerCallbackQuery').args[1].text, /only works in the support chat/);
  });
});

test('a malformed admin button is ignored', async () => {
  const { deliver, sent } = makeBot();
  await deliver(adminTap('adm:i:not-a-ticket:42'));
  await deliver(adminTap('adm:z:T-260917-AB2C:42'));
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 0);
});

test('✍️ Reply asks for an answer that is then delivered like any other reply', async () => {
  const { deliver, messages, sheet } = makeBot();
  await deliver(adminTap('adm:r:T-260917-AB2C:42'));

  const [prompt] = messages(SUPPORT_CHAT);
  assert.equal(prompt.args[2].reply_markup.force_reply, true);
  assert.deepEqual(support.parseTicketHeader(prompt.args[1]), { ticketId: 'T-260917-AB2C', telegramId: '42' });

  await deliver(supportChatMessage('Your pass is active, try the new link', {
    reply_to_message: { message_id: 970, from: BOT, chat: { id: Number(SUPPORT_CHAT) }, text: prompt.args[1] }
  }));
  assert.match(messages(STUDENT.id)[0].args[1], /Your pass is active, try the new link/);
  assert.equal(sheet.calls.find((c) => c.name === 'appendTicketMessage').args[1].handledBy, '@ravi_admin');
});

test('🎟 Pass status shows every group the student holds', async () => {
  const { deliver, messages } = makeBot();
  await deliver(adminTap('adm:p:T-260917-AB2C:42'));
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Pass & payment<\/b>[\s\S]*Valid until 30-11-2099 · <b>not in the group/);
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Next step:<\/b> Pass is valid but they are not in/);
});

test('📜 Full history posts the whole conversation, or explains when it is missing', async () => {
  const found = makeBot({ sheet: fakeSheet({ getTicket: {
    ticket_id: 'T-260917-AB2C', status: 'answered', handled_by: '@ravi_admin',
    conversation: '[17-09-2026, 10:12:03 AM IST] Asha:\nfirst <message>'
  } }) });
  await found.deliver(adminTap('adm:h:T-260917-AB2C:42'));
  assert.match(found.messages(SUPPORT_CHAT)[0].args[1], /History<\/b>\n<b>Status:<\/b> 🟡 In progress[\s\S]*first &lt;message&gt;/);

  const missing = makeBot({ sheet: fakeSheet({ getTicket: null }) });
  await missing.deliver(adminTap('adm:h:T-260917-AB2C:42'));
  assert.match(missing.messages(SUPPORT_CHAT)[0].args[1], /could not be read from the sheet/);
});

test('✅ Close from a button closes the ticket, tells the student, and offers Reopen', async () => {
  const { deliver, sheet, messages } = makeBot();
  await deliver(adminTap('adm:c:T-260917-AB2C:42'));

  assert.deepEqual(sheet.calls.find((c) => c.name === 'setTicketStatus').args, ['T-260917-AB2C', 'closed', '@ravi_admin']);
  assert.match(messages(STUDENT.id)[0].args[1], /marked as resolved/);
  const [report] = messages(SUPPORT_CHAT);
  const buttons = report.args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes('adm:o:T-260917-AB2C:42'), 'a closed ticket should offer Reopen');
  assert.ok(!buttons.includes('adm:c:T-260917-AB2C:42'));
});

test('/invite replied to a ticket does the same as the button', async () => {
  let asked = null;
  await withResendInvite(async (groupId, telegramId) => { asked = String(telegramId); return { sent: false, subscriber: null }; }, async () => {
    const { deliver, messages } = makeBot();
    await deliver(supportChatMessage('/invite', { reply_to_message: ticketMessage() }));
    assert.equal(asked, '42');
    assert.match(messages(SUPPORT_CHAT)[0].args[1], /no pass on record/);
  });
});

test('a long message with a long history still fits in one Telegram message', async () => {
  const long = 'x'.repeat(3400);
  const conversation =
    `[17-09-2026, 10:12:03 AM IST] Asha (@asha):\n${'y'.repeat(3000)}\n\n` +
    `[17-09-2026, 11:50:00 AM IST] Asha (@asha):\n${long}`;
  const sheet = fakeSheet({
    listTickets: { total: 1, tickets: [{ ticket_id: 'T-260917-AB2C', status: 'open', updated_at: '' }] },
    appendTicketMessage: (id) => ({ ticket_id: id, status: 'open', conversation })
  });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(privateMessage(long));

  const [post] = messages(SUPPORT_CHAT);
  const visible = post.args[1].replace(/<[^>]+>/g, '').replace(/&lt;|&gt;|&amp;/g, '_');
  assert.ok(visible.length <= 4096, `post is ${visible.length} characters`);
  assert.match(post.args[1], /cut short — tap 📜 History/);
});

// ---------------------------------------------------------------------------
// Buying the pass, with and without a coupon
// ---------------------------------------------------------------------------

const razorpay = require('../src/razorpay');
const pricing = require('../src/pricing');

/** Records payment links instead of calling Razorpay. */
async function withPaymentLinks(fn) {
  const original = razorpay.createPaymentLink;
  const links = [];
  razorpay.createPaymentLink = async (options) => {
    links.push(options);
    return { short_url: 'https://rzp.io/l/test', id: 'plink_1' };
  };
  try {
    return await fn(links);
  } finally {
    razorpay.createPaymentLink = original;
  }
}

function coupon(overrides) {
  return Object.assign({
    code: 'SAVE50', discount_type: 'flat', discount_value: 50, active: true, expires_on: '',
    max_uses: null, times_used: 0, one_per_student: true, used_by_student: 0
  }, overrides || {});
}

test('/plans shows the one pass with its name, date and price, and a coupon button', async () => {
  const sheet = fakeSheet({ getBotSettings: { pass_name: 'Target UPSC Prelims 2026', pass_price: '199', pass_valid_until: '31-05-2099' } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(privateMessage('/plans'));

  const [offer] = messages(STUDENT.id);
  assert.match(offer.args[1], /Target UPSC Prelims 2026[\s\S]*Valid until <b>31-05-2099[\s\S]*Price: <b>₹199/);
  const buttons = offer.args[2].reply_markup.inline_keyboard.flat();
  assert.equal(buttons[0].text, '💳 Pay ₹199');
  assert.equal(buttons[0].callback_data, 'buy:upsc:exam_pass');
  assert.equal(buttons[1].callback_data, 'cpn:upsc');
});

test('a valid coupon shows the discounted price and a pay button that carries the code', async () => {
  const sheet = fakeSheet({ getCoupon: coupon() });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(tap('cpn:upsc'));
  const [prompt] = messages(STUDENT.id);
  assert.equal(prompt.args[2].reply_markup.force_reply, true);

  await deliver(privateMessage(' save50 ', { reply_to_message: { message_id: 1, from: BOT, chat: { id: STUDENT.id }, text: prompt.args[1].replace(/<[^>]+>/g, '') } }));
  const lookup = sheet.calls.find((c) => c.name === 'getCoupon');
  assert.deepEqual(lookup.args, ['SAVE50', '42'], 'the code is normalised and checked for this student');

  const offer = messages(STUDENT.id).at(-1);
  assert.match(offer.args[1], /Coupon <b>SAVE50<\/b> applied — ₹50 off[\s\S]*<s>₹199<\/s> <b>₹149<\/b> \(you save ₹50\)/);
  const buttons = offer.args[2].reply_markup.inline_keyboard.flat();
  assert.equal(buttons[0].text, '💳 Pay ₹149');
  assert.equal(buttons[0].callback_data, 'buy:upsc:exam_pass:SAVE50');
  // "plain:" and not "pick:": choosing a group keeps whatever the student
  // arrived with, while removing a coupon has to clear it.
  assert.equal(buttons[1].callback_data, 'plain:upsc', 'the student can remove the coupon');
});

test('a refused coupon says why and offers another try or the full price', async () => {
  const sheet = fakeSheet({ getCoupon: coupon({ used_by_student: 1 }) });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(privateMessage('SAVE50', { reply_to_message: { message_id: 1, from: BOT, chat: { id: STUDENT.id }, text: '🎟 Coupon code for UPSC Prelims\n\nType it' } }));

  const [reply] = messages(STUDENT.id);
  assert.match(reply.args[1], /SAVE50<\/b>: You have already used that coupon code/);
  assert.deepEqual(reply.args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['cpn:upsc', 'plain:upsc']);
});

test('paying with a coupon re-checks it and charges the discounted amount, with the coupon in the notes', async () => {
  await withPaymentLinks(async (links) => {
    const sheet = fakeSheet({ getCoupon: coupon({ discount_type: 'percent', discount_value: 20 }), getSubscriber: null,
      getBotSettings: { pass_valid_until: '31-05-2099', pass_name: 'Target 2026' } });
    const { deliver, messages } = makeBot({ sheet });
    await deliver(tap('buy:upsc:exam_pass:SAVE50'));

    assert.equal(links.length, 1);
    assert.equal(links[0].plan.amountPaise, 15920, '20% off ₹199 is ₹159.20');
    assert.equal(links[0].plan.groupId, 'upsc');
    assert.deepEqual(links[0].extraNotes, {
      plan_label: 'Target 2026', valid_until: '31-05-2099',
      coupon_code: 'SAVE50', original_amount: '199', discount_amount: '39.8'
    });
    assert.match(messages(STUDENT.id).at(-1).args[1], /You pay <b>₹159.20<\/b> \(coupon SAVE50, you save ₹39.80\)/);
  });
});

test('a coupon that stopped working before the tap is refused and nothing is charged', async () => {
  await withPaymentLinks(async (links) => {
    const sheet = fakeSheet({ getCoupon: coupon({ active: false }), getSubscriber: null });
    const { deliver, messages } = makeBot({ sheet });
    await deliver(tap('buy:upsc:exam_pass:SAVE50'));
    assert.equal(links.length, 0);
    assert.match(messages(STUDENT.id).at(-1).args[1], /no longer active/);
  });
});

test('a button for a retired pass sells nothing and shows the current pass instead', async () => {
  await withPaymentLinks(async (links) => {
    const { deliver, messages } = makeBot();
    await deliver(tap('buy:upsc:sprint_30'));
    assert.equal(links.length, 0);
    assert.match(messages(STUDENT.id)[0].args[1], /no longer sold/);
    assert.match(messages(STUDENT.id)[1].args[1], /Price: <b>₹199/);
  });
});

test('someone who already holds the pass to the same date is not charged again', async () => {
  await withPaymentLinks(async (links) => {
    const sheet = fakeSheet({
      getBotSettings: { pass_valid_until: '31-05-2099' },
      getSubscriber: { status: 'active', expiry_date: '31-05-2099, 11:59:59 PM IST', plan_label: 'Target 2026' }
    });
    const { deliver, messages } = makeBot({ sheet });
    await deliver(tap('buy:upsc:exam_pass'));
    assert.equal(links.length, 0);
    assert.match(messages(STUDENT.id)[0].args[1], /nothing to buy/);
  });
});

// ---------------------------------------------------------------------------
// Support: the case file and the admin tools
// ---------------------------------------------------------------------------

test('a student already in the group gets a different suggestion than one outside it', async () => {
  const prompt = { message_id: 800, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('invite')) };
  const inside = makeBot({ memberStatus: 'member' });
  await inside.deliver(privateMessage('cannot see posts', { reply_to_message: prompt }));
  assert.match(inside.messages(SUPPORT_CHAT)[0].args[1], /in the group[\s\S]*already in UPSC Prelims → ask what exactly they see/);
});

test('a ticket that mentions a payment id gets a Check payment button', async () => {
  const { deliver, messages } = makeBot();
  const prompt = { message_id: 801, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.promptLine(support.categoryById('payment')) };
  await deliver(privateMessage('paid, id pay_TZ8ciB8Yng8WE3', { reply_to_message: prompt }));
  const buttons = messages(SUPPORT_CHAT)[0].args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.some((b) => /^adm:k:T-\d{6}-[A-Z0-9]{4}:42:pay_TZ8ciB8Yng8WE3$/.test(b)));
});

test('📋 Quick replies lists the answers for this issue type, relevant ones first', async () => {
  const sheet = fakeSheet({ getTicket: { ticket_id: 'T-260917-AB2C', category: 'payment', status: 'open' } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(adminTap('adm:q:T-260917-AB2C:42'));

  const [menu] = messages(SUPPORT_CHAT);
  const buttons = menu.args[2].reply_markup.inline_keyboard.flat();
  assert.equal(buttons[0].text, '📎 Ask for payment proof');
  assert.equal(buttons.at(-1).text, '✅ Resolved — close ticket');
  assert.equal(buttons[0].callback_data, 'adm:q1:T-260917-AB2C:42');
  assert.match(menu.args[1], /Payment not received/);
});

test('a quick reply is sent to the student, logged, and uses the text admins set', async () => {
  const sheet = fakeSheet({ getBotSettings: { qr_payment_not_received: 'Custom: no payment found.' } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(adminTap('adm:q2:T-260917-AB2C:42'));

  assert.match(messages(STUDENT.id)[0].args[1], /Support reply · T-260917-AB2C[\s\S]*Custom: no payment found\./);
  const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
  assert.equal(appended.args[1].logAction, 'quick_reply:qr_payment_not_received');
  assert.equal(appended.args[1].handledBy, '@ravi_admin');
  assert.equal(appended.args[1].status, undefined);
  assert.equal(sheet.calls.filter((c) => c.name === 'setTicketStatus').length, 0, 'a normal quick reply must never close');
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Status: 🟡 In progress · ⏳ Waiting for student/);
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Quick reply sent<\/b> by @ravi_admin/);
});

test('the "Resolved" quick reply also closes the ticket', async () => {
  const { deliver, sheet, messages } = makeBot();
  await deliver(adminTap('adm:q7:T-260917-AB2C:42'));
  assert.deepEqual(sheet.calls.find((c) => c.name === 'setTicketStatus').args, ['T-260917-AB2C', 'closed', '@ravi_admin']);
  const buttons = messages(SUPPORT_CHAT)[0].args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes('adm:o:T-260917-AB2C:42'), 'a closed ticket offers Reopen');
});

test('an invite that could not be sent is still written to the Support Log', async () => {
  await withResendInvite(async () => ({ sent: false, reason: 'no subscription on record', subscriber: null }), async () => {
    const { deliver, sheet } = makeBot();
    await deliver(adminTap('adm:i:T-260917-AB2C:42'));
    const logged = sheet.calls.find((c) => c.name === 'logTicketEvent');
    assert.equal(logged.args[0], 'T-260917-AB2C');
    assert.equal(logged.args[1].action, 'invite_not_sent');
    assert.equal(logged.args[1].who, '@ravi_admin');
  });
});

/** Replaces razorpay.getPayment for one test. */
async function withPayment(payment, fn) {
  const original = razorpay.getPayment;
  razorpay.getPayment = async () => {
    if (payment instanceof Error) throw payment;
    return payment;
  };
  try {
    return await fn();
  } finally {
    razorpay.getPayment = original;
  }
}

test('🔍 Check payment reports what Razorpay says and logs the check', async () => {
  await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'failed', amount: 19900, method: 'upi',
    created_at: 1789000000, error_description: 'Payment was declined by the bank' }, async () => {
    const { deliver, sheet, messages } = makeBot();
    await deliver(adminTap('adm:k:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));

    const [report] = messages(SUPPORT_CHAT);
    assert.match(report.args[1], /failed — no money was taken[\s\S]*₹199[\s\S]*declined by the bank/);
    assert.ok(!report.args[2].reply_markup.inline_keyboard.flat().some((b) => b.callback_data.startsWith('adm:g:')),
      'a failed payment must not offer a grant');
    const logged = sheet.calls.find((c) => c.name === 'logTicketEvent');
    assert.equal(logged.args[1].action, 'payment_checked');
    assert.match(logged.args[1].details, /failed/);
  });
});

test('a captured payment with no pass offers "Grant pass for this payment"', async () => {
  await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 19900, created_at: 1789000000 }, async () => {
    const { deliver, messages } = makeBot({ sheet: fakeSheet({ getSubscriber: null }) });
    await deliver(adminTap('adm:k:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
    const [report] = messages(SUPPORT_CHAT);
    assert.match(report.args[1], /Money was received but the student has no valid pass/);
    assert.ok(report.args[2].reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'adm:g:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
  });
});

test('granting asks which group first, then grants through the normal payment path', async () => {
  await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 14900, created_at: 1789000000 }, async () => {
    const original = membership.grantAccess;
    const grants = [];
    membership.grantAccess = async (options) => {
      grants.push(options);
      return { subscriber: { plan_label: 'Target 2026', expiry_date: '31-05-2099, 11:59:59 PM IST' }, inviteLink: 'https://t.me/+granted', alreadyProcessed: false };
    };
    try {
      const sheet = fakeSheet({
        getSubscriber: null,
        getBotSettings: { pass_valid_until: '31-05-2099', pass_name: 'Target 2026' },
        // ₹149 is only a legitimate price for this pass because this coupon exists.
        listCoupons: [{ code: 'SAVE50', discount_type: 'flat', discount_value: 50 }]
      });
      const { deliver, messages } = makeBot({ sheet });

      await deliver(adminTap('adm:g:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      const ask = messages(SUPPORT_CHAT)[0];
      assert.match(ask.args[1], /Grant a pass for <code>pay_TZ8ciB8Yng8WE3/);
      assert.equal(grants.length, 0, 'nothing is granted before the admin confirms');
      assert.equal(ask.args[2].reply_markup.inline_keyboard[0][0].callback_data, 'adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3');

      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.equal(grants.length, 1);
      assert.deepEqual({ ...grants[0] }, {
        groupId: 'upsc', telegramId: '42', planId: 'exam_pass', paymentId: 'pay_TZ8ciB8Yng8WE3',
        amountPaise: 14900, event: 'manual.grant', validUntil: '31-05-2099', planLabel: 'Target 2026'
      });
      assert.equal(messages(STUDENT.id)[0].args[2].reply_markup.inline_keyboard[0][0].url, 'https://t.me/+granted');
      const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
      assert.equal(appended.args[1].logAction, 'pass_granted');
      assert.match(messages(SUPPORT_CHAT).at(-1).args[1], /Pass granted<\/b> by @ravi_admin/);
    } finally {
      membership.grantAccess = original;
    }
  });
});

test('a grant is refused when the payment was not captured, belongs to someone else, or was already used', async () => {
  const original = membership.grantAccess;
  let granted = 0;
  membership.grantAccess = async () => { granted++; return {}; };
  try {
    await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'authorized', amount: 19900 }, async () => {
      const { deliver, messages } = makeBot();
      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.match(messages(SUPPORT_CHAT)[0].args[1], /Not granted.<\/b> Razorpay does not show this payment as captured/);
    });
    await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 19900, notes: { telegram_id: '999' } }, async () => {
      const { deliver, messages } = makeBot();
      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.match(messages(SUPPORT_CHAT)[0].args[1], /another student's checkout/);
    });
    await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 19900 }, async () => {
      const sheet = fakeSheet({ findPayment: { telegram_id: '777', source: 'Payments' } });
      const { deliver, messages } = makeBot({ sheet });
      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.match(messages(SUPPORT_CHAT)[0].args[1], /already recorded for Telegram id <code>777/);
      assert.equal(sheet.calls.find((c) => c.name === 'logTicketEvent').args[1].action, 'pass_grant_refused');
    });
    // On a sheet whose Apps Script is older than findPayment, the member rows are searched instead.
    await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 19900 }, async () => {
      const stale = Object.assign(new Error('old script'), { staleScript: true });
      const sheet = fakeSheet({
        findPayment: () => { throw stale; },
        listSubscribers: { total: 1, subscribers: [{ telegram_id: '888', payment_id: 'pay_TZ8ciB8Yng8WE3' }] }
      });
      const { deliver, messages } = makeBot({ sheet });
      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.match(messages(SUPPORT_CHAT)[0].args[1], /already recorded for Telegram id <code>888/);
    });
    // Any other sheet error refuses rather than granting blind.
    await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 19900 }, async () => {
      const sheet = fakeSheet({ findPayment: () => { throw new Error('Sheets down'); } });
      const { deliver, messages } = makeBot({ sheet });
      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.match(messages(SUPPORT_CHAT)[0].args[1], /Could not check the payment records, so nothing was granted/);
    });
    // A payment below the lowest price anyone can pay is not a payment for this pass.
    await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 100 }, async () => {
      const sheet = fakeSheet({ listCoupons: [{ code: 'HALF', discount_type: 'percent', discount_value: 50 }] });
      const { deliver, messages } = makeBot({ sheet });
      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.match(messages(SUPPORT_CHAT)[0].args[1], /This payment is ₹1, less than the lowest price anyone can pay for the pass today \(₹99.50/);
    });
    assert.equal(granted, 0);
  } finally {
    membership.grantAccess = original;
  }
});

test('/msg by Telegram id messages the student and opens a logged conversation', async () => {
  const { deliver, sheet, messages } = makeBot();
  await deliver(supportChatMessage('/msg 42 Your refund has been processed.'));

  const [toStudent] = messages(STUDENT.id);
  const ticketId = support.parseReplyLine(toStudent.args[1]);
  assert.ok(ticketId, 'the message must carry a ticket so the student\'s reply threads');
  assert.match(toStudent.args[1], /Your refund has been processed\./);

  const created = sheet.calls.find((c) => c.name === 'createTicket').args[0];
  assert.equal(created.ticket_id, ticketId);
  assert.equal(created.opened_by, '@ravi_admin');
  assert.equal(created.telegram_id, '42');
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Message sent<\/b> by @ravi_admin/);
});

test('/msg by @username finds the student in the members sheet', async () => {
  const sheet = fakeSheet({ listSubscribers: { total: 1, subscribers: [{ telegram_id: '42', username: 'Asha', name: 'Asha K' }] } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/msg @asha hello'));
  assert.equal(messages(STUDENT.id).length, 1);

  const unknown = makeBot();
  await unknown.deliver(supportChatMessage('/msg @nobody_here hello'));
  assert.match(unknown.messages(SUPPORT_CHAT)[0].args[1], /No student found/);
  await unknown.deliver(supportChatMessage('/msg 42'));
  assert.match(unknown.messages(SUPPORT_CHAT).at(-1).args[1], /Usage/);
});


test('a payment at the best coupon price is accepted for a grant', async () => {
  await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 9950, created_at: 1789000000 }, async () => {
    const original = membership.grantAccess;
    let granted = 0;
    membership.grantAccess = async () => { granted++; return { subscriber: { expiry_date: 'x' }, inviteLink: '', alreadyProcessed: false }; };
    try {
      const sheet = fakeSheet({ getSubscriber: null, listCoupons: [{ code: 'HALF', discount_type: 'percent', discount_value: 50, active: false }] });
      const { deliver } = makeBot({ sheet });
      await deliver(adminTap('adm:g0:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'));
      assert.equal(granted, 1, 'a real discounted payment, even with a coupon since switched off, must still be grantable');
    } finally {
      membership.grantAccess = original;
    }
  });
});

test('coupon guessing is limited per student', async () => {
  const sheet = fakeSheet({ getCoupon: null });
  const { deliver, messages } = makeBot({ sheet });
  const prompt = { message_id: 1, from: BOT, chat: { id: STUDENT.id }, text: '🎟 Coupon code for UPSC Prelims' };
  for (let i = 0; i < 10; i++) await deliver(privateMessage(`GUESS${i}`, { reply_to_message: prompt }));
  assert.equal(sheet.calls.filter((c) => c.name === 'getCoupon').length, 8, 'only 8 lookups in the window');
  assert.match(messages(STUDENT.id).at(-1).args[1], /Too many code attempts/);
});

test('a flood of free-typed messages stops reaching the sheet', async () => {
  const sheet = fakeSheet();
  const { deliver } = makeBot({ sheet });
  for (let i = 0; i < 25; i++) await deliver(privateMessage(`spam ${i}`));
  assert.equal(sheet.calls.filter((c) => c.name === 'listTickets').length, 20);
});

test('student commands only answer in a private chat, never in a paid group or the support chat', async () => {
  const { deliver, sent } = makeBot();
  for (const text of ['/status', '/plans', '/start', '/help', '/cancel']) {
    await deliver({ message: { message_id: messageSeq++, date: 1, from: STUDENT, chat: { id: -1009999999999, type: 'supergroup' }, text } });
    await deliver(supportChatMessage(text));
  }
  assert.equal(sent.filter((s) => s.method === 'sendMessage').length, 0, 'a command in a group was answered in public');
});

test('student commands still answer in private, including with the bot\'s @name', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/help@upsc_pay_bot'));
  await deliver(privateMessage('/status'));
  assert.ok(messages(STUDENT.id).length >= 2);
});

test('/statusx is not mistaken for /status', async () => {
  const sheet = fakeSheet();
  const { deliver } = makeBot({ sheet });
  await deliver(privateMessage('/statusx'));
  assert.equal(sheet.calls.filter((c) => c.name === 'getSubscriber').length, 0);
});

// ---------------------------------------------------------------------------
// Bots that sell two groups: which group a ticket is about
// ---------------------------------------------------------------------------

const NEWS_ENV = {
  SHEET_URL_APPSC_NEWS_EN: 'https://script.google.com/macros/s/test-en/exec',
  SHEET_TOKEN_APPSC_NEWS_EN: 'token-en',
  TELEGRAM_GROUP_APPSC_NEWS_EN: '-1001111111111',
  SHEET_URL_APPSC_NEWS_TE: 'https://script.google.com/macros/s/test-te/exec',
  SHEET_TOKEN_APPSC_NEWS_TE: 'token-te',
  TELEGRAM_GROUP_APPSC_NEWS_TE: '-1002222222222',
  TELEGRAM_PAYBOT_NEWS: '456:TEST',
  SUPPORT_CHAT_NEWS: SUPPORT_CHAT
};

/**
 * A bot for the two newspaper groups. `sheetsById` gives each group its own
 * sheet; tickets live in the first (English) one.
 */
async function withNewsBot(sheetsById, fn, { memberStatus = 'member' } = {}) {
  const saved = {};
  Object.keys(NEWS_ENV).forEach((key) => { saved[key] = process.env[key]; process.env[key] = NEWS_ENV[key]; });
  const originalForGroup = sheets.forGroup;
  sheets.forGroup = (id) => sheetsById[id] || fakeSheet();
  try {
    const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_NEWS', polling: false });
    const sent = [];
    let nextId = 5000;
    const record = (method) => async (...args) => {
      sent.push({ method, args });
      return { message_id: nextId++, chat: { id: args[0] } };
    };
    ['sendMessage', 'copyMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText', 'deleteMessage']
      .forEach((method) => { app.bot[method] = record(method); });
    app.bot.getMe = async () => NEWS_BOT;
    app.bot.getChatMember = async () => ({ status: memberStatus });
    const deliver = async (update) => {
      app.bot.processUpdate(Object.assign({ update_id: nextId++ }, update));
      await app.settle();
    };
    const messages = (chatId) => sent.filter((s) => s.method === 'sendMessage' && String(s.args[0]) === String(chatId));
    await fn({ app, sent, deliver, messages });
  } finally {
    sheets.forGroup = originalForGroup;
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

const NEWS_BOT = { id: 456, is_bot: true, first_name: 'News bot', username: 'news_pay_bot' };
const PASS = { status: 'active', expiry_date: '30-11-2099, 11:59:59 PM IST', plan_label: 'Target 2026 Pass', total_paid: 199, payment_id: 'pay_ENGLISHPASS001' };

test('with two groups, "I still need help" asks which group, and the prompt carries it', async () => {
  const en = fakeSheet();
  await withNewsBot({ appsc_news_en: en, appsc_news_te: fakeSheet() }, async ({ deliver, messages }) => {
    await deliver(tap('sup:ask:payment'));
    const [choice] = messages(STUDENT.id);
    assert.match(choice.args[1], /Which group is this about/);
    const buttons = choice.args[2].reply_markup.inline_keyboard.flat();
    assert.deepEqual(buttons.map((b) => b.text), ['Newspaper · English', 'Newspaper · Telugu', 'Both / not sure']);
    assert.deepEqual(buttons.map((b) => b.callback_data), ['sup:grp:payment:0', 'sup:grp:payment:1', 'sup:grp:payment:x']);

    await deliver(tap('sup:grp:payment:1'));
    const prompt = messages(STUDENT.id).at(-1);
    assert.equal(support.parsePrompt(prompt.args[1]).id, 'payment');
    assert.equal(support.parsePromptGroup(prompt.args[1]), 'Newspaper · Telugu');
  });
});

test('a ticket about a chosen group is stored with it, and admins see which pass is the ticket\'s', async () => {
  const en = fakeSheet({ getSubscriber: PASS });
  const te = fakeSheet({ getSubscriber: Object.assign({}, PASS, { payment_id: 'pay_TELUGUPASS0001' }) });
  await withNewsBot({ appsc_news_en: en, appsc_news_te: te }, async ({ deliver, messages }) => {
    const prompt = { message_id: 700, from: NEWS_BOT, chat: { id: STUDENT.id, type: 'private' },
      text: support.promptLine(support.categoryById('invite'), 'Newspaper · Telugu') };
    await deliver(privateMessage('cannot see the posts', { reply_to_message: prompt }));

    const created = en.calls.find((c) => c.name === 'createTicket').args[0];
    assert.equal(created.group, 'appsc_news_te');
    assert.ok(!en.calls.some((c) => c.name === 'setTicketGroup'), 'a chosen group needs no second write');

    const card = messages(SUPPORT_CHAT)[0].args[1];
    assert.match(card, /<b>Group:<\/b> Newspaper · Telugu\n/);
    assert.match(card, /<b>Newspaper · Telugu<\/b> · 📌 <i>this ticket<\/i>/);
    assert.ok(!/<b>Newspaper · English<\/b> · 📌/.test(card), 'only the ticket\'s group is marked');
    assert.match(card, /Next step:<\/b> Pass is valid and they are already in Newspaper · Telugu →/);

    const confirmation = messages(STUDENT.id).at(-1).args[1];
    assert.match(confirmation, /<b>Group:<\/b> Newspaper · Telugu/);
  });
});

test('a ticket with no group chosen is filed under the only group the student holds a pass in', async () => {
  const en = fakeSheet({ getSubscriber: null });
  const te = fakeSheet({ getSubscriber: PASS });
  await withNewsBot({ appsc_news_en: en, appsc_news_te: te }, async ({ deliver, messages }) => {
    const prompt = { message_id: 701, from: NEWS_BOT, chat: { id: STUDENT.id, type: 'private' },
      text: support.promptLine(support.categoryById('invite')) };
    await deliver(privateMessage('link does not open', { reply_to_message: prompt }));

    assert.equal(en.calls.find((c) => c.name === 'createTicket').args[0].group, '');
    const set = en.calls.find((c) => c.name === 'setTicketGroup');
    assert.ok(set, 'the guessed group should be recorded');
    assert.equal(set.args[1], 'appsc_news_te');
    assert.match(messages(SUPPORT_CHAT)[0].args[1], /<b>Group:<\/b> Newspaper · Telugu <i>\(not chosen — their only pass\)<\/i>/);
  });
});

test('a group whose sheet cannot be read says so instead of "no pass", and the next step says to retry', async () => {
  const en = fakeSheet({ getSubscriber: () => { throw new Error('Google Sheets request timed out after 30s'); } });
  const te = fakeSheet({ getSubscriber: null });
  await withNewsBot({ appsc_news_en: en, appsc_news_te: te }, async ({ deliver, messages }) => {
    const prompt = { message_id: 702, from: NEWS_BOT, chat: { id: STUDENT.id, type: 'private' },
      text: support.promptLine(support.categoryById('payment'), 'Newspaper · English') };
    await deliver(privateMessage('paid yesterday', { reply_to_message: prompt }));
    const card = messages(SUPPORT_CHAT)[0].args[1];
    assert.match(card, /⚠️ <b>Newspaper · English<\/b>[\s\S]*took too long to answer/);
    assert.match(card, /➖ <b>Newspaper · Telugu<\/b>\n\s+No pass/);
    assert.match(card, /Next step:<\/b> Could not read Newspaper · English just now/);
  });
});

test('/find pay_… shows Razorpay, which group recorded it, and the student\'s tickets with their buttons', async () => {
  const en = fakeSheet({
    listTickets: { total: 1, tickets: [{ ticket_id: 'T-260917-AB2C', telegram_id: '42', status: 'open', waiting_on: 'admin',
      category: 'payment', group: 'appsc_news_te', updated_at: '17-09-2026, 06:48:00 PM IST' }], counts: {} }
  });
  const te = fakeSheet({ findPayment: { telegram_id: '42' } });
  await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 19900, method: 'upi',
    created_at: 1789000000, notes: { telegram_id: '42' } }, async () => {
    await withNewsBot({ appsc_news_en: en, appsc_news_te: te }, async ({ deliver, messages }) => {
      await deliver(supportChatMessage('/find pay_TZ8ciB8Yng8WE3'));
      const [post] = messages(SUPPORT_CHAT);
      const text = post.args[1];
      assert.match(text, /captured — the money was received/);
      assert.match(text, /Belongs to:<\/b> the checkout of Telegram id <code>42<\/code>/);
      assert.match(text, /Recorded in <b>Newspaper · Telugu<\/b> for Telegram id <code>42<\/code>/);
      assert.match(text, /<code>T-260917-AB2C<\/code> · 🆕 Open · 🔴 Needs reply\n\s+Paid, but no invite link · Newspaper · Telugu/);
      const buttons = post.args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
      assert.ok(buttons.includes('adm:g:T-260917-AB2C:42:pay_TZ8ciB8Yng8WE3'), 'a captured payment offers Grant');
      assert.ok(buttons.includes('adm:r:T-260917-AB2C:42'));

      // Pasting the id without a command does the same.
      await deliver(supportChatMessage('student says pay_TZ8ciB8Yng8WE3 is theirs'));
      assert.match(messages(SUPPORT_CHAT).at(-1).args[1], /Recorded in <b>Newspaper · Telugu/);
    });
  });
});

test('/find warns when a captured payment is recorded nowhere', async () => {
  await withPayment({ id: 'pay_TZ8ciB8Yng8WE3', status: 'captured', amount: 19900, created_at: 1789000000, notes: {} }, async () => {
    const { deliver, messages } = makeBot();
    await deliver(supportChatMessage('/find pay_TZ8ciB8Yng8WE3'));
    assert.match(messages(SUPPORT_CHAT)[0].args[1], /Not recorded in any group/);
  });
});

test('/find with no argument explains itself; a ticket id posts that ticket', async () => {
  const sheet = fakeSheet({ getTicket: { ticket_id: 'T-260917-AB2C', telegram_id: '42', status: 'in_progress',
    waiting_on: 'student', category: 'coupon', last_message: 'code SAVE50 fails', updated_at: 'x', conversation: '' } });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/find'));
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Usage/);
  await deliver(supportChatMessage('/find t-260917-ab2c'));
  const card = messages(SUPPORT_CHAT)[1];
  assert.deepEqual(support.parseTicketHeader(card.args[1]), { ticketId: 'T-260917-AB2C', telegramId: '42' });
  assert.match(card.args[1], /Coupon code not working[\s\S]*code SAVE50 fails/);
});

test('every ticket post has a Summary button that posts the summary', async () => {
  const sheet = fakeSheet({ getSupportStats: SAMPLE_STATS });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(adminTap('adm:p:T-260917-AB2C:42'));
  const buttons = messages(SUPPORT_CHAT)[0].args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes('sum:show'));
  await deliver(adminTap('sum:show'));
  assert.match(messages(SUPPORT_CHAT).at(-1).args[1], /support summary/);
});
