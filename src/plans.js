// ============================================================================
// Subscription plan definitions (src/plans.js)
// ============================================================================
// One place that defines what a student can buy, what it costs, and how long
// access lasts. The bot menu, the payment link, the webhook and the expiry cron
// all read from here, so a price or a duration is changed in exactly one spot.
//
// Amounts are in paise, because that is the unit Razorpay works in. Storing
// rupees and multiplying later is how off-by-100 charges happen.
// ============================================================================

/** Milliseconds in a day, used for every expiry calculation. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** India is UTC+05:30 all year — no daylight saving — so one constant is exact. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * PLANS — the three passes, keyed by the id stored in the sheet and in
 * Razorpay's `notes`, so a row can always be traced back to what was sold.
 */
const PLANS = {
  sprint_30: {
    id: 'sprint_30',
    label: '30-Day Sprint Pass',
    emoji: '🗓️',
    amountPaise: 29900,              // ₹299
    type: 'one_time',
    durationDays: 30,
    tagline: '30 days validity, renew manually',
    description: 'Full access to every subject topic for 30 days.',
    // Reminder goes out this many days before expiry.
    reminderDaysBefore: 3
  },

  autopay_monthly: {
    id: 'autopay_monthly',
    label: 'Monthly Auto-Pay',
    emoji: '🔄',
    amountPaise: 24900,              // ₹249/month
    type: 'recurring',
    durationDays: 30,
    tagline: 'Auto-renews monthly, save 17%, cancel anytime',
    description: 'Renews itself every 30 days over UPI AutoPay or card. Cancel whenever you like.',
    reminderDaysBefore: 0,           // Nothing to remind about: it renews itself.
    // Razorpay plan id, created once with `node setup-razorpay.js`.
    razorpayPlanIdEnv: 'RAZORPAY_MONTHLY_PLAN_ID',
    intervalMonths: 1,
    totalBillingCycles: 12
  },

  exam_pass: {
    id: 'exam_pass',
    label: 'Target APPSC 2026 Pass',
    emoji: '🎯',
    amountPaise: 79900,              // ₹799
    type: 'one_time',
    durationDays: null,              // Ends on a fixed date, not after N days.
    tagline: 'Valid until exam day — best value',
    description: 'One payment, access right through to the exam. No renewals to remember.',
    reminderDaysBefore: 7,
    fixedEndDateEnv: 'EXAM_PASS_END_DATE'
  }
};

/** Plan ids in the order they are shown to a student. */
const PLAN_ORDER = ['sprint_30', 'autopay_monthly', 'exam_pass'];

/**
 * getPlan — looks up a plan by id.
 *
 * @param {string} planId
 * @returns {Object|null} The plan, or null when the id is unknown
 */
function getPlan(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId) ? PLANS[planId] : null;
}

/** Every plan, in display order. */
function listPlans() {
  return PLAN_ORDER.map((id) => PLANS[id]);
}

/** Formats an amount in paise as a rupee string, e.g. 29900 -> "₹299". */
function formatAmount(amountPaise) {
  const rupees = amountPaise / 100;
  return '₹' + (Number.isInteger(rupees) ? rupees : rupees.toFixed(2));
}

/**
 * parseExamDate — reads the fixed exam-pass end date from the environment.
 * Accepts DD-MM-YYYY, which is the format every date in this project uses.
 *
 * @returns {Date|null} End of the exam day, or null when unset or unparseable
 */
function parseExamDate(envName = 'EXAM_PASS_END_DATE', fallback = '') {
  const raw = String(process.env[envName] || '').trim() || String(fallback || '').trim();
  const match = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return null;

  const [, dd, mm, yyyy] = match;
  // End of that day IN IST, so a pass bought for "30-11-2026" lasts all of the
  // 30th for a student in India. Building it from local parts was only correct
  // on a machine set to Asia/Kolkata; on Vercel, which runs in UTC, the pass
  // ran 5 hours 30 minutes past the exam day it was sold for.
  const date = new Date(
    Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), 23, 59, 59, 999) - IST_OFFSET_MS
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * computeExpiry — when access bought today should end.
 *
 * A renewal extends from the CURRENT expiry rather than from today, so a
 * student who renews early is not silently robbed of the days they already
 * paid for. If the existing expiry is in the past, the new term starts now.
 *
 * @param {Object} plan A plan from PLANS
 * @param {Date} [from] Treated as "now"; defaults to the current time
 * @param {Date|null} [currentExpiry] Existing expiry, for a renewal
 * @returns {Date} The new expiry
 */
function computeExpiry(plan, from = new Date(), currentExpiry = null) {
  // A lifetime pass does not run out. It still needs a date — every sheet,
  // sweep and sort in this system reads Expiry Date — so it gets one far
  // enough out that nothing will ever reach it, and isLifetimePlan() is what
  // the sweep checks rather than trusting the date alone.
  if (isLifetimePlan(plan)) return new Date(LIFETIME_EXPIRY.getTime());

  if (plan.fixedEndDateEnv) {
    // Each dated pass reads its own date: the EPFO pass must not end on the
    // APPSC exam's day just because both are "until the exam".
    const examDate = parseExamDate(plan.fixedEndDateEnv, plan.fixedEndDate);
    if (examDate) return examDate;
    // Falling back to a year keeps a mis-set env var from granting nothing at
    // all — the student paid, so they get access either way.
    return new Date(from.getTime() + 365 * DAY_MS);
  }

  const base = (currentExpiry && currentExpiry.getTime() > from.getTime()) ? currentExpiry : from;

  return new Date(base.getTime() + plan.durationDays * DAY_MS);
}

/**
 * daysUntil — whole days from `from` until `date`, rounded up.
 * Negative once the date has passed.
 *
 * @param {Date} date Target
 * @param {Date} [from] Treated as now
 * @returns {number}
 */
/**
 * The expiry written for a lifetime pass: the last moment of 31-12-2099 in
 * India. A real date rather than a blank or a sentinel string, so the columns
 * that sort, filter and parse Expiry Date keep working unchanged.
 */
const LIFETIME_EXPIRY = new Date(Date.UTC(2099, 11, 31, 23, 59, 59) - IST_OFFSET_MS);

/** True for a pass that never expires. */
function isLifetimePlan(plan) {
  return Boolean(plan && plan.lifetime === true);
}

function daysUntil(date, from = new Date()) {
  return Math.ceil((date.getTime() - from.getTime()) / DAY_MS);
}

module.exports = {
  LIFETIME_EXPIRY,
  isLifetimePlan,
  PLANS,
  IST_OFFSET_MS,
  PLAN_ORDER,
  DAY_MS,
  getPlan,
  listPlans,
  formatAmount,
  parseExamDate,
  computeExpiry,
  daysUntil
};
