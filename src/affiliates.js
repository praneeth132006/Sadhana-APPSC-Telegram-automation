// ============================================================================
// src/affiliates.js — the influencer (affiliate) programme's rules
// ============================================================================
// Influencers promote an exam's channel. Each one applies through the
// affiliate bot, an admin approves the application with terms of their own
// choosing, and the influencer gets a promo code:
//
//   - a student who pays with it gets the discount the admin set
//   - the influencer earns the commission the admin set, on every paid use
//   - earnings are withdrawn weekly or monthly, over UPI, by hand
//
// A code belongs to ONE exam — one payment bot — and is refused by every
// other bot. An influencer who wants to promote two exams applies twice and
// holds two codes, each with its own terms.
//
// Everything here is pure: no sheet, no Telegram. src/affiliate-store.js keeps
// the records and src/affiliatebot.js talks to influencers.
// ============================================================================

const groupRegistry = require('./groups');
const pricing = require('./pricing');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between withdrawals, per payout cycle. */
const CYCLE_DAYS = { weekly: 7, monthly: 30 };

/** A UPI id: handle@bank. Deliberately loose on the handle — banks differ. */
const UPI_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

/** "promo_RAVIUPSC27" on a /start link. */
const START_PREFIX = 'promo_';

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

/** "TELEGRAM_PAYBOT_UPSC" → "upsc". */
function examIdFor(payBotEnv) {
  return String(payBotEnv || '').replace(/^TELEGRAM_PAYBOT_/, '').toLowerCase();
}

/**
 * listExams — what an influencer can apply to promote: one entry per payment
 * bot, because a promo code is honoured by exactly one bot.
 *
 * Only bots with a token and at least one ready group are offered. Promoting
 * an exam whose bot cannot sell is promoting nothing.
 *
 * @returns {Array<{id: string, label: string, botEnv: string, groups: Array<Object>}>}
 */
function listExams() {
  const byBot = new Map();
  for (const group of groupRegistry.listGroups()) {
    if (!group.ready || !group.paymentBotEnv) continue;
    if (!String(process.env[group.paymentBotEnv] || '').trim()) continue;
    if (!byBot.has(group.paymentBotEnv)) {
      byBot.set(group.paymentBotEnv, {
        id: examIdFor(group.paymentBotEnv),
        // The family's name without the language: "APPSC Newspaper", not
        // "Newspaper · English". The code works for both languages.
        label: group.label,
        botEnv: group.paymentBotEnv,
        groups: []
      });
    }
    byBot.get(group.paymentBotEnv).groups.push(group);
  }
  return [...byBot.values()];
}

/** One exam by id, or null. */
function getExam(examId) {
  return listExams().find((exam) => exam.id === String(examId || '').toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/** Upper case, no spaces — the same shape a coupon code has. */
function normaliseCode(code) {
  return pricing.normaliseCode(code);
}

/** The code on a "promo_CODE" /start payload, or ''. */
function codeFromStartPayload(payload) {
  const text = String(payload || '').trim();
  if (!text.toLowerCase().startsWith(START_PREFIX)) return '';
  const code = normaliseCode(text.slice(START_PREFIX.length));
  return pricing.COUPON_CODE_PATTERN.test(code) ? code : '';
}

/**
 * shareLink — the link an influencer posts. Opening it starts the exam's
 * payment bot with the code already applied, so a follower never types it.
 */
function shareLink(botUsername, code) {
  const name = String(botUsername || '').replace(/^@/, '').trim();
  if (!name) return '';
  return `https://t.me/${name}?start=${START_PREFIX}${normaliseCode(code)}`;
}

/**
 * suggestCode — a readable code from the influencer's name and the exam:
 * "Ravi Kumar" promoting UPSC → "RAVIUPSC" plus two digits.
 *
 * @param {Object} person { name, username }
 * @param {string} examId
 * @param {Function} [random] For tests
 */
function suggestCode(person, examId, random = Math.random) {
  const source = String((person && (person.name || person.username)) || 'PROMO');
  const letters = source.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'PROMO';
  const exam = String(examId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const digits = String(10 + Math.floor(random() * 90));
  return (letters + exam + digits).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Approval terms
// ---------------------------------------------------------------------------

/** Parses the yes/no an admin sends, with a default for blank. */
function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !/^(no|false|off|0)$/i.test(String(value).trim());
}

/** A whole number from a form field, or NaN. */
function wholeNumber(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return /^\d+$/.test(text) ? Number(text) : NaN;
}

/**
 * validateTerms — what an admin sets when approving an application.
 *
 * @param {Object} raw From the dashboard
 * @param {Object} [options]
 * @param {number} [options.pricePaise] The pass price now, to refuse a
 *   discount that would take it below what Razorpay accepts
 * @param {Date} [options.now]
 * @returns {{ok: boolean, error?: string, value?: Object}}
 */
function validateTerms(raw, { pricePaise = null, now = new Date() } = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Terms are missing.' };

  const discountType = String(raw.discount_type || '').trim().toLowerCase();
  if (discountType !== 'percent' && discountType !== 'flat') {
    return { ok: false, error: 'Student discount must be a percent or a flat ₹ amount.' };
  }
  const discountValue = wholeNumber(raw.discount_value);
  if (discountType === 'percent' && !(discountValue >= 1 && discountValue <= 90)) {
    return { ok: false, error: 'A percent discount must be a whole number from 1 to 90.' };
  }
  if (discountType === 'flat' && !(discountValue >= 1 && discountValue <= 100000)) {
    return { ok: false, error: 'A flat discount must be a whole number of rupees, at least ₹1.' };
  }

  const commissionType = String(raw.commission_type || '').trim().toLowerCase();
  if (commissionType !== 'percent' && commissionType !== 'flat') {
    return { ok: false, error: 'Commission must be a percent or a flat ₹ amount per sale.' };
  }
  const commissionValue = wholeNumber(raw.commission_value);
  if (commissionType === 'percent' && !(commissionValue >= 1 && commissionValue <= 100)) {
    return { ok: false, error: 'A percent commission must be a whole number from 1 to 100.' };
  }
  if (commissionType === 'flat' && !(commissionValue >= 1 && commissionValue <= 100000)) {
    return { ok: false, error: 'A flat commission must be a whole number of rupees, at least ₹1.' };
  }

  const cycle = String(raw.payout_cycle || '').trim().toLowerCase();
  if (!CYCLE_DAYS[cycle]) return { ok: false, error: 'Payout cycle must be weekly or monthly.' };

  const minPayout = raw.min_payout === '' || raw.min_payout === undefined || raw.min_payout === null
    ? 0 : wholeNumber(raw.min_payout);
  if (!(minPayout >= 0 && minPayout <= 1000000)) {
    return { ok: false, error: 'Minimum withdrawal must be a whole number of rupees (0 for none).' };
  }

  const code = raw.code ? normaliseCode(raw.code) : '';
  if (code && !pricing.COUPON_CODE_PATTERN.test(code)) {
    return { ok: false, error: 'Code must be 3–20 characters: letters, numbers, - or _ (no spaces).' };
  }

  const expires = String(raw.expires_on || '').trim();
  if (expires && !pricing.endOfDayIst(expires)) {
    return { ok: false, error: 'Expiry must be a real date written as dd-mm-yyyy.' };
  }
  if (expires && pricing.endOfDayIst(expires).getTime() < now.getTime()) {
    return { ok: false, error: 'That expiry date has already passed.' };
  }

  const maxUsesText = String(raw.max_uses === undefined || raw.max_uses === null ? '' : raw.max_uses).trim();
  const maxUses = maxUsesText ? wholeNumber(maxUsesText) : '';
  if (maxUsesText && !(maxUses >= 1)) {
    return { ok: false, error: 'Max uses must be a whole number of at least 1, or blank for unlimited.' };
  }

  // A discount that would make the pass unpayable is caught now, while the
  // admin is looking at it, rather than by the first student to try it.
  if (pricePaise) {
    const discount = discountType === 'percent'
      ? Math.round(pricePaise * discountValue / 100) : discountValue * 100;
    if (pricePaise - discount < pricing.MIN_PAYABLE_PAISE) {
      return {
        ok: false,
        error: `That discount takes the ${pricing.rupees(pricePaise)} pass below ` +
          `${pricing.rupees(pricing.MIN_PAYABLE_PAISE)}, which cannot be charged.`
      };
    }
  }

  return {
    ok: true,
    value: {
      code,
      discount_type: discountType,
      discount_value: discountValue,
      commission_type: commissionType,
      commission_value: commissionValue,
      payout_cycle: cycle,
      min_payout: minPayout,
      expires_on: expires,
      max_uses: maxUses,
      one_per_student: bool(raw.one_per_student, true),
      note: String(raw.note || '').trim().slice(0, 500)
    }
  };
}

/** "10% off" / "₹20 off". */
function describeDiscount(terms) {
  return terms.discount_type === 'percent'
    ? `${terms.discount_value}% off`
    : `${pricing.rupees(Number(terms.discount_value) * 100)} off`;
}

/** "20% of what the student pays" / "₹30 per sale". */
function describeCommission(terms) {
  return terms.commission_type === 'percent'
    ? `${terms.commission_value}% of what the student pays`
    : `${pricing.rupees(Number(terms.commission_value) * 100)} per sale`;
}

/**
 * commissionFor — what an influencer earns on one payment.
 *
 * Worked out from what the student actually paid, never the list price, and
 * a flat commission is capped at that amount: a sale can never cost more in
 * commission than it brought in.
 */
function commissionFor(terms, paidPaise) {
  const paid = Math.max(0, Number(paidPaise) || 0);
  const value = Number(terms.commission_value) || 0;
  const raw = terms.commission_type === 'percent' ? Math.round(paid * value / 100) : value * 100;
  return Math.min(Math.max(0, raw), paid);
}

// ---------------------------------------------------------------------------
// A student using a code
// ---------------------------------------------------------------------------

/**
 * evaluatePromo — may this student use this code on this bot, and what does it
 * take off?
 *
 * @param {Object|null} code A row from the Codes tab
 * @param {Object} context
 * @param {string} context.payBotEnv The bot the student is buying from
 * @param {number} context.amountPaise The pass price now
 * @param {string|number} context.studentId
 * @param {number} context.uses Paid uses of this code so far
 * @param {number} context.usesByStudent Paid uses by this student
 * @param {Date} [context.now]
 * @returns {Object} { ok, reason } or the applied discount
 */
function evaluatePromo(code, { payBotEnv, amountPaise, studentId, uses = 0, usesByStudent = 0, now = new Date() }) {
  if (!code) return { ok: false, reason: 'That code does not exist. Please check the spelling.' };

  // The one rule the whole programme rests on: a UPSC influencer's code is
  // for the UPSC bot, and no other.
  if (code.exam_bot !== payBotEnv) {
    const exam = getExam(code.exam);
    return {
      ok: false,
      reason: `That code is for ${exam ? exam.label : 'another exam'} and cannot be used here.`
    };
  }
  if (String(code.status || 'active') !== 'active') {
    return { ok: false, reason: 'That code is not active at the moment.' };
  }
  if (String(code.telegram_id) === String(studentId)) {
    return { ok: false, reason: 'You cannot use your own promo code.' };
  }
  if (code.expires_on) {
    const end = pricing.endOfDayIst(code.expires_on);
    if (!end || now.getTime() > end.getTime()) return { ok: false, reason: 'That code has expired.' };
  }
  if (code.max_uses !== '' && code.max_uses !== undefined && code.max_uses !== null &&
      Number(uses) >= Number(code.max_uses)) {
    return { ok: false, reason: 'That code has already been used the maximum number of times.' };
  }
  if (bool(code.one_per_student, true) && Number(usesByStudent) > 0) {
    return { ok: false, reason: 'You have already used that code.' };
  }

  const value = Number(code.discount_value) || 0;
  const discountPaise = code.discount_type === 'percent'
    ? Math.round(amountPaise * value / 100) : Math.round(value * 100);
  if (!(discountPaise > 0)) return { ok: false, reason: 'That code does not give a discount.' };
  const finalPaise = amountPaise - discountPaise;
  if (finalPaise < pricing.MIN_PAYABLE_PAISE) {
    return { ok: false, reason: 'That code cannot be used on this pass. Please contact support.' };
  }

  return {
    ok: true,
    kind: 'promo',
    code: normaliseCode(code.code),
    discountPaise,
    finalPaise,
    label: describeDiscount(code),
    affiliateId: String(code.telegram_id),
    commissionPaise: commissionFor(code, finalPaise)
  };
}

// ---------------------------------------------------------------------------
// Earnings and withdrawals
// ---------------------------------------------------------------------------

/**
 * summarise — where one code stands, from its sales.
 *
 *   earned     — credited, not yet asked for
 *   requested  — in a withdrawal the admin has not paid yet
 *   paid       — sent
 */
function summarise(sales) {
  const out = { uses: 0, revenuePaise: 0, discountPaise: 0, earnedPaise: 0, availablePaise: 0,
    requestedPaise: 0, paidPaise: 0 };
  for (const sale of sales || []) {
    if (sale.status === 'cancelled') continue;
    const commission = Number(sale.commission_paise) || 0;
    out.uses += 1;
    out.revenuePaise += Number(sale.paid_paise) || 0;
    out.discountPaise += Number(sale.discount_paise) || 0;
    out.earnedPaise += commission;
    if (sale.status === 'paid') out.paidPaise += commission;
    else if (sale.status === 'requested') out.requestedPaise += commission;
    else out.availablePaise += commission;
  }
  return out;
}

/**
 * withdrawal — may this code's earnings be withdrawn now?
 *
 * @param {Object} code Row from Codes (payout_cycle, min_payout)
 * @param {Array<Object>} sales This code's sales
 * @param {Array<Object>} payouts This code's withdrawal requests
 * @param {Object} [options]
 * @param {string} [options.upi] The influencer's UPI id
 * @param {Date} [options.now]
 * @param {Function} [options.parseDate] Timestamp string → Date
 * @returns {{ok: boolean, reason?: string, amountPaise: number, nextAt?: Date|null}}
 */
function withdrawal(code, sales, payouts, { upi = '', now = new Date(), parseDate = (s) => new Date(s) } = {}) {
  const stats = summarise(sales);
  const amountPaise = stats.availablePaise;
  const minPaise = (Number(code.min_payout) || 0) * 100;

  const open = (payouts || []).find((p) => p.status === 'requested');
  if (open) {
    return { ok: false, amountPaise, reason: `Your request ${open.payout_id} is still with the admin.` };
  }

  if (amountPaise <= 0) return { ok: false, amountPaise, reason: 'Nothing is waiting to be withdrawn yet.' };
  if (amountPaise < minPaise) {
    return {
      ok: false, amountPaise,
      reason: `You can withdraw once you reach ${pricing.rupees(minPaise)} ` +
        `(${pricing.rupees(minPaise - amountPaise)} to go).`
    };
  }

  // Weekly or monthly, counted from the last request that was not rejected.
  const days = CYCLE_DAYS[code.payout_cycle] || CYCLE_DAYS.monthly;
  const last = (payouts || [])
    .filter((p) => p.status !== 'rejected')
    .map((p) => parseDate(p.requested_at))
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => b - a)[0];
  if (last) {
    const nextAt = new Date(last.getTime() + days * DAY_MS);
    if (now.getTime() < nextAt.getTime()) {
      return { ok: false, amountPaise, nextAt, reason: `Your payout cycle is ${code.payout_cycle}.` };
    }
  }

  if (!UPI_PATTERN.test(String(upi || '').trim())) {
    return { ok: false, amountPaise, reason: 'Set your UPI ID first, so we know where to send it.' };
  }
  return { ok: true, amountPaise };
}

module.exports = {
  CYCLE_DAYS,
  UPI_PATTERN,
  START_PREFIX,
  examIdFor,
  listExams,
  getExam,
  normaliseCode,
  codeFromStartPayload,
  shareLink,
  suggestCode,
  validateTerms,
  describeDiscount,
  describeCommission,
  commissionFor,
  evaluatePromo,
  summarise,
  withdrawal
};
