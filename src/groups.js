// ============================================================================
// Group registry (src/groups.js)
// ============================================================================
// One place that knows which groups exist, where each keeps its data, and what
// each charges. Everything else asks here rather than reading the environment
// directly, so there is exactly one answer to "which sheet is this?".
//
// The isolation this system promises rests on one rule, enforced below:
//
//   THERE IS NO DEFAULT GROUP.
//
// Every call that touches a sheet must name its group. Code that forgets fails
// loudly with "no group id given" instead of quietly writing UPSC questions
// into the Telugu newspaper sheet — a mistake that is invisible until someone
// notices the wrong content in a paid group, by which point it has been posted.
//
// Shape lives in groups.config.json, which is safe to commit. Secrets live in
// .env, keyed by each group's envPrefix.
// ============================================================================

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '..', 'groups.config.json');

/** Parsed config, read once. */
let config = null;

/** Loads and validates groups.config.json. */
function loadConfig() {
  if (config) return config;

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read groups.config.json: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`groups.config.json is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed.groups) || !parsed.groups.length) {
    throw new Error('groups.config.json defines no groups.');
  }

  const seen = new Set();
  parsed.groups.forEach((group) => {
    if (!group.id) throw new Error('A group in groups.config.json has no id.');
    if (seen.has(group.id)) {
      // Two groups sharing an id would make routing ambiguous, and the loser
      // would silently receive the winner's data.
      throw new Error(`groups.config.json has two groups with id "${group.id}".`);
    }
    seen.add(group.id);
    if (!group.envPrefix) {
      throw new Error(`Group "${group.id}" has no envPrefix, so its secrets cannot be found.`);
    }
  });

  config = parsed;
  return config;
}

/** Forgets the cached config. Tests use this after changing the environment. */
function reset() {
  config = null;
}

/**
 * listGroups — every configured group, with its secrets resolved.
 *
 * @returns {Array<Object>} Groups in configuration order
 */
function listGroups() {
  return loadConfig().groups.map((group) => decorate(group));
}

/**
 * getGroup — one group by id.
 *
 * @param {string} groupId
 * @returns {Object|null} The group, or null when the id is unknown
 */
function getGroup(groupId) {
  if (!groupId) return null;
  const found = loadConfig().groups.find((g) => g.id === String(groupId));
  return found ? decorate(found) : null;
}

/**
 * requireGroup — getGroup, but refuses to continue on an unknown id.
 *
 * Used by anything that is about to read or write data. A typo'd or missing
 * group id must stop the request, never fall back to a default.
 *
 * @param {string} groupId
 * @returns {Object} The group
 */
function requireGroup(groupId) {
  if (!groupId) {
    throw new Error('No group id given. Every data operation must name its group.');
  }
  const group = getGroup(groupId);
  if (!group) {
    const known = listGroups().map((g) => g.id).join(', ');
    throw new Error(`Unknown group "${groupId}". Configured groups: ${known}`);
  }
  return group;
}

/** A human label including the language, e.g. "UPSC (English)". */
function displayName(group) {
  return group.language ? `${group.label} (${group.language})` : group.label;
}

/** Adds the resolved secrets and plans to a raw config entry. */
function decorate(group) {
  const prefix = group.envPrefix;

  // The group that inherits the original single-group setup. Before this
  // system had groups there was one sheet and one Telegram group, named by
  // GOOGLE_SHEET_WEBAPP_URL, SHEET_API_TOKEN and TELEGRAM_PREMIUM_GROUP_ID.
  // Pointing LEGACY_GROUP_ID at one group id lets that setup keep running,
  // unchanged and uninterrupted, while the other four are filled in one at a
  // time — rather than every group being broken until all five are ready.
  const isLegacy = String(process.env.LEGACY_GROUP_ID || '').trim() === group.id;
  const legacy = {
    url: isLegacy ? String(process.env.GOOGLE_SHEET_WEBAPP_URL || '').trim() : '',
    token: isLegacy ? String(process.env.SHEET_API_TOKEN || '').trim() : '',
    chat: isLegacy
      ? String(process.env.TELEGRAM_PREMIUM_GROUP_ID || process.env.TELEGRAM_GROUP_ID || '').trim()
      : '',
    plan: isLegacy ? String(process.env.RAZORPAY_MONTHLY_PLAN_ID || '').trim() : ''
  };

  // A per-group value always wins, so migrating a group is a matter of adding
  // its own variables and never of removing the old ones first.
  const sheetUrl = String(process.env[`SHEET_URL_${prefix}`] || '').trim() || legacy.url;
  const sheetToken = String(process.env[`SHEET_TOKEN_${prefix}`] || '').trim() || legacy.token;
  const telegramGroupId =
    String(process.env[`TELEGRAM_GROUP_${prefix}`] || '').trim() || legacy.chat;
  // The spreadsheet itself, for the direct Sheets API (src/sheets-direct.js).
  // Accepts the bare id or the whole link copied from the browser.
  const sheetIdRaw = String(process.env[`SHEET_ID_${prefix}`] || '').trim();
  const sheetId = (sheetIdRaw.match(/\/d\/([A-Za-z0-9_-]{20,})/) || [null, sheetIdRaw])[1];
  const razorpayPlanId =
    String(process.env[`RAZORPAY_PLAN_${prefix}`] || '').trim() || legacy.plan;

  // Auto-pay only needs a Razorpay plan while a recurring pass is on sale.
  const shapes = loadConfig().planShapes || {};
  const sellsRecurring = Object.keys(group.plans || {})
    .some((planId) => shapes[planId] && shapes[planId].type === 'recurring' && !shapes[planId].retired);

  return Object.assign({}, group, {
    displayName: displayName(group),
    // Falls back to the full name, so a group without one still works.
    shortName: group.shortName || displayName(group),
    sheetUrl,
    sheetToken,
    sheetId,
    telegramGroupId,
    razorpayPlanId,
    // What a group needs before it can be used at all. Reported rather than
    // thrown, so the Health page can list what is missing per group instead of
    // the whole system refusing to start.
    ready: Boolean(sheetUrl && sheetToken && telegramGroupId),
    missing: [
      sheetUrl ? null : `SHEET_URL_${prefix}`,
      sheetToken ? null : `SHEET_TOKEN_${prefix}`,
      telegramGroupId ? null : `TELEGRAM_GROUP_${prefix}`
    ].filter(Boolean),
    // Auto-pay is deliberately NOT part of `ready`: a group with no recurring
    // plan id still sells its one-time passes perfectly well. But it is not
    // silent either — without this the only symptom was a student tapping
    // Monthly Auto-Pay and being told the bot could not create a link.
    autopayReady: Boolean(razorpayPlanId) || !sellsRecurring,
    autopayMissing: razorpayPlanId || !sellsRecurring ? null : `RAZORPAY_PLAN_${prefix}`
  });
}

/**
 * plansFor — the passes this group sells, at this group's prices.
 *
 * Shape comes from planShapes, price from the group. That way a price differs
 * per group without five copies of the same wording drifting apart.
 *
 * A plan marked `retired` in planShapes is no longer sold, so it is left out
 * here — but it still exists for anyone who bought it. getPlanFor finds it by
 * id, because a renewal webhook, a reminder or /cancel for an existing member
 * must keep working after the plan comes off sale.
 *
 * @param {string} groupId
 * @param {Object} [options]
 * @param {boolean} [options.includeRetired] Also return plans no longer sold
 * @returns {Array<Object>} Plan objects, in configuration order
 */
function plansFor(groupId, options = {}) {
  const group = requireGroup(groupId);
  const shapes = loadConfig().planShapes || {};

  return Object.entries(group.plans || {})
    .map(([planId, amountPaise]) => {
      const shape = shapes[planId];
      if (!shape) return null;
      if (shape.retired && !options.includeRetired) return null;
      return Object.assign({}, shape, {
        id: planId,
        amountPaise: Number(amountPaise),
        groupId: group.id,
        // Recurring passes need a Razorpay plan per group, because the amount
        // is baked into the plan and the amounts differ.
        razorpayPlanId: shape.type === 'recurring' ? group.razorpayPlanId : ''
      });
    })
    .filter(Boolean);
}

/**
 * getPlanFor — one plan within one group, retired or not.
 *
 * @param {string} groupId
 * @param {string} planId
 * @param {Object} [options] Passed to plansFor; includeRetired defaults to true
 * @returns {Object|null}
 */
function getPlanFor(groupId, planId, options = {}) {
  return plansFor(groupId, Object.assign({ includeRetired: true }, options))
    .find((p) => p.id === planId) || null;
}

module.exports = {
  reset,
  listGroups,
  getGroup,
  requireGroup,
  plansFor,
  getPlanFor,
  displayName,
  CONFIG_PATH
};
