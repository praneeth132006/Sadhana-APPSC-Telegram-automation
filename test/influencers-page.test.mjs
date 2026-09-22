// ============================================================================
// The Influencers page, rendered for real (test/influencers-page.test.mjs)
// ============================================================================
// Runs the real dashboard/influencers.js — through the real shared.js, sign-in
// included — against a fake DOM and a fake API, reads back what ended up on
// the page, and clicks the buttons that decide things to see exactly what
// they send.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const CODE = {
  code: 'RAVI10', exam: 'upsc', exam_bot: 'TELEGRAM_PAYBOT_UPSC', telegram_id: '501', username: 'ravi_teaches',
  name: 'Ravi Kumar', discount_type: 'percent', discount_value: '10', commission_type: 'percent', commission_value: '20',
  payout_cycle: 'weekly', min_payout: '100', expires_on: '', max_uses: '', one_per_student: 'yes', status: 'active',
  share_link: 'https://t.me/prelimspaymentbot?start=promo_RAVI10', upi_id: 'ravi@okicici',
  stats: { uses: 2, revenuePaise: 35820, discountPaise: 3980, earnedPaise: 7164, availablePaise: 3582, requestedPaise: 3582, paidPaise: 0 }
};
const PAYLOAD = {
  status: { sheet: true, bot: true, adminChat: true, serviceAccount: 'sheets-bot@x.iam.gserviceaccount.com',
    sheetUrl: 'https://docs.google.com/spreadsheets/d/AFF/edit' },
  botUsername: 'influencer_bot',
  exams: [{ id: 'upsc', label: 'UPSC', pricePaise: 19900 }, { id: 'epfo', label: 'EPFO', pricePaise: 19900 }],
  influencers: [{ telegram_id: '501', upi_id: 'ravi@okicici' }],
  requests: [
    { request_id: 'REQ-20260922-AAAAAA', created_at: '22-09-2026', telegram_id: '777', username: 'priya_edu', name: 'Priya',
      exam: 'epfo', details: 'Instagram @priya_edu — 25k followers', status: 'pending', suggested_code: 'PRIYAEPFO42' },
    { request_id: 'REQ-20260920-BBBBBB', created_at: '20-09-2026', telegram_id: '501', username: 'ravi_teaches', name: 'Ravi Kumar',
      exam: 'upsc', details: 'YouTube', status: 'approved', code: 'RAVI10', decided_by: 'Admin', decided_at: '21-09-2026' }
  ],
  codes: [CODE],
  sales: [
    { sale_id: 'SALE-2', timestamp: '22-09-2026', code: 'RAVI10', exam: 'upsc', group: 'UPSC Prelims', student_id: '9002',
      student_name: 'Meena', student_username: 'meena', payment_id: 'pay_BBB', list_price_paise: 19900, discount_paise: 1990,
      paid_paise: 17910, commission_paise: 3582, status: 'requested', payout_id: 'WD-20260922-CCCCCC' },
    { sale_id: 'SALE-1', timestamp: '21-09-2026', code: 'RAVI10', exam: 'upsc', group: 'UPSC Prelims', student_id: '9001',
      student_name: 'Kiran', student_username: 'kiran', payment_id: 'pay_AAA', list_price_paise: 19900, discount_paise: 1990,
      paid_paise: 17910, commission_paise: 3582, status: 'earned', payout_id: '' }
  ],
  payouts: [{ payout_id: 'WD-20260922-CCCCCC', requested_at: '22-09-2026', code: 'RAVI10', exam: 'upsc', influencer_id: '501',
    username: 'ravi_teaches', name: 'Ravi Kumar', upi_id: 'ravi@okicici', amount_paise: 3582, sales: '1', status: 'requested' }],
  totals: { influencers: 2, pendingRequests: 1, activeCodes: 1, openPayouts: 1, uses: 2, revenuePaise: 35820,
    discountPaise: 3980, earnedPaise: 7164, availablePaise: 3582, requestedPaise: 3582, paidPaise: 0 }
};

/** A DOM just rich enough for the page: ids resolve to nodes, clicks dispatch. */
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.attributes = {}; this.dataset = {}; this.style = {};
      this.className = ''; this._text = ''; this.value = ''; this.listeners = {};
      this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    }
    append(...n) { this.children.push(...n); }
    appendChild(n) { this.children.push(n); return n; }
    prepend(...n) { this.children.unshift(...n); }
    insertBefore(n) { this.children.push(n); return n; }
    remove() {}
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') byId.set(v, this); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); }
    replaceChildren(...n) { this.children = n; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(v) { this._text = ''; this.children = []; }
    get parentNode() { return body; }
  }
  class Text extends Node { constructor(t) { super('#text'); this._text = String(t); } }
  const byId = new Map();
  const body = new Node('body');
  const document = {
    body, readyState: 'complete', title: '',
    createElement: (t) => new Node(t),
    createTextNode: (t) => new Text(t),
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, new Node('div')); return byId.get(id); },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  // The select boxes the page reads start at their first option.
  document.getElementById('examFilter').value = 'all';
  document.getElementById('searchInput').value = '';
  return { Node, document, byId };
}

/** Every node under `node`, depth first. */
function walk(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

async function renderPage(payload = PAYLOAD) {
  const dom = fakeDom();
  const posted = [];
  const fakeUser = { uid: 'u', email: 'a@b.c', displayName: 'Admin', getIdToken: async () => 't' };
  const answers = {
    '/api/groups': [{ id: 'appsc_news_en', label: 'News', shortName: 'News', displayName: 'News', ready: true }],
    '/api/affiliates': payload,
    '/api/config': { firebaseProjectId: 'p', authorizedDomains: ['localhost'] },
    '/api/ping': { status: 'ok' }
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URLSearchParams, URL, TextDecoder,
    Node: dom.Node, document: dom.document,
    localStorage: { store: { selectedGroup: 'appsc_news_en', 'dashboard.group': 'appsc_news_en' },
      getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; }, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => false,
    fetch: async (url, init = {}) => {
      const path = String(url).split('?')[0];
      if ((init.method || 'GET') === 'POST') {
        posted.push({ path, body: JSON.parse(init.body || '{}') });
        return { ok: true, status: 200, headers: { get: () => 'application/json' },
          json: async () => ({ success: true, message: 'ok' }) };
      }
      const data = answers[path];
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => (data === undefined ? { success: true, data: {} } : { success: true, data }) };
    },
    window: { location: { hostname: 'localhost', href: 'http://localhost/influencers.html?group=appsc_news_en',
      search: '?group=appsc_news_en', pathname: '/influencers.html', reload() {}, assign() {} },
      addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }
  });
  context.globalThis = context;

  const firebaseApp = new vm.SourceTextModule('export function initializeApp() { return {}; }',
    { identifier: 'firebase-app', context });
  // Signed in the moment anyone asks.
  const firebaseAuth = new vm.SourceTextModule(`
    export function getAuth() { return {}; }
    export function setPersistence() { return Promise.resolve(); }
    export const browserLocalPersistence = {};
    export function signInWithPopup() { return Promise.resolve({}); }
    export class GoogleAuthProvider { setCustomParameters() {} }
    export function signOut() { return Promise.resolve(); }
    export function onAuthStateChanged(auth, cb) { Promise.resolve().then(() => cb(globalThis.__user)); }
  `, { identifier: 'firebase-auth', context });
  context.__user = fakeUser;

  const modules = {};
  const load = (file) => new vm.SourceTextModule(fs.readFileSync(`dashboard/${file}`, 'utf8'),
    { identifier: file, context });
  modules['shared.js'] = load('shared.js');
  const page = load('influencers.js');
  const linker = (spec) => {
    if (spec.includes('firebase-app')) return firebaseApp;
    if (spec.includes('firebase-auth')) return firebaseAuth;
    if (spec.endsWith('shared.js')) return modules['shared.js'];
    throw new Error('unexpected import ' + spec);
  };
  await page.link(linker);
  await page.evaluate();

  // Let sign-in, the group check and the first load run to the end.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return { dom, posted };
}

const { dom, posted } = await renderPage();
const byId = (id) => dom.document.getElementById(id);
const body = () => byId('tabBody');
const button = (text) => walk(body()).find((n) => n.tagName === 'BUTTON' && n.textContent === text);
const openTab = (id) => byId(`tab-${id}`).click();
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test('the page opens on what needs a decision, with counts on every tab', () => {
  const tabs = byId('tabs').textContent;
  assert.match(tabs, /Applications1/);
  assert.match(tabs, /Withdrawals1/);
  assert.match(tabs, /Promo codes1/);
  assert.match(tabs, /Sales2/);
  assert.match(body().textContent, /Applications waiting/, 'the first view should be the waiting application');
  const alert = walk(byId('tabs')).filter((n) => /sp-tab-count alert/.test(n.className));
  assert.equal(alert.length, 2, 'applications and withdrawals waiting should be flagged');
});

test('the waiting application is on the page with who, which exam and where', () => {
  openTab('requests');
  const text = body().textContent;
  assert.match(text, /Priya \(@priya_edu\)/);
  assert.match(text, /777/);
  assert.match(text, /EPFO/);
  assert.match(text, /25k followers/);
  assert.doesNotMatch(text, /REQ-20260920-BBBBBB/, 'a decided application is listed as waiting');
});

test('approving sends the request id and every term, with the suggested code', async () => {
  openTab('requests');
  button('Approve…').click();
  const codeInput = walk(body()).find((n) => n.tagName === 'INPUT' && /pc-code-input/.test(n.className));
  assert.ok(codeInput, 'no approval form opened');
  assert.equal(codeInput.value, 'PRIYAEPFO42');
  assert.match(body().textContent, /the student pays .*₹179\.10.*the influencer earns .*₹35\.82/,
    'the live preview of one sale is missing');
  button('Approve and send the code').click();
  await settle();
  const sent = posted.find((p) => p.path === '/api/affiliates/approve');
  assert.ok(sent, 'nothing was sent');
  assert.equal(sent.body.requestId, 'REQ-20260922-AAAAAA');
  assert.deepEqual(Object.keys(sent.body.terms).sort(), ['code', 'commission_type', 'commission_value', 'discount_type',
    'discount_value', 'expires_on', 'max_uses', 'min_payout', 'note', 'one_per_student', 'payout_cycle'].sort());
  assert.equal(sent.body.terms.code, 'PRIYAEPFO42');
});

test('a withdrawal shows the UPI ID and amount, and marking it paid sends the reference', async () => {
  openTab('payouts');
  const text = body().textContent;
  assert.match(text, /ravi@okicici/);
  assert.match(text, /₹35\.82/);
  button('Mark paid…').click();
  byId('pay-WD-20260922-CCCCCC').value = 'UTR412345678901';
  button('I have sent ₹35.82 — mark paid').click();
  await settle();
  const sent = posted.find((p) => p.path === '/api/affiliates/payout');
  assert.deepEqual(sent.body, { payoutId: 'WD-20260922-CCCCCC', decision: 'paid', reference: 'UTR412345678901', reason: '' });
});

test('each code shows its terms and what is owed, and opens into its sales', () => {
  openTab('codes');
  const text = body().textContent;
  assert.match(text, /RAVI10/);
  assert.match(text, /10% off/);
  assert.match(text, /20% of paid/);
  assert.match(text, /min ₹100/);
  assert.match(text, /₹71\.64/, 'owed = available + requested');
  const row = walk(body()).find((n) => n.tagName === 'TR' && /inf-row/.test(n.className));
  row.click();
  assert.match(body().textContent, /pay_AAA/);
  assert.match(body().textContent, /t\.me\/prelimspaymentbot\?start=promo_RAVI10/);
});

test('every sale is listed with both sides\' ids and the money', () => {
  openTab('sales');
  const text = body().textContent;
  for (const s of ['pay_AAA', 'pay_BBB', '9001', '9002', '₹179.10', '₹35.82', 'SALE-1', 'WD-20260922-CCCCCC']) {
    assert.ok(text.includes(s), `${s} is missing from the sales table`);
  }
});

test('the search box narrows whichever section is open', () => {
  openTab('sales');
  byId('searchInput').value = 'meena';
  (byId('searchInput').listeners.input || []).forEach((fn) => fn({}));
  const text = body().textContent;
  assert.ok(text.includes('pay_BBB'));
  assert.ok(!text.includes('pay_AAA'), 'the search did not filter');
  byId('searchInput').value = '';
  (byId('searchInput').listeners.input || []).forEach((fn) => fn({}));
});

test('the headline numbers and the history are on the page', () => {
  assert.match(byId('statGrid').textContent, /Applications Waiting/);
  assert.match(byId('statGrid').textContent, /₹358\.20/);
  openTab('history');
  assert.match(body().textContent, /Approved → RAVI10/);
});

test('before the sheet exists, the page says exactly what to set up, as banners', async () => {
  const { dom: empty } = await renderPage({
    status: { sheet: false, bot: false, adminChat: false, serviceAccount: 'sheets-bot@x.iam.gserviceaccount.com' },
    notReady: true
  });
  const text = empty.document.getElementById('notices').textContent;
  assert.match(text, /sheets-bot@x\.iam\.gserviceaccount\.com/);
  assert.match(text, /AFFILIATE_SHEET_ID/);
  assert.match(text, /TELEGRAM_AFFILIATE_BOT/);
  assert.match(empty.document.getElementById('tabBody').textContent, /not set up yet/);
});
