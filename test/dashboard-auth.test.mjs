// ============================================================================
// The dashboard's side of signing in (test/dashboard-auth.test.mjs)
// ============================================================================
// dashboard/shared.js is a browser module that imports Firebase from a CDN, so
// it cannot simply be imported here. It is loaded into a vm with the Firebase
// modules and the DOM stubbed, which means the real `api()` runs against a
// fake fetch — token attachment, the 401 retry and all.
//
// This exists because a parse check is not enough. The retry was first written
// with a `forceFreshToken` parameter that never made it onto the (destructured)
// signature of the function that used it: perfectly valid syntax, and a
// ReferenceError on every single request the dashboard made.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SHARED = fs.readFileSync('dashboard/shared.js', 'utf8');

/** A Firebase user whose tokens say whether a fresh one was demanded. */
function fakeUser() {
  const asked = [];
  return {
    asked,
    uid: 'uid-1', email: 'curator@example.com', displayName: 'Curator', photoURL: '',
    getIdToken: async (force) => { asked.push(Boolean(force)); return force ? 'fresh-token' : 'cached-token'; }
  };
}

/**
 * load — evaluates shared.js with Firebase, the DOM and fetch replaced.
 *
 * @param {Object} options
 * @param {Function} options.fetch What the module's fetch calls answer with
 * @param {Object} [options.user] The signed-in user, if any
 */
async function load({ fetch, user = null, signOutFails = false, onReload = () => {} }) {
  const events = { signedOut: 0, toasts: [] };

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    URLSearchParams, TextDecoder, URL,
    fetch,
    __signedOut: () => { events.signedOut++; },
    __signOutFails: signOutFails,
    localStorage: {
      store: {},
      getItem(k) { return this.store[k] ?? null; },
      setItem(k, v) { this.store[k] = String(v); },
      removeItem(k) { delete this.store[k]; }
    },
    // Just enough DOM for the module to evaluate. Nothing here renders; the
    // point is the request path, not the page.
    document: {
      // A body that accepts toasts, so the lapsed-session path runs as it does
      // in a browser rather than stopping at the first DOM call.
      body: { append() {}, appendChild() {} },
      readyState: 'complete',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, append() {}, setAttribute() {} }),
      addEventListener() {}
    },
    window: {
      location: { hostname: 'localhost', href: 'http://localhost/', search: '', reload: onReload },
      addEventListener() {}
    }
  });
  context.globalThis = context;

  const firebaseApp = new vm.SourceTextModule(
    'export function initializeApp() { return {}; }', { identifier: 'firebase-app', context });
  const firebaseAuth = new vm.SourceTextModule(`
    export function getAuth() { return { currentUser: null }; }
    export function setPersistence() { return Promise.resolve(); }
    export const browserLocalPersistence = {};
    export function signInWithPopup() { return Promise.resolve({}); }
    export class GoogleAuthProvider { setCustomParameters() {} }
    export function signOut() {
      globalThis.__signedOut();
      return globalThis.__signOutFails ? Promise.reject(new Error('signOut failed')) : Promise.resolve();
    }
    export function onAuthStateChanged() {}
  `, { identifier: 'firebase-auth', context });


  const module = new vm.SourceTextModule(SHARED, { identifier: 'shared.js', context });
  await module.link((specifier) => {
    if (specifier.includes('firebase-app')) return firebaseApp;
    if (specifier.includes('firebase-auth')) return firebaseAuth;
    throw new Error('unexpected import: ' + specifier);
  });
  // Linking shared.js links the two stubs along with it.
  await module.evaluate();

  // currentUser is module-private, so it is set the way sign-in sets it.
  if (user) module.namespace.__setCurrentUserForTests(user);
  return { api: module.namespace.api, events };
}

test('a request carries the cached token, and does not demand a fresh one', async () => {
  const user = fakeUser();
  const seen = [];
  const { api } = await load({
    user,
    fetch: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ success: true, data: { fine: true } }) };
    }
  });

  const data = await api('/api/analytics');
  assert.deepEqual(data, { fine: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, 'Bearer cached-token');
  assert.deepEqual(user.asked, [false], 'a fresh token was demanded when the cached one was fine');
});

test('a 401 is retried once with a fresh token, and succeeds', async () => {
  // The session lapsed while the tab sat open. The SDK hands out a cached
  // token until it is close to expiry, so the fix is to demand a new one —
  // not to show the curator an error about tokens.
  const user = fakeUser();
  const seen = [];
  const { api, events } = await load({
    user,
    fetch: async (url, init) => {
      seen.push(init.headers.Authorization);
      if (seen.length === 1) {
        return { ok: false, status: 401, json: async () => ({ success: false, error: 'Token has expired' }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { recovered: true } }) };
    }
  });

  const data = await api('/api/analytics');
  assert.deepEqual(data, { recovered: true });
  assert.deepEqual(seen, ['Bearer cached-token', 'Bearer fresh-token']);
  assert.deepEqual(user.asked, [false, true]);
  assert.equal(events.signedOut, 0, 'a recoverable lapse should not sign anybody out');
});

test('a 401 that survives a fresh token ends the session, once', async () => {
  const user = fakeUser();
  let calls = 0;
  const { api, events } = await load({
    user,
    fetch: async () => {
      calls++;
      return { ok: false, status: 401, json: async () => ({ success: false, error: 'Token signature is invalid.' }) };
    }
  });

  await assert.rejects(() => api('/api/analytics'), /session has expired/i);
  assert.equal(calls, 2, 'it should try exactly twice, not loop');
  assert.equal(events.signedOut, 1, 'the gate never came back');

  // A page firing several requests at once must not sign out several times.
  await Promise.allSettled([api('/api/stats'), api('/api/questions')]);
  assert.equal(events.signedOut, 1, 'each failing request signed the curator out again');
});

test('a 403 is not retried — a new token would not help', async () => {
  const user = fakeUser();
  let calls = 0;
  const { api, events } = await load({
    user,
    fetch: async () => {
      calls++;
      return {
        ok: false, status: 403,
        json: async () => ({ success: false, error: 'Account x@y.com is not on the curator allowlist.' })
      };
    }
  });

  await assert.rejects(() => api('/api/analytics'), /allowlist/);
  assert.equal(calls, 1, 'a refused identity was asked again pointlessly');
  assert.equal(events.signedOut, 0, 'being refused is not a lapsed session');
});

test('a signed-out visitor sends no Authorization header at all', async () => {
  const seen = [];
  const { api } = await load({
    fetch: async (url, init) => {
      seen.push(init.headers.Authorization);
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    }
  });
  await api('/api/config');
  assert.equal(seen[0], undefined);
});

test('a sign-out that fails reloads the page rather than leaving it stuck', async () => {
  // currentUser is already cleared by then, so without a reload the page could
  // load nothing and would never show the sign-in gate either.
  const user = fakeUser();
  let reloaded = 0;
  const { api } = await load({
    user,
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ success: false, error: 'expired' }) }),
    signOutFails: true,
    onReload: () => { reloaded++; }
  });

  await assert.rejects(() => api('/api/analytics'), /session has expired/i);
  // The sign-out is chained on a promise, so let it settle.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reloaded, 1, 'a failed sign-out left the page stuck with no way back in');
});
