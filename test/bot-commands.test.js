// ============================================================================
// The bot's command menu (test/bot-commands.test.js)
// ============================================================================
// Students saw no new commands at all. Two scripts wrote two different lists
// to two different scopes, and Telegram always shows the most specific scope
// in a private chat — so the list with /start, /about and /referral was
// written to a place no student ever looks.
//
// These pin the three things that went wrong: where the menu is written, that
// there is only one list, and that every command on it is one the bot
// actually answers.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret';
process.env.SHEET_URL_UPSC = 'https://script.google.com/macros/s/test-upsc/exec';
process.env.SHEET_TOKEN_UPSC = 'token-for-tests';
process.env.TELEGRAM_GROUP_UPSC = '-1009999999999';
process.env.TELEGRAM_PAYBOT_UPSC = '123:TEST';

const botCommands = require('../src/bot-commands');

require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};

/** A fake Telegram API that remembers commands per scope, as the real one does. */
function fakeTelegram() {
  const scopes = new Map();
  const key = (scope) => JSON.stringify(scope || { type: 'default' });
  const calls = [];
  const api = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'setMyCommands') {
      if (params.commands.length) scopes.set(key(params.scope), params.commands);
      else scopes.delete(key(params.scope));
      return { ok: true, result: true };
    }
    if (method === 'deleteMyCommands') { scopes.delete(key(params.scope)); return { ok: true, result: true }; }
    if (method === 'getMyCommands') return { ok: true, result: scopes.get(key(params.scope)) || [] };
    return { ok: false, description: 'unknown method ' + method };
  };
  return { api, scopes, calls, key };
}

// ---------------------------------------------------------------------------
// Where the menu goes
// ---------------------------------------------------------------------------

test('the student menu is written to private chats, where students actually are', async () => {
  const tg = fakeTelegram();
  await botCommands.registerMenus(tg.api, null);

  const shown = tg.scopes.get(tg.key({ type: 'all_private_chats' }));
  assert.ok(shown, 'nothing was written to private chats — the scope Telegram shows students');
  assert.deepEqual(shown.map((c) => c.command),
    ['start', 'about', 'plans', 'status', 'referral', 'help', 'support']);
});

test('a stale private-chat menu is replaced, not left shadowing the new one', async () => {
  // Exactly the state the live bots were in: the old four-command list in the
  // private-chat scope, hiding everything written to default.
  const tg = fakeTelegram();
  tg.scopes.set(tg.key({ type: 'all_private_chats' }), [
    { command: 'plans' }, { command: 'status' }, { command: 'support' }, { command: 'help' }
  ]);
  await botCommands.registerMenus(tg.api, null);

  assert.deepEqual(await botCommands.menuStudentsSee(tg.api),
    ['start', 'about', 'plans', 'status', 'referral', 'help', 'support']);
});

test('the default menu is cleared, so the paid groups do not show dead commands', async () => {
  // The bot answers no student command inside the paid groups on purpose.
  // Default is what those groups fall back to, so a list there would be seven
  // commands that do nothing when tapped.
  const tg = fakeTelegram();
  tg.scopes.set(tg.key({ type: 'default' }), botCommands.STUDENT_COMMANDS);
  await botCommands.registerMenus(tg.api, null);
  assert.equal(tg.scopes.has(tg.key({ type: 'default' })), false);
});

test('the admin menu goes to the support chat, and only there', async () => {
  const tg = fakeTelegram();
  await botCommands.registerMenus(tg.api, { chatId: '-1005555555555' });

  const admin = tg.scopes.get(tg.key({ type: 'chat', chat_id: '-1005555555555' }));
  assert.deepEqual(admin.map((c) => c.command),
    ['summary', 'tickets', 'find', 'msg', 'settings', 'supporthelp']);
  // Students never see admin commands.
  assert.ok(!tg.scopes.get(tg.key({ type: 'all_private_chats' })).some((c) => c.command === 'summary'));
});

test('a bot with no support chat still gets its student menu', async () => {
  const tg = fakeTelegram();
  const results = await botCommands.registerMenus(tg.api, null);
  assert.ok(results.every((r) => r.ok));
  assert.ok(!results.some((r) => /admin/.test(r.what)), 'an admin menu was attempted with no chat');
});

test('a refused write is reported, not swallowed', async () => {
  const results = await botCommands.registerMenus(
    async () => ({ ok: false, description: 'Unauthorized' }), null);
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.ok === false && r.detail === 'Unauthorized'));
});

test('what students see is read from the private-chat scope, falling back as Telegram does', async () => {
  const tg = fakeTelegram();
  assert.deepEqual(await botCommands.menuStudentsSee(tg.api), [], 'nothing set means nothing shown');

  tg.scopes.set(tg.key({ type: 'default' }), [{ command: 'plans' }]);
  assert.deepEqual(await botCommands.menuStudentsSee(tg.api), ['plans'],
    'with no private-chat list, Telegram shows default');

  tg.scopes.set(tg.key({ type: 'all_private_chats' }), [{ command: 'start' }]);
  assert.deepEqual(await botCommands.menuStudentsSee(tg.api), ['start'],
    'a private-chat list always wins over default');
});

// ---------------------------------------------------------------------------
// One list
// ---------------------------------------------------------------------------

test('there is one command list, and both scripts use it', () => {
  // Two lists is how this broke. Neither script may grow its own again.
  for (const file of ['set-webhooks.js', 'bot-profile.js']) {
    const src = fs.readFileSync(file, 'utf8');
    assert.match(src, /require\('\.\/src\/bot-commands'\)/, `${file} does not use the shared list`);
    assert.ok(!/const STUDENT_COMMANDS\s*=\s*\[/.test(src), `${file} defines its own student list again`);
    assert.ok(!/command:\s*'plans'/.test(src), `${file} has a command list of its own`);
  }
});

test('/about and the Telegram description are the same paragraph', () => {
  const src = fs.readFileSync('src/botapp.js', 'utf8');
  assert.match(src, /botCommands\.ABOUT/, '/about has its own copy of the paragraph again');
  assert.ok(!/Join our APPSC prep group via this bot/.test(src), 'the paragraph is duplicated in botapp.js');
  assert.match(botCommands.ABOUT, /Eenadu, Sakshi & Nipuna/);
  assert.ok(botCommands.SHORT_DESCRIPTION.length <= 120, 'Telegram refuses a short description over 120');
});

test('every command is a valid Telegram command', () => {
  // Telegram rejects the WHOLE list if any one entry breaks its rules.
  for (const { command, description } of [...botCommands.STUDENT_COMMANDS, ...botCommands.ADMIN_COMMANDS]) {
    assert.match(command, /^[a-z0-9_]{1,32}$/, `"${command}" is not a legal command name`);
    assert.ok(description.length >= 1 && description.length <= 256, `/${command} has a bad description`);
  }
});

// ---------------------------------------------------------------------------
// Every command on the menu does something
// ---------------------------------------------------------------------------

test('every command on the menu is answered by the bot in a private chat', async () => {
  // A menu entry that does nothing when tapped is worse than no entry: it
  // looks like the bot is broken.
  const sheets = require('../src/sheets');
  const { createPaymentBot } = require('../src/botapp');
  const sheet = new Proxy({}, {
    get: (target, name) => {
      if (name === 'then') return undefined;
      if (name === 'getBotSettings') return async () => ({});
      if (name === 'getSubscriber') return async () => null;
      if (name === 'getReferralFor') return async () => ({ code: 'REFAJMXPQ', telegram_id: '42', status: 'active' });
      if (name === 'listReferralEarnings') return async () => [];
      if (name === 'listTickets') return async () => ({ total: 0, tickets: [], counts: {} });
      return async () => null;
    }
  });
  sheets.forGroup = () => sheet;

  const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_UPSC', polling: false });
  const sent = [];
  app.bot.sendMessage = async (...args) => { sent.push(args); return { message_id: 1 }; };
  app.bot.getMe = async () => ({ id: 1, is_bot: true, username: 'test_bot' });
  app.bot.getChatMember = async () => ({ status: 'left' });

  const student = { id: 42, is_bot: false, first_name: 'Asha', username: 'asha' };
  let seq = 1;
  for (const { command } of botCommands.STUDENT_COMMANDS) {
    sent.length = 0;
    app.bot.processUpdate({ update_id: seq++, message: {
      message_id: seq, date: 1, from: student, chat: { id: 42, type: 'private' }, text: '/' + command
    } });
    await app.settle();
    assert.ok(sent.length > 0, `/${command} is on the menu but the bot does not answer it`);
  }
});
