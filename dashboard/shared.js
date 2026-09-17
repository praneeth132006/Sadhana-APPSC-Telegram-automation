// ============================================================================
// Shared dashboard runtime (dashboard/shared.js)
// ============================================================================
// Every dashboard page imports this module. It owns:
//   - Firebase sign-in and the auth gate that covers the page until you are in
//   - the top navigation shared by all five dashboards
//   - `api()`, which attaches a fresh Firebase ID token to every request
//   - toasts, DOM helpers and formatting used across pages
//
// Security note: the gate here is convenience, not protection. The server
// verifies the same ID token on every call (src/auth.js), so an unauthenticated
// browser sees nothing even if it skips this file entirely.
// ============================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

// ---------------------------------------------------------------------------
// Firebase configuration
// ---------------------------------------------------------------------------
// These values are public identifiers, not secrets — Firebase web apps are
// designed to ship them. Every browser that loads this page receives them, so
// there is nothing here to withhold. What actually protects the data is the
// server-side token check plus the CURATOR_EMAILS allowlist in .env.
//
// GitHub secret scanning opens a "Google API Key" alert on the apiKey below and
// advises rotating it. Do not: the replacement would be equally public, and
// rotating means a code change and a redeploy for no gain. SECURITY-REVIEW.md
// records what this key can actually reach (authorised domains are tight, no
// billable API is activated) and how that was verified.
const firebaseConfig = {
  apiKey: 'AIzaSyDlL3dw-FY2bdNQDCm4Rtp0ZhrDTCSJHfQ',
  authDomain: 'ap-gurukul-43050.firebaseapp.com',
  projectId: 'ap-gurukul-43050',
  storageBucket: 'ap-gurukul-43050.firebasestorage.app',
  messagingSenderId: '797079176348',
  appId: '1:797079176348:web:f20cccdedb8f1ca3fa9959'
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();

/** The signed-in Firebase user, or null. */
export let currentUser = null;

/** Server bootstrap data from /api/config. */
export let serverConfig = {};

// ---------------------------------------------------------------------------
// Navigation definition
// ---------------------------------------------------------------------------

/** The five dashboards, in the order they appear in the nav bar. */
const PAGES = [
  { id: 'upload',     href: 'index.html',      icon: '📤', label: 'Upload',     hint: 'Paste JSON and push questions to the sheet' },
  { id: 'analytics',  href: 'analytics.html',  icon: '📊', label: 'Analytics',  hint: 'Counts, coverage, runway and curator activity' },
  { id: 'questions',  href: 'questions.html',  icon: '📚', label: 'Questions',  hint: 'Browse, search and edit the whole question bank' },
  { id: 'automation', href: 'automation.html', icon: '🤖', label: 'Automation', hint: 'Post to Telegram now and manage schedules' },
  { id: 'members',    href: 'members.html',    icon: '💳', label: 'Members',    hint: 'Paying members, revenue and expiry sweep' },
  { id: 'pricing',    href: 'pricing.html',    icon: '🎟', label: 'Pass & Coupons', hint: 'The pass students buy, its price, and coupon codes' },
  { id: 'support',    href: 'support.html',    icon: '🆘', label: 'Support',    hint: 'Student tickets: reply, send invite links, check payments' },
  { id: 'health',     href: 'health.html',     icon: '🩺', label: 'Health',     hint: 'System status and security posture' }
];

/** The 16 APPSC subjects offered in every subject dropdown. */
export const SUBJECTS = [
  'History', 'AP History', 'Geography', 'AP Geography', 'Economy', 'AP Economy',
  'Polity', 'Society', 'Current Affairs', 'Science and Technology', 'Biology',
  'Chemistry', 'Physics', 'Environment', 'General Studies', 'Disaster Management'
];

/** Workflow states a question can be in. */
export const STATUSES = ['Draft', 'Review', 'Approved', 'Scheduled', 'Sending', 'Posted', 'Rejected', 'Archived'];

/** Statuses a curator may set. Posted and Sending are written by the poster
 *  together with the Posted column and the message id; setting one by hand
 *  desynchronises the row, so the question claims to be posted and is sent
 *  again. Offered for FILTERING, never for assignment. */
export const ASSIGNABLE_STATUSES = STATUSES.filter((s) => s !== 'Posted' && s !== 'Sending');

/** Difficulty levels. */
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** Shorthand for document.getElementById. */
export const $ = (id) => document.getElementById(id);

/**
 * el — creates an element with attributes and children in one call.
 * Text children are appended as text nodes, never parsed as HTML, which is why
 * none of these dashboards need innerHTML for user-supplied data.
 *
 * @param {string} tag Tag name
 * @param {Object} [attrs] Attributes; `class`, `text`, `html` and `on*` handled specially
 * @param {Array} [children] Child nodes or strings
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  Object.entries(attrs).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value; // Only ever called with literals we author.
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  });

  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });

  return node;
}

/** Replaces every child of `node` with the supplied nodes. */
export function replaceChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter(Boolean));
}

/** Escapes a string for safe use inside HTML we build by hand. */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Formats a number with thousands separators, or an em dash when absent. */
export function num(value) {
  return (value === null || value === undefined || Number.isNaN(Number(value)))
    ? '—'
    : Number(value).toLocaleString('en-IN');
}

/** Formats a percentage to one decimal place. */
export function pct(part, whole) {
  if (!whole) return '0%';
  return (Math.round((part / whole) * 1000) / 10) + '%';
}

/** Shortens long text for table cells, with an ellipsis. */
export function truncate(text, max = 120) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/**
 * showToast — floating notification in the bottom-right corner.
 *
 * @param {'success'|'error'|'info'|'warn'} type Visual style
 * @param {string} message Text to display
 * @param {number} [durationMs] Auto-dismiss delay
 */
export function showToast(type, message, durationMs = 5000) {
  let container = $('toastContainer');
  if (!container) {
    container = el('div', { id: 'toastContainer', class: 'toast-container' });
    document.body.append(container);
  }

  const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
  const toast = el('div', { class: 'toast ' + type }, [
    el('span', { class: 'toast-icon', text: icons[type] || 'ℹ️' }),
    el('span', { class: 'toast-message', text: message }),
    el('button', { class: 'toast-close', title: 'Dismiss', text: '×', onclick: () => toast.remove() })
  ]);

  container.append(toast);
  setTimeout(() => {
    toast.style.animation = 'slideOutRight 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Which group the dashboard is looking at
// ---------------------------------------------------------------------------
// Every data request carries a group, and there is no default. A curator with
// nothing selected sees a picker rather than somebody's data — because a page
// that quietly showed "the first group" would look exactly like a page showing
// the group they meant, and questions would be uploaded into the wrong sheet.

const GROUP_STORAGE_KEY = 'sadhana.selectedGroup';

/**
 * getSelectedGroup — the group this page is showing.
 *
 * The URL wins, localStorage is only a memory of last time. Storage alone was
 * a trap: a browser that refuses site data — a private window, strict privacy
 * settings, an in-app browser — made the write fail silently, so choosing a
 * group reloaded straight back to the chooser. Clicking appeared to do nothing,
 * forever, with no error anywhere.
 *
 * Putting it in the URL also makes the current group visible and linkable.
 *
 * @returns {string} A group id, or '' when none is chosen
 */
export function getSelectedGroup() {
  const fromUrl = new URLSearchParams(window.location.search).get('group');
  if (fromUrl) return String(fromUrl);

  try {
    return String(localStorage.getItem(GROUP_STORAGE_KEY) || '');
  } catch (err) {
    return '';
  }
}

/** Remembers the chosen group, best effort. Never throws. */
export function rememberSelectedGroup(groupId) {
  try {
    if (groupId) localStorage.setItem(GROUP_STORAGE_KEY, groupId);
    else localStorage.removeItem(GROUP_STORAGE_KEY);
  } catch (err) { /* storage is a convenience; the URL is the truth */ }
}

/**
 * selectGroup — switch the page to a group.
 *
 * Navigates rather than reloading, so the choice is carried in the URL and
 * takes effect even where storage is unavailable. A full navigation rather
 * than a re-render because every panel is holding the previous group's data,
 * and a partial refresh is how the two end up mixed on screen.
 *
 * @param {string} groupId
 */
export function selectGroup(groupId) {
  rememberSelectedGroup(groupId);
  const url = new URL(window.location.href);
  url.searchParams.set('group', groupId);
  window.location.assign(url.toString());
}

/** The groups this curator can work in. Fetched once per page. */
let groupsCache = null;
export async function listGroups() {
  if (!groupsCache) groupsCache = await api('/api/groups');
  return groupsCache;
}

/**
 * api — calls the local server with a fresh Firebase ID token attached.
 * Tokens are short lived, so `getIdToken()` is called per request and the SDK
 * refreshes it transparently when needed.
 *
 * @param {string} path API path, e.g. '/api/analytics'
 * @param {Object} [options] { method, body, query }
 * @returns {Promise<Object>} The `data` field of the response
 */
export async function api(path, options = {}) {
  const { method = 'GET', body = null, query = null } = options;

  const params = new URLSearchParams();
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
    });
  }

  // The group travels on every request. /api/groups is how the picker learns
  // what exists, so it is the one call that cannot require a selection.
  if (path !== '/api/groups' && !params.has('group')) {
    const selected = getSelectedGroup();
    if (selected) params.set('group', selected);
  }

  let url = path;
  const qs = params.toString();
  if (qs) url += '?' + qs;

  const headers = {};
  if (currentUser) {
    headers['Authorization'] = 'Bearer ' + (await currentUser.getIdToken());
  }
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    // Never send this request anywhere but our own origin.
    credentials: 'same-origin'
  });

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || payload.success === false) {
    throw new Error(payload.error || `Request failed with HTTP ${res.status}`);
  }
  return payload.data !== undefined ? payload.data : payload;
}

// ---------------------------------------------------------------------------
// Chrome: nav bar and auth gate
// ---------------------------------------------------------------------------

/** Builds the top bar: brand, page nav, connection pill, profile chip. */
function buildTopBar(activePage) {
  // Each link carries the current group, so moving between pages cannot lose
  // it. Without this the group would survive only in localStorage, and a
  // browser refusing site data would drop back to the chooser on every click.
  const selected = getSelectedGroup();
  const withGroup = (href) => (selected ? `${href}?group=${encodeURIComponent(selected)}` : href);

  const nav = el('nav', { class: 'main-nav' },
    PAGES.map((page) => el('a', {
      class: 'nav-link' + (page.id === activePage ? ' active' : ''),
      href: withGroup(page.href),
      title: page.hint
    }, [
      el('span', { class: 'nav-icon', text: page.icon }),
      el('span', { class: 'nav-label', text: page.label })
    ]))
  );

  // Which group is being worked in, directly under the title. It is the single
  // most consequential thing on the page: uploading a Telugu batch into the
  // UPSC sheet looks identical to doing it right, and nothing else would say.
  const groupSelect = el('select', {
    class: 'group-select',
    id: 'groupSelect',
    title: 'Everything on this page belongs to the selected group',
    onchange: (e) => selectGroup(e.target.value)
  });

  const identity = el('div', { class: 'top-identity' }, [
    el('h1', { class: 'top-title', text: 'Questions Dashboard' }),
    el('div', { class: 'top-group', id: 'groupSwitcher' }, [
      el('span', { class: 'top-group-label', text: 'Posting to' }),
      groupSelect
    ])
  ]);

  const connectionPill = el('div', { class: 'sheet-pill', id: 'sheetConnectionPill' }, [
    el('span', { id: 'connectionStatus', class: 'status-dot offline' }),
    el('span', { id: 'connectionStatusText', class: 'sheet-pill-text', text: 'Sheets: connecting…' })
  ]);

  const profileChip = el('div', { id: 'userProfileChip', class: 'user-chip', style: 'display:none' }, [
    el('div', { class: 'user-avatar', id: 'userAvatar', text: 'U' }),
    el('div', { class: 'user-meta' }, [
      el('span', { class: 'user-name', id: 'userEmail', text: '' }),
      el('span', { class: 'user-role', text: 'Curator' })
    ]),
    el('button', {
      class: 'user-signout',
      title: 'Sign out',
      text: 'Sign out',
      onclick: () => signOut(auth)
    })
  ]);

  return el('header', { class: 'top-bar', id: 'topBar' }, [
    identity,
    nav,
    el('div', { class: 'top-right' }, [connectionPill, profileChip])
  ]);
}


/**
 * buildGroupChooser — the full-screen picker shown when nothing is selected.
 *
 * Deliberately blocking. Guessing a group for the curator would mean the first
 * upload of a session could land in the wrong sheet, and there is no undo for a
 * question posted to a paying group.
 */
function buildGroupChooser(groups) {
  const cards = groups.map((group) => el('button', {
    class: 'group-card' + (group.ready ? '' : ' is-unready'),
    disabled: group.ready ? undefined : 'disabled',
    onclick: () => selectGroup(group.id)
  }, [
    el('div', { class: 'group-card-name', text: group.label }),
    el('div', { class: 'group-card-lang', text: group.language || '' }),
    el('div', {
      class: 'group-card-meta',
      text: group.ready
        ? `${(group.subjects || []).length} subjects`
        : 'not configured'
    })
  ]));

  return el('div', { id: 'groupChooser', class: 'group-chooser' }, [
    el('div', { class: 'group-chooser-card' }, [
      el('h2', { class: 'group-chooser-title', text: 'Choose a group' }),
      el('p', {
        class: 'group-chooser-sub',
        text: 'Every page, upload and payment below belongs to the group you pick. Nothing is shared between them.'
      }),
      el('div', { class: 'group-card-grid' }, cards)
    ])
  ]);
}

/** Fills the top-bar switcher and returns whether a valid group is selected. */
async function applyGroupSelection() {
  let groups = [];
  try {
    groups = await listGroups();
  } catch (err) {
    return { ok: false, groups: [], error: err.message };
  }

  const ready = groups.filter((g) => g.ready);
  const selected = getSelectedGroup();
  const valid = ready.some((g) => g.id === selected);

  // A group that has been removed or unconfigured since the last visit must not
  // leave the page pointed at it.
  if (selected && !valid) rememberSelectedGroup('');

  const select = $('groupSelect');
  if (select) {
    select.innerHTML = '';
    ready.forEach((group) => {
      const option = document.createElement('option');
      option.value = group.id;
      // Short in the bar, full name on hover: a truncated group name is the
      // one field that must never be ambiguous.
      option.textContent = group.shortName || group.displayName;
      option.title = group.displayName;
      if (group.id === selected) option.selected = true;
      select.appendChild(option);
    });
  }

  return { ok: valid, groups, error: null };
}

/** Builds the full-screen sign-in gate shown to logged-out visitors. */
function buildAuthGate() {
  const errorBox = el('div', { id: 'gateAuthError', class: 'auth-error-text', style: 'display:none' });

  const showAuthError = (message) => {
    errorBox.textContent = message;
    errorBox.style.display = 'block';
  };

  // Google only. Email-and-password sign-in was removed: the server accepts an
  // address only if it is on the curator allowlist or has a verified email, so
  // a self-registered password account could not curate anything — it produced
  // a working sign-in that then failed on every request, which reads as a
  // broken dashboard rather than as "you are not a curator".
  const googleBtn = el('button', { class: 'auth-google-btn', type: 'button' }, [
    el('span', { class: 'auth-google-mark', text: 'G' }),
    el('span', { text: 'Continue with Google' })
  ]);

  googleBtn.addEventListener('click', async () => {
    errorBox.style.display = 'none';
    googleBtn.disabled = true;
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      showAuthError(friendlyAuthError(err));
    } finally {
      googleBtn.disabled = false;
    }
  });

  return el('div', { id: 'authGate', class: 'auth-gate' }, [
    el('div', { class: 'auth-card' }, [
      el('div', { class: 'auth-logo', text: 'SA' }),
      el('h1', { class: 'auth-title', text: 'Questions Dashboard' }),
      el('p', { class: 'auth-sub', text: 'Sign in to manage question banks and paid groups.' }),
      googleBtn,
      errorBox,
      el('p', { class: 'auth-foot', text: 'Curator access only' })
    ])
  ]);
}

/**
 * buildBootScreen — the neutral splash shown while Firebase restores the
 * session from local storage.
 *
 * Without this the sign-in gate is what fills the screen during that gap, so
 * every navigation between dashboards looked like being logged out again. The
 * gate is now only revealed once Firebase has actually confirmed there is no
 * user.
 */
function buildBootScreen() {
  return el('div', { id: 'bootScreen', class: 'boot-screen' }, [
    el('div', { class: 'boot-inner' }, [
      el('div', { class: 'boot-spinner' }),
      el('div', { class: 'boot-title', text: 'Sadhana APPSC' }),
      el('div', { class: 'boot-hint', text: 'Restoring your session…' })
    ])
  ]);
}

/**
 * isHostAuthorised — does `host` match one of Firebase's authorised domains?
 *
 * Firebase accepts an exact match or any subdomain of a listed domain. Kept
 * separate from the network call so the rule itself is directly testable — the
 * previous hardcoded guess wrongly rejected a valid custom domain.
 *
 * @param {string} host location.hostname
 * @param {Array<string>} domains authorizedDomains from the project config
 * @returns {boolean}
 */
export function isHostAuthorised(host, domains) {
  if (!host || !Array.isArray(domains)) return false;
  return domains.some((domain) => host === domain || host.endsWith('.' + domain));
}

/**
 * warnIfOriginNotAuthorised — flags a host Firebase sign-in cannot work from.
 *
 * Firebase authorises sign-in per domain. Rather than guessing which hosts are
 * allowed, this asks the project for its actual authorised list — an earlier
 * version hardcoded a guess and wrongly warned on a perfectly valid custom
 * domain, which is worse than saying nothing.
 *
 * The check is advisory and fails open: if the list cannot be fetched, no
 * banner is shown, because a false alarm is more damaging than a missing one.
 */
async function warnIfOriginNotAuthorised() {
  const host = location.hostname;

  // Served from a file:// URL or similar — nothing useful to say.
  if (!host) return;

  let authorised;
  try {
    const res = await fetch(
      'https://identitytoolkit.googleapis.com/v1/projects?key=' + encodeURIComponent(firebaseConfig.apiKey)
    );
    if (!res.ok) return;
    authorised = (await res.json()).authorizedDomains;
  } catch (err) {
    return; // Offline or blocked: stay quiet rather than guess.
  }

  if (!Array.isArray(authorised) || !authorised.length) return;
  if (isHostAuthorised(host, authorised)) return;

  const localUrl = `http://localhost:${location.port || '3000'}${location.pathname}`;

  showBanner('error', `Sign-in will fail on "${host}".`,
    'That host is not on this Firebase project\u2019s authorised list (' + authorised.join(', ') + '). ' +
    'Either open the dashboard at ' + localUrl + ', or add "' + host + '" under ' +
    'Firebase Console \u2192 Authentication \u2192 Settings \u2192 Authorised domains. ' +
    'Signing in from an unauthorised host is what produces the "500. That\u2019s an error" page from Google.');
}

/** Turns a Firebase error code into something a curator can act on. */
function friendlyAuthError(err) {
  const code = (err && err.code) || '';
  const table = {
    // Firebase authorises sign-in per domain. Opening the dashboard on a LAN
    // IP, or on 127.0.0.1 when only localhost is authorised, fails here — and
    // Google's popup often surfaces it as a bare 500 rather than a clear error.
    'auth/unauthorized-domain':
      `This page is open on "${location.hostname}", which is not an authorised Firebase domain. ` +
      'Open it at http://localhost:' + (location.port || '3000') + ' instead, or add this host under ' +
      'Firebase Console → Authentication → Settings → Authorised domains.',
    'auth/internal-error':
      'Google rejected the sign-in request. This is almost always the domain: open the dashboard at ' +
      'http://localhost:' + (location.port || '3000') + ' rather than an IP address. If you are already ' +
      'on localhost, check that Google sign-in is enabled in Firebase Console → Authentication → Sign-in method.',
    'auth/invalid-credential': 'Email or password is incorrect.',
    'auth/wrong-password': 'Email or password is incorrect.',
    'auth/user-not-found': 'No account exists for that email.',
    'auth/email-already-in-use': 'That email already has an account — use Sign In.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/invalid-email': 'That email address is not valid.',
    'auth/popup-closed-by-user': 'Sign-in popup was closed before finishing.',
    'auth/popup-blocked': 'Your browser blocked the popup. Allow popups and try again.',
    'auth/too-many-requests': 'Too many attempts. Wait a minute and try again.',
    'auth/network-request-failed': 'Network error reaching Firebase. Check your connection.',
    /* What this property does: Provides specific instructions with the current hostname when domain is not whitelisted */
    /* What it brings: Eliminates confusion when deploying to custom domains or preview URLs on Vercel */
    /* Where changes can be seen: In the error box below the Sign In button */
    'auth/unauthorized-domain': `This domain (${typeof window !== 'undefined' && window.location ? window.location.hostname : 'current'}) is not authorised in Firebase console. Add it under Authentication > Settings > Authorized domains.`,
    'auth/operation-not-allowed': 'That sign-in method is disabled in the Firebase console.'
  };
  return table[code] || (err && err.message) || 'Sign-in failed.';
}

/**
 * Updates the Google Sheets status pill.
 *
 * The pill shows a short form and carries the full text as a tooltip. The long
 * version — "Sheets: connected · v6 (30 columns + membership)" — pushed the
 * account chip off the bar and then truncated anyway, so the one word that
 * matters was the one that got cut.
 *
 * @param {'online'|'offline'|'warn'} state Dot colour
 * @param {string} text Full description, kept as the title
 * @param {string} [short] What to display; defaults to the full text
 */
function setConnectionStatus(state, text, short) {
  const dot = $('connectionStatus');
  const label = $('connectionStatusText');
  const pill = $('sheetConnectionPill');
  if (dot) { dot.className = 'status-dot ' + state; }
  if (pill) pill.title = text;
  if (label) label.textContent = short || text;
}

/**
 * showBanner — a persistent, full-width notice pinned above the page content.
 * Used for conditions the curator must act on rather than dismiss, such as an
 * out-of-date Apps Script deployment.
 *
 * @param {'warn'|'error'|'info'} tone Visual style
 * @param {string} title Short headline
 * @param {string} detail Explanation and the fix
 */
export function showBanner(tone, title, detail) {
  let host = $('bannerHost');
  if (!host) {
    host = el('div', { id: 'bannerHost', class: 'banner-host' });
    const container = document.querySelector('.app-container') || document.body;
    // Sit directly under the nav, above the sign-in gate — the gate fills the
    // viewport, so a banner placed after it would never be seen while logged out.
    const anchor = $('authGate') || $('pageRoot');
    container.insertBefore(host, anchor || null);
  }

  // One banner per title, so a periodic re-check does not stack duplicates.
  if (host.querySelector(`[data-banner="${CSS.escape(title)}"]`)) return;

  host.append(el('div', { class: 'banner tone-' + tone, dataset: { banner: title } }, [
    el('div', { class: 'banner-body' }, [
      el('strong', { text: title }),
      el('span', { text: ' ' + detail })
    ]),
    el('button', { class: 'btn-icon', text: '×', title: 'Dismiss', onclick: (e) => e.target.closest('.banner').remove() })
  ]));
}

/** Pings the sheet backend and reflects the result in the header pill. */
async function refreshConnectionStatus() {
  setConnectionStatus('loading', 'Sheets: connecting…', 'Connecting…');
  try {
    const res = await fetch('/api/ping');
    const payload = await res.json();

    if (!payload.success) {
      setConnectionStatus('offline', 'Sheets: ' + (payload.error || 'offline'), 'Sheets offline');
      return;
    }

    if (payload.unbound) {
      // v5 is deployed but it cannot see any spreadsheet.
      setConnectionStatus('warn', 'Sheets: script not attached to a sheet', 'Not attached');
      showBanner('error', 'The Apps Script is not attached to your spreadsheet.',
        'It was created as a standalone project rather than from inside the Sheet. Open your Google ' +
        'Sheet → Extensions → Apps Script, paste google_apps_script.js there, run upgradeSpreadsheet, ' +
        'and deploy a new version of that project.');
      return;
    }

    if (payload.outdated) {
      // Reachable, but running an older script than these dashboards need.
      setConnectionStatus('warn', `Sheets: ${payload.version} — upgrade needed`, 'Upgrade needed');
      showBanner('warn', 'Google Apps Script needs upgrading.',
        payload.upgradeHint ||
        `The deployed backend is ${payload.version}, but the dashboards need ${payload.requiredVersion}.`);
    } else {
      setConnectionStatus('online', `Sheets: connected · ${payload.version}`, 'Sheets connected');
    }

    if (payload.tokenRequired === false) {
      showBanner('warn', 'Your Google Sheet Web App has no API token.',
        'It is deployed as "Anyone", so the /exec URL alone grants full read and write access to your ' +
        'question bank. Set API_TOKEN in Apps Script > Project Settings > Script properties to the value ' +
        'already in your .env, then redeploy. See the Health dashboard for details.');
    }
  } catch (err) {
    setConnectionStatus('offline', 'Sheets: local server unreachable', 'Server offline');
  }
}

// ---------------------------------------------------------------------------
// Page bootstrap
// ---------------------------------------------------------------------------

/**
 * initDashboard — call once per page.
 * Injects the nav and auth gate, waits for Firebase, then runs `onReady(user)`
 * exactly once when a curator is signed in. Everything inside `#pageRoot` stays
 * hidden until then.
 *
 * @param {Object} options
 * @param {string} options.page Page id, used to highlight the nav link
 * @param {Function} options.onReady Called with the signed-in user
 */
export async function initDashboard({ page, onReady }) {
  const container = document.querySelector('.app-container') || document.body;
  const pageRoot = $('pageRoot');

  container.prepend(buildTopBar(page));

  // The gate starts hidden. Showing it before Firebase has restored the
  // session is what made every tab change look like a fresh logout.
  const gate = buildAuthGate();
  gate.style.display = 'none';
  container.insertBefore(gate, pageRoot || null);

  // The splash covers the page until the first auth state resolves.
  document.body.append(buildBootScreen());

  if (!$('toastContainer')) {
    document.body.append(el('div', { id: 'toastContainer', class: 'toast-container' }));
  }

  // Persist the session in local storage so it survives navigation between
  // dashboards, reloads and browser restarts. This is Firebase's default, but
  // stating it explicitly means a change of default cannot silently log
  // everyone out on every page load.
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (err) {
    console.warn('[auth] could not set local persistence:', err.message);
  }

  // Bootstrap config drives the gate's behaviour (e.g. hiding registration).
  try {
    const res = await fetch('/api/config');
    serverConfig = await res.json();

    if (serverConfig.firebaseProjectId && serverConfig.firebaseProjectId !== firebaseConfig.projectId) {
      showToast('error',
        `Firebase project mismatch: page uses "${firebaseConfig.projectId}" but the server expects ` +
        `"${serverConfig.firebaseProjectId}". Sign-in will be rejected.`, 15000);
    }
    if (!serverConfig.authEnforced) {
      showToast('warn', 'Server auth is not configured (FIREBASE_PROJECT_ID missing) — the API is locked.', 12000);
    }
  } catch (err) {
    showToast('error', 'Cannot reach the local server. Start it with: npm run dashboard');
  }

  // Advisory only, and it fails open — never let it block startup.
  warnIfOriginNotAuthorised().catch(() => {});

  refreshConnectionStatus();
  // Re-check the sheet connection every couple of minutes.
  setInterval(refreshConnectionStatus, 120000);

  let started = false;

  /** Removes the splash once we know whether anyone is signed in. */
  function dismissBootScreen() {
    const boot = $('bootScreen');
    if (!boot) return;
    boot.classList.add('done');
    setTimeout(() => boot.remove(), 260);
  }

  onAuthStateChanged(auth, async (user) => {
    const authGate = $('authGate');

    if (!user) {
      /* What this line does: Clears the current active curator session reference */
      /* What it brings: Revokes client access to signed API requests */
      /* Where changes can be seen: Client-side session state */
      currentUser = null;
      /* What this line does: Resets started flag to false */
      /* What it brings: Allows re-running initialization when user signs in */
      /* Where changes can be seen: Re-executing page onReady callback upon login */
      started = false;
      /* What this line does: Makes the authentication gate modal visible with flex centering */
      /* What it brings: Prompts visitor with sign-in controls */
      /* Where changes can be seen: Center of the screen */
      if (authGate) authGate.style.display = 'flex';
      // Nothing from the dashboard shows behind the gate: the nav, the group
      // switcher and the sheet pill all describe data the visitor cannot see.
      const bar = $('topBar');
      if (bar) bar.style.display = 'none';
      /* What this line does: Strictly hides pageRoot with !important priority and adds is-auth-hidden class */
      /* What it brings: Prevents any dashboard content from peeking out or leaking behind the modal */
      /* Where changes can be seen: Bottom or background of the screen */
      if (pageRoot) {
        /* What this line does: Applies inline display none with important priority */
        /* What it brings: Overrides any CSS rules trying to display the workspace */
        /* Where changes can be seen: Workspace panel container */
        pageRoot.style.setProperty('display', 'none', 'important');
        /* What this line does: Adds the is-auth-hidden CSS class to pageRoot */
        /* What it brings: Redundant CSS-level concealment safeguard */
        /* Where changes can be seen: DOM tree class list of #pageRoot */
        pageRoot.classList.add('is-auth-hidden');
      }
      /* What this line does: Hides the authenticated user profile chip in the top navigation */
      /* What it brings: Ensures navigation bar reflects logged-out state */
      /* Where changes can be seen: Top right corner of header */
      const chip = $('userProfileChip');
      if (chip) chip.style.display = 'none';
      /* What this line does: Dismisses the dark loading splash screen */
      /* What it brings: Smooth transition to the login gate */
      /* Where changes can be seen: Splash fade-out */
      dismissBootScreen();
      return;
    }

    /* What this line does: Stores verified Firebase user session */
    /* What it brings: Supplies auth tokens to all backend API calls */
    /* Where changes can be seen: Active user credentials */
    currentUser = user;
    /* What this line does: Hides the authentication gate modal */
    /* What it brings: Dismisses login card upon successful sign-in */
    /* Where changes can be seen: Center modal disappears */
    if (authGate) authGate.style.display = 'none';
    const topBar = $('topBar');
    if (topBar) topBar.style.display = '';
    /* What this line does: Unhides pageRoot and removes is-auth-hidden class */
    /* What it brings: Smoothly reveals the full curation workspace */
    /* Where changes can be seen: Main dashboard panels appear */
    if (pageRoot) {
      /* What this line does: Clears inline display override */
      /* What it brings: Restores normal layout flow */
      /* Where changes can be seen: Main dashboard panels */
      pageRoot.style.display = '';
      /* What this line does: Removes is-auth-hidden class */
      /* What it brings: Lifts CSS lockdown */
      /* Where changes can be seen: Workspace visibility */
      pageRoot.classList.remove('is-auth-hidden');
    }
    /* What this line does: Dismisses the dark loading splash screen */
    /* What it brings: Smooth transition to dashboard content */
    /* Where changes can be seen: Full workspace display */
    dismissBootScreen();

    const chip = $('userProfileChip');
    const avatar = $('userAvatar');
    const emailLabel = $('userEmail');
    if (chip) chip.style.display = 'flex';
    if (emailLabel) emailLabel.textContent = user.displayName || user.email || '';
    if (avatar) {
      if (user.photoURL) {
        replaceChildren(avatar, el('img', { src: user.photoURL, alt: '' }));
      } else {
        avatar.textContent = (user.displayName || user.email || 'U').charAt(0).toUpperCase();
      }
    }

    if (started) return;
    started = true;

    // Nothing on the page may load until a group is chosen. Everything below
    // this point reads or writes one group's sheet, so starting without one
    // would mean the first request of the session picks a group by accident.
    const selection = await applyGroupSelection();
    if (!selection.ok) {
      if (selection.error) {
        showBanner('error', 'Could not load the group list.', selection.error);
        return;
      }
      const anchor = $('pageRoot');
      if (anchor && anchor.parentNode) {
        anchor.style.display = 'none';
        anchor.parentNode.insertBefore(buildGroupChooser(selection.groups), anchor);
      }
      // The switcher is meaningless until a group exists to switch from.
      const switcher = $('groupSwitcher');
      if (switcher) switcher.style.display = 'none';
      return;
    }

    try {
      await onReady(user);
    } catch (err) {
      if (/allowlist|not verified|Sign in required|Server auth is not configured/i.test(err.message)) {
        // A permissions problem, not a transient failure — say it once, clearly,
        // and leave it on screen.
        showBanner('error', 'Signed in, but this account cannot use the dashboard.',
          err.message + ' Add the address to CURATOR_EMAILS in the server\u2019s .env file and restart it.');
      } else {
        showToast('error', err.message, 10000);
      }
      console.error('[dashboard] init failed', err);
    }
  });
}

/** Signs the current curator out. */
export function logout() {
  return signOut(auth);
}

// ---------------------------------------------------------------------------
// Small shared UI builders
// ---------------------------------------------------------------------------

/**
 * statCard — the large headline metric tile used on Analytics and Health.
 *
 * @param {string} label Caption under the value
 * @param {string|number} value The metric
 * @param {Object} [opts] { sub, tone } — tone is ok | warn | danger | info
 */
export function statCard(label, value, opts = {}) {
  const text = String(value);
  // Long values are identities (an email, a hostname), not headline numbers,
  // so they get a smaller, wrappable treatment.
  const valueClass = 'stat-value' + (text.length > 14 ? ' long' : '');

  return el('div', { class: 'stat-card tone-' + (opts.tone || 'info') }, [
    el('div', { class: valueClass, text }),
    el('div', { class: 'stat-label', text: label }),
    opts.sub ? el('div', { class: 'stat-sub', text: opts.sub }) : null
  ]);
}

/**
 * barRow — one horizontal bar in a simple CSS bar chart.
 *
 * @param {string} label Row label
 * @param {number} value Value for this row
 * @param {number} max Largest value in the series, used to scale the bar
 * @param {Object} [opts] { tone, suffix }
 */
export function barRow(label, value, max, opts = {}) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return el('div', { class: 'bar-row' }, [
    el('div', { class: 'bar-label', text: label, title: label }),
    el('div', { class: 'bar-track' }, [
      el('div', { class: 'bar-fill tone-' + (opts.tone || 'info'), style: `width:${width}%` })
    ]),
    el('div', { class: 'bar-value', text: num(value) + (opts.suffix || '') })
  ]);
}

/** A labelled section panel with an optional right-hand action area. */
export function panel(title, subtitle, body, actions = null) {
  return el('section', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('div', {}, [
        el('h2', { class: 'panel-title', text: title }),
        subtitle ? el('p', { class: 'panel-subtitle', text: subtitle }) : null
      ]),
      actions
    ]),
    el('div', { class: 'panel-body' }, body)
  ]);
}

/** A centred "nothing here yet" placeholder. */
export function emptyState(icon, message, hint) {
  return el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-icon', text: icon }),
    el('p', { text: message }),
    hint ? el('p', { class: 'empty-hint', text: hint }) : null
  ]);
}

/** A small coloured pill, used for Status and Difficulty values. */
export function pill(text, tone) {
  return el('span', { class: 'pill tone-' + (tone || 'info'), text });
}

/** Maps a Status value to a pill tone. */
export function statusTone(status) {
  return {
    Approved: 'ok', Posted: 'info', Scheduled: 'warn',
    Review: 'warn', Rejected: 'danger', Archived: 'muted', Draft: 'muted'
  }[status] || 'muted';
}

/** Maps a Difficulty value to a pill tone. */
export function difficultyTone(difficulty) {
  return { Easy: 'ok', Medium: 'warn', Hard: 'danger' }[difficulty] || 'muted';
}
