// ============================================================================
// The Influencers dashboard's API (test/affiliate-server.test.js)
// ============================================================================
// The real server, the real store on an in-memory sheet, and every Telegram
// message recorded. What matters here: an approval makes a code that can
// never shadow a coupon and tells the influencer their code and link; a
// withdrawal is only marked paid with a UPI reference; and the influencer
// bot's webhook refuses anything Telegram did not sign.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'sheets-bot@test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token'
});
process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.AFFILIATE_SHEET_ID = 'AFFILIATESHEET1234567890abc';
process.env.TELEGRAM_AFFILIATE_BOT = '777:TEST';
process.env.CRON_SECRET = 'cron-secret-for-tests';
process.env.PUBLIC_BASE_URL = 'https://appscsadhana.vercel.app';
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.RATE_LIMIT_MAX = '100000';
process.env.CURATOR_EMAILS = '';
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

const realFetch = globalThis.fetch;
require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};

const { fakeSheetsApi } = require('./helpers/fake-sheets');
const auth = require('../src/auth');
const sheets = require('../src/sheets');
const paybot = require('../src/paybot');
const store = require('../src/affiliate-store');
const notify = require('../src/affiliate-notify');

auth.authorize = async (token) => {
  if (token !== 'valid-token') throw auth.authError('Token signature is invalid.', 'reauth');
  return { uid: 'u', email: 'admin@example.com', name: 'Admin', emailVerified: true, signInProvider: 'google.com' };
};

/** Coupons that already exist in the exam sheets. */
const COUPONS = new Set(['DIWALI20']);
sheets.forGroup = () => ({
  getBotSettings: async () => ({}),
  getCoupon: async (code) => (COUPONS.has(code) ? { code } : null)
});
paybot.getMe = async (env) => ({ username: env === 'TELEGRAM_PAYBOT_NEWS' ? 'appscpaymentsbot' : 'sadhanapaybot' });

const server = require('../server');
delete process.env.SUPPORT_CHAT_ID;

let baseUrl;
let book;
let told;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => {
  book = {};
  fakeSheetsApi(book, 'AFFILIATESHEET1234567890abc', { fallback: realFetch });
  told = [];
  notify.useClient({
    getMe: async () => ({ username: 'influencer_test_bot' }),
    sendMessage: async (chatId, text) => { told.push({ chatId: String(chatId), text }); return {}; }
  });
});

async function api(path, { method = 'GET', body, token = 'valid-token', headers = {} } = {}) {
  const res = await realFetch(baseUrl + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, headers),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const RAVI = { id: 501, first_name: 'Ravi', last_name: 'Kumar', username: 'ravi_teaches' };
const TERMS = { discount_type: 'percent', discount_value: 10, commission_type: 'percent', commission_value: 20,
  payout_cycle: 'weekly', min_payout: 0, one_per_student: true };

async function pendingRequest(exam = 'news') {
  const out = await store.createRequest(RAVI, exam, 'Ravi, youtube.com/@ravi_teaches, 40k subscribers');
  assert.equal(out.ok, true, out.reason);
  return out.request.request_id;
}

test('the Influencers API needs a signed-in curator, and ignores the group picker', async () => {
  assert.equal((await api('/api/affiliates', { token: null })).status, 401);
  const res = await api('/api/affiliates');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.status.sheet, true);
  assert.equal(res.json.data.botUsername, 'influencer_test_bot');
});

test('the overview has every exam with its price, and suggests a code for a waiting application', async () => {
  await pendingRequest();
  const { json } = await api('/api/affiliates');
  const data = json.data;
  assert.ok(data.exams.some((e) => e.id === 'news' && e.pricePaise === 19900));
  assert.equal(data.totals.pendingRequests, 1);
  assert.match(data.requests[0].suggested_code, /^RAVIKUNEWS\d{2}$/);
});

test('approving creates the code and sends the influencer their code, terms and link', async () => {
  const requestId = await pendingRequest();
  const res = await api('/api/affiliates/approve', { method: 'POST', body: { requestId, terms: Object.assign({ code: 'ravi10' }, TERMS) } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.code.code, 'RAVI10');
  assert.equal(res.json.code.share_link, 'https://t.me/appscpaymentsbot?start=promo_RAVI10');
  assert.equal(res.json.notified, true);

  const message = told.find((t) => t.chatId === '501');
  assert.ok(message, 'the influencer was not told');
  assert.match(message.text, /approved for APPSC Newspaper/);
  assert.match(message.text, /<code>RAVI10<\/code>/);
  assert.match(message.text, /Students get: <b>10% off<\/b>/);
  assert.match(message.text, /t\.me\/appscpaymentsbot\?start=promo_RAVI10/);
  assert.match(message.text, /only in the APPSC Newspaper payment bot/);

  const [header, row] = book.Codes;
  assert.equal(row[header.indexOf('Created By')], 'Admin (admin@example.com)');
});

test('an approval with bad terms, or a code a coupon already uses, is refused', async () => {
  const requestId = await pendingRequest();
  const badTerms = await api('/api/affiliates/approve', { method: 'POST', body: { requestId, terms: Object.assign({}, TERMS, { discount_value: 95 }) } });
  assert.equal(badTerms.status, 400);
  assert.match(badTerms.json.error, /1 to 90/);

  const clash = await api('/api/affiliates/approve', { method: 'POST', body: { requestId, terms: Object.assign({ code: 'DIWALI20' }, TERMS) } });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /DIWALI20 is already in use/);
  assert.equal(told.length, 0, 'the influencer was told about an approval that did not happen');
});

test('rejecting tells the influencer why', async () => {
  const requestId = await pendingRequest();
  const res = await api('/api/affiliates/reject', { method: 'POST', body: { requestId, reason: 'Audience too small for now' } });
  assert.equal(res.status, 200);
  assert.match(told[0].text, /not approved this time/);
  assert.match(told[0].text, /Audience too small for now/);
  const again = await api('/api/affiliates/reject', { method: 'POST', body: { requestId } });
  assert.equal(again.status, 409, 'a request is decided once');
});

test('a code can be paused, resumed, and given new terms — and the influencer is told the new terms', async () => {
  const requestId = await pendingRequest();
  await api('/api/affiliates/approve', { method: 'POST', body: { requestId, terms: Object.assign({ code: 'RAVI10' }, TERMS) } });
  told.length = 0;

  assert.equal((await api('/api/affiliates/code', { method: 'POST', body: { code: 'RAVI10', status: 'paused' } })).json.code.status, 'paused');
  assert.equal((await store.getCode('RAVI10')).status, 'paused');
  assert.equal((await api('/api/affiliates/code', { method: 'POST', body: { code: 'RAVI10', status: 'active' } })).json.code.status, 'active');

  const changed = await api('/api/affiliates/code', { method: 'POST', body: { code: 'RAVI10', terms: Object.assign({}, TERMS, { commission_value: 30 }) } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.match(told.at(-1).text, /terms of your code RAVI10 have changed/);
  assert.match(told.at(-1).text, /30% of what the student pays/);
});

test('a withdrawal is marked paid only with a UPI reference, and the influencer gets the reference', async () => {
  const requestId = await pendingRequest();
  await api('/api/affiliates/approve', { method: 'POST', body: { requestId, terms: Object.assign({ code: 'RAVI10' }, TERMS) } });
  for (const [f, v] of [['legal_name', 'Ravi Kumar'], ['phone', '9876543210'], ['email', 'ravi@example.com'], ['upi_id', 'ravi@okicici']]) {
    await store.setPayoutField(RAVI, f, v);
  }
  await store.recordSale({ code: 'RAVI10', payment_id: 'pay_1', student_id: 900, paid_paise: 17910, commission_paise: 3582 });
  const { payout } = await store.requestPayout('RAVI10', 501);
  told.length = 0;

  const noRef = await api('/api/affiliates/payout', { method: 'POST', body: { payoutId: payout.payout_id, decision: 'paid' } });
  assert.equal(noRef.status, 409);
  assert.match(noRef.json.error, /UTR/);

  const paid = await api('/api/affiliates/payout', { method: 'POST', body: { payoutId: payout.payout_id, decision: 'paid', reference: '412345678901' } });
  assert.equal(paid.status, 200);
  assert.match(told[0].text, /Paid: ₹35\.82/);
  assert.match(told[0].text, /412345678901/);

  const { json } = await api('/api/affiliates');
  assert.equal(json.data.totals.paidPaise, 3582);
  assert.equal(json.data.codes[0].stats.paidPaise, 3582);
});

test('a rejected withdrawal goes back to the influencer\'s balance', async () => {
  const requestId = await pendingRequest();
  await api('/api/affiliates/approve', { method: 'POST', body: { requestId, terms: Object.assign({ code: 'RAVI10' }, TERMS) } });
  for (const [f, v] of [['legal_name', 'Ravi Kumar'], ['phone', '9876543210'], ['email', 'ravi@example.com'], ['upi_id', 'ravi@okicici']]) {
    await store.setPayoutField(RAVI, f, v);
  }
  await store.recordSale({ code: 'RAVI10', payment_id: 'pay_1', student_id: 900, paid_paise: 17910, commission_paise: 3582 });
  const { payout } = await store.requestPayout('RAVI10', 501);
  const res = await api('/api/affiliates/payout', { method: 'POST', body: { payoutId: payout.payout_id, decision: 'rejected', reason: 'UPI ID bounced' } });
  assert.equal(res.status, 200);
  assert.match(told.at(-1).text, /UPI ID bounced/);
  const { json } = await api('/api/affiliates');
  assert.equal(json.data.codes[0].stats.availablePaise, 3582);
});

test('without the influencer sheet the page explains what to set up, and changes are refused', async () => {
  const saved = process.env.AFFILIATE_SHEET_ID;
  delete process.env.AFFILIATE_SHEET_ID;
  try {
    const res = await api('/api/affiliates');
    assert.equal(res.status, 200);
    assert.equal(res.json.data.notReady, true);
    assert.equal(res.json.data.status.serviceAccount, 'sheets-bot@test.iam.gserviceaccount.com');
    const refused = await api('/api/affiliates/approve', { method: 'POST', body: {} });
    assert.equal(refused.status, 503);
    assert.match(refused.json.error, /share the sheet with sheets-bot@/);
  } finally {
    process.env.AFFILIATE_SHEET_ID = saved;
  }
});

test('the influencer bot\'s webhook refuses anything Telegram did not sign', async () => {
  const unsigned = await realFetch(`${baseUrl}/api/telegram/affiliate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ update_id: 1 })
  });
  assert.equal(unsigned.status, 401);

  const secret = crypto.createHash('sha256').update('telegram-webhook:' + process.env.CRON_SECRET).digest('hex').slice(0, 48);
  const signed = await realFetch(`${baseUrl}/api/telegram/affiliate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: 0 })
  });
  assert.equal(signed.status, 200, 'the signed probe set-webhooks sends must be accepted');
});

test('the daily sweep puts back a bot menu that drifted, and leaves a correct one alone', async () => {
  const botCommands = require('../src/bot-commands');
  // What Telegram holds, per token: UPSC still shows the old /referral entry.
  const menus = {
    '333:TEST': ['start', 'about', 'plans', 'status', 'referral', 'help', 'support', 'terms'],
    '444:TEST': botCommands.STUDENT_COMMANDS.map((c) => c.command),
    '777:TEST': []
  };
  const writes = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const m = String(url).match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/);
    if (!m) return previous(url, init);
    const [, token, method] = m;
    const body = JSON.parse(init.body || '{}');
    const reply = (result) => ({ json: async () => ({ ok: true, result }) });
    if (method === 'getMyCommands') {
      const scope = body.scope && body.scope.type;
      return reply(scope === 'all_private_chats' ? (menus[token] || []).map((command) => ({ command, description: 'x' })) : []);
    }
    writes.push({ token, method, body });
    if (method === 'setMyCommands' && body.scope.type === 'all_private_chats') menus[token] = body.commands.map((c) => c.command);
    return reply(true);
  };
  try {
    const results = await server.syncBotMenus();
    const byBot = Object.fromEntries(results.map((r) => [r.bot, r]));
    assert.equal(byBot.TELEGRAM_PAYBOT_UPSC.changed, true);
    assert.deepEqual(byBot.TELEGRAM_PAYBOT_UPSC.was.includes('referral'), true);
    assert.equal(byBot.TELEGRAM_PAYBOT_EPFO.changed, false, 'a correct menu was rewritten for nothing');
    assert.equal(byBot.TELEGRAM_AFFILIATE_BOT.changed, true);
    assert.ok(!menus['333:TEST'].includes('referral'), '/referral is still on the UPSC menu');
    assert.deepEqual(menus['777:TEST'], botCommands.AFFILIATE_COMMANDS.map((c) => c.command));
    assert.ok(!writes.some((w) => w.token === '444:TEST'), 'the EPFO bot was written to');

    // Run again: everything is right, so nothing is written.
    writes.length = 0;
    await server.syncBotMenus();
    assert.equal(writes.length, 0);
  } finally {
    globalThis.fetch = previous;
  }
});
