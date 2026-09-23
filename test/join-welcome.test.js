// ============================================================================
// After paying: never silent (test/join-welcome.test.js)
// ============================================================================
// A student who pays and taps their invite used to be let in with nothing said.
// Now approving the join request sends a welcome with a button straight into
// the group; a refused request still says why.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LEGACY_GROUP_ID = '';
process.env.EXAM_PASS_END_DATE = '30-11-2099';
for (const prefix of ['UPSC']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100777';
}
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
delete process.env.SUPPORT_CHAT_ID;

require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};

const membership = require('../src/membership');
const { createPaymentBot } = require('../src/botapp');
// Code tracking off: a local .env would otherwise point it at the real sheets.
require('../src/code-tracking').isConfigured = () => false;

const STUDENT = { id: 900, is_bot: false, first_name: 'Kiran', username: 'kiran' };

function makeBot(result) {
  membership.handleJoinRequest = async () => result;
  const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_UPSC', polling: false });
  const sent = [];
  app.bot.sendMessage = async (...args) => { sent.push(args); return { message_id: sent.length }; };
  const request = async (chatId = -100777) => {
    app.bot.processUpdate({ update_id: 1, chat_join_request: { chat: { id: chatId, type: 'supergroup' }, from: STUDENT, date: 1 } });
    await app.settle();
    return sent;
  };
  return { request };
}

test('an approved join gets a welcome with a button straight into the group', async () => {
  const sent = await makeBot({ approved: true, reason: 'active subscription', inviteLink: 'https://t.me/+mine',
    expiry: '30-11-2099, 11:59:59 PM IST' }).request();
  assert.equal(sent.length, 1, 'the student was let in in silence');
  const [chatId, text, extra] = sent[0];
  assert.equal(chatId, 900);
  assert.match(text, /Welcome to UPSC Prelims/);
  assert.match(text, /You are in/);
  assert.match(text, /until <b>30-11-2099/);
  const button = extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.url, 'https://t.me/+mine');
  assert.match(button.text, /Open UPSC Prelims/);
});

test('a lifetime pass is not given a date, and a missing link still gets the welcome', async () => {
  const sent = await makeBot({ approved: true, reason: 'ok', inviteLink: '', expiry: 'Lifetime' }).request();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0][1], /runs until/);
  assert.equal(sent[0][2].reply_markup, undefined);
});

test('a refused join still says why, and gets no welcome', async () => {
  const sent = await makeBot({ approved: false, reason: 'no subscription on record' }).request();
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /That invite is not for this account/);
  assert.doesNotMatch(sent[0][1], /Welcome/);
});

test('a join request for a chat this bot does not sell is ignored', async () => {
  const sent = await makeBot({ approved: true, inviteLink: 'x' }).request(-100999);
  assert.equal(sent.length, 0);
});

test('a student who never started the bot is let in without an error', async () => {
  membership.handleJoinRequest = async () => ({ approved: true, inviteLink: 'https://t.me/+mine' });
  const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_UPSC', polling: false });
  app.bot.sendMessage = async () => { throw new Error('403: bot can\'t initiate conversation with a user'); };
  app.bot.processUpdate({ update_id: 1, chat_join_request: { chat: { id: -100777, type: 'supergroup' }, from: STUDENT, date: 1 } });
  await app.settle();
});
