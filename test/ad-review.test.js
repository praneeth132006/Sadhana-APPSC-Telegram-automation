// ============================================================================
// What a Telegram ad reviewer does to the bot (test/ad-review.test.js)
// ============================================================================
// Telegram rejected the bot's ad: "Ad destinations must be functional,
// technically complete, and active. Bots must respond to commands properly."
//
// A reviewer opens the bot, presses Start, taps through the menu, types the
// commands every bot is expected to know (/help, /settings, /terms), types a
// few it does not, sends a sticker, and taps the buttons it is given. Any one
// of those met with silence reads as a broken bot.
//
// So this walks every payment bot through exactly that, and asserts one thing
// each time: the bot answered.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret';
for (const prefix of ['APPSC_NEWS_EN', 'APPSC_NEWS_TE', 'APPSC_Q_EN', 'APPSC_Q_TE', 'UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = 'token-for-tests';
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + String(Math.abs(prefix.length * 1234567)).padStart(10, '9');
}
process.env.TELEGRAM_PAYBOT_NEWS = '111:TEST';
process.env.TELEGRAM_PAYBOT_SADHANA = '222:TEST';
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
process.env.TELEGRAM_PAYBOT_EPFO = '444:TEST';

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

const sheets = require('../src/sheets');
const razorpay = require('../src/razorpay');
const botCommands = require('../src/bot-commands');
const { createPaymentBot } = require('../src/botapp');
// Code tracking off: a local .env would otherwise point it at the real sheets.
require('../src/code-tracking').isConfigured = () => false;

delete process.env.SUPPORT_CHAT_ID;
delete process.env.SUPPORT_THREAD_ID;

const REVIEWER = { id: 5550001, is_bot: false, first_name: 'Reviewer', language_code: 'en' };
const BOTS = ['TELEGRAM_PAYBOT_NEWS', 'TELEGRAM_PAYBOT_SADHANA', 'TELEGRAM_PAYBOT_UPSC', 'TELEGRAM_PAYBOT_EPFO'];

/** A sheet for someone who has never been here: no pass, no code, no tickets. */
function freshSheet(overrides = {}) {
  const known = {
    getBotSettings: async () => ({}),
    getSubscriber: async () => null,
    getReferralFor: async () => null,
    createReferral: async (r) => Object.assign({ status: 'active' }, r),
    listReferralEarnings: async () => [],
    recordReferralOpen: async () => null,
    listTickets: async () => ({ total: 0, tickets: [], counts: {} }),
    createTicket: async (t) => Object.assign({ status: 'open' }, t),
    getCoupon: async () => null
  };
  Object.assign(known, overrides);
  return new Proxy(known, {
    get: (target, name) => {
      if (name === 'then') return undefined;
      return target[name] || (async () => null);
    }
  });
}

function makeBot(payBotEnv, sheet = freshSheet()) {
  sheets.forGroup = () => sheet;
  const app = createPaymentBot({ payBotEnv, polling: false });
  const sent = [];
  let nextId = 1000;
  const record = (method) => async (...args) => {
    sent.push({ method, args });
    return { message_id: nextId++, chat: { id: args[0] } };
  };
  ['sendMessage', 'sendChatAction', 'answerCallbackQuery', 'editMessageReplyMarkup', 'editMessageText',
    'deleteMessage', 'copyMessage'].forEach((method) => { app.bot[method] = record(method); });
  app.bot.getMe = async () => ({ id: 1, is_bot: true, username: 'review_test_bot' });
  app.bot.getChatMember = async () => ({ status: 'left' });

  let seq = 1;
  const deliver = async (update) => {
    const before = sent.length;
    app.bot.processUpdate(Object.assign({ update_id: seq++ }, update));
    await app.settle();
    return sent.slice(before);
  };
  const say = (text, extra = {}) => deliver({
    message: Object.assign({ message_id: seq++, date: 1, from: REVIEWER, chat: { id: REVIEWER.id, type: 'private' } },
      text === null ? {} : { text }, extra)
  });
  const tap = (data, message) => deliver({
    callback_query: { id: 'cb' + seq++, from: REVIEWER, data, message: message || {
      message_id: seq++, date: 1, chat: { id: REVIEWER.id, type: 'private' }, text: '…'
    } }
  });
  return { app, sent, say, tap };
}

const replies = (calls) => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
const buttonsIn = (calls) => replies(calls).flatMap((c) => {
  const options = c.args[2] || {};
  const keyboard = (options.reply_markup && options.reply_markup.inline_keyboard) || [];
  return keyboard.flat().filter((b) => b.callback_data).map((b) => b.callback_data);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const ALWAYS_EXPECTED = [
  // Everything on the menu.
  ...botCommands.STUDENT_COMMANDS.map((c) => '/' + c.command),
  // The three Telegram asks every bot to support, whether listed or not.
  '/start', '/help', '/settings',
  // How people actually type.
  '/START', '/Plans', '/help@review_test_bot', '/start ad_campaign_42', '/start hello there',
  '/status  ', '/invite', '/cancel',
  // Things this bot does not do.
  '/menu', '/buy', '/lang', '/stop', '/foo_bar', '/plansx', '/', '/ hello', '/plans,'
];

for (const payBotEnv of BOTS) {
  test(`${payBotEnv}: every command a reviewer might send gets an answer`, async () => {
    const { say } = makeBot(payBotEnv);
    for (const text of ALWAYS_EXPECTED) {
      const out = await say(text);
      assert.ok(replies(out).length > 0, `${payBotEnv} said nothing to "${text}"`);
    }
  });

  test(`${payBotEnv}: stickers, locations and plain text get an answer`, async () => {
    const { say } = makeBot(payBotEnv);
    const cases = [
      ['a sticker', null, { sticker: { file_id: 's', width: 1, height: 1, is_animated: false } }],
      ['a location', null, { location: { latitude: 17.4, longitude: 78.5 } }],
      ['a contact', null, { contact: { phone_number: '+910000000000', first_name: 'X' } }],
      ['a dice', null, { dice: { emoji: '🎲', value: 3 } }],
      ['plain text', 'hello, how do I join?', {}],
      ['a photo', null, { photo: [{ file_id: 'p', width: 1, height: 1 }], caption: 'screenshot' }]
    ];
    for (const [what, text, extra] of cases) {
      const out = await say(text, extra);
      assert.ok(replies(out).length > 0, `${payBotEnv} said nothing to ${what}`);
    }
  });

  test(`${payBotEnv}: every button the reviewer is shown does something`, async () => {
    const realCreate = razorpay.createPaymentLink;
    razorpay.createPaymentLink = async () => ({ id: 'plink_test', short_url: 'https://rzp.io/i/test' });
    try {
      const { say, tap } = makeBot(payBotEnv);
      const seen = new Set();
      let frontier = buttonsIn(await say('/start'));
      frontier.push(...buttonsIn(await say('/plans')));
      frontier.push(...buttonsIn(await say('/help')));

      // Breadth-first through everything reachable, a bounded number of taps.
      let taps = 0;
      while (frontier.length && taps < 60) {
        const data = frontier.shift();
        if (seen.has(data)) continue;
        seen.add(data);
        taps++;
        const out = await tap(data);
        const answered = out.some((c) => c.method === 'sendMessage' || c.method === 'editMessageText' ||
          (c.method === 'answerCallbackQuery' && c.args[1] && c.args[1].text));
        assert.ok(answered, `${payBotEnv}: tapping "${data}" did nothing visible`);
        frontier.push(...buttonsIn(out));
      }
      assert.ok(seen.has('go:plans'), 'the welcome has no Continue button');
      assert.ok([...seen].some((d) => d.startsWith('buy:')), `${payBotEnv}: no way to reach a Pay button`);
    } finally {
      razorpay.createPaymentLink = realCreate;
    }
  });
}

// ---------------------------------------------------------------------------
// Commands only in private chats, and failures that still answer
// ---------------------------------------------------------------------------

test('unknown commands in a paid group are still ignored', async () => {
  const { app, sent } = makeBot('TELEGRAM_PAYBOT_UPSC');
  app.bot.processUpdate({ update_id: 1, message: {
    message_id: 1, date: 1, from: REVIEWER, chat: { id: -1001, type: 'supergroup' }, text: '/menu'
  } });
  await app.settle();
  assert.equal(replies(sent).length, 0, 'the bot posted into a group');
});

test('a command that throws half-way still gets a reply', async () => {
  const { say } = makeBot('TELEGRAM_PAYBOT_UPSC', freshSheet({
    getBotSettings: async () => ({ referral_enabled: 'yes' }),
    getReferralFor: async () => { throw new Error('boom'); }
  }));
  const out = await say('/referral');
  assert.ok(replies(out).length > 0);
});

test('/status says "try again", not "no pass", when the sheet does not answer', async () => {
  const { say } = makeBot('TELEGRAM_PAYBOT_NEWS', freshSheet({
    getSubscriber: async () => { throw new Error('Google Sheets did not answer'); }
  }));
  const out = await say('/status');
  const text = replies(out).map((c) => c.args[1]).join('\n');
  assert.match(text, /Could not read your status/);
  assert.doesNotMatch(text, /do not have a pass/);
});

test('each bot describes what it actually sells', () => {
  assert.match(botCommands.aboutFor('TELEGRAM_PAYBOT_UPSC'), /UPSC/);
  assert.doesNotMatch(botCommands.aboutFor('TELEGRAM_PAYBOT_UPSC'), /APPSC|Eenadu|Telugu/);
  assert.match(botCommands.aboutFor('TELEGRAM_PAYBOT_NEWS'), /Eenadu/);
  for (const env of BOTS) {
    assert.ok(botCommands.aboutFor(env).length <= 512, `${env}: Telegram refuses a description over 512`);
    assert.ok(botCommands.shortDescriptionFor(env).length <= 120, `${env}: short description over 120`);
  }
});

test('/terms and /settings reply in plain words with a way to get help', async () => {
  const { say } = makeBot('TELEGRAM_PAYBOT_NEWS');
  const terms = replies(await say('/terms'))[0];
  assert.match(terms.args[1], /Terms/);
  assert.match(terms.args[1], /Razorpay/);
  assert.match(terms.args[1], /no refunds/i, 'there are no refunds, and the terms must say so');
  assert.doesNotMatch(terms.args[1], /refund request/i);
  assert.match(terms.args[1], /valid for life/, 'the newspaper pass is lifetime');
  const settings = replies(await say('/settings'))[0];
  assert.match(settings.args[1], /Settings/);
});
