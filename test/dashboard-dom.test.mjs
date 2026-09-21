// ============================================================================
// Building the dashboard's DOM (test/dashboard-dom.test.mjs)
// ============================================================================
// The Referrals page rendered tables with a single header cell and no rows at
// all, and nobody could tell — it looked like a page with nothing to show.
//
// el() took its children as ONE array in the third argument and silently
// ignored anything after it. The page passed them as separate arguments, so
// every row after the first, and every table body, was dropped without an
// error. These run the real el() from dashboard/shared.js against a small
// fake DOM, so the contract is pinned in both forms.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Just enough DOM for el() and the helpers built on it. */
function fakeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.className = '';
      this._text = '';
      this.style = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); return node; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    addEventListener() {}
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  class Text extends Node {
    constructor(text) { super('#text'); this._text = String(text); }
  }
  return {
    Node,
    document: {
      body: new Node('body'),
      readyState: 'complete',
      createElement: (tag) => new Node(tag),
      createTextNode: (text) => new Text(text),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    }
  };
}

/** Loads the real shared.js with Firebase stubbed and the fake DOM installed. */
async function loadShared() {
  const dom = fakeDom();
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, TextDecoder, URL,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    Node: dom.Node,
    document: dom.document,
    window: { location: { hostname: 'localhost', href: 'http://localhost/', search: '', reload() {} },
      addEventListener() {} }
  });
  context.globalThis = context;

  const firebaseApp = new vm.SourceTextModule('export function initializeApp() { return {}; }',
    { identifier: 'firebase-app', context });
  const firebaseAuth = new vm.SourceTextModule(`
    export function getAuth() { return {}; }
    export function setPersistence() { return Promise.resolve(); }
    export const browserLocalPersistence = {};
    export function signInWithPopup() { return Promise.resolve({}); }
    export class GoogleAuthProvider { setCustomParameters() {} }
    export function signOut() { return Promise.resolve(); }
    export function onAuthStateChanged() {}
  `, { identifier: 'firebase-auth', context });

  const shared = new vm.SourceTextModule(fs.readFileSync('dashboard/shared.js', 'utf8'),
    { identifier: 'shared.js', context });
  await shared.link((specifier) => (specifier.includes('firebase-app') ? firebaseApp : firebaseAuth));
  await shared.evaluate();
  return shared.namespace;
}

const { el } = await loadShared();
const tags = (node) => node.children.map((c) => c.tagName);

test('children passed as separate arguments are all kept', () => {
  // The form the Referrals page used — the one that silently lost rows.
  const body = el('tbody', {}, el('tr'), el('tr'), el('tr'));
  assert.equal(body.children.length, 3, 'rows after the first were dropped');
});

test('children passed as one array are still all kept', () => {
  // The form every other page uses, which must keep working.
  const body = el('tbody', {}, [el('tr'), el('tr'), el('tr')]);
  assert.equal(body.children.length, 3);
});

test('a table built with separate arguments has its header AND its body', () => {
  const table = el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Code' }), el('th', { text: 'Member' }), el('th', { text: 'Telegram ID' }))),
    el('tbody', {}, el('tr'), el('tr')));

  assert.deepEqual(tags(table), ['THEAD', 'TBODY'], 'the table body was dropped');
  assert.equal(table.children[0].children[0].children.length, 3, 'header cells after the first were dropped');
  assert.equal(table.children[1].children.length, 2);
});

test('a cell keeps both lines — the name and the Telegram id under it', () => {
  // Exactly what went missing: the id sat in a second child.
  const cell = el('td', {}, el('div', { text: 'Asha (@asha)' }), el('div', { text: '111' }));
  assert.equal(cell.children.length, 2);
  assert.match(cell.textContent, /111/, 'the Telegram id is not in the cell');
});

test('nested arrays are flattened, and empty children are skipped', () => {
  const row = el('tr', {}, el('td'), [el('td'), [el('td'), null]], false, undefined, el('td'));
  assert.equal(row.children.length, 4);
});

test('text children become text, attributes and classes are set', () => {
  const node = el('td', { class: 'ref-id', colspan: '12', title: 'x' }, 'RL-0001');
  assert.equal(node.className, 'ref-id');
  assert.equal(node.attributes.colspan, '12');
  assert.equal(node.textContent, 'RL-0001');
});

test('an element with no children is empty, not broken', () => {
  assert.equal(el('br').children.length, 0);
  assert.equal(el('span', { text: 'x' }).textContent, 'x');
});
