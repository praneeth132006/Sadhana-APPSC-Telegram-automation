// ============================================================================
// The Code Tracking page, rendered for real (test/tracking-page.test.mjs)
// ============================================================================
// Runs the real dashboard/tracking.js — through the real shared.js, sign-in
// included — against a fake DOM and a fake API, then reads back what ended up
// on the page and clicks what an admin would click.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ROWS = [
  { code: 'AD10', kind: 'coupon', student_id: '9001', username: 'kiran', name: 'Kiran Rao', group: 'UPSC Prelims', source: 'link',
    stage: 'link_expired', stage_label: 'Payment link expired — did not pay', clicked_at: '22-09-2026, 10:00:00 AM IST', clicks: '2',
    applied_at: '22-09-2026, 10:01:00 AM IST', link_created_at: '22-09-2026, 10:02:00 AM IST', links_created: '2', amount: '189',
    link_status: 'expired', failed_attempts: '1', last_activity: '22-09-2026, 10:02:00 AM IST' },
  { code: 'AD10', kind: 'coupon', student_id: '9002', username: 'meena', name: 'Meena', source: 'link',
    stage: 'paid', stage_label: 'Paid', clicked_at: '22-09-2026, 09:00:00 AM IST', clicks: '1',
    applied_at: '22-09-2026, 09:01:00 AM IST', link_created_at: '22-09-2026, 09:02:00 AM IST', links_created: '1', amount: '189',
    paid_at: '22-09-2026, 09:03:00 AM IST', paid_amount: '189', payment_id: 'pay_AAA', last_activity: '22-09-2026, 09:03:00 AM IST' },
  { code: 'AD10', kind: 'coupon', student_id: '9003', username: '', name: '=HYPERLINK("x")', source: 'link',
    stage: 'clicked', stage_label: 'Clicked link only', clicked_at: '22-09-2026, 08:00:00 AM IST', clicks: '1',
    last_activity: '22-09-2026, 08:00:00 AM IST' },
  { code: 'AD10', kind: 'coupon', student_id: '9004', username: 'sai', name: 'Sai', source: 'typed',
    stage: 'paid_unrecorded', stage_label: 'Paid on Razorpay — not recorded', applied_at: '22-09-2026, 07:00:00 AM IST',
    link_created_at: '22-09-2026, 07:01:00 AM IST', links_created: '1', amount: '189', link_status: 'paid',
    last_activity: '22-09-2026, 07:01:00 AM IST' },
  { code: 'AD10', kind: 'coupon', student_id: '9005', username: 'ravi', name: 'Ravi', source: 'typed',
    stage: 'refused', stage_label: 'Code refused', refused_at: '22-09-2026, 06:00:00 AM IST',
    refused_reason: 'You have already used that coupon code.', last_activity: '22-09-2026, 06:00:00 AM IST' }
];
const TOTALS = { people: 5, clicked: 3, clicks: 4, applied: 3, refused: 1, linkCreated: 3, links: 4, paid: 1, notPaid: 1,
  pending: 0, expired: 1, unrecorded: 1, appliedNoLink: 0, clickedOnly: 1, revenue: 189, fromLink: 3, typed: 2, conversion: 20 };
const CODES = [
  Object.assign({ code: 'AD10', kind: 'coupon' }, TOTALS),
  { code: 'NEWAD', kind: 'coupon', people: 0, clicked: 0, applied: 0, linkCreated: 0, paid: 0, notPaid: 0, revenue: 0, conversion: 0 }
];

function payloadFor(code) {
  return {
    context: { groupId: 'upsc', primaryGroupId: 'upsc', primaryGroupName: 'UPSC Prelims', isPrimary: true },
    configured: true,
    botUsername: 'prelimspaymentbot',
    linkBase: 'https://t.me/prelimspaymentbot?start=promo_',
    code: code || '',
    codes: CODES,
    totals: TOTALS,
    rows: code && code !== 'AD10' ? [] : ROWS
  };
}

/** A DOM just rich enough for the page: ids resolve to nodes, clicks dispatch. */
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.attributes = {}; this.dataset = {}; this.style = {};
      this.className = ''; this._text = ''; this.value = ''; this.listeners = {}; this.disabled = false;
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
    dispatch(type) { (this.listeners[type] || []).forEach((fn) => fn({ stopPropagation() {}, preventDefault() {} })); }
    click() { this.dispatch('click'); }
    replaceChildren(...n) { this.children = n; }
    scrollIntoView() {}
    focus() {}
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
  return { Node, document, byId };
}

function walk(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

async function renderPage({ search = '?group=upsc', payload = payloadFor } = {}) {
  const dom = fakeDom();
  const gets = [];
  const posted = [];
  const copied = [];
  const files = [];
  const fakeUser = { uid: 'u', email: 'a@b.c', displayName: 'Admin', getIdToken: async () => 't' };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, URLSearchParams, URL: Object.assign(function () {}, {
      createObjectURL: (blob) => { files.push(blob); return 'blob:x'; }
    }), TextDecoder,
    Blob: class { constructor(parts, opts) { this.text = parts.join(''); this.type = opts && opts.type; } },
    Node: dom.Node, document: dom.document,
    localStorage: { store: { selectedGroup: 'upsc', 'dashboard.group': 'upsc' },
      getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; }, removeItem() {} },
    navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
    confirm: () => false,
    fetch: async (url, init = {}) => {
      const u = new URL(String(url), 'http://localhost');
      if ((init.method || 'GET') === 'POST') {
        posted.push({ path: u.pathname, query: u.search, body: JSON.parse(init.body || '{}') });
        return { ok: true, status: 200, headers: { get: () => 'application/json' },
          json: async () => ({ success: true, data: { checked: 3, changed: 1, failed: 0, remaining: 0, unrecorded: [{ link_id: 'p' }] } }) };
      }
      gets.push(u.pathname + u.search);
      const answers = {
        '/api/groups': [{ id: 'upsc', label: 'UPSC', shortName: 'UPSC Prelims', displayName: 'UPSC', ready: true }],
        '/api/config': { firebaseProjectId: 'p', authorizedDomains: ['localhost'] },
        '/api/ping': { status: 'ok' }
      };
      const data = u.pathname === '/api/pricing/tracking' ? payload(u.searchParams.get('code') || '') : answers[u.pathname];
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => (data === undefined ? { success: true, data: {} } : { success: true, data }) };
    },
    window: { location: { hostname: 'localhost', href: 'http://localhost/tracking.html' + search,
      search, pathname: '/tracking.html', reload() {}, assign() {} },
      addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }
  });
  context.globalThis = context;

  const firebaseApp = new vm.SourceTextModule('export function initializeApp() { return {}; }', { identifier: 'firebase-app', context });
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

  const shared = new vm.SourceTextModule(fs.readFileSync('dashboard/shared.js', 'utf8'), { identifier: 'shared.js', context });
  const page = new vm.SourceTextModule(fs.readFileSync('dashboard/tracking.js', 'utf8'), { identifier: 'tracking.js', context });
  const linker = (spec) => {
    if (spec.includes('firebase-app')) return firebaseApp;
    if (spec.includes('firebase-auth')) return firebaseAuth;
    if (spec.endsWith('shared.js')) return shared;
    throw new Error('unexpected import ' + spec);
  };
  await page.link(linker);
  await page.evaluate();
  const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  const byId = (id) => dom.document.getElementById(id);
  return { dom, byId, gets, posted, copied, files, settle };
}

const trackingGets = (gets) => gets.filter((g) => g.startsWith('/api/pricing/tracking'));

test('the page loads every code, with the group on the request and no broken query string', async () => {
  const { gets } = await renderPage();
  const [first] = trackingGets(gets);
  assert.equal(first, '/api/pricing/tracking?group=upsc');
});

test('the funnel shows every step, with who did not pay called out', async () => {
  const { byId } = await renderPage();
  const text = byId('summaryPanel').textContent;
  for (const bit of ['People', 'Clicked the link', 'Applied the code', 'Made a payment link', 'Paid', 'Made a link, did not pay']) {
    assert.match(text, new RegExp(bit), `${bit} is missing`);
  }
  assert.match(text, /₹189 · 20% of people/);
  assert.match(text, /3 from the link · 2 typed/);
  assert.match(text, /0 link\(s\) still open · 1 expired/);
  assert.match(text, /1 paid on Razorpay but were never recorded/);
});

test('with every code on show, a table compares them, and a click opens one', async () => {
  const { byId, gets, settle } = await renderPage();
  const table = byId('codeTable');
  assert.match(table.textContent, /AD10/);
  assert.match(table.textContent, /NEWAD/);
  const row = walk(table).find((n) => n.tagName === 'TR' && /NEWAD/.test(n.textContent) && n.listeners.click);
  row.click();
  await settle();
  assert.equal(trackingGets(gets).at(-1), '/api/pricing/tracking?code=NEWAD&group=upsc');
  assert.match(byId('peoplePanel').textContent, /Nobody has used this code yet/);
});

test('one code shows its ad link, ready to copy', async () => {
  const { byId, copied, gets } = await renderPage({ search: '?group=upsc&code=ad10' });
  assert.equal(trackingGets(gets)[0], '/api/pricing/tracking?code=AD10&group=upsc', 'the Track button\'s code was not used');
  assert.equal(byId('adLink').textContent, 'https://t.me/prelimspaymentbot?start=promo_AD10');
  byId('copyLinkBtn').click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(copied, ['https://t.me/prelimspaymentbot?start=promo_AD10']);
});

test('the people table says where each person got to, and how', async () => {
  const { byId } = await renderPage();
  const text = byId('peopleTable').textContent;
  assert.match(text, /Kiran Rao/);
  assert.match(text, /@kiran/);
  assert.match(text, /9001/);
  assert.match(text, /Payment link expired — did not pay/);
  assert.match(text, /₹189 · 2 links/);
  assert.match(text, /1 failed payment attempt/);
  assert.match(text, /2 clicks/);
  assert.match(text, /pay_AAA/);
  assert.match(text, /🔗 Link/);
  assert.match(text, /⌨️ Typed/);
  assert.match(text, /You have already used that coupon code/, 'a refused code shows why');
  assert.match(text, /Paid on Razorpay — not recorded/);
});

test('the tabs filter the people, with counts, and "did not pay" is flagged', async () => {
  const { byId } = await renderPage();
  const tabs = byId('viewTabs').textContent;
  assert.match(tabs, /Everyone5/);
  assert.match(tabs, /Made a link, did not pay2/);
  assert.match(tabs, /Paid1/);
  assert.match(tabs, /Clicked only1/);
  assert.match(tabs, /Code refused1/);

  byId('view-unpaid').click();
  let text = byId('peopleTable').textContent;
  assert.match(text, /Kiran Rao/);
  assert.match(text, /Sai/);
  assert.doesNotMatch(text, /Meena/);

  byId('view-paid').click();
  text = byId('peopleTable').textContent;
  assert.match(text, /Meena/);
  assert.doesNotMatch(text, /Kiran/);

  byId('view-applied').click();
  assert.match(byId('peoplePanel').textContent, /Nobody matches this filter/);
});

test('search finds people by name, @username or Telegram ID', async () => {
  const { byId } = await renderPage();
  const find = byId('searchInput');
  for (const [query, who] of [['meena', 'Meena'], ['@kiran', 'Kiran Rao'], ['9005', 'Ravi']]) {
    byId('view-all').click();
    find.value = query;
    find.dispatch('input');
    const rows = walk(byId('peopleTable')).filter((n) => n.className === 'tr-person');
    assert.equal(rows.length, 1, `"${query}" matched ${rows.length} rows`);
    assert.match(rows[0].textContent, new RegExp(who));
  }
  find.value = '';
  find.dispatch('input');
});

test('Check with Razorpay asks for the chosen code and reloads', async () => {
  const { byId, posted, gets, settle } = await renderPage({ search: '?group=upsc&code=AD10' });
  const before = trackingGets(gets).length;
  byId('checkBtn').click();
  await settle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].path, '/api/pricing/tracking/refresh');
  assert.equal(posted[0].query, '?group=upsc');
  assert.deepEqual(posted[0].body, { code: 'AD10' });
  assert.equal(trackingGets(gets).length, before + 1, 'the page did not reload after checking');
});

test('the CSV download has every column, and cannot run a formula in a spreadsheet', async () => {
  const { byId, files } = await renderPage();
  byId('view-all').click();
  const csvButton = walk(byId('peoplePanel')).find((n) => n.attributes.id === 'csvBtn');
  csvButton.click();
  assert.equal(files.length, 1);
  const csv = files[0].text;
  const [header, ...lines] = csv.split('\n');
  assert.match(header, /^Name,Username,Telegram ID,Code,Group,Came from,Stage/);
  assert.equal(lines.length, 5);
  assert.match(csv, /Kiran Rao,kiran,9001,AD10/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/, 'a name starting with = must be neutralised');
});

test('a bot without tracking set up says what is missing', async () => {
  const { byId } = await renderPage({
    payload: () => ({ context: { isPrimary: true }, configured: false, codes: [], rows: [], totals: TOTALS })
  });
  assert.match(byId('notices').textContent, /Tracking is not set up for this bot/);
  assert.match(byId('notices').textContent, /SHEET_ID/);
});

test('the Code Tracking page is on the nav bar, next to Pass & Coupons', () => {
  const shared = fs.readFileSync('dashboard/shared.js', 'utf8');
  const pricing = shared.indexOf("id: 'pricing'");
  const tracking = shared.indexOf("id: 'tracking'");
  assert.ok(tracking > pricing && tracking - pricing < 300, 'Code Tracking is not listed right after Pass & Coupons');
  assert.match(fs.readFileSync('dashboard/pricing.js', 'utf8'), /tracking\.html\?code=\$\{encodeURIComponent\(c\.code\)\}/,
    'each coupon should have a Track button');
});
