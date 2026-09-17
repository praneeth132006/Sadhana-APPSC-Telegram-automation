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

/**
 * Issue types a student picks from. Each has an admin-editable instant answer.
 * `aliases` are labels a category used to have, so a support prompt sent
 * before a rename still opens the right kind of ticket. `hidden` keeps a
 * category readable on old tickets without offering it any more.
 */
const CATEGORIES = [
  {
    id: 'payment',
    emoji: '💳',
    label: 'Paid, but no invite link',
    aliases: ['Paid but no access'],
    settingKey: 'faq_payment',
    answer:
      'Payments usually confirm within a minute, and your private invite link is sent to this chat ' +
      'as soon as they do.\n\n' +
      '• Send /status — if your pass shows as active, the invite button is right there.\n' +
      '• UPI payments can take up to 15 minutes to confirm at the bank.\n' +
      '• If money left your account and /status still shows no pass after 30 minutes, raise a ticket ' +
      'below with your payment ID (it starts with pay_) or a screenshot and we will sort it out.'
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
    id: 'payment_failed',
    emoji: '❌',
    label: 'Payment failed or money deducted',
    settingKey: 'faq_payment_failed',
    answer:
      '• If the payment page showed an error, no pass was bought — you can simply try again from /plans.\n' +
      '• If money was deducted but the payment failed, your bank normally returns it within 5–7 working days.\n' +
      '• If you are not sure, raise a ticket below with your payment ID (starts with pay_) or a screenshot.'
  },
  {
    id: 'coupon',
    emoji: '🎟',
    label: 'Coupon code not working',
    settingKey: 'faq_coupon',
    answer:
      '• Codes are not case-sensitive, but must be typed exactly, without spaces.\n' +
      '• A code can expire, be switched off, or reach its usage limit, and most codes work once per student.\n' +
      '• Apply the code from /plans before you pay — a discount cannot be added after payment.'
  },
  {
    id: 'access',
    emoji: '🚪',
    label: 'Removed from the group',
    settingKey: 'faq_access',
    answer:
      'Members are removed automatically when their pass expires.\n\n' +
      '• Send /status to see your expiry date.\n' +
      '• If it has expired, buy again from /plans and you will get a new invite.\n' +
      '• If your pass is still active and you were removed, raise a ticket below.'
  },
  {
    id: 'other',
    emoji: '💬',
    label: 'Something else',
    settingKey: 'faq_other',
    answer: 'Tell us what is going on and an admin will get back to you here in this chat.'
  },
  {
    id: 'renewal',
    emoji: '🔁',
    label: 'Renewal or auto-pay',
    settingKey: 'faq_renewal',
    hidden: true,
    answer:
      '• Passes do not renew by themselves — buy again from /plans when yours runs out.\n' +
      '• If you are on the old Monthly Auto-Pay, send /cancel to stop future charges; you keep access ' +
      'until the date you have already paid for.'
  }
];

/** Categories offered in the /support menu, in order. */
const MENU_CATEGORIES = CATEGORIES.filter((c) => !c.hidden);

/**
 * Ticket lifecycle. A ticket is `open` until an admin does anything with it,
 * then `in_progress` until an admin explicitly closes it. Nothing else closes
 * a ticket. Who has to act next is tracked separately in `waiting_on`, so a
 * ticket can be in progress and still need a reply.
 */
const TICKET_STATUSES = ['open', 'in_progress', 'closed'];

const STATUS_LABELS = {
  open: '🆕 Open',
  in_progress: '🟡 In progress',
  closed: '✅ Closed'
};

const STATUS_MEANINGS = {
  open: 'New — no admin has picked it up yet.',
  in_progress: 'An admin has replied or acted. It stays in progress until an admin closes it.',
  closed: 'An admin closed it. If the student writes again it reopens as in progress.'
};

/** Who has to act next on a ticket that is not closed. */
const WAITING_LABELS = {
  admin: '🔴 Needs reply',
  student: '⏳ Waiting for student'
};

/** A stored status, with the old "answered" read as in_progress. */
function normaliseStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'answered') return 'in_progress';
  return TICKET_STATUSES.includes(value) ? value : 'open';
}

/** The label for a status, tolerating an old or unknown one. */
function statusLabel(status) {
  return STATUS_LABELS[normaliseStatus(status)];
}

/** "🟡 In progress · 🔴 Needs reply", or just "✅ Closed". */
function statusLine(status, waitingOn) {
  const normalised = normaliseStatus(status);
  const waiting = normalised === 'closed' ? '' : WAITING_LABELS[waitingOn];
  return waiting ? `${STATUS_LABELS[normalised]} · ${waiting}` : STATUS_LABELS[normalised];
}

/**
 * Ready-made answers an admin can send with one tap. The text is editable in
 * Bot Settings; `for` lists the issue types it is shown first for.
 */
const QUICK_REPLIES = [
  {
    id: 'q1', key: 'qr_ask_payment_proof', button: '📎 Ask for payment proof',
    for: ['payment', 'payment_failed', 'other'],
    text: 'Please send your payment ID (it starts with pay_ and is in the Razorpay receipt or your UPI app) ' +
      'or a screenshot of the payment, and we will check it right away.'
  },
  {
    id: 'q2', key: 'qr_payment_not_received', button: '❌ Payment not received',
    for: ['payment', 'payment_failed'],
    text: 'We checked and could not find a successful payment for your account. If money left your bank, ' +
      'it is usually returned within 5–7 working days. You can buy the pass again with /plans.'
  },
  {
    id: 'q3', key: 'qr_payment_processing', button: '⏳ Payment still processing',
    for: ['payment', 'payment_failed'],
    text: 'Your payment is still being confirmed by the bank. This can take up to 30 minutes — your invite ' +
      'link will arrive in this chat automatically as soon as it clears.'
  },
  {
    id: 'q4', key: 'qr_pass_expired', button: '⌛ Pass has expired',
    for: ['access', 'invite'],
    text: 'Your pass has expired, which is why the link no longer works. Buy a new one with /plans and you ' +
      'will get a fresh invite link straight away.'
  },
  {
    id: 'q5', key: 'qr_invite_sent', button: '🔗 New link sent — tap it',
    for: ['invite', 'payment', 'access'],
    text: 'We have sent you a new invite link in this chat. Tap it from this same Telegram account and you ' +
      'will be let in automatically.'
  },
  {
    id: 'q6', key: 'qr_coupon_help', button: '🎟 How to use a coupon',
    for: ['coupon'],
    text: 'Send /plans, pick your group, tap "Apply coupon code" and type the code. The discounted price is ' +
      'shown before you pay. A discount cannot be added to a payment that is already made.'
  },
  {
    id: 'q7', key: 'qr_resolved', button: '✅ Resolved — close ticket', closes: true,
    for: [],
    text: 'Glad we could help! We are closing this ticket. If anything else comes up, just send a message here.'
  }
];

/** The quick reply for an id such as "q2", or null. */
function quickReplyById(id) {
  return QUICK_REPLIES.find((q) => q.id === id) || null;
}

/** Quick replies ordered for an issue type: the relevant ones first, "resolved" last. */
function quickRepliesFor(category) {
  const relevant = QUICK_REPLIES.filter((q) => q.for.includes(category));
  const others = QUICK_REPLIES.filter((q) => !q.for.includes(category) && !q.closes);
  return [...relevant, ...others, ...QUICK_REPLIES.filter((q) => q.closes)];
}

/**
 * The settings admins can change without a deploy. Stored in each sheet's
 * "Bot Settings" tab; anything not listed here is ignored when read and
 * refused when written. `section` groups them on the dashboard. `optional`
 * settings may be blank on purpose; the rest fall back to their default.
 */
const SETTINGS = [
  {
    key: 'support_enabled', section: 'support', label: 'Support tickets enabled', type: 'toggle', default: 'yes',
    hint: 'When "no", /support still shows the answers below but does not accept tickets.'
  },
  {
    key: 'support_hours', section: 'support', label: 'Support hours', type: 'text', maxLength: 120,
    default: 'Mon–Sat, 9 AM – 7 PM IST',
    hint: 'Shown to students when they raise a ticket.'
  },
  {
    key: 'support_response_time', section: 'support', label: 'Expected response time', type: 'text', maxLength: 120,
    default: 'within 24 hours',
    hint: 'Completes the sentence "An admin will reply …".'
  },
  {
    key: 'support_contact', section: 'support', label: 'Fallback contact', type: 'text', maxLength: 120,
    default: '', optional: true,
    hint: 'Optional, e.g. @YourAdminHandle or an email. Shown when tickets are switched off.'
  },
  {
    key: 'welcome_note', section: 'support', label: 'Extra /start message', type: 'textarea', maxLength: 1000,
    default: '', optional: true,
    hint: 'Optional. Added to the /start greeting, e.g. an offer or an announcement.'
  },
  ...CATEGORIES.filter((c) => !c.hidden).map((category) => ({
    key: category.settingKey,
    section: 'answers',
    label: `${category.emoji} ${category.label}`,
    type: 'textarea',
    maxLength: 2000,
    default: category.answer,
    hint: `Shown instantly when a student picks "${category.label}" in /support.`
  })),
  ...QUICK_REPLIES.map((reply) => ({
    key: reply.key,
    section: 'quick',
    label: reply.button,
    type: 'textarea',
    maxLength: 1500,
    default: reply.text,
    hint: reply.closes
      ? 'Sent to the student when an admin taps this quick reply. It also closes the ticket.'
      : 'Sent to the student when an admin taps this quick reply.'
  })),
  {
    key: 'pass_name', section: 'pass', label: 'Pass name', type: 'text', maxLength: 80, default: '', optional: true,
    hint: 'The exam the pass is for, e.g. "Target APPSC Group 2 – 2026". Blank uses the built-in name.'
  },
  {
    key: 'pass_price', section: 'pass', label: 'Price (₹)', type: 'price', maxLength: 6, default: '', optional: true,
    hint: 'Whole rupees. Blank uses ₹199.'
  },
  {
    key: 'pass_valid_until', section: 'pass', label: 'Valid until', type: 'date', maxLength: 10, default: '',
    optional: true,
    hint: 'dd-mm-yyyy. Access ends at the end of this day. Blank uses EXAM_PASS_END_DATE.'
  },
  {
    key: 'pass_description', section: 'pass', label: 'Description', type: 'textarea', maxLength: 300,
    default: '', optional: true,
    hint: 'One or two lines shown with the price. Blank uses the built-in description.'
  }
];

const SETTING_KEYS = SETTINGS.map((s) => s.key);

/** Longest message accepted into a ticket; Telegram's own limit is 4096. */
const MAX_MESSAGE_CHARS = 3500;

/** Escapes text before putting it in an HTML-formatted Telegram message. */
function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A category by id, falling back to "other". */
function categoryById(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES.find((c) => c.id === 'other');
}

/** A category by its label (or a label it used to have), as it appears on a support prompt. */
function categoryByLabel(label) {
  const clean = String(label || '').trim();
  return CATEGORIES.find((c) => c.label === clean || (c.aliases || []).includes(clean)) ||
    categoryById('other');
}

/**
 * normaliseSettings — every known setting, stored value or default.
 *
 * A blank stored value falls back to the default for the answers and the
 * toggle, because an empty answer or an empty "enabled" would read as broken
 * rather than as a choice. Optional settings may legitimately be blank.
 *
 * @param {Object} stored Raw { key: value } from the sheet
 * @returns {Object} { key: value } for every key in SETTINGS
 */
function normaliseSettings(stored = {}) {
  const out = {};
  SETTINGS.forEach((def) => {
    const raw = stored && Object.prototype.hasOwnProperty.call(stored, def.key) ? stored[def.key] : undefined;
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value) {
      out[def.key] = def.optional ? '' : def.default;
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
    if (def.type === 'price' && text && (!/^\d+$/.test(text) || Number(text) < 1)) {
      return { ok: false, error: `"${key}" must be a whole number of rupees, at least 1.` };
    }
    if (def.type === 'date' && text && !isRealDate(text)) {
      return { ok: false, error: `"${key}" must be a real date written as dd-mm-yyyy.` };
    }
    if (def.type === 'date' && text && isPastDay(text)) {
      return { ok: false, error: `"${key}" is in the past. Choose today or a later date.` };
    }
    value[key] = text;
  }
  return { ok: true, value };
}

/** Whether "dd-mm-yyyy" names a real calendar date. */
function isRealDate(text) {
  const match = String(text || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return false;
  const [, dd, mm, yyyy] = match.map(Number);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd));
  return date.getUTCFullYear() === yyyy && date.getUTCMonth() === mm - 1 && date.getUTCDate() === dd;
}

/** Whether a real dd-mm-yyyy date ended before now, in India. */
function isPastDay(text, now = Date.now()) {
  const [dd, mm, yyyy] = String(text).split('-').map(Number);
  const endOfDay = Date.UTC(yyyy, mm - 1, dd, 23, 59, 59, 999) - (5 * 60 + 30) * 60 * 1000;
  return endOfDay < now;
}

/** The first Razorpay payment id in some text, e.g. "pay_TZ8ciB8Yng8WE3". */
function findPaymentId(text) {
  const match = String(text || '').match(/\bpay_[A-Za-z0-9]{8,30}\b/);
  return match ? match[0] : '';
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

/**
 * First line of the "describe your problem" prompt. The group, when the
 * student named one, follows an em dash — no category label contains one,
 * while group names do contain " · ".
 */
function promptLine(category, groupName = '') {
  return `📨 Support request · ${category.label}${groupName ? ` — ${groupName}` : ''}`;
}

const PROMPT_PATTERN = /^📨 Support request · (.+?)(?: — (.+))?$/m;

/** The category a reply to a support prompt belongs to, or null. */
function parsePrompt(text) {
  const match = firstLine(text).match(PROMPT_PATTERN);
  return match ? categoryByLabel(match[1]) : null;
}

/** The group name on a support prompt, or '' when the student did not pick one. */
function parsePromptGroup(text) {
  const match = firstLine(text).match(PROMPT_PATTERN);
  return match && match[2] ? match[2].trim() : '';
}

function firstLine(text) {
  return String(text || '').split('\n')[0];
}

/** First line of every ticket message in the admin support chat. */
function ticketHeader(ticketId, telegramId) {
  return `🎫 ${ticketId} · user ${telegramId}`;
}

/**
 * The same first line as HTML. The code tags keep Telegram from turning the
 * id into a phone-number link; the text, which is what gets parsed, is
 * unchanged.
 */
function ticketHeaderHtml(ticketId, telegramId) {
  return `🎫 <code>${esc(ticketId)}</code> · user <code>${esc(telegramId)}</code>`;
}

/** { ticketId, telegramId } from a ticket message in the support chat, or null. */
function parseTicketHeader(text) {
  // A message's text never has tags; the HTML the bot sent does, and reads the same.
  const plain = firstLine(text).replace(/<\/?code>/g, '');
  const match = plain.match(new RegExp(`^🎫 (${TICKET_ID_PATTERN}) · user (\\d+)`));
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

/** An admin's words as the student reads them, from Telegram or the dashboard. */
function studentReplyHtml(ticketId, text) {
  return `${esc(replyLine(ticketId))}\n\n${esc(text)}\n\n` +
    '<i>— Support Team</i>\n<i>To reply, just send a message here.</i>';
}

/** What a student is told when an admin closes their ticket. */
function resolvedHtml(ticketId) {
  return `${esc(replyLine(ticketId))}\n\n` +
    '✅ <b>Your ticket has been marked as resolved.</b>\n\n' +
    'If you still need help, just send a message here and we will pick it up again. ' +
    'For a different problem, send /support.';
}

/** First line of the confirmation a student gets after raising a ticket. */
function receivedLine(ticketId) {
  return `📨 Ticket received · ${ticketId}`;
}

// ---- Admin buttons ---------------------------------------------------------
// Every ticket post in the support chat carries these, so nothing needs a
// command. The data is adm:<action>:<ticketId>:<telegramId>[:<paymentId>] —
// at most about 55 bytes, inside Telegram's 64.

const ADMIN_ACTIONS = {
  r: 'reply',
  q: 'quickMenu',
  i: 'invite',
  p: 'passes',
  h: 'history',
  c: 'close',
  o: 'reopen',
  k: 'checkPayment',
  g: 'grantAsk'
};

/**
 * Buttons under a ticket in the support chat.
 *
 * @param {string} ticketId
 * @param {string|number} telegramId
 * @param {{closed?: boolean, paymentId?: string}} [options] paymentId adds a
 *   "Check payment" button for a pay_ id the student mentioned
 */
function adminKeyboard(ticketId, telegramId, { closed = false, paymentId = '' } = {}) {
  const data = (code, extra) => `adm:${code}:${ticketId}:${telegramId}${extra ? ':' + extra : ''}`;
  const rows = [
    [
      { text: '✍️ Write reply', callback_data: data('r') },
      { text: '📋 Quick replies', callback_data: data('q') }
    ],
    [
      { text: '🔗 Send new invite link', callback_data: data('i') },
      { text: '🎟 Pass & payment', callback_data: data('p') }
    ]
  ];
  if (paymentId) rows.push([{ text: `🔍 Check payment ${paymentId}`, callback_data: data('k', paymentId) }]);
  rows.push([
    { text: '📜 History', callback_data: data('h') },
    { text: '📊 Summary', callback_data: 'sum:show' },
    closed
      ? { text: '🔓 Reopen', callback_data: data('o') }
      : { text: '✅ Close', callback_data: data('c') }
  ]);
  return { inline_keyboard: rows };
}

/** One button per quick reply, relevant ones first. */
function quickReplyKeyboard(ticketId, telegramId, category) {
  return {
    inline_keyboard: quickRepliesFor(category).map((reply) => ([{
      text: reply.button,
      callback_data: `adm:${reply.id}:${ticketId}:${telegramId}`
    }]))
  };
}

/**
 * { action, ticketId, telegramId, paymentId?, quickReply? } from an admin
 * button, or null for anything malformed.
 */
function parseAdminCallback(data) {
  const match = String(data || '').match(
    new RegExp(`^adm:([a-z])(\\d?):(${TICKET_ID_PATTERN}):(\\d+)(?::(pay_[A-Za-z0-9]{8,30}))?$`)
  );
  if (!match) return null;
  const [, letter, digit, ticketId, telegramId, paymentId] = match;

  if (letter === 'q' && digit) {
    if (paymentId) return null;
    const reply = quickReplyById(`q${digit}`);
    return reply ? { action: 'quickReply', ticketId, telegramId, quickReply: reply } : null;
  }
  // g<n>: grant the pass for payment in the family's n-th group, confirmed.
  if (letter === 'g' && digit) {
    return paymentId
      ? { action: 'grantConfirm', ticketId, telegramId, paymentId, groupIndex: Number(digit) }
      : null;
  }
  if (digit || !ADMIN_ACTIONS[letter]) return null;
  const needsPayment = letter === 'k' || letter === 'g';
  if (needsPayment !== Boolean(paymentId)) return null;
  return { action: ADMIN_ACTIONS[letter], ticketId, telegramId, paymentId: paymentId || '' };
}

/**
 * suggestNextStep — the one line that tells an admin what to do, from the
 * issue type and what the student actually holds.
 *
 * @param {string} category
 * @param {Array<{group: Object, eligible: boolean, subscriber: Object|null, inGroup: string, reason: string, error?: boolean}>} passes
 *   inGroup is 'yes' | 'no' | 'unknown'
 * @param {string} [groupId] The group the ticket is about; only its pass is
 *   considered when the student holds one there or it could not be read
 * @returns {string} Plain text
 */
function suggestNextStep(category, passes = [], groupId = '') {
  const about = groupId ? passes.filter((p) => p.group.id === groupId) : [];
  if (about.length && (about[0].subscriber || about[0].error)) passes = about;

  const unreadable = passes.filter((p) => p.error);
  if (unreadable.length && !passes.some((p) => p.subscriber)) {
    return `Could not read ${unreadable.map((p) => p.group.shortName).join(', ')} just now → ` +
      'tap "🎟 Pass & payment" to check again before replying.';
  }

  const valid = passes.filter((p) => p.eligible);
  const outside = valid.filter((p) => p.inGroup === 'no');
  const expired = passes.filter((p) => p.subscriber && !p.eligible);

  if (outside.length) {
    return `Pass is valid but they are not in ${outside.map((p) => p.group.shortName).join(', ')} → ` +
      'tap "🔗 Send new invite link".';
  }
  if (valid.length && valid.every((p) => p.inGroup === 'yes')) {
    return `Pass is valid and they are already in ${valid.map((p) => p.group.shortName).join(', ')} → ` +
      'ask what exactly they see (✍️ Write reply).';
  }
  if (valid.length) {
    return 'Pass is valid → "🔗 Send new invite link" is safe to send.';
  }
  if (category === 'coupon') {
    return 'Check the code on the dashboard Pass & Coupons page (active, expiry, uses) → then reply.';
  }
  if (expired.length) {
    return `No valid pass (${expired.map((p) => `${p.group.shortName}: ${p.reason}`).join('; ')}) → ` +
      'quick reply "⌛ Pass has expired" or check their payment.';
  }
  if (category === 'payment' || category === 'payment_failed') {
    return 'No payment recorded for this account → ask for the payment ID (📋 Quick replies → ' +
      '"📎 Ask for payment proof"), then 🔍 check it.';
  }
  return 'No pass on record → reply to find out more.';
}

/**
 * inferTicketGroup — the group a ticket is most likely about when the student
 * did not say: the only group they hold a pass in. '' when that is not clear.
 */
function inferTicketGroup(passes = []) {
  const held = passes.filter((p) => p.subscriber);
  return held.length === 1 ? held[0].group.id : '';
}

/** "06-10-2026, 12:25:53 AM IST" → "06-10-2026"; anything else unchanged. */
function shortDate(stamp) {
  const text = String(stamp || '').trim();
  const match = text.match(/^(\d{2}-\d{2}-\d{4}),/);
  return match ? match[1] : text;
}

/** What kind of attachment a message carries, for a one-line description. */
function mediaKind(message) {
  if (!message) return '';
  if (message.photo) return 'photo';
  if (message.video || message.video_note || message.animation) return 'video';
  if (message.voice || message.audio) return 'voice message';
  if (message.document) return 'file';
  return '';
}

/** Where each "[time] who:" entry of a stored conversation starts. */
const ENTRY_START = /(?:^|\n\n)(?=\[[^\]\n]{6,40}\] [^\n]*:\n)/g;

/**
 * earlierConversation — the thread before its newest message, trimmed to the
 * most recent `maxChars`, starting on a whole entry.
 *
 * @param {string} conversation The Conversation cell of a ticket
 * @param {number} [maxChars]
 * @returns {string} '' when there is nothing before the newest message
 */
function earlierConversation(conversation, maxChars = 1500) {
  const text = String(conversation || '');
  const starts = [];
  let match;
  ENTRY_START.lastIndex = 0;
  while ((match = ENTRY_START.exec(text)) !== null) {
    starts.push(match.index + (match[0].startsWith('\n\n') ? 2 : 0));
    if (match[0] === '') ENTRY_START.lastIndex++;
  }
  if (starts.length < 2) return '';

  const before = text.slice(0, starts[starts.length - 1]).trimEnd();
  return lastChars(before, maxChars);
}

/** The newest `maxChars` of a thread, cut at an entry boundary when one is near. */
function lastChars(text, maxChars = 3500) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  const tail = value.slice(value.length - maxChars);
  const boundary = tail.search(/\n\n\[/);
  return '…\n' + (boundary !== -1 && boundary < maxChars / 2 ? tail.slice(boundary + 2) : tail);
}

/**
 * isRecent — whether an IST stamp from the sheet is within `days` of now.
 * An unreadable stamp counts as recent, so a formatting quirk never splits a
 * conversation into a second ticket.
 */
function isRecent(stamp, days, now = Date.now()) {
  const match = String(stamp || '').match(/^(\d{2})-(\d{2})-(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return true;
  let hour = parseInt(match[4], 10) % 12;
  if (match[7].toUpperCase() === 'PM') hour += 12;
  const at = Date.UTC(+match[3], +match[2] - 1, +match[1], hour, +match[5], +match[6]) - (5 * 60 + 30) * 60 * 1000;
  return now - at <= days * 24 * 60 * 60 * 1000;
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
  MENU_CATEGORIES,
  STATUS_LABELS,
  STATUS_MEANINGS,
  WAITING_LABELS,
  normaliseStatus,
  statusLabel,
  statusLine,
  QUICK_REPLIES,
  quickReplyById,
  quickRepliesFor,
  quickReplyKeyboard,
  suggestNextStep,
  isRealDate,
  findPaymentId,
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
  parsePromptGroup,
  ticketHeader,
  ticketHeaderHtml,
  inferTicketGroup,
  shortDate,
  mediaKind,
  parseTicketHeader,
  replyLine,
  parseReplyLine,
  receivedLine,
  studentReplyHtml,
  resolvedHtml,
  TICKET_ID_PATTERN,
  adminKeyboard,
  parseAdminCallback,
  earlierConversation,
  lastChars,
  isRecent,
  supportChatFor,
  botIdFromToken,
  parseCommand,
  messageText,
  hasMedia,
  createSettingsCache,
  createThrottle
};
