// ============================================================================
// Code tracking: the webhook and the dashboard API (test/code-tracking-api.test.js)
// ============================================================================
// The real server over an in-memory sheet. A paid webhook closes the funnel
// for the right student and code (once, however often Razorpay retries); the
// dashboard's API returns the funnel, the people and the ad link; and the
// Razorpay check finds links that were never paid — or were paid without the
// webhook ever arriving.
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
process.env.CRON_SECRET = 'cron-secret-for-tests';
process.env.PUBLIC_BASE_URL = 'https://appscsadhana.vercel.app';
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret_for_tests';
process.env.RATE_LIMIT_MAX = '100000';
process.env.CURATOR_EMAILS = '';
process.env.LEGACY_GROUP_ID = '';
process.env.EXAM_PASS_END_DATE = '30-11-2099';
process.env.AFFILIATE_SHEET_ID = '';
for (const prefix of ['APPSC_NEWS_EN', 'APPSC_NEWS_TE', 'APPSC_Q_EN', 'APPSC_Q_TE', 'UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + Math.abs(prefix.length * 7919);
  // Blank, not deleted: dotenv would refill a deleted one from a local .env.
  process.env[`SHEET_ID_${prefix}`] = '';
}
process.env.SHEET_ID_UPSC = 'UPSCSHEET1234567890abcdefgh';
process.env.TELEGRAM_PAYBOT_NEWS = '111:TEST';
process.env.TELEGRAM_PAYBOT_UPSC = '333:TEST';
process.env.TELEGRAM_PAYBOT_EPFO = '444:TEST';

const realFetch = globalThis.fetch;
/** Only this server is reachable; any other sheet, Razorpay or Telegram call fails the test. */
const localOnly = (url, init) => {
  const target = String(url && url.url ? url.url : url);
  if (!target.startsWith('http://localhost:') && !target.startsWith('http://127.0.0.1:')) {
    return Promise.reject(new Error(`Network call to ${target.split('?')[0]} attempted in a test — stub it`));
  }
  return realFetch(url, init);
};
require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};

const { fakeSheetsApi } = require('./helpers/fake-sheets');
const auth = require('../src/auth');
const sheets = require('../src/sheets');
const paybot = require('../src/paybot');
const razorpay = require('../src/razorpay');
const membership = require('../src/membership');
const tracking = require('../src/code-tracking');
const { istNow } = require('../src/sheets-direct').tabs;

auth.authorize = async (token) => {
  if (token !== 'valid-token') throw auth.authError('Token signature is invalid.', 'reauth');
  return { uid: 'u', email: 'admin@example.com', name: 'Admin', emailVerified: true, signInProvider: 'google.com' };
};

const redemptions = [];
sheets.forGroup = (groupId) => ({
  groupId,
  getBotSettings: async () => ({}),
  listCoupons: async () => [{ code: 'AD10', discount_type: 'flat', discount_value: 10, active: true },
    { code: 'NEWAD', discount_type: 'flat', discount_value: 20, active: true }],
  recordRedemption: async (r) => { redemptions.push(r); return { recorded: true }; }
});
paybot.getMe = async (env) => ({ username: env === 'TELEGRAM_PAYBOT_UPSC' ? 'prelimspaymentbot' : 'otherbot' });
const dms = [];
paybot.sendDirectMessage = async (env, id, text) => { dms.push({ env, id: String(id), text }); };

/** Payment ids already granted, so a retried webhook is recognised. */
const granted = new Set();
membership.grantAccess = async (options) => {
  const already = granted.has(options.paymentId);
  granted.add(options.paymentId);
  return { subscriber: { telegram_id: options.telegramId, expiry_date: '30-11-2099' }, inviteLink: 'https://t.me/+x', alreadyProcessed: already };
};

const server = require('../server');
delete process.env.SUPPORT_CHAT_ID;

const UPSC = 'TELEGRAM_PAYBOT_UPSC';
let baseUrl;
let book;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => {
  book = {};
  fakeSheetsApi(book, 'UPSCSHEET1234567890abcdefgh', { fallback: localOnly });
  redemptions.length = 0;
  dms.length = 0;
});

async function api(path, { method = 'GET', body, token = 'valid-token' } = {}) {
  const res = await realFetch(baseUrl + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function paidEvent({ code = 'AD10', kind = 'coupon', paymentId = 'pay_1', student = '900', amount = 18900 } = {}) {
  const notes = {
    telegram_id: student, telegram_username: 'kiran', plan_id: 'exam_pass', group_id: 'upsc',
    original_amount: '199', discount_amount: '10', student_name: 'Kiran Rao'
  };
  notes[kind === 'promo' ? 'promo_code' : 'coupon_code'] = code;
  return {
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: 'plink_' + paymentId, notes } }, payment: { entity: { id: paymentId, amount } } }
  };
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

test('a paid link with a coupon marks that student paid on the tracking tab', async () => {
  await tracking.record(UPSC, { type: 'clicked', code: 'AD10', student: { id: 900, username: 'kiran' }, source: 'link' });
  await tracking.record(UPSC, { type: 'link_created', code: 'AD10', student: { id: 900 }, amountPaise: 18900, linkId: 'plink_pay_1' });

  const handled = await server.handlePaymentEvent(paidEvent());
  assert.equal(handled.handled, true);
  assert.equal(redemptions.length, 1, 'the coupon use is still counted as before');
  assert.equal(dms.length, 1, 'the student still gets their invite');

  const [row] = await tracking.list(UPSC);
  assert.equal(row.stage, 'paid');
  assert.equal(row.payment_id, 'pay_1');
  assert.equal(row.paid_amount, '189');
  assert.equal(row.name, 'Kiran Rao');
  assert.ok(row.clicked_at, 'the click was kept');
});

test('a retried webhook does not touch the paid row again', async () => {
  await server.handlePaymentEvent(paidEvent({ paymentId: 'pay_retry' }));
  const first = (await tracking.list(UPSC))[0].paid_at;
  await new Promise((r) => setTimeout(r, 1100));
  await server.handlePaymentEvent(paidEvent({ paymentId: 'pay_retry' }));
  const rows = await tracking.list(UPSC);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].paid_at, first);
});

test('someone who typed the code and paid, never clicking, still shows as paid', async () => {
  await server.handlePaymentEvent(paidEvent({ paymentId: 'pay_typed', student: '901' }));
  const [row] = await tracking.list(UPSC);
  assert.equal(row.student_id, '901');
  assert.equal(row.stage, 'paid');
  assert.equal(row.kind, 'coupon');
});

test('a full-price payment adds nothing to tracking', async () => {
  const event = paidEvent({ paymentId: 'pay_full' });
  delete event.payload.payment_link.entity.notes.coupon_code;
  await server.handlePaymentEvent(event);
  assert.equal(book[tracking.TAB], undefined, 'the tab was touched for a payment with no code');
});

test('a paid webhook for a bot with no tracking sheet still lets the student in', async () => {
  const event = paidEvent({ paymentId: 'pay_epfo' });
  event.payload.payment_link.entity.notes.group_id = 'epfo';
  const handled = await server.handlePaymentEvent(event);
  assert.equal(handled.handled, true);
  assert.equal(dms.length, 1);
});

// ---------------------------------------------------------------------------
// The dashboard API
// ---------------------------------------------------------------------------

test('the tracking API needs a signed-in curator', async () => {
  assert.equal((await api('/api/pricing/tracking?group=upsc', { token: null })).status, 401);
});

test('the tracking API gives the funnel, the people, every coupon and the ad link', async () => {
  const hour = 60 * 60 * 1000;
  const at = (h) => new Date(Date.now() - h * hour);
  await tracking.record(UPSC, { type: 'clicked', code: 'AD10', student: { id: 1, username: 'a' }, source: 'link', now: at(5) });
  await tracking.record(UPSC, { type: 'clicked', code: 'AD10', student: { id: 2, username: 'b' }, source: 'link', now: at(5) });
  await tracking.record(UPSC, { type: 'link_created', code: 'AD10', student: { id: 2 }, amountPaise: 18900, linkId: 'plink_2', now: at(4) });
  await tracking.record(UPSC, { type: 'link_created', code: 'AD10', student: { id: 3 }, amountPaise: 18900, linkId: 'plink_3', now: at(30) });
  await tracking.record(UPSC, { type: 'paid', code: 'AD10', student: { id: 3 }, paymentId: 'pay_3', paidPaise: 18900, now: at(29) });
  await tracking.record(UPSC, { type: 'applied', code: 'RAVI10', kind: 'promo', student: { id: 4 }, source: 'typed', now: at(1) });

  const all = await api('/api/pricing/tracking?group=upsc');
  assert.equal(all.status, 200, JSON.stringify(all.json));
  const data = all.json.data;
  assert.equal(data.configured, true);
  assert.equal(data.linkBase, 'https://t.me/prelimspaymentbot?start=promo_');
  assert.equal(data.rows.length, 4);
  assert.ok(data.rows.every((r) => r._row === undefined), 'sheet row numbers are internal');
  assert.deepEqual(data.codes.map((c) => c.code), ['AD10', 'RAVI10', 'NEWAD'],
    'codes with activity first, then coupons nobody has used yet');
  assert.equal(data.codes.find((c) => c.code === 'NEWAD').people, 0);
  assert.equal(data.totals.people, 4);

  const ad = (await api('/api/pricing/tracking?group=upsc&code=ad10')).json.data;
  assert.equal(ad.code, 'AD10');
  assert.equal(ad.rows.length, 3);
  assert.equal(ad.totals.clicked, 2);
  assert.equal(ad.totals.linkCreated, 2);
  assert.equal(ad.totals.paid, 1);
  assert.equal(ad.totals.notPaid, 1);
  assert.equal(ad.totals.revenue, 189);
  const student2 = ad.rows.find((r) => r.student_id === '2');
  assert.equal(student2.stage, 'link_pending');
  assert.equal(student2.stage_label, 'Payment link created — not paid yet');
});

test('the tracking API works the same from the other language\'s group of a shared bot', async () => {
  process.env.SHEET_ID_APPSC_NEWS_EN = 'NEWSSHEET1234567890abcdefgh';
  try {
    fakeSheetsApi(book, 'NEWSSHEET1234567890abcdefgh', { fallback: localOnly });
    await tracking.record('TELEGRAM_PAYBOT_NEWS', { type: 'clicked', code: 'AD10', student: { id: 7 }, source: 'link' });
    const en = (await api('/api/pricing/tracking?group=appsc_news_en')).json.data;
    const te = (await api('/api/pricing/tracking?group=appsc_news_te')).json.data;
    assert.equal(en.rows.length, 1);
    assert.deepEqual(te.rows, en.rows);
    assert.equal(te.context.isPrimary, false);
  } finally {
    process.env.SHEET_ID_APPSC_NEWS_EN = '';
  }
});

test('a bot without a tracking sheet says so instead of failing', async () => {
  const res = await api('/api/pricing/tracking?group=epfo');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.configured, false);
  assert.deepEqual(res.json.data.rows, []);
  const check = await api('/api/pricing/tracking/refresh?group=epfo', { method: 'POST', body: {} });
  assert.equal(check.status, 409);
});

test('"Check payments with Razorpay" updates unpaid links and flags any paid but unrecorded', async () => {
  await tracking.record(UPSC, { type: 'link_created', code: 'AD10', student: { id: 11, username: 'x' }, amountPaise: 18900, linkId: 'plink_exp' });
  await tracking.record(UPSC, { type: 'link_created', code: 'AD10', student: { id: 12, username: 'y' }, amountPaise: 18900, linkId: 'plink_lost' });
  const asked = [];
  const original = razorpay.getPaymentLink;
  razorpay.getPaymentLink = async (id) => {
    asked.push(id);
    return id === 'plink_exp' ? { status: 'expired', payments: [{ status: 'failed' }] } : { status: 'paid', payments: [{ status: 'captured' }] };
  };
  try {
    const res = await api('/api/pricing/tracking/refresh?group=upsc', { method: 'POST', body: { code: 'AD10' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.data.checked, 2);
    assert.equal(res.json.data.unrecorded.length, 1);
    assert.match(res.json.message, /paid on Razorpay but never recorded/);
    assert.deepEqual(asked.sort(), ['plink_exp', 'plink_lost']);

    const data = (await api('/api/pricing/tracking?group=upsc&code=AD10')).json.data;
    assert.equal(data.rows.find((r) => r.student_id === '11').stage, 'link_expired');
    assert.equal(data.rows.find((r) => r.student_id === '11').failed_attempts, '1');
    assert.equal(data.rows.find((r) => r.student_id === '12').stage, 'paid_unrecorded');
    assert.equal(data.totals.unrecorded, 1);
  } finally {
    razorpay.getPaymentLink = original;
  }
});

test('the stored stage text is refreshed for a link that expired while nobody looked', async () => {
  const old = new Date(Date.now() - 26 * 60 * 60 * 1000);
  await tracking.record(UPSC, { type: 'link_created', code: 'AD10', student: { id: 21 }, amountPaise: 18900, linkId: 'plink_old', now: old });
  const data = (await api('/api/pricing/tracking?group=upsc&code=AD10')).json.data;
  assert.equal(data.rows[0].stage, 'link_expired', 'read-time stage is right even before anything is rewritten');
  assert.match(istNow(old), /IST$/);
});
