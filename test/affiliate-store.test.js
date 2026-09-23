// ============================================================================
// The influencer spreadsheet (test/affiliate-store.test.js)
// ============================================================================
// Every record the programme keeps, against an in-memory Google Sheet that
// behaves like the Sheets API: tabs created on first use, rows appended, rows
// rewritten in place. The money paths are the ones that matter most — a sale
// credited once however often Razorpay redelivers, a rupee in at most one
// withdrawal, and a rejected withdrawal handing its sales back.
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
process.env.AFFILIATE_SHEET_ID = 'https://docs.google.com/spreadsheets/d/AFFILIATESHEET1234567890abc/edit';
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

const { fakeSheetsApi } = require('./helpers/fake-sheets');
const store = require('../src/affiliate-store');
const affiliates = require('../src/affiliates');

const RAVI = { id: 501, first_name: 'Ravi', last_name: 'Kumar', username: 'ravi_teaches' };
const TERMS = affiliates.validateTerms({
  discount_type: 'percent', discount_value: 10, commission_type: 'percent', commission_value: 20,
  payout_cycle: 'weekly', min_payout: 50
}).value;

function fresh() {
  const book = {};
  const api = fakeSheetsApi(book, 'AFFILIATESHEET1234567890abc');
  return { book, api };
}

async function approvedCode(terms = TERMS) {
  const applied = await store.createRequest(RAVI, 'news', 'Ravi, YouTube @ravi_teaches, 40k subscribers');
  assert.equal(applied.ok, true, applied.reason);
  const approved = await store.approveRequest(applied.request.request_id, terms, 'Admin (a@x.com)',
    { botUsername: 'appscpaymentsbot' });
  assert.equal(approved.ok, true, approved.error);
  return approved.code;
}

/** Everything RazorpayX needs to pay Ravi, by UPI. */
async function giveDetails(user = RAVI) {
  for (const [field, value] of [['legal_name', 'Ravi Kumar'], ['phone', '9876543210'], ['email', 'ravi@example.com'], ['upi_id', 'ravi@okicici']]) {
    const out = await store.setPayoutField(user, field, value);
    assert.equal(out.ok, true, out.reason);
  }
}

async function sell(code, paymentId, studentId = 900) {
  return store.recordSale({
    code: code.code, payment_id: paymentId, student_id: studentId, student_username: 's' + studentId,
    student_name: 'Student', group: 'UPSC Prelims',
    list_price_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582
  });
}

test('the sheet builds its own tabs, styled, on first use', async () => {
  const { book } = fresh();
  const tabs = await store.ensureTabs();
  assert.deepEqual(tabs, ['Influencers', 'Requests', 'Codes', 'Sales', 'Payouts', 'Link Opens', 'Log']);
  for (const tab of tabs) {
    assert.ok(book[tab], `${tab} was not created`);
    assert.deepEqual(book[tab][0], store.TABLES[Object.keys(store.TABLES).find((k) => store.TABLES[k].tab === tab)].headers);
  }
});

test('the sheet is made readable: ₹ on money, coloured dropdowns on Status, no blank Sheet1', async () => {
  const book = { Sheet1: [] };
  const { calls } = fakeSheetsApi(book, 'AFFILIATESHEET1234567890abc');
  await store.ensureTabs();
  const requests = calls.filter((c) => c.path.startsWith(':batchUpdate')).flatMap((c) => c.body.requests);

  const money = requests.filter((r) => r.repeatCell && r.repeatCell.fields === 'userEnteredFormat.numberFormat');
  assert.equal(money.length, 9, 'Codes ×4, Sales ×4, Payouts ×1');
  assert.equal(money[0].repeatCell.cell.userEnteredFormat.numberFormat.pattern, '"₹"#,##0.00');

  const dropdowns = requests.filter((r) => r.setDataValidation);
  assert.equal(dropdowns.length, 5, 'one per Status column');
  const values = dropdowns.map((r) => r.setDataValidation.rule.condition.values.map((v) => v.userEnteredValue));
  assert.ok(values.some((v) => v.join() === 'pending,approved,rejected'));
  assert.ok(values.some((v) => v.join() === 'earned,requested,paid,cancelled'));
  assert.ok(dropdowns.every((r) => r.setDataValidation.rule.strict === false), 'a dropdown must never refuse a write');

  assert.ok(requests.filter((r) => r.addConditionalFormatRule).length >= 14);
  assert.equal(book.Sheet1, undefined, 'the blank starter tab was left behind');
});

test('a Sheet1 with anything in it is never deleted', async () => {
  const book = { Sheet1: [['my notes']] };
  fakeSheetsApi(book, 'AFFILIATESHEET1234567890abc');
  await store.ensureTabs();
  assert.deepEqual(book.Sheet1, [['my notes']]);
});

test('an application is recorded once per exam, and refused while one is waiting', async () => {
  const { book } = fresh();
  const first = await store.createRequest(RAVI, 'news', 'Ravi, YouTube @ravi_teaches, 40k subscribers');
  assert.equal(first.ok, true);
  assert.match(first.request.request_id, /^REQ-\d{8}-[0-9A-F]{6}$/);

  const again = await store.createRequest(RAVI, 'news', 'Ravi again, same channel, please');
  assert.equal(again.ok, false);
  assert.match(again.reason, /already with the admin/);

  // Sadhana APPSC is closed to influencers, so it takes no application.
  const closed = await store.createRequest(RAVI, 'sadhana', 'Ravi, also a Telegram channel for Sadhana aspirants');
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /not open/);

  assert.equal(book.Requests.length, 2, 'header + one application');
  assert.equal(book.Influencers.length, 2, 'one person, one row');
});

test('an application for an exam that is not on offer is refused', async () => {
  fresh();
  const out = await store.createRequest(RAVI, 'no_such_exam', 'Some details that are long enough');
  assert.equal(out.ok, false);
  assert.match(out.reason, /not open/);
});

test('approving creates the code with the admin\'s terms and a share link', async () => {
  const { book } = fresh();
  const code = await approvedCode();
  assert.match(code.code, /^RAVIKUNEWS\d{2}$/);
  assert.equal(code.exam, 'news');
  assert.equal(code.exam_bot, 'TELEGRAM_PAYBOT_NEWS');
  assert.equal(code.share_link, `https://t.me/appscpaymentsbot?start=promo_${code.code}`);

  const saved = await store.getCode(code.code.toLowerCase());
  assert.equal(saved.discount_value, '10');
  assert.equal(saved.commission_value, '20');
  assert.equal(saved.payout_cycle, 'weekly');
  const request = (await store.listRequests())[0];
  assert.equal(request.status, 'approved');
  assert.equal(request.code, code.code);
  assert.ok(book.Log.some((r) => r[2] === 'approved'));
});

test('an approved exam cannot be applied for again while its code is active', async () => {
  fresh();
  await approvedCode();
  const again = await store.createRequest(RAVI, 'news', 'Another application for the same exam');
  assert.equal(again.ok, false);
  assert.match(again.reason, /already have the code/);
});

test('a custom code already used by a coupon or another influencer is refused', async () => {
  fresh();
  const applied = await store.createRequest(RAVI, 'news', 'Ravi, YouTube, 40k subscribers');
  const clash = await store.approveRequest(applied.request.request_id, Object.assign({}, TERMS, { code: 'SAVE10' }),
    'Admin', { codeTaken: async (c) => c === 'SAVE10' });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /already in use/);

  const ok = await store.approveRequest(applied.request.request_id, Object.assign({}, TERMS, { code: 'RAVI10' }), 'Admin');
  assert.equal(ok.ok, true);
  assert.equal(ok.code.code, 'RAVI10');
});

test('a request is decided once', async () => {
  fresh();
  const applied = await store.createRequest(RAVI, 'news', 'Ravi, YouTube, 40k subscribers');
  const rejected = await store.rejectRequest(applied.request.request_id, 'Audience too small for now', 'Admin');
  assert.equal(rejected.ok, true);
  const late = await store.approveRequest(applied.request.request_id, TERMS, 'Admin');
  assert.equal(late.ok, false);
  assert.match(late.error, /already rejected/);
});

test('a sale is credited once, however many times Razorpay delivers it', async () => {
  const { book } = fresh();
  const code = await approvedCode();
  const first = await sell(code, 'pay_A1');
  const again = await sell(code, 'pay_A1');
  assert.equal(first.recorded, true);
  assert.equal(again.recorded, false);
  assert.equal(book.Sales.length, 2, 'header + one sale');

  const sale = (await store.listSales())[0];
  assert.equal(sale.paid, '179.1', 'money is written in rupees for people');
  assert.equal(sale.commission_paise, 3582, 'and read back in paise for code');
  assert.equal(sale.status, 'earned');

  const row = await store.getCode(code.code);
  assert.equal(row.uses, '1');
  assert.equal(row.commission_earned, '35.82');
});

test('a payment naming a code that is not in the Codes tab credits nobody', async () => {
  const { book } = fresh();
  await store.ensureTabs();
  const out = await store.recordSale({ code: 'GHOST10', influencer_id: '999', payment_id: 'pay_G', paid_paise: 17910, commission_paise: 3582 });
  assert.equal(out.recorded, false);
  assert.equal(book.Sales.length, 1, 'only the header');
});

test('the influencer credited is the code\'s owner, never whoever the notes name', async () => {
  fresh();
  const code = await approvedCode();
  const out = await store.recordSale({ code: code.code, influencer_id: '666', payment_id: 'pay_O', student_id: 900,
    list_price_paise: 19900, discount_paise: 1990, paid_paise: 17910, commission_paise: 3582 });
  assert.equal(out.sale.influencer_id, String(RAVI.id));
});

test('usage counts every paid use and each student\'s own', async () => {
  fresh();
  const code = await approvedCode();
  await sell(code, 'pay_1', 900);
  await sell(code, 'pay_2', 901);
  assert.deepEqual(await store.usageOf(code.code, 900), { uses: 2, usesByStudent: 1 });
  assert.deepEqual(await store.usageOf(code.code, 999), { uses: 2, usesByStudent: 0 });
});

test('withdrawing needs a UPI ID, the minimum, and respects the cycle', async () => {
  fresh();
  const code = await approvedCode();
  await sell(code, 'pay_1');

  // ₹35.82 earned, ₹50 minimum.
  const under = await store.requestPayout(code.code, RAVI.id);
  assert.equal(under.ok, false);
  assert.match(under.reason, /₹14\.18 to go/);

  await sell(code, 'pay_2', 901);
  assert.equal((await store.setUpi(RAVI, 'not a upi')).ok, false);
  assert.equal((await store.setUpi(RAVI, 'ravi@okicici')).ok, true);
  const noDetails = await store.requestPayout(code.code, RAVI.id);
  assert.equal(noDetails.ok, false);
  assert.match(noDetails.reason, /payout details.*Name as on your bank account, Mobile number, Email/);

  await giveDetails();

  const ok = await store.requestPayout(code.code, RAVI.id);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.payout.amount_paise, 7164);
  assert.equal(ok.payout.upi_id, 'ravi@okicici');
  assert.equal(ok.payout.sales, 2);

  // The same money cannot be asked for twice.
  const twice = await store.requestPayout(code.code, RAVI.id);
  assert.equal(twice.ok, false);
  assert.match(twice.reason, /still with the admin/);
  const sales = await store.listSales();
  assert.ok(sales.every((s) => s.status === 'requested' && s.payout_id === ok.payout.payout_id));
});

test('someone else cannot withdraw a code\'s earnings', async () => {
  fresh();
  const code = await approvedCode();
  const out = await store.requestPayout(code.code, 12345);
  assert.equal(out.ok, false);
  assert.match(out.reason, /not one of your codes/);
});

test('marking paid needs the UPI reference, then closes the sales', async () => {
  fresh();
  const code = await approvedCode(Object.assign({}, TERMS, { min_payout: 0 }));
  await giveDetails();
  await sell(code, 'pay_1');
  const { payout } = await store.requestPayout(code.code, RAVI.id);

  const noRef = await store.decidePayout(payout.payout_id, 'paid', { actor: 'Admin' });
  assert.equal(noRef.ok, false);
  assert.match(noRef.error, /UTR/);

  const paid = await store.decidePayout(payout.payout_id, 'paid', { reference: '412345678901', actor: 'Admin' });
  assert.equal(paid.ok, true);
  const [sale] = await store.listSales();
  assert.equal(sale.status, 'paid');
  assert.ok(sale.paid_at);
  assert.equal((await store.getCode(code.code)).commission_paid, '35.82');

  const again = await store.decidePayout(payout.payout_id, 'paid', { reference: 'x', actor: 'Admin' });
  assert.equal(again.ok, false, 'a withdrawal is paid once');
});

test('a rejected withdrawal hands its sales back to be withdrawn again', async () => {
  fresh();
  const code = await approvedCode(Object.assign({}, TERMS, { min_payout: 0 }));
  await giveDetails();
  await sell(code, 'pay_1');
  const { payout } = await store.requestPayout(code.code, RAVI.id);
  const rejected = await store.decidePayout(payout.payout_id, 'rejected', { reason: 'Wrong UPI ID', actor: 'Admin' });
  assert.equal(rejected.ok, true);
  const [sale] = await store.listSales();
  assert.equal(sale.status, 'earned');
  assert.equal(sale.payout_id, '');

  // And a rejected request does not start the weekly clock.
  const retry = await store.requestPayout(code.code, RAVI.id);
  assert.equal(retry.ok, true, retry.reason);
});

test('a paid withdrawal starts the weekly clock', async () => {
  fresh();
  const code = await approvedCode(Object.assign({}, TERMS, { min_payout: 0 }));
  await giveDetails();
  await sell(code, 'pay_1');
  const { payout } = await store.requestPayout(code.code, RAVI.id);
  await store.decidePayout(payout.payout_id, 'paid', { reference: 'UTR1', actor: 'Admin' });
  await sell(code, 'pay_2', 901);

  const tooSoon = await store.requestPayout(code.code, RAVI.id);
  assert.equal(tooSoon.ok, false);
  assert.match(tooSoon.reason, /weekly/);
  assert.ok(tooSoon.nextAt instanceof Date);

  const nextWeek = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const later = await store.requestPayout(code.code, RAVI.id, nextWeek);
  assert.equal(later.ok, true, later.reason);
});

test('pausing a code keeps its history; changing terms keeps past earnings', async () => {
  fresh();
  const code = await approvedCode();
  await sell(code, 'pay_1');
  assert.equal((await store.setCodeStatus(code.code, 'paused', 'Admin')).code.status, 'paused');
  assert.equal((await store.getCode(code.code)).status, 'paused');

  const changed = await store.updateCodeTerms(code.code, Object.assign({}, TERMS, { commission_value: 30 }), 'Admin');
  assert.equal(changed.ok, true);
  assert.equal((await store.getCode(code.code)).commission_value, '30');
  assert.equal((await store.listSales())[0].commission_paise, 3582, 'a past sale keeps what it earned');
});

test('columns are found by name, so a reordered sheet is still read right', async () => {
  const { book } = fresh();
  await store.ensureTabs();
  // An admin drags "Name" to the front of Influencers.
  book.Influencers[0] = ['Name', 'Telegram ID', 'Username', 'UPI ID', 'Joined At', 'Updated At', 'Status', 'Notes'];
  await store.setUpi(RAVI, 'ravi@okicici');
  const row = book.Influencers[1];
  assert.equal(row[0], 'Ravi Kumar');
  assert.equal(row[1], '501');
  assert.equal((await store.getInfluencer(501)).upi_id, 'ravi@okicici');
});

test('payout details: each is checked, and the sheet says who can be paid', async () => {
  const { book } = fresh();
  assert.match((await store.setPayoutField(RAVI, 'phone', '12345')).reason, /10-digit/);
  assert.match((await store.setPayoutField(RAVI, 'email', 'nope')).reason, /email/);
  assert.equal((await store.setPayoutField(RAVI, 'phone', '+91 98765 43210')).value, '9876543210');
  await giveDetails();
  const row = await store.getInfluencer(501);
  assert.equal(row.details_complete, 'yes');
  assert.equal(row.payout_method, 'upi');
  const header = book.Influencers[0];
  for (const col of ['Legal Name', 'Phone', 'Email', 'Payout Method', 'Account Holder', 'Account Number', 'IFSC', 'PAN', 'Details Complete']) {
    assert.ok(header.includes(col), `${col} is not a column`);
  }
});

test('a bank account is taken whole, checked, and becomes the payout method', async () => {
  fresh();
  await giveDetails();
  assert.match((await store.setBankAccount(RAVI, { holder: 'Ravi Kumar', number: '12', ifsc: 'HDFC0001234' })).reason, /9 to 18 digits/);
  assert.match((await store.setBankAccount(RAVI, { holder: 'Ravi Kumar', number: '123456789012', ifsc: 'HDFC001' })).reason, /IFSC/);
  const ok = await store.setBankAccount(RAVI, { holder: 'Ravi Kumar', number: '1234 5678 9012', ifsc: 'hdfc0001234' });
  assert.equal(ok.ok, true, ok.reason);
  const row = await store.getInfluencer(501);
  assert.deepEqual([row.payout_method, row.account_number, row.ifsc, row.details_complete], ['bank', '123456789012', 'HDFC0001234', 'yes']);
  // Switching back to UPI works because the UPI ID is there too.
  assert.equal((await store.setPayoutMethod(RAVI, 'upi')).ok, true);
  const newbie = { id: 777, first_name: 'New' };
  assert.match((await store.setPayoutMethod(newbie, 'bank')).reason, /bank account first/);
});

test('a withdrawal records the payout details as they were when it was asked for', async () => {
  const { book } = fresh();
  const code = await approvedCode(Object.assign({}, TERMS, { min_payout: 0 }));
  await giveDetails();
  await store.setBankAccount(RAVI, { holder: 'Ravi Kumar', number: '123456789012', ifsc: 'HDFC0001234' });
  await sell(code, 'pay_1');
  const { payout } = await store.requestPayout(code.code, RAVI.id);
  assert.equal(payout.payout_method, 'bank');
  assert.equal(payout.account_number, '123456789012');
  assert.equal(payout.phone, '9876543210');
  // Changing the UPI ID afterwards does not touch the request already made.
  await store.setPayoutField(RAVI, 'upi_id', 'other@okaxis');
  const [header, row] = book.Payouts;
  assert.equal(row[header.indexOf('UPI ID')], 'ravi@okicici');
  assert.equal(row[header.indexOf('IFSC')], 'HDFC0001234');
});

test('a link open is recorded once per student, never for the influencer or an unknown code', async () => {
  const { book } = fresh();
  const code = await approvedCode();
  const kiran = { id: 900, first_name: 'Kiran', username: 'kiran' };
  assert.equal((await store.recordLinkOpen(code.code, kiran)).recorded, true);
  assert.equal((await store.recordLinkOpen(code.code.toLowerCase(), kiran)).recorded, false, 'counted twice');
  assert.equal((await store.recordLinkOpen(code.code, RAVI)).recorded, false, 'the influencer counted their own open');
  assert.equal((await store.recordLinkOpen('GHOST', kiran)).recorded, false);
  assert.equal(book['Link Opens'].length, 2, 'header + one open');
  const [open] = await store.listOpens();
  assert.deepEqual([open.code, open.student_id, open.student_name], [code.code, '900', 'Kiran']);
});

test('a paused code for an exam stops a fresh application for it', async () => {
  fresh();
  const code = await approvedCode();
  await store.setCodeStatus(code.code, 'paused', 'Admin');
  const again = await store.createRequest(RAVI, 'news', 'Email: ravi@gmail.com · Mobile: 9876543210');
  assert.equal(again.ok, false);
  assert.match(again.reason, /is paused/);
});

test('the paid message names a bank transfer as one, not as UPI', () => {
  const notify = require('../src/affiliate-notify');
  const bank = notify.payoutPaidMessage({ payout_method: 'bank', account_number: '123456789012', amount_paise: 5000,
    code: 'RAVI10', reference: 'UTR123', upi_id: '' });
  assert.match(bank, /bank account <code>XXXXXXXX9012/);
  assert.match(bank, /Bank reference \(UTR\): <code>UTR123/);
  assert.doesNotMatch(bank, /UPI/);
  const upi = notify.payoutPaidMessage({ payout_method: 'upi', upi_id: 'ravi@okicici', amount_paise: 5000, code: 'RAVI10', reference: 'R1' });
  assert.match(upi, /Sent to <code>ravi@okicici/);
});

test('setPayoutFields saves several details in one write, and reports what it could not', async () => {
  const { book, api } = fresh();
  const out = await store.setPayoutFields(RAVI, { legal_name: 'Ravi Kumar', email: 'RAVI@GMAIL.COM', phone: '123', upi_id: 'ravi@okicici' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.saved, ['legal_name', 'email', 'upi_id']);
  assert.deepEqual(out.refused.map((r) => r.field), ['phone']);
  assert.equal(out.influencer.email, 'ravi@gmail.com');
  assert.equal(out.influencer.payout_method, 'upi');
  assert.equal(out.influencer.details_complete, 'no', 'the mobile is still missing');
  const person = await store.getInfluencer(501);
  assert.equal(person.legal_name, 'Ravi Kumar');
  assert.equal(book.Influencers.length, 2, 'one person, one row');

  // Four details are one write to their row, not four.
  const rowWrites = () => api.calls.filter((c) => c.method === 'POST' && c.body && Array.isArray(c.body.data) &&
    c.body.data.some((d) => /^'Influencers'!/.test(d.range))).length;
  const before = rowWrites();
  await store.setPayoutFields(RAVI, { legal_name: 'Ravi K', email: 'ravi@yahoo.com', phone: '9876543210', upi_id: 'ravi@ybl' });
  assert.equal(rowWrites() - before, 1);

  const nothing = await store.setPayoutFields(RAVI, { phone: 'nope' });
  assert.equal(nothing.ok, false);
  assert.deepEqual(nothing.saved, []);
});

test('setPayoutFields keeps a waiting application\'s details current, and respects the lock after approval', async () => {
  const { book } = fresh();
  await store.setPayoutFields(RAVI, { legal_name: 'Ravi Kumar', email: 'ravi@gmail.com', phone: '9876543210', upi_id: 'ravi@okicici' });
  const applied = await store.createRequest(RAVI, 'news', store.contactDetails(await store.getInfluencer(501)));
  assert.equal(applied.ok, true);
  await store.setPayoutFields(RAVI, { upi_id: 'ravi@ybl', legal_name: 'Ravi K' });
  const [header, row] = book.Requests;
  assert.equal(row[header.indexOf('Details')], 'Name: Ravi K · Email: ravi@gmail.com · Mobile: 9876543210 · UPI: ravi@ybl');

  await store.approveRequest(applied.request.request_id, TERMS, 'Admin');
  const locked = await store.setPayoutFields(RAVI, { email: 'new@gmail.com', upi_id: 'ravi@okaxis' });
  assert.deepEqual(locked.saved, ['upi_id']);
  assert.match(locked.refused[0].reason, /cannot be changed once your application is approved/);
  assert.equal((await store.getInfluencer(501)).email, 'ravi@gmail.com');
});
