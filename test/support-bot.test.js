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

test('replying to an admin answer adds to the ticket and shows admins what came before', async () => {
  const conversation =
    '[17-09-2026, 10:12:03 AM IST] Asha (@asha):\nPaid but no link\n\n' +
    '[17-09-2026, 11:40:10 AM IST] Admin @ravi_admin:\nTry again now\n\n' +
    '[17-09-2026, 11:50:00 AM IST] Asha (@asha):\nStill not working';
  const sheet = fakeSheet({ appendTicketMessage: (id) => ({ ticket_id: id, status: 'open', conversation }) });
  const { deliver, messages } = makeBot({ sheet });
  const answer = { message_id: 902, from: BOT, chat: { id: STUDENT.id, type: 'private' },
    text: support.replyLine('T-260917-AB2C') + '\n\nTry again now' };

  await deliver(privateMessage('Still not working', { reply_to_message: answer }));

  const appended = sheet.calls.find((c) => c.name === 'appendTicketMessage');
  assert.equal(appended.args[0], 'T-260917-AB2C');
  assert.equal(appended.args[1].status, 'open');
  assert.equal(appended.args[1].text, 'Still not working');

  const [toAdmins] = messages(SUPPORT_CHAT);
  const text = toAdmins.args[1];
  assert.ok(support.parseTicketHeader(text));
  assert.match(text, /Student replied/);
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

test('a closed or stale ticket is not reused; the student is offered a new one', async () => {
  const sheet = fakeSheet({
    listTickets: { total: 2, tickets: [
      { ticket_id: 'T-260917-AAAA', status: 'closed', updated_at: '' },
      { ticket_id: 'T-260801-BBBB', status: 'open', updated_at: '01-08-2020, 10:00:00 AM IST' }
    ] }
  });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(privateMessage('new problem'));

  assert.equal(sheet.calls.filter((c) => c.name === 'appendTicketMessage').length, 0);
  assert.match(messages(STUDENT.id)[0].args[1], /send this message to our support team/);
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

test('/tickets posts each waiting ticket with its own buttons', async () => {
  const sheet = fakeSheet({
    listTickets: (filters) => filters.status === 'open'
      ? { total: 1, counts: { open: 1, answered: 1, closed: 3 },
        tickets: [{ ticket_id: 'T-260917-AB2C', telegram_id: '42', username: 'asha', category: 'invite', status: 'open', last_message: 'link broken' }] }
      : { total: 1, counts: { open: 1, answered: 1, closed: 3 },
        tickets: [{ ticket_id: 'T-260916-ZZ99', telegram_id: '43', name: 'Ravi', category: 'payment', status: 'answered', last_message: 'thanks' }] }
  });
  const { deliver, messages } = makeBot({ sheet });
  await deliver(supportChatMessage('/tickets'));

  const posts = messages(SUPPORT_CHAT);
  assert.match(posts[0].args[1], /Open 1 · 🔵 Answered 1 · ✅ Closed 3/);
  assert.equal(posts.length, 3, 'a summary plus one post per waiting ticket');
  assert.match(posts[1].args[1], /^🎫 T-260917-AB2C · user 42[\s\S]*Invite link not working[\s\S]*link broken/);
  assert.ok(posts[1].args[2].reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'adm:c:T-260917-AB2C:42'));
  assert.match(posts[2].args[1], /^🎫 T-260916-ZZ99 · user 43/);
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
    assert.match(messages(SUPPORT_CHAT)[0].args[1], /no invite sent — subscription has expired[\s\S]*needs an active pass/);
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
  assert.equal(sheet.calls.find((c) => c.name === 'appendTicketMessage').args[1].status, 'answered');
});

test('🎟 Pass status shows every group the student holds', async () => {
  const { deliver, messages } = makeBot();
  await deliver(adminTap('adm:p:T-260917-AB2C:42'));
  assert.match(messages(SUPPORT_CHAT)[0].args[1], /Pass status[\s\S]*active<\/b> until 30-11-2026/);
});

test('📜 Full history posts the whole conversation, or explains when it is missing', async () => {
  const found = makeBot({ sheet: fakeSheet({ getTicket: {
    ticket_id: 'T-260917-AB2C', status: 'answered', handled_by: '@ravi_admin',
    conversation: '[17-09-2026, 10:12:03 AM IST] Asha:\nfirst <message>'
  } }) });
  await found.deliver(adminTap('adm:h:T-260917-AB2C:42'));
  assert.match(found.messages(SUPPORT_CHAT)[0].args[1], /Full history[\s\S]*answered[\s\S]*first &lt;message&gt;/);

  const missing = makeBot({ sheet: fakeSheet({ getTicket: null }) });
  await missing.deliver(adminTap('adm:h:T-260917-AB2C:42'));
  assert.match(missing.messages(SUPPORT_CHAT)[0].args[1], /not in the sheet/);
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
  assert.match(post.args[1], /Full history/);
});
