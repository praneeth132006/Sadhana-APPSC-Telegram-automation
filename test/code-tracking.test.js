// ============================================================================
// Code tracking, the store (test/code-tracking.test.js)
// ============================================================================
// Against an in-memory Google Sheet: one row per student per code, filled in
// step by step as they click, apply, make a payment link and pay — and read
// back with the stage worked out, so a link that quietly expired overnight
// shows as "did not pay" without anything being written.
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
process.env.LEGACY_GROUP_ID = '';
for (const prefix of ['APPSC_NEWS_EN', 'APPSC_NEWS_TE', 'APPSC_Q_EN', 'APPSC_Q_TE', 'UPSC', 'EPFO']) {
  process.env[`SHEET_URL_${prefix}`] = `https://script.google.com/macros/s/test-${prefix}/exec`;
  process.env[`SHEET_TOKEN_${prefix}`] = `token-${prefix}`;
  process.env[`TELEGRAM_GROUP_${prefix}`] = '-100' + Math.abs(prefix.length * 7919);
  // Blank, not deleted: dotenv would refill a deleted one from a local .env.
  process.env[`SHEET_ID_${prefix}`] = '';
}
// The newspaper bot's first group keeps its tracking; EPFO has no sheet id.
process.env.SHEET_ID_APPSC_NEWS_EN = 'https://docs.google.com/spreadsheets/d/NEWSSHEET1234567890abcdef/edit';
process.env.SHEET_ID_APPSC_NEWS_TE = 'NEWSTELUGUSHEET1234567890ab';
process.env.TELEGRAM_PAYBOT_NEWS = '111:TEST';
process.env.TELEGRAM_PAYBOT_EPFO = '444:TEST';

const { fakeSheetsApi } = require('./helpers/fake-sheets');
const tracking = require('../src/code-tracking');
const { istNow } = require('../src/sheets-direct').tabs;

const NEWS = 'TELEGRAM_PAYBOT_NEWS';
const KIRAN = { id: 900, first_name: 'Kiran', last_name: 'Rao', username: 'kiran' };
const MEENA = { id: 901, first_name: 'Meena', username: 'meena' };

function fresh() {
  const book = {};
  const api = fakeSheetsApi(book, 'NEWSSHEET1234567890abcdef');
  return { book, api };
}

/** The tab as objects, straight from the fake sheet. */
function tab(book) {
  const [header, ...rows] = book[tracking.TAB];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Where it lives
// ---------------------------------------------------------------------------

test('tracking lives in the first sheet of the bot\'s family, and is off where there is no sheet id', () => {
  assert.equal(tracking.primaryGroupFor(NEWS).id, 'appsc_news_en');
  assert.equal(tracking.isConfigured(NEWS), true);
  assert.equal(tracking.isConfigured('TELEGRAM_PAYBOT_EPFO'), false, 'EPFO has no SHEET_ID');
  assert.equal(tracking.isConfigured('TELEGRAM_PAYBOT_NOPE'), false);
});

test('safeRecord does nothing and says nothing for a bot with no sheet', async () => {
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error('should not be called'); };
  const out = await tracking.safeRecord('TELEGRAM_PAYBOT_EPFO', { type: 'clicked', code: 'AD10', student: KIRAN });
  assert.equal(out, null);
  assert.equal(called, 0);
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

test('the first event creates the tab with its headers and one row', async () => {
  const { book } = fresh();
  await tracking.record(NEWS, { type: 'clicked', code: 'ad10', student: KIRAN, source: 'link' });
  assert.deepEqual(book[tracking.TAB][0], tracking.HEADERS);
  const [row] = tab(book);
  assert.equal(row.Code, 'AD10', 'codes are stored upper-case');
  assert.equal(row['Student ID'], '900');
  assert.equal(row.Username, 'kiran');
  assert.equal(row.Name, 'Kiran Rao');
  assert.equal(row.Source, 'link');
  assert.equal(row.Clicks, 1);
  assert.match(row['Clicked At'], /IST$/);
  assert.equal(row.Stage, 'Clicked link only');
});

test('a student is one row per code however often they come back', async () => {
  const { book } = fresh();
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link', now: new Date(Date.now() - HOUR) });
  const first = tab(book)[0]['Clicked At'];
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link' });
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link' });
  const rows = tab(book);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Clicks, 3);
  assert.equal(rows[0]['Clicked At'], first, 'the first click is kept');
});

test('different students and different codes are separate rows', async () => {
  const { book } = fresh();
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link' });
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: MEENA, source: 'link' });
  await tracking.record(NEWS, { type: 'applied', code: 'DIWALI20', student: KIRAN, source: 'typed', kind: 'coupon' });
  assert.equal(tab(book).length, 3);
});

test('events arriving together for one student still make one row', async () => {
  const { book } = fresh();
  await Promise.all([
    tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link' }),
    tracking.record(NEWS, { type: 'applied', code: 'AD10', student: KIRAN, source: 'link', kind: 'coupon' }),
    tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link' })
  ]);
  const rows = tab(book);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Clicks, 2);
  assert.ok(rows[0]['Applied At']);
});

test('the whole way: clicked, applied, made a link, paid — every step kept', async () => {
  const { book } = fresh();
  const student = KIRAN;
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student, source: 'link' });
  await tracking.record(NEWS, { type: 'applied', code: 'AD10', student, source: 'link', kind: 'coupon', group: 'Newspaper · English' });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student, kind: 'coupon', amountPaise: 17910, linkId: 'plink_1' });
  let [row] = tab(book);
  assert.equal(row.Stage, 'Payment link created — not paid yet');
  assert.equal(row.Amount, 179.1);
  assert.equal(row['Link ID'], 'plink_1');
  assert.equal(row['Links Created'], 1);
  assert.equal(row['Link Status'], 'created');

  await tracking.record(NEWS, { type: 'paid', code: 'AD10', student: { id: '900', username: 'kiran' },
    paymentId: 'pay_1', paidPaise: 17910 });
  [row] = tab(book);
  assert.equal(row.Stage, 'Paid');
  assert.equal(row['Payment ID'], 'pay_1');
  assert.equal(row['Paid Amount'], 179.1);
  assert.equal(row['Link Status'], 'paid');
  for (const col of ['Clicked At', 'Applied At', 'Link Created At', 'Paid At']) assert.ok(row[col], `${col} was lost`);
  assert.equal(row.Kind, 'coupon');
  assert.equal(row.Group, 'Newspaper · English');
  assert.equal(row.Name, 'Kiran Rao', 'the paid event without a name must not blank it');
});

test('the first way in is kept: an ad click later typed in still came from the ad', async () => {
  const { book } = fresh();
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link' });
  await tracking.record(NEWS, { type: 'applied', code: 'AD10', student: KIRAN, source: 'typed' });
  assert.equal(tab(book)[0].Source, 'link');
});

test('a second payment link counts, and the row shows the latest one', async () => {
  const { book } = fresh();
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: KIRAN, amountPaise: 17910, linkId: 'plink_1' });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: KIRAN, amountPaise: 17910, linkId: 'plink_2' });
  const [row] = tab(book);
  assert.equal(row['Links Created'], 2);
  assert.equal(row['Link ID'], 'plink_2');
  assert.ok(row['Applied At'], 'making a link means the code was applied');
});

test('a refused code keeps its reason; applying it later moves them on', async () => {
  const { book } = fresh();
  await tracking.record(NEWS, { type: 'refused', code: 'AD10', student: KIRAN, source: 'typed', reason: 'That coupon code has expired.' });
  let [row] = tab(book);
  assert.equal(row.Stage, 'Code refused');
  assert.equal(row['Refused Reason'], 'That coupon code has expired.');
  await tracking.record(NEWS, { type: 'applied', code: 'AD10', student: KIRAN, source: 'typed' });
  [row] = tab(book);
  assert.equal(row.Stage, 'Applied code — no payment link');
});

test('bad events are refused rather than written', async () => {
  fresh();
  await assert.rejects(tracking.record(NEWS, { type: 'clicked', code: '', student: KIRAN }), /code and a student id/);
  await assert.rejects(tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: {} }), /code and a student id/);
  await assert.rejects(tracking.record(NEWS, { type: 'teleported', code: 'AD10', student: KIRAN }), /Unknown tracking event/);
});

test('safeRecord swallows a sheet that will not answer, and logs it', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return { ok: false, status: 403, json: async () => ({ error: { message: 'The caller does not have permission' } }) };
  };
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const out = await tracking.safeRecord(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN });
    assert.equal(out, null);
    assert.match(logged.join('\n'), /could not record clicked for AD10/);
  } finally {
    console.error = original;
  }
});

test('an admin who adds a column of their own does not scramble the writes', async () => {
  const { book } = fresh();
  book[tracking.TAB] = [['My notes', ...tracking.HEADERS.slice(0, 10)]];
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: KIRAN, amountPaise: 19900, linkId: 'plink_9' });
  const header = book[tracking.TAB][0];
  assert.equal(header[0], 'My notes');
  assert.ok(header.includes('Link ID'), 'the missing columns were added on the end');
  const row = book[tracking.TAB][1];
  assert.equal(row[0], '', 'the admin\'s column was written into');
  assert.equal(row[header.indexOf('Link ID')], 'plink_9');
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

test('stage: a link lasts 24 hours, then shows as expired without anyone writing it', () => {
  const now = new Date();
  const created = (hoursAgo) => istNow(new Date(now.getTime() - hoursAgo * HOUR));
  assert.equal(tracking.stageOf({ link_created_at: created(2), link_status: 'created' }, now), 'link_pending');
  assert.equal(tracking.stageOf({ link_created_at: created(25), link_status: 'created' }, now), 'link_expired');
  assert.equal(tracking.stageOf({ link_created_at: created(1), link_status: 'expired' }, now), 'link_expired');
  assert.equal(tracking.stageOf({ link_created_at: created(1), link_status: 'cancelled' }, now), 'link_expired');
  assert.equal(tracking.stageOf({ link_created_at: created(1), link_status: 'paid' }, now), 'paid_unrecorded');
  assert.equal(tracking.stageOf({ link_created_at: created(30), paid_at: created(29) }, now), 'paid');
  assert.equal(tracking.stageOf({ applied_at: created(1) }, now), 'applied');
  assert.equal(tracking.stageOf({ refused_at: created(1) }, now), 'refused');
  assert.equal(tracking.stageOf({ refused_at: created(2), applied_at: created(1) }, now), 'applied');
  assert.equal(tracking.stageOf({ clicked_at: created(1) }, now), 'clicked');
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('list gives every row with its stage, newest activity first, and can narrow to one code', async () => {
  fresh();
  const now = Date.now();
  await tracking.record(NEWS, { type: 'clicked', code: 'AD10', student: KIRAN, source: 'link', now: new Date(now - 3 * HOUR) });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: MEENA, amountPaise: 17910, linkId: 'p', now: new Date(now - HOUR) });
  await tracking.record(NEWS, { type: 'applied', code: 'OTHER', student: KIRAN, source: 'typed', now: new Date(now - 2 * HOUR) });

  const all = await tracking.list(NEWS);
  assert.deepEqual(all.map((r) => [r.code, r.student_id]), [['AD10', '901'], ['OTHER', '900'], ['AD10', '900']]);
  assert.equal(all[0].stage, 'link_pending');
  assert.equal(all[0].stage_label, 'Payment link created — not paid yet');

  const ad = await tracking.list(NEWS, { code: 'ad10' });
  assert.equal(ad.length, 2);
  assert.ok(ad.every((r) => r.code === 'AD10'));

  // A day later, Meena's unpaid link has expired.
  const later = await tracking.list(NEWS, { code: 'AD10', now: new Date(now + 24 * HOUR) });
  assert.equal(later.find((r) => r.student_id === '901').stage, 'link_expired');
});

test('summarise counts people at every step they reached', () => {
  const now = new Date();
  const ago = (h) => istNow(new Date(now.getTime() - h * HOUR));
  const rows = [
    // clicked only
    { code: 'AD10', clicked_at: ago(5), clicks: '2', source: 'link' },
    // clicked, applied, link, paid
    { code: 'AD10', clicked_at: ago(5), clicks: '1', applied_at: ago(4), link_created_at: ago(4), links_created: '1',
      paid_at: ago(4), paid_amount: '179.1', source: 'link' },
    // typed, link still open
    { code: 'AD10', applied_at: ago(1), link_created_at: ago(1), links_created: '2', link_status: 'created', source: 'typed' },
    // link expired
    { code: 'AD10', clicked_at: ago(30), clicks: '1', applied_at: ago(30), link_created_at: ago(30), links_created: '1', source: 'link' },
    // applied, no link
    { code: 'AD10', applied_at: ago(2), source: 'typed' },
    // refused
    { code: 'AD10', refused_at: ago(2), refused_reason: 'expired', source: 'typed' },
    // paid on Razorpay, never recorded
    { code: 'AD10', applied_at: ago(3), link_created_at: ago(3), links_created: '1', link_status: 'paid', source: 'link' }
  ].map((r) => Object.assign({ stage: tracking.stageOf(r, now) }, r));

  const s = tracking.summarise(rows);
  assert.equal(s.people, 7);
  assert.equal(s.clicked, 3);
  assert.equal(s.clicks, 4);
  assert.equal(s.applied, 5);
  assert.equal(s.refused, 1);
  assert.equal(s.linkCreated, 4);
  assert.equal(s.links, 5);
  assert.equal(s.paid, 1);
  assert.equal(s.revenue, 179.1);
  assert.equal(s.pending, 1);
  assert.equal(s.expired, 1);
  assert.equal(s.notPaid, 2, 'made a link and did not pay: the open one and the expired one');
  assert.equal(s.unrecorded, 1);
  assert.equal(s.appliedNoLink, 1);
  assert.equal(s.clickedOnly, 1);
  assert.equal(s.fromLink, 4);
  assert.equal(s.typed, 3);
  assert.equal(s.conversion, 14.3);

  const empty = tracking.summarise([]);
  assert.equal(empty.people, 0);
  assert.equal(empty.conversion, 0, 'no division by zero');
});

test('summariseByCode gives one funnel per code, busiest first', () => {
  const rows = [
    { code: 'AD10', kind: 'coupon', clicked_at: 'x', stage: 'clicked' },
    { code: 'AD10', kind: '', applied_at: 'x', stage: 'applied' },
    { code: 'RAVI10', kind: 'promo', paid_at: 'x', paid_amount: '180', stage: 'paid' }
  ];
  const out = tracking.summariseByCode(rows);
  assert.deepEqual(out.map((c) => [c.code, c.kind, c.people]), [['AD10', 'coupon', 2], ['RAVI10', 'promo', 1]]);
  assert.equal(out[1].revenue, 180);
});

// ---------------------------------------------------------------------------
// Asking Razorpay about links that were never paid
// ---------------------------------------------------------------------------

test('checking with Razorpay: expired, failed attempts, paid-but-unrecorded — and paid rows are left alone', async () => {
  const { book } = fresh();
  const student = (id) => ({ id, username: 'u' + id });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: student(1), amountPaise: 100, linkId: 'plink_expired' });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: student(2), amountPaise: 100, linkId: 'plink_failed' });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: student(3), amountPaise: 100, linkId: 'plink_paid' });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: student(4), amountPaise: 100, linkId: 'plink_done' });
  await tracking.record(NEWS, { type: 'paid', code: 'AD10', student: student(4), paymentId: 'pay_4', paidPaise: 100 });
  await tracking.record(NEWS, { type: 'link_created', code: 'OTHER', student: student(5), amountPaise: 100, linkId: 'plink_other' });
  await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: student(6), amountPaise: 100, linkId: 'plink_broken' });

  const asked = [];
  const links = {
    plink_expired: { status: 'expired', payments: [] },
    plink_failed: { status: 'created', payments: [{ status: 'failed' }, { status: 'failed' }] },
    plink_paid: { status: 'paid', payments: [{ status: 'captured' }] }
  };
  const originalError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await tracking.refreshFromRazorpay(NEWS, {
      code: 'AD10',
      getPaymentLink: async (id) => {
        asked.push(id);
        if (!links[id]) throw new Error('Razorpay 500');
        return links[id];
      }
    });
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(asked.sort(), ['plink_broken', 'plink_expired', 'plink_failed', 'plink_paid'],
    'only unpaid links of this code are asked about');
  assert.equal(result.checked, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.unrecorded.length, 1);
  assert.equal(result.unrecorded[0].link_id, 'plink_paid');
  assert.equal(result.remaining, 0);

  const rows = await tracking.list(NEWS, { code: 'AD10' });
  const by = (id) => rows.find((r) => r.student_id === String(id));
  assert.equal(by(1).stage, 'link_expired');
  assert.equal(by(2).stage, 'link_pending');
  assert.equal(by(2).failed_attempts, '2');
  assert.equal(by(3).stage, 'paid_unrecorded');
  assert.equal(by(4).stage, 'paid');
  assert.ok(by(1).checked_at, 'when it was checked is recorded');
  assert.equal(tab(book).find((r) => r['Student ID'] === '1').Stage, 'Payment link expired — did not pay');

  // An expired link is final: the next check does not ask about it again.
  asked.length = 0;
  await tracking.refreshFromRazorpay(NEWS, { code: 'AD10', getPaymentLink: async (id) => { asked.push(id); return links[id] || { status: 'created' }; } });
  assert.ok(!asked.includes('plink_expired'));
});

test('checking with Razorpay is bounded, and says how many are left', async () => {
  fresh();
  for (let i = 1; i <= 5; i++) {
    await tracking.record(NEWS, { type: 'link_created', code: 'AD10', student: { id: i }, amountPaise: 100, linkId: 'plink_' + i });
  }
  const result = await tracking.refreshFromRazorpay(NEWS, { limit: 2, getPaymentLink: async () => ({ status: 'created', payments: [] }) });
  assert.equal(result.checked, 2);
  assert.equal(result.remaining, 3);
});
