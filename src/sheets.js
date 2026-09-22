// ============================================================================
// Google Sheets Service — client for the Apps Script Web App (v5 / 30 columns)
// ============================================================================
// Every call goes through `request()`, which is the single place that:
//   - resolves the Web App URL from the environment (never from user input),
//   - attaches the shared API token from SHEET_API_TOKEN,
//   - enforces a timeout so a hung Apps Script cannot pin a Node worker,
//   - detects the Google sign-in HTML that comes back from a mis-deployed
//     script and turns it into an actionable error instead of a JSON parse
//     failure.
//
// Callers pass an action plus parameters. They never pass a URL — that is what
// made the previous version SSRF-able from the browser.
// ============================================================================

/**
 * Hard ceiling on one attempt at an Apps Script call. A cold Apps Script
 * reading a large sheet routinely takes 20–35s, and the old 30s ceiling cut
 * those off just before they answered.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.SHEET_TIMEOUT_MS) || 45000;

/** Pause before a retry, multiplied by the attempt number. */
const RETRY_BASE_DELAY_MS = Number(process.env.SHEET_RETRY_DELAY_MS) >= 0 && process.env.SHEET_RETRY_DELAY_MS !== undefined
  ? Number(process.env.SHEET_RETRY_DELAY_MS)
  : 1500;

/** Largest upstream response we will buffer (Apps Script pages are far smaller). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const groups = require('./groups');
const direct = require('./sheets-direct');

/** Every operation a sheets client exposes. */
/**
 * sheetRowOf — the 1-based spreadsheet row a question came from.
 *
 * Every question carries both `row_index` (0-based position within the data)
 * and `excel_row` (the real row number, header counted). markAsPosted takes the
 * row number. Callers used to pass `row_index` and leave the sheet to guess
 * which of the two it had been handed; that guess mapped the 3rd, 4th and 5th
 * rows of a batch back onto rows 2, 3 and 4, so those questions went out to
 * Telegram but stayed marked unposted and were sent again on the next run.
 * One rule, one place, no guessing.
 *
 * @param {Object} q Question object from getUnpostedQuestions
 * @returns {number} 1-based row number (2 is the first data row)
 */
function sheetRowOf(q) {
  if (q && q.excel_row !== undefined && q.excel_row !== null && q.excel_row !== '') {
    return Number(q.excel_row);
  }
  return Number(q && q.row_index) + 2;
}
const API_NAMES = ['ping', 'readConfig', 'getSubjects', 'writeConfig', 'getUnpostedQuestions', 'markAsPosted', 'getStats', 'getAnalytics', 'listQuestions', 'checkDuplicates', 'addQuestions', 'updateQuestion', 'deleteQuestion', 'bulkDelete', 'claimQuestions', 'releaseQuestions', 'unpostQuestions', 'listPosted', 'bulkStatus', 'scheduleQuestions', 'getSubscriber', 'listSubscribers', 'getExpiring', 'getRevenue', 'upsertSubscriber', 'getBotSettings', 'updateBotSettings', 'createTicket', 'appendTicketMessage', 'setTicketStatus', 'listTickets', 'getTicket', 'logTicketEvent', 'listCoupons', 'getCoupon', 'upsertCoupon', 'deleteCoupon', 'recordRedemption', 'listRedemptions', 'getSupportStats', 'findPayment', 'setTicketGroup', 'recoverStaleClaims', 'holdQuestions', 'unscheduleQuestions', 'formatQuestions', 'markDeleted'];

/**
 * getWebAppUrl — resolves and validates the deployed Apps Script URL.
 * Only script.google.com endpoints are accepted, so a mistyped or hostile
 * value in .env cannot redirect our server-side fetches somewhere else.
 *
 * @returns {string} The validated Web App URL
 */
function validateWebAppUrl(raw, label) {
  if (!raw || !String(raw).trim()) {
    throw new Error(
      `No Apps Script URL for ${label}.\n` +
      'Deploy google_apps_script.js as a Web App and put the /exec URL in .env.'
    );
  }

  const url = String(raw).trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Apps Script URL for ${label} is not a valid URL: ` + url);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Apps Script URL for ${label} must use https.`);
  }
  if (parsed.hostname !== 'script.google.com' && parsed.hostname !== 'script.googleusercontent.com') {
    throw new Error(
      `Apps Script URL for ${label} must point at script.google.com. Got: ` + parsed.hostname
    );
  }
  if (!parsed.pathname.endsWith('/exec')) {
    throw new Error(
      `Apps Script URL for ${label} must end in /exec (the deployment URL), not /edit or /dev.`
    );
  }

  return url;
}

/**
 * contextFor — resolves which sheet a group talks to.
 *
 * requireGroup throws on an unknown or missing id, which is the whole point:
 * a request that cannot say which group it belongs to must fail rather than
 * fall back to some default sheet and write one group's data into another's.
 *
 * @param {string} groupId
 * @returns {{url: string, token: string, groupId: string, label: string}}
 */
function contextFor(groupId) {
  const group = groups.requireGroup(groupId);
  return {
    groupId: group.id,
    label: group.displayName,
    url: validateWebAppUrl(group.sheetUrl, group.displayName),
    token: group.sheetToken,
    spreadsheetId: group.sheetId || null
  };
}

/**
 * forGroup — a sheets client bound to exactly one group.
 *
 * The only way to reach a sheet. Every method is the same as before with the
 * group already applied, so a caller cannot accidentally omit it.
 *
 * @param {string} groupId
 * @returns {Object} The same API, bound to that group's sheet
 */
function forGroup(groupId) {
  const ctx = contextFor(groupId);
  // With a sheet id and a service account, the posting path talks to the
  // Sheets API directly: under a second a call instead of 3–35s, and none of
  // the Web App's intermittent 404s. Everything else stays on the Apps Script.
  const useDirect = Boolean(ctx.spreadsheetId) && direct.isConfigured();
  const bound = {};
  API_NAMES.forEach((name) => {
    if (useDirect && direct.DIRECT[name]) {
      bound[name] = async (...args) => {
        try {
          return await direct.DIRECT[name](ctx, ...args);
        } catch (err) {
          // An old-layout tab needs the Apps Script's column migration first.
          if (err.needsAppsScript) return module.exports[`_${name}`](ctx, ...args);
          throw err;
        } finally {
          // Dashboard reads cached from the Apps Script must not outlive a write.
          if (direct.WRITES.has(name)) invalidateReads(ctx);
        }
      };
    } else {
      bound[name] = (...args) => module.exports[`_${name}`](ctx, ...args);
    }
  });
  bound.groupId = ctx.groupId;
  bound.label = ctx.label;
  bound.direct = useDirect;
  return bound;
}

/** True when a group has everything it needs to be reachable. */
function isConfigured(groupId) {
  try {
    contextFor(groupId || String(process.env.LEGACY_GROUP_ID || '').trim());
    return true;
  } catch (err) {
    return false;
  }
}

/** The validated Apps Script URL for one group. */
function getWebAppUrl(groupId) {
  return contextFor(groupId || String(process.env.LEGACY_GROUP_ID || '').trim()).url;
}

/**
 * Reads the dashboards repeat within seconds of each other. Apps Script takes
 * 3–30s to answer each one because it re-reads every subject tab, so they are
 * served from a short per-group cache and identical requests in flight are
 * shared. Any write to a group clears that group's cache, so a curator never
 * sees their own change missing.
 */
const CACHED_GET_ACTIONS = new Set(['getConfig', 'getSubjects', 'getStats', 'getAnalytics', 'listQuestions']);
const READ_CACHE_MS = Number(process.env.SHEET_READ_CACHE_MS) >= 0 && process.env.SHEET_READ_CACHE_MS !== undefined
  ? Number(process.env.SHEET_READ_CACHE_MS)
  : 20000;

/** groupUrl -> Map(queryKey -> { at, promise }) */
const readCache = new Map();

/** Drops every cached read for one sheet. */
function invalidateReads(ctx) {
  readCache.delete(ctx.url);
}

/** Clears the whole read cache (tests, and a manual refresh). */
function clearReadCache() {
  readCache.clear();
}

/**
 * How many times a READ is tried before giving up. Apps Script regularly
 * answers a perfectly good request with a 404 from its redirect host, a 5xx,
 * or nothing at all while it cold-starts; the next attempt almost always works.
 */
const GET_ATTEMPTS = 3;

/** Statuses from Google that mean "busy, try again", not "you asked wrongly". */
const TRANSIENT_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

/** No new attempt is started once a call has been going this long. */
const RETRY_WINDOW_MS = 60000;

/** Most redirects followed. Apps Script uses one (exec → echo). */
const MAX_REDIRECTS = 5;

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Turns an HTTP status from Google into a sentence a curator can act on. */
function describeStatus(status, statusText, attempts) {
  const tried = attempts > 1 ? ` (tried ${attempts} times)` : '';
  if (status === 404) {
    return `Google Sheets answered 404 Not Found${tried}. Apps Script does this when it is overloaded, ` +
      'and also when the deployment was removed — if it keeps happening, check the /exec URL in .env ' +
      'still matches Deploy → Manage deployments.';
  }
  if (status === 429) return `Google Sheets is rate-limiting this script${tried}. Wait a minute and try again.`;
  if (status >= 500) return `Google Sheets had a server error (HTTP ${status})${tried}. Try again in a minute.`;
  return `Google Sheets request failed with status ${status} ${statusText || ''}`.trim() + tried;
}

/**
 * fetchOnce — one Apps Script call, following redirects by hand.
 *
 * Following them ourselves is what lets a failure say WHERE it happened.
 * A POST is executed by the /exec hop; everything after that only fetches
 * the answer. So a POST that failed after /exec answered must never be sent
 * again — it may already have written — while one refused by /exec itself
 * (429, 5xx) never ran and is safe to repeat.
 *
 * @returns {Promise<{status: number, text: string, executed: boolean}>}
 */
async function fetchOnce(url, init, signal) {
  let current = url;
  let options = Object.assign({}, init, { redirect: 'manual', signal });
  let executed = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, options);
    if (hop === 0 && response.status >= 300 && response.status < 400) executed = true;

    const location = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('location')
      : null;
    if (response.status >= 300 && response.status < 400 && location) {
      // Drain so the socket is released, then follow as a GET, as browsers do.
      try { await response.text(); } catch (err) { /* ignore */ }
      current = new URL(location, current).toString();
      options = { method: 'GET', redirect: 'manual', signal };
      continue;
    }

    const text = await response.text();
    return { status: response.status, statusText: response.statusText || '', text, executed: executed || response.ok };
  }
  const err = new Error('Google Sheets redirected too many times.');
  err.transient = true;
  err.executed = executed;
  throw err;
}

/**
 * request — performs one Apps Script call and returns the parsed JSON body.
 *
 * @param {{url: string, token: string}} ctx Which sheet to talk to
 * @param {'GET'|'POST'} method HTTP method
 * @param {Object} params Query parameters (GET) or body fields (POST)
 * @returns {Promise<Object>} Parsed response payload
 */
async function request(ctx, method, params) {
  if (method !== 'GET') {
    // A write changes what every cached read would say.
    invalidateReads(ctx);
    try {
      return await requestUncached(ctx, method, params);
    } finally {
      // Reads that started before the write finished may hold the old answer.
      invalidateReads(ctx);
    }
  }

  if (!CACHED_GET_ACTIONS.has(params.action) || READ_CACHE_MS <= 0) {
    return requestUncached(ctx, method, params);
  }

  const key = JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
  let perSheet = readCache.get(ctx.url);
  if (!perSheet) { perSheet = new Map(); readCache.set(ctx.url, perSheet); }

  const hit = perSheet.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < READ_CACHE_MS)) return hit.promise;

  const entry = { at: Date.now(), pending: true, promise: null };
  entry.promise = requestUncached(ctx, method, params).then(
    (result) => { entry.pending = false; entry.at = Date.now(); return result; },
    (err) => { if (perSheet.get(key) === entry) perSheet.delete(key); throw err; }
  );
  perSheet.set(key, entry);
  return entry.promise;
}

async function requestUncached(ctx, method, params) {
  const baseUrl = ctx.url;
  const token = ctx.token;

  let url;
  let init;
  if (method === 'GET') {
    const query = new URLSearchParams();
    Object.keys(params).forEach((key) => {
      if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
        query.set(key, String(params[key]));
      }
    });
    if (token) query.set('token', token);
    url = `${baseUrl}?${query.toString()}`;
    init = { method: 'GET' };
  } else {
    const body = Object.assign({}, params);
    if (token) body.token = token;
    url = baseUrl;
    init = {
      method: 'POST',
      // Apps Script only receives e.postData.contents intact with text/plain;
      // application/json triggers a CORS preflight it cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    };
  }

  // Reads are always safe to repeat. A write is repeated only when Google
  // turned it away before the script ran (see fetchOnce).
  const attempts = method === 'GET' ? GET_ATTEMPTS : 2;
  let lastError = null;
  let reply = null;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // AbortController gives us a hard timeout; without it a stalled Apps
    // Script would hold the request open indefinitely.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let retryable = false;
    try {
      reply = await fetchOnce(url, init, controller.signal);
      if (reply.status >= 200 && reply.status < 300) { lastError = null; break; }
      lastError = new Error(describeStatus(reply.status, reply.statusText, attempt));
      lastError.upstreamStatus = reply.status;
      retryable = TRANSIENT_STATUSES.has(reply.status) && (method === 'GET' || !reply.executed);
    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = new Error(
          `Google Sheets did not answer within ${REQUEST_TIMEOUT_MS / 1000}s` +
          (attempt > 1 ? ` (tried ${attempt} times)` : '') + '. Apps Script is slow right now — try again in a minute.'
        );
        lastError.transient = true;
        // A write that timed out may still be running, so it is never resent.
        retryable = method === 'GET';
      } else {
        lastError = new Error('Google Sheets request failed: ' + err.message);
        lastError.transient = true;
        retryable = method === 'GET' || err.executed === false;
      }
    } finally {
      clearTimeout(timer);
    }

    if (!retryable || attempt === attempts) break;
    // Two slow attempts already cost the curator a minute and a half; a third
    // would only make the page look hung. Say so instead.
    if (Date.now() - startedAt > RETRY_WINDOW_MS) break;
    await sleepMs(RETRY_BASE_DELAY_MS * attempt);
  }

  if (lastError) throw lastError;

  const text = reply.text;
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error('Google Sheets response exceeded the size limit.');
  }

  // Apps Script answers with HTML in two very different situations, and calling
  // both a "sign-in page" sent me chasing a deployment setting when the real
  // message — a data-validation rule rejecting a write — was sitting in the
  // body. Separate them, and quote what the page actually says.
  if (/<!doctype html|<html/i.test(text)) {
    if (/accounts\.google\.com|ServiceLogin/i.test(text)) {
      throw new Error(
        'Google Apps Script returned a sign-in page. Redeploy the Web App with "Who has access: Anyone".'
      );
    }
    // An uncaught error inside the script. The useful sentence is in the page.
    const detail = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const message = (detail.match(/(?:Error|Exception)[:\s]+([^]{0,300})/i) || [null, detail])[1];
    throw new Error('Google Apps Script failed: ' + String(message).slice(0, 300));
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    throw new Error('Google Sheets returned a non-JSON response: ' + text.slice(0, 180));
  }

  if (result.success === false) {
    const message = String(result.error || 'Unknown Google Sheets API error');

    // "Unknown POST action: bulkDelete" means the script pasted into this
    // sheet is older than the code calling it. Apps Script is not deployed by
    // merging or by `vercel deploy` — it is a copy-paste into each sheet's
    // script editor — so this is the one failure mode that looks like a broken
    // feature and is really a missed manual step. The raw message named the
    // action and nothing else, which told a curator nothing about what to do.
    const stale = message.match(/^Unknown (?:POST|GET) action: (\w+)/);
    if (stale) {
      const err = new Error(
        `This sheet's Apps Script does not know the "${stale[1]}" action, so it is older than ` +
        'the dashboard. Open the sheet → Extensions → Apps Script, paste the current ' +
        'apps-script file for this group over what is there, and Deploy → Manage deployments ' +
        '→ edit → Version: New version.'
      );
      // Marked so the API can answer 409 rather than 500: nothing is broken
      // here, a step is outstanding.
      err.statusCode = 409;
      err.staleScript = true;
      err.missingAction = stale[1];
      throw err;
    }

    throw new Error(message);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/** Liveness probe. Also reports whether the script expects a token. */
async function ping(ctx) {
  return request(ctx, 'GET', { action: 'ping' });
}

/** Reads the Config tab (subjects, emojis, thread ids, cron, batch size). */
async function readConfig(ctx) {
  const result = await request(ctx, 'GET', { action: 'getConfig' });
  return result.data || [];
}

/** Lists the sheet tabs that hold questions. */
async function getSubjects(ctx) {
  const result = await request(ctx, 'GET', { action: 'getSubjects' });
  return result.data || [];
}

/**
 * getUnpostedQuestions — next batch of questions eligible for posting.
 *
 * @param {string} subject Subject tab name
 * @param {number} count Maximum questions to return
 * @param {boolean} requireApproved Only return Approved/Scheduled rows.
 *   Defaults to true: an omitted argument must not be the one that publishes
 *   unreviewed Drafts to a paid channel.
 */
async function getUnpostedQuestions(ctx, subject, count = 1, requireApproved = true) {
  const result = await request(ctx, 'GET', {
    action: 'getQuestions',
    subject,
    limit: count,
    requireApproved: requireApproved ? 'true' : ''
  });
  return result.data || [];
}

/** Per-subject total / posted / pending counts. */
async function getStats(ctx) {
  const result = await request(ctx, 'GET', { action: 'getStats' });
  return result.data || [];
}

/** Full analytics payload consumed by the Analytics dashboard. */
async function getAnalytics(ctx) {
  const result = await request(ctx, 'GET', { action: 'getAnalytics' });
  return result.data || null;
}

/** Filtered, paginated question browse. */
async function listQuestions(ctx, filters = {}) {
  const result = await request(ctx, 'GET', Object.assign({ action: 'listQuestions' }, filters));
  return result.data || { total: 0, questions: [], page: 1, totalPages: 1 };
}

/** Reports which of the supplied duplicate hashes already exist. */
async function checkDuplicates(ctx, hashes = []) {
  if (!hashes.length) return { existing: [] };
  const result = await request(ctx, 'GET', { action: 'checkDuplicates', hashes: hashes.join(',') });
  return result.data || { existing: [] };
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/** Writes topic thread ids back into the Config tab. */
async function writeConfig(ctx, configData) {
  await request(ctx, 'POST', { action: 'updateConfig', config: configData });
  return true;
}

/**
 * listPosted — posted rows carrying a Telegram message id.
 *
 * @param {string} subject Subject tab
 * @returns {Promise<Array<Object>>} { row, question_id, message_id, status }
 */
async function listPosted(ctx, subject) {
  const result = await request(ctx, 'GET', { action: 'listPosted', subject });
  return result.data || [];
}

/**
 * unpostQuestions — returns rows to the queue after their poll was deleted.
 *
 * @param {string} subject Subject tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @param {string} [status] Status to restore
 * @returns {Promise<number>} Rows returned to the queue
 */
async function unpostQuestions(ctx, subject, rowNumbers, status) {
  if (!rowNumbers || !rowNumbers.length) return 0;
  const result = await request(ctx, 'POST', {
    action: 'unpostQuestions', subject, rowNumbers, status: status || 'Approved'
  });
  return result.unpostedCount || 0;
}

/**
 * claimQuestions — reserves rows for sending before anything is sent.
 *
 * @param {string} subject Subject tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @returns {Promise<{claimed: Array<number>, skipped: Array<Object>}>}
 */
async function claimQuestions(ctx, subject, rowNumbers) {
  if (!rowNumbers || !rowNumbers.length) return { claimed: [], skipped: [] };
  const result = await request(ctx, 'POST', { action: 'claimQuestions', subject, rowNumbers });
  return { claimed: result.claimed || [], skipped: result.skipped || [] };
}

/**
 * releaseQuestions — hands claimed rows back, for a send that never happened.
 *
 * @param {string} subject Subject tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @param {string} [status] Status to restore
 * @returns {Promise<number>} Rows released
 */
async function releaseQuestions(ctx, subject, rowNumbers, status) {
  if (!rowNumbers || !rowNumbers.length) return 0;
  const result = await request(ctx, 'POST', {
    action: 'releaseQuestions', subject, rowNumbers, status: status || 'Approved'
  });
  return result.releasedCount || 0;
}

/**
 * recoverStaleClaims — puts back in the queue rows a killed run left claimed.
 *
 * Rows held for checking are never touched; see recoverStaleClaims in the
 * Apps Script.
 *
 * @param {string} subject Subject tab
 * @param {number} minutes How old a claim must be to count as abandoned
 * @returns {Promise<{recovered: Array<Object>, held: number}>}
 */
async function recoverStaleClaims(ctx, subject, minutes) {
  const result = await request(ctx, 'POST', { action: 'recoverStaleClaims', subject, minutes });
  const data = result.data || {};
  return { recovered: data.recovered || [], held: Number(data.held) || 0 };
}

/**
 * holdQuestions — marks rows that need a person: the poll may be in the
 * channel, but the sheet does not say so. They stay out of the queue and are
 * never recovered automatically.
 *
 * @param {string} subject Subject tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @param {string} [note] What happened, for the Review Notes column
 * @returns {Promise<number>} Rows held
 */
async function holdQuestions(ctx, subject, rowNumbers, note) {
  if (!rowNumbers || !rowNumbers.length) return 0;
  const result = await request(ctx, 'POST', { action: 'holdQuestions', subject, rowNumbers, note: note || '' });
  return result.heldCount || 0;
}

/**
 * markAsPosted — records the full posting trail for a batch of rows.
 *
 * @param {string} subject Subject tab name
 * @param {Array<number>} rowIndices Row indices returned by getUnpostedQuestions
 * @param {string|number} [messageId] Telegram message id of the poll
 * @param {string|number} [threadId] Forum topic thread the poll went to
 * @param {Object} [pollIds] Optional { sheetRowNumber: pollId } map
 */
async function markAsPosted(ctx, subject, rowIndices, messageId = null, threadId = null, pollIds = null) {
  if (!rowIndices || rowIndices.length === 0) return 0;
  const result = await request(ctx, 'POST', {
    action: 'markPosted',
    subject,
    rowIndices,
    messageId: messageId ? String(messageId) : '',
    threadId: threadId ? String(threadId) : '',
    pollIds: pollIds || {}
  });

  // The sheet skips a row it cannot find, and says so by counting zero. This
  // used to fall back to `|| rowIndices.length` and report a clean success, so
  // a question that was never marked looked marked, stayed eligible, and went
  // out to Telegram again on the next run. Surface it instead.
  const updated = Number(result.updatedCount);
  if (!updated) {
    throw new Error(
      `The sheet marked none of row(s) ${rowIndices.join(', ')} in "${subject}" as posted — ` +
      'the row numbers may no longer exist in that tab.'
    );
  }
  return updated;
}

/**
 * bulkDelete — removes many questions from one subject in a single call.
 *
 * @param {string} subject Subject tab name
 * @param {Array<string>} questionIds Question IDs to remove
 * @returns {Promise<Object>} { deletedCount, notFound }
 */
async function bulkDelete(ctx, subject, questionIds) {
  if (!questionIds || !questionIds.length) return { deletedCount: 0, notFound: [] };
  const result = await request(ctx, 'POST', {
    action: 'bulkDelete',
    subject,
    questionIds
  });
  return { deletedCount: result.deletedCount || 0, notFound: result.notFound || [] };
}

/** Appends questions from the dashboard, skipping duplicates by default. */
async function addQuestions(ctx, subject, questions, addedBy, skipDuplicates = true) {
  return request(ctx, 'POST', {
    action: 'addQuestions',
    subject,
    questions,
    added_by: addedBy,
    skipDuplicates
  });
}

/**
 * updateQuestion — applies an allowlisted field patch to one question.
 *
 * `rowNumber` and `verifyText` are a fallback for rows that have no Question ID
 * (written before the 30-column migration, or pasted in by hand). The sheet
 * only acts on the row number when the question text there still matches, so a
 * shifted row can never be edited by mistake.
 */
async function updateQuestion(ctx, subject, questionId, fields, updatedBy, rowNumber, verifyText) {
  return request(ctx, 'POST', {
    action: 'updateQuestion',
    subject,
    questionId,
    fields,
    updated_by: updatedBy,
    rowNumber: rowNumber || '',
    verifyText: verifyText || ''
  });
}

/** Permanently removes one question row. See updateQuestion for the fallback. */
async function deleteQuestion(ctx, subject, questionId, rowNumber, verifyText) {
  return request(ctx, 'POST', {
    action: 'deleteQuestion',
    subject,
    questionId,
    rowNumber: rowNumber || '',
    verifyText: verifyText || ''
  });
}

/**
 * queueResult — the one shape every queue write answers with.
 *
 * These three used to return a bare count, and a bare 0 is the least useful
 * answer this app can give: the dashboard printed a line per id as though it
 * had worked and then "0 question(s) queued" underneath. `notFound` and
 * `skipped` are what turn that into a sentence a curator can act on. An older
 * Apps Script sends neither, so both default to empty rather than undefined.
 */
function queueResult(result) {
  return {
    updatedCount: Number(result && result.updatedCount) || 0,
    notFound: Array.isArray(result && result.notFound) ? result.notFound : [],
    skipped: Array.isArray(result && result.skipped) ? result.skipped : []
  };
}

/** Sets Status on many questions at once. */
async function bulkStatus(ctx, subject, questionIds, status, updatedBy) {
  return queueResult(await request(ctx, 'POST', {
    action: 'bulkStatus',
    subject,
    questionIds,
    status,
    updated_by: updatedBy
  }));
}

/** Stamps Scheduled For and flips Status to Scheduled. */
async function scheduleQuestions(ctx, subject, questionIds, scheduledFor, updatedBy) {
  return queueResult(await request(ctx, 'POST', {
    action: 'scheduleQuestions',
    subject,
    questionIds,
    scheduledFor,
    updated_by: updatedBy
  }));
}

/**
 * markDeleted — records that a poll is no longer in the channel.
 *
 * Posted stays YES: the question WAS posted, and leaving it that way is what
 * keeps a question someone deleted from quietly going back out.
 */
async function markDeleted(ctx, subject, rowNumbers, note) {
  const result = await request(ctx, 'POST', {
    action: 'markDeleted', subject, rowNumbers, note: note || ''
  });
  return result.markedCount || 0;
}

/**
 * formatQuestions — puts one subject tab back to the canonical layout.
 *
 * The way back for a tab an upload turned navy from top to bottom. On the
 * Apps Script route this is formatSheetHeaders, which has always been there —
 * it simply had no way to be asked for from outside the script editor.
 */
async function formatQuestions(ctx, subject) {
  const result = await request(ctx, 'POST', { action: 'formatQuestions', subject });
  return result.data || { subject, rows: 0 };
}

/**
 * unscheduleQuestions — the reverse of scheduleQuestions.
 *
 * A sheet whose Apps Script predates this action still has to be able to
 * unqueue, so the fallback is a plain bulkStatus. That restores the status but
 * leaves Scheduled For as it was, which is said out loud in `partial` rather
 * than left for the curator to discover in the sheet.
 */
async function unscheduleQuestions(ctx, subject, questionIds, status, updatedBy) {
  try {
    return queueResult(await request(ctx, 'POST', {
      action: 'unscheduleQuestions',
      subject,
      questionIds,
      status,
      updated_by: updatedBy
    }));
  } catch (err) {
    if (!err.staleScript) throw err;
    const fallback = await bulkStatus(ctx, subject, questionIds, status || 'Approved', updatedBy);
    return Object.assign(fallback, {
      partial: 'This sheet\'s Apps Script is too old to clear the "Scheduled For" column, so the ' +
        'status was changed but the old target time is still in the sheet.'
    });
  }
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/**
 * getSubscriber — one member by Telegram id.
 *
 * @param {string|number} telegramId
 * @returns {Promise<Object|null>} The member, or null when they have never paid
 */
async function getSubscriber(ctx, telegramId) {
  const result = await request(ctx, 'GET', { action: 'getSubscriber', telegramId });
  return result.data || null;
}

/** Filtered, paginated member list for the Members dashboard. */
async function listSubscribers(ctx, filters = {}) {
  const result = await request(ctx, 'GET', Object.assign({ action: 'listSubscribers' }, filters));
  return result.data || { total: 0, subscribers: [], page: 1, totalPages: 1 };
}

/**
 * getExpiring — active members whose access ends within `days`.
 * Pass 0 for those already past expiry.
 */
async function getExpiring(ctx, days = 0) {
  const result = await request(ctx, 'GET', { action: 'getExpiring', days });
  return result.data || [];
}

/** Revenue and membership totals. */
async function getRevenue(ctx) {
  const result = await request(ctx, 'GET', { action: 'getRevenue' });
  return result.data || null;
}

/**
 * upsertSubscriber — creates or updates a member row.
 * Set `is_payment` to also append to the Payments log and advance the
 * lifetime revenue and renewal counters.
 *
 * @param {Object} subscriber Fields to write; telegram_id is required
 * @param {string} [event] Label recorded in the payment log
 */
async function upsertSubscriber(ctx, subscriber, event = 'payment') {
  const result = await request(ctx, 'POST', { action: 'upsertSubscriber', subscriber, event });
  return result.data;
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/** Every stored bot setting as { key: value }. */
async function getBotSettings(ctx) {
  const result = await request(ctx, 'GET', { action: 'getBotSettings' });
  return result.data || {};
}

/** Writes the given settings; returns everything stored afterwards. */
async function updateBotSettings(ctx, settings, updatedBy) {
  const result = await request(ctx, 'POST', { action: 'updateBotSettings', settings, updated_by: updatedBy });
  return result.data || {};
}

/**
 * createTicket — records a support ticket. Idempotent on ticket_id.
 *
 * @param {Object} ticket ticket_id, telegram_id, username, name, category, bot, message
 */
async function createTicket(ctx, ticket) {
  const result = await request(ctx, 'POST', { action: 'createTicket', ticket });
  return result.data || null;
}

/** Adds a message to a ticket's thread. Resolves null for an unknown ticket. */
async function appendTicketMessage(ctx, ticketId, { author, text, status, handledBy, logAction } = {}) {
  const result = await request(ctx, 'POST', {
    action: 'appendTicketMessage', ticketId, author, text, status: status || '', handledBy: handledBy || '',
    logAction: logAction || ''
  });
  return result.data || null;
}

/** Closes (closed) or reopens (in_progress) a ticket. Resolves null for an unknown ticket. */
async function setTicketStatus(ctx, ticketId, status, handledBy) {
  const result = await request(ctx, 'POST', { action: 'setTicketStatus', ticketId, status, handledBy: handledBy || '' });
  return result.data || null;
}

/** Sets the group id a ticket is about ('' for not specified). Resolves null for an unknown ticket. */
async function setTicketGroup(ctx, ticketId, group, handledBy) {
  const result = await request(ctx, 'POST', { action: 'setTicketGroup', ticketId, group: group || '', handledBy: handledBy || '' });
  return result.data || null;
}

/** Newest-first ticket list with per-status counts. */
async function listTickets(ctx, filters = {}) {
  const result = await request(ctx, 'GET', Object.assign({ action: 'listTickets' }, filters));
  return result.data || { total: 0, tickets: [], counts: {}, page: 1, totalPages: 1 };
}

/**
 * logTicketEvent — records something done on a ticket that is not a message
 * (a payment check, an invite that could not be sent). Resolves null for an
 * unknown ticket.
 */
async function logTicketEvent(ctx, ticketId, { who, role, action, details } = {}) {
  const result = await request(ctx, 'POST', {
    action: 'logTicketEvent', ticketId, who: who || '', role: role || '', logAction: action, details: details || ''
  });
  return result.data || null;
}

/** Every coupon in the sheet. */
async function listCoupons(ctx) {
  const result = await request(ctx, 'GET', { action: 'listCoupons' });
  return result.data || [];
}

/** One coupon plus how often this student already used it, or null. */
async function getCoupon(ctx, code, telegramId) {
  const result = await request(ctx, 'GET', { action: 'getCoupon', code, telegramId });
  return result.data || null;
}

/** Creates or updates a coupon; resolves the stored coupon. */
async function upsertCoupon(ctx, coupon, updatedBy) {
  const result = await request(ctx, 'POST', { action: 'upsertCoupon', coupon, updated_by: updatedBy });
  return result.data || null;
}

/** Deletes an unused coupon; resolves { deleted, reason }. */
async function deleteCoupon(ctx, code) {
  const result = await request(ctx, 'POST', { action: 'deleteCoupon', code });
  return result.data || { deleted: false };
}

/** Logs a paid checkout that used a code. Idempotent on payment_id. */
async function recordRedemption(ctx, redemption) {
  const result = await request(ctx, 'POST', { action: 'recordRedemption', redemption });
  return result.data || { recorded: false };
}

/** Newest-first redemptions, optionally for one code. */
async function listRedemptions(ctx, filters = {}) {
  const result = await request(ctx, 'GET', Object.assign({ action: 'listRedemptions' }, filters));
  return result.data || { total: 0, redemptions: [] };
}

/**
 * findPayment — where a Razorpay payment id is recorded in this sheet, from the
 * Payments log or a member row. Resolves null when it is not.
 */
async function findPayment(ctx, paymentId) {
  const result = await request(ctx, 'GET', { action: 'findPayment', paymentId });
  return result.data || null;
}

/** Queues, today's numbers, response times and per-admin activity for the Support page. */
async function getSupportStats(ctx, { days } = {}) {
  const result = await request(ctx, 'GET', { action: 'getSupportStats', days: days || '' });
  return result.data || null;
}

/** One ticket including its whole conversation, or null. */
async function getTicket(ctx, ticketId) {
  const result = await request(ctx, 'GET', { action: 'getTicket', ticketId });
  return result.data || null;
}

module.exports = {
  forGroup,
  contextFor,
  isConfigured,
  getWebAppUrl,
  validateWebAppUrl,
  sheetRowOf,
  clearReadCache,
  API_NAMES
};

// ---------------------------------------------------------------------------
// Transitional single-group API
// ---------------------------------------------------------------------------
// TEMPORARY. These are the old, group-less exports, bound to the group named
// by LEGACY_GROUP_ID. They exist so the running system keeps selling passes
// and posting questions while call sites move to forGroup() one file at a
// time — a migration that touches six files, and doing it in one commit means
// every one of them is unverifiable at once.
//
// They are the one place a default group exists, which is exactly what this
// design forbids, so they are deliberately loud: without LEGACY_GROUP_ID set
// they throw rather than guess. DELETE THIS BLOCK once no caller uses it.

/** The migration group, or a clear error if nobody has named one. */
function legacyGroupId() {
  const id = String(process.env.LEGACY_GROUP_ID || '').trim();
  if (!id) {
    throw new Error(
      'This call did not name a group and LEGACY_GROUP_ID is not set. ' +
      'Use sheets.forGroup(groupId) — there is no default group.'
    );
  }
  return id;
}

API_NAMES.forEach((name) => {
  module.exports[name] = (...args) => forGroup(legacyGroupId())[name](...args);
});

// The raw, context-taking implementations. forGroup() binds these; nothing
// outside this module should call them directly, which is what the underscore
// says. Listed explicitly rather than resolved by name at runtime, so a typo
// is a startup crash instead of a method that is silently missing.
const IMPLEMENTATIONS = {
  ping, readConfig, getSubjects, writeConfig, getUnpostedQuestions, markAsPosted,
  getStats, getAnalytics, listQuestions, checkDuplicates, addQuestions,
  updateQuestion, deleteQuestion, bulkDelete, claimQuestions, releaseQuestions,
  recoverStaleClaims, holdQuestions,
  unpostQuestions, listPosted, markDeleted, bulkStatus, scheduleQuestions,
  unscheduleQuestions, formatQuestions, getSubscriber,
  listSubscribers, getExpiring, getRevenue, upsertSubscriber,
  getBotSettings, updateBotSettings, createTicket, appendTicketMessage,
  setTicketStatus, listTickets, getTicket, logTicketEvent, listCoupons, getCoupon,
  upsertCoupon, deleteCoupon, recordRedemption, listRedemptions, getSupportStats, findPayment, setTicketGroup
};

API_NAMES.forEach((name) => {
  // Every operation must exist, or a caller would get "not a function" from
  // somewhere far from the cause.
  if (typeof IMPLEMENTATIONS[name] !== 'function') {
    throw new Error(`sheets.js: API_NAMES lists "${name}" but there is no such function.`);
  }
  module.exports[`_${name}`] = IMPLEMENTATIONS[name];
});
