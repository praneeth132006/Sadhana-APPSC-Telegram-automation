// ============================================================================
// The EPFO exam (test/epfo.test.js)
// ============================================================================
// EPFO is a sixth group with its own Telegram group, its own sheet and its own
// payment bot, running on exactly the machinery the other five use. These pin
// what makes it EPFO rather than a copy of UPSC: its thirteen subjects, the
// Question ID prefix each one gets, its own pass at Rs 199, and an end date of
// its own — the EPFO exam is not on the APPSC exam's day.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret';
process.env.EXAM_PASS_END_DATE = '30-11-2026';
delete process.env.EPFO_PASS_END_DATE;
process.env.LEGACY_GROUP_ID = '';
for (const prefix of ['UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
}
process.env.TELEGRAM_GROUP_UPSC = '-1009999999991';
process.env.TELEGRAM_GROUP_EPFO = '-1009999999992';
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
process.env.TELEGRAM_PAYBOT_EPFO = '444:TEST';

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

const groups = require('../src/groups');
const plans = require('../src/plans');
const pricing = require('../src/pricing');
const sheets = require('../src/sheets');
const paybot = require('../src/paybot');
const membership = require('../src/membership');
const botCommands = require('../src/bot-commands');
const { createPaymentBot } = require('../src/botapp');

delete process.env.SUPPORT_CHAT_ID;
delete process.env.SUPPORT_THREAD_ID;

const SUBJECTS = [
  'Indian Culture', 'Freedom Movement', 'Economy', 'Polity', 'General Science',
  'Computer Applications', 'Industrial Relations', 'Labour Codes and Acts', 'Social Security',
  'Accountancy', 'Auditing', 'Insurance', 'Current Affairs'
];

/** End of a dd-mm-yyyy day in IST, as the pass stores it. */
const endOfDay = (ddmmyyyy) => pricing.endOfDayIst(ddmmyyyy).getTime();

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

test('EPFO is its own group, in English, with the thirteen subjects asked for', () => {
  const epfo = groups.getGroup('epfo');
  assert.ok(epfo, 'no epfo group');
  assert.equal(epfo.label, 'EPFO');
  assert.equal(epfo.language, 'English');
  assert.equal(epfo.envPrefix, 'EPFO');
  assert.deepEqual(epfo.subjects, SUBJECTS);
  assert.equal(epfo.ready, true, `not ready: ${epfo.missing.join(', ')}`);
});

test('EPFO has a sheet, a Telegram group and a bot of its own', () => {
  const epfo = groups.getGroup('epfo');
  const upsc = groups.getGroup('upsc');
  assert.notEqual(epfo.sheetUrl, upsc.sheetUrl);
  assert.notEqual(epfo.sheetToken, upsc.sheetToken);
  assert.notEqual(epfo.telegramGroupId, upsc.telegramGroupId);
  assert.equal(epfo.paymentBotEnv, 'TELEGRAM_PAYBOT_EPFO');
  // No other group is sold by the EPFO bot, and EPFO by no other bot.
  const soldByEpfoBot = groups.listGroups().filter((g) => g.paymentBotEnv === 'TELEGRAM_PAYBOT_EPFO');
  assert.deepEqual(soldByEpfoBot.map((g) => g.id), ['epfo']);
});

test('every EPFO subject gets its own Question ID prefix', () => {
  const epfo = groups.getGroup('epfo');
  const codes = SUBJECTS.map((s) => groups.subjectCode(epfo, s));
  assert.equal(new Set(codes).size, codes.length, `two subjects share a prefix: ${codes.join(' ')}`);
  // First-three-letters would have given both of these IND.
  assert.equal(groups.subjectCode(epfo, 'Indian Culture'), 'CUL');
  assert.equal(groups.subjectCode(epfo, 'Industrial Relations'), 'IRL');
});

test('groups without subjectCodes keep the prefixes their questions already have', () => {
  // Changing an existing group's prefixes would split one tab's ids in two.
  const upsc = groups.getGroup('upsc');
  assert.equal(groups.subjectCode(upsc, 'Modern India'), 'MOD');
  assert.equal(groups.subjectCode(groups.getGroup('appsc_q_en'), 'Indian Economy'), 'IND');
});

test('the EPFO Apps Script is generated with its subjects and prefixes', () => {
  const file = path.join(__dirname, '..', 'apps-script', 'epfo.gs.js');
  assert.ok(fs.existsSync(file), 'run node build-apps-scripts.js');
  const src = fs.readFileSync(file, 'utf8');
  const block = src.slice(src.indexOf('var SUBJECT_CONFIG_LIST_DEFAULT = ['), src.indexOf('];', src.indexOf('var SUBJECT_CONFIG_LIST_DEFAULT = [')));
  const epfo = groups.getGroup('epfo');
  for (const subject of SUBJECTS) {
    assert.ok(block.includes(`subject: ${JSON.stringify(subject)}`), `${subject} is not in the script`);
    assert.ok(block.includes(`code: '${groups.subjectCode(epfo, subject)}'`), `${subject} has the wrong prefix`);
  }
  assert.ok(!block.includes('Ancient India'), 'the script carries another group\'s subjects');
});

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

test('EPFO sells one pass, at Rs 199, valid until the EPFO exam', () => {
  const pass = pricing.currentPass('epfo', {});
  assert.equal(pass.id, 'epfo_pass');
  assert.equal(pass.amountPaise, 19900);
  assert.equal(pass.lifetime, false);
  assert.equal(pass.type, 'one_time');
  // The exam is on 20-12-2026; members keep access until 24-12-2026.
  assert.equal(pass.validUntil, '24-12-2026');
  assert.deepEqual(groups.plansFor('epfo').map((p) => p.id), ['epfo_pass']);
});

test('the EPFO date is its own, not the APPSC exam date', () => {
  assert.notEqual(pricing.currentPass('epfo', {}).validUntil, process.env.EXAM_PASS_END_DATE);
  assert.equal(pricing.currentPass('upsc', {}).validUntil, '30-11-2026', 'the other groups moved too');
});

test('EPFO_PASS_END_DATE moves the EPFO date and nothing else', () => {
  process.env.EPFO_PASS_END_DATE = '15-06-2027';
  try {
    assert.equal(pricing.currentPass('epfo', {}).validUntil, '15-06-2027');
    assert.equal(pricing.currentPass('upsc', {}).validUntil, '30-11-2026');
  } finally {
    delete process.env.EPFO_PASS_END_DATE;
  }
});

test('the date set on the dashboard wins over both', () => {
  process.env.EPFO_PASS_END_DATE = '15-06-2027';
  try {
    assert.equal(pricing.currentPass('epfo', { pass_valid_until: '20-08-2027' }).validUntil, '20-08-2027');
  } finally {
    delete process.env.EPFO_PASS_END_DATE;
  }
});

test('an EPFO pass bought with no date in its notes still ends on the EPFO date', () => {
  // computeExpiry used to read EXAM_PASS_END_DATE for every dated pass, so an
  // EPFO member would have been cut off on the APPSC exam's day.
  const plan = groups.getPlanFor('epfo', 'epfo_pass');
  const now = new Date(Date.UTC(2026, 8, 22));
  assert.equal(plans.computeExpiry(plan, now).getTime(), endOfDay('24-12-2026'));

  process.env.EPFO_PASS_END_DATE = '15-06-2027';
  try {
    assert.equal(plans.computeExpiry(plan, now).getTime(), endOfDay('15-06-2027'));
    // And the APPSC exam pass is untouched by it.
    assert.equal(plans.computeExpiry(groups.getPlanFor('upsc', 'exam_pass'), now).getTime(), endOfDay('30-11-2026'));
  } finally {
    delete process.env.EPFO_PASS_END_DATE;
  }
});

test('paying for EPFO writes an EPFO member to the EPFO sheet', async () => {
  const written = [];
  const invites = [];
  const originalForGroup = sheets.forGroup;
  const originalInvite = paybot.createJoinRequestInvite;
  sheets.forGroup = (groupId) => ({
    getSubscriber: async () => null,
    upsertSubscriber: async (row) => { written.push({ groupId, row }); return row; }
  });
  paybot.createJoinRequestInvite = async (botEnv, chatId, telegramId) => {
    invites.push({ botEnv, chatId, telegramId });
    return 'https://t.me/+epfo';
  };
  try {
    const result = await membership.grantAccess({
      groupId: 'epfo', telegramId: '4242', planId: 'epfo_pass', paymentId: 'pay_EPFO1',
      amountPaise: 19900, validUntil: '24-12-2026'
    });
    assert.equal(written.length, 1);
    assert.equal(written[0].groupId, 'epfo');
    assert.equal(written[0].row.plan, 'epfo_pass');
    assert.equal(written[0].row.plan_label, 'Target EPFO Pass');
    assert.equal(written[0].row.amount, 199);
    assert.equal(result.expiry.getTime(), endOfDay('24-12-2026'));
    // The invite is for the EPFO group, made by the EPFO bot.
    assert.deepEqual(invites, [{ botEnv: 'TELEGRAM_PAYBOT_EPFO', chatId: '-1009999999992', telegramId: '4242' }]);
  } finally {
    sheets.forGroup = originalForGroup;
    paybot.createJoinRequestInvite = originalInvite;
  }
});

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

test('the EPFO bot describes EPFO, not APPSC or UPSC', () => {
  const about = botCommands.aboutFor('TELEGRAM_PAYBOT_EPFO');
  assert.match(about, /EPFO/);
  assert.doesNotMatch(about, /APPSC|UPSC|Eenadu|Telugu/);
  assert.ok(about.length <= 512);
  assert.ok(botCommands.shortDescriptionFor('TELEGRAM_PAYBOT_EPFO').length <= 120);
});

test('the EPFO bot sells only the EPFO pass, at Rs 199, with its end date', async () => {
  sheets.forGroup = () => new Proxy({}, {
    get: (t, name) => (name === 'then' ? undefined : async () => (name === 'getBotSettings' ? {} : null))
  });
  const app = createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_EPFO', polling: false });
  assert.deepEqual(app.familyGroups().map((g) => g.id), ['epfo']);

  const sent = [];
  app.bot.sendMessage = async (...args) => { sent.push(args); return { message_id: 1 }; };
  app.bot.sendChatAction = async () => true;
  app.bot.getMe = async () => ({ id: 444, is_bot: true, username: 'epfo_test_bot' });
  app.bot.processUpdate({ update_id: 1, message: {
    message_id: 1, date: 1, from: { id: 42, is_bot: false, first_name: 'Asha' },
    chat: { id: 42, type: 'private' }, text: '/plans'
  } });
  await app.settle();

  const text = sent.map((s) => s[1]).join('\n');
  assert.match(text, /Target EPFO Pass/);
  assert.match(text, /₹199/);
  assert.match(text, /24-12-2026/);
  assert.doesNotMatch(text, /UPSC|APPSC|Newspaper/);
  const buttons = sent.flatMap((s) => ((s[2] && s[2].reply_markup && s[2].reply_markup.inline_keyboard) || []).flat());
  assert.ok(buttons.some((b) => /^buy:epfo:epfo_pass/.test(String(b.callback_data))),
    `no EPFO buy button: ${JSON.stringify(buttons.map((b) => b.callback_data))}`);
});
