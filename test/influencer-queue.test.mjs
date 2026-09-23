// ============================================================================
// Withdrawals and applications waiting, on every page (test/influencer-queue.test.mjs)
// ============================================================================
// When an influencer asks to be paid, the admin should know from whichever
// dashboard page is open — not only by visiting Influencers. These render real
// pages (through the real shared.js) against a fake DOM and a fake API, and
// check the Influencers badge, the banner, the link straight to Withdrawals,
// and the pop-up when a new withdrawal arrives while a page is open.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const QUEUE = {
  configured: true, requests: 1, payouts: 2, payoutPaise: 5382,
  latestPayouts: [
    { payout_id: 'WD-2', requested_at: '23-09-2026, 10:15:00 AM IST', name: 'Ravi Kumar', username: 'ravi', code: 'RAVI10', amount_paise: 3582 },
    { payout_id: 'WD-1', requested_at: '22-09-2026, 09:00:00 AM IST', name: 'Priya', username: 'priya', code: 'PRIYA5', amount_paise: 1800 }
  ]
};

function fakeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.attributes = {}; this.dataset = {}; this.style = {};
      this.className = ''; this._text = ''; this.value = ''; this.listeners = {}; this.parent = null;
      this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    }
    append(...n) { n.forEach((c) => { if (c && typeof c === 'object') c.parent = this; }); this.children.push(...n); }
    appendChild(n) { this.append(n); return n; }
    prepend(...n) { this.children.unshift(...n); }
    insertBefore(n) { this.append(n); return n; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') byId.set(v, this); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); }
    replaceChildren(...n) { this.children = []; this.append(...n); }
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
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  // The page's own containers, as its HTML would have them.
  for (const id of ['pageRoot', 'notices', 'controlPanel', 'summaryPanel', 'peoplePanel', 'refreshBtn', 'checkBtn',
    'botBadge', 'helpBtn', 'sheetLink', 'exportBtn', 'statGrid', 'howItWorks', 'tabs', 'tabBody', 'examFilter', 'searchInput']) {
    const node = new Node('div');
    node.setAttribute('id', id);
    body.append(node);
  }
  return { Node, document, byId, body };
}

function walk(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => walk(c, out));
  return out;
}

async function renderPage(file, { queue = QUEUE, search = '?group=upsc' } = {}) {
  const dom = fakeDom();
  let answer = queue;
  const timers = [];
  const pageName = file.replace('.js', '');
  const fakeUser = { uid: 'u', email: 'a@b.c', displayName: 'Admin', getIdToken: async () => 't' };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    // Toasts linger for seconds; nothing here needs to wait for them.
    setTimeout: (fn, ms) => (ms > 1000 ? 0 : setTimeout(fn, ms)), clearTimeout,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
    URLSearchParams, URL, TextDecoder,
    Node: dom.Node, document: dom.document,
    localStorage: { store: { selectedGroup: 'upsc', 'dashboard.group': 'upsc' },
      getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; }, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => false,
    fetch: async (url) => {
      const u = new URL(String(url), 'http://localhost');
      const answers = {
        '/api/groups': [{ id: 'upsc', label: 'UPSC', shortName: 'UPSC Prelims', displayName: 'UPSC', ready: true }],
        '/api/config': { firebaseProjectId: 'p', authorizedDomains: ['localhost'] },
        '/api/affiliates/pending': answer,
        '/api/affiliates': { status: { sheet: true }, influencers: [], requests: [], codes: [], sales: [], payouts: [], totals: {} },
        '/api/pricing/tracking': { context: { isPrimary: true }, configured: true, codes: [], rows: [],
          totals: { people: 0, clicked: 0, clicks: 0, applied: 0, linkCreated: 0, links: 0, paid: 0, notPaid: 0, pending: 0,
            expired: 0, unrecorded: 0, revenue: 0, fromLink: 0, typed: 0, conversion: 0 } }
      };
      const data = answers[u.pathname];
      return { ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => (data === undefined ? { success: true, data: {} } : { success: true, data }) };
    },
    window: { location: { hostname: 'localhost', href: `http://localhost/${pageName}.html${search}`,
      search, pathname: `/${pageName}.html`, reload() {}, assign() {} },
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
  const page = new vm.SourceTextModule(fs.readFileSync(`dashboard/${file}`, 'utf8'), { identifier: file, context });
  await page.link((spec) => {
    if (spec.includes('firebase-app')) return firebaseApp;
    if (spec.includes('firebase-auth')) return firebaseAuth;
    if (spec.endsWith('shared.js')) return shared;
    throw new Error('unexpected import ' + spec);
  });
  await page.evaluate();
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await settle();

  const byId = (id) => dom.byId.get(id) || null;
  // Only this feature's pop-ups: the fake server's config raises its own.
  const toasts = () => walk(dom.body).filter((n) => /^toast /.test(n.className))
    .map((n) => n.textContent).filter((t) => /withdrawal/i.test(t));
  const poll = async (next) => {
    answer = next;
    const timer = timers.find((t) => t.ms === 60000);
    assert.ok(timer, 'the page does not keep checking for new withdrawals');
    await timer.fn();
    await settle();
  };
  return { dom, byId, toasts, poll, timers };
}

test('on any page, a waiting withdrawal shows as a badge and a banner, with a link straight to it', async () => {
  const { byId } = await renderPage('tracking.js');
  const badge = byId('navInfluencersBadge');
  assert.ok(badge, 'no badge on the Influencers link');
  assert.equal(badge.textContent, '3', 'two withdrawals and one application');
  assert.match(byId('nav-influencers').getAttribute('title'), /2 withdrawals to pay \(₹53\.82\) · 1 application to decide/);

  const banner = byId('influencerQueueBanner').textContent;
  assert.match(banner, /Influencer withdrawal requested/);
  assert.match(banner, /2 withdrawals to pay \(₹53\.82\)/);
  assert.match(banner, /1 application to decide/);
  assert.match(banner, /Latest: Ravi Kumar \(RAVI10\) — ₹35\.82, 23-09-2026, 10:15:00 AM/);
  assert.equal(byId('queuePayoutsLink').getAttribute('href'), 'influencers.html?group=upsc&tab=payouts');
  assert.equal(byId('queueRequestsLink').getAttribute('href'), 'influencers.html?group=upsc&tab=requests');
});

test('with only an application waiting, the banner says so and links to Applications', async () => {
  const { byId } = await renderPage('tracking.js', { queue: { configured: true, requests: 2, payouts: 0, payoutPaise: 0, latestPayouts: [] } });
  assert.equal(byId('navInfluencersBadge').textContent, '2');
  const banner = byId('influencerQueueBanner').textContent;
  assert.match(banner, /Influencer application waiting/);
  assert.match(banner, /2 applications to decide/);
  assert.equal(byId('queuePayoutsLink'), null);
  assert.ok(byId('queueRequestsLink'));
});

test('nothing waiting: no badge, no banner', async () => {
  const { byId } = await renderPage('tracking.js', { queue: { configured: true, requests: 0, payouts: 0, payoutPaise: 0, latestPayouts: [] } });
  const badge = byId('navInfluencersBadge');
  assert.equal(badge.textContent, '');
  assert.equal(badge.style.display, 'none');
  assert.equal(byId('influencerQueueBanner').textContent, '');
});

test('without the influencer sheet, pages show nothing about it', async () => {
  const { byId } = await renderPage('tracking.js', { queue: { configured: false } });
  assert.equal(byId('navInfluencersBadge'), null);
  assert.equal(byId('influencerQueueBanner'), null);
});

test('a withdrawal requested while a page is open pops up, once', async () => {
  const { toasts, poll, byId } = await renderPage('tracking.js');
  assert.equal(toasts().length, 0, 'what was already waiting at load is not "new"');

  const newer = JSON.parse(JSON.stringify(QUEUE));
  newer.payouts = 3;
  newer.payoutPaise = 7382;
  newer.latestPayouts.unshift({ payout_id: 'WD-3', requested_at: '23-09-2026, 11:00:00 AM IST', name: 'Sai', code: 'SAI20', amount_paise: 2000 });
  await poll(newer);
  assert.equal(toasts().length, 1);
  assert.match(toasts()[0], /New withdrawal request: Sai — ₹20 \(SAI20\)/);
  assert.equal(byId('navInfluencersBadge').textContent, '4');

  await poll(newer);
  assert.equal(toasts().length, 1, 'the same withdrawal popped up twice');
});

test('the check repeats every minute', async () => {
  const { timers } = await renderPage('tracking.js');
  assert.equal(timers.filter((t) => t.ms === 60000).length, 1);
});

test('the Influencers page gets the badge but not the banner, and opens on Withdrawals from the link', async () => {
  const { byId } = await renderPage('influencers.js', { search: '?group=upsc&tab=payouts' });
  assert.equal(byId('navInfluencersBadge').textContent, '3');
  assert.equal(byId('influencerQueueBanner').textContent, '', 'its own tabs already say it');
  const active = walk(byId('tabs')).find((n) => /sp-tab\b.*active|active.*sp-tab/.test(n.className));
  assert.ok(active, 'no tab is active');
  assert.match(active.textContent, /Withdrawals/);
});
