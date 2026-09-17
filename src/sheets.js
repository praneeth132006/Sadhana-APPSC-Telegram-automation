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

/** Hard ceiling on how long we wait for Apps Script before giving up. */
const REQUEST_TIMEOUT_MS = 30000;

/** Largest upstream response we will buffer (Apps Script pages are far smaller). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const groups = require('./groups');

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
const API_NAMES = ['ping', 'readConfig', 'getSubjects', 'writeConfig', 'getUnpostedQuestions', 'markAsPosted', 'getStats', 'getAnalytics', 'listQuestions', 'checkDuplicates', 'addQuestions', 'updateQuestion', 'deleteQuestion', 'bulkDelete', 'claimQuestions', 'releaseQuestions', 'unpostQuestions', 'listPosted', 'bulkStatus', 'scheduleQuestions', 'getSubscriber', 'listSubscribers', 'getExpiring', 'getRevenue', 'upsertSubscriber', 'getBotSettings', 'updateBotSettings', 'createTicket', 'appendTicketMessage', 'setTicketStatus', 'listTickets', 'getTicket', 'logTicketEvent', 'listCoupons', 'getCoupon', 'upsertCoupon', 'deleteCoupon', 'recordRedemption', 'listRedemptions'];

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
    token: group.sheetToken
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
  const bound = {};
  API_NAMES.forEach((name) => {
    bound[name] = (...args) => module.exports[`_${name}`](ctx, ...args);
  });
  bound.groupId = ctx.groupId;
  bound.label = ctx.label;
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
 * request — performs one Apps Script call and returns the parsed JSON body.
 *
 * @param {{url: string, token: string}} ctx Which sheet to talk to
 * @param {'GET'|'POST'} method HTTP method
 * @param {Object} params Query parameters (GET) or body fields (POST)
 * @returns {Promise<Object>} Parsed response payload
 */
async function request(ctx, method, params) {
  const baseUrl = ctx.url;
  const token = ctx.token;

  // AbortController gives us a hard timeout; without it a stalled Apps Script
  // would hold the request open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    if (method === 'GET') {
      const query = new URLSearchParams();
      Object.keys(params).forEach((key) => {
        if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
          query.set(key, String(params[key]));
        }
      });
      if (token) query.set('token', token);

      response = await fetch(`${baseUrl}?${query.toString()}`, {
        redirect: 'follow',
        signal: controller.signal
      });
    } else {
      const body = Object.assign({}, params);
      if (token) body.token = token;

      response = await fetch(baseUrl, {
        method: 'POST',
        redirect: 'follow',
        // Apps Script only receives e.postData.contents intact with text/plain;
        // application/json triggers a CORS preflight it cannot answer.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Google Sheets request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw new Error('Google Sheets request failed: ' + err.message);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`Google Sheets request failed with status ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
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

/** Sets Status on many questions at once. */
async function bulkStatus(ctx, subject, questionIds, status, updatedBy) {
  const result = await request(ctx, 'POST', {
    action: 'bulkStatus',
    subject,
    questionIds,
    status,
    updated_by: updatedBy
  });
  return result.updatedCount || 0;
}

/** Stamps Scheduled For and flips Status to Scheduled. */
async function scheduleQuestions(ctx, subject, questionIds, scheduledFor, updatedBy) {
  const result = await request(ctx, 'POST', {
    action: 'scheduleQuestions',
    subject,
    questionIds,
    scheduledFor,
    updated_by: updatedBy
  });
  return result.updatedCount || 0;
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

/** Sets a ticket to open, answered or closed. Resolves null for an unknown ticket. */
async function setTicketStatus(ctx, ticketId, status, handledBy) {
  const result = await request(ctx, 'POST', { action: 'setTicketStatus', ticketId, status, handledBy: handledBy || '' });
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
  unpostQuestions, listPosted, bulkStatus, scheduleQuestions, getSubscriber,
  listSubscribers, getExpiring, getRevenue, upsertSubscriber,
  getBotSettings, updateBotSettings, createTicket, appendTicketMessage,
  setTicketStatus, listTickets, getTicket, logTicketEvent, listCoupons, getCoupon,
  upsertCoupon, deleteCoupon, recordRedemption, listRedemptions
};

API_NAMES.forEach((name) => {
  if (typeof IMPLEMENTATIONS[name] !== 'function') {
    throw new Error(`sheets.js: API_NAMES lists "${name}" but there is no such function.`);
  }
  module.exports[`_${name}`] = IMPLEMENTATIONS[name];
});
