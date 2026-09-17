// ============================================================================
// Sadhana APPSC — Dashboard server & API (server.js)
// ============================================================================
// Serves the five dashboards out of dashboard/ and exposes the JSON API they
// run on. It is the only process that holds secrets (the Telegram bot token and
// the Sheets API token), so it is also the security boundary:
//
//   - Every mutating and data-reading endpoint requires a Firebase ID token
//     that is verified server-side (src/auth.js). The browser-side login gate
//     is cosmetic; this is the control that actually holds.
//   - It binds to 127.0.0.1 by default, so nothing on the local network can
//     reach it.
//   - It sends no permissive CORS headers, so another origin cannot drive it
//     from a page the curator happens to have open.
//   - Callers cannot supply a URL to fetch. The Sheets endpoint comes from
//     .env only, which closes the SSRF hole the previous /api/ping?url= had.
//   - Request bodies are size capped and requests are rate limited.
//
// Run with: npm run dashboard
// ============================================================================

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const sheets = require('./src/sheets');
const auth = require('./src/auth');
const telegram = require('./src/telegram');
const paybot = require('./src/paybot');
const groupRegistry = require('./src/groups');
const razorpay = require('./src/razorpay');
const membership = require('./src/membership');
const plans = require('./src/plans');
const botapp = require('./src/botapp');
const support = require('./src/support');
const pricing = require('./src/pricing');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/* What this line does: Resolves port number from PORT environment variable or defaults to 3000 */
/* What it brings: Seamless port assignment on cloud runtimes like Vercel and local machines */
/* Where changes can be seen: Listening HTTP port */
const PORT = Number(process.env.PORT) || 3000;

/* What this line does: Binds to 0.0.0.0 in cloud/Vercel or explicit HOST, and 127.0.0.1 on local machines */
/* What it brings: Allows container ingress on Vercel while preserving local loopback security */
/* Where changes can be seen: Incoming network socket binding in server.listen */
const HOST = process.env.HOST || (process.env.VERCEL ? '0.0.0.0' : '127.0.0.1');

const DASHBOARD_DIR = path.resolve(__dirname, 'dashboard');

/** Subjects with a posting batch in flight, as "<group>::<subject>".
 *  Two overlapping batches read the same unposted rows and send both copies, so
 *  the second caller is turned away rather than allowed to duplicate the first.
 *  This covers a re-click or a cron firing on top of a manual run within one
 *  instance; it is not a distributed lock. */
const postsInFlight = new Set();

/**
 * Wall-clock budget for handling one Telegram bot update, in milliseconds.
 * Telegram waits about a minute before treating a webhook as failed and
 * retrying it; a retry re-runs the handler and can issue a second payment link
 * for one tap. Stay clearly under that.
 */
const BOT_UPDATE_BUDGET_MS = 20000;

/** Wall-clock budget for one /api/telegram/post request, in milliseconds.
 *  The loop stops on its own before this, so the partial batch is reported
 *  honestly instead of the platform killing the request mid-write. Keep it
 *  below the platform's function timeout (`maxDuration` in vercel.json). */
const POST_BUDGET_MS = Number(process.env.POST_BUDGET_MS) || 240000;

/** Most questions one request will post. Anything larger is better split
 *  across runs than raced against the function timeout. */
const MAX_POST_BATCH = 20;

/** Largest JSON body we accept. A full batch of questions is far below this. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Apps Script version these dashboards require. Older deployments lack the
 *  analytics, browse and edit actions, so the UI warns instead of failing. */
const REQUIRED_SHEET_VERSION = 'v6 (30 columns + membership)';

/** Major version number REQUIRED_SHEET_VERSION asks for, e.g. 6. */
const REQUIRED_SHEET_MAJOR = Number(REQUIRED_SHEET_VERSION.match(/^v(\d+)/)[1]);

/** Whether a deployment's reported version is new enough for the dashboards.
 *  A later major version is fine; only an older one is a problem. Both the
 *  ping route and the health report ask this, and when they each carried their
 *  own copy of the test one was left behind on an upgrade and the Health page
 *  called a current deployment outdated against itself. */
function sheetVersionIsCurrent(version) {
  const major = Number((String(version).match(/^v(\d+)/) || [])[1]);
  return Number.isFinite(major) && major >= REQUIRED_SHEET_MAJOR;
}

/** Rate limit: requests allowed per IP inside the window. */
const RATE_LIMIT_MAX = 240;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Extensions we are willing to serve, mapped to their content types. */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Per-IP request counters: ip -> { count, resetAt }. */
const rateBuckets = new Map();

/**
 * checkRateLimit — fixed-window counter per client address.
 *
 * @param {string} ip Remote address
 * @returns {boolean} true when the request may proceed
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

// Drop expired buckets periodically so the map cannot grow without bound.
const rateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
rateCleanup.unref();

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * applySecurityHeaders — headers applied to every response.
 * The CSP allowlists exactly the Google origins Firebase Auth needs and
 * nothing else, so an injected script has nowhere to send data.
 */
function applySecurityHeaders(res) {
  const projectId = auth.getProjectId();
  const authFrames = projectId
    ? `https://${projectId}.firebaseapp.com https://accounts.google.com`
    : 'https://accounts.google.com';

  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://www.gstatic.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://lh3.googleusercontent.com https://*.googleusercontent.com",
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://www.gstatic.com",
    `frame-src ${authFrames}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
}

/**
 * sendJSON — writes a JSON response.
 * Deliberately sends no Access-Control-Allow-Origin: the dashboard is served
 * from this same origin, so it needs none, and omitting it means no other site
 * can read our responses.
 */
function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** Sends a plain-text error without leaking internals. */
function sendText(res, statusCode, message) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

/**
 * readJsonBody — buffers and parses a request body, aborting if it is too big.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<Object>} Parsed JSON body
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      return;
    }

    const chunks = [];
    let received = 0;

    req.on('data', (chunk) => {
      received += chunk.length;
      // Enforce the cap on the actual stream too — Content-Length can lie.
      if (received > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', reject);

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('Body must be a JSON object'), { statusCode: 400 }));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }));
      }
    });
  });
}

/**
 * readRawBody — buffers a request body as raw bytes.
 *
 * A webhook signature is an HMAC over the EXACT bytes Razorpay sent.
 * Re-serialising parsed JSON changes key order and whitespace, so the hash
 * would never match. Everything else uses readJsonBody; this exists only for
 * signature verification.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>} The body as a UTF-8 string
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Field length ceilings, so one oversized paste cannot wreck a sheet. */
const LIMITS = {
  question: 4000,
  option: 300,
  explanation: 4000,
  short: 200,
  url: 500,
  notes: 1000
};

/** Maximum questions accepted in a single upload. */
const MAX_QUESTIONS_PER_BATCH = 100;

/** Coerces to a trimmed string of at most `max` characters. */
function str(value, max) {
  return String(value === null || value === undefined ? '' : value).trim().slice(0, max);
}

/**
 * sanitiseQuestion — normalises one incoming question object.
 * Only known fields survive; anything else the client sends is dropped, which
 * is what stops a crafted payload from setting Posted or Added By directly.
 *
 * @returns {{ok: boolean, error?: string, value?: Object}}
 */
function sanitiseQuestion(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `Question ${index + 1} is not an object` };
  }

  const question = str(raw.question || raw.question_text, LIMITS.question);
  if (!question) return { ok: false, error: `Question ${index + 1} has empty question text` };

  const answer = str(raw.correct_answer, 4).toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(answer)) {
    return { ok: false, error: `Question ${index + 1} has an invalid correct answer "${answer}" (expected A, B, C or D)` };
  }

  const options = ['a', 'b', 'c', 'd'].map((letter) => str(raw['option_' + letter], LIMITS.option));
  if (options.some((o) => !o)) {
    return { ok: false, error: `Question ${index + 1} is missing one or more options` };
  }

  // Only allow http(s) source links — no javascript: or data: URLs into a cell
  // that a curator may later click from the sheet.
  let sourceUrl = str(raw.source_url || raw.sourceUrl, LIMITS.url);
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) sourceUrl = '';

  return {
    ok: true,
    value: {
      date: str(raw.date, 40),
      newspaper: str(raw.newspaper, LIMITS.short),
      topic: str(raw.topic, LIMITS.short),
      question,
      option_a: options[0],
      option_b: options[1],
      option_c: options[2],
      option_d: options[3],
      correct_answer: answer,
      explanation: str(raw.explanation, LIMITS.explanation),
      difficulty: str(raw.difficulty, 20) || 'Medium',
      tags: str(raw.tags, LIMITS.short),
      source_url: sourceUrl,
      // What this does: Sets the default workflow status for newly added questions to 'Approved'
      // What it brings: Ensures all incoming questions default to Approved as requested by the user
      // Where changes can be seen: In API responses from /api/questions and rows saved to Google Sheets
      status: str(raw.status, 20) || 'Approved',
      review_notes: str(raw.review_notes, LIMITS.notes),
      scheduled_for: str(raw.scheduled_for, 40)
    }
  };
}

/**
 * sanitiseQuestionBatch — validates a whole upload.
 *
 * @returns {{ok: boolean, error?: string, value?: Array<Object>}}
 */
function sanitiseQuestionBatch(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: 'No questions provided' };
  }
  if (questions.length > MAX_QUESTIONS_PER_BATCH) {
    return { ok: false, error: `Too many questions in one batch (max ${MAX_QUESTIONS_PER_BATCH})` };
  }

  const clean = [];
  for (let i = 0; i < questions.length; i++) {
    const result = sanitiseQuestion(questions[i], i);
    if (!result.ok) return result;
    clean.push(result.value);
  }
  return { ok: true, value: clean };
}

/**
 * validateSubject — a subject must be a plain, reasonable sheet-tab name.
 * This keeps an arbitrary string out of the sheet-name lookups on the Apps
 * Script side.
 */
function validateSubject(value) {
  const subject = str(value, 60);
  if (!subject) return { ok: false, error: 'Missing "subject"' };
  if (!/^[A-Za-z0-9 &()\-.]+$/.test(subject)) {
    return { ok: false, error: 'Subject contains unsupported characters' };
  }
  return { ok: true, value: subject };
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

/**
 * resolveStaticPath — maps a URL path to a real file inside dashboard/.
 * Percent-encoding is decoded first (so %2e%2e is caught), the path is
 * normalised, and the result must sit strictly inside DASHBOARD_DIR — compared
 * with a trailing separator so a sibling like `dashboard-backup` cannot match
 * the prefix. Only allowlisted extensions are served.
 *
 * @returns {string|null} Absolute file path, or null when the request is unsafe
 */
function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    return null; // Malformed percent-encoding.
  }

  if (decoded.includes('\0')) return null;

  const requested = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.resolve(DASHBOARD_DIR, '.' + path.posix.normalize(requested));

  if (resolved !== DASHBOARD_DIR && !resolved.startsWith(DASHBOARD_DIR + path.sep)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(MIME_TYPES, path.extname(resolved).toLowerCase())) {
    return null;
  }
  return resolved;
}

/** Streams a static file, or 404s. */
async function serveStatic(res, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    sendText(res, 404, '404 Not Found');
    return;
  }

  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) {
      sendText(res, 404, '404 Not Found');
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', MIME_TYPES[path.extname(filePath).toLowerCase()]);
    res.setHeader('Content-Length', stats.size);
    // Dashboards change often during curation; never let a stale copy stick.
    res.setHeader('Cache-Control', 'no-cache');

    fs.createReadStream(filePath)
      .on('error', () => sendText(res, 500, '500 Internal Server Error'))
      .pipe(res);
  } catch (err) {
    sendText(res, 404, '404 Not Found');
  }
}

/**
 * createCheckoutForStudent — builds the right kind of Razorpay checkout.
 *
 * A one-time pass gets a payment link; the recurring plan gets a subscription
 * mandate. Both carry the Telegram id in `notes`, which is how the webhook
 * later knows who to let in.
 *
 * @param {Object} options { plan, telegramId, username, name }
 * @returns {Promise<Object>} { url, kind, id, plan, price }
 */
async function createCheckoutForStudent({ plan, telegramId, username, name }) {
  if (plan.type === 'recurring') {
    // Group-scoped plans come from groups.config.json and carry razorpayPlanId
    // directly; only the legacy single-group table has razorpayPlanIdEnv. This
    // used to read process.env[plan.razorpayPlanIdEnv] unconditionally, so for
    // every group plan it looked up process.env[undefined] and auto-pay failed
    // with "undefined is not set" no matter how the environment was configured.
    const razorpayPlanId = String(
      plan.razorpayPlanId ||
      (plan.razorpayPlanIdEnv ? process.env[plan.razorpayPlanIdEnv] : '') ||
      ''
    ).trim();

    if (!razorpayPlanId) {
      const envName = plan.groupId
        ? `RAZORPAY_PLAN_${groupRegistry.requireGroup(plan.groupId).envPrefix}`
        : (plan.razorpayPlanIdEnv || 'RAZORPAY_MONTHLY_PLAN_ID');
      throw new Error(
        `${envName} is not set. Run "node setup-razorpay.js" once and put the id in .env.`
      );
    }

    const subscription = await razorpay.createSubscription({
      plan, razorpayPlanId, telegramId, username
    });
    return {
      url: subscription.short_url,
      kind: 'subscription',
      id: subscription.id,
      plan: plan.id,
      price: plans.formatAmount(plan.amountPaise)
    };
  }

  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const link = await razorpay.createPaymentLink({
    plan,
    telegramId,
    username,
    name,
    callbackUrl: base ? `${base}/payment-success.html` : undefined
  });

  return {
    url: link.short_url,
    kind: 'payment_link',
    id: link.id,
    plan: plan.id,
    price: plans.formatAmount(plan.amountPaise)
  };
}

/**
 * handlePaymentEvent — turns a verified Razorpay webhook into group access.
 *
 * Only the events that actually mean "money arrived" grant anything. Every
 * identity fact — who paid, for which plan — is read from `notes`, which
 * Razorpay echoes back from what WE set when creating the link. Nothing here
 * trusts a value the payer could choose.
 *
 * @param {Object} event Parsed, signature-verified webhook body
 * @returns {Promise<{handled: boolean, reason?: string}>}
 */
/**
 * deliverAccess — tells the student they are in, and gives them the link.
 *
 * grantAccess records the sale and mints the invite, but this webhook used to
 * discard the link it returned, so a paying student was recorded as active and
 * never told. The money moved, the row appeared, and nothing reached the buyer.
 *
 * A failure here must not fail the webhook: the payment is real and the row is
 * written, so a Telegram outage should leave the student able to fetch the same
 * link with /status rather than making Razorpay retry a delivery that already
 * succeeded everywhere that matters.
 *
 * @param {Object} result What grantAccess returned
 * @param {Object} plan   The plan bought
 * @param {string|number} telegramId
 */
async function deliverAccess(result, plan, telegramId, groupId) {
  if (!result || !result.inviteLink) {
    console.error('[payments] no invite link to deliver for', telegramId);
    return;
  }

  const expiry = (result.subscriber && result.subscriber.expiry_date) || '';
  const text =
    '\u2705 <b>Payment received \u2014 you are in.</b>\n\n' +
    (plan ? plan.emoji + ' <b>' + plan.label + '</b>\n' : '') +
    (expiry ? 'Access until <b>' + expiry + '</b>\n\n' : '\n') +
    'Tap to request access:\n' + result.inviteLink + '\n\n' +
    '<i>You are approved automatically. The link is tied to this Telegram account \u2014 ' +
    'forwarding it will not let anyone else in.</i>\n\n' +
    'Send /status any time to see how long you have left.';

  try {
    await paybot.sendDirectMessage(groupRegistry.requireGroup(groupId).paymentBotEnv, telegramId, text);
  } catch (err) {
    // Telegram forbids a bot from opening a conversation, so this also fires
    // for someone who paid without ever messaging the bot.
    console.error('[payments] could not DM the invite to', telegramId, '-', err.message);
  }
}

/**
 * recordCouponUse — counts a coupon once its payment has actually succeeded.
 *
 * Never fails the webhook: the student has paid and must get access whether
 * or not the coupon tally can be written. The sheet ignores a payment id it
 * has already recorded, so a redelivered webhook counts nothing twice.
 */
async function recordCouponUse(notes, paymentId, paidPaise) {
  try {
    const group = groupRegistry.requireGroup(notes.group_id);
    const primary = groupRegistry.listGroups()
      .find((g) => g.ready && g.paymentBotEnv === group.paymentBotEnv) || group;
    await sheets.forGroup(primary.id).recordRedemption({
      code: notes.coupon_code,
      telegram_id: notes.telegram_id,
      username: notes.telegram_username || '',
      group: group.shortName,
      original_amount: Number(notes.original_amount) || 0,
      discount: Number(notes.discount_amount) || 0,
      paid_amount: (Number(paidPaise) || 0) / 100,
      payment_id: paymentId
    });
  } catch (err) {
    console.error(`[payments] could not record coupon ${notes.coupon_code} for ${paymentId}: ${err.message}`);
  }
}

async function handlePaymentEvent(event) {
  const type = String(event.event || '');
  const payload = event.payload || {};

  /** Pulls our own notes back out of whichever entity the event carries. */
  const notesFrom = (entity) => (entity && entity.notes) || {};

  // ---- One-time passes: a payment link was paid --------------------------
  if (type === 'payment_link.paid') {
    const link = (payload.payment_link && payload.payment_link.entity) || {};
    const payment = (payload.payment && payload.payment.entity) || {};
    const notes = notesFrom(link);

    if (!notes.telegram_id || !notes.plan_id || !notes.group_id) {
      return { handled: false, reason: 'payment link notes lacked telegram_id / plan_id / group_id' };
    }

    const paidPaise = payment.amount || link.amount_paid || link.amount;
    const granted = await membership.grantAccess({
      groupId: notes.group_id,
      telegramId: notes.telegram_id,
      planId: notes.plan_id,
      username: notes.telegram_username,
      paymentId: payment.id || link.id,
      amountPaise: paidPaise,
      linkId: link.id,
      event: type,
      validUntil: notes.valid_until,
      planLabel: notes.plan_label
    });

    if (notes.coupon_code) {
      await recordCouponUse(notes, payment.id || link.id, paidPaise);
    }

    // A repeat delivery of the same payment must not send a second message.
    if (!granted.alreadyProcessed) {
      const plan = groupRegistry.getPlanFor(notes.group_id, notes.plan_id);
      await deliverAccess(granted, plan && Object.assign({}, plan, { label: notes.plan_label || plan.label }),
        notes.telegram_id, notes.group_id);
    }
    return { handled: true };
  }

  // ---- Recurring: a subscription cycle was charged -----------------------
  if (type === 'subscription.charged') {
    const subscription = (payload.subscription && payload.subscription.entity) || {};
    const payment = (payload.payment && payload.payment.entity) || {};
    const notes = notesFrom(subscription);

    if (!notes.telegram_id || !notes.plan_id || !notes.group_id) {
      return { handled: false, reason: 'subscription notes lacked telegram_id / plan_id / group_id' };
    }

    const charged = await membership.grantAccess({
      groupId: notes.group_id,
      telegramId: notes.telegram_id,
      planId: notes.plan_id,
      username: notes.telegram_username,
      paymentId: payment.id || subscription.id,
      amountPaise: payment.amount,
      subscriptionId: subscription.id,
      event: type
    });

    // The first charge of a subscription IS the buyer's initial payment, so an
    // auto-pay customer arrives here rather than through payment_link.paid.
    // Without this they would pay and never be sent a link. Renewals by someone
    // already in the group are skipped: they need no invite, and a monthly link
    // is something members would learn to forward.
    if (!charged.alreadyProcessed && charged.isRejoining) {
      await deliverAccess(charged, groupRegistry.getPlanFor(notes.group_id, notes.plan_id), notes.telegram_id, notes.group_id);
    }
    return { handled: true };
  }

  // ---- Recurring: the mandate ended --------------------------------------
  // The member keeps what they already paid for; the daily cron removes them
  // when the paid period actually runs out.
  if (type === 'subscription.cancelled' || type === 'subscription.halted') {
    const subscription = (payload.subscription && payload.subscription.entity) || {};
    const notes = notesFrom(subscription);
    if (!notes.telegram_id || !notes.group_id) {
      return { handled: false, reason: 'no telegram_id / group_id in notes' };
    }

    await sheets.forGroup(notes.group_id).upsertSubscriber({
      telegram_id: notes.telegram_id,
      status: 'cancelled',
      subscription_id: subscription.id,
      notes: `Subscription ${type.split('.')[1]} on ${membership.formatIst(new Date())}. ` +
             'Access continues until the paid period ends.',
      is_payment: false
    }, type);
    return { handled: true };
  }

  // Everything else (payment.captured for a link we already handled,
  // authorisations, refunds) is acknowledged without action.
  return { handled: false, reason: `no handler for "${type}"` };
}

/**
 * canonicalRedirect — returns the localhost URL to send a 127.0.0.1 request to.
 *
 * Set CANONICAL_HOST_REDIRECT=false in .env to switch this off (for example if
 * you deliberately added 127.0.0.1 to your Firebase authorised domains).
 *
 * @param {URL} parsedUrl The incoming request URL
 * @returns {string|null} Absolute URL to redirect to, or null to serve normally
 */
function canonicalRedirect(parsedUrl) {
  if (String(process.env.CANONICAL_HOST_REDIRECT || '').toLowerCase() === 'false') return null;
  if (parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== '[::1]' && parsedUrl.hostname !== '::1') {
    return null;
  }
  return `http://localhost:${parsedUrl.port || PORT}${parsedUrl.pathname}${parsedUrl.search}`;
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------

/** True when the bot token and group id are both present. */
function telegramConfigured() {
  /* What this line does: Validates presence of TELEGRAM_BOT_TOKEN and either TELEGRAM_GROUP_ID or TELEGRAM_CHANNEL_ID */
  /* What it brings: Seamless support for both Telegram supergroup setups and channel setups */
  /* Where changes can be seen: /api/config telegramConfigured flag and posting capability checks */
  const chatId = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHANNEL_ID;
  return Boolean(
    String(process.env.TELEGRAM_BOT_TOKEN || '').trim() &&
    String(chatId || '').trim()
  );
}

/** Lazily initialises the Telegram client the first time it is needed. */
let telegramReady = false;
function ensureTelegram() {
  /* What this line does: Verifies configuration before attempting to initialize client */
  /* What it brings: Clear explanatory error if credentials are not configured */
  /* Where changes can be seen: /api/telegram/post endpoint */
  if (!telegramConfigured()) {
    throw new Error('Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_GROUP_ID in .env');
  }
  /* What this line does: Lazily creates Telegram bot client once when needed */
  /* What it brings: Avoids startup crashes if network is briefly unavailable */
  /* Where changes can be seen: Telegram dispatch execution */
  if (!telegramReady) {
    const chatId = process.env.TELEGRAM_GROUP_ID || process.env.TELEGRAM_CHANNEL_ID;
    telegram.init(process.env.TELEGRAM_BOT_TOKEN, chatId);
    telegramReady = true;
  }
}

// ---------------------------------------------------------------------------
// Payment bots, served over Telegram webhooks
// ---------------------------------------------------------------------------
// The bots used to be three long-running laptop processes started by hand, so
// in practice one ran and two did not — and the one that did had been started
// before the prices changed and kept quoting the old ones from memory. Served
// from here there is no process to forget, all three answer, and a price change
// takes effect on deploy.

/** Bots built so far, keyed by their token env var. Built on first update and
 *  reused for the life of the instance, so a warm function does no extra work. */
const paymentBots = new Map();

/**
 * paymentBotFor — the bot for one family, built once per instance.
 *
 * @param {string} payBotEnv Env var naming the bot's token
 * @returns {Object} The bot app from src/botapp.js
 */
function paymentBotFor(payBotEnv) {
  if (!paymentBots.has(payBotEnv)) {
    paymentBots.set(payBotEnv, botapp.createPaymentBot({ payBotEnv, polling: false }));
  }
  return paymentBots.get(payBotEnv);
}

/** Every payment-bot env var a ready group names, deduplicated. */
function paymentBotEnvs() {
  return [...new Set(
    groupRegistry.listGroups()
      .filter((g) => g.ready && g.paymentBotEnv)
      .map((g) => g.paymentBotEnv)
  )].filter((env) => String(process.env[env] || '').trim());
}

/**
 * telegramWebhookSecret — the value Telegram must echo back in a header.
 *
 * Telegram sends X-Telegram-Bot-Api-Secret-Token on every webhook delivery. It
 * is the only thing separating a real update from anyone who guesses the URL,
 * and this endpoint hands out invite links, so a missing secret means the
 * endpoint refuses to run rather than trusting whatever arrives.
 *
 * Derived from CRON_SECRET so there is one fewer secret to set and rotate; it
 * is a distinct value, not CRON_SECRET itself.
 *
 * @returns {string} The secret, or '' when CRON_SECRET is unset
 */
function telegramWebhookSecret() {
  const base = String(process.env.TELEGRAM_WEBHOOK_SECRET || process.env.CRON_SECRET || '').trim();
  if (!base) return '';
  return crypto.createHash('sha256').update('telegram-webhook:' + base).digest('hex').slice(0, 48);
}

/** Payment-bot usernames, resolved once per instance. */
const botUsernameCache = new Map();

/**
 * paymentBotUsername — the @handle of the bot that sells a group.
 *
 * The thank-you page uses it to offer a real "back to Telegram" button rather
 * than the words "go back to Telegram", which on a phone means the student has
 * to find the chat themselves.
 *
 * @param {string} payBotEnv Env var naming the bot's token
 * @returns {Promise<string|null>} Username without the @, or null
 */
async function paymentBotUsername(payBotEnv) {
  if (botUsernameCache.has(payBotEnv)) return botUsernameCache.get(payBotEnv);
  const me = await paybot.getMe(payBotEnv);
  const username = (me && me.username) || null;
  botUsernameCache.set(payBotEnv, username);
  return username;
}

/**
 * describeShortfall — why the batch was smaller than the number asked for.
 *
 * "2 of 2 posted" after asking for 5 looks like a broken poster. It is usually
 * a full queue: everything else is already posted, or still a Draft. Counting
 * the tab and naming the reason turns that into an answer.
 *
 * @param {Object} db Group-bound sheets client
 * @param {string} subject Subject tab
 * @param {number} asked How many the curator requested
 * @param {number} eligible How many were actually available
 * @param {boolean} requireApproved Whether Drafts were excluded
 * @returns {Promise<string>} One sentence, or a fallback when the tab cannot be read
 */
async function describeShortfall(db, subject, asked, eligible, requireApproved) {
  try {
    const page = await db.listQuestions({ subject, pageSize: 500 });
    const all = page.questions || [];

    const posted = all.filter((q) => String(q.posted).toUpperCase() === 'YES').length;
    const sending = all.filter((q) => q.claimed).length;
    const draft = all.filter((q) =>
      String(q.posted).toUpperCase() !== 'YES' && !q.claimed &&
      !['Approved', 'Scheduled', 'Rejected', 'Archived'].includes(q.status)).length;
    const refused = all.filter((q) =>
      String(q.posted).toUpperCase() !== 'YES' && !q.claimed &&
      ['Rejected', 'Archived'].includes(q.status)).length;

    const parts = [];
    if (posted) parts.push(`${posted} already posted`);
    if (draft) parts.push(`${draft} not approved yet`);
    if (refused) parts.push(`${refused} rejected or archived`);
    if (sending) parts.push(`${sending} held as "Sending"`);

    if (!parts.length) return `"${subject}" has nothing else to send.`;
    return `The rest of "${subject}": ${parts.join(', ')}.` +
      (draft && requireApproved
        ? ' Approve them in the Question Bank, or switch eligibility to include Drafts.'
        : '');
  } catch (err) {
    // Never let the explanation break the response that reports real posts.
    return `Only ${eligible} of ${asked} were eligible in "${subject}".`;
  }
}

/** Small promise delay used to stay under Telegram's rate limits. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

/**
 * handlePublicRoute — the two endpoints that work before sign-in.
 * Neither returns any spreadsheet content or secret value.
 *
 * @param {string} pathname Request path
 * @param {string} method HTTP method
 * @param {http.IncomingMessage} req Needed by the webhook, which must read the
 *   raw request body to verify Razorpay's signature over the exact bytes sent
 * @param {http.ServerResponse} res
 * @returns {Promise<boolean>} true when the route was handled
 */
async function handlePublicRoute(pathname, method, req, res) {
  // Client bootstrap: what the browser needs to render the login gate.
  if (pathname === '/api/config' && method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      firebaseProjectId: auth.getProjectId() || null,
      authEnforced: auth.isConfigured(),
      // Deliberately reports only whether the sheet is wired up. The Web App
      // URL itself stays on the server; the browser never needs it.
      sheetConfigured: sheets.isConfigured(),
      telegramConfigured: telegramConfigured(),
      allowRegistration: String(process.env.ALLOW_SELF_REGISTRATION || '').toLowerCase() === 'true'
    });
    return true;
  }

  // Plan catalogue. Public: it is a price list, and the bot reads it too.
  if (pathname === '/api/plans' && method === 'GET') {
    // Group-scoped. This used to serve plans.listPlans() — the legacy global
    // table — so the Members page advertised "what students can buy right now"
    // at prices no group actually charges. The bot and the checkout have been
    // group-aware for a while; this was the last screen that was not.
    let group = '';
    try {
      group = String(new URL(req.url, 'http://localhost').searchParams.get('group') || '').trim();
    } catch (err) {
      group = '';
    }

    let catalogue;
    if (group) {
      try {
        catalogue = groupRegistry.plansFor(group);
      } catch (err) {
        sendJSON(res, 400, { success: false, error: err.message.split('\n')[0] });
        return true;
      }
    } else {
      // No group named: report every group's catalogue rather than inventing a
      // default. A single price list here is what made the old bug invisible.
      catalogue = null;
    }

    const describe = (plan) => ({
      id: plan.id,
      label: plan.label,
      emoji: plan.emoji,
      price: plans.formatAmount(plan.amountPaise),
      amountPaise: plan.amountPaise,
      type: plan.type,
      durationDays: plan.durationDays,
      tagline: plan.tagline,
      description: plan.description
    });

    sendJSON(res, 200, {
      success: true,
      data: {
        configured: razorpay.isConfigured(),
        testMode: razorpay.isTestMode(),
        group: group || null,
        plans: catalogue ? catalogue.map(describe) : [],
        // Always present, so a caller that names no group still sees real
        // prices instead of a plausible-looking wrong one.
        groups: groupRegistry.listGroups().map((g) => ({
          id: g.id,
          label: g.displayName,
          plans: groupRegistry
            .plansFor(g.id)
            .map(describe)
        }))
      }
    });
    return true;
  }

  // ---- Payment confirmation for the thank-you page ------------------------
  // Public because the payer is a student in a browser, not a signed-in
  // curator. It grants nothing: it only says what was bought, so the page can
  // name the pass and point at the right bot instead of showing one generic
  // message for five groups. The redirect's HMAC is checked all the same —
  // otherwise anyone could ask this endpoint about any payment link id.
  if (pathname === '/api/payments/confirm' && method === 'GET') {
    let query;
    try {
      query = new URL(req.url, 'http://localhost').searchParams;
    } catch (err) {
      sendJSON(res, 400, { success: false, error: 'Bad request' });
      return true;
    }

    const paymentLinkId = str(query.get('razorpay_payment_link_id'), 60);
    const paymentId = str(query.get('razorpay_payment_id'), 60);
    const referenceId = str(query.get('razorpay_payment_link_reference_id'), 120);
    const status = str(query.get('razorpay_payment_link_status'), 30);
    const signature = str(query.get('razorpay_signature'), 200);

    if (!paymentLinkId || !signature) {
      sendJSON(res, 400, { success: false, error: 'Incomplete payment reference' });
      return true;
    }

    let valid = false;
    try {
      valid = razorpay.verifyPaymentLinkSignature({
        paymentLinkId, paymentId, referenceId, status, signature
      });
    } catch (err) {
      valid = false;
    }
    if (!valid) {
      console.warn('[payments] confirm called with a bad signature');
      sendJSON(res, 401, { success: false, error: 'Could not verify this payment' });
      return true;
    }

    // Read the link back from Razorpay rather than trusting the query string
    // for anything but identity: notes are what we set when creating it.
    let link;
    try {
      link = await razorpay.getPaymentLink(paymentLinkId);
    } catch (err) {
      sendJSON(res, 502, { success: false, error: 'Could not reach Razorpay just now' });
      return true;
    }

    const notes = link.notes || {};
    let group = null;
    try {
      group = groupRegistry.requireGroup(notes.group_id);
    } catch (err) {
      group = null;
    }
    const plan = group ? groupRegistry.getPlanFor(group.id, notes.plan_id) : null;

    // The bot to send them back to. Looked up once and cached: this page is
    // hit right after every payment and the username never changes.
    let botUsername = null;
    if (group) {
      try {
        botUsername = await paymentBotUsername(group.paymentBotEnv);
      } catch (err) {
        botUsername = null;
      }
    }

    sendJSON(res, 200, {
      success: true,
      data: {
        status: String(link.status || status || ''),
        paid: String(link.status || '').toLowerCase() === 'paid',
        amountPaise: Number(link.amount) || (plan ? plan.amountPaise : null),
        planLabel: plan ? plan.label : null,
        planEmoji: plan ? plan.emoji : null,
        recurring: plan ? plan.type === 'recurring' : false,
        groupName: group ? group.displayName : null,
        botUsername
      }
    });
    return true;
  }

  // ---- Razorpay webhook --------------------------------------------------
  // Public because Razorpay's servers call it, and they cannot present a
  // Firebase token. It is NOT unauthenticated: the HMAC signature over the raw
  // body is the credential, and a request without a valid one is rejected
  // before a single field of its payload is read.
  if (pathname === '/api/payments/webhook' && method === 'POST') {
    const rawBody = await readRawBody(req);
    const signature = req.headers['x-razorpay-signature'];

    if (!razorpay.verifyWebhookSignature(rawBody, signature)) {
      // Deliberately terse: telling a forger why they failed helps them.
      console.warn('[payments] rejected a webhook with an invalid signature');
      sendJSON(res, 401, { success: false, error: 'Invalid signature' });
      return true;
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      sendJSON(res, 400, { success: false, error: 'Malformed webhook payload' });
      return true;
    }

    try {
      const result = await handlePaymentEvent(event);
      // Always 200 once handled, so Razorpay stops retrying.
      sendJSON(res, 200, { success: true, handled: result.handled, reason: result.reason || null });
    } catch (err) {
      // A 500 makes Razorpay retry, which is what we want for a transient
      // failure — the payment is real and must not be silently dropped.
      console.error('[payments] webhook handling failed:', err.message);
      sendJSON(res, 500, { success: false, error: 'Processing failed, please retry' });
    }
    return true;
  }

  // ---- Telegram bot webhooks ---------------------------------------------
  // Public in the routing sense only: Telegram cannot present a Firebase token,
  // so the credential is the secret it echoes in a header. Without a matching
  // one this refuses to act — the endpoint hands out paid-group invite links.
  if (pathname.startsWith('/api/telegram/bot/') && method === 'POST') {
    const secret = telegramWebhookSecret();
    if (!secret) {
      // Refusing beats running unauthenticated: anyone who guessed the URL
      // could otherwise drive the bot.
      sendJSON(res, 503, {
        success: false,
        error: 'No TELEGRAM_WEBHOOK_SECRET or CRON_SECRET set, so the bot webhook refuses to run.'
      });
      return true;
    }

    const offered = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    const a = Buffer.from(offered);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('[bot] rejected a webhook with a bad secret token');
      sendJSON(res, 401, { success: false, error: 'Unauthorised' });
      return true;
    }

    const payBotEnv = decodeURIComponent(pathname.slice('/api/telegram/bot/'.length));
    if (!paymentBotEnvs().includes(payBotEnv)) {
      sendJSON(res, 404, { success: false, error: `No payment bot is configured as "${payBotEnv}".` });
      return true;
    }

    let update;
    try {
      update = JSON.parse(await readRawBody(req));
    } catch (err) {
      sendJSON(res, 400, { success: false, error: 'Malformed update' });
      return true;
    }

    // Do the work BEFORE answering Telegram.
    //
    // This used to answer 200 first, on the reasoning that Telegram retries
    // anything it does not get a prompt 200 for and a retry would mean a second
    // payment link for one tap. That reasoning holds for a long-lived server
    // and is fatal here: the instance is frozen the moment the response is
    // sent, so the handler's outbound call to Telegram died mid-TLS-handshake
    // with "Client network socket disconnected", exit 128. Telegram recorded a
    // clean delivery and the student got no reply — every bot silently useless.
    //
    // processUpdate() dispatches synchronously and returns nothing, so settle()
    // (see src/botapp.js) is what actually waits for the handlers.
    try {
      const app = paymentBotFor(payBotEnv);
      app.bot.processUpdate(update);
      // Cap the wait well under Telegram's patience: if a handler hangs on
      // Razorpay or Sheets, a late 200 becomes a retry and a duplicate payment
      // link. Answering on time and letting the straggler finish is safer.
      let budgetTimer;
      try {
        await Promise.race([
          app.settle(),
          new Promise((resolve) => {
            budgetTimer = setTimeout(resolve, BOT_UPDATE_BUDGET_MS);
          })
        ]);
      } finally {
        // The losing timer keeps the event loop alive for the full budget —
        // holding the instance open long after the reply went out, and hanging
        // process exit for anything that runs this in-process.
        clearTimeout(budgetTimer);
      }
    } catch (err) {
      console.error(`[bot] ${payBotEnv} failed to handle an update:`, err.message);
    }
    sendJSON(res, 200, { success: true });
    return true;
  }

  // Liveness of the Apps Script deployment, for the header status pill.
  // ---- Scheduled expiry sweep ---------------------------------------------
  // Runs the same check membership-cron.js runs, but on a schedule Vercel owns
  // rather than on a laptop that sleeps. Removing lapsed members is the half of
  // this product that has to keep working when nobody is watching: without it a
  // 30-day pass simply never ends, and everyone who ever paid stays forever.
  //
  // Public in the routing sense only. Vercel Cron sends
  // `Authorization: Bearer $CRON_SECRET`, and without a matching secret this
  // refuses to run — otherwise anyone who found the URL could trigger removals.
  if (pathname === '/api/cron/sweep' && (method === 'POST' || method === 'GET')) {
    const secret = String(process.env.CRON_SECRET || '').trim();
    if (!secret) {
      sendJSON(res, 503, {
        success: false,
        error: 'CRON_SECRET is not set, so the scheduled sweep refuses to run.'
      });
      return true;
    }

    const offered = String(req.headers.authorization || '');
    // Constant-time compare: a timing oracle on a secret that can remove paying
    // members is not worth saving three lines over.
    const expected = `Bearer ${secret}`;
    const a = Buffer.from(offered);
    const b = Buffer.from(expected);
    const authorised = a.length === b.length && crypto.timingSafeEqual(a, b);

    if (!authorised) {
      sendJSON(res, 401, { success: false, error: 'Unauthorised' });
      return true;
    }

    try {
      const summary = await membership.runDailyCheckAllGroups({ dryRun: false });
      console.log(
        `[cron] sweep across ${summary.groups.length} group(s): ` +
        `reminded ${summary.totals.reminded}, removed ${summary.totals.removed}`
      );
      sendJSON(res, 200, { success: true, data: summary });
    } catch (err) {
      console.error('[cron] sweep failed:', err.message);
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  if (pathname === '/api/ping' && method === 'GET') {
    if (!sheets.isConfigured()) {
      sendJSON(res, 200, { success: false, status: 'unconfigured', error: 'GOOGLE_SHEET_WEBAPP_URL is not set in .env' });
      return true;
    }
    try {
      const result = await sheets.ping();
      // v5 reports `version`; older deployments only put it in `message`.
      const version = result.version ||
        (String(result.message || '').match(/v\d+[^)"]*/) || ['unknown'])[0].trim();

      // The dashboards call actions that only exist in v6 of the Apps Script
      // (the membership reads behind the Members page). Detect an older
      // deployment here so the UI can say exactly what to do instead of
      // surfacing an opaque "Unknown action" from Google.
      const outdated = !sheetVersionIsCurrent(version);

      // A script that is not bound to a spreadsheet was pasted into a
      // standalone project instead of the Sheet's own Extensions > Apps Script.
      const unbound = result.boundToSpreadsheet === false;

      sendJSON(res, 200, {
        success: true,
        status: 'ok',
        version,
        outdated,
        unbound,
        spreadsheetName: result.spreadsheetName || null,
        requiredVersion: REQUIRED_SHEET_VERSION,
        tokenRequired: result.tokenRequired,
        upgradeHint: outdated
          ? 'The Web App at your GOOGLE_SHEET_WEBAPP_URL is running ' + version + '. Open your Google ' +
            'Sheet > Extensions > Apps Script (NOT script.google.com — that creates a standalone project ' +
            'with a different URL), paste the current google_apps_script.js, run upgradeSpreadsheet, then ' +
            'Deploy > Manage deployments > Edit > New version. Redeploying that project keeps this same URL.'
          : null
      });
    } catch (err) {
      sendJSON(res, 200, { success: false, status: 'offline', error: err.message });
    }
    return true;
  }

  return false;
}

/** The groups one payment bot sells, in configuration order. */
function familyOf(groupId) {
  const group = groupRegistry.requireGroup(groupId);
  const family = groupRegistry.listGroups()
    .filter((g) => g.ready && g.paymentBotEnv && g.paymentBotEnv === group.paymentBotEnv);
  return { group, family, primary: family[0] || group };
}

/** Invalidates a running bot's cached settings, so a dashboard save applies at once. */
function refreshBotSettings(payBotEnv) {
  const app = paymentBots.get(payBotEnv);
  if (app && app.settingsCache) app.settingsCache.invalidate();
}

/**
 * handleSupportRoute — tickets and bot settings for the Support page.
 *
 * @returns {Promise<boolean>} true when the route was handled
 */
async function handleSupportRoute(pathname, method, req, res, query, groupId, selectedDb, actor) {
  const { group, primary } = familyOf(groupId);
  // A bot's tickets and settings live in its first group's sheet, whichever of
  // its groups the dashboard is looking at.
  const db = primary.id === group.id ? selectedDb : sheets.forGroup(primary.id);
  const context = {
    groupId: group.id,
    primaryGroupId: primary.id,
    primaryGroupName: primary.shortName,
    isPrimary: primary.id === group.id,
    payBotEnv: group.paymentBotEnv || '',
    botConfigured: paymentBotEnvs().includes(group.paymentBotEnv),
    supportChatConfigured: Boolean(support.supportChatFor(group.paymentBotEnv))
  };

  if (pathname === '/api/support/tickets' && method === 'GET') {
    const status = str(query.get('status'), 20).toLowerCase();
    const data = await db.listTickets({
      status: support.TICKET_STATUSES.includes(status) ? status : '',
      search: str(query.get('search'), 120),
      page: str(query.get('page'), 8) || '1',
      pageSize: str(query.get('pageSize'), 4) || '50'
    });
    sendJSON(res, 200, { success: true, data: Object.assign({ context }, data) });
    return true;
  }

  if (pathname === '/api/support/ticket' && method === 'GET') {
    const ticketId = str(query.get('id'), 20);
    if (!TICKET_ID_RE.test(ticketId)) {
      sendJSON(res, 400, { success: false, error: 'A valid ticket id (T-yymmdd-XXXX) is required.' });
      return true;
    }
    const ticket = await db.getTicket(ticketId);
    if (!ticket) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found in this group's sheet.` });
      return true;
    }
    sendJSON(res, 200, { success: true, data: ticket });
    return true;
  }

  if (pathname === '/api/support/reply' && method === 'POST') {
    const body = await readJsonBody(req);
    const ticketId = str(body.ticketId, 20);
    const text = str(body.text, support.MAX_MESSAGE_CHARS + 1);
    if (!TICKET_ID_RE.test(ticketId)) {
      sendJSON(res, 400, { success: false, error: 'A valid ticketId is required.' });
      return true;
    }
    if (!text) {
      sendJSON(res, 400, { success: false, error: 'The reply is empty.' });
      return true;
    }
    if (text.length > support.MAX_MESSAGE_CHARS) {
      sendJSON(res, 400, { success: false, error: `Replies are limited to ${support.MAX_MESSAGE_CHARS} characters.` });
      return true;
    }

    const ticket = await db.getTicket(ticketId);
    if (!ticket) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found in this group's sheet.` });
      return true;
    }

    const app = supportBotFor(res, ticket);
    if (!app) return true;

    try {
      await app.bot.sendMessage(ticket.telegram_id,
        `${support.esc(support.replyLine(ticketId))}\n\n${support.esc(text)}\n\n` +
        '<i>Reply to this message to answer.</i>',
        { parse_mode: 'HTML' });
    } catch (err) {
      sendJSON(res, 502, {
        success: false,
        error: `Telegram did not deliver the reply: ${err.message}. The student may have blocked the bot.`
      });
      return true;
    }

    let updated = null;
    let warning = '';
    try {
      updated = await db.appendTicketMessage(ticketId, {
        author: `Admin ${actor}`, text, status: 'answered', handledBy: actor
      });
    } catch (err) {
      // The student already has the message; failing the request now would
      // invite a second send.
      warning = `Delivered, but the sheet was not updated: ${err.message}`;
    }

    await mirrorToSupportChat(app, ticket,
      `💻 Answered from the dashboard by ${support.esc(actor)}:\n\n${support.esc(text)}`);

    sendJSON(res, 200, { success: true, data: updated, warning });
    return true;
  }

  if (pathname === '/api/support/resend-invite' && method === 'POST') {
    const body = await readJsonBody(req);
    const ticketId = str(body.ticketId, 20);
    if (!TICKET_ID_RE.test(ticketId)) {
      sendJSON(res, 400, { success: false, error: 'A valid ticketId is required.' });
      return true;
    }
    const ticket = await db.getTicket(ticketId);
    if (!ticket) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found in this group's sheet.` });
      return true;
    }
    const app = supportBotFor(res, ticket);
    if (!app) return true;

    const results = await app.resendInvites(ticket.telegram_id, { ticketId, actor });
    await mirrorToSupportChat(app, ticket,
      `🔗 <b>Resend invite</b> from the dashboard · by ${support.esc(actor)}\n\n` +
      app.describeInviteResults(results));

    sendJSON(res, 200, {
      success: true,
      data: {
        results: results.map((r) => ({
          group: r.group.shortName,
          sent: r.sent,
          delivered: r.delivered,
          status: r.status,
          reason: r.reason || '',
          error: r.error || '',
          // Only when the student could not be messaged, so an admin can pass it on.
          inviteLink: r.sent && !r.delivered ? r.inviteLink : ''
        }))
      }
    });
    return true;
  }

  if (pathname === '/api/support/student' && method === 'GET') {
    const ticketId = str(query.get('ticketId'), 20);
    if (!TICKET_ID_RE.test(ticketId)) {
      sendJSON(res, 400, { success: false, error: 'A valid ticketId is required.' });
      return true;
    }
    const ticket = await db.getTicket(ticketId);
    if (!ticket) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found.` });
      return true;
    }
    const app = supportBotFor(res, ticket);
    if (!app) return true;

    const passes = await app.studentSnapshot(ticket.telegram_id);
    sendJSON(res, 200, {
      success: true,
      data: {
        passes: passes.map((p) => ({
          group: p.group.shortName,
          groupId: p.group.id,
          hasPass: Boolean(p.subscriber),
          valid: p.eligible,
          reason: p.reason,
          inGroup: p.inGroup,
          status: p.subscriber ? p.subscriber.status : '',
          passName: p.subscriber ? (p.subscriber.plan_label || p.subscriber.plan) : '',
          expiry: p.subscriber ? p.subscriber.expiry_date : '',
          totalPaid: p.subscriber ? p.subscriber.total_paid : 0,
          paymentId: p.subscriber ? p.subscriber.payment_id : '',
          lastPaymentAt: p.subscriber ? p.subscriber.last_payment_at : ''
        })),
        suggestion: support.suggestNextStep(ticket.category, passes),
        paymentIdInTicket: support.findPaymentId(ticket.conversation)
      }
    });
    return true;
  }

  if (pathname === '/api/support/check-payment' && method === 'POST') {
    const body = await readJsonBody(req);
    const ticketId = str(body.ticketId, 20);
    const paymentId = str(body.paymentId, 40);
    if (!TICKET_ID_RE.test(ticketId) || !/^pay_[A-Za-z0-9]{8,30}$/.test(paymentId)) {
      sendJSON(res, 400, { success: false, error: 'A valid ticketId and a payment id starting with pay_ are required.' });
      return true;
    }
    const ticket = await db.getTicket(ticketId);
    if (!ticket) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found.` });
      return true;
    }
    const app = supportBotFor(res, ticket);
    if (!app) return true;

    const result = await app.checkPayment(paymentId, ticket.telegram_id);
    const payment = result.payment || null;
    try {
      await db.logTicketEvent(ticketId, {
        who: actor, role: 'admin', action: 'payment_checked',
        details: payment ? `${paymentId}: ${payment.status}, ${pricing.rupees(payment.amount)}` : `${paymentId}: not found`
      });
    } catch (err) {
      console.warn(`[support] could not log the payment check on ${ticketId}: ${err.message}`);
    }

    const notes = (payment && payment.notes) || {};
    sendJSON(res, 200, {
      success: true,
      data: {
        found: result.found,
        captured: result.captured,
        message: htmlToText(result.html),
        payment: payment && {
          id: payment.id,
          status: payment.status,
          amount: pricing.rupees(payment.amount),
          method: payment.method || '',
          createdAt: payment.created_at ? membership.formatIst(new Date(payment.created_at * 1000)) : '',
          description: payment.description || '',
          error: payment.error_description || '',
          belongsTo: notes.telegram_id
            ? (String(notes.telegram_id) === String(ticket.telegram_id) ? 'this student' : `Telegram id ${notes.telegram_id}`)
            : 'unknown'
        },
        groups: app.familyGroups().map((g) => ({ id: g.id, name: g.shortName }))
      }
    });
    return true;
  }

  if (pathname === '/api/support/grant-pass' && method === 'POST') {
    const body = await readJsonBody(req);
    const ticketId = str(body.ticketId, 20);
    const paymentId = str(body.paymentId, 40);
    if (!TICKET_ID_RE.test(ticketId) || !/^pay_[A-Za-z0-9]{8,30}$/.test(paymentId)) {
      sendJSON(res, 400, { success: false, error: 'A valid ticketId and a payment id starting with pay_ are required.' });
      return true;
    }
    const ticket = await db.getTicket(ticketId);
    if (!ticket) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found.` });
      return true;
    }
    const app = supportBotFor(res, ticket);
    if (!app) return true;

    const target = app.familyGroups().find((g) => g.id === str(body.groupId, 40));
    if (!target) {
      sendJSON(res, 400, { success: false, error: 'Choose which group the student paid for.' });
      return true;
    }
    const outcome = await app.grantForPayment({
      group: target, telegramId: ticket.telegram_id, paymentId, ticketId, admin: actor
    });
    await mirrorToSupportChat(app, ticket, `💻 From the dashboard:\n${outcome.html}`);
    sendJSON(res, 200, { success: true, data: { granted: outcome.granted, message: htmlToText(outcome.html) } });
    return true;
  }

  if (pathname === '/api/support/status' && method === 'POST') {
    const body = await readJsonBody(req);
    const ticketId = str(body.ticketId, 20);
    const status = str(body.status, 20).toLowerCase();
    if (!TICKET_ID_RE.test(ticketId) || !support.TICKET_STATUSES.includes(status)) {
      sendJSON(res, 400, {
        success: false,
        error: `ticketId and a status of ${support.TICKET_STATUSES.join(' / ')} are required.`
      });
      return true;
    }

    const updated = await db.setTicketStatus(ticketId, status, actor);
    if (!updated) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found in this group's sheet.` });
      return true;
    }

    let notified = false;
    if (status === 'closed' && body.notify !== false && paymentBotEnvs().includes(updated.bot)) {
      try {
        const app = paymentBotFor(updated.bot);
        await app.bot.sendMessage(updated.telegram_id,
          `${support.esc(support.replyLine(ticketId))}\n\n` +
          '✅ This ticket has been marked as resolved. If you still need help, reply to this message ' +
          'or send /support.',
          { parse_mode: 'HTML' });
        notified = true;
        await mirrorToSupportChat(app, updated, `✅ Closed from the dashboard by ${support.esc(actor)}`, { closed: true });
      } catch (err) {
        console.warn(`[support] could not tell ${updated.telegram_id} that ${ticketId} closed: ${err.message}`);
      }
    }

    sendJSON(res, 200, { success: true, data: updated, notified });
    return true;
  }

  if (pathname === '/api/support/settings' && method === 'GET') {
    const stored = await db.getBotSettings();
    sendJSON(res, 200, {
      success: true,
      data: {
        context,
        definitions: support.SETTINGS,
        settings: support.normaliseSettings(stored),
        categories: support.CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji })),
        statuses: support.TICKET_STATUSES.map((id) => ({
          id, label: support.STATUS_LABELS[id], meaning: support.STATUS_MEANINGS[id]
        })),
        quickReplies: support.QUICK_REPLIES.map((q) => ({
          id: q.id, key: q.key, button: q.button, closes: Boolean(q.closes), for: q.for
        }))
      }
    });
    return true;
  }

  if (pathname === '/api/support/settings' && method === 'POST') {
    const body = await readJsonBody(req);
    const checked = support.validateSettingsPatch(body.settings);
    if (!checked.ok) {
      sendJSON(res, 400, { success: false, error: checked.error });
      return true;
    }
    const stored = await db.updateBotSettings(checked.value, actor);
    refreshBotSettings(group.paymentBotEnv);
    sendJSON(res, 200, {
      success: true,
      data: { context, settings: support.normaliseSettings(stored) }
    });
    return true;
  }

  sendJSON(res, 404, { success: false, error: `Unknown API route: ${method} ${pathname}` });
  return true;
}

const TICKET_ID_RE = /^T-\d{6}-[A-Z0-9]{4}$/;

/** Telegram HTML as plain text, for the dashboard. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Where a coupon stands today, for the dashboard. */
function couponState(coupon, now = new Date()) {
  if (!coupon.active) return 'off';
  const end = coupon.expires_on ? pricing.endOfDayIst(coupon.expires_on) : null;
  if (coupon.expires_on && (!end || end.getTime() < now.getTime())) return 'expired';
  if (coupon.max_uses !== null && coupon.max_uses !== '' && coupon.max_uses !== undefined &&
      Number(coupon.times_used) >= Number(coupon.max_uses)) return 'used_up';
  return 'live';
}

/**
 * handlePricingRoute — the pass on sale and its coupon codes.
 *
 * Both are per payment bot and live in its first group's sheet, like the
 * support settings, so the two languages of a family can never disagree.
 *
 * @returns {Promise<boolean>} true when the route was handled
 */
async function handlePricingRoute(pathname, method, req, res, query, groupId, actor) {
  const { group, primary } = familyOf(groupId);
  const db = sheets.forGroup(primary.id);
  const context = {
    groupId: group.id,
    primaryGroupId: primary.id,
    primaryGroupName: primary.shortName,
    isPrimary: primary.id === group.id,
    payBotEnv: group.paymentBotEnv || ''
  };

  const describePass = (settings) => {
    const pass = pricing.currentPass(primary.id, support.normaliseSettings(settings));
    if (!pass) return null;
    return {
      name: pass.label,
      price: pass.amountPaise / 100,
      priceText: pricing.rupees(pass.amountPaise),
      validUntil: pass.validUntil,
      description: pass.description,
      defaults: (() => {
        const base = pricing.currentPass(primary.id, {});
        return { name: base.label, price: base.amountPaise / 100, validUntil: base.validUntil, description: base.description };
      })()
    };
  };

  if (pathname === '/api/pricing' && method === 'GET') {
    const [stored, coupons, redemptions] = await Promise.all([
      db.getBotSettings(),
      db.listCoupons(),
      db.listRedemptions({ limit: str(query.get('limit'), 3) || '50' })
    ]);
    const settings = support.normaliseSettings(stored);
    sendJSON(res, 200, {
      success: true,
      data: {
        context,
        pass: describePass(stored),
        passSettings: {
          name: settings.pass_name, price: settings.pass_price,
          validUntil: settings.pass_valid_until, description: settings.pass_description
        },
        coupons: coupons.map((c) => Object.assign({}, c, {
          state: couponState(c),
          discountText: pricing.describeDiscount(c)
        })),
        redemptions
      }
    });
    return true;
  }

  if (pathname === '/api/pricing/pass' && method === 'POST') {
    const body = await readJsonBody(req);
    const checked = pricing.validatePassInput(body);
    if (!checked.ok) {
      sendJSON(res, 400, { success: false, error: checked.error });
      return true;
    }
    const stored = await db.updateBotSettings(checked.value, actor);
    refreshBotSettings(group.paymentBotEnv);
    sendJSON(res, 200, { success: true, data: { context, pass: describePass(stored) } });
    return true;
  }

  if (pathname === '/api/pricing/coupon' && method === 'POST') {
    const body = await readJsonBody(req);
    const checked = pricing.validateCouponInput(body.coupon);
    if (!checked.ok) {
      sendJSON(res, 400, { success: false, error: checked.error });
      return true;
    }
    if (body.mode === 'create') {
      const existing = await db.getCoupon(checked.value.code);
      if (existing) {
        sendJSON(res, 409, { success: false, error: `${checked.value.code} already exists. Edit it instead.` });
        return true;
      }
    }
    const saved = await db.upsertCoupon(checked.value, actor);
    sendJSON(res, 200, {
      success: true,
      data: saved && Object.assign({}, saved, { state: couponState(saved), discountText: pricing.describeDiscount(saved) })
    });
    return true;
  }

  if (pathname === '/api/pricing/coupon/delete' && method === 'POST') {
    const body = await readJsonBody(req);
    const code = pricing.normaliseCode(body.code);
    if (!pricing.COUPON_CODE_PATTERN.test(code)) {
      sendJSON(res, 400, { success: false, error: 'A valid coupon code is required.' });
      return true;
    }
    const result = await db.deleteCoupon(code);
    if (!result.deleted) {
      sendJSON(res, result.reason === 'not found' ? 404 : 409, { success: false, error: result.reason });
      return true;
    }
    sendJSON(res, 200, { success: true, data: result });
    return true;
  }

  if (pathname === '/api/pricing/redemptions' && method === 'GET') {
    const code = pricing.normaliseCode(query.get('code'));
    const data = await db.listRedemptions({
      code: pricing.COUPON_CODE_PATTERN.test(code) ? code : '',
      limit: str(query.get('limit'), 3) || '100'
    });
    sendJSON(res, 200, { success: true, data });
    return true;
  }

  sendJSON(res, 404, { success: false, error: `Unknown API route: ${method} ${pathname}` });
  return true;
}

/**
 * supportBotFor — the bot a ticket's student talks to, or an error response.
 *
 * Replies must come from that same bot: a student who only ever started the
 * UPSC bot cannot be messaged by the newspaper bot at all.
 */
function supportBotFor(res, ticket) {
  if (!paymentBotEnvs().includes(ticket.bot)) {
    sendJSON(res, 409, {
      success: false,
      error: `This ticket came through ${ticket.bot || 'an unknown bot'}, which is not configured on this server.`
    });
    return null;
  }
  try {
    return paymentBotFor(ticket.bot);
  } catch (err) {
    sendJSON(res, 409, { success: false, error: err.message.split('\n')[0] });
    return null;
  }
}

/** Keeps the admin support chat in step with what happened on the dashboard. */
async function mirrorToSupportChat(app, ticket, html, { closed = false } = {}) {
  const chat = support.supportChatFor(ticket.bot);
  if (!chat) return;
  // The same buttons as a ticket raised in Telegram, so an admin can carry on
  // from the chat whichever side the last action came from.
  const options = {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: support.adminKeyboard(ticket.ticket_id, ticket.telegram_id, { closed })
  };
  if (chat.threadId) options.message_thread_id = chat.threadId;
  try {
    await app.bot.sendMessage(chat.chatId,
      `${support.ticketHeader(ticket.ticket_id, ticket.telegram_id)}\n${html}`, options);
  } catch (err) {
    console.warn(`[support] could not mirror ${ticket.ticket_id} to the support chat: ${err.message}`);
  }
}

/**
 * handleAuthedRoute — everything that reads or writes real data.
 * `user` is the verified Firebase identity; it is the only source of the
 * "Added By" / "Updated By" attribution, so a client cannot forge authorship.
 *
 * @returns {Promise<boolean>} true when the route was handled
 */
async function handleAuthedRoute(pathname, method, req, res, query, user) {

  // Which group this request is about. Required on every data route, and
  // deliberately not defaulted: a request that cannot say which group it means
  // must fail rather than quietly read or write whichever one came first.
  const groupId = String(query.get('group') || '').trim();

  // The two routes that are about the system rather than about one group.
  if (pathname === '/api/groups' && method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      data: groupRegistry.listGroups().map((g) => ({
        id: g.id,
        label: g.label,
        language: g.language,
        displayName: g.displayName,
        shortName: g.shortName,
        ready: g.ready,
        missing: g.missing,
        subjects: g.subjects || [],
        plans: groupRegistry.plansFor(g.id).map((plan) => ({
          id: plan.id, label: plan.label, emoji: plan.emoji,
          amountPaise: plan.amountPaise, type: plan.type
        }))
      }))
    });
    return true;
  }

  const NO_GROUP_NEEDED = ['/api/health'];

  let db = null;
  if (!NO_GROUP_NEEDED.includes(pathname)) {
    if (!groupId) {
      sendJSON(res, 400, {
        success: false,
        error: 'No group selected. Every request must name a group with ?group=<id>.'
      });
      return true;
    }
    try {
      db = sheets.forGroup(groupId);
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message.split('\n')[0] });
      return true;
    }
  }

  const actor = user.name ? `${user.name} (${user.email})` : user.email;

  // ---- System health -------------------------------------------------------
  if (pathname === '/api/health' && method === 'GET') {
    const health = {
      // serverless: on Vercel the process binds 0.0.0.0 because the container
      // requires it, and there is no LAN for that to expose it to.
      server: {
        ok: true, port: PORT, host: HOST, node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        serverless: Boolean(process.env.VERCEL)
      },
      auth: auth.describeConfig(),
      sheets: {
        configured: groupRegistry.listGroups().some((g) => g.ready), reachable: false, version: null,
        requiredVersion: REQUIRED_SHEET_VERSION,
        tokenRequired: null, current: false, bound: null, spreadsheetName: null,
        membershipReady: null, membershipError: null, error: null,
        // Which of the newest Apps Script actions this sheet has never heard of.
        missingActions: null, scriptCurrent: null
      },
      telegram: {
        configured: telegramConfigured(), reachable: false, botUsername: null,
        groupTitle: null, groupReachable: false, isForum: false, error: null
      },
      payments: {
        configured: razorpay.isConfigured(),
        testMode: razorpay.isTestMode(),
        webhookSecretSet: Boolean(String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim()),
        publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '') || null,
        // Auto-pay needs one Razorpay plan PER GROUP, because the amount is
        // baked into the plan and the groups need not charge the same. The old
        // single RAZORPAY_MONTHLY_PLAN_ID answered for none of them.
        recurringPlanReady: groupRegistry.listGroups().every((g) => g.autopayReady),
        // Per group, because "is the premium group set?" has five answers now.
        groups: groupRegistry.listGroups().map((g) => ({
          id: g.id,
          label: g.displayName,
          ready: g.ready,
          missing: g.missing,
          autopayReady: g.autopayReady,
          // Named so the Health page can print the exact variable to set,
          // rather than "auto-pay is not configured" with no next step.
          autopayMissing: g.autopayMissing,
          paymentBotEnv: g.paymentBotEnv,
          dedicatedPaymentBot: paybot.hasDedicatedBot(g.paymentBotEnv)
        })),
        premiumGroupSet: groupRegistry.listGroups().some((g) => g.ready),
        // Every ready group's payment bot must hold its own token. This used to
        // call hasDedicatedBot() with no argument, which reads
        // process.env[undefined] and is therefore always false — so the Health
        // page showed "One bot is doing both jobs" however the bots were set up,
        // and pointed at TELEGRAM_PAYMENT_BOT_TOKEN, the legacy single-bot
        // fallback, rather than the per-family tokens actually in use.
        dedicatedPaymentBot: (() => {
          const ready = groupRegistry.listGroups().filter((g) => g.ready);
          return ready.length > 0 && ready.every((g) => paybot.hasDedicatedBot(g.paymentBotEnv));
        })(),
        // Which groups are still falling back to another bot's token, so the
        // warning can name them instead of saying "one bot" for all five.
        sharedPaymentBotGroups: groupRegistry.listGroups()
          .filter((g) => g.ready && !paybot.hasDedicatedBot(g.paymentBotEnv))
          .map((g) => ({ label: g.displayName, env: g.paymentBotEnv })),
        cronSecretSet: Boolean(String(process.env.CRON_SECRET || '').trim())
      },
      you: { email: user.email, uid: user.uid, provider: user.signInProvider, emailVerified: user.emailVerified }
    };

    // Health is about the system, so with no group named it reports on the
    // first one that is actually usable rather than refusing to say anything.
    const healthGroup = groupId ||
      (groupRegistry.listGroups().find((g) => g.ready) || {}).id || '';

    if (healthGroup && sheets.isConfigured(healthGroup)) {
      try {
        const ping = await sheets.forGroup(healthGroup).ping();
        health.sheets.reachable = true;
        health.sheets.version = ping.version ||
          (String(ping.message || '').match(/v\d+[^)"]*/) || [null])[0];
        health.sheets.tokenRequired = Boolean(ping.tokenRequired);
        health.sheets.current = sheetVersionIsCurrent(health.sheets.version);
        health.sheets.bound = ping.boundToSpreadsheet !== false;
        health.sheets.spreadsheetName = ping.spreadsheetName || null;

        // The membership actions only exist in a script deployed after the
        // payments release. Probe one so the dashboard can say so plainly
        // rather than letting a webhook fail mysteriously at 2am.
        try {
          await sheets.forGroup(healthGroup).getRevenue();
          health.sheets.membershipReady = true;
        } catch (err) {
          health.sheets.membershipReady = false;
          health.sheets.membershipError = err.message;
        }

        // Apps Script is pasted into each sheet by hand — merging a PR or
        // deploying does not touch it. So the dashboard routinely runs ahead of
        // the script and a feature looks broken when a manual step is simply
        // outstanding. Probe the newest actions with arguments that cannot
        // match anything, and report which ones the script has never heard of.
        const NEWEST_ACTIONS = ['bulkDelete', 'claimQuestions', 'unpostQuestions', 'listPosted'];
        const missingActions = [];
        for (const action of NEWEST_ACTIONS) {
          try {
            const client = sheets.forGroup(healthGroup);
            if (action === 'bulkDelete') await client.bulkDelete('__probe__', ['__probe__']);
            else if (action === 'claimQuestions') await client.claimQuestions('__probe__', [999999]);
            else if (action === 'unpostQuestions') await client.unpostQuestions('__probe__', [999999]);
            else await client.listPosted('__probe__');
          } catch (err) {
            // Only a script that does not KNOW the action counts. "Sheet tab
            // __probe__ not found" means it knows it perfectly well.
            if (err.staleScript) missingActions.push(action);
          }
        }
        health.sheets.missingActions = missingActions;
        health.sheets.scriptCurrent = missingActions.length === 0;
      } catch (err) {
        health.sheets.error = err.message;
      }
    }

    if (telegramConfigured()) {
      try {
        ensureTelegram();
        const info = await telegram.getBotInfo();
        health.telegram.reachable = true;
        health.telegram.botUsername = info.username || null;
        health.telegram.groupTitle = info.groupTitle;
        health.telegram.isForum = info.isForum;
        health.telegram.groupReachable = info.groupReachable;
      } catch (err) {
        health.telegram.error = err.message;
      }
    }

    sendJSON(res, 200, { success: true, data: health });
    return true;
  }

  // ---- Subjects / config ---------------------------------------------------
  if (pathname === '/api/subjects' && method === 'GET') {
    sendJSON(res, 200, { success: true, data: await db.readConfig() });
    return true;
  }

  // ---- Analytics -----------------------------------------------------------
  if (pathname === '/api/analytics' && method === 'GET') {
    sendJSON(res, 200, { success: true, data: await db.getAnalytics() });
    return true;
  }

  if (pathname === '/api/stats' && method === 'GET') {
    sendJSON(res, 200, { success: true, data: await db.getStats() });
    return true;
  }

  // ---- Question browse -----------------------------------------------------
  if (pathname === '/api/questions' && method === 'GET') {
    const data = await db.listQuestions({
      subject: str(query.get('subject'), 60) || 'all',
      status: str(query.get('status'), 20),
      posted: str(query.get('posted'), 4),
      difficulty: str(query.get('difficulty'), 20),
      search: str(query.get('search'), 120),
      page: str(query.get('page'), 8) || '1',
      pageSize: str(query.get('pageSize'), 4) || '25'
    });
    sendJSON(res, 200, { success: true, data });
    return true;
  }

  // ---- Question upload -----------------------------------------------------
  // /api/send is the name the original dashboard used; both paths are accepted
  // so an older cached page keeps working.
  if ((pathname === '/api/questions' || pathname === '/api/send') && method === 'POST') {
    const body = await readJsonBody(req);

    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const batch = sanitiseQuestionBatch(body.questions);
    if (!batch.ok) { sendJSON(res, 400, { success: false, error: batch.error }); return true; }

    // Attribution comes from the verified token, never from the request body.
    const result = await db.addQuestions(subject.value, batch.value, actor, body.skipDuplicates !== false);
    sendJSON(res, 200, {
      success: true,
      addedCount: result.addedCount || 0,
      skippedCount: result.skippedCount || 0,
      skipped: result.skipped || [],
      ids: result.ids || [],
      message: result.message
    });
    return true;
  }

  // ---- Question edit -------------------------------------------------------
  if (pathname === '/api/questions/update' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const questionId = str(body.questionId, 60);
    const rowNumber = parseInt(body.rowNumber, 10) || '';
    if (!questionId && !rowNumber) {
      sendJSON(res, 400, { success: false, error: 'Missing questionId' });
      return true;
    }
    if (!body.fields || typeof body.fields !== 'object') {
      sendJSON(res, 400, { success: false, error: 'Missing fields object' });
      return true;
    }

    const result = await db.updateQuestion(
      subject.value, questionId, body.fields, actor, rowNumber, str(body.verifyText, LIMITS.question)
    );
    sendJSON(res, 200, { success: true, message: result.message });
    return true;
  }

  // ---- Question delete -----------------------------------------------------
  if (pathname === '/api/questions/delete' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const questionId = str(body.questionId, 60);
    const rowNumber = parseInt(body.rowNumber, 10) || '';
    if (!questionId && !rowNumber) {
      sendJSON(res, 400, { success: false, error: 'Missing questionId' });
      return true;
    }

    const result = await db.deleteQuestion(
      subject.value, questionId, rowNumber, str(body.verifyText, LIMITS.question)
    );
    sendJSON(res, 200, { success: true, message: result.message });
    return true;
  }

  // ---- Bulk status change --------------------------------------------------
  // ---- Bulk delete ---------------------------------------------------------
  // Deleting one row at a time through /api/questions/delete meant a confirm
  // dialog and a round trip per question, which made clearing a batch of 29
  // impractical. One call, one confirmation.
  if (pathname === '/api/questions/bulk-delete' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const ids = Array.isArray(body.questionIds)
      ? [...new Set(body.questionIds.map((id) => str(id, 60)).filter(Boolean))]
      : [];
    if (!ids.length) { sendJSON(res, 400, { success: false, error: 'No questionIds provided' }); return true; }
    // The same cap as a bulk status change. This one is irreversible, so the
    // limit is about how much a single mistaken click can destroy, not load.
    if (ids.length > 200) { sendJSON(res, 400, { success: false, error: 'Too many questionIds (max 200)' }); return true; }

    const result = await db.bulkDelete(subject.value, ids);
    console.log(`[questions] ${actor} deleted ${result.deletedCount} row(s) from "${subject.value}"`);
    sendJSON(res, 200, {
      success: true,
      deletedCount: result.deletedCount,
      // Named rather than counted, so a curator can see which ids survived
      // instead of being told a number that does not add up.
      notFound: result.notFound
    });
    return true;
  }

  if (pathname === '/api/questions/status' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const ids = Array.isArray(body.questionIds) ? body.questionIds.map((id) => str(id, 60)).filter(Boolean) : [];
    if (!ids.length) { sendJSON(res, 400, { success: false, error: 'No questionIds provided' }); return true; }
    if (ids.length > 200) { sendJSON(res, 400, { success: false, error: 'Too many questionIds (max 200)' }); return true; }

    const status = str(body.status, 20);
    if (!status) { sendJSON(res, 400, { success: false, error: 'Missing status' }); return true; }

    const updatedCount = await db.bulkStatus(subject.value, ids, status, actor);
    sendJSON(res, 200, { success: true, updatedCount });
    return true;
  }

  // ---- Schedule ------------------------------------------------------------
  if (pathname === '/api/questions/schedule' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const ids = Array.isArray(body.questionIds) ? body.questionIds.map((id) => str(id, 60)).filter(Boolean) : [];
    if (!ids.length) { sendJSON(res, 400, { success: false, error: 'No questionIds provided' }); return true; }

    const updatedCount = await db.scheduleQuestions(subject.value, ids, str(body.scheduledFor, 40), actor);
    sendJSON(res, 200, { success: true, updatedCount });
    return true;
  }

  // ---- Members -------------------------------------------------------------
  if (pathname === '/api/members' && method === 'GET') {
    const data = await db.listSubscribers({
      status: str(query.get('status'), 20),
      plan: str(query.get('plan'), 40),
      search: str(query.get('search'), 120),
      page: str(query.get('page'), 8) || '1',
      pageSize: str(query.get('pageSize'), 4) || '50'
    });
    sendJSON(res, 200, { success: true, data });
    return true;
  }

  if (pathname === '/api/members/revenue' && method === 'GET') {
    sendJSON(res, 200, { success: true, data: await db.getRevenue() });
    return true;
  }

  // Creates a checkout link on behalf of a student. The bot calls this, and so
  // can an admin issuing a link manually.
  if (pathname === '/api/payments/link' && method === 'POST') {
    const body = await readJsonBody(req);

    // Group-scoped, so the plan carries this group's price AND its group id.
    // plans.getPlan() returns the legacy global plan, which has no groupId:
    // razorpay then wrote an empty notes.group_id and the webhook dropped the
    // event as "notes lacked group_id" — the student paid and got nothing.
    const plan = groupRegistry.getPlanFor(groupId, str(body.planId, 40));
    if (!plan) {
      sendJSON(res, 400, {
        success: false,
        error: `"${str(body.planId, 40)}" is not a pass sold for this group.`
      });
      return true;
    }

    const telegramId = str(body.telegramId, 32);
    if (!/^\d+$/.test(telegramId)) {
      sendJSON(res, 400, { success: false, error: 'telegramId must be numeric' });
      return true;
    }

    const link = await createCheckoutForStudent({
      plan,
      telegramId,
      username: str(body.username, 60),
      name: str(body.name, 100)
    });
    sendJSON(res, 200, { success: true, data: link });
    return true;
  }

  // Runs the expiry sweep on demand, so an admin can see what the nightly job
  // will do (or fix a missed run) without waiting for cron.
  if (pathname === '/api/members/run-check' && method === 'POST') {
    const body = await readJsonBody(req);
    const summary = await membership.runDailyCheckAllGroups({ dryRun: body.dryRun !== false });
    sendJSON(res, 200, { success: true, data: summary });
    return true;
  }

  // ---- Support ---------------------------------------------------------------
  // Tickets live in the sheet of the first group a payment bot sells (see
  // primaryGroup in src/botapp.js). Every route reports which group that is, so
  // the page can say where to look instead of showing an empty list.
  if (pathname.startsWith('/api/support/')) {
    return handleSupportRoute(pathname, method, req, res, query, groupId, db, actor);
  }

  if (pathname === '/api/pricing' || pathname.startsWith('/api/pricing/')) {
    return handlePricingRoute(pathname, method, req, res, query, groupId, actor);
  }

  // ---- Telegram status -----------------------------------------------------
  if (pathname === '/api/telegram/status' && method === 'GET') {
    if (!telegramConfigured()) {
      sendJSON(res, 200, { success: true, data: { configured: false, connected: false } });
      return true;
    }
    try {
      ensureTelegram();
      const info = await telegram.getBotInfo();
      sendJSON(res, 200, {
        success: true,
        data: {
          configured: true,
          connected: true,
          botUsername: info.username,
          botName: info.firstName,
          groupTitle: info.groupTitle,
          groupReachable: info.groupReachable,
          isForum: info.isForum
        }
      });
    } catch (err) {
      sendJSON(res, 200, { success: true, data: { configured: true, connected: false, error: err.message } });
    }
    return true;
  }

  // ---- Post to Telegram now ------------------------------------------------
  // This is the endpoint that makes the automation dashboard able to publish
  // without dropping to the CLI. It is the most sensitive route in the app:
  // it writes to a public channel, so it is authenticated, rate limited, and
  // capped at a small batch per call.
  // ---- Reconcile the sheet against the channel -----------------------------
  // Telegram never tells a bot that a message was deleted, so a poll removed
  // from the channel left the sheet claiming it was posted for ever: the
  // question could never be re-sent and the counts were wrong. This walks the
  // posted rows, checks each poll is still there, and puts the deleted ones
  // back in the queue.
  if (pathname === '/api/telegram/reconcile' && method === 'POST') {
    const body = await readJsonBody(req);

    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    try {
      ensureTelegram();
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message });
      return true;
    }

    // Reporting only unless asked to write, so it can be run to look first.
    const apply = body.apply === true;
    const deadline = Date.now() + POST_BUDGET_MS;

    const posted = await db.listPosted(subject.value);
    const missing = [];
    const unknown = [];
    let checked = 0;

    for (const row of posted) {
      if (Date.now() > deadline) break;
      checked++;

      const exists = await telegram.pollStillExists(row.message_id);
      if (exists === false) missing.push(row);
      else if (exists === null) unknown.push(row.question_id);

      // Telegram rate-limits edits like anything else.
      await sleep(400);
    }

    let restored = 0;
    if (apply && missing.length) {
      restored = await db.unpostQuestions(subject.value, missing.map((m) => m.row), 'Approved');
      console.log(`[reconcile] ${actor} returned ${restored} deleted poll(s) to the queue in "${subject.value}"`);
    }

    sendJSON(res, 200, {
      success: true,
      applied: apply,
      checked,
      totalPosted: posted.length,
      missing: missing.map((m) => ({ questionId: m.question_id, row: m.row, messageId: m.message_id })),
      // Named, so "3 could not be checked" is actionable rather than ominous.
      unknown,
      restored,
      message: apply
        ? `${restored} deleted poll(s) put back in the queue for "${subject.value}".`
        : `${missing.length} of ${checked} checked poll(s) are no longer in the channel.` +
          (missing.length ? ' Run again with Apply to put them back in the queue.' : '')
    });
    return true;
  }

  if (pathname === '/api/telegram/post' && method === 'POST') {
    const body = await readJsonBody(req);

    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), MAX_POST_BATCH);
    const requireApproved = body.requireApproved !== false;
    const deadline = Date.now() + POST_BUDGET_MS;

    try {
      ensureTelegram();
    } catch (err) {
      sendJSON(res, 400, { success: false, error: err.message });
      return true;
    }

    // Resolve the forum topic for this subject from the Config tab.
    const config = await db.readConfig();
    const subjectConfig = config.find((c) => c.subject === subject.value);
    if (!subjectConfig) {
      sendJSON(res, 400, { success: false, error: `"${subject.value}" is not in the Config tab` });
      return true;
    }
    if (!subjectConfig.topic_thread_id) {
      sendJSON(res, 400, { success: false, error: `No Telegram topic thread configured for "${subject.value}". Run: node setup.js` });
      return true;
    }

    const lockKey = `${groupId}::${subject.value}`;
    if (postsInFlight.has(lockKey)) {
      sendJSON(res, 409, {
        success: false,
        error: `A posting batch for "${subject.value}" is already running. Wait for it to finish — starting a second one would post the same questions twice.`
      });
      return true;
    }
    postsInFlight.add(lockKey);
    try {
      const questions = await db.getUnpostedQuestions(subject.value, count, requireApproved);
      if (!questions.length) {
        sendJSON(res, 200, {
          success: true,
          postedCount: 0,
          requestedCount: count,
          results: [],
          message: requireApproved
            ? `No Approved or Scheduled questions waiting in "${subject.value}"`
            : `No unposted questions left in "${subject.value}"`
        });
        return true;
      }

      // ---- Claim before sending ------------------------------------------
      // A poll can reach Telegram and still leave this process with a timeout
      // or a dropped connection. Marking only after a confirmed send therefore
      // left delivered questions looking unposted, and they went out again on
      // every subsequent run — two of them were stuck in that loop. Claiming
      // first means the worst case is a question that needs a human to resolve,
      // never one that is posted twice.
      const rowsWanted = questions.map((q) => sheets.sheetRowOf(q));
      const claim = await db.claimQuestions(subject.value, rowsWanted);
      const claimedRows = new Set(claim.claimed);

      const results = [];
      const postedRowIndices = [];
      const strandedRows = [];

      // Anything another run took first is reported, not silently dropped.
      for (const skip of claim.skipped || []) {
        const q = questions.find((item) => sheets.sheetRowOf(item) === Number(skip.row));
        results.push({
          questionId: q ? q.question_id : `row ${skip.row}`,
          ok: false,
          error: `Skipped — ${skip.reason}.`,
          preview: q ? q.question_text.slice(0, 80) : ''
        });
      }

      const toSend = questions.filter((q) => claimedRows.has(sheets.sheetRowOf(q)));

      for (let i = 0; i < toSend.length; i++) {
        const q = toSend[i];
        const sheetRow = sheets.sheetRowOf(q);

        // Stop cleanly while there is still time to record what has been sent,
        // and hand back what was never attempted.
        if (Date.now() > deadline) {
          const untouched = toSend.slice(i).map((rest) => sheets.sheetRowOf(rest));
          try {
            await db.releaseQuestions(subject.value, untouched, q.status);
          } catch (releaseErr) {
            console.error('[post] could not release unsent rows:', releaseErr.message);
          }
          toSend.slice(i).forEach((rest) => results.push({
            questionId: rest.question_id,
            ok: false,
            error: 'Stopped before the request timed out — run again to post the rest.',
            preview: rest.question_text.slice(0, 80)
          }));
          break;
        }

        try {
          const sent = await telegram.sendQuizPoll(subjectConfig.topic_thread_id, q);

          const messageId = sent && sent.message_id ? sent.message_id : null;
          const pollIds = sent && sent.poll && sent.poll.id
            ? { [String(sheetRow)]: sent.poll.id }
            : null;

          try {
            await db.markAsPosted(
              subject.value, [sheetRow], messageId, subjectConfig.topic_thread_id, pollIds
            );
            postedRowIndices.push(sheetRow);
            results.push({ questionId: q.question_id, ok: true, preview: q.question_text.slice(0, 80) });
          } catch (markErr) {
            // The poll is public and the row is still claimed, so it cannot go
            // out again. It needs a person, and says so.
            console.error(`[post] row ${sheetRow} posted but not marked:`, markErr.message);
            strandedRows.push(sheetRow);
            results.push({
              questionId: q.question_id,
              ok: false,
              error: `Posted to Telegram, but the sheet did not record it (${markErr.message}). ` +
                     `Row ${sheetRow} is held as "Sending" so it cannot be posted twice — mark it Posted by hand.`,
              preview: q.question_text.slice(0, 80)
            });
          }
        } catch (err) {
          // Did Telegram refuse it, or did the answer go missing? Only a refusal
          // proves nothing was delivered, and only then is it safe to hand the
          // row back. Anything else keeps the claim.
          if (telegram.wasRejectedBeforeDelivery(err)) {
            try {
              await db.releaseQuestions(subject.value, [sheetRow], q.status);
            } catch (releaseErr) {
              console.error(`[post] could not release row ${sheetRow}:`, releaseErr.message);
            }
            results.push({
              questionId: q.question_id, ok: false,
              error: `Telegram refused it: ${err.message}`,
              preview: q.question_text.slice(0, 80)
            });
          } else {
            strandedRows.push(sheetRow);
            results.push({
              questionId: q.question_id, ok: false,
              error: `No answer from Telegram (${err.message}). It may or may not have gone out, ` +
                     `so row ${sheetRow} is held as "Sending" rather than risking a duplicate. Check the channel.`,
              preview: q.question_text.slice(0, 80)
            });
          }
        }

        // Telegram allows roughly 20 messages a minute into one group and each
        // question costs two or three, so pace the batch. A 429 is still handled
        // inside src/telegram.js, this just makes hitting one much less likely.
        if (i < toSend.length - 1) await sleep(telegram.POST_SPACING_MS);
      }

      const postedCount = postedRowIndices.length;
      const remaining = questions.length - postedCount;

      // "2 of 2 posted" after asking for 5 reads like a failure and explains
      // nothing. When fewer were eligible than were asked for, say so and say
      // what the rest are, so the answer is not "the poster is broken".
      let message = `${postedCount} of ${questions.length} question(s) posted to "${subject.value}"`;
      if (questions.length < count) {
        const shortfall = await describeShortfall(db, subject.value, count, questions.length, requireApproved);
        message += ` — you asked for ${count}, and ${questions.length} ${questions.length === 1 ? 'was' : 'were'} ready. ${shortfall}`;
      } else if (remaining) {
        message += ` — run again to send the remaining ${remaining}`;
      }
      if (strandedRows.length) {
        message += ` ⚠️ ${strandedRows.length} row(s) are held as "Sending" and need checking.`;
      }

      sendJSON(res, 200, {
        success: true,
        postedCount,
        requestedCount: count,
        eligibleCount: questions.length,
        strandedRows,
        failedCount: questions.length - postedCount,
        results,
        message
      });
      return true;

    } finally {
      postsInFlight.delete(lockKey);
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);

  const clientIp = req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    res.setHeader('Retry-After', '60');
    sendJSON(res, 429, { success: false, error: 'Too many requests — slow down.' });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    sendText(res, 400, '400 Bad Request');
    return;
  }

  const pathname = parsedUrl.pathname;
  const method = req.method;

  // No CORS preflight is answered: the API is same-origin only. A cross-origin
  // page that tries to send an Authorization header gets stopped right here.
  if (method === 'OPTIONS') {
    sendText(res, 405, '405 Method Not Allowed');
    return;
  }

  if (!pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, '405 Method Not Allowed');
      return;
    }

    // Firebase authorises sign-in per DOMAIN, and it treats "localhost" and
    // "127.0.0.1" as different domains. Only "localhost" is on the default
    // authorised list, so loading the dashboard at http://127.0.0.1:3000 makes
    // Google sign-in fail — often as an opaque 500 from accounts.google.com.
    // Same machine, same port, so redirecting is free and removes the trap.
    const redirect = canonicalRedirect(parsedUrl);
    if (redirect) {
      res.statusCode = 302;
      res.setHeader('Location', redirect);
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }

    await serveStatic(res, pathname);
    return;
  }

  try {
    if (await handlePublicRoute(pathname, method, req, res)) return;

    // Everything past this point requires a verified Firebase identity.
    if (!auth.isConfigured()) {
      sendJSON(res, 503, {
        success: false,
        error: 'Server auth is not configured. Set FIREBASE_PROJECT_ID in .env and restart.'
      });
      return;
    }

    const token = auth.extractBearerToken(req);
    if (!token) {
      sendJSON(res, 401, { success: false, error: 'Sign in required.' });
      return;
    }

    let user;
    try {
      user = await auth.authorize(token);
    } catch (err) {
      sendJSON(res, 403, { success: false, error: err.message });
      return;
    }

    if (await handleAuthedRoute(pathname, method, req, res, parsedUrl.searchParams, user)) return;

    sendJSON(res, 404, { success: false, error: `Unknown API route: ${method} ${pathname}` });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    // Log the full error locally; return only the message to the client.
    console.error(`[api] ${method} ${pathname} failed:`, err.message);
    sendJSON(res, statusCode, { success: false, error: err.message });
  }
});

// Cap header size and idle sockets so a slow client cannot hold resources.
server.headersTimeout = 20000;
// A posting batch paces itself against Telegram's per-group rate limit, so one
// request legitimately runs for minutes. Match POST_BUDGET_MS with headroom,
// and keep it in step with `maxDuration` in vercel.json.
server.requestTimeout = POST_BUDGET_MS + 60000;
server.keepAliveTimeout = 10000;

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const warnings = [];
    if (!auth.isConfigured()) warnings.push('FIREBASE_PROJECT_ID not set — API is locked (503) until you set it');
    if (!sheets.isConfigured()) warnings.push('GOOGLE_SHEET_WEBAPP_URL not set — sheet features disabled');
    if (!process.env.SHEET_API_TOKEN) warnings.push('SHEET_API_TOKEN not set — your Apps Script Web App is world-writable');
    if (!auth.getCuratorAllowlist().length) warnings.push('CURATOR_EMAILS not set — any verified Firebase user can curate');
    if (HOST === '0.0.0.0') warnings.push('HOST=0.0.0.0 — this dashboard is reachable from your whole network');

    // Always print the localhost form: it is the origin Firebase authorises.
    const displayHost = (HOST === '127.0.0.1' || HOST === '::1') ? 'localhost' : HOST;

    console.log('════════════════════════════════════════════════════════');
    console.log(`🚀 Sadhana APPSC Dashboard   http://${displayHost}:${PORT}`);
    console.log('────────────────────────────────────────────────────────');
    console.log('   📤 Upload      /index.html');
    console.log('   📊 Analytics   /analytics.html');
    console.log('   📚 Questions   /questions.html');
    console.log('   🤖 Automation  /automation.html');
    console.log('   🩺 Health      /health.html');
    console.log('────────────────────────────────────────────────────────');
    console.log(`   Google Sheets: ${sheets.isConfigured() ? 'configured ✅' : 'not configured ⚠️'}`);
    console.log(`   Telegram bot : ${telegramConfigured() ? 'configured ✅' : 'not configured ⚠️'}`);
    console.log(`   Firebase auth: ${auth.isConfigured() ? 'enforced ✅' : 'NOT ENFORCED ❌'}`);
    if (warnings.length) {
      console.log('────────────────────────────────────────────────────────');
      warnings.forEach((w) => console.log('   ⚠️  ' + w));
    }
    console.log('════════════════════════════════════════════════════════');
  });
}

module.exports = server;
module.exports.createCheckoutForStudent = createCheckoutForStudent;
module.exports.handlePaymentEvent = handlePaymentEvent;
