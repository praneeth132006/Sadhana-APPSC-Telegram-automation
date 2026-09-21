// ============================================================================
// src/referrals.js — referral codes, discounts, commission and payouts
// ============================================================================
// A student who already has a pass can invite others. The person they invite
// pays 10% less; the inviter earns 20% of what that person actually paid, in
// rupees, paid out once it reaches ₹1000 or at the monthly run — whichever
// comes first.
//
// Everything that decides whether a code applies, what it takes off, what it
// earns and when that is payable lives here, so the bot, the checkout, the
// webhook and the dashboard cannot disagree about any of it. Nothing in this
// file talks to a sheet, to Telegram or to Razorpay: it is arithmetic and
// rules over plain objects, which is what makes the money side testable
// without any of them.
//
// Two rules are worth stating out loud, because both are about money leaving
// the business:
//
//   - Commission is earned on what was PAID, never on the list price. The
//     referred student's discount comes off first, so 20% of a discounted sale
//     is smaller than 20% of the sticker price. Paying commission on the
//     sticker price would quietly pay out more than the sale brought in.
//   - Commission is only ever created from a payment that actually succeeded,
//     and a payment id is recorded with it. A webhook that Razorpay delivers
//     twice must not pay an inviter twice for one sale.
// ============================================================================

/** How much less the invited student pays. */
const DEFAULT_DISCOUNT_PERCENT = 10;

/** What the inviter earns, as a percentage of what the invited student paid. */
const DEFAULT_COMMISSION_PERCENT = 20;

/** Pending earnings at or above this (in rupees) are paid out on request. */
const DEFAULT_PAYOUT_THRESHOLD_RUPEES = 1000;

/** Referral codes: unambiguous characters only. */
const CODE_ALPHABET = 'ACDEFHJKMNPQRTUVWXY3479';
const CODE_LENGTH = 6;
const CODE_PREFIX = 'REF';

/** REF followed by six code characters, e.g. REF7K2MQD. */
const CODE_PATTERN = new RegExp(`^${CODE_PREFIX}[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** What a referral row's Status may say. */
const REFERRAL_STATUSES = ['active', 'disabled'];

/** What one earned commission may say. */
const EARNING_STATUSES = ['pending', 'paid', 'cancelled'];

/**
 * normaliseCode — what the student typed, as the sheet stores it.
 *
 * Deliberately forgiving about the things people actually do with a code they
 * were sent: lower case it, pad it, and paste the whole share link around it.
 */
function normaliseCode(input) {
  const text = String(input === null || input === undefined ? '' : input).trim();
  // "https://t.me/mybot?start=ref_REFAJMXPQ" and "ref_REFAJMXPQ" both mean the
  // code. Deep links are how nearly every referral actually arrives.
  //
  // The separator is required, and that is the whole subtlety: without it,
  // "refajmxpq" — a member typing their own code in lower case — matched this
  // as the "ref" prefix plus "ajmxpq", and came back as a different code that
  // belonged to nobody.
  const fromLink = text.match(/(?:[?&]start=ref[_-]?|^ref[_-])([A-Za-z0-9]+)$/i);
  const raw = fromLink ? fromLink[1] : text;
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/**
 * generateCode — a new code, from an injected source of randomness.
 *
 * `random` is a parameter so a test can make collisions happen on purpose;
 * the caller checks the result is not already taken and asks again if it is.
 *
 * @param {Function} [random] Returns a float in [0, 1)
 */
function generateCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return CODE_PREFIX + out;
}

/** True when a string is shaped like a referral code. */
function isCode(text) {
  return CODE_PATTERN.test(normaliseCode(text));
}

/** The link a student shares. `botUsername` is without the @. */
function shareLink(botUsername, code) {
  const name = String(botUsername || '').replace(/^@/, '').trim();
  if (!name) return '';
  return `https://t.me/${name}?start=ref_${normaliseCode(code)}`;
}

/** The code carried by a /start payload, or '' when there is none. */
function codeFromStartPayload(payload) {
  const text = String(payload || '').trim();
  if (!/^ref[_-]/i.test(text)) return '';
  const code = normaliseCode(text);
  return isCode(code) ? code : '';
}

/**
 * settingsFrom — the three numbers an admin can change, with their defaults.
 *
 * Every one is clamped rather than rejected: these come from a spreadsheet
 * cell a person types into, and a stray value should land on something sane
 * rather than take the referral system down.
 */
function settingsFrom(settings = {}) {
  const number = (value, fallback) => {
    const text = String(value === null || value === undefined ? '' : value).trim();
    // An unset spreadsheet cell arrives as ''. Number('') is 0, and 0 is
    // finite, so without this every default silently became zero: no discount
    // for the person invited, and no commission for anyone who invited them.
    if (text === '') return fallback;
    const n = Number(text);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  return {
    // Never 100%: a free sale earns the inviter nothing and costs a seat.
    discountPercent: clamp(number(settings.referral_discount_percent, DEFAULT_DISCOUNT_PERCENT), 0, 90),
    // Never above 100%: paying out more than the sale brought in.
    commissionPercent: clamp(number(settings.referral_commission_percent, DEFAULT_COMMISSION_PERCENT), 0, 100),
    payoutThresholdPaise:
      clamp(Math.round(number(settings.referral_payout_threshold, DEFAULT_PAYOUT_THRESHOLD_RUPEES) * 100), 0, 10000000),
    // An admin can switch the whole thing off without deleting anybody's code
    // or their unpaid earnings.
    enabled: String(settings.referral_enabled || '').trim().toLowerCase() !== 'no'
  };
}

/** Percent of an amount, rounded to the nearest paisa. */
function percentOf(amountPaise, percent) {
  return Math.round((Number(amountPaise) || 0) * (Number(percent) || 0) / 100);
}

/**
 * evaluateReferral — may this buyer use this code, and what does it take off?
 *
 * The reasons are written for the student, who sees them as they are.
 *
 * @param {Object|null} referral The code's row, or null when it is not found
 * @param {Object} options
 * @param {number} options.amountPaise The price before any discount
 * @param {string|number} options.buyerTelegramId Who is trying to use it
 * @param {number} [options.buyerReferredCount] Referrals this buyer has already used
 * @param {boolean} [options.buyerHasPaid] Whether they have ever bought a pass
 * @param {Object} [options.settings] From settingsFrom
 * @param {number} [options.minPayablePaise] Razorpay's floor
 * @returns {{ok: boolean, reason?: string, kind?: string, code?: string,
 *   discountPaise?: number, finalPaise?: number, commissionPaise?: number,
 *   referrerTelegramId?: string, label?: string}}
 */
function evaluateReferral(referral, options) {
  const {
    amountPaise,
    buyerTelegramId,
    buyerReferredCount = 0,
    buyerHasPaid = false,
    minPayablePaise = 100
  } = options;
  const config = settingsFrom(options.settings);

  if (!config.enabled) {
    return { ok: false, reason: 'Referral codes are not being accepted at the moment.' };
  }
  if (!referral) {
    return { ok: false, reason: 'That referral code does not exist. Please check the spelling.' };
  }
  if (String(referral.status || 'active').toLowerCase() !== 'active') {
    return { ok: false, reason: 'That referral code is no longer active.' };
  }

  // Inviting yourself is just a discount you wrote yourself, and it would pay
  // you commission on your own purchase.
  if (String(referral.telegram_id || '') === String(buyerTelegramId || '')) {
    return { ok: false, reason: 'You cannot use your own referral code.' };
  }

  // The offer is for bringing someone new in. Somebody who has already paid
  // has already been brought in, by whoever brought them.
  if (buyerHasPaid || buyerReferredCount > 0) {
    return {
      ok: false,
      reason: 'A referral code can only be used on your first pass, and you already have one.'
    };
  }

  const price = Number(amountPaise) || 0;
  let discountPaise = percentOf(price, config.discountPercent);
  let finalPaise = price - discountPaise;

  // Razorpay will not create a link below ₹1. Rather than refusing the sale,
  // give back what can be given and charge the floor.
  if (finalPaise < minPayablePaise) {
    finalPaise = Math.min(price, minPayablePaise);
    discountPaise = price - finalPaise;
  }

  return {
    ok: true,
    kind: 'referral',
    code: normaliseCode(referral.code),
    label: `${config.discountPercent}% off, invited by a member`,
    discountPaise,
    finalPaise,
    // On what they actually pay, never on the sticker price.
    commissionPaise: percentOf(finalPaise, config.commissionPercent),
    referrerTelegramId: String(referral.telegram_id || '')
  };
}

/**
 * summarise — one inviter's standing, from their earning rows.
 *
 * @param {Array<Object>} earnings Rows from the Referral Log for one code
 * @param {Object} [settings]
 * @returns {{joined: number, pendingPaise: number, paidPaise: number,
 *   totalPaise: number, payable: boolean, thresholdPaise: number}}
 */
function summarise(earnings, settings) {
  const config = settingsFrom(settings);
  let pendingPaise = 0;
  let paidPaise = 0;
  let joined = 0;

  for (const row of earnings || []) {
    const status = String(row.status || 'pending').toLowerCase();
    const amount = Number(row.commission_paise) || 0;
    // A cancelled earning (a refund, a chargeback) counts as neither a join
    // nor money: it is kept only so the history still explains itself.
    if (status === 'cancelled') continue;
    joined++;
    if (status === 'paid') paidPaise += amount;
    else pendingPaise += amount;
  }

  return {
    joined,
    pendingPaise,
    paidPaise,
    totalPaise: pendingPaise + paidPaise,
    thresholdPaise: config.payoutThresholdPaise,
    // "₹1000 or monthly once": the threshold is what the student can see for
    // themselves. The monthly run pays everyone with anything pending, and is
    // the admin's decision rather than a rule the bot states.
    payable: pendingPaise > 0 && pendingPaise >= config.payoutThresholdPaise
  };
}

/**
 * payoutDue — who should be paid in a monthly run.
 *
 * @param {Array<Object>} earnings Every pending earning across all inviters
 * @returns {Array<{code: string, telegramId: string, username: string,
 *   name: string, pendingPaise: number, count: number, paymentIds: string[]}>}
 */
function payoutDue(earnings, { thresholdPaise = null } = {}) {
  const byCode = new Map();

  for (const row of earnings || []) {
    if (String(row.status || 'pending').toLowerCase() !== 'pending') continue;
    const code = normaliseCode(row.code);
    if (!code) continue;

    const entry = byCode.get(code) || {
      code,
      telegramId: String(row.referrer_telegram_id || ''),
      username: String(row.referrer_username || ''),
      name: String(row.referrer_name || ''),
      pendingPaise: 0,
      count: 0,
      paymentIds: []
    };
    entry.pendingPaise += Number(row.commission_paise) || 0;
    entry.count++;
    if (row.payment_id) entry.paymentIds.push(String(row.payment_id));
    // A later row usually carries the fresher handle.
    if (row.referrer_username) entry.username = String(row.referrer_username);
    if (row.referrer_name) entry.name = String(row.referrer_name);
    byCode.set(code, entry);
  }

  const due = [...byCode.values()]
    .filter((e) => e.pendingPaise > 0 &&
      (thresholdPaise === null || e.pendingPaise >= thresholdPaise));
  // Largest owed first: if a run has to be cut short, it is cut where it
  // matters least.
  due.sort((a, b) => b.pendingPaise - a.pendingPaise);
  return due;
}

module.exports = {
  DEFAULT_DISCOUNT_PERCENT,
  DEFAULT_COMMISSION_PERCENT,
  DEFAULT_PAYOUT_THRESHOLD_RUPEES,
  CODE_PATTERN,
  CODE_PREFIX,
  REFERRAL_STATUSES,
  EARNING_STATUSES,
  normaliseCode,
  generateCode,
  isCode,
  shareLink,
  codeFromStartPayload,
  settingsFrom,
  percentOf,
  evaluateReferral,
  summarise,
  payoutDue
};
