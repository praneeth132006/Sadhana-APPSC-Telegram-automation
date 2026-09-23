// ============================================================================
// The influencer bot (test/affiliate-bot.test.js)
// ============================================================================
// The bot run against the real store on an in-memory sheet, so an application
// typed in chat is checked all the way to the Requests tab, and a withdrawal
// all the way to Payouts. Telegram is recorded, never called.
//
// It is held to the same rule the payment bots were after the ad rejection:
// every command, every unknown command, every sticker gets an answer.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'bot@test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
});
process.env.AFFILIATE_SHEET_ID = 'AFFILIATESHEET1234567890abc';
process.env.TELEGRAM_AFFILIATE_BOT = '777:TEST';
process.env.SUPPORT_CHAT_ID = '-1005555555555';
delete process.env.AFFILIATE_ADMIN_CHAT_ID;
process.env.PUBLIC_BASE_URL = 'https://appscsadhana.vercel.app';
process.env.LEGACY_GROUP_ID = '';
for (const prefix of ['APPSC_NEWS_EN', 'APPSC_NEWS_TE', 'APPSC_Q_EN', 'APPSC_Q_TE', 'UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + Math.abs(prefix.length * 7919);
}
process.env.TELEGRAM_PAYBOT_NEWS = '111:TEST';
process.env.TELEGRAM_PAYBOT_SADHANA = '222:TEST';
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
process.env.TELEGRAM_PAYBOT_EPFO = '444:TEST';

require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};

const { fakeSheetsApi } = require('./helpers/fake-sheets');
const store = require('../src/affiliate-store');
const affiliates = require('../src/affiliates');
const notify = require('../src/affiliate-notify');
const botCommands = require('../src/bot-commands');
const { createAffiliateBot, PROMPT } = require('../src/affiliatebot');

const RAVI = { id: 501, is_bot: false, first_name: 'Ravi', last_name: 'Kumar', username: 'ravi_teaches' };
const BOT_ID = 777;

function makeBot() {
  const book = {};
  fakeSheetsApi(book, 'AFFILIATESHEET1234567890abc');
  const alerts = [];
  notify.useClient({ sendMessage: async (chatId, text, extra) => { alerts.push({ chatId: String(chatId), text, extra }); return {}; } });

  const app = createAffiliateBot({ polling: false });
  const sent = [];
  const record = (method) => async (...args) => { sent.push({ method, args }); return { message_id: sent.length }; };
  ['sendMessage', 'sendChatAction', 'answerCallbackQuery'].forEach((m) => { app.bot[m] = record(m); });

  let seq = 1;
  const deliver = async (update) => {
    const before = sent.length;
    app.bot.processUpdate(Object.assign({ update_id: seq++ }, update));
    await app.settle();
    return sent.slice(before).filter((s) => s.method === 'sendMessage');
  };
  const say = (text, extra = {}, from = RAVI, chat = { id: RAVI.id, type: 'private' }) => deliver({ message: Object.assign(
    { message_id: seq++, date: 1, from, chat }, text === null ? {} : { text }, extra) });
  const tap = (data) => deliver({ callback_query: { id: 'cb' + seq++, from: RAVI, data,
    message: { message_id: 1, date: 1, chat: { id: RAVI.id, type: 'private' }, text: '…' } } });
  /** Answers a prompt the bot sent, the way Telegram delivers a reply. */
  const answer = (prompt, text) => say(text, { reply_to_message: {
    message_id: 9, from: { id: BOT_ID, is_bot: true }, chat: { id: RAVI.id, type: 'private' }, text: prompt } });
  return { app, book, sent, alerts, say, tap, answer };
}

const textOf = (messages) => messages.map((m) => m.args[1]).join('\n---\n');
const buttons = (messages) => messages.flatMap((m) =>
  ((m.args[2] && m.args[2].reply_markup && m.args[2].reply_markup.inline_keyboard) || []).flat());

test('every command on the menu, and the ones Telegram expects, gets an answer', async () => {
  const { say } = makeBot();
  for (const text of [...botCommands.AFFILIATE_COMMANDS.map((c) => '/' + c.command), '/settings', '/status', '/START', '/Codes']) {
    const out = await say(text);
    assert.ok(out.length > 0, `the affiliate bot said nothing to ${text}`);
  }
});

test('unknown commands, stickers and plain messages get pointed somewhere', async () => {
  const { say } = makeBot();
  assert.match(textOf(await say('/menu')), /do not know that command/);
  assert.match(textOf(await say('/referral')), /do not know that command/);
  assert.match(textOf(await say(null, { sticker: { file_id: 's' } })), /\/apply/);
  assert.match(textOf(await say('hi, how do I join?')), /\/apply/);
});

test('nothing is said in a group chat, even though the bot may sit in the admin chat', async () => {
  const { say } = makeBot();
  const out = await say('/start', {}, RAVI, { id: -1005555555555, type: 'supergroup' });
  assert.equal(out.length, 0);
});

test('the welcome explains the programme and offers the four actions', async () => {
  const { say } = makeBot();
  const out = await say('/start');
  assert.match(out[0].args[1], /Welcome to our influencer programme/);
  assert.deepEqual(buttons(out).map((b) => b.callback_data), ['aff:apply', 'aff:codes', 'aff:withdraw', 'aff:payout']);
});

test('applying: choose an exam, give email and mobile, and the admin is alerted', async () => {
  const { tap, answer, alerts, book } = makeBot();

  const exams = await tap('aff:apply');
  // One button per exam open to influencers — the APPSC ones for now.
  const offered = buttons(exams).map((b) => [b.text, b.callback_data]);
  assert.deepEqual(offered, affiliates.listExams().map((e) => [e.label, `aff:exam:${e.id}`]));
  assert.ok(offered.some(([, data]) => data === 'aff:exam:news'));
  assert.ok(!offered.some(([, data]) => /upsc|epfo/.test(data)), 'a closed exam was offered');

  const emailPrompt = await tap('aff:exam:news');
  assert.ok(emailPrompt[0].args[1].startsWith(`${PROMPT.applyEmail}APPSC Newspaper`));
  assert.equal(emailPrompt[0].args[2].reply_markup.force_reply, true);
  assert.match(textOf(await answer(`${PROMPT.applyEmail}APPSC Newspaper`, 'not-an-email')), /does not look like an email/);

  const phonePrompt = await answer(`${PROMPT.applyEmail}APPSC Newspaper`, 'Ravi@Gmail.com');
  // The email is confirmed out loud before the next question.
  assert.match(phonePrompt[0].args[1], /Your email is set: <b>ravi@gmail\.com/);
  assert.ok(phonePrompt[1].args[1].startsWith(`${PROMPT.applyPhone}APPSC Newspaper`));
  assert.match(textOf(await answer(`${PROMPT.applyPhone}APPSC Newspaper`, '123')), /10-digit/);

  const done = await answer(`${PROMPT.applyPhone}APPSC Newspaper`, '+91 98765 43210');
  assert.match(done[0].args[1], /Your mobile number is set: <b>9876543210/);
  assert.match(done[1].args[1], /Application sent for APPSC Newspaper/);
  assert.match(done[1].args[1], /REQ-\d{8}-/);
  assert.match(done[1].args[1], /ravi@gmail\.com/);
  assert.match(done[1].args[1], /9876543210/);
  assert.match(done[1].args[1], /we still need: <b>Name as on your bank account, UPI ID/);
  assert.deepEqual(buttons(done).map((b) => b.callback_data), ['aff:set:email', 'aff:set:phone', 'aff:payout']);

  // The contact details are on their row, ready for a payout.
  const person = await store.getInfluencer(501);
  assert.equal(person.email, 'ravi@gmail.com');
  assert.equal(person.phone, '9876543210');

  // In the sheet, as the admin will see it.
  const [header, row] = book.Requests;
  const cell = (name) => row[header.indexOf(name)];
  assert.equal(cell('Telegram ID'), '501');
  assert.equal(cell('Exam'), 'news');
  assert.equal(cell('Exam Bot'), 'TELEGRAM_PAYBOT_NEWS');
  assert.equal(cell('Status'), 'pending');
  assert.match(cell('Details'), /ravi@gmail\.com · Mobile: 9876543210/);

  // And the admins were told, in Support Team, with a way to decide it.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].chatId, '-1005555555555');
  assert.match(alerts[0].text, /New influencer application/);
  assert.match(alerts[0].text, /ravi_teaches/);
  assert.equal(alerts[0].extra.reply_markup.inline_keyboard[0][0].url, 'https://appscsadhana.vercel.app/influencers.html');
});

test('an email or mobile sent without tapping Reply still continues the application', async () => {
  const { tap, say, alerts } = makeBot();
  await tap('aff:exam:news');
  const afterEmail = await say('ravi@gmail.com');
  assert.match(afterEmail[0].args[1], /Your email is set: <b>ravi@gmail\.com/);
  assert.ok(afterEmail[1].args[1].startsWith(`${PROMPT.applyPhone}APPSC Newspaper`));

  const done = await say('9876543210');
  assert.match(textOf(done), /Application sent for APPSC Newspaper/);
  assert.equal(alerts.length, 1);

  // Once sent, a stray email is saved as a payout detail, and said so.
  const later = await say('new@gmail.com');
  assert.match(textOf(later), /Saved: <b>Email/);
  assert.equal((await store.getInfluencer(501)).email, 'new@gmail.com');
});

test('details already given are not asked for again, and a finished payout setup is said so', async () => {
  const { tap, answer } = makeBot();
  await answer(PROMPT.legal_name, 'Ravi Kumar');
  await answer(PROMPT.upi, 'ravi@okicici');
  await answer(PROMPT.email, 'ravi@gmail.com');
  await answer(PROMPT.phone, '9876543210');
  const out = await tap('aff:exam:news');
  assert.equal(out.length, 1, 'it asked for a detail it already had');
  assert.match(out[0].args[1], /Application sent for APPSC Newspaper/);
  assert.match(out[0].args[1], /payout details are all set up/);
  assert.deepEqual(buttons(out).map((b) => b.text), ['✉️ Change email', '📱 Change mobile', '💳 Payout details']);
});

test('email and mobile can be changed while the application waits, and the admin sees the new ones', async () => {
  const { tap, answer, book } = makeBot();
  await tap('aff:exam:news');
  await answer(`${PROMPT.applyEmail}APPSC Newspaper`, 'ravi@gmail.com');
  await answer(`${PROMPT.applyPhone}APPSC Newspaper`, '9876543210');

  const prompt = await tap('aff:set:email');
  assert.ok(prompt[0].args[1].startsWith(PROMPT.email));
  const saved = await answer(PROMPT.email, 'ravi.new@gmail.com');
  assert.match(textOf(saved), /your application now shows the new one/);
  await answer(PROMPT.phone, '9123456780');

  const [header, row] = book.Requests;
  assert.equal(row[header.indexOf('Details')], 'Email: ravi.new@gmail.com · Mobile: 9123456780');
});

test('once approved, email and mobile are locked; the rest can still change', async () => {
  const { tap, answer, say } = makeBot();
  await tap('aff:exam:news');
  await answer(`${PROMPT.applyEmail}APPSC Newspaper`, 'ravi@gmail.com');
  await answer(`${PROMPT.applyPhone}APPSC Newspaper`, '9876543210');
  const [request] = await store.listRequests();
  const terms = affiliates.validateTerms({ discount_type: 'percent', discount_value: 10, commission_type: 'percent',
    commission_value: 20, payout_cycle: 'weekly', min_payout: 0 }).value;
  await store.approveRequest(request.request_id, Object.assign({}, terms, { code: 'RAVI10' }), 'Admin');

  // The card shows them locked, with no button to change them.
  const card = await tap('aff:payout');
  assert.match(textOf(card), /cannot be changed here/);
  const data = buttons(card).map((b) => b.callback_data);
  assert.ok(!data.includes('aff:set:email') && !data.includes('aff:set:phone'), 'offered to change a locked detail');
  assert.ok(data.includes('aff:set:upi_id'));

  // An old button, a stale prompt or a typed address is refused all the same.
  assert.match(textOf(await tap('aff:set:email')), /cannot be changed once your application is approved/);
  assert.match(textOf(await answer(PROMPT.phone, '9123456780')), /cannot be changed/);
  assert.match(textOf(await say('other@gmail.com')), /cannot be changed/);
  const person = await store.getInfluencer(501);
  assert.equal(person.email, 'ravi@gmail.com');
  assert.equal(person.phone, '9876543210');

  // Other payout details are unaffected.
  assert.match(textOf(await answer(PROMPT.upi, 'ravi@okicici')), /Saved: <b>UPI ID/);
});

test('a second application for the same exam is stopped before anything is typed', async () => {
  const { tap, answer } = makeBot();
  await tap('aff:exam:news');
  await answer(`${PROMPT.applyEmail}APPSC Newspaper`, 'ravi@gmail.com');
  await answer(`${PROMPT.applyPhone}APPSC Newspaper`, '9876543210');
  const again = await tap('aff:exam:news');
  assert.match(again[0].args[1], /already with the admin/);
  assert.ok(!again[0].args[2] || !again[0].args[2].reply_markup, 'it asked for the details again');
});

test('an application for an exam that has been closed is refused', async () => {
  const { answer } = makeBot();
  // UPSC is not open to influencers, so a stale prompt cannot smuggle one in.
  const out = await answer(`${PROMPT.applyEmail}UPSC`, 'ravi@gmail.com');
  assert.match(textOf(out), /not open for promotion/);
});

test('payout details: each is asked for, checked, saved, and can be changed', async () => {
  const { tap, answer } = makeBot();
  const card = await tap('aff:payout');
  assert.match(card[0].args[1], /Your payout details/);
  assert.match(card[0].args[1], /Still needed: <b>Name as on your bank account, Mobile number, Email, UPI ID<\/b>/);
  const data = buttons(card).map((b) => b.callback_data);
  for (const d of ['aff:set:legal_name', 'aff:set:phone', 'aff:set:email', 'aff:set:upi_id', 'aff:set:bank', 'aff:set:pan', 'aff:method:upi', 'aff:method:bank']) {
    assert.ok(data.includes(d), `no ${d} button`);
  }

  const phonePrompt = await tap('aff:set:phone');
  assert.ok(phonePrompt[0].args[1].startsWith(PROMPT.phone));
  assert.match(textOf(await answer(PROMPT.phone, '12345')), /10-digit Indian mobile/);
  assert.match(textOf(await answer(PROMPT.phone, '+91 98765 43210')), /Saved: <b>Mobile number<\/b>[\s\S]*Mobile: <b>9876543210<\/b>/);
  await answer(PROMPT.legal_name, 'Ravi Kumar');
  await answer(PROMPT.email, 'Ravi@Gmail.com');
  assert.match(textOf(await answer(PROMPT.upi, 'not-a-upi')), /does not look like a UPI ID/);
  const done = await answer(PROMPT.upi, 'ravi@okicici');
  assert.match(textOf(done), /All set/);
  assert.ok(buttons(done).some((b) => b.text === '💳 Change UPI ID'), 'no obvious way to change the UPI ID');

  // Changing it is the same button.
  await tap('aff:set:upi_id');
  assert.match(textOf(await answer(PROMPT.upi, 'ravi@okaxis')), /UPI ID: <b>ravi@okaxis<\/b>/);

  // A bank account, in one reply, switches the payout method.
  assert.match(textOf(await answer(PROMPT.bank, 'Ravi Kumar')), /three lines/);
  const bank = await answer(PROMPT.bank, 'Ravi Kumar\n1234 5678 9012\nhdfc0001234');
  assert.match(textOf(bank), /paid by bank transfer/);
  assert.match(textOf(bank), /XXXXXXXX9012/);
  assert.doesNotMatch(textOf(bank), /123456789012/, 'the full account number was shown in chat');
  const row = await store.getInfluencer(501);
  assert.deepEqual([row.payout_method, row.ifsc, row.phone, row.email, row.details_complete],
    ['bank', 'HDFC0001234', '9876543210', 'ravi@gmail.com', 'yes']);
  assert.match(textOf(await tap('aff:method:upi')), /paid by <b>UPI<\/b>/);
  assert.equal((await store.getInfluencer(501)).payout_method, 'upi');
});

test('/upi and /bank open the same payout screen', async () => {
  const { say } = makeBot();
  assert.match(textOf(await say('/upi')), /Your payout details/);
  assert.match(textOf(await say('/bank')), /Your payout details/);
});

test('codes: terms, share link, sales and earnings, and a Withdraw button when it is due', async () => {
  const { say, answer } = makeBot();
  const giveDetails = async () => {
    await answer(PROMPT.legal_name, 'Ravi Kumar');
    await answer(PROMPT.phone, '9876543210');
    await answer(PROMPT.email, 'ravi@gmail.com');
    await answer(PROMPT.upi, 'ravi@okicici');
  };
  const applied = await store.createRequest(RAVI, 'news', 'Ravi, YouTube, 40k subscribers');
  const terms = affiliates.validateTerms({ discount_type: 'percent', discount_value: 10, commission_type: 'percent',
    commission_value: 20, payout_cycle: 'weekly', min_payout: 0 }).value;
  const { code } = await store.approveRequest(applied.request.request_id, Object.assign({}, terms, { code: 'RAVI10' }),
    'Admin', { botUsername: 'appscpaymentsbot' });
  await store.recordSale({ code: code.code, payment_id: 'pay_1', student_id: 900,
    list_price_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582 });

  const noUpi = await say('/codes');
  assert.match(noUpi[0].args[1], /RAVI10<\/b> — APPSC Newspaper/);
  assert.match(noUpi[0].args[1], /Students get: <b>10% off<\/b>/);
  assert.match(noUpi[0].args[1], /You earn: <b>20% of what the student pays<\/b>/);
  assert.match(noUpi[0].args[1], /Students joined: <b>1<\/b>/);
  assert.match(noUpi[0].args[1], /Available: <b>₹35\.82<\/b>/);
  assert.match(noUpi[0].args[1], /t\.me\/appscpaymentsbot\?start=promo_RAVI10/);
  assert.match(noUpi[0].args[1], /Payout details missing/);
  assert.ok(buttons(noUpi).some((b) => b.callback_data === 'aff:payout'));
  assert.ok(!buttons(noUpi).some((b) => /^aff:wd:/.test(b.callback_data || '')), 'withdraw offered without payout details');

  await giveDetails();
  const ready = await say('/codes');
  assert.ok(buttons(ready).some((b) => b.callback_data === 'aff:wd:RAVI10'));
  assert.ok(buttons(ready).some((b) => /^https:\/\/t\.me\/share\/url/.test(b.url || '')));
});

test('withdrawing: the request, the admin alert, and no second request for the same money', async () => {
  const { tap, answer, alerts, book } = makeBot();
  const applied = await store.createRequest(RAVI, 'news', 'Ravi, YouTube, 40k subscribers');
  const terms = affiliates.validateTerms({ discount_type: 'percent', discount_value: 10, commission_type: 'percent',
    commission_value: 20, payout_cycle: 'weekly', min_payout: 0 }).value;
  await store.approveRequest(applied.request.request_id, Object.assign({}, terms, { code: 'RAVI10' }), 'Admin');
  await store.recordSale({ code: 'RAVI10', payment_id: 'pay_1', student_id: 900, paid_paise: 17910, commission_paise: 3582 });
  const early = await tap('aff:wd:RAVI10');
  assert.match(early[0].args[1], /Add your payout details first/);
  assert.equal(early[0].args[2].reply_markup.inline_keyboard[0][0].callback_data, 'aff:payout');
  await answer(PROMPT.legal_name, 'Ravi Kumar');
  await answer(PROMPT.phone, '9876543210');
  await answer(PROMPT.email, 'ravi@gmail.com');
  await answer(PROMPT.upi, 'ravi@okicici');
  alerts.length = 0;

  const choice = await tap('aff:withdraw');
  assert.match(choice[0].args[1], /RAVI10<\/b>: ₹35\.82 ready/);

  const done = await tap('aff:wd:RAVI10');
  assert.match(done[0].args[1], /Withdrawal requested: ₹35\.82/);
  assert.match(done[0].args[1], /ravi@okicici/);
  assert.equal(book.Payouts.length, 2, 'header + one request');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Withdrawal requested/);
  assert.match(alerts[0].text, /ravi@okicici/);

  const again = await tap('aff:wd:RAVI10');
  assert.match(again[0].args[1], /still with the admin/);
  assert.equal(book.Payouts.length, 2);
});

test('nobody can withdraw someone else\'s code by crafting the button', async () => {
  const { tap } = makeBot();
  const other = { id: 999, first_name: 'Other' };
  const applied = await store.createRequest(other, 'news', 'Other person, Telegram, 5k');
  const terms = affiliates.validateTerms({ discount_type: 'flat', discount_value: 10, commission_type: 'flat',
    commission_value: 20, payout_cycle: 'weekly' }).value;
  await store.approveRequest(applied.request.request_id, Object.assign({}, terms, { code: 'OTHER10' }), 'Admin');
  const out = await tap('aff:wd:OTHER10');
  assert.match(out[0].args[1], /not one of your codes/);
});

test('before the influencer sheet exists, the bot says so instead of failing', async () => {
  const { say } = makeBot();
  const saved = process.env.AFFILIATE_SHEET_ID;
  delete process.env.AFFILIATE_SHEET_ID;
  try {
    assert.match(textOf(await say('/apply')), /being set up/);
    assert.match(textOf(await say('/codes')), /being set up/);
  } finally {
    process.env.AFFILIATE_SHEET_ID = saved;
  }
});

test('a question for the admin reaches Support Team', async () => {
  const { say, answer, alerts } = makeBot();
  const prompt = await say('/support');
  assert.ok(prompt[0].args[1].startsWith(PROMPT.question));
  const out = await answer(PROMPT.question, 'When is the next payout?');
  assert.match(out[0].args[1], /Sent to the admin/);
  assert.match(alerts.at(-1).text, /When is the next payout\?/);
  assert.match(alerts.at(-1).text, /<code>501<\/code>/);
});
