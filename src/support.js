// ============================================================================
// src/support.js — support tickets and admin-editable bot settings
// ============================================================================
// Pure helpers shared by the payment bot (src/botapp.js) and the dashboard API
// (server.js). Nothing here talks to Telegram or to a sheet directly.
//
// The bot runs on Vercel, where nothing survives between two updates, so a
// support conversation cannot be held in memory. Instead every message the bot
// sends that can be replied to starts with a fixed first line naming what it is
// (a support prompt, a ticket, an admin's reply). A reply to one of those says,
// by itself, which ticket it belongs to — see the parse* functions below.
// ============================================================================

const crypto = require('crypto');

/** Issue types a student picks from. Each has an admin-editable instant answer. */
const CATEGORIES = [
  {
    id: 'payment',
    emoji: '💳',
    label: 'Paid but no access',
    settingKey: 'faq_payment',
    answer:
      'Payments usually confirm within a minute, and your private invite link is sent to this chat ' +
      'as soon as they do.\n\n' +
      '• Send /status — if your pass shows as active, the invite button is right there.\n' +
      '• UPI payments can take up to 15 minutes to confirm at the bank.\n' +
      '• If money left your account and /status still shows no pass after 30 minutes, raise a ticket ' +
      'below with your payment ID or a screenshot and we will sort it out.'
  },
  {
    id: 'invite',
    emoji: '🔗',
    label: 'Invite link not working',
    settingKey: 'faq_invite',
    answer:
      'Invite links are tied to the Telegram account that paid.\n\n' +
      '• Open the link from this same Telegram account — a forwarded link is declined automatically.\n' +
      '• Send /status to get a fresh button for your group.\n' +
      '• Tapping the link sends a join request; it is approved automatically within a few seconds.'
  },
  {
    id: 'renewal',
    emoji: '🔁',
    label: 'Renewal or auto-pay',
    settingKey: 'faq_renewal',
    answer:
      '• One-time passes do not renew — buy again from /plans before they expire and the new days are ' +
      'added on top.\n' +
      '• Monthly Auto-Pay renews itself. Send /cancel to stop future charges; you keep access until ' +
      'the date you have already paid for.\n' +
      '• You get a reminder before a pass runs out.'
  },
  {
    id: 'access',
    emoji: '🚪',
    label: 'Removed from the group',
    settingKey: 'faq_access',
    answer:
      'Members are removed automatically when their pass expires.\n\n' +
      '• Send /status to see your expiry date.\n' +
      '• If it has expired, renew from /plans and you will get a new invite.\n' +
      '• If your pass is still active and you were removed, raise a ticket below.'
  },
  {
    id: 'other',
    emoji: '💬',
    label: 'Something else',
    settingKey: 'faq_other',
    answer: 'Tell us what is going on and an admin will get back to you here in this chat.'
  }
];

/**
 * The settings admins can change without a deploy. Stored in each sheet's
 * "Bot Settings" tab; anything not listed here is ignored when read and
 * refused when written.
 */
const SETTINGS = [
  {
    key: 'support_enabled', label: 'Support tickets enabled', type: 'toggle', default: 'yes',
    hint: 'When "no", /support still shows the answers below but does not accept tickets.'
  },
  {
    key: 'support_hours', label: 'Support hours', type: 'text', maxLength: 120,
    default: 'Mon–Sat, 9 AM – 7 PM IST',
    hint: 'Shown to students when they raise a ticket.'
  },
  {
    key: 'support_response_time', label: 'Expected response time', type: 'text', maxLength: 120,
    default: 'within 24 hours',
    hint: 'Completes the sentence "An admin will reply …".'
  },
  {
    key: 'support_contact', label: 'Fallback contact', type: 'text', maxLength: 120, default: '',
    hint: 'Optional, e.g. @YourAdminHandle or an email. Shown when tickets are switched off.'
  },
  {
    key: 'welcome_note', label: 'Extra /start message', type: 'textarea', maxLength: 1000, default: '',
    hint: 'Optional. Added to the /start greeting, e.g. an offer or an announcement.'
  },
  ...CATEGORIES.map((category) => ({
    key: category.settingKey,
    label: `Answer: ${category.label}`,
    type: 'textarea',
    maxLength: 2000,
    default: category.answer,
    hint: `Shown when a student picks "${category.label}" in /support.`
  }))
];

const SETTING_KEYS = SETTINGS.map((s) => s.key);

const TICKET_STATUSES = ['open', 'answered', 'closed'];

/** Longest message accepted into a ticket; Telegram's own limit is 4096. */
const MAX_MESSAGE_CHARS = 3500;

/** Escapes text before putting it in an HTML-formatted Telegram message. */
function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A category by id, falling back to "other". */
function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}

/** A category by its label, as it appears on a support prompt. */
function categoryByLabel(label) {
  const clean = String(label || '').trim();
  return CATEGORIES.find((c) => c.label === clean) || categoryById('other');
}

/**
 * normaliseSettings — every known setting, stored value or default.
 *
 * A blank stored value falls back to the default for the answers and the
 * toggle, because an empty answer or an empty "enabled" would read as broken
 * rather than as a choice. The optional texts may legitimately be blank.
 *
 * @param {Object} stored Raw { key: value } from the sheet
 * @returns {Object} { key: value } for every key in SETTINGS
 */
function normaliseSettings(stored = {}) {
  const out = {};
  SETTINGS.forEach((def) => {
    const raw = stored && Object.prototype.hasOwnProperty.call(stored, def.key) ? stored[def.key] : undefined;
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    const optional = def.key === 'support_contact' || def.key === 'welcome_note';
    if (!value && !(optional && raw !== undefined)) {
      out[def.key] = def.default;
    } else if (def.type === 'toggle') {
      out[def.key] = /^(no|false|off|0)$/i.test(value) ? 'no' : 'yes';
    } else {
      out[def.key] = value;
    }
  });
  return out;
}

/**
 * validateSettingsPatch — checks a partial update from an admin.
 *
 * @param {Object} patch { key: value }
 * @returns {{ok: boolean, error?: string, value?: Object}}
 */
function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'settings must be an object of { key: value }' };
  }
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: 'No settings given.' };

  const value = {};
  for (const key of keys) {
    const def = SETTINGS.find((s) => s.key === key);
    if (!def) return { ok: false, error: `Unknown setting "${key}". Known: ${SETTING_KEYS.join(', ')}` };

    const text = String(patch[key] === null || patch[key] === undefined ? '' : patch[key]).trim();
    if (def.type === 'toggle') {
      if (!/^(yes|no)$/i.test(text)) return { ok: false, error: `"${key}" must be yes or no.` };
      value[key] = text.toLowerCase();
      continue;
    }
    if (text.length > def.maxLength) {
      return { ok: false, error: `"${key}" is ${text.length} characters; the limit is ${def.maxLength}.` };
    }
    value[key] = text;
  }
  return { ok: true, value };
}

/** Whether students can raise tickets. */
function ticketsEnabled(settings) {
  return normaliseSettings(settings).support_enabled !== 'no';
}

/**
 * newTicketId — T-yymmdd-XXXX, the date in IST.
 *
 * Four base-32 characters give ~1M ids per day, and the sheet refuses a
 * duplicate id by returning the existing row rather than overwriting it.
 */
function newTicketId(now = new Date()) {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const date = String(ist.getUTCFullYear()).slice(2) + pad(ist.getUTCMonth() + 1) + pad(ist.getUTCDate());
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(4);
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += alphabet[bytes[i] % alphabet.length];
  return `T-${date}-${suffix}`;
}

const TICKET_ID_PATTERN = 'T-\\d{6}-[A-Z0-9]{4}';

// ---- Message markers -------------------------------------------------------
// Each is the FIRST line of a message the bot sends, matched with ^ so text a
// student typed further down can never pass for one.

/** First line of the "describe your problem" prompt. */
function promptLine(category) {
  return `📨 Support request · ${category.label}`;
}

/** The category a reply to a support prompt belongs to, or null. */
function parsePrompt(text) {
  const match = String(text || '').match(/^📨 Support request · (.+)/);
  return match ? categoryByLabel(match[1]) : null;
}

/** First line of every ticket message in the admin support chat. */
function ticketHeader(ticketId, telegramId) {
  return `🎫 ${ticketId} · user ${telegramId}`;
}

/** { ticketId, telegramId } from a ticket message in the support chat, or null. */
function parseTicketHeader(text) {
  const match = String(text || '').match(new RegExp(`^🎫 (${TICKET_ID_PATTERN}) · user (\\d+)`));
  return match ? { ticketId: match[1], telegramId: match[2] } : null;
}

/** First line of an admin's answer as the student sees it. */
function replyLine(ticketId) {
  return `💬 Support reply · ${ticketId}`;
}

/** The ticket id an answer the student is replying to belongs to, or null. */
function parseReplyLine(text) {
  const match = String(text || '').match(new RegExp(`^(?:💬 Support reply|📨 Ticket received) · (${TICKET_ID_PATTERN})`));
  return match ? match[1] : null;
}

/** First line of the confirmation a student gets after raising a ticket. */
function receivedLine(ticketId) {
  return `📨 Ticket received · ${ticketId}`;
}

/**
 * supportChatFor — where a family's tickets are sent.
 *
 * SUPPORT_CHAT_<FAMILY> (e.g. SUPPORT_CHAT_UPSC for TELEGRAM_PAYBOT_UPSC) wins
 * over the shared SUPPORT_CHAT_ID. The matching *_THREAD_* variable names a
 * forum topic in that chat. The bot must be a member of the chat.
 *
 * @param {string} payBotEnv
 * @returns {{chatId: string, threadId: number|null}|null}
 */
function supportChatFor(payBotEnv) {
  const family = String(payBotEnv || '').replace(/^TELEGRAM_PAYBOT_/, '');
  const read = (name) => String(process.env[name] || '').trim();
  const own = family ? read(`SUPPORT_CHAT_${family}`) : '';
  const chatId = own || read('SUPPORT_CHAT_ID');
  if (!/^-?\d+$/.test(chatId)) return null;
  // A topic id only means something in the chat it came from.
  const thread = own ? read(`SUPPORT_THREAD_${family}`) : read('SUPPORT_THREAD_ID');
  return { chatId, threadId: /^\d+$/.test(thread) ? Number(thread) : null };
}

/** The numeric bot id every token starts with. */
function botIdFromToken(token) {
  const match = String(token || '').trim().match(/^(\d+):/);
  return match ? match[1] : '';
}

/**
 * parseCommand — "/set@MyBot key value" → { name: 'set', mention: 'MyBot', args: 'key value' }.
 *
 * @returns {{name: string, mention: string, args: string}|null}
 */
function parseCommand(text) {
  const match = String(text || '').match(/^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), mention: match[2] || '', args: (match[3] || '').trim() };
}

/** Text or caption of a message, trimmed to what a ticket stores. */
function messageText(message) {
  if (!message) return '';
  return String(message.text || message.caption || '').trim().slice(0, MAX_MESSAGE_CHARS);
}

/** True when a message carries something other than plain text worth copying. */
function hasMedia(message) {
  return Boolean(message && (message.photo || message.document || message.video ||
    message.voice || message.audio || message.video_note || message.animation));
}

/**
 * createSettingsCache — settings read at most once per ttl per instance.
 *
 * A failed read (stale Apps Script, Sheets down) serves defaults for a short
 * while instead of retrying on every message, so a sheet problem slows nothing
 * down and never stops the bot answering.
 *
 * @param {{load: Function, ttlMs?: number, failureTtlMs?: number, now?: Function}} options
 */
function createSettingsCache({ load, ttlMs = 60000, failureTtlMs = 30000, now = Date.now }) {
  let cached = null;
  let expiresAt = 0;
  let inflight = null;

  async function get() {
    if (cached && now() < expiresAt) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        cached = normaliseSettings(await load());
        expiresAt = now() + ttlMs;
      } catch (err) {
        console.error('[support] could not read bot settings, using defaults:', err.message);
        cached = normaliseSettings({});
        expiresAt = now() + failureTtlMs;
      } finally {
        inflight = null;
      }
      return cached;
    })();
    return inflight;
  }

  function invalidate() {
    cached = null;
    expiresAt = 0;
  }

  return { get, invalidate };
}

/**
 * createThrottle — at most `limit` events per key per window, per instance.
 *
 * Best effort only: serverless instances do not share memory. It exists to
 * stop one person flooding the admin chat from a single burst.
 */
function createThrottle({ limit = 5, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return true;
  };
}

module.exports = {
  CATEGORIES,
  SETTINGS,
  SETTING_KEYS,
  TICKET_STATUSES,
  MAX_MESSAGE_CHARS,
  esc,
  categoryById,
  categoryByLabel,
  normaliseSettings,
  validateSettingsPatch,
  ticketsEnabled,
  newTicketId,
  promptLine,
  parsePrompt,
  ticketHeader,
  parseTicketHeader,
  replyLine,
  parseReplyLine,
  receivedLine,
  supportChatFor,
  botIdFromToken,
  parseCommand,
  messageText,
  hasMedia,
  createSettingsCache,
  createThrottle
};
