// ============================================================================
// Shared pages once per bot, and the Members pie charts (test/dashboard-family.test.mjs)
// ============================================================================
// Renders real dashboard pages (through the real shared.js) against a fake DOM
// and a fake API. Pass & Coupons, Code Tracking, Influencers and Support are
// the same for English and Telugu, so their switcher offers one entry per
// payment bot; the Members page draws its analysis as labelled pie charts.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const GROUPS = [
  { id: 'appsc_news_en', label: 'APPSC Newspaper', language: 'English', shortName: 'Newspaper · English', displayName: 'APPSC Newspaper (English)', paymentBotEnv: 'TELEGRAM_PAYBOT_NEWS', ready: true },
  { id: 'appsc_news_te', label: 'APPSC Newspaper', language: 'Telugu', shortName: 'Newspaper · Telugu', displayName: 'APPSC Newspaper (Telugu)', paymentBotEnv: 'TELEGRAM_PAYBOT_NEWS', ready: true },
  { id: 'upsc', label: 'UPSC', language: 'English', shortName: 'UPSC Prelims', displayName: 'UPSC Prelims', paymentBotEnv: 'TELEGRAM_PAYBOT_UPSC', ready: true }
];

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
    createElementNS: (ns, t) => new Node(t),
    createTextNode: (t) => new Text(t),
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}
  };
  // The page's own containers, as its HTML would have them.
  for (const id of ['pageRoot', 'notices', 'controlPanel', 'summaryPanel', 'peoplePanel', 'refreshBtn', 'checkBtn',
    'botBadge', 'helpBtn', 'sheetLink', 'exportBtn', 'statGrid', 'howItWorks', 'tabs', 'tabBody', 'examFilter', 'searchInput',
    'panels', 'dryRunBtn', 'modeBadge', 'passPanel', 'couponPanel', 'redemptionPanel']) {
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

async function renderPage(file, { search = '?group=appsc_news_te', answers: extra = {} } = {}) {
  const dom = fakeDom();
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
    localStorage: { store: { 'sadhana.selectedGroup': 'appsc_news_te' },
      getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = v; }, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    confirm: () => false,
    fetch: async (url) => {
      const u = new URL(String(url), 'http://localhost');
      const answers = Object.assign({
        '/api/groups': GROUPS,
        '/api/config': { firebaseProjectId: 'p', authorizedDomains: ['localhost'] },
        '/api/affiliates/pending': { configured: false }
      }, extra);
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
  return { dom, byId, timers };
}


const options = (byId) => byId('groupSelect').children.filter((n) => n.tagName === 'OPTION');

test('Pass & Coupons, Code Tracking, Influencers and Support: one switcher entry per bot, English & Telugu together', async () => {
  for (const file of ['pricing.js', 'tracking.js', 'influencers.js', 'support.js']) {
    const { byId } = await renderPage(file);
    const opts = options(byId);
    assert.deepEqual(opts.map((o) => o.textContent), ['APPSC Newspaper — English & Telugu', 'UPSC Prelims'], file);
    assert.equal(opts[0].value, 'appsc_news_en', `${file}: the bot's data lives in its first group`);
    assert.equal(opts[0].selected, true, `${file}: viewing Telugu must select the Newspaper entry`);
    assert.match(byId('groupSwitcher').textContent, /^Showing/, file);
  }
});

test('the shared pages no longer warn about a "shared bot"', async () => {
  for (const file of ['pricing.js', 'tracking.js']) {
    const { dom } = await renderPage(file, { answers: {
      '/api/pricing': { context: { isPrimary: false, primaryGroupName: 'Newspaper · English' }, coupons: [], redemptions: {}, passSettings: {} },
      '/api/pricing/tracking': { context: { isPrimary: false, primaryGroupName: 'Newspaper · English' }, configured: true, codes: [], rows: [],
        totals: { people: 0, clicked: 0, clicks: 0, applied: 0, linkCreated: 0, links: 0, paid: 0, notPaid: 0, pending: 0, expired: 0, unrecorded: 0, revenue: 0, fromLink: 0, typed: 0, conversion: 0 } }
    } });
    assert.doesNotMatch(dom.body.textContent, /Shared bot/, file);
  }
});

test('per-language pages keep one entry per group', async () => {
  const { byId } = await renderPage('members.js', { answers: { '/api/members/analysis': null } });
  assert.deepEqual(options(byId).map((o) => o.textContent), ['Newspaper · English', 'Newspaper · Telugu', 'UPSC Prelims']);
  assert.equal(options(byId)[1].selected, true);
  assert.match(byId('groupSwitcher').textContent, /^Posting to/);
});

const ANALYSIS = {
  totals: { members: 10, active: 5, paying: 9, revenue: 1776.1, averagePaid: 197.34, discountGiven: 19.9, previews: 1, joinedLast30Days: 8 },
  status: [{ key: 'active', label: 'Active — has access', count: 5, percent: 50 }, { key: 'expired', label: 'Expired', count: 3, percent: 30 },
    { key: 'removed', label: 'Removed from the group', count: 2, percent: 20 }],
  passes: [{ key: 'exam_pass', label: 'Target 2026 Pass', count: 9, percent: 90 }, { key: 'lifetime_pass', label: 'Lifetime', count: 1, percent: 10 }],
  revenueByPass: [{ key: 'exam_pass', label: 'Target 2026 Pass', count: 1577.1, value: 1577.1, members: 9, percent: 88.8 },
    { key: 'lifetime_pass', label: 'Lifetime', count: 199, value: 199, members: 1, percent: 11.2 }],
  price: [{ key: 'full', label: 'Full price', count: 8, percent: 88.9 }, { key: 'discounted', label: 'With a coupon or promo code', count: 1, percent: 11.1 }],
  expiry: [{ key: 'lifetime', label: 'Lifetime — never ends', count: 5, percent: 100 }],
  loyalty: [],
  weekly: Array.from({ length: 12 }, (_, i) => ({ label: `W${i}`, count: i === 11 ? 8 : 0, revenue: i === 11 ? 1592 : 0 }))
};

test('Members: six labelled pie charts and the weekly joins', async () => {
  const { byId, dom } = await renderPage('members.js', { answers: {
    '/api/members/analysis': ANALYSIS,
    '/api/members/revenue': { active: 5, totalRevenue: 1776, expiringIn7Days: 0, expired: 3, removed: 2, cancelled: 0, totalMembers: 10, byPlan: {}, recentPayments: [] },
    '/api/members': { total: 0, subscribers: [] },
    '/api/plans': { configured: true, testMode: false, plans: [] }
  } });
  const text = byId('panels').textContent;
  assert.match(text, /Member analysis/);
  for (const id of ['chartStatus', 'chartPasses', 'chartRevenue', 'chartPrice', 'chartExpiry', 'chartLoyalty', 'chartWeekly']) {
    assert.ok(byId(id), `${id} is missing`);
  }

  // Every slice is named with its count and share — never colour alone.
  const status = byId('chartStatus');
  assert.match(status.textContent, /Active — has access5 · 50%/);
  assert.match(status.textContent, /Expired3 · 30%/);
  const slices = walk(status).filter((n) => n.tagName === 'PATH');
  assert.equal(slices.length, 3, 'one slice per status');
  assert.ok(slices.every((p) => /^M /.test(p.attributes.d)), 'slices are drawn');
  assert.equal(slices[0].attributes.fill, '#0ca30c', 'active is the "good" colour');
  assert.ok(slices.every((p) => p.attributes.stroke === '#0f0f12' && p.attributes['stroke-width'] === '2'), 'slices need a 2px gap');
  assert.match(walk(slices[1]).find((n) => n.tagName === 'TITLE').textContent, /Expired: 3 \(30%\)/, 'hover says the numbers');
  assert.match(walk(status).find((n) => n.tagName === 'SVG').attributes['aria-label'], /Active — has access 5 \(50%\)/);

  // Rupee charts read in rupees.
  assert.match(byId('chartRevenue').textContent, /₹1,577 · 88.8%/);
  assert.match(byId('chartRevenue').textContent, /₹1,776revenue/);

  // A chart with one part is a full ring, not a broken arc.
  const expiry = walk(byId('chartExpiry'));
  assert.equal(expiry.filter((n) => n.tagName === 'PATH').length, 0);
  assert.ok(expiry.some((n) => n.tagName === 'CIRCLE' && n.attributes.class === 'mb-slice'));

  // An empty chart says so.
  assert.match(byId('chartLoyalty').textContent, /Nothing to show yet/);

  // Weeks with nobody new show no bar.
  const weekly = walk(byId('chartWeekly'));
  assert.equal(weekly.filter((n) => /bar-fill/.test(n.className)).length, 1);
  assert.match(byId('chartWeekly').textContent, /W118 · ₹1,592/);

  // The headline tiles do not repeat the ones above them.
  assert.doesNotMatch(walk(dom.body).filter((n) => /mb-headline/.test(n.className)).map((n) => n.textContent).join(''), /Revenue|^Members/);
});

test('Members still loads when the analysis cannot be read', async () => {
  const { byId } = await renderPage('members.js', { answers: {
    '/api/members/revenue': { active: 0, totalRevenue: 0, expiringIn7Days: 0, expired: 0, removed: 0, cancelled: 0, totalMembers: 0, byPlan: {}, recentPayments: [] },
    '/api/members': { total: 0, subscribers: [] },
    '/api/plans': { configured: true, testMode: false, plans: [] }
  } });
  assert.doesNotMatch(byId('panels').textContent, /Could not load members/);
});
