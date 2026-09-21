// ============================================================================
// The Referrals page, rendered for real (test/referrals-page.test.mjs)
// ============================================================================
// The page once rendered a header cell and no rows, and the only check made
// at the time injected hand-written HTML instead of running the page's code.
// This runs the real dashboard/referrals.js — through the real shared.js,
// sign-in included — against a fake DOM and a fake API, and reads back what
// ended up on the page.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const PAYLOAD = {
  settings: { enabled: true, discountPercent: 10, commissionPercent: 20, payoutThresholdPaise: 100000 },
  totals: { joined: 2, revenuePaise: 35820, discountPaise: 3980, pendingPaise: 3582, paidPaise: 3582,
    linkOpens: 3, activeReferrers: 1 },
  due: [],
  codes: [{
    code: 'REFAJMXPQ', telegramId: '7234356929', username: 'asha', name: 'Asha K', status: 'active',
    createdAt: '19-09-2026, 10:00:00 AM IST', shareLink: 'https://t.me/bot?start=ref_REFAJMXPQ',
    joined: 2, pendingPaise: 3582, paidPaise: 3582, totalPaise: 7164, payable: false,
    lastJoinedAt: '21-09-2026, 11:30:00 AM IST', linkOpens: 3,
    openedBy: [{ telegramId: '5550001', joined: true }, { telegramId: '5550002', joined: true },
      { telegramId: '5550003', joined: false }],
    joins: [
      { referralId: 'RL-0001', at: '20-09-2026', telegramId: '5550001', username: 'ravi', name: 'Ravi T',
        group: 'Newspaper · English', plan: 'lifetime_pass', paymentId: 'pay_AAA', originalPaise: 19900,
        discountPaise: 1990, paidPaise: 17910, commissionPaise: 3582, status: 'paid', paidAt: '21-09-2026' },
      { referralId: 'RL-0002', at: '21-09-2026', telegramId: '5550002', username: 'meena', name: 'Meena',
        group: 'Newspaper · Telugu', plan: 'lifetime_pass', paymentId: 'pay_BBB', originalPaise: 19900,
        discountPaise: 1990, paidPaise: 17910, commissionPaise: 3582, status: 'pending', paidAt: '' }
    ]
  }],
  earnings: [
    { referral_id: 'RL-0002', timestamp: '21-09-2026', code: 'REFAJMXPQ', referrer_telegram_id: '7234356929',
      referrer_username: 'asha', referrer_name: 'Asha K', referred_telegram_id: '5550002',
      referred_username: 'meena', referred_name: 'Meena', group: 'Newspaper · Telugu', payment_id: 'pay_BBB',
      paid_paise: 17910, commission_paise: 3582, status: 'pending' },
    { referral_id: 'RL-0001', timestamp: '20-09-2026', code: 'REFAJMXPQ', referrer_telegram_id: '7234356929',
      referrer_username: 'asha', referrer_name: 'Asha K', referred_telegram_id: '5550001',
      referred_username: 'ravi', referred_name: 'Ravi T', group: 'Newspaper · English', payment_id: 'pay_AAA',
      paid_paise: 17910, commission_paise: 3582, status: 'paid' }
  ]
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
  document.getElementById('codeFilter').value = 'all';
  document.getElementById('joinStatus').value = 'all';
  document.getElementById('joinGroup').value = 'all';
  return { Node, document, byId };
}

/** Every node under `node`, depth first. */
function walk(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

async function renderPage() {
  const dom = fakeDom();
  const fakeUser = { uid: 'u', email: 'a@b.c', displayName: 'Admin', getIdToken: async () => 't' };
  const answers = {
    '/api/groups': [{ id: 'appsc_news_en', label: 'News', shortName: 'News', displayName: 'News', ready: true }],
    '/api/referrals': PAYLOAD,
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
    fetch: async (url) => {
      const path = String(url).split('?')[0];
      const data = answers[path];
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => (data === undefined ? { success: true, data: {} } : { success: true, data }) };
    },
    window: { location: { hostname: 'localhost', href: 'http://localhost/referrals.html?group=appsc_news_en',
      search: '?group=appsc_news_en', pathname: '/referrals.html', reload() {}, assign() {} },
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
  const page = load('referrals.js');
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
  return dom;
}

const dom = await renderPage();
const area = (id) => dom.document.getElementById(id);
const rowsIn = (id) => walk(area(id)).filter((n) => n.tagName === 'TR');

test('the referrer table has a header and a row per referrer', () => {
  const rows = rowsIn('codesArea');
  assert.ok(rows.length >= 2, `expected a header and a referrer row, found ${rows.length} row(s)`);
  assert.match(area('codesArea').textContent, /REFAJMXPQ/);
  assert.match(area('codesArea').textContent, /7234356929/, 'the referrer\'s Telegram id is not on the page');
});

test('every referred payment is its own row, with both sides\' Telegram ids', () => {
  const text = area('joinsArea').textContent;
  assert.equal(rowsIn('joinsArea').length, 3, 'expected a header and two payment rows');
  for (const id of ['7234356929', '5550001', '5550002', 'pay_AAA', 'pay_BBB', 'RL-0001', 'RL-0002']) {
    assert.match(text, new RegExp(id), `${id} is missing from the payments table`);
  }
});

test('opening a referrer shows everyone who joined and who opened the link', () => {
  const row = rowsIn('codesArea').find((r) => /REFAJMXPQ/.test(r.textContent) && r.className.includes('ref-row'));
  assert.ok(row, 'no clickable referrer row');
  row.click();
  const text = area('codesArea').textContent;
  assert.match(text, /Joined using REFAJMXPQ \(2\)/);
  assert.match(text, /Ravi T \(@ravi\)/);
  assert.match(text, /Meena \(@meena\)/);
  assert.match(text, /Opened the link \(3\)/);
  assert.match(text, /5550003/, 'someone who opened but did not pay is not listed');
  assert.match(text, /lifetime_pass/);
});

test('the headline numbers are on the page', () => {
  const text = area('statGrid').textContent;
  assert.match(text, /Link Opens/);
  assert.match(text, /₹358\.20/, 'revenue from referrals is missing');
});
