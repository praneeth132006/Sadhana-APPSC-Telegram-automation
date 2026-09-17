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
    listTickets: record('listTickets', { total: 0, tickets: [], counts: { open: 0 } }),
    getSubscriber: record('getSubscriber', { status: 'active', expiry_date: '30-11-2026' })
  };
  Object.entries(overrides).forEach(([name, result]) => { client[name] = record(name, result); });
  return client;
}

/** A bot wired to a fake sheet, with every Telegram call recorded. */
function makeBot({ sheet = fakeSheet(), supportChat = SUPPORT_CHAT } = {}) {
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
  ['sendMessage', 'copyMessage', 'answerCallbackQuery', 'editMessageReplyMarkup', 'deleteMessage']
    .forEach((method) => { app.bot[method] = record(method); });
  app.bot.getMe = async () => BOT;

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
  assert.deepEqual(buttons, support.CATEGORIES.map((c) => `sup:faq:${c.id}`));
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
  assert.match(toAdmins.args[1], /active<\/b> until 30-11-2026/, 'admins should see the student\'s pass');
  assert.match(toAdmins.args[1], /pay_ABC123/);

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

test('commands are left to their own handlers, not offered to support', async () => {
  const { deliver, messages } = makeBot();
  await deliver(privateMessage('/nonsense'));
  assert.equal(messages(STUDENT.id).length, 0);
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

test('replying to an admin answer adds to the ticket and reopens it', async () => {
  const { deliver, sheet, messages } = makeBot();
  const answer = { message_id: 902, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.replyLine('T-260917-AB2C') + '\n\nTry again now' };

  await deliver(privateMessage('Still not working', { reply_to_message: answer }));

  const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
  assert.equal(appended.args[0], 'T-260917-AB2C');
  assert.equal(appended.args[1].status, 'open');
  assert.equal(appended.args[1].text, 'Still not working');

  const [toAdmins] = messages(SUPPORT_CHAT);
  assert.match(toAdmins.args[1], /Follow-up from the student/);
  assert.ok(support.parseTicketHeader(toAdmins.args[1]));
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
  assert.equal(appended.args[1].status, 'answered');
  assert.equal(appended.args[1].handledBy, '@ravi_admin');

  const [confirmation] = messages(SUPPORT_CHAT);
  assert.match(confirmation.args[1], /Delivered to the student/);
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
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Not delivered: Forbidden/);
});

test('/close on a ticket closes it and tells the student', async () => {
  const { deliver, sheet, messages } = makeBot();
  await deliver(supportChatMessage('/close', { reply_to_message: ticketMessage() }));

  const closed = sheet.calls.find((c) => c.name === 'setTicketStatus');
  assert.deepEqual(closed.args, ['T-260917-AB2C', 'closed', '@ravi_admin']);
  assert.match(messages(STUDENT.id)[0].args[1], /marked as resolved/);
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Closed by @ravi_admin/);
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

test('/tickets lists open tickets from the sheet', async () => {
  const sheet = fakeSheet({
    listTickets: {
      total: 1, counts: { open: 1, answered: 2, closed: 3 },
      tickets: [{ ticket_id: 'T-260917-AB2C', username: 'asha', category: 'invite', last_message: 'link broken' }]
    }
  });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/tickets'));

  const [list] = messages(SUPPORT_CHAT);
  assert.match(list.args[1], /Open 1 · Answered 2 · Closed 3/);
  assert.match(list.args[1], /T-260917-AB2C[\s\S]*@asha[\s\S]*Invite link not working[\s\S]*link broken/);
});
