// ============================================================================
// The taster and the free preview (test/taster-and-trial.test.js)
// ============================================================================
// Telegram rejected the ad while the bot asked for money on its first screen.
// A newcomer now answers real questions from the sheet, one at a time, and is
// offered a few read-only minutes in the group before the price is mentioned.
//
// These cover the whole of that: the welcome that sells nothing, the language
// step, the questions, the pass that follows them, the preview being granted
// once per person, and the sweep that warns and then removes them.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_for_tests';
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.CRON_SECRET = 'cron-secret-for-tests';
process.env.PUBLIC_BASE_URL = 'https://appscsadhana.vercel.app';
process.env.EXAM_PASS_END_DATE = '30-11-2099';
process.env.LEGACY_GROUP_ID = '';
process.env.RATE_LIMIT_MAX = '100000';
for (const prefix of ['APPSC_NEWS_EN', 'APPSC_NEWS_TE', 'UPSC']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + prefix.length;
}
process.env.TELEGRAM_PAYBOT_NEWS = '111:TEST';
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
process.env.TELEGRAM_AFFILIATE_BOT = '777:TEST';
process.env.AFFILIATE_BOT_USERNAME = 'Affiliatemainbot';
delete process.env.SUPPORT_CHAT_ID;

require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(url, ...rest) {
    const target = String(url && url.url ? url.url : url);
    if (/^https:\/\/(script\.google(usercontent)?\.com|api\.razorpay\.com|api\.telegram\.org|sheets\.googleapis\.com)\//.test(target)) {
      return Promise.reject(new Error(`Network call to ${target.split('?')[0]} attempted in a test — stub it`));
    }
    return realFetch.call(this, url, ...rest);
  };
}

const sheets = require('../src/sheets');
const paybot = require('../src/paybot');
const membership = require('../src/membership');
const support = require('../src/support');
const { createPaymentBot } = require('../src/botapp');
// Code tracking off: a local .env would otherwise point it at the real sheets.
require('../src/code-tracking').isConfigured = () => false;

const STUDENT = { id: 900, is_bot: false, first_name: 'Kiran', username: 'kiran' };

/** Three complete questions, as the sheet returns them. */
const QUESTIONS = [1, 2, 3].map((n) => ({
  question_id: `POL-${n}`, subject: 'Polity', question_text: `Sample question ${n}?`,
  option_a: 'One', option_b: 'Two', option_c: 'Three', option_d: 'Four',
  correct_answer: 'B', explanation: `Because of reason ${n}.`, status: 'Posted'
}));

/**
 * A bot over a stubbed sheet. `rows` is the Subscribers table, by Telegram id,
 * so a preview written by one call is seen by the next.
 */
function makeBot({ payBotEnv = 'TELEGRAM_PAYBOT_UPSC', settings = {}, questions = QUESTIONS, rows = {} } = {}) {
  const sheetCalls = [];
  sheets.forGroup = (groupId) => ({
    groupId,
    getBotSettings: async () => settings,
    readConfig: async () => [{ subject: 'Polity' }, { subject: 'Economy' }],
    sampleQuestions: async (subject, count) => {
      sheetCalls.push({ name: 'sampleQuestions', subject, count });
      return questions.slice(0, count);
    },
    getSubscriber: async (id) => rows[`${groupId}:${id}`] || null,
    upsertSubscriber: async (row, event) => {
      const saved = Object.assign({}, rows[`${groupId}:${row.telegram_id}`], row);
      rows[`${groupId}:${row.telegram_id}`] = saved;
      sheetCalls.push({ name: 'upsertSubscriber', event, row: saved });
      return saved;
    },
    getCoupon: async () => null
  });
  const invites = [];
  paybot.createJoinRequestInvite = async (env, chatId, telegramId) => {
    invites.push({ env, chatId, telegramId });
    return 'https://t.me/+preview-invite';
  };

  const app = createPaymentBot({ payBotEnv, polling: false });
  const sent = [];
  const record = (method) => async (...args) => { sent.push({ method, args }); return { message_id: sent.length }; };
  ['sendMessage', 'sendPoll', 'sendChatAction', 'answerCallbackQuery'].forEach((m) => { app.bot[m] = record(m); });
  app.bot.getMe = async () => ({ id: 1, is_bot: true, username: 'test_pay_bot' });

  let seq = 1;
  const deliver = async (update) => {
    const before = sent.length;
    app.bot.processUpdate(Object.assign({ update_id: seq++ }, update));
    await app.settle();
    return sent.slice(before);
  };
  const say = (text) => deliver({ message: { message_id: seq++, date: 1, from: STUDENT, chat: { id: STUDENT.id, type: 'private' }, text } });
  const tap = (data) => deliver({ callback_query: { id: 'cb' + seq++, from: STUDENT, data,
    message: { message_id: 1, date: 1, chat: { id: STUDENT.id, type: 'private' }, text: '…' } } });
  return { app, sent, rows, invites, sheetCalls, say, tap };
}

const messages = (out) => out.filter((s) => s.method === 'sendMessage');
const polls = (out) => out.filter((s) => s.method === 'sendPoll');
const buttons = (out) => messages(out).flatMap((m) =>
  ((m.args[2] && m.args[2].reply_markup && m.args[2].reply_markup.inline_keyboard) || []).flat());
const textOf = (out) => messages(out).map((m) => m.args[1]).join('\n---\n');

// ---------------------------------------------------------------------------
// The taster
// ---------------------------------------------------------------------------

test('the welcome sells nothing: no price, no pay button, just Continue', async () => {
  const { say } = makeBot();
  const out = await say('/start');
  assert.equal(messages(out).length, 1);
  assert.doesNotMatch(textOf(out), /₹|Pay/);
  assert.deepEqual(buttons(out).map((b) => b.callback_data), ['go:plans']);
});

test('the welcome points down to Continue, with no "Need help" line', async () => {
  const { say } = makeBot();
  const out = await say('/start');
  const text = textOf(out);
  assert.match(text, /Tap <b>Continue<\/b> below 👇 to see the pass\./);
  assert.doesNotMatch(text, /Need help/);
  assert.doesNotMatch(text, /\/support/);
  assert.deepEqual(buttons(out).map((b) => b.text), ['Continue ⬇️']);
});

test('Continue asks the language, and picking one starts the questions — not the price', async () => {
  const { tap } = makeBot({ payBotEnv: 'TELEGRAM_PAYBOT_NEWS' });
  const ask = await tap('go:plans');
  assert.match(textOf(ask), /Which language/);
  assert.deepEqual(buttons(ask).map((b) => [b.text, b.callback_data]), [
    ['🔤 English', 'pick:appsc_news_en'],
    ['🇮🇳 తెలుగు (Telugu)', 'pick:appsc_news_te']
  ]);

  const first = await tap('pick:appsc_news_en');
  assert.equal(polls(first).length, 1, 'the first question was not asked');
  assert.doesNotMatch(textOf(first), /₹/, 'the price came before the questions');
  assert.deepEqual(buttons(first).map((b) => b.callback_data), ['smp:appsc_news_en:1']);
});

test('the questions come one at a time, and the pass follows the last one', async () => {
  const { tap } = makeBot();
  const one = await tap('go:plans');            // single-group bot: straight to the questions
  assert.equal(polls(one).length, 1);
  const poll = polls(one)[0].args;
  assert.match(poll[1], /Sample question 1/);
  assert.deepEqual(poll[2], ['One', 'Two', 'Three', 'Four']);
  assert.equal(poll[3].type, 'quiz');
  assert.equal(poll[3].correct_option_id, 1, 'B is the second option');
  assert.match(poll[3].explanation, /reason 1/);
  assert.match(textOf(one), /Question 1 of 3/);

  const two = await tap('smp:upsc:1');
  assert.match(polls(two)[0].args[1], /Sample question 2/);
  assert.deepEqual(buttons(two).map((b) => b.callback_data), ['smp:upsc:2']);

  const three = await tap('smp:upsc:2');
  assert.match(polls(three)[0].args[1], /Sample question 3/);
  // After the last one: the invitation, then the pass with its buttons.
  assert.match(textOf(three), /That was 3 of the questions we post every day/);
  assert.match(textOf(three), /join <b>UPSC Prelims<\/b>/);
  assert.match(textOf(three), /₹199/);
  const data = buttons(three).map((b) => b.callback_data);
  assert.ok(data.some((d) => /^buy:upsc:/.test(d)), 'no Pay button after the questions');
  assert.ok(!data.includes('trial:upsc'), 'the free preview is no longer offered');
  assert.ok(!data.some((d) => /^smp:/.test(d)), 'it asked for a fourth question');
});

test('the admin can ask for a different number of questions, or none at all', async () => {
  const two = makeBot({ settings: { sample_questions: '2' } });
  const out = await two.tap('go:plans');
  assert.match(textOf(out), /Question 1 of 2/);
  assert.equal(two.sheetCalls.filter((c) => c.name === 'sampleQuestions')[0].count, 2);

  const none = makeBot({ settings: { sample_questions: '0' } });
  const straight = await none.tap('go:plans');
  assert.equal(polls(straight).length, 0);
  assert.match(textOf(straight), /₹199/, 'with the taster off, the pass should come straight away');
});

test('a sheet with no usable questions still ends at the pass', async () => {
  const { tap } = makeBot({ questions: [] });
  const out = await tap('go:plans');
  assert.equal(polls(out).length, 0);
  assert.match(textOf(out), /₹199/);
});

test('a question Telegram refuses does not strand the student', async () => {
  const bot = makeBot();
  bot.app.bot.sendPoll = async () => { throw new Error('POLL_QUESTION_INVALID'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const out = await bot.tap('go:plans');
    assert.match(textOf(out), /₹199/);
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// The free preview
// ---------------------------------------------------------------------------

test('the free preview is no longer offered, and an old button says so', async () => {
  const { tap, invites } = makeBot();
  const out = await tap('trial:upsc');
  assert.match(textOf(out), /no longer offered/);
  assert.equal(invites.length, 0, 'an invite was minted');
});

test('a preview is let into the group and muted for exactly its length', async () => {
  const rows = {};
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  rows['upsc:900'] = {
    telegram_id: '900', plan: 'trial', status: 'trial',
    expiry_date: membership.formatIst(expiry)
  };
  makeBot({ rows });
  const approved = [];
  const muted = [];
  paybot.approveJoinRequest = async (env, chatId, userId) => { approved.push({ chatId, userId }); };
  paybot.readOnlyMember = async (env, chatId, userId, until) => { muted.push({ userId, until }); };
  const verdict = await membership.handleJoinRequest('upsc', 900);
  assert.equal(verdict.approved, true);
  assert.equal(verdict.trial, true);
  assert.equal(approved.length, 1);
  assert.equal(muted.length, 1, 'a preview was let in able to post');
  assert.ok(Math.abs(muted[0].until - (expiry.getTime() / 1000 + 60)) < 5, 'the mute does not lift with the preview');
});

// ---------------------------------------------------------------------------
// The sweep that warns and removes
// ---------------------------------------------------------------------------

/** Loads the server with the sheet and Telegram stubbed for one group's trials. */
function loadSweep({ trials, settings = {} }) {
  for (const key of Object.keys(require.cache)) {
    if (/server\.js|membership\.js|sheets\.js|paybot\.js/.test(key)) delete require.cache[key];
  }
  const sheetsModule = require('../src/sheets');
  const paybotModule = require('../src/paybot');
  const razorpay = require('../src/razorpay');
  const serverModule = require('../server');

  const written = [];
  const sent = [];
  const removed = [];
  sheetsModule.forGroup = (groupId) => ({
    groupId,
    getBotSettings: async () => settings,
    listTrialMembers: async () => (groupId === 'upsc' ? trials : []),
    upsertSubscriber: async (row, event) => { written.push({ groupId, event, row }); return row; }
  });
  paybotModule.sendDirectMessage = async (env, userId, text, extra) => { sent.push({ userId: String(userId), text, extra }); };
  paybotModule.removeFromChat = async (env, chatId, userId) => { removed.push(String(userId)); return true; };
  razorpay.createPaymentLink = async () => ({ id: 'plink_trial', short_url: 'https://rzp.io/i/trial' });
  return { serverModule, written, sent, removed };
}

const minutesAgo = (n) => membership.formatIst(new Date(Date.now() - n * 60 * 1000));
const minutesAhead = (n) => membership.formatIst(new Date(Date.now() + n * 60 * 1000));

test('the sweep warns at the minute the admin set, once, with a real payment link', async () => {
  const trial = { telegram_id: '900', username: 'kiran', name: 'Kiran', plan: 'trial', status: 'trial',
    start_date: minutesAgo(8), expiry_date: minutesAhead(2), reminder_sent: '' };
  const { serverModule, written, sent } = loadSweep({ trials: [trial] });

  const result = await serverModule.sweepTrials();
  assert.deepEqual(result.warned.map((w) => w.telegram_id), ['900']);
  assert.equal(result.ended.length, 0);
  assert.equal(written[0].event, 'trial.warned');
  assert.equal(written[0].row.reminder_sent, 'warned');
  assert.match(sent[0].text, /2 minute\(s\) left/);
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].url, 'https://rzp.io/i/trial');

  // Marked as warned in the sheet, so the next run says nothing.
  trial.reminder_sent = 'warned';
  const again = await serverModule.sweepTrials();
  assert.equal(again.warned.length, 0);
  assert.equal(sent.length, 1);
});

test('the sweep does not warn before the minute the admin set', async () => {
  const { serverModule, sent } = loadSweep({
    trials: [{ telegram_id: '900', plan: 'trial', status: 'trial', start_date: minutesAgo(3), expiry_date: minutesAhead(7), reminder_sent: '' }]
  });
  const result = await serverModule.sweepTrials();
  assert.equal(result.warned.length, 0);
  assert.equal(sent.length, 0);
});

test('the sweep removes the preview when its time is up, and invites them to join', async () => {
  const { serverModule, written, sent, removed } = loadSweep({
    trials: [{ telegram_id: '900', username: 'kiran', name: 'Kiran', plan: 'trial', status: 'trial',
      start_date: minutesAgo(11), expiry_date: minutesAgo(1), reminder_sent: 'warned' }]
  });
  const result = await serverModule.sweepTrials();
  assert.deepEqual(result.ended.map((e) => e.telegram_id), ['900']);
  assert.deepEqual(removed, ['900'], 'they were left in the group');
  assert.equal(written[0].event, 'trial.ended');
  assert.equal(written[0].row.status, 'trial_expired');
  assert.equal(written[0].row.invite_link, '', 'the old invite still works');
  assert.match(sent[0].text, /free preview .* has ended/);
  assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].url, 'https://rzp.io/i/trial');
});

test('a preview with an unreadable expiry is ended rather than left open for ever', async () => {
  const { serverModule, removed } = loadSweep({
    trials: [{ telegram_id: '900', plan: 'trial', status: 'trial', start_date: minutesAgo(30), expiry_date: 'whenever', reminder_sent: '' }]
  });
  const result = await serverModule.sweepTrials();
  assert.equal(result.ended[0].reason, 'unreadable expiry');
  assert.deepEqual(removed, ['900']);
});

test('a failed payment link still lets the message through', async () => {
  const { serverModule, sent } = loadSweep({
    trials: [{ telegram_id: '900', plan: 'trial', status: 'trial', start_date: minutesAgo(9), expiry_date: minutesAhead(1), reminder_sent: '' }]
  });
  require('../src/razorpay').createPaymentLink = async () => { throw new Error('Razorpay is down'); };
  const originalError = console.error;
  console.error = () => {};
  try {
    await serverModule.sweepTrials();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data, 'go:plans');
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// Earning with us
// ---------------------------------------------------------------------------

test('/affiliate offers the programme, the figure the admin set, and the way in', async () => {
  const { say } = makeBot({ settings: { affiliate_earn_upto: '75', support_email: 'help@example.com' } });
  const out = await say('/affiliate');
  assert.match(textOf(out), /Earn with us/);
  assert.match(textOf(out), /<b>up to ₹75 for each successful referral<\/b>/);
  assert.match(textOf(out), /help@example\.com/);
  assert.equal(buttons(out)[0].url, 'https://t.me/Affiliatemainbot');
  // And the default figure, for a bot whose admin has set nothing.
  const plain = makeBot();
  assert.match(textOf(await plain.say('/earn')), /<b>up to ₹50 for each successful referral<\/b>/);
});

test('the taster and referral settings are on the Pass & Coupons page; the preview ones are gone', () => {
  const keys = support.SETTINGS.filter((s) => s.section === 'pass').map((s) => s.key);
  for (const key of ['sample_questions', 'affiliate_earn_upto']) {
    assert.ok(keys.includes(key), `${key} cannot be edited on the dashboard`);
  }
  for (const key of ['trial_enabled', 'trial_minutes', 'trial_warn_minutes']) {
    assert.ok(!keys.includes(key), `${key} is still on the dashboard`);
  }
});
