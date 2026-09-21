// ============================================================================
// src/pricing.js — the pass on sale, and coupon codes
// ============================================================================
// One pass is sold: exam_pass. Its name, price and valid-until date can be
// changed by an admin (Bot Settings tab, dashboard Pass & Coupons page) without
// a deploy; anything left blank falls back to groups.config.json and
// EXAM_PASS_END_DATE.
//
// Coupons live in the sheet. Everything that decides whether a code applies
// and what it takes off is here, so the bot, the checkout and the dashboard
// cannot disagree about it.
// ============================================================================

const plans = require('./plans');
const groups = require('./groups');

/** The one pass on sale. */
const PASS_PLAN_ID = 'exam_pass';

/** Razorpay will not create a payment link for less than Rs 1. */
const MIN_PAYABLE_PAISE = 100;

const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,20}$/;

const DATE_PATTERN = /^(\d{2})-(\d{2})-(\d{4})$/;

/**
 * endOfDayIst — "30-11-2026" as the last moment of that day in India.
 *
 * @param {string} text dd-mm-yyyy
 * @returns {Date|null} null when it is not a real calendar date
 */
function endOfDayIst(text) {
  const match = String(text || '').trim().match(DATE_PATTERN);
  if (!match) return null;
  const [, dd, mm, yyyy] = match.map(Number);
  const date = new Date(Date.UTC(yyyy, mm - 1, dd, 23, 59, 59, 999) - plans.IST_OFFSET_MS);
  // Date.UTC rolls 31-02 over into March; a real date survives the round trip.
  const check = new Date(date.getTime() + plans.IST_OFFSET_MS);
  if (check.getUTCDate() !== dd || check.getUTCMonth() !== mm - 1) return null;
  return date;
}

/** Paise as "₹199" or "₹149.50". */
function rupees(amountPaise) {
  return plans.formatAmount(amountPaise);
}

/**
 * currentPass — the pass a group sells right now, with admin overrides applied.
 *
 * @param {string} groupId
 * @param {Object} [settings] Normalised bot settings (src/support.js)
 * @returns {Object|null} The plan plus `validUntil` (dd-mm-yyyy or '')
 */
function currentPass(groupId, settings = {}) {
  const base = groups.getPlanFor(groupId, passPlanIdFor(groupId), { includeRetired: false });
  if (!base) return null;

  const price = String(settings.pass_price || '').trim();
  const amountPaise = /^\d+$/.test(price) && Number(price) >= 1 ? Number(price) * 100 : base.amountPaise;

  // A lifetime pass has no end date, and must not pick one up from the family's
  // settings or from EXAM_PASS_END_DATE: either would quietly turn "pay once,
  // keep it for life" back into "valid until the exam".
  const lifetime = plans.isLifetimePlan(base);
  let validUntil = '';
  if (!lifetime) {
    const configured = String(settings.pass_valid_until || '').trim();
    const fromEnv = String(process.env[base.fixedEndDateEnv || 'EXAM_PASS_END_DATE'] || '').trim();
    validUntil = endOfDayIst(configured) ? configured : (endOfDayIst(fromEnv) ? fromEnv : '');
  }

  return Object.assign({}, base, {
    label: String(settings.pass_name || '').trim() || base.label,
    description: String(settings.pass_description || '').trim() || base.description,
    amountPaise,
    validUntil,
    lifetime
  });
}

/**
 * passPlanIdFor — which pass a group sells.
 *
 * Set per group in groups.config.json as `passPlanId`, and exam_pass when it
 * is not. That is what lets the two newspaper groups sell a lifetime pass
 * while every other group keeps its exam pass, without the pass definitions
 * themselves — which all groups share — having to know about it.
 */
function passPlanIdFor(groupId) {
  const group = groups.getGroup(groupId);
  return (group && String(group.passPlanId || '').trim()) || PASS_PLAN_ID;
}

/** Upper-cases and trims a code. */
function normaliseCode(code) {
  return String(code || '').trim().toUpperCase();
}

/** "₹50 off" or "20% off". */
function describeDiscount(coupon) {
  return coupon.discount_type === 'percent'
    ? `${coupon.discount_value}% off`
    : `${rupees(Number(coupon.discount_value) * 100)} off`;
}

/**
 * evaluateCoupon — whether a code applies to a price, and what it takes off.
 *
 * The reasons are written for the student, who sees them as they are.
 *
 * @param {Object|null} coupon As the sheet returns it (getCoupon), including used_by_student
 * @param {{amountPaise: number, now?: Date}} options
 * @returns {{ok: boolean, reason?: string, code?: string, discountPaise?: number, finalPaise?: number, label?: string}}
 */
function evaluateCoupon(coupon, { amountPaise, now = new Date() }) {
  if (!coupon) return { ok: false, reason: 'That coupon code does not exist. Please check the spelling.' };
  if (!coupon.active) return { ok: false, reason: 'That coupon code is no longer active.' };

  if (coupon.expires_on) {
    const end = endOfDayIst(coupon.expires_on);
    if (!end || now.getTime() > end.getTime()) return { ok: false, reason: 'That coupon code has expired.' };
  }
  if (coupon.max_uses !== null && coupon.max_uses !== undefined && coupon.max_uses !== '' &&
      Number(coupon.times_used) >= Number(coupon.max_uses)) {
    return { ok: false, reason: 'That coupon code has already been used the maximum number of times.' };
  }
  if (coupon.one_per_student && Number(coupon.used_by_student) > 0) {
    return { ok: false, reason: 'You have already used that coupon code.' };
  }

  const value = Number(coupon.discount_value);
  const discountPaise = coupon.discount_type === 'percent'
    ? Math.round(amountPaise * value / 100)
    : Math.round(value * 100);
  if (!(discountPaise > 0)) return { ok: false, reason: 'That coupon code does not give a discount.' };

  const finalPaise = amountPaise - discountPaise;
  if (finalPaise < MIN_PAYABLE_PAISE) {
    return { ok: false, reason: 'That coupon code cannot be used on this pass. Please contact support.' };
  }

  return {
    ok: true,
    code: normaliseCode(coupon.code),
    discountPaise,
    finalPaise,
    label: describeDiscount(coupon)
  };
}

/**
 * validateCouponInput — checks a coupon an admin is creating or editing.
 *
 * @param {Object} raw From the dashboard
 * @returns {{ok: boolean, error?: string, value?: Object}}
 */
function validateCouponInput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'coupon must be an object' };

  const code = normaliseCode(raw.code);
  if (!COUPON_CODE_PATTERN.test(code)) {
    return { ok: false, error: 'Code must be 3–20 characters: letters, numbers, - or _ (no spaces).' };
  }

  const type = String(raw.discount_type || '').trim().toLowerCase();
  if (type !== 'percent' && type !== 'flat') return { ok: false, error: 'Discount type must be percent or flat.' };

  const valueText = String(raw.discount_value === undefined || raw.discount_value === null ? '' : raw.discount_value).trim();
  if (!/^\d+$/.test(valueText)) return { ok: false, error: 'Discount must be a whole number.' };
  const value = Number(valueText);
  if (type === 'percent' && (value < 1 || value > 99)) {
    return { ok: false, error: 'A percent discount must be between 1 and 99.' };
  }
  if (type === 'flat' && (value < 1 || value > 100000)) {
    return { ok: false, error: 'A flat discount must be at least ₹1.' };
  }

  const expires = String(raw.expires_on || '').trim();
  if (expires && !endOfDayIst(expires)) return { ok: false, error: 'Expiry must be a real date written as dd-mm-yyyy.' };

  const maxText = String(raw.max_uses === undefined || raw.max_uses === null ? '' : raw.max_uses).trim();
  if (maxText && (!/^\d+$/.test(maxText) || Number(maxText) < 1)) {
    return { ok: false, error: 'Max uses must be a whole number of at least 1, or blank for unlimited.' };
  }

  const bool = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    if (typeof v === 'boolean') return v;
    return !/^(no|false|off|0)$/i.test(String(v).trim());
  };

  return {
    ok: true,
    value: {
      code,
      discount_type: type,
      discount_value: value,
      active: bool(raw.active, true),
      expires_on: expires,
      max_uses: maxText ? Number(maxText) : '',
      one_per_student: bool(raw.one_per_student, true),
      note: String(raw.note || '').trim().slice(0, 500)
    }
  };
}

/**
 * validatePassInput — checks the pass name, price, date and description an
 * admin is saving. Blank means "use the built-in default".
 *
 * @returns {{ok: boolean, error?: string, value?: Object}} value is a settings patch
 */
function validatePassInput(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'pass must be an object' };
  const name = String(raw.name || '').trim();
  const price = String(raw.price === undefined || raw.price === null ? '' : raw.price).trim();
  const validUntil = String(raw.validUntil || '').trim();
  const description = String(raw.description || '').trim();

  if (name.length > 80) return { ok: false, error: 'The pass name is limited to 80 characters.' };
  if (price && (!/^\d+$/.test(price) || Number(price) < 1 || Number(price) > 100000)) {
    return { ok: false, error: 'Price must be a whole number of rupees, at least ₹1.' };
  }
  if (validUntil && !endOfDayIst(validUntil)) {
    return { ok: false, error: 'Valid until must be a real date written as dd-mm-yyyy.' };
  }
  // Students would pay for a pass that has already ended.
  if (validUntil && endOfDayIst(validUntil).getTime() < now.getTime()) {
    return { ok: false, error: 'Valid until is in the past. Choose today or a later date.' };
  }
  if (description.length > 300) return { ok: false, error: 'The description is limited to 300 characters.' };

  return {
    ok: true,
    value: {
      pass_name: name,
      pass_price: price,
      pass_valid_until: validUntil,
      pass_description: description
    }
  };
}

module.exports = {
  passPlanIdFor,
  PASS_PLAN_ID,
  MIN_PAYABLE_PAISE,
  COUPON_CODE_PATTERN,
  endOfDayIst,
  rupees,
  currentPass,
  normaliseCode,
  describeDiscount,
  evaluateCoupon,
  validateCouponInput,
  validatePassInput
};
