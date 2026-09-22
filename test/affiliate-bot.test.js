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
for (const prefix of ['UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + (prefix === 'UPSC' ? '11' : '22');
}
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
  assert.deepEqual(buttons(out).map((b) => b.callback_data), ['aff:apply', 'aff:codes', 'aff:withdraw', 'aff:upi']);
});

test('applying: choose an exam, describe the promotion, and the admin is alerted', async () => {
  const { tap, answer, alerts, book } = makeBot();

  const exams = await tap('aff:apply');
  // One button per exam on sale (a machine with the real .env offers all four).
  const offered = buttons(exams).map((b) => [b.text, b.callback_data]);
  assert.deepEqual(offered, affiliates.listExams().map((e) => [e.label, `aff:exam:${e.id}`]));
  assert.ok(offered.some(([, data]) => data === 'aff:exam:upsc'));
  assert.ok(offered.some(([, data]) => data === 'aff:exam:epfo'));

  const prompt = await tap('aff:exam:upsc');
  assert.ok(prompt[0].args[1].startsWith(`${PROMPT.application}UPSC`));
  assert.equal(prompt[0].args[2].reply_markup.force_reply, true);

  const done = await answer(`${PROMPT.application}UPSC\n\nReply to this message with…`,
    'Ravi Kumar — youtube.com/@ravi_teaches — 40k subscribers');
  assert.match(done[0].args[1], /Application sent for UPSC/);
  assert.match(done[0].args[1], /REQ-\d{8}-/);
  assert.match(done[0].args[1], /set the UPI ID/, 'no UPI yet, so they are nudged');

  // In the sheet, as the admin will see it.
  const [header, row] = book.Requests;
  const cell = (name) => row[header.indexOf(name)];
  assert.equal(cell('Telegram ID'), '501');
  assert.equal(cell('Exam'), 'upsc');
  assert.equal(cell('Exam Bot'), 'TELEGRAM_PAYBOT_UPSC');
  assert.equal(cell('Status'), 'pending');
  assert.match(cell('Details'), /40k subscribers/);

  // And the admins were told, in Support Team, with a way to decide it.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].chatId, '-1005555555555');
  assert.match(alerts[0].text, /New influencer application/);
  assert.match(alerts[0].text, /ravi_teaches/);
  assert.equal(alerts[0].extra.reply_markup.inline_keyboard[0][0].url, 'https://appscsadhana.vercel.app/influencers.html');
});

test('a second application for the same exam is stopped before they type it all', async () => {
  const { tap, answer } = makeBot();
  await tap('aff:exam:upsc');
  await answer(`${PROMPT.application}UPSC`, 'Ravi Kumar — youtube.com/@ravi_teaches — 40k');
  const again = await tap('aff:exam:upsc');
  assert.match(again[0].args[1], /already with the admin/);
  assert.ok(!again[0].args[2] || !again[0].args[2].reply_markup, 'it asked for the details again');
});

test('a one-line application is sent back for more detail', async () => {
  const { answer, book } = makeBot();
  const out = await answer(`${PROMPT.application}UPSC`, 'me');
  assert.match(out[0].args[1], /tell us a little more/);
  assert.ok(!book.Requests || book.Requests.length <= 1);
});

test('the UPI ID is checked, saved, and shown back', async () => {
  const { tap, answer } = makeBot();
  const prompt = await tap('aff:upi');
  assert.ok(prompt[0].args[1].startsWith(PROMPT.upi));
  assert.match(textOf(await answer(PROMPT.upi, 'not-a-upi')), /does not look like a UPI ID/);
  assert.match(textOf(await answer(PROMPT.upi, 'ravi@okicici')), /UPI ID saved: <code>ravi@okicici<\/code>/);
  assert.equal((await store.getInfluencer(501)).upi_id, 'ravi@okicici');
});

test('codes: terms, share link, sales and earnings, and a Withdraw button when it is due', async () => {
  const { say, answer } = makeBot();
  const applied = await store.createRequest(RAVI, 'upsc', 'Ravi, YouTube, 40k subscribers');
  const terms = affiliates.validateTerms({ discount_type: 'percent', discount_value: 10, commission_type: 'percent',
    commission_value: 20, payout_cycle: 'weekly', min_payout: 0 }).value;
  const { code } = await store.approveRequest(applied.request.request_id, Object.assign({}, terms, { code: 'RAVI10' }),
    'Admin', { botUsername: 'prelimspaymentbot' });
  await store.recordSale({ code: code.code, payment_id: 'pay_1', student_id: 900,
    list_price_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582 });

  const noUpi = await say('/codes');
  assert.match(noUpi[0].args[1], /RAVI10<\/b> — UPSC/);
  assert.match(noUpi[0].args[1], /Students get: <b>10% off<\/b>/);
  assert.match(noUpi[0].args[1], /You earn: <b>20% of what the student pays<\/b>/);
  assert.match(noUpi[0].args[1], /Students joined: <b>1<\/b>/);
  assert.match(noUpi[0].args[1], /Available: <b>₹35\.82<\/b>/);
  assert.match(noUpi[0].args[1], /t\.me\/prelimspaymentbot\?start=promo_RAVI10/);
  assert.match(noUpi[0].args[1], /No UPI ID yet/);
  assert.ok(!buttons(noUpi).some((b) => /^aff:wd:/.test(b.callback_data || '')), 'withdraw offered with no UPI ID');

  await answer(PROMPT.upi, 'ravi@okicici');
  const ready = await say('/codes');
  assert.ok(buttons(ready).some((b) => b.callback_data === 'aff:wd:RAVI10'));
  assert.ok(buttons(ready).some((b) => /^https:\/\/t\.me\/share\/url/.test(b.url || '')));
});

test('withdrawing: the request, the admin alert, and no second request for the same money', async () => {
  const { tap, answer, alerts, book } = makeBot();
  const applied = await store.createRequest(RAVI, 'upsc', 'Ravi, YouTube, 40k subscribers');
  const terms = affiliates.validateTerms({ discount_type: 'percent', discount_value: 10, commission_type: 'percent',
    commission_value: 20, payout_cycle: 'weekly', min_payout: 0 }).value;
  await store.approveRequest(applied.request.request_id, Object.assign({}, terms, { code: 'RAVI10' }), 'Admin');
  await store.recordSale({ code: 'RAVI10', payment_id: 'pay_1', student_id: 900, paid_paise: 17910, commission_paise: 3582 });
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
  const applied = await store.createRequest(other, 'upsc', 'Other person, Telegram, 5k');
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
