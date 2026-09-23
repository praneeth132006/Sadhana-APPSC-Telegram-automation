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
const affiliates = require('./src/affiliates');
const affiliateStore = require('./src/affiliate-store');
const codeTracking = require('./src/code-tracking');
const affiliateNotify = require('./src/affiliate-notify');
const affiliateBotFactory = require('./src/affiliatebot');
const sheetTabs = require('./src/sheet-tabs');
const botCommands = require('./src/bot-commands');
const autopilotFactory = require('./src/autopilot');

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

/**
 * How long a claim may sit before a posting run treats it as abandoned.
 *
 * A run cannot last longer than POST_BUDGET_MS, so anything older than this
 * belongs to a run that died — a serverless timeout, a closed laptop — and its
 * unsent questions are waiting to be posted by someone. Comfortably above the
 * budget so a slow run in progress is never robbed of its own rows.
 */
const STALE_CLAIM_MINUTES = Math.max(10, Math.ceil((POST_BUDGET_MS / 60000) * 2));

/** Most questions one request will post. Anything larger is better split
 *  across runs than raced against the function timeout. */
const MAX_POST_BATCH = 20;

/** Wall-clock budget for one autopilot batch. Shorter than a manual run's:
 *  nobody is watching, and a run that overruns its own interval is worse than
 *  one that stops early and sends the rest next time. */
const AUTOPILOT_RUN_BUDGET_MS = Number(process.env.AUTOPILOT_RUN_BUDGET_MS) || 120000;

/** Posted rows the autopilot's deleted-poll check looks at in one pass, and
 *  how long it may spend. Each row is a Telegram call plus a rate-limit pause,
 *  so a whole channel cannot be swept at once — the cursor in
 *  reconcileChannel carries the rest to the following passes. */
const AUTOPILOT_RECONCILE_LIMIT = Number(process.env.AUTOPILOT_RECONCILE_LIMIT) || 40;
const AUTOPILOT_RECONCILE_BUDGET_MS = Number(process.env.AUTOPILOT_RECONCILE_BUDGET_MS) || 60000;

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

/** Rate limit: requests allowed per IP inside the window.
 *  Configurable because a curation team behind one office NAT shares an
 *  address, and the whole team then shares one bucket. Read per request rather
 *  than captured at load, so a test can lower it around the few cases that are
 *  about the limiter and leave the rest of the suite unthrottled. */
const rateLimitMax = () => Number(process.env.RATE_LIMIT_MAX) || 240;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;

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

/**
 * clientAddress — who a request is from, for rate limiting.
 *
 * On Vercel every request reaches the function from the platform's own proxy,
 * so the socket address is the same for everyone and one busy minute would
 * lock every visitor out together. Vercel sets x-real-ip / x-forwarded-for
 * itself and overwrites what a client sends, so they are trusted there — and
 * only there: anywhere else a client could invent them.
 */
function clientAddress(req) {
  if (process.env.VERCEL) {
    const real = String(req.headers['x-real-ip'] || '').trim();
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (real || forwarded) return real || forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

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
  return bucket.count <= rateLimitMax();
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
    // The pass name is admin-edited; unescaped, one "<" in it makes Telegram
    // reject this message and the student who just paid never gets the link.
    (plan ? plan.emoji + ' <b>' + support.esc(plan.label) + '</b>\n' : '') +
    (expiry ? 'Access until <b>' + support.esc(expiry) + '</b>\n\n' : '\n') +
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

/**
 * recordCodePaid — marks the student paid on the Code Tracking tab. Never
 * fails the webhook (safeRecord swallows and logs): the student has paid.
 */
async function recordCodePaid(notes, paymentId, paidPaise) {
  let group;
  try {
    group = groupRegistry.requireGroup(notes.group_id);
  } catch (err) {
    return;
  }
  await codeTracking.safeRecord(group.paymentBotEnv, {
    type: 'paid',
    code: notes.promo_code || notes.coupon_code,
    kind: notes.promo_code ? 'promo' : 'coupon',
    student: { id: notes.telegram_id, username: notes.telegram_username || '', name: notes.student_name || '' },
    group: group.shortName,
    paymentId,
    paidPaise
  });
}

/**
 * sweepTrials — warns the previews that are nearly over and ends the ones
 * that are, in every group.
 *
 * Both messages carry a real payment link, because the moment someone has
 * just read the group is the moment they will pay. A link that cannot be
 * created is not fatal: the message still goes, with a button that opens the
 * pass instead.
 *
 * Nothing here trusts the clock to have run on time — a preview found an hour
 * late is simply ended then.
 */
async function sweepTrials({ now = new Date() } = {}) {
  const result = { checked: 0, warned: [], ended: [], failed: [] };

  for (const group of groupRegistry.listGroups()) {
    if (!group.ready) continue;
    let trials = [];
    try {
      trials = await sheets.forGroup(group.id).listTrialMembers();
    } catch (err) {
      result.failed.push({ group: group.id, error: err.message });
      continue;
    }
    if (!trials.length) continue;
    result.checked += trials.length;

    for (const member of trials) {
      const expiry = membership.parseIst(member.expiry_date);
      try {
        // Unreadable dates would otherwise keep someone in for ever.
        if (!expiry) {
          await membership.endTrial(group.id, member);
          result.ended.push({ group: group.id, telegram_id: member.telegram_id, reason: 'unreadable expiry' });
          continue;
        }

        if (now.getTime() >= expiry.getTime()) {
          await membership.endTrial(group.id, member);
          result.ended.push({ group: group.id, telegram_id: member.telegram_id });
          const offer = await payNowMessage(group, member);
          await tellStudent(group, member.telegram_id,
            `⌛ <b>Your free preview of ${support.esc(group.shortName)} has ended</b> and you have been removed from the group.\n\n` +
            'Everything you saw is posted every day — join to keep getting it.',
            offer);
          continue;
        }

        // Previews are no longer offered; any still open is warned two minutes before it ends.
        const warnAt = expiry.getTime() - 2 * 60 * 1000;
        if (member.reminder_sent !== 'warned' && now.getTime() >= warnAt) {
          await membership.markTrialWarned(group.id, member);
          result.warned.push({ group: group.id, telegram_id: member.telegram_id });
          const minutesLeft = Math.max(1, Math.round((expiry.getTime() - now.getTime()) / 60000));
          const offer = await payNowMessage(group, member);
          await tellStudent(group, member.telegram_id,
            `⏳ <b>${minutesLeft} minute(s) left of your free preview.</b>\n\n` +
            `You will be removed from ${support.esc(group.shortName)} automatically when it ends. ` +
            'Join now and you keep your place — no interruption.',
            offer);
        }
      } catch (err) {
        result.failed.push({ group: group.id, telegram_id: member.telegram_id, error: err.message });
      }
    }
  }
  return result;
}

/** A Pay button for a preview message: a real link when we can mint one. */
async function payNowMessage(group, member) {
  try {
    const settings = await sheets.forGroup(group.id).getBotSettings().catch(() => ({}));
    const pass = pricing.currentPass(group.id, settings);
    if (!pass) return null;
    const checkout = await createCheckoutForStudent({
      plan: pass, telegramId: member.telegram_id, username: member.username, name: member.name
    });
    return {
      inline_keyboard: [[{ text: `💳 Join now — ${pricing.rupees(pass.amountPaise)}`, url: checkout.url }]]
    };
  } catch (err) {
    console.error(`[cron] could not make a payment link for ${member.telegram_id}: ${err.message}`);
    return { inline_keyboard: [[{ text: '💳 See the pass', callback_data: 'go:plans' }]] };
  }
}

/** Messages a student from their group's payment bot. Never fatal. */
async function tellStudent(group, telegramId, html, replyMarkup) {
  try {
    await paybot.sendDirectMessage(group.paymentBotEnv, telegramId, html,
      replyMarkup ? { reply_markup: replyMarkup } : undefined);
    return true;
  } catch (err) {
    console.error(`[cron] could not message ${telegramId}: ${err.message}`);
    return false;
  }
}

/**
 * couponExists — true when any payment bot's sheet already has this coupon
 * code, so an influencer's code can never shadow one (or be shadowed by it).
 */
async function couponExists(code) {
  const primaries = new Map();
  for (const group of groupRegistry.listGroups()) {
    if (group.ready && !primaries.has(group.paymentBotEnv)) primaries.set(group.paymentBotEnv, group);
  }
  const found = await Promise.all([...primaries.values()].map((group) =>
    sheets.forGroup(group.id).getCoupon(code, '').then(Boolean).catch((err) => {
      console.error(`[affiliates] could not check coupons in ${group.id}: ${err.message}`);
      return false;
    })));
  return found.some(Boolean);
}

/** The pass an exam sells now, with the price its bot quotes. */
async function examPass(exam) {
  const group = exam.groups[0];
  let settings = {};
  try {
    settings = await Promise.race([
      sheets.forGroup(group.id).getBotSettings(),
      new Promise((resolve) => setTimeout(() => resolve({}), 8000))
    ]) || {};
  } catch (err) {
    settings = {};
  }
  return pricing.currentPass(group.id, settings);
}

/**
 * handleAffiliateRoute — the Influencers dashboard's API.
 *
 *   GET  /api/affiliates          everything: requests, codes, sales, payouts
 *   POST /api/affiliates/setup    create the sheet's tabs
 *   POST /api/affiliates/approve  { requestId, terms } — creates the code
 *   POST /api/affiliates/reject   { requestId, reason }
 *   POST /api/affiliates/code     { code, status } pause/resume, or { code, terms }
 *   POST /api/affiliates/payout   { payoutId, decision: paid|rejected, reference, reason }
 *
 * Nothing here moves money. Marking a withdrawal paid records that a person
 * sent it, with the UPI reference to prove it.
 */
async function handleAffiliateRoute(pathname, method, req, res, user) {
  const actor = user.name ? `${user.name} (${user.email})` : user.email;

  const status = {
    sheet: affiliateStore.isConfigured(),
    bot: affiliateNotify.isConfigured(),
    adminChat: Boolean(affiliateNotify.adminChat()),
    serviceAccount: require('./src/sheets-direct').serviceAccountEmail(),
    sheetUrl: affiliateStore.spreadsheetId()
      ? `https://docs.google.com/spreadsheets/d/${affiliateStore.spreadsheetId()}/edit` : ''
  };
  let botUsername = null;
  if (status.bot) {
    try {
      botUsername = (await affiliateNotify.bot().getMe()).username || null;
    } catch (err) {
      botUsername = null;
    }
  }

  if (!status.sheet) {
    if (method === 'GET' && pathname === '/api/affiliates') {
      sendJSON(res, 200, { success: true, data: { status, botUsername, notReady: true } });
    } else {
      sendJSON(res, 503, {
        success: false,
        error: 'The influencer sheet is not set up: set AFFILIATE_SHEET_ID and share the sheet with ' +
          `${status.serviceAccount || 'the service account'} as an Editor.`
      });
    }
    return true;
  }

  if (pathname === '/api/affiliates' && method === 'GET') {
    const { influencers, requests, codes, sales, payouts, opens } = await affiliateStore.overview();
    const exams = affiliates.listExams();
    const passes = await Promise.all(exams.map((exam) => examPass(exam).catch(() => null)));
    const upiOf = new Map(influencers.map((i) => [i.telegram_id, i.upi_id]));

    const codeRows = codes.map((code) => {
      const mine = sales.filter((sale) => String(sale.code).toUpperCase() === String(code.code).toUpperCase());
      const opened = opens.filter((o) => String(o.code).toUpperCase() === String(code.code).toUpperCase());
      const paidIds = new Set(mine.filter((sale) => sale.status !== 'cancelled').map((sale) => sale.student_id));
      return Object.assign({}, code, {
        stats: Object.assign(affiliates.summarise(mine), {
          opens: opened.length,
          // Opened the link and paid — from either side, so a student who
          // typed the code without opening the link still counts as joined.
          openedAndPaid: opened.filter((o) => paidIds.has(o.student_id)).length
        }),
        upi_id: upiOf.get(code.telegram_id) || '',
        // Who looked and has not paid: the people an influencer's audience
        // is losing between the link and the checkout.
        notYetPaid: opened.filter((o) => !paidIds.has(o.student_id)).reverse()
      });
    });
    const totals = affiliates.summarise(sales);

    sendJSON(res, 200, {
      success: true,
      data: {
        status,
        botUsername,
        exams: exams.map((exam, i) => ({
          id: exam.id, label: exam.label, botEnv: exam.botEnv,
          pricePaise: passes[i] ? passes[i].amountPaise : null
        })),
        // One row per person, with their payout details and totals across
        // every code they hold.
        influencers: influencers.map((person) => {
          const theirCodes = codes.filter((c) => c.telegram_id === person.telegram_id);
          const theirSales = sales.filter((sale) => theirCodes.some((c) =>
            String(c.code).toUpperCase() === String(sale.code).toUpperCase()));
          return Object.assign({}, person, {
            payout: affiliates.payoutDetails(person),
            codes: theirCodes.map((c) => ({ code: c.code, exam: c.exam, status: c.status })),
            stats: affiliates.summarise(theirSales),
            pendingApplications: requests.filter((r) => r.telegram_id === person.telegram_id && r.status === 'pending').length
          });
        }),
        opens: opens.slice().reverse(),
        // Newest first: the question is almost always "what just came in".
        requests: requests.slice().reverse().map((r) => Object.assign({}, r, {
          suggested_code: r.status === 'pending' ? affiliates.suggestCode(r, r.exam) : ''
        })),
        codes: codeRows,
        sales: sales.slice().reverse(),
        payouts: payouts.slice().reverse(),
        totals: Object.assign(totals, {
          influencers: influencers.length,
          pendingRequests: requests.filter((r) => r.status === 'pending').length,
          activeCodes: codes.filter((c) => c.status === 'active').length,
          openPayouts: payouts.filter((p) => p.status === 'requested').length
        })
      }
    });
    return true;
  }

  if (method !== 'POST') {
    sendJSON(res, 404, { success: false, error: 'Not found' });
    return true;
  }
  const body = await readJsonBody(req);

  if (pathname === '/api/affiliates/setup') {
    const tabs = await affiliateStore.ensureTabs();
    sendJSON(res, 200, { success: true, message: `The influencer sheet has its tabs: ${tabs.join(', ')}.` });
    return true;
  }

  if (pathname === '/api/affiliates/approve') {
    const requestId = str(body.requestId, 40);
    const request = (await affiliateStore.listRequests()).find((r) => r.request_id === requestId);
    if (!request) {
      sendJSON(res, 404, { success: false, error: `No request ${requestId}.` });
      return true;
    }
    const exam = affiliates.getExam(request.exam);
    if (!exam) {
      sendJSON(res, 400, { success: false, error: `The exam "${request.exam}" is not on sale any more.` });
      return true;
    }
    const pass = await examPass(exam).catch(() => null);
    const terms = affiliates.validateTerms(body.terms, { pricePaise: pass ? pass.amountPaise : null });
    if (!terms.ok) {
      sendJSON(res, 400, { success: false, error: terms.error });
      return true;
    }
    let examBotUsername = '';
    try {
      examBotUsername = await paymentBotUsername(exam.botEnv) || '';
    } catch (err) {
      // The code still works when typed; only the link needs the name.
    }
    const result = await affiliateStore.approveRequest(requestId, terms.value, actor,
      { codeTaken: couponExists, botUsername: examBotUsername });
    if (!result.ok) {
      sendJSON(res, 409, { success: false, error: result.error });
      return true;
    }
    const notified = await affiliateNotify.tellInfluencer(result.code.telegram_id, affiliateNotify.approvedMessage(result.code));
    console.log(`[affiliates] ${actor} approved ${requestId} as ${result.code.code}`);
    sendJSON(res, 200, {
      success: true,
      code: result.code,
      notified,
      message: `Approved. Code ${result.code.code} is live in the ${exam.label} bot` +
        (notified ? ' and the influencer has been sent it.' : ' — but the influencer could not be messaged; send them the code yourself.')
    });
    return true;
  }

  if (pathname === '/api/affiliates/reject') {
    const reason = str(body.reason, 500);
    const result = await affiliateStore.rejectRequest(str(body.requestId, 40), reason, actor);
    if (!result.ok) {
      sendJSON(res, 409, { success: false, error: result.error });
      return true;
    }
    const notified = await affiliateNotify.tellInfluencer(result.request.telegram_id, affiliateNotify.rejectedMessage(result.request));
    sendJSON(res, 200, { success: true, notified, message: 'Rejected' + (notified ? ' and the influencer was told.' : '.') });
    return true;
  }

  if (pathname === '/api/affiliates/code') {
    const code = affiliates.normaliseCode(str(body.code, 24));
    if (body.terms) {
      const existing = await affiliateStore.getCode(code);
      const exam = existing && affiliates.getExam(existing.exam);
      const pass = exam ? await examPass(exam).catch(() => null) : null;
      const terms = affiliates.validateTerms(body.terms, { pricePaise: pass ? pass.amountPaise : null });
      if (!terms.ok) {
        sendJSON(res, 400, { success: false, error: terms.error });
        return true;
      }
      const result = await affiliateStore.updateCodeTerms(code, terms.value, actor);
      if (!result.ok) {
        sendJSON(res, 404, { success: false, error: result.error });
        return true;
      }
      await affiliateNotify.tellInfluencer(result.code.telegram_id,
        `ℹ️ <b>The terms of your code ${support.esc(code)} have changed.</b>\n\n` +
        affiliateNotify.termsLines(result.code).join('\n') +
        '\n\n<i>Sales already made keep what they earned.</i>');
      sendJSON(res, 200, { success: true, code: result.code, message: `${code}'s terms updated.` });
      return true;
    }
    const wanted = str(body.status, 12) === 'paused' ? 'paused' : 'active';
    const result = await affiliateStore.setCodeStatus(code, wanted, actor);
    if (!result.ok) {
      sendJSON(res, 404, { success: false, error: result.error });
      return true;
    }
    const notified = await affiliateNotify.tellInfluencer(result.code.telegram_id, affiliateNotify.codeStatusMessage(result.code));
    sendJSON(res, 200, { success: true, code: result.code,
      message: `${code} is ${wanted}` + (notified ? ' and the influencer was told.' : '.') });
    return true;
  }

  if (pathname === '/api/affiliates/payout') {
    const decision = str(body.decision, 12) === 'paid' ? 'paid' : 'rejected';
    const result = await affiliateStore.decidePayout(str(body.payoutId, 40), decision, {
      reference: str(body.reference, 100), reason: str(body.reason, 500), actor
    });
    if (!result.ok) {
      sendJSON(res, 409, { success: false, error: result.error });
      return true;
    }
    const notified = await affiliateNotify.tellInfluencer(result.payout.influencer_id, decision === 'paid'
      ? affiliateNotify.payoutPaidMessage(result.payout)
      : affiliateNotify.payoutRejectedMessage(result.payout));
    sendJSON(res, 200, {
      success: true,
      payout: result.payout,
      message: (decision === 'paid' ? 'Marked paid' : 'Rejected') + (notified ? ' and the influencer was told.' : '.')
    });
    return true;
  }

  sendJSON(res, 404, { success: false, error: 'Not found' });
  return true;
}

/**
 * recordAffiliateSale — credits an influencer once a payment made with their
 * promo code succeeds, and tells them.
 *
 * Never fails the webhook: the student has paid and must get access whether
 * or not the commission can be written. The store ignores a payment id it has
 * already recorded, so a redelivered webhook credits nothing twice — which
 * matters more here than anywhere else in this file, because the other end of
 * it is money leaving the business.
 *
 * What is owed was worked out when the link was created and rides in its
 * notes, so an admin changing the code's terms while the link was open cannot
 * change what the influencer earns for a sale that already happened.
 */
async function recordAffiliateSale(notes, paymentId, paidPaise) {
  try {
    const group = groupRegistry.requireGroup(notes.group_id);
    const paid = Number(paidPaise) || 0;
    let commissionPaise = Math.round((Number(notes.commission_amount) || 0) * 100);
    if (!(notes.commission_amount !== undefined && notes.commission_amount !== '')) {
      const code = await affiliateStore.getCode(notes.promo_code);
      commissionPaise = code ? affiliates.commissionFor(code, paid) : 0;
    }
    const result = await affiliateStore.recordSale({
      code: notes.promo_code,
      influencer_id: notes.affiliate_id || '',
      group: group.shortName,
      student_id: notes.telegram_id,
      student_username: notes.telegram_username || '',
      student_name: notes.student_name || '',
      payment_id: paymentId,
      list_price_paise: Math.round((Number(notes.original_amount) || 0) * 100),
      discount_paise: Math.round((Number(notes.discount_amount) || 0) * 100),
      paid_paise: paid,
      commission_paise: Math.min(commissionPaise, paid)
    });
    if (!result.recorded) return;
    console.log(`[payments] promo ${result.sale.code}: credited ₹${result.sale.commission_paise / 100} to ` +
      `${result.sale.influencer_id} for ${notes.telegram_id}'s payment ${paymentId}`);

    // Telling the influencer is the whole reward loop. Best effort: a failed
    // message must not undo a credit that is already in the sheet.
    let stats = null;
    try {
      const sales = (await affiliateStore.listSales())
        .filter((s) => String(s.code).toUpperCase() === String(result.sale.code).toUpperCase());
      stats = affiliates.summarise(sales);
    } catch (err) {
      // The message still goes, without the running total.
    }
    await affiliateNotify.tellInfluencer(result.sale.influencer_id, affiliateNotify.saleMessage(result.sale, stats));
  } catch (err) {
    console.error(`[payments] could not record promo ${notes.promo_code} for ${paymentId}: ${err.message}`);
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
    if (notes.promo_code) {
      await recordAffiliateSale(notes, payment.id || link.id, paidPaise);
    }
    // The last step of the Code Tracking funnel: this student paid.
    if ((notes.coupon_code || notes.promo_code) && !granted.alreadyProcessed) {
      await recordCodePaid(notes, payment.id || link.id, paidPaise);
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

/**
 * telegramChatFor — the Telegram supergroup a group's questions go to.
 *
 * Each group has its own supergroup (TELEGRAM_GROUP_<PREFIX>) with its own
 * topic ids. Posting always went to TELEGRAM_GROUP_ID — the English newspaper
 * group — so every other group's topic ids pointed at threads that did not
 * exist there ("message thread not found"), or worse, at a real topic in the
 * wrong group. No fallback: a group without its own chat must not post anywhere.
 *
 * @param {string} groupId
 * @returns {string} The chat id, e.g. -100…
 */
function telegramChatFor(groupId) {
  const group = groupRegistry.requireGroup(groupId);
  if (!group.telegramGroupId) {
    const err = new Error(
      `No Telegram group is set for ${group.displayName}. Add TELEGRAM_GROUP_${group.envPrefix} ` +
      '(the group\'s -100… chat id) to the environment and redeploy.'
    );
    err.statusCode = 400;
    throw err;
  }
  return group.telegramGroupId;
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

/**
 * syncBotMenus — puts back any bot menu Telegram holds that differs from the
 * one in src/bot-commands.js.
 *
 * Menus live on Telegram's servers, so a deploy never changes them: the
 * /referral entry stayed in every payment bot's menu after referrals were
 * removed, until someone remembered to run `npm run bot-profile`. The daily
 * sweep checks instead, and only writes when something is actually wrong.
 * Never throws — a menu is not worth failing the sweep over.
 */
async function syncBotMenus() {
  const results = [];
  const callFor = (token) => (method, params) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {})
  }).then((r) => r.json());

  const bots = paymentBotEnvs().map((env) => ({ env, wanted: botCommands.STUDENT_COMMANDS, payment: true }));
  if (affiliateNotify.isConfigured()) {
    bots.push({ env: affiliateNotify.BOT_ENV, wanted: botCommands.AFFILIATE_COMMANDS, payment: false });
  }
  for (const { env, wanted, payment } of bots) {
    try {
      const call = callFor(String(process.env[env] || '').trim());
      const shown = await botCommands.menuStudentsSee(call);
      const expected = wanted.map((c) => c.command);
      if (shown.join(' ') === expected.join(' ')) {
        results.push({ bot: env, changed: false });
        continue;
      }
      if (payment) {
        await botCommands.registerMenus(call, support.supportChatFor(env));
      } else {
        await call('setMyCommands', { commands: wanted, scope: { type: 'all_private_chats' } });
        await call('deleteMyCommands', { scope: { type: 'default' } });
      }
      console.log(`[cron] ${env} menu was ${shown.map((c) => '/' + c).join(' ') || '(empty)'} — rewritten`);
      results.push({ bot: env, changed: true, was: shown });
    } catch (err) {
      console.error(`[cron] could not check ${env}'s menu: ${err.message}`);
      results.push({ bot: env, error: err.message });
    }
  }
  return results;
}

let affiliateBotApp = null;
/** The affiliate bot, built once per instance. */
function affiliateBot() {
  if (!affiliateBotApp) affiliateBotApp = affiliateBotFactory.createAffiliateBot({ polling: false });
  return affiliateBotApp;
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
/**
 * recoverAbandonedClaims — hands back rows a posting run claimed and never
 * sent, so the questions it did not get to can be posted by the next run.
 *
 * Never fails a posting run: a sheet whose Apps Script predates this simply
 * behaves as it did before, which is the old stuck-row problem and not a new
 * one.
 *
 * @returns {Promise<Array<Object>>} The rows put back, [] when none or unknown
 */
async function recoverAbandonedClaims(db, subject) {
  try {
    const result = await db.recoverStaleClaims(subject, STALE_CLAIM_MINUTES);
    if (result.recovered.length) {
      console.log(`[post] ${subject}: put ${result.recovered.length} abandoned claim(s) back in the queue ` +
        `(${result.recovered.map((r) => r.question_id || `row ${r.row}`).join(', ')})`);
    }
    return result.recovered;
  } catch (err) {
    if (err.staleScript) {
      console.warn(`[post] ${subject}: this sheet's Apps Script cannot recover abandoned claims — redeploy it.`);
    } else {
      console.error(`[post] ${subject}: could not recover abandoned claims: ${err.message}`);
    }
    return [];
  }
}

/**
 * holdForChecking — marks a row whose poll may be in the channel, so it is
 * never posted again automatically and never handed back by
 * recoverAbandonedClaims. Best effort: the row is already claimed either way.
 */
async function holdForChecking(db, subject, row, note) {
  try {
    await db.holdQuestions(subject, [row], note);
  } catch (err) {
    if (!err.staleScript) console.error(`[post] could not hold row ${row} for checking: ${err.message}`);
  }
}

async function describeShortfall(db, subject, asked, eligible, requireApproved) {
  try {
    const page = await db.listQuestions({ subject, pageSize: 500 });
    const all = page.questions || [];

    const posted = all.filter((q) => String(q.posted).toUpperCase() === 'YES').length;
    const sending = all.filter((q) => q.claimed && !q.held).length;
    const held = all.filter((q) => q.held).length;
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
    if (sending) parts.push(`${sending} being sent right now`);
    if (held) parts.push(`${held} held for checking`);

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

/**
 * authoriseCron — the shared gate on every scheduled route.
 *
 * These routes are public in the routing sense only. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; without a matching secret they refuse
 * to run, because anyone who found the URL could otherwise remove paying
 * members or publish to the channel.
 *
 * Answers the request itself when it refuses, so a caller is one `if` away
 * from being safe — three routes each re-deriving this is three chances to
 * get one of them wrong.
 *
 * @returns {boolean} true when the route may proceed
 */
function authoriseCron(req, res) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) {
    sendJSON(res, 503, {
      success: false,
      error: 'CRON_SECRET is not set, so the scheduled routes refuse to run.'
    });
    return false;
  }

  // Constant-time compare: a timing oracle on a secret that can remove paying
  // members is not worth saving three lines over.
  const offered = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  if (offered.length !== expected.length || !crypto.timingSafeEqual(offered, expected)) {
    sendJSON(res, 401, { success: false, error: 'Unauthorised' });
    return false;
  }
  return true;
}

/** Which subject each group's deleted-poll cron checks next. groupId -> index. */
const cronReconcileTurn = new Map();

/**
 * The autopilot: unattended "every N minutes, post M questions" runs.
 *
 * Built here rather than inside src/autopilot.js because the work it does is
 * this file's — postBatch and reconcileChannel, with the same claiming, the
 * same locking and the same sheet client the dashboard button uses. The module
 * only decides WHEN, which is what makes it testable without Telegram.
 *
 * `sheets.forGroup` is resolved per run, not captured once: a group whose
 * configuration is fixed while a job is running should be picked up by the
 * next run rather than needing the job restarted.
 */
const autopilot = autopilotFactory.createAutopilot({
  maxBatch: MAX_POST_BATCH,
  postBatch: async ({ groupId, subject, count, requireApproved }) => {
    const outcome = await postBatch({
      db: sheets.forGroup(groupId),
      groupId,
      subject,
      count,
      requireApproved,
      // Well inside one interval, so a long batch cannot still be running when
      // its own next run comes due.
      budgetMs: Math.min(POST_BUDGET_MS, AUTOPILOT_RUN_BUDGET_MS)
    });
    // A refusal (no topic configured, bot unreachable, a batch already in
    // flight) is a failure of this run, not a quiet zero: the job has to be
    // able to report it, and must not read it as "the queue is empty" and
    // switch itself off.
    if (!outcome.payload || outcome.payload.success !== true) {
      throw new Error((outcome.payload && outcome.payload.error) || 'The posting run failed.');
    }
    return outcome.payload;
  },
  reconcile: async ({ groupId, subject }) => {
    const outcome = await reconcileChannel({
      db: sheets.forGroup(groupId),
      groupId,
      subject,
      apply: true,
      // Never re-queue unattended: a question someone deleted from the channel
      // would go back out within the interval, and nobody would be watching.
      action: 'mark',
      limit: AUTOPILOT_RECONCILE_LIMIT,
      budgetMs: AUTOPILOT_RECONCILE_BUDGET_MS,
      actor: 'autopilot'
    });
    if (!outcome.payload || outcome.payload.success !== true) {
      throw new Error((outcome.payload && outcome.payload.error) || 'The deleted-poll check failed.');
    }
    return outcome.payload;
  }
});

/**
 * Where the last deleted-poll sweep for each group+subject stopped.
 *
 * Checking a poll is one Telegram call and a pause for the rate limit, so a
 * subject with 500 posted questions cannot be swept inside one run. Without a
 * cursor, every automatic sweep re-checked the same first rows for ever and
 * the newest posts — the ones most likely to have just been deleted — were
 * never reached at all. `${group}::${subject}` -> the row it stopped after.
 */
const reconcileCursor = new Map();

/**
 * reconcileChannel — finds posted questions whose poll is gone from Telegram.
 *
 * Telegram never tells a bot that a message was deleted, so a poll removed
 * from the channel left the sheet claiming it was posted for ever: the
 * question could never be re-sent and the counts were wrong. This walks the
 * posted rows, checks each poll is still there, and (with `apply`) puts the
 * deleted ones back in the queue.
 *
 * Shared by the dashboard button, the autopilot's periodic check and the cron
 * route, so all three agree on what "deleted" means.
 *
 * @param {Object} options
 * @param {boolean} options.apply Write the changes, rather than only report
 * @param {number} [options.limit] Most rows to check in this pass
 * @returns {Promise<{status: number, payload: Object}>}
 */
async function reconcileChannel(options) {
  const { db, groupId, subject, apply, actor } = options;

  // What to do with a poll that is gone. Marking is the default, and the old
  // default of re-queueing was wrong in the common case: a curator who deletes
  // a poll from the channel has decided that question should not be there, and
  // putting it back in the queue posts it again a few minutes later. Getting
  // it back out is a separate decision a person makes on purpose.
  const action = options.action === 'requeue' ? 'requeue' : 'mark';

  let chatId;
  try {
    ensureTelegram();
    chatId = telegramChatFor(groupId);
  } catch (err) {
    return { status: 400, payload: { success: false, error: err.message } };
  }

  const budgetMs = Number(options.budgetMs) || POST_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const limit = Math.max(0, Number(options.limit) || 0);

  const posted = await db.listPosted(subject);
  const cursorKey = `${groupId}::${subject}`;

  // Start after wherever the last sweep stopped, then wrap around. Sorting by
  // row first makes "after" mean the same thing on every pass, whatever order
  // the sheet client happened to return.
  const ordered = posted.slice().sort((a, b) => Number(a.row) - Number(b.row));
  const resumeAfter = Number(reconcileCursor.get(cursorKey)) || 0;
  const resumeAt = ordered.findIndex((row) => Number(row.row) > resumeAfter);
  const queue = resumeAt <= 0 ? ordered : ordered.slice(resumeAt).concat(ordered.slice(0, resumeAt));

  const missing = [];
  const unknown = [];
  let checked = 0;
  let lastRow = resumeAfter;

  for (const row of queue) {
    if (Date.now() > deadline) break;
    if (limit && checked >= limit) break;
    checked++;
    lastRow = Number(row.row);

    const exists = await telegram.pollStillExists(row.message_id, chatId);
    if (exists === false) missing.push(row);
    else if (exists === null) unknown.push(row.question_id);

    // Telegram rate-limits edits like anything else.
    await sleep(400);
  }

  // A sweep that reached the end starts again from the top next time.
  reconcileCursor.set(cursorKey, checked >= ordered.length ? 0 : lastRow);

  let restored = 0;
  let marked = 0;
  if (apply && missing.length) {
    const rowNumbers = missing.map((m) => m.row);
    if (action === 'requeue') {
      restored = await db.unpostQuestions(subject, rowNumbers, 'Approved');
      console.log(`[reconcile] ${actor || 'the deleted-poll check'} returned ${restored} deleted ` +
        `poll(s) to the queue in "${subject}"`);
    } else {
      marked = await db.markDeleted(subject, rowNumbers,
        `Deleted from the Telegram group — the poll is no longer there. ` +
        `Noticed by ${actor || 'the scheduled deleted-poll check'}.`);
      console.log(`[reconcile] ${actor || 'the deleted-poll check'} marked ${marked} question(s) ` +
        `Deleted in "${subject}"`);
    }
  }

  const swept = checked >= ordered.length;
  return {
    status: 200,
    payload: {
      success: true,
      applied: Boolean(apply),
      checked,
      totalPosted: ordered.length,
      missing: missing.map((m) => ({ questionId: m.question_id, row: m.row, messageId: m.message_id })),
      // Named, so "3 could not be checked" is actionable rather than ominous.
      unknown,
      action,
      restored,
      marked,
      // A partial sweep has to say so, or "0 deleted" sounds like the whole
      // channel was checked when only the first few rows were.
      complete: swept,
      message: apply
        ? (action === 'requeue'
          ? `${restored} deleted poll(s) put back in the queue for "${subject}".`
          : `${marked} question(s) marked Deleted in "${subject}". They stay out of the queue, ` +
            'so none of them will be posted again.')
        : `${missing.length} of ${checked} checked poll(s) are no longer in the channel.` +
          (swept ? '' : ` ${ordered.length - checked} more will be checked on the next pass.`) +
          (missing.length ? ' Run again with Apply to put them back in the queue.' : '')
    }
  };
}

/**
 * postBatch — sends the next `count` eligible questions of one subject.
 *
 * This is the whole posting run: recover abandoned claims, read the queue,
 * reserve the rows, send each poll, mark each row, and hand back anything it
 * did not reach. It used to live inside the HTTP handler, which meant the only
 * way to post was for someone to be holding a browser tab open. It is a
 * function now because three callers need exactly this behaviour and must not
 * each grow their own copy of it: the dashboard button, the autopilot, and the
 * cron route.
 *
 * It never throws for an ordinary failure — the outcome is the return value,
 * because half a batch that posted is still news worth reporting precisely.
 *
 * @param {Object} options
 * @param {Object} options.db Group-bound sheets client
 * @param {string} options.groupId Which group is posting
 * @param {string} options.subject Subject tab (already validated)
 * @param {number} options.count How many to send, capped at MAX_POST_BATCH
 * @param {boolean} options.requireApproved Exclude Drafts
 * @param {number} [options.budgetMs] Wall-clock ceiling for the run
 * @param {Function} [options.emit] Called with each progress event
 * @param {Function} [options.stopping] Returns true to stop after the question in hand
 * @returns {Promise<{status: number, payload: Object}>}
 */
async function postBatch(options) {
  const db = options.db;
  const groupId = options.groupId;
  const subject = options.subject;
  const count = Math.min(Math.max(parseInt(options.count, 10) || 1, 1), MAX_POST_BATCH);
  const requireApproved = options.requireApproved !== false;
  const emit = options.emit || (() => {});
  const stopping = options.stopping || (() => false);
  const deadline = Date.now() + (Number(options.budgetMs) || POST_BUDGET_MS);
  const done = (status, payload) => ({ status, payload });

  let chatId;
  try {
    ensureTelegram();
    chatId = telegramChatFor(groupId);
  } catch (err) {
    return done(400, { success: false, error: err.message });
  }

  // Resolve the forum topic for this subject from the Config tab.
  const config = await db.readConfig();
  const subjectConfig = config.find((c) => c.subject === subject);
  if (!subjectConfig) {
    return done(400, { success: false, error: `"${subject}" is not in the Config tab` });
  }
  if (!subjectConfig.topic_thread_id) {
    return done(400, {
      success: false,
      error: `No Telegram topic thread configured for "${subject}". Run: node setup.js`
    });
  }

  const lockKey = `${groupId}::${subject}`;
  if (postsInFlight.has(lockKey)) {
    return done(409, {
      success: false,
      error: `A posting batch for "${subject}" is already running. Wait for it to finish — ` +
        'starting a second one would post the same questions twice.'
    });
  }
  postsInFlight.add(lockKey);

  try {
    emit({ type: 'stage', text: 'Checking for questions an interrupted run left behind…' });
    // A run that was killed mid-batch leaves its unsent rows claimed. They
    // were never posted, and without this they never could be: they are not
    // eligible, and no one can clear them from the dashboard. Put them back
    // before deciding what to send, so "post the rest" is just posting again.
    const recovered = await recoverAbandonedClaims(db, subject);
    emit({ type: 'stage', text: `Reading the next ${count} eligible question(s) from the sheet…` });
    const questions = await db.getUnpostedQuestions(subject, count, requireApproved);
    if (!questions.length) {
      return done(200, {
        success: true,
        postedCount: 0,
        requestedCount: count,
        eligibleCount: 0,
        failedCount: 0,
        results: [],
        message: requireApproved
          ? `No Approved or Scheduled questions waiting in "${subject}"`
          : `No unposted questions left in "${subject}"`
      });
    }

    // ---- Claim before sending ------------------------------------------
    // A poll can reach Telegram and still leave this process with a timeout
    // or a dropped connection. Marking only after a confirmed send therefore
    // left delivered questions looking unposted, and they went out again on
    // every subsequent run — two of them were stuck in that loop. Claiming
    // first means the worst case is a question that needs a human to resolve,
    // never one that is posted twice.
    emit({ type: 'stage', text: `Reserving ${questions.length} question(s) so none can go out twice…` });
    const rowsWanted = questions.map((q) => sheets.sheetRowOf(q));
    const claim = await db.claimQuestions(subject, rowsWanted);
    const claimedRows = new Set(claim.claimed);

    const results = [];
    // Every outcome is also streamed the moment it is known.
    const record = (item) => { results.push(item); emit(Object.assign({ type: 'result' }, item)); };
    const postedRowIndices = [];
    const strandedRows = [];

    // Anything another run took first is reported, not silently dropped.
    for (const skip of claim.skipped || []) {
      const q = questions.find((item) => sheets.sheetRowOf(item) === Number(skip.row));
      record({
        questionId: q ? q.question_id : `row ${skip.row}`,
        ok: false,
        error: `Skipped — ${skip.reason}.`,
        preview: q ? q.question_text.slice(0, 80) : ''
      });
    }

    const toSend = questions.filter((q) => claimedRows.has(sheets.sheetRowOf(q)));
    emit({ type: 'plan', total: toSend.length, eligible: questions.length, skipped: (claim.skipped || []).length });

    for (let i = 0; i < toSend.length; i++) {
      const q = toSend[i];
      const sheetRow = sheets.sheetRowOf(q);

      // Stop cleanly while there is still time to record what has been sent,
      // and hand back what was never attempted.
      if (Date.now() > deadline || stopping()) {
        const untouched = toSend.slice(i).map((rest) => sheets.sheetRowOf(rest));
        try {
          await db.releaseQuestions(subject, untouched, q.status);
        } catch (releaseErr) {
          console.error('[post] could not release unsent rows:', releaseErr.message);
        }
        toSend.slice(i).forEach((rest) => record({
          questionId: rest.question_id,
          ok: false,
          error: stopping()
            ? 'Not sent — posting was stopped. It is back in the queue.'
            : 'Stopped before the request timed out — run again to post the rest.',
          preview: rest.question_text.slice(0, 80)
        }));
        break;
      }

      emit({
        type: 'sending', index: i + 1, total: toSend.length,
        questionId: q.question_id, preview: String(q.question_text || '').slice(0, 80)
      });

      try {
        const sent = await telegram.sendQuizPoll(subjectConfig.topic_thread_id, q, chatId);

        const messageId = sent && sent.message_id ? sent.message_id : null;
        const pollIds = sent && sent.poll && sent.poll.id
          ? { [String(sheetRow)]: sent.poll.id }
          : null;

        try {
          await db.markAsPosted(
            subject, [sheetRow], messageId, subjectConfig.topic_thread_id, pollIds
          );
          postedRowIndices.push(sheetRow);
          record({ questionId: q.question_id, ok: true, preview: q.question_text.slice(0, 80) });
        } catch (markErr) {
          // The poll is public and the row is still claimed, so it cannot go
          // out again. It needs a person, and says so.
          console.error(`[post] row ${sheetRow} posted but not marked:`, markErr.message);
          strandedRows.push(sheetRow);
          await holdForChecking(db, subject, sheetRow,
            `Posted to Telegram${messageId ? ` (message ${messageId})` : ''} but the sheet write failed: ${markErr.message}`);
          record({
            questionId: q.question_id,
            ok: false,
            error: `Posted to Telegram, but the sheet did not record it (${markErr.message}). ` +
                   `Row ${sheetRow} is held for checking so it cannot be posted twice — mark it Posted by hand.`,
            preview: q.question_text.slice(0, 80)
          });
        }
      } catch (err) {
        // Did Telegram refuse it, or did the answer go missing? Only a refusal
        // proves nothing was delivered, and only then is it safe to hand the
        // row back. Anything else keeps the claim.
        if (telegram.wasRejectedBeforeDelivery(err)) {
          try {
            await db.releaseQuestions(subject, [sheetRow], q.status);
          } catch (releaseErr) {
            console.error(`[post] could not release row ${sheetRow}:`, releaseErr.message);
          }
          record({
            questionId: q.question_id, ok: false,
            error: `Telegram refused it: ${err.message}`,
            preview: q.question_text.slice(0, 80)
          });
        } else {
          strandedRows.push(sheetRow);
          await holdForChecking(db, subject, sheetRow,
            `No answer from Telegram when posting: ${err.message}. It may or may not have gone out.`);
          record({
            questionId: q.question_id, ok: false,
            error: `No answer from Telegram (${err.message}). It may or may not have gone out, ` +
                   `so row ${sheetRow} is held for checking rather than risking a duplicate. Check the channel.`,
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
    let message = `${postedCount} of ${questions.length} question(s) posted to "${subject}"`;
    if (questions.length < count) {
      emit({ type: 'stage', text: 'Checking why fewer questions were ready than asked for…' });
      const shortfall = await describeShortfall(db, subject, count, questions.length, requireApproved);
      message += ` — you asked for ${count}, and ${questions.length} ${questions.length === 1 ? 'was' : 'were'} ready. ${shortfall}`;
    } else if (remaining) {
      message += ` — run again to send the remaining ${remaining}`;
    }
    if (recovered.length) {
      message += ` ♻️ ${recovered.length} question(s) left claimed by an interrupted run were put back in the queue first.`;
    }
    if (strandedRows.length) {
      message += ` ⚠️ ${strandedRows.length} row(s) are held for checking — they may be in the channel.`;
    }

    return done(200, {
      success: true,
      postedCount,
      requestedCount: count,
      eligibleCount: questions.length,
      recoveredRows: recovered.map((r) => r.row),
      strandedRows,
      failedCount: questions.length - postedCount,
      results,
      message,
      // Which route reached the sheet, so a deploy can be checked at a glance.
      sheetAccess: db.direct ? 'sheets-api' : 'apps-script'
    });

  } catch (err) {
    console.error(`[post] ${subject} failed:`, err.message);
    return done(err.statusCode || 500, { success: false, error: err.message });
  } finally {
    postsInFlight.delete(lockKey);
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
        // The name the student was shown at checkout, which an admin may have set.
        planLabel: notes.plan_label || (plan ? plan.label : null),
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

  // ---- The influencer (affiliate) bot's webhook ----------------------------
  // The same credential as the payment bots — the secret Telegram echoes — and
  // the same rule: do the work before answering, inside the same budget.
  if (pathname === '/api/telegram/affiliate' && method === 'POST') {
    const secret = telegramWebhookSecret();
    if (!secret) {
      sendJSON(res, 503, { success: false, error: 'No TELEGRAM_WEBHOOK_SECRET or CRON_SECRET set.' });
      return true;
    }
    const offered = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
    const expected = Buffer.from(secret);
    if (offered.length !== expected.length || !crypto.timingSafeEqual(offered, expected)) {
      console.warn('[affiliate-bot] rejected a webhook with a bad secret token');
      sendJSON(res, 401, { success: false, error: 'Unauthorised' });
      return true;
    }
    if (!affiliateNotify.isConfigured()) {
      sendJSON(res, 404, { success: false, error: 'No affiliate bot is configured.' });
      return true;
    }
    let update;
    try {
      update = JSON.parse(await readRawBody(req));
    } catch (err) {
      sendJSON(res, 400, { success: false, error: 'Malformed update' });
      return true;
    }
    try {
      const app = affiliateBot();
      app.bot.processUpdate(update);
      let budgetTimer;
      try {
        await Promise.race([
          app.settle(),
          new Promise((resolve) => { budgetTimer = setTimeout(resolve, BOT_UPDATE_BUDGET_MS); })
        ]);
      } finally {
        clearTimeout(budgetTimer);
      }
    } catch (err) {
      console.error('[affiliate-bot] failed to handle an update:', err.message);
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
    if (!authoriseCron(req, res)) return true;

    try {
      const summary = await membership.runDailyCheckAllGroups({ dryRun: false });
      console.log(
        `[cron] sweep across ${summary.groups.length} group(s): ` +
        `reminded ${summary.totals.reminded}, removed ${summary.totals.removed}`
      );
      summary.supportSummaries = await postDailySupportSummaries();
      summary.menus = await syncBotMenus();
      // Belt and braces: if the minute-by-minute pinger has been down, no
      // preview is left open for longer than a day.
      summary.trials = await sweepTrials();
      sendJSON(res, 200, { success: true, data: summary });
    } catch (err) {
      console.error('[cron] sweep failed:', err.message);
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // ---- Free preview sweep --------------------------------------------------
  // The preview lasts minutes, so this has to run every minute — far more
  // often than the nightly sweep. Vercel's free plan only schedules daily
  // crons, so a free minute-by-minute pinger calls this (see the README);
  // the nightly sweep calls it too, so a stale preview is never left open.
  if (pathname === '/api/cron/trials' && (method === 'POST' || method === 'GET')) {
    if (!authoriseCron(req, res)) return true;
    try {
      const result = await sweepTrials();
      if (result.warned.length || result.ended.length) {
        console.log(`[cron] previews: warned ${result.warned.length}, ended ${result.ended.length}`);
      }
      sendJSON(res, 200, { success: true, data: result });
    } catch (err) {
      console.error('[cron] preview sweep failed:', err.message);
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // ---- Autopilot tick (serverless) ----------------------------------------
  // On Vercel nothing survives between requests, so the in-process timer never
  // fires: a job started from the dashboard would be forgotten the moment the
  // response was sent. Vercel Cron calling this is the scheduler there, and it
  // runs exactly the same tick the timer does.
  //
  // Same authorisation as the expiry sweep: this posts to a public channel, so
  // an unauthenticated caller who found the URL must not be able to trigger it.
  if (pathname === '/api/cron/autopilot' && (method === 'POST' || method === 'GET')) {
    if (!authoriseCron(req, res)) return true;

    try {
      const ran = await autopilot.tick();
      if (ran.length) {
        console.log(`[cron] autopilot ran ${ran.length} job(s): ` +
          ran.map((r) => `${r.subject} (+${r.run.posted})`).join(', '));
      }
      sendJSON(res, 200, { success: true, data: { ran, jobs: autopilot.list() } });
    } catch (err) {
      console.error('[cron] autopilot failed:', err.message);
      sendJSON(res, 500, { success: false, error: err.message });
    }
    return true;
  }

  // ---- Deleted-poll sweep (serverless) -------------------------------------
  // The half of "keep the sheet honest" that has to keep working when nobody
  // is watching: a poll deleted in Telegram leaves the sheet claiming it was
  // posted, so the question can never be re-sent and every count is wrong.
  // One subject per group per call, taking the next in rotation, because each
  // row costs a Telegram call and a rate-limit pause.
  if (pathname === '/api/cron/reconcile' && (method === 'POST' || method === 'GET')) {
    if (!authoriseCron(req, res)) return true;

    const results = [];
    for (const group of groupRegistry.listGroups()) {
      if (!group.ready) continue;
      try {
        const groupDb = sheets.forGroup(group.id);
        const config = await groupDb.readConfig();
        const subjects = config.map((c) => c.subject).filter(Boolean);
        if (!subjects.length) continue;

        // Round-robin across this group's subjects, so a daily cron eventually
        // covers all of them instead of only ever checking the first.
        const at = cronReconcileTurn.get(group.id) || 0;
        const subject = subjects[at % subjects.length];
        cronReconcileTurn.set(group.id, (at + 1) % subjects.length);

        const outcome = await reconcileChannel({
          db: groupDb,
          groupId: group.id,
          subject,
          apply: true,
          action: 'mark',
          limit: AUTOPILOT_RECONCILE_LIMIT,
          budgetMs: AUTOPILOT_RECONCILE_BUDGET_MS,
          actor: 'the nightly deleted-poll check'
        });
        results.push({
          groupId: group.id,
          subject,
          marked: outcome.payload.marked || 0,
          checked: outcome.payload.checked || 0,
          complete: outcome.payload.complete === true
        });
      } catch (err) {
        console.error(`[cron] reconcile failed for ${group.id}: ${err.message}`);
        results.push({ groupId: group.id, error: err.message });
      }
    }

    const marked = results.reduce((sum, r) => sum + (r.marked || 0), 0);
    console.log(`[cron] deleted-poll sweep marked ${marked} question(s) Deleted`);
    sendJSON(res, 200, { success: true, data: { results, marked } });
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

/**
 * postDailySupportSummaries — the morning support summary, posted by each
 * payment bot into its support chat by the daily job. Set
 * SUPPORT_DAILY_SUMMARY=off to stop it. Never fails the sweep.
 *
 * @returns {Promise<Array<{bot: string, posted: boolean, error?: string}>>}
 */
async function postDailySupportSummaries() {
  if (/^(off|false|no|0)$/i.test(String(process.env.SUPPORT_DAILY_SUMMARY || '').trim())) return [];
  const results = [];
  for (const payBotEnv of paymentBotEnvs()) {
    const chat = support.supportChatFor(payBotEnv);
    if (!chat) continue;
    try {
      const app = paymentBotFor(payBotEnv);
      const posted = await app.postSupportSummary(chat);
      results.push({ bot: payBotEnv, posted });
    } catch (err) {
      console.error(`[cron] support summary for ${payBotEnv} failed: ${err.message}`);
      results.push({ bot: payBotEnv, posted: false, error: err.message });
    }
  }
  return results;
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
  const { group, family, primary } = familyOf(groupId);
  // A bot's tickets and settings live in its first group's sheet, whichever of
  // its groups the dashboard is looking at.
  const db = primary.id === group.id ? selectedDb : sheets.forGroup(primary.id);
  const familyIds = family.map((g) => g.id);
  const context = {
    groupId: group.id,
    groups: family.map((g) => ({ id: g.id, name: g.shortName })),
    primaryGroupId: primary.id,
    primaryGroupName: primary.shortName,
    isPrimary: primary.id === group.id,
    payBotEnv: group.paymentBotEnv || '',
    botConfigured: paymentBotEnvs().includes(group.paymentBotEnv),
    supportChatConfigured: Boolean(support.supportChatFor(group.paymentBotEnv))
  };

  if (pathname === '/api/support/tickets' && method === 'GET') {
    const status = str(query.get('status'), 20).toLowerCase();
    const waitingOn = str(query.get('waitingOn'), 10).toLowerCase();
    const data = await db.listTickets({
      status: status && (support.TICKET_STATUSES.includes(status) || status === 'answered')
        ? support.normaliseStatus(status) : '',
      waitingOn: ['admin', 'student'].includes(waitingOn) ? waitingOn : '',
      sort: str(query.get('sort'), 10) === 'waiting' ? 'waiting' : '',
      search: str(query.get('search'), 120),
      group: familyIds.includes(str(query.get('group'), 40)) ? str(query.get('group'), 40) : '',
      page: str(query.get('page'), 8) || '1',
      pageSize: str(query.get('pageSize'), 4) || '50'
    });
    sendJSON(res, 200, { success: true, data: Object.assign({ context }, data) });
    return true;
  }

  if (pathname === '/api/support/stats' && method === 'GET') {
    const days = str(query.get('days'), 3);
    const data = await db.getSupportStats({ days: /^\d+$/.test(days) ? days : '30' });
    sendJSON(res, 200, { success: true, data: Object.assign({ context }, data || {}) });
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
      await app.bot.sendMessage(ticket.telegram_id, support.studentReplyHtml(ticketId, text), { parse_mode: 'HTML' });
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
        author: `Admin ${actor}`, text, handledBy: actor
      });
    } catch (err) {
      // The student already has the message; failing the request now would
      // invite a second send.
      warning = `Delivered, but the sheet was not updated: ${err.message}`;
    }

    await mirrorToSupportChat(app, ticket,
      `💻 <b>Answered from the dashboard</b> · by ${support.esc(actor)}\n` +
      `<blockquote>${support.esc(text)}</blockquote>\n` +
      `<b>Status:</b> ${support.statusLine('in_progress', 'student')}`);

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
          lastPaymentAt: p.subscriber ? p.subscriber.last_payment_at : '',
          // The sheet could not be read: not the same as having no pass.
          error: Boolean(p.error),
          aboutThisTicket: Boolean(ticket.group) && p.group.id === ticket.group
        })),
        ticketGroup: ticket.group || '',
        suggestion: support.suggestNextStep(ticket.category, passes, ticket.group || ''),
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

  // Only an admin action closes a ticket, and this route is how the dashboard
  // does it. "open" and "in_progress" both mean reopen: once an admin has
  // touched a ticket it is never "not picked up" again.
  if (pathname === '/api/support/group' && method === 'POST') {
    const body = await readJsonBody(req);
    const ticketId = str(body.ticketId, 20);
    const newGroup = str(body.group, 40);
    if (!TICKET_ID_RE.test(ticketId) || (newGroup && !familyIds.includes(newGroup))) {
      sendJSON(res, 400, { success: false, error: 'ticketId and one of this bot\'s groups (or blank) are required.' });
      return true;
    }
    const updated = await db.setTicketGroup(ticketId, newGroup, actor);
    if (!updated) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found in this group's sheet.` });
      return true;
    }
    sendJSON(res, 200, { success: true, data: updated });
    return true;
  }

  if (pathname === '/api/support/status' && method === 'POST') {
    const body = await readJsonBody(req);
    const ticketId = str(body.ticketId, 20);
    const requested = str(body.status, 20).toLowerCase();
    const status = requested === 'closed' ? 'closed'
      : (['open', 'in_progress', 'answered', 'reopen'].includes(requested) ? 'in_progress' : '');
    if (!TICKET_ID_RE.test(ticketId) || !status) {
      sendJSON(res, 400, {
        success: false,
        error: 'ticketId and a status of closed (close) or in_progress (reopen) are required.'
      });
      return true;
    }

    const updated = await db.setTicketStatus(ticketId, status, actor);
    if (!updated) {
      sendJSON(res, 404, { success: false, error: `Ticket ${ticketId} was not found in this group's sheet.` });
      return true;
    }

    const changed = updated.previous_status !== updated.status;
    let notified = false;
    const app = paymentBotEnvs().includes(updated.bot) ? paymentBotFor(updated.bot) : null;
    if (app && changed && status === 'closed' && body.notify !== false) {
      try {
        await app.bot.sendMessage(updated.telegram_id, support.resolvedHtml(ticketId), { parse_mode: 'HTML' });
        notified = true;
      } catch (err) {
        console.warn(`[support] could not tell ${updated.telegram_id} that ${ticketId} closed: ${err.message}`);
      }
    }
    if (app && changed) {
      await mirrorToSupportChat(app, updated,
        (status === 'closed'
          ? `✅ <b>Closed</b> from the dashboard by ${support.esc(actor)}${notified ? ' — the student was told.' : ''}`
          : `🔓 <b>Reopened</b> from the dashboard by ${support.esc(actor)}`) +
        `\nStatus: ${support.statusLine(updated.status, updated.waiting_on)}`,
        { closed: updated.status === 'closed' });
    }

    sendJSON(res, 200, { success: true, data: updated, notified, changed });
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
        waiting: Object.entries(support.WAITING_LABELS).map(([id, label]) => ({ id, label })),
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
      // The page needs to know, or it offers a "Valid until" box that does
      // nothing: a lifetime pass ignores any end date by design.
      lifetime: pass.lifetime === true,
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

  // ---- Code tracking: who clicked a code's link, applied it, made a payment
  // link and paid — or did not.
  if (pathname === '/api/pricing/tracking' && method === 'GET') {
    const payBotEnv = group.paymentBotEnv;
    if (!codeTracking.isConfigured(payBotEnv)) {
      sendJSON(res, 200, { success: true, data: { context, configured: false, codes: [], rows: [], totals: codeTracking.summarise([]) } });
      return true;
    }
    const wanted = pricing.normaliseCode(query.get('code'));
    const code = pricing.COUPON_CODE_PATTERN.test(wanted) ? wanted : '';
    const [all, coupons, botUsername] = await Promise.all([
      codeTracking.list(payBotEnv),
      db.listCoupons().catch(() => []),
      paymentBotUsername(payBotEnv).catch(() => null)
    ]);
    const rows = code ? all.filter((r) => String(r.code).toUpperCase() === code) : all;
    // Every code worth picking: the ones with activity, and every coupon, so
    // a brand-new ad code can be chosen (and its link copied) before anyone uses it.
    const codes = codeTracking.summariseByCode(all);
    for (const c of coupons) {
      if (!codes.some((x) => x.code === c.code)) {
        codes.push(Object.assign({ code: c.code, kind: 'coupon' }, codeTracking.summarise([])));
      }
    }
    sendJSON(res, 200, {
      success: true,
      data: {
        context,
        configured: true,
        botUsername: botUsername || '',
        linkBase: botUsername ? `https://t.me/${botUsername}?start=promo_` : '',
        stages: codeTracking.STAGES,
        code,
        codes,
        totals: codeTracking.summarise(rows),
        rows: rows.map((r) => { const out = Object.assign({}, r); delete out._row; return out; })
      }
    });
    return true;
  }

  if (pathname === '/api/pricing/tracking/refresh' && method === 'POST') {
    const payBotEnv = group.paymentBotEnv;
    if (!codeTracking.isConfigured(payBotEnv)) {
      sendJSON(res, 409, { success: false, error: 'Code tracking needs this group\'s SHEET_ID and the service account.' });
      return true;
    }
    if (!razorpay.isConfigured()) {
      sendJSON(res, 409, { success: false, error: 'Razorpay is not configured, so payment links cannot be checked.' });
      return true;
    }
    const body = await readJsonBody(req);
    const wanted = pricing.normaliseCode(body.code);
    const result = await codeTracking.refreshFromRazorpay(payBotEnv, {
      getPaymentLink: (id) => razorpay.getPaymentLink(id),
      code: pricing.COUPON_CODE_PATTERN.test(wanted) ? wanted : ''
    });
    const parts = [`Checked ${result.checked} payment link(s) with Razorpay`];
    if (result.changed) parts.push(`${result.changed} updated`);
    if (result.failed) parts.push(`${result.failed} could not be read`);
    if (result.remaining) parts.push(`${result.remaining} more to check — press again`);
    if (result.unrecorded.length) {
      parts.push(`⚠️ ${result.unrecorded.length} paid on Razorpay but never recorded — check those students on the Members page`);
    }
    sendJSON(res, 200, { success: true, data: result, message: parts.join(' · ') + '.' });
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
      `${support.ticketHeaderHtml(ticket.ticket_id, ticket.telegram_id)}\n${html}`, options);
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

  // ---- Influencers (affiliates) ---------------------------------------------
  // One programme across every exam, kept in its own sheet — so, like
  // /api/groups, these routes are about the system and not about one group.
  if (pathname.startsWith('/api/affiliates')) {
    return handleAffiliateRoute(pathname, method, req, res, user);
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
        let chat = null;
        try { chat = groupId ? telegramChatFor(groupId) : null; } catch (err) { chat = null; }
        const info = await telegram.getBotInfo(chat);
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
    sendJSON(res, 200, { success: true, data: sheetTabs.cleanAnalytics(await db.getAnalytics()) });
    return true;
  }

  if (pathname === '/api/stats' && method === 'GET') {
    sendJSON(res, 200, { success: true, data: sheetTabs.cleanStats(await db.getStats()) });
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

    const result = await db.bulkStatus(subject.value, ids, status, actor);
    sendJSON(res, 200, Object.assign({ success: true }, result));
    return true;
  }

  // ---- Queue and unqueue ---------------------------------------------------
  if (pathname === '/api/questions/schedule' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const ids = Array.isArray(body.questionIds) ? body.questionIds.map((id) => str(id, 60)).filter(Boolean) : [];
    if (!ids.length) { sendJSON(res, 400, { success: false, error: 'No questionIds provided' }); return true; }
    if (ids.length > 200) { sendJSON(res, 400, { success: false, error: 'Too many questionIds (max 200)' }); return true; }

    const result = await db.scheduleQuestions(subject.value, ids, str(body.scheduledFor, 40), actor);
    sendJSON(res, 200, Object.assign({ success: true }, result));
    return true;
  }

  // Takes questions back out of the queue. Queueing was a one-way door: the
  // only way back was to open the sheet and edit two columns by hand on every
  // row, which is exactly the work this dashboard exists to remove.
  if (pathname === '/api/questions/unschedule' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const ids = Array.isArray(body.questionIds) ? body.questionIds.map((id) => str(id, 60)).filter(Boolean) : [];
    if (!ids.length) { sendJSON(res, 400, { success: false, error: 'No questionIds provided' }); return true; }
    if (ids.length > 200) { sendJSON(res, 400, { success: false, error: 'Too many questionIds (max 200)' }); return true; }

    // Approved by default: a question that was ready enough to queue is still
    // ready, so unqueueing should not quietly send it back for review.
    const status = str(body.status, 20) || 'Approved';
    const result = await db.unscheduleQuestions(subject.value, ids, status, actor);
    console.log(`[questions] ${actor} unqueued ${result.updatedCount} question(s) in "${subject.value}"`);
    sendJSON(res, 200, Object.assign({ success: true }, result));
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
      const info = await telegram.getBotInfo(telegramChatFor(groupId));
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

    const outcome = await reconcileChannel({
      db,
      groupId,
      subject: subject.value,
      // Reporting only unless asked to write, so it can be run to look first.
      apply: body.apply === true,
      action: str(body.action, 10),
      limit: parseInt(body.limit, 10) || 0,
      actor
    });
    sendJSON(res, outcome.status, outcome.payload);
    return true;
  }

  // ---- Repair a tab's formatting -------------------------------------------
  // Rows appended through the Sheets API inherit the formatting of the row
  // above them, and the row above the first upload is the header. Sheets
  // filled before that was fixed are bold white on navy from top to bottom
  // and unreadable. This is the way back, without anyone editing a sheet by
  // hand or pasting a script.
  if (pathname === '/api/questions/format' && method === 'POST') {
    const body = await readJsonBody(req);

    // One subject, or the whole group's Config tab in one go — which is what
    // a curator whose sheet is already navy actually needs.
    let subjects;
    if (body.allSubjects === true) {
      subjects = (await db.readConfig()).map((c) => c.subject).filter(Boolean);
    } else {
      const subject = validateSubject(body.subject);
      if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }
      subjects = [subject.value];
    }

    if (!subjects.length) {
      sendJSON(res, 400, { success: false, error: 'No subjects are configured for this group.' });
      return true;
    }

    const results = [];
    for (const subject of subjects) {
      try {
        const done = await db.formatQuestions(subject);
        results.push({ subject, ok: true, rows: done.rows || 0 });
      } catch (err) {
        // One missing tab must not abandon the others: a curator asking for
        // the whole group wants every tab it could reach fixed.
        results.push({ subject, ok: false, error: err.message.split('\n')[0] });
      }
    }

    const fixed = results.filter((r) => r.ok).length;
    console.log(`[questions] ${actor} restored the formatting of ${fixed} tab(s)`);
    sendJSON(res, 200, {
      success: true,
      results,
      formattedCount: fixed,
      message: `${fixed} of ${results.length} tab(s) put back to the standard layout.`
    });
    return true;
  }

  // ---- Autopilot -----------------------------------------------------------
  // "Every 5 minutes, post the next 20 questions until there are none left."
  // Before this the only unattended posting was a cron expression in the
  // Config tab driving `node schedule.js` from a terminal that has to stay
  // open — nothing a curator could start, watch or stop from the dashboard.
  if (pathname === '/api/automation/autopilot' && method === 'GET') {
    sendJSON(res, 200, {
      success: true,
      data: {
        // Only this group's jobs: the page shows one group at a time, and
        // another group's job is not this curator's business.
        jobs: autopilot.list().filter((job) => job.groupId === groupId),
        // A job here lives in this process. On a serverless deployment that
        // process is gone between requests, so the page has to say so rather
        // than show a job that will never run again.
        persistent: !process.env.VERCEL,
        tickSeconds: Math.round(autopilotFactory.TICK_MS / 1000),
        maxBatch: MAX_POST_BATCH,
        emptyRunsBeforeStop: autopilotFactory.EMPTY_RUNS_BEFORE_STOP
      }
    });
    return true;
  }

  if (pathname === '/api/automation/autopilot' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const job = autopilot.start(groupId, subject.value, {
      intervalMinutes: body.intervalMinutes,
      batchSize: body.batchSize,
      requireApproved: body.requireApproved,
      stopWhenEmpty: body.stopWhenEmpty,
      reconcileEveryRuns: body.reconcileEveryRuns
    }, actor);

    console.log(`[autopilot] ${actor} started "${subject.value}": ` +
      `${job.settings.batchSize} question(s) every ${job.settings.intervalMinutes} min`);
    sendJSON(res, 200, { success: true, data: job, persistent: !process.env.VERCEL });
    return true;
  }

  if (pathname === '/api/automation/autopilot/stop' && method === 'POST') {
    const body = await readJsonBody(req);
    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    const job = autopilot.stop(groupId, subject.value, `Stopped by ${actor}.`);
    if (!job) {
      sendJSON(res, 404, { success: false, error: `Nothing is running for "${subject.value}".` });
      return true;
    }
    console.log(`[autopilot] ${actor} stopped "${subject.value}"`);
    // A batch already in flight finishes — it is mid-send to a public channel,
    // and abandoning it is how a question ends up posted but unrecorded.
    sendJSON(res, 200, {
      success: true,
      data: job,
      message: job.busy
        ? 'Stopped. The batch already sending will finish, and nothing new will start.'
        : 'Stopped.'
    });
    return true;
  }

  if (pathname === '/api/telegram/post' && method === 'POST') {
    const body = await readJsonBody(req);

    const subject = validateSubject(body.subject);
    if (!subject.ok) { sendJSON(res, 400, { success: false, error: subject.error }); return true; }

    // ---- Live progress ----------------------------------------------------
    // A batch runs for minutes — every question is a Telegram send plus a
    // sheet write, and Apps Script alone can take 10s a call. Answering once
    // at the end left the page showing "Posting…" with no way to tell a slow
    // run from a dead one. With `stream: true` the answer is NDJSON: one line
    // per step and per question, then a final "done" line carrying exactly
    // the payload the non-streaming answer has.
    const streaming = body.stream === true;
    let clientGone = false;
    const emit = (event) => {
      if (!streaming || res.writableEnded) return;
      try { res.write(JSON.stringify(event) + '\n'); } catch (err) { clientGone = true; }
    };
    if (streaming) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no'
      });
      // Stop pressed, tab closed, connection lost: nobody is watching any more,
      // so stop after the question in hand and put the rest back.
      res.on('close', () => { if (!res.writableEnded) clientGone = true; });
    }

    const outcome = await postBatch({
      db,
      groupId,
      subject: subject.value,
      count: body.count,
      requireApproved: body.requireApproved !== false,
      emit,
      stopping: () => clientGone
    });

    if (!streaming) { sendJSON(res, outcome.status, outcome.payload); return true; }
    emit(Object.assign({ type: 'done', status: outcome.status }, outcome.payload));
    res.end();
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);

  // Signed machine-to-machine deliveries are authenticated by their own
  // secrets, and a 429 to Razorpay or Telegram delays a payment or a reply.
  const rawPath = String(req.url || '').split('?')[0];
  // Every /api/cron/* route is one of these: each is refused without
  // CRON_SECRET, and a 429 to Vercel Cron does not become a retry — it
  // silently skips that run, so the sweep, the autopilot batch or the
  // deleted-poll check simply does not happen and nothing says why.
  const signedDelivery = rawPath === '/api/payments/webhook' ||
    rawPath.startsWith('/api/telegram/bot/') || rawPath === '/api/telegram/affiliate' ||
    rawPath.startsWith('/api/cron/');
  if (!signedDelivery && !checkRateLimit(clientAddress(req))) {
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
      // 401 when a NEW token would fix it — an expired session, a clock that
      // has drifted, a token from another project. 403 only when the identity
      // itself is refused, where signing in again changes nothing.
      //
      // Both used to answer 403, so a lapsed session reached the dashboard as
      // a permissions problem and told the curator to add themselves to
      // CURATOR_EMAILS when all they had to do was sign in again.
      const status = err.statusCode === 401 || err.authKind === 'reauth' ? 401 : 403;
      sendJSON(res, status, { success: false, error: err.message });
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
module.exports.clientAddress = clientAddress;
module.exports.handlePaymentEvent = handlePaymentEvent;
module.exports.syncBotMenus = syncBotMenus;
module.exports.sweepTrials = sweepTrials;
