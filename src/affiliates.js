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
 * Only bots with a token, at least one ready group, and `affiliate` left on in
 * groups.config.json are offered. Promoting an exam whose bot cannot sell is
 * promoting nothing, and an exam the admin has not opened is not on offer.
 *
 * @returns {Array<{id: string, label: string, botEnv: string, groups: Array<Object>}>}
 */
function listExams({ includeClosed = false } = {}) {
  const byBot = new Map();
  for (const group of groupRegistry.listGroups()) {
    if (!group.ready || !group.paymentBotEnv) continue;
    if (!String(process.env[group.paymentBotEnv] || '').trim()) continue;
    // Only the exams opened to influencers, per groups.config.json — unless
    // the caller wants every exam, for naming a code that already exists.
    if (!includeClosed && group.affiliate === false) continue;
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

/**
 * getExam — one exam by id, open or not.
 *
 * Closing an exam stops new applications; it must never make an approved code
 * nameless, so this looks at every exam and `isExamOpen` is what applications
 * are checked against.
 */
function getExam(examId) {
  return listExams({ includeClosed: true }).find((exam) => exam.id === String(examId || '').toLowerCase()) || null;
}

/** Whether influencers may apply to promote this exam right now. */
function isExamOpen(examId) {
  return listExams().some((exam) => exam.id === String(examId || '').toLowerCase());
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
// Payout details — what RazorpayX needs to pay someone
// ---------------------------------------------------------------------------
// A RazorpayX payout is made to a Contact (name, phone, email) through a Fund
// Account (a UPI ID, or a bank account with its IFSC). Collected once, in the
// bot, checked here, and shown to the admin beside every withdrawal so the
// payout can be made without asking the influencer anything.

const PAYOUT_FIELDS = {
  legal_name: {
    label: 'Name as on your bank account',
    check: (v) => /^[A-Za-z][A-Za-z .'-]{1,99}$/.test(v) || 'Use letters only, as it appears on your bank account.'
  },
  phone: {
    label: 'Mobile number',
    clean: (v) => String(v).replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=[6-9]\d{9}$)/, ''),
    check: (v) => /^[6-9]\d{9}$/.test(v) || 'Send a 10-digit Indian mobile number, e.g. 9876543210.'
  },
  email: {
    label: 'Email',
    clean: (v) => String(v).trim().toLowerCase(),
    check: (v) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(v) || 'That does not look like an email address.'
  },
  upi_id: {
    label: 'UPI ID',
    check: (v) => UPI_PATTERN.test(v) || 'That does not look like a UPI ID. It looks like name@bank, e.g. ravi@okicici.'
  },
  account_holder: {
    label: 'Account holder name',
    check: (v) => /^[A-Za-z][A-Za-z .'-]{1,99}$/.test(v) || 'Use letters only, as it appears on the bank account.'
  },
  account_number: {
    label: 'Account number',
    clean: (v) => String(v).replace(/[\s-]/g, ''),
    check: (v) => /^\d{9,18}$/.test(v) || 'An account number is 9 to 18 digits.'
  },
  ifsc: {
    label: 'IFSC',
    clean: (v) => String(v).trim().toUpperCase(),
    check: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v) || 'An IFSC is 11 characters, like HDFC0001234.'
  },
  pan: {
    label: 'PAN (optional)',
    clean: (v) => String(v).trim().toUpperCase(),
    check: (v) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v) || 'A PAN looks like ABCDE1234F.'
  }
};

/** Cleans and checks one payout detail. { ok, value } or { ok: false, reason }. */
function checkPayoutField(field, raw) {
  const def = PAYOUT_FIELDS[field];
  if (!def) return { ok: false, reason: 'Unknown detail.' };
  const value = (def.clean ? def.clean(raw) : String(raw || '').trim().replace(/\s+/g, ' '));
  const verdict = def.check(value);
  return verdict === true ? { ok: true, value } : { ok: false, reason: verdict };
}

/**
 * payoutDetails — what an influencer has given, and what is still missing
 * before they can be paid. The method is UPI unless they chose bank.
 */
function payoutDetails(influencer) {
  const i = influencer || {};
  const method = String(i.payout_method || '').toLowerCase() === 'bank' ? 'bank' : 'upi';
  const needed = ['legal_name', 'phone', 'email'].concat(method === 'bank'
    ? ['account_holder', 'account_number', 'ifsc'] : ['upi_id']);
  const missing = needed.filter((field) => !String(i[field] || '').trim());
  return { method, complete: missing.length === 0, missing, missingLabels: missing.map((f) => PAYOUT_FIELDS[f].label) };
}

/** The four details an application asks for, in the order they are asked. */
const APPLY_FIELDS = ['legal_name', 'email', 'phone', 'upi_id'];

/** A labelled line ("Email: …", "UPI ID = …"), and which field each label means. */
const LABELLED_LINE = new RegExp('^(' + [
  '(?:full\\s+)?name(?:\\s+as\\s+on\\s+(?:your\\s+)?bank(?:\\s+account)?)?',
  'e-?mail(?:\\s+(?:id|address))?',
  '(?:mobile|phone|contact)(?:\\s+(?:no\\.?|number))?',
  'number',
  'upi(?:\\s+id)?'
].join('|') + ')\\s*[:=\\-–]\\s*(.+)$', 'i');

function labelField(label) {
  const l = label.toLowerCase();
  if (/name/.test(l)) return 'legal_name';
  if (/mail/.test(l)) return 'email';
  if (/upi/.test(l)) return 'upi_id';
  return 'phone';
}

/** Short replies that are not anyone's name. */
const NOT_A_NAME = /^(?:hi|hii+|hello|hey|ok|okay|yes|no|thanks|thank you|start|help|done|sure)$/i;

/** Words that make a line a sentence rather than somebody's name. */
const SENTENCE_WORDS = new Set(['i', 'im', 'am', 'is', 'are', 'was', 'on', 'in', 'at', 'the', 'my', 'me', 'and', 'or',
  'to', 'of', 'for', 'with', 'we', 'you', 'your', 'our', 'it', 'this', 'that', 'will', 'can', 'please', 'promote',
  'channel', 'youtube', 'instagram', 'telegram', 'followers', 'subscribers', 'name', 'email', 'mobile', 'upi']);

/**
 * looksLikeName — a line with no label is taken as a name only if it reads
 * like one: at most five words, none of them the words of a sentence.
 */
function looksLikeName(text) {
  const words = String(text).trim().toLowerCase().split(/\s+/);
  return words.length <= 5 && !words.some((w) => SENTENCE_WORDS.has(w.replace(/[^a-z]/g, '')));
}

/**
 * parseDetails — an influencer's name, email, mobile and UPI ID from one
 * message, in any order, one per line (or separated by commas).
 *
 * Each line may carry a label ("Email: …", "2. 98765 43210"); a line without
 * one is recognised by its shape. The four shapes cannot be mistaken for each
 * other: an email has a dot after the @, a UPI ID never does, a mobile is
 * digits and a name is letters.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {boolean} [options.allowLoneName] Accept a message that is only a
 *   name. Off for chatter, where "ok" would otherwise become a name.
 * @returns {{values: Object, problems: Array<{line: string, reason: string}>}}
 */
function parseDetails(text, { allowLoneName = true } = {}) {
  let lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && /[,;|]/.test(lines[0])) lines = lines[0].split(/[,;|]/).map((l) => l.trim()).filter(Boolean);

  const values = {};
  const problems = [];
  const take = (field, raw, line) => {
    if (values[field] !== undefined) {
      problems.push({ line, reason: `${PAYOUT_FIELDS[field].label} was given twice; the first one was kept.` });
      return;
    }
    const checked = checkPayoutField(field, raw);
    if (checked.ok) values[field] = checked.value;
    else problems.push({ line, reason: `${PAYOUT_FIELDS[field].label}: ${checked.reason}` });
  };

  for (const line of lines) {
    // "1. Ravi", "2) ravi@…", "- 98765…"
    const bare = line.replace(/^(?:\d{1,2}\s*[.)\-:]|[-•*])\s*/, '');
    const labelled = bare.match(LABELLED_LINE);
    if (labelled) {
      take(labelField(labelled[1]), labelled[2].trim(), line);
      continue;
    }
    const field = ['email', 'upi_id', 'phone', 'legal_name']
      .find((f) => checkPayoutField(f, bare).ok && (f !== 'legal_name' || looksLikeName(bare)));
    if (field) take(field, bare, line);
    else problems.push({ line, reason: 'Not recognised as a name, email, mobile number or UPI ID.' });
  }

  // A message that is only a name is usually chatter ("ok", "hi").
  const onlyName = Object.keys(values).length === 1 && values.legal_name;
  if (onlyName && (!allowLoneName || NOT_A_NAME.test(values.legal_name))) {
    delete values.legal_name;
  }
  return { values, problems };
}

/** "XXXXXX1234" — enough to recognise an account without showing it. */
function maskAccount(number) {
  const text = String(number || '');
  return text.length > 4 ? 'X'.repeat(Math.min(text.length - 4, 8)) + text.slice(-4) : text;
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
 * @param {Object} [options.influencer] Their Influencers row, for the payout details
 * @param {Date} [options.now]
 * @param {Function} [options.parseDate] Timestamp string → Date
 * @returns {{ok: boolean, reason?: string, amountPaise: number, nextAt?: Date|null}}
 */
function withdrawal(code, sales, payouts, { influencer = null, now = new Date(), parseDate = (s) => new Date(s) } = {}) {
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

  // Everything RazorpayX needs, before the admin is asked to pay.
  // Each detail was checked when it was saved; here it only has to be there.
  const details = payoutDetails(influencer);
  if (!details.complete) {
    return {
      ok: false, amountPaise, needsDetails: true,
      reason: `Add your payout details first (/payout): ${details.missingLabels.join(', ')}.`
    };
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
  isExamOpen,
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
  withdrawal,
  PAYOUT_FIELDS,
  checkPayoutField,
  payoutDetails,
  maskAccount,
  APPLY_FIELDS,
  parseDetails
};
