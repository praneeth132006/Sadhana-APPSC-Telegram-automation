// ============================================================================
// src/botapp.js — the payment bot, as a function instead of a process
// ============================================================================
// One payment bot serves ONE family of groups. Which family is decided by the
// env var naming its token: TELEGRAM_PAYBOT_NEWS, TELEGRAM_PAYBOT_SADHANA or
// TELEGRAM_PAYBOT_UPSC. Everything the bot offers derives from that, so the
// UPSC bot cannot sell a newspaper pass or hand out a Telugu group's invite —
// not because it declines to, but because those groups are not in its list.
//
// This file used to BE bot.js: a script that built one bot at module load from
// process.env.PAYBOT_ENV and started polling. That meant three long-running
// laptop processes, started by hand, one per family. In practice one of them
// was running and the other two were not, so two of the three payment bots
// answered nobody — and the one that was running had been started before the
// prices changed, so it kept quoting the old ones from memory.
//
// As a factory it can be built once per family and driven two ways:
//   - polling, by bot.js, for local development
//   - webhook, by server.js, on the deployment, where there is no process to
//     forget to start and a price change takes effect when you deploy
//
// It never grants access itself. Tapping a button only produces a payment link;
// the door is opened by the webhook in server.js, and only after Razorpay's
// signature has been verified.
// ============================================================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const sheets = require('./sheets');
const membership = require('./membership');
const razorpay = require('./razorpay');
const groupRegistry = require('./groups');
const support = require('./support');
const pricing = require('./pricing');
const affiliates = require('./affiliates');
const affiliateStore = require('./affiliate-store');
const codeTracking = require('./code-tracking');
const affiliateNotify = require('./affiliate-notify');
const botCommands = require('./bot-commands');
// For buildQuizPost only: the taster posts a sample exactly as the group would.
const telegram = require('./telegram');

/**
 * createPaymentBot — builds one family's bot with all its handlers attached.
 *
 * @param {Object} options
 * @param {string} options.payBotEnv Env var naming this bot's token
 * @param {boolean} [options.polling] true for a long-running local process,
 *   false for webhook mode, where server.js feeds it updates
 * @returns {{payBotEnv: string, bot: Object, familyGroups: Function}}
 */
function createPaymentBot({ payBotEnv, polling = false }) {
  /** The groups this bot sells, in configuration order. */
  function familyGroups() {
  return groupRegistry.listGroups().filter((g) => g.paymentBotEnv === payBotEnv && g.ready);
  }

  /** A group, but only if this bot is allowed to sell it. */
  function familyGroup(groupId) {
  return familyGroups().find((g) => g.id === groupId) || null;
  }

  /** The passes a group sells, at that group's prices. */
  function plansFor(groupId) {
  return groupRegistry.plansFor(groupId);
  }

  /** One pass within one group. */
  function planFor(groupId, planId) {
  return groupRegistry.getPlanFor(groupId, planId);
  }

  /** That group's sheet. */
  function sheetFor(groupId) {
  return sheets.forGroup(groupId);
  }

  // Reported, never process.exit(). In webhook mode this runs inside the web
  // server, and exiting would take the dashboard down with it.
  const missing = [];
  if (!payBotEnv) {
    missing.push('payBotEnv (which payment bot this is, e.g. TELEGRAM_PAYBOT_UPSC)');
  } else if (!String(process.env[payBotEnv] || '').trim()) {
    missing.push(`${payBotEnv} (the bot token)`);
  } else if (!familyGroups().length) {
    missing.push(`no ready group has paymentBotEnv "${payBotEnv}" — check groups.config.json and .env`);
  }
  if (!razorpay.isConfigured()) missing.push('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET');
  if (missing.length) {
    throw new Error('Cannot start ' + (payBotEnv || 'this bot') + '. Missing:\n   ' + missing.join('\n   '));
  }

  // allowed_updates must be stated explicitly on every getUpdates call.
  // Telegram remembers the last list it was given for a bot and silently drops
  // every other update type — this bot's stored list was
  // ["message","channel_post","my_chat_member","chat_member"], with no
  // callback_query, so every tap on a plan button was discarded by Telegram
  // before it reached us: no request, no error, nothing to log. Passing the list
  // here means the set the bot needs is re-asserted on each poll rather than
  // inherited from whatever last touched the token.
  // chat_join_request is what makes a forwarded invite worthless: the link asks
  // to join rather than joining, and this bot decides who is let in. Leave it out
  // and every request sits unanswered forever, with paying students locked out.
  const ALLOWED_UPDATES = [
  'message', 'callback_query', 'my_chat_member', 'chat_member', 'chat_join_request'
  ];

  // polling for a laptop, webhook for the deployment. Same handlers either way,
  // so the two cannot drift.
  const bot = new TelegramBot(String(process.env[payBotEnv] || '').trim(),
    polling
      ? { polling: { params: { allowed_updates: JSON.stringify(ALLOWED_UPDATES) } } }
      : { polling: false });

  // src/paybot.js builds its own non-polling client from the same token for
  // invites, approvals and removals, so nothing here has to be handed around.

  /** Escapes text before putting it in an HTML-formatted message. */
  function esc(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------------------------------------------------------------------------
  // Support: shared state
  // ---------------------------------------------------------------------------

  /**
   * ABOUT_TEXT — what this bot is, in the words the admin gave.
   *
   * The same paragraph is set as the bot's Telegram description (the screen
   * shown before anyone presses Start) by `npm run bot-profile`, so the first
   * thing a stranger reads and the first thing /about says do not drift apart.
   */
  // From src/bot-commands.js, so /about and the Telegram description screen can
  // no longer drift apart. Escaped here because this one is sent as HTML.
  const ABOUT_TEXT = esc(botCommands.aboutFor(payBotEnv));

  /** The family's name, for the top of a greeting. */
  function botDisplayName() {
  const group = primaryGroup();
  return group ? group.label : 'APPSC Prep';
  }

  /**
   * Promo codes arrived on an influencer's link and not yet used, by Telegram id.
   *
   * A student taps the link, reads the welcome, then taps Continue — three
   * separate updates. The code has to survive that, and it is deliberately
   * only in memory: it is a convenience, not a record. If the process restarts
   * in between, the student can still type the code, and the influencer's
   * earning is only ever written from a payment that succeeded.
   */
  const pendingPromo = new Map();

  /** How long a code from a link waits to be used. */
  const PENDING_PROMO_MS = 24 * 60 * 60 * 1000;

  /** The code this student arrived with, if it has not gone stale. */
  function takePendingPromo(telegramId) {
  const held = pendingPromo.get(String(telegramId));
  if (!held) return '';
  if (Date.now() - held.at > PENDING_PROMO_MS) {
    pendingPromo.delete(String(telegramId));
    return '';
  }
  return held.code;
  }

  /**
   * ":CODE" for a button's callback data. The code from a link is held in
   * memory, and on the deployment the next tap can reach a different instance
   * that never saw the /start — so it also rides on every button between the
   * welcome and the price.
   */
  function codeSuffix(user) {
  const code = user ? takePendingPromo(user.id) : '';
  return code ? ':' + code : '';
  }

  /** Takes back a code that rode in on a button, unless one is already held. */
  function adoptCode(user, code) {
  const clean = pricing.normaliseCode(code);
  if (!user || !clean || !pricing.COUPON_CODE_PATTERN.test(clean)) return;
  if (!takePendingPromo(user.id)) pendingPromo.set(String(user.id), { code: clean, at: Date.now() });
  }

  /**
   * trackCode — notes how far a student got with a code, for the dashboard's
   * Code Tracking page. Behind the reply and never fatal: tracking must not
   * slow down or break a purchase.
   */
  function trackCode(event) {
  if (!codeTracking.isConfigured(payBotEnv)) return;
  keepAlive(codeTracking.safeRecord(payBotEnv, event));
  }

  /** Keyboard with a single button that opens the support menu. */
  const SUPPORT_BUTTON = { inline_keyboard: [[{ text: '🆘 Support', callback_data: 'sup:menu' }]] };

  /** How long /start waits for settings before greeting without the extra note. */
  const START_SETTINGS_WAIT_MS = 2500;

  /** How long a support flow waits for settings before using the defaults. */
  const SUPPORT_SETTINGS_WAIT_MS = 8000;

  /** How long /status and /cancel wait for one group's sheet. */
  const SUBSCRIPTION_READ_MS = 12000;

  /**
   * The family's first group. A bot's settings are read from, and its tickets
   * written to, this group's sheet, so a student in a two-group family never
   * has a ticket split across sheets.
   */
  function primaryGroup() {
  return familyGroups()[0];
  }

  const botId = support.botIdFromToken(process.env[payBotEnv]);

  // A refresh that runs behind an answer is handed to keepAlive, so settle()
  // waits for it and the deployment is not frozen half-way through the read.
  const settingsCache = support.createSettingsCache({
    load: () => sheetFor(primaryGroup().id).getBotSettings(),
    background: (work) => keepAlive(work)
  });

  /**
   * settingsNow — settings without waiting: what this instance already holds,
   * or the defaults while the first read runs behind the reply.
   *
   * For /start, /about, /help and /terms, which only use settings for an
   * optional line (the welcome note, the contact email). A Telegram ad
   * reviewer presses Start and counts the seconds; the welcome must not sit
   * behind a spreadsheet read to decide whether to add a sentence.
   */
  function settingsNow() {
    const held = settingsCache.peek();
    if (held) {
      keepAlive(settingsCache.get());
      return held;
    }
    keepAlive(settingsCache.refresh());
    return support.normaliseSettings({});
  }

  /** Settings, or the defaults if the sheet does not answer within `ms`. */
  async function settingsWithin(ms) {
  let timer;
  try {
    return await Promise.race([
      settingsCache.get(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(support.normaliseSettings({})), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
  }

  const allowTicket = support.createThrottle({ limit: 5, windowMs: 10 * 60 * 1000 });

  // Coupon codes are secrets worth guessing; without a limit a script could
  // try thousands through the bot.
  const allowCouponCheck = support.createThrottle({ limit: 8, windowMs: 10 * 60 * 1000 });

  // Every free-typed message looks the student's tickets up in the sheet. A
  // flood of messages must not become a flood of Apps Script calls.
  const allowFreeText = support.createThrottle({ limit: 20, windowMs: 10 * 60 * 1000 });

  /** A ticket untouched for longer than this is not joined by a new message. */
  const ACTIVE_TICKET_DAYS = 7;

  // ---------------------------------------------------------------------------
  // Menus
  // ---------------------------------------------------------------------------

  /**
   * groupKeyboard — one button per group this bot sells.
   *
   * Only shown when the family has more than one. A bot serving a single group
   * asking "which group?" is a question with one answer.
   */
  function groupKeyboard(user = null) {
  const suffix = codeSuffix(user);
  return {
    inline_keyboard: familyGroups().map((group) => ([{
      text: `${group.language === 'Telugu' ? '🇮🇳 తెలుగు (Telugu)' : '🔤 English'}`,
      callback_data: `pick:${group.id}${suffix}`
    }]))
  };
  }

  /** The "which language?" message. */
  function chooseGroupMessage() {
  return '<b>Which language do you prefer?</b>\n\n' +
    'Your questions, your group and your pass are all in the language you pick.';
  }

  /** The pass a group sells right now, with the admin's name, price and date applied. */
  async function passFor(groupId) {
  const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
  return pricing.currentPass(groupId, settings);
  }

  /**
   * passMessage — what the pass is, until when, and what it costs.
   *
   * @param {Object} group
   * @param {Object} pass From passFor
   * @param {Object|null} applied A coupon that evaluated ok, if any
   */
  function passMessage(group, pass, applied) {
  const lines = [
    `${esc(pass.emoji)} <b>${esc(pass.label)}</b>`,
    `for <b>${esc(group.shortName)}</b>`,
    '',
    esc(pass.description),
    ''
  ];
  if (pass.lifetime) {
    lines.push('♾️ <b>Lifetime access</b> — pay once, never renew');
  } else if (pass.validUntil) {
    lines.push(`📅 Valid until <b>${esc(pass.validUntil)}</b>`);
  }
  if (applied) {
    lines.push(applied.kind === 'promo'
      ? `🎁 Promo code <b>${esc(applied.code)}</b> applied — ${esc(applied.label)}`
      : `🎟 Coupon <b>${esc(applied.code)}</b> applied — ${esc(applied.label)}`);
    lines.push(
      `💰 Price: <s>${pricing.rupees(pass.amountPaise)}</s> <b>${pricing.rupees(applied.finalPaise)}</b> ` +
      `(you save ${pricing.rupees(applied.discountPaise)})`);
  } else {
    lines.push(`💰 Price: <b>${pricing.rupees(pass.amountPaise)}</b>`);
  }
  return lines.join('\n');
  }

  /**
   * passKeyboard — Pay, plus Apply or Remove coupon. The group, and the coupon
   * once applied, travel on the button, so a tap never depends on memory and
   * the code is checked again when it is used.
   */
  function passKeyboard(group, pass, applied) {
  const amount = applied ? applied.finalPaise : pass.amountPaise;
  // Promo codes and coupons never share a code (approving one checks the
  // coupons), so the code alone says which it is when the button comes back.
  return {
    inline_keyboard: [
      [{
        text: `💳 Pay ${pricing.rupees(amount)}`,
        callback_data: `buy:${group.id}:${pass.id}${applied ? ':' + applied.code : ''}`
      }],
      applied
        ? [{ text: applied.kind === 'promo' ? '✖️ Remove promo code' : '✖️ Remove coupon',
             callback_data: `plain:${group.id}` }]
        : [{ text: '🎟 Apply coupon or promo code', callback_data: `cpn:${group.id}` }]
    ]
  };
  }

  /** Sends one group's pass, optionally with a coupon applied. */
  async function sendPass(chatId, group, applied = null, user = null) {
  const pass = await passFor(group.id);
  if (!pass) {
    await bot.sendMessage(chatId, 'Nothing is on sale for this group right now. Please check back soon.');
    return;
  }

  // A code that came in on a share link is applied here, where the student
  // first sees a price — not silently at checkout, where a discount appearing
  // from nowhere is indistinguishable from a bug.
  let show = applied;
  let refused = '';
  if (!show && user) {
    const waiting = takePendingPromo(user.id);
    if (waiting) {
      const { result } = await checkCode(waiting, user, group, 'link');
      if (result.ok) show = result;
      else {
        refused = result.reason;
        // It cannot be used, so stop offering it on every screen.
        pendingPromo.delete(String(user.id));
      }
    }
  }

  await bot.sendMessage(chatId, passMessage(group, pass, show), {
    parse_mode: 'HTML',
    reply_markup: passKeyboard(group, pass, show)
  });

  // Said out loud rather than swallowed: someone who followed a friend's link
  // and is being charged full price deserves to know why.
  if (refused) {
    await bot.sendMessage(chatId,
      `🎁 The promo link you followed could not be used: ${esc(refused)}`,
      { parse_mode: 'HTML' });
  }
  }

  /**
   * offerGroups — the entry point for a student.
   *
   * With one group in the family this goes straight to that group's pass;
   * with two it asks first. Either way the student only ever sees groups this
   * bot is responsible for.
   */
  async function offerGroups(chatId, user = null, { taster = false } = {}) {
  const groups = familyGroups();

  if (groups.length === 1) {
    if (taster) await sendSample(chatId, groups[0], 0, user);
    else await sendPass(chatId, groups[0], null, user);
    return;
  }

  await bot.sendMessage(chatId, chooseGroupMessage(), {
    parse_mode: 'HTML',
    reply_markup: groupKeyboard(user)
  });
  }

  /** First line of the "type your coupon code" prompt. */
  function couponPromptLine(group) {
  return `🎟 Coupon code for ${group.shortName}`;
  }

  /** The group a reply to a coupon prompt is for, or null. */
  function parseCouponPrompt(text) {
  const match = String(text || '').match(/^🎟 Coupon code for (.+)/);
  if (!match) return null;
  return familyGroups().find((g) => g.shortName === match[1].trim()) || null;
  }

  /**
   * checkCoupon — looks a code up and evaluates it against the current price.
   *
   * @returns {Promise<{pass: Object|null, result: Object}>}
   */
  async function checkCoupon(code, telegramId, group) {
  const pass = await passFor(group.id);
  if (!pass) return { pass: null, result: { ok: false, reason: 'Nothing is on sale for this group right now.' } };
  let coupon;
  try {
    coupon = await sheetFor(primaryGroup().id).getCoupon(pricing.normaliseCode(code), String(telegramId));
  } catch (err) {
    console.error(`[bot] ${payBotEnv}: could not look up coupon ${code} — ${err.message}`);
    return {
      pass,
      result: {
        ok: false,
        reason: 'Coupon codes cannot be checked right now. Please try again in a few minutes, or pay the full price.'
      }
    };
  }
  return { pass, result: pricing.evaluateCoupon(coupon, { amountPaise: pass.amountPaise }), known: Boolean(coupon) };
  }

  /** Buttons after a coupon was refused. */
  function couponRetryKeyboard(group) {
  return {
    inline_keyboard: [
      [{ text: '🎟 Try another code', callback_data: `cpn:${group.id}` }],
      [{ text: '💳 Continue at full price', callback_data: `plain:${group.id}` }]
    ]
  };
  }

  /** A student's reply to the coupon prompt. */
  async function applyCoupon(msg, group) {
  const code = pricing.normaliseCode(msg.text);
  if (!pricing.COUPON_CODE_PATTERN.test(code)) {
    await bot.sendMessage(msg.chat.id,
      '❌ That does not look like a coupon or promo code. Codes are letters and numbers without spaces.',
      { reply_markup: couponRetryKeyboard(group) });
    return;
  }
  const { pass, result } = await checkCode(code, msg.from, group, 'typed');
  if (!result.ok) {
    await bot.sendMessage(msg.chat.id, `❌ <b>${esc(code)}</b>: ${esc(result.reason)}`,
      { parse_mode: 'HTML', reply_markup: couponRetryKeyboard(group) });
    return;
  }
  await bot.sendMessage(msg.chat.id, passMessage(group, pass, result), {
    parse_mode: 'HTML',
    reply_markup: passKeyboard(group, pass, result)
  });
  }

  // ---------------------------------------------------------------------------
  // Promo codes (influencers)
  // ---------------------------------------------------------------------------
  // An influencer's code, approved on the dashboard with its own discount and
  // commission, is typed in the same box as a coupon. It is looked up first;
  // a code that is not an influencer's goes on to the coupons.
  //
  // A code belongs to one exam — one payment bot. The UPSC influencer's code
  // is refused here unless this is the UPSC bot (affiliates.evaluatePromo).

  /**
   * checkPromo — the influencer code, evaluated for this student, or null when
   * the code is not an influencer's (so the caller tries the coupons).
   */
  async function checkPromo(code, user, pass) {
  if (!affiliateStore.isConfigured()) return null;
  const row = await affiliateStore.getCode(code);
  if (!row) return null;
  const usage = await affiliateStore.usageOf(row.code, user.id);
  return affiliates.evaluatePromo(row, {
    payBotEnv, amountPaise: pass.amountPaise, studentId: user.id,
    uses: usage.uses, usesByStudent: usage.usesByStudent
  });
  }

  /**
   * checkCode — whatever the student typed: an influencer's promo code, or a
   * coupon. Guessing codes is guessing at discounts, so both share one limit.
   *
   * @returns {Promise<{pass: Object|null, result: Object}>}
   */
  async function lookUpCode(code, user, group) {
  const pass = await passFor(group.id);
  if (!pass) return { pass: null, result: { ok: false, reason: 'Nothing is on sale for this group right now.' } };
  if (!allowCouponCheck(String(user.id))) {
    return {
      pass,
      result: { ok: false, reason: 'Too many code attempts. Please wait a few minutes before trying another code.' }
    };
  }
  const clean = pricing.normaliseCode(code);
  try {
    const promo = await checkPromo(clean, user, pass);
    if (promo) return { pass, result: promo, kind: 'promo', known: true };
  } catch (err) {
    console.error(`[bot] ${payBotEnv}: could not look up promo code ${clean} — ${err.message}`);
    return {
      pass,
      result: { ok: false, reason: 'Codes cannot be checked right now. Please try again in a few minutes, or pay the full price.' }
    };
  }
  return Object.assign({ kind: 'coupon' }, await checkCoupon(clean, user.id, group));
  }

  /**
   * checkCode — lookUpCode, and when the student brought the code themselves
   * (`source`: link or typed), a note of whether it worked. A code that does
   * not exist is not tracked: a typo is not a campaign.
   */
  async function checkCode(code, user, group, source = '') {
  const found = await lookUpCode(code, user, group);
  if (source && found.known) {
    trackCode({
      type: found.result.ok ? 'applied' : 'refused',
      code: pricing.normaliseCode(code), kind: found.kind, student: user, group: group.shortName,
      source, reason: found.result.ok ? '' : found.result.reason
    });
  }
  return found;
  }

  /**
   * findSubscription — where does this person hold a pass, within this family?
   *
   * Each group keeps its own sheet, so this asks each in turn. A student may
   * hold English and not Telugu, and the answer has to say which.
   *
   * @param {string|number} telegramId
   * @returns {Promise<Array<{group: Object, subscriber: Object}>>}
   */
  async function findSubscriptions(telegramId) {
  // In parallel and bounded: a sheet takes 2–4 s to answer and can take 45 s
  // to time out, and the webhook only waits 20 s for a reply. Read one group
  // after another and a student in a two-group family can get no answer at all.
  let incomplete = false;
  const reads = await Promise.all(familyGroups().map(async (group) => {
    const failed = Symbol('failed');
    const subscriber = await within(
      Promise.resolve().then(() => sheetFor(group.id).getSubscriber(telegramId)).catch((err) => {
        console.error(`[bot] could not read ${group.id}: ${err.message}`);
        return failed;
      }),
      SUBSCRIPTION_READ_MS,
      failed
    );
    if (subscriber === failed) {
      incomplete = true;
      return null;
    }
    return subscriber ? { group, subscriber } : null;
  }));
  const found = reads.filter(Boolean);
  // "You have no pass" said to a member because their sheet was slow is worse
  // than "try again", so callers can tell an empty answer from a failed one.
  found.incomplete = incomplete;
  return found;
  }

  // --------------------------------------------------------------------
  // Keeping handler work alive on the deployment
  // --------------------------------------------------------------------
  // processUpdate() dispatches to the handlers below synchronously and throws
  // their promises away — nothing anywhere holds a reference to the work. A
  // long-lived `node bot.js` does not care: the process stays up and the reply
  // goes out whenever it is ready.
  //
  // On Vercel it is fatal. server.js answered Telegram 200 and returned, the
  // instance was frozen mid-flight, and the outbound call to Telegram died with
  // "Client network socket disconnected before secure TLS connection was
  // established" — unhandled rejection, exit 128, and a bot that answers
  // nothing while Telegram reports a clean delivery.
  //
  // Intercepting on()/onText() here means every handler registered below is
  // tracked without each one having to remember to opt in.
  const pending = new Set();

  /** Work started behind a reply (a settings refresh) that settle() must still wait for. */
  function keepAlive(promise) {
    const work = Promise.resolve(promise).catch(() => {});
    pending.add(work);
    work.finally(() => pending.delete(work));
    return work;
  }

  function track(handler) {
    if (typeof handler !== 'function') return handler;
    return function trackedHandler(...args) {
      const work = Promise.resolve()
        .then(() => handler.apply(this, args))
        .catch((err) => {
          // Swallow here so one failing handler cannot become the unhandled
          // rejection that kills the whole instance mid-reply.
          console.error(`[bot] ${payBotEnv} handler failed: ${err && err.message}`);
        });
      pending.add(work);
      work.finally(() => pending.delete(work));
      return work;
    };
  }

  const registerOn = bot.on.bind(bot);
  const registerOnText = bot.onText.bind(bot);
  bot.on = (event, handler) => registerOn(event, track(handler));
  bot.onText = (regexp, handler) => registerOnText(regexp, track(handler));

  /**
   * Resolve once no handler work is outstanding. Loops rather than awaiting the
   * set once, because a handler can start more work — send a reply, then write
   * to the sheet — while we are already waiting on it.
   *
   * @returns {Promise<void>}
   */
  async function settle() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  /**
   * studentCommand — registers a student command that only answers in a
   * private chat with the bot.
   *
   * The bot is an admin of every paid group and of the support chat, so it
   * sees commands typed there too. Answering them would post a member's pass
   * and invite button for the whole group to see (/status), or act on their
   * subscription in public (/cancel).
   */
  //
  // Every command registered here is also remembered by name, so the catch-all
  // message handler can tell "a command we answer" from "a command we do not"
  // and reply to the second kind instead of staying silent. Telegram's ad
  // review sends commands to the bot and rejects it when any of them goes
  // unanswered ("Bots must respond to commands properly").
  const studentCommandNames = new Set(['support']);

  function studentCommand(name, handler) {
    studentCommandNames.add(name);
    // Case-insensitive, and the command must end at a space or the end of the
    // text — the same boundary commandName() uses — so /Plans works and
    // /plansfoo falls through to the "unknown command" reply.
    const pattern = new RegExp(`^\\/${name}(?:@\\w+)?(?=\\s|$)(?:\\s+(\\S+))?`, 'i');
    bot.onText(pattern, async (msg, match) => {
      if (!msg || !msg.chat || msg.chat.type !== 'private') return;
      showTyping(msg.chat.id);
      try {
        await handler(msg, match);
      } catch (err) {
        // A handler that throws used to be logged and nothing else — the
        // student saw a command that did nothing. Say something instead.
        console.error(`[bot] ${payBotEnv} /${name} failed: ${err && err.message}`);
        await apologise(msg.chat.id);
      }
    });
  }

  /**
   * "typing…" at the top of the chat while a command works. The sheet takes a
   * few seconds to answer, and a bot that shows nothing for those seconds looks
   * like one that is not going to answer. Never awaited, never fatal.
   */
  function showTyping(chatId) {
    Promise.resolve()
      .then(() => bot.sendChatAction(chatId, 'typing'))
      .catch(() => {});
  }

  /** The reply when something broke half-way through a command. */
  async function apologise(chatId) {
    try {
      await bot.sendMessage(chatId,
        '⚠️ Something went wrong on our side. Please try again in a moment, or tap below to reach us.',
        { reply_markup: SUPPORT_BUTTON });
    } catch (err) {
      console.error(`[bot] ${payBotEnv}: could not even apologise — ${err.message}`);
    }
  }

  /**
   * The command a message starts with, lower-cased, or '' when the text is not
   * a well-formed command ("/", "/ hi", "/plans,").
   */
  function commandName(text) {
    const match = String(text || '').match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?=\s|$)/);
    return match ? match[1].toLowerCase() : '';
  }

  /** The command list, as one block of text for replies that point people to it. */
  function commandListText() {
    return botCommands.STUDENT_COMMANDS
      .map(({ command, description }) => `/${command} — ${esc(description.charAt(0).toLowerCase() + description.slice(1))}`)
      .join('\n');
  }

  studentCommand('start', async (msg, match) => {
  const name = msg.from.first_name || 'there';

  // An influencer's link arrives as "/start promo_CODE". Remembering it here,
  // before anything else, is what makes the link do its job: the student never
  // has to type the code, and the discount is already on the pass when they
  // see it. Whether it is valid for this bot is decided there, not here.
  const promo = affiliates.codeFromStartPayload(match && match[1]);
  if (promo) {
    pendingPromo.set(String(msg.from.id), { code: promo, at: Date.now() });
    // Who clicked the code's link — an ad's or an influencer's — for the
    // Code Tracking page. Behind the reply, like the open below.
    trackCode({ type: 'clicked', code: promo, student: msg.from, source: 'link' });
    // Who opened the influencer's link, for the Influencers page. Behind the
    // reply, never before it: the welcome must not wait on a spreadsheet.
    if (affiliateStore.isConfigured()) {
      keepAlive(Promise.resolve().then(() => affiliateStore.recordLinkOpen(promo, msg.from)).catch((err) =>
        console.error(`[bot] ${payBotEnv}: could not record a link open for ${promo} — ${err.message}`)));
    }
  }

  // Bounded: a slow sheet must never hold up the greeting.
  const settings = settingsNow();
  const note = settings.welcome_note ? `${esc(settings.welcome_note)}\n\n` : '';

  await bot.sendMessage(msg.chat.id,
    `<b>Welcome to ${esc(botDisplayName())}</b> 👋\n\n` +
    `Hello ${esc(name)}! ` + ABOUT_TEXT + '\n\n' +
    note +
    (promo ? `🎁 Promo code <b>${esc(promo)}</b> will be applied on the next screen.\n\n` : '') +
    'Tap <b>Continue</b> below 👇 to see the pass.',
    {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'Continue ⬇️', callback_data: `go:plans${promo ? ':' + promo : ''}` }]] }
    }
  );
  });

  studentCommand('about', async (msg) => {
  const aboutSettings = settingsNow();
  await bot.sendMessage(msg.chat.id,
    `<b>About ${esc(botDisplayName())}</b>\n\n` + ABOUT_TEXT + '\n\n' +
    'Commands:\n' + commandListText() +
    (aboutSettings && support.emailFallbackLine(aboutSettings)
      ? '\n\n' + support.emailFallbackLine(aboutSettings) : ''),
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Continue ⬇️', callback_data: 'go:plans' }]] } }
  );
  });

  studentCommand('plans', async (msg) => {
  await offerGroups(msg.chat.id, msg.from);
  });

  studentCommand('status', async (msg) => {
  try {
    const held = await findSubscriptions(msg.from.id);
    if (!held.length && held.incomplete) throw new Error('a member sheet did not answer');

    if (!held.length) {
      await bot.sendMessage(msg.chat.id,
        'You do not have a pass yet.\n\nSend /plans to see the options.',
        { parse_mode: 'HTML' });
      await offerGroups(msg.chat.id, msg.from);
      return;
    }

    // Reported per group, because a student can hold English and not Telugu,
    // and "you are active" without saying where is not an answer.
    for (const { group, subscriber } of held) {
      const options = { parse_mode: 'HTML' };
      if (subscriber.status === 'active' && subscriber.invite_link) {
        options.reply_markup = {
          inline_keyboard: [[{ text: `🔗 Open ${group.shortName}`, url: subscriber.invite_link }]]
        };
      }
      // A recurring pass is the one status where the member has an ongoing
      // obligation, so the way out belongs in the same message as the status.
      const recurring = subscriber.subscription_id && subscriber.status === 'active'
        ? '\n\n🔁 This renews automatically. Send /cancel to stop future charges — ' +
          'you keep access until the date above.'
        : '';

      await bot.sendMessage(msg.chat.id,
        `<b>${esc(group.shortName)}</b>\n` + membership.describeStatus(subscriber) + recurring,
        options);
    }
  } catch (err) {
    console.error('[bot] /status failed:', err.message);
    await bot.sendMessage(msg.chat.id, '⚠️ Could not read your status right now. Please try again shortly.',
      { reply_markup: SUPPORT_BUTTON });
  }
  });

  // What an influencer sees: the programme, in the payment bot their audience
  // is already in. The earning shown is the admin's figure from the dashboard;
  // what any one influencer actually earns is set per code when approved.
  studentCommand('affiliate', async (msg) => { await sendAffiliateCard(msg.chat.id); });

  // The same thing under the name people guess.
  studentCommand('earn', async (msg) => { await sendAffiliateCard(msg.chat.id); });

  /** The influencer programme, as a student's audience-owner sees it. */
  async function sendAffiliateCard(chatId) {
  const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
  const upto = pricing.rupees((Number(settings.affiliate_earn_upto) || 50) * 100);
  const email = String(settings.support_email || '').trim();
  const username = await affiliateBotUsername();
  await bot.sendMessage(chatId,
    '🤝 <b>Earn with us</b>\n\n' +
    'Have a channel, a page or a batch of students? Share our prep groups and earn on every ' +
    `student who joins with your own promo code — <b>up to ${esc(upto)} for each successful referral</b>.\n\n` +
    'Your followers get a discount with your code, and you can withdraw your earnings by UPI or bank transfer.\n\n' +
    (username ? 'Tap below for the details and to apply.' : 'Applications open shortly — please check back.') +
    (email ? `\n\nAny questions? Email us at <b>${esc(email)}</b>.` : ''),
    {
      parse_mode: 'HTML',
      reply_markup: username
        ? { inline_keyboard: [[{ text: '🤝 Open the influencer bot', url: `https://t.me/${username}` }]] }
        : undefined
    });
  }

  studentCommand('help', async (msg) => {
  const many = familyGroups().length > 1;
  const helpSettings = settingsNow();
  const steps = [
    many ? 'Send /plans and choose your group.' : 'Send /plans to see the pass.',
    'Got a coupon or an influencer\'s promo code? Tap <b>🎟 Apply coupon or promo code</b> and type it — the new price is shown before you pay.',
    'Pay on the secure Razorpay page that opens.',
    'This bot sends you a private invite link. Tap it and you are let in automatically.'
  ];
  await bot.sendMessage(msg.chat.id,
    '<b>How it works</b>\n\n' +
    steps.map((step, i) => `${i + 1}. ${step}`).join('\n') + '\n\n' +
    (many ? '<i>Your pass is for the group you chose. The invite will not let you ' +
            'into the other one, and forwarding it will not let anyone else in.</i>\n\n'
          : '<i>The invite is tied to your account — forwarding it will not let ' +
            'anyone else in.</i>\n\n') +
    (familyGroups().some((g) => { const p = pricing.currentPass(g.id, {}); return p && p.lifetime; })
      ? 'Your pass is for life — you pay once and never renew. Check /status any time.\n\n'
      : 'You will get a reminder before your pass ends. Check /status any time.\n\n') +
    'Trouble? Send /support, or just type your question here.' +
    (helpSettings && support.emailFallbackLine(helpSettings)
      ? '\n\n' + support.emailFallbackLine(helpSettings) : ''),
    { parse_mode: 'HTML', reply_markup: SUPPORT_BUTTON }
  );
  });

  studentCommand('cancel', async (msg) => {
  try {
    const held = await findSubscriptions(msg.from.id);
    const renewing = held.filter(({ subscriber }) => subscriber.subscription_id);

    if (!renewing.length) {
      await bot.sendMessage(msg.chat.id,
        'You do not have an auto-renewing subscription, so there is nothing to cancel.\n\n' +
        'One-time passes simply end on their expiry date.');
      return;
    }

    for (const { group, subscriber } of renewing) {
      // Cancel at cycle end: they keep what they already paid for.
      await razorpay.cancelSubscription(subscriber.subscription_id, true);
      await sheetFor(group.id).upsertSubscriber({
        telegram_id: String(msg.from.id),
        status: 'cancelled',
        notes: `Cancelled by user on ${membership.formatIst(new Date())}`,
        is_payment: false
      }, 'subscription.cancelled');

      await bot.sendMessage(msg.chat.id,
        `✅ Auto-renewal cancelled for <b>${esc(group.shortName)}</b>.\n\n` +
        `You keep access until <b>${esc(subscriber.expiry_date)}</b> — you paid for it.\n\n` +
        'Send /plans if you want to come back later.',
        { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('[bot] /cancel failed:', err.message);
    await bot.sendMessage(msg.chat.id, '⚠️ Could not cancel automatically. Tap below to reach an admin.',
      { reply_markup: SUPPORT_BUTTON });
  }
  });

  // /settings and /terms are two of the commands Telegram asks every bot to
  // answer (with /start and /help), and the first ones an ad reviewer tries
  // after the menu. Neither is on the list of things this bot was built for,
  // so both used to get silence.
  studentCommand('settings', async (msg) => {
  await bot.sendMessage(msg.chat.id,
    '<b>Settings</b>\n\n' +
    'There is nothing to set up — your pass is linked to this Telegram account ' +
    'automatically when you pay.\n\n' +
    '/status — see your pass and your invite link\n' +
    '/plans — see the pass and join\n' +
    '/support — anything else',
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Continue ⬇️', callback_data: 'go:plans' }],
          [{ text: '🆘 Support', callback_data: 'sup:menu' }]
        ]
      }
    });
  });

  studentCommand('terms', async (msg) => {
  const settings = await settingsWithin(START_SETTINGS_WAIT_MS);
  const passes = familyGroups()
    .map((group) => ({ group, pass: pricing.currentPass(group.id, settings) }))
    .filter(({ pass }) => pass);
  const validity = passes.map(({ group, pass }) =>
    `• <b>${esc(group.shortName)}</b> — ${esc(pass.label)}, ` +
    (pass.lifetime ? 'valid for life' : pass.validUntil ? `valid until ${esc(pass.validUntil)}` : 'valid for the period shown before you pay')
  ).join('\n');
  await bot.sendMessage(msg.chat.id,
    '<b>Terms</b>\n\n' +
    (validity ? validity + '\n\n' : '') +
    '1. The price and how long the pass lasts are shown before you pay. You pay once; nothing renews on its own.\n' +
    '2. <b>All payments are final. There are no refunds</b>, including for a pass you stop using.\n' +
    '3. Payment is taken on Razorpay\'s secure page. This bot never sees your card or UPI details.\n' +
    '4. After payment the bot sends a private invite link for the group you chose. It works only for your ' +
    'Telegram account and cannot be shared.\n' +
    '5. When a dated pass ends you are removed from the group, with a reminder beforehand.\n' +
    '6. If you paid and did not get your invite link, send /support with your Razorpay payment id ' +
    '(it starts with pay_) and we will get you in.' +
    (support.emailFallbackLine(settings) ? '\n\n' + support.emailFallbackLine(settings) : ''),
    { parse_mode: 'HTML', reply_markup: SUPPORT_BUTTON });
  });

  // ---------------------------------------------------------------------------
  // The taster: real questions before the price
  // ---------------------------------------------------------------------------
  // Telegram refused the ad while the bot asked for money on its first screen.
  // A newcomer now answers a few real questions from the sheet — the actual
  // product — and only then sees what it costs.

  /** Questions already fetched for a group, so a second visitor waits for nothing. */
  const sampleCache = new Map();
  const SAMPLE_CACHE_MS = 10 * 60 * 1000;

  /**
   * samplesFor — the same few complete questions from this group's sheet,
   * every time, for every student.
   *
   * Fixed on purpose: the taster is the bot's shop window, and it used to be
   * a different three on every /start (subjects shuffled, newest questions
   * first, chosen per server). Worse, Next could land on another server that
   * had chosen a different set, so a student could see a question twice or
   * skip one. Now the choice is a pure function of the sheet:
   *
   *   - subjects in the Config tab's order;
   *   - from each, its OLDEST complete question — so posting new questions
   *     every day never changes it;
   *   - one per subject, taking from the next subject for variety, and going
   *     round again only if there are fewer subjects than questions wanted.
   *
   * An empty or unreadable subject is skipped. Never throws: no samples means
   * the pass is shown straight away.
   */
  async function samplesFor(group, wanted) {
  const held = sampleCache.get(group.id);
  if (held && Date.now() - held.at < SAMPLE_CACHE_MS && held.questions.length >= wanted) {
    return held.questions.slice(0, wanted);
  }

  const sheet = sheetFor(group.id);
  let subjects = [];
  try {
    subjects = (await sheet.readConfig()).map((row) => row.subject).filter(Boolean);
  } catch (err) {
    console.error(`[bot] ${payBotEnv}: could not read subjects for samples — ${err.message}`);
    return [];
  }

  // Candidates per subject, in Config order, until there are enough subjects.
  const perSubject = [];
  for (const subject of subjects) {
    if (perSubject.length >= wanted) break;
    try {
      const questions = await sheet.sampleQuestions(subject, wanted);
      if (questions && questions.length) perSubject.push(questions);
    } catch (err) {
      // A subject tab that will not read is not worth failing the welcome over.
    }
  }

  // Round-robin: the first of each subject, then the second of each, …
  const out = [];
  const seen = new Set();
  for (let round = 0; out.length < wanted && perSubject.some((qs) => qs.length > round); round++) {
    for (const questions of perSubject) {
      const q = questions[round];
      if (!q || out.length >= wanted) continue;
      const key = q.question_id || `${q.subject}|${q.question_text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(q);
    }
  }
  sampleCache.set(group.id, { at: Date.now(), questions: out });
  return out;
  }

  /** One sample as the quiz poll the group itself would post. */
  async function sendQuestionPoll(chatId, question) {
  const post = telegram.buildQuizPost(question);
  const correct = { A: 0, B: 1, C: 2, D: 3 }[String(question.correct_answer || '').toUpperCase()] || 0;
  const explanation = String(question.explanation || '').slice(0, 195);
  if (post.leadMessage) await bot.sendMessage(chatId, post.leadMessage, { parse_mode: 'HTML' });
  await bot.sendPoll(chatId, post.pollQuestion, post.options, Object.assign({
    type: 'quiz',
    correct_option_id: correct,
    is_anonymous: false
  }, explanation ? { explanation: esc(explanation), explanation_parse_mode: 'HTML' } : {}));
  }

  /**
   * sendSample — question number `index`, then either a Next button or, after
   * the last one, the invitation to join and the pass.
   */
  async function sendSample(chatId, group, index, user) {
  // Waited for, unlike /start: the pass that follows reads them anyway, and
  // how many questions to show is the admin's decision, not a guess.
  const wanted = support.sampleCount(await settingsWithin(SUPPORT_SETTINGS_WAIT_MS));
  const questions = wanted > 0 ? await samplesFor(group, wanted) : [];
  const total = Math.min(wanted, questions.length);
  if (!total || index >= total) {
    await sendPass(chatId, group, null, user);
    return;
  }

  try {
    await sendQuestionPoll(chatId, questions[index]);
  } catch (err) {
    // A poll Telegram will not take (a malformed row) must not strand anyone.
    console.error(`[bot] ${payBotEnv}: could not send a sample question — ${err.message}`);
    await sendPass(chatId, group, null, user);
    return;
  }

  if (index + 1 < total) {
    await bot.sendMessage(chatId,
      `<i>Question ${index + 1} of ${total}. Tap below for the next one.</i>`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Next →', callback_data: `smp:${group.id}:${index + 1}${codeSuffix(user)}` }]] } });
    return;
  }

  await bot.sendMessage(chatId,
    `🎓 <b>That was ${total} of the questions we post every day.</b>\n\n` +
    `For subject-wise questions like these — every day, with answers and explanations — ` +
    `join <b>${esc(group.shortName)}</b>.`,
    { parse_mode: 'HTML' });
  await sendPass(chatId, group, null, user);
  }

  // ---------------------------------------------------------------------------
  // Buying a pass
  // ---------------------------------------------------------------------------

  bot.on('callback_query', async (query) => {
  const data = String(query.data || '');
  const user = query.from;
  // "typing…" while the next screen is worked out: Continue reads the price,
  // Pay asks Razorpay for a link. Private chats only — never in a group.
  if (query.message && query.message.chat && query.message.chat.type === 'private') showTyping(user.id);

  // Acknowledging must not be able to kill the handler. A callback from a
  // message sent by an earlier bot process is "too old" by the time it
  // arrives, and answerCallbackQuery throws — which once left students
  // tapping a dead button with nothing logged and nothing sent.
  const ack = async (text) => {
    try {
      await bot.answerCallbackQuery(query.id, text ? { text } : undefined);
    } catch (err) {
      console.error('[bot] could not acknowledge the tap (stale button?):', err.message);
    }
  };

  // ---- the welcome's Continue button --------------------------------------
  if (data === 'go:plans' || data.startsWith('go:plans:')) {
    adoptCode(user, data.slice('go:plans:'.length));
    await ack();
    // Continue from the welcome: language, then the questions, then the price.
    await offerGroups(user.id, user, { taster: true });
    return;
  }

  // ---- buttons left on old messages from the ended referral programme ----
  if (data.startsWith('ref:')) {
    await ack('Member referrals have ended. Influencer promo codes work at checkout.');
    return;
  }

  // ---- picking a group ----------------------------------------------------
  // Two buttons, because they mean opposite things and sharing one callback
  // made a promo code impossible to use in a two-group family: choosing a group
  // went through the same handler as "remove what is applied", so the code the
  // student arrived with was dropped the moment they picked English or Telugu.
  //
  //   pick:<groupId>   — I choose this group (anything applied still applies)
  //   plain:<groupId>  — show me this group's plain price
  if (data.startsWith('pick:') || data.startsWith('plain:')) {
    const plain = data.startsWith('plain:');
    const [, groupId, carried] = data.split(':');
    const group = familyGroup(groupId);
    if (!plain) adoptCode(user, carried);
    if (!group) {
      await ack('That group is not available here.');
      return;
    }
    await ack();
    // Picking a language starts the taster; "remove the code" goes straight
    // back to the price, because they have already seen the questions.
    if (plain) await sendPass(user.id, group, null, null);
    else await sendSample(user.id, group, 0, user);
    return;
  }

  // ---- the taster ---------------------------------------------------------
  if (data.startsWith('smp:')) {
    const [, groupId, index, carried] = data.split(':');
    const group = familyGroup(groupId);
    if (!group) {
      await ack('That group is not available here.');
      return;
    }
    adoptCode(user, carried);
    await ack();
    await sendSample(user.id, group, Number(index) || 0, user);
    return;
  }

  // ---- the free preview (no longer offered) -------------------------------
  // Old pass messages may still carry the button; say so rather than ignore it.
  if (data.startsWith('trial:')) {
    await ack();
    await bot.sendMessage(user.id, 'The free preview is no longer offered. Send /plans to join.');
    return;
  }

  // ---- asking for a coupon code -------------------------------------------
  if (data.startsWith('cpn:')) {
    const group = familyGroup(data.slice(4));
    if (!group) {
      await ack('That group is not available here.');
      return;
    }
    await ack();
    await bot.sendMessage(user.id,
      `${esc(couponPromptLine(group))}\n\nType your coupon or promo code and send it as a reply to this message.`,
      {
        parse_mode: 'HTML',
        reply_markup: { force_reply: true, input_field_placeholder: 'Coupon code' }
      });
    return;
  }

  if (data.startsWith('sup:')) {
    await handleSupportCallback(query, data, ack);
    return;
  }

  if (data.startsWith('adm:')) {
    await handleAdminCallback(query, data, ack);
    return;
  }

  if (data.startsWith('sum:')) {
    await handleSummaryCallback(query, data, ack);
    return;
  }

  if (!data.startsWith('buy:')) {
    await ack();
    return;
  }

  // ---- buying the pass ----------------------------------------------------
  // buy:<groupId>:<planId>[:<couponCode>] — everything is carried on the
  // button, so a tap on yesterday's message still buys the group it offered.
  // The price is never taken from the button: it is worked out again now, and
  // a coupon is checked again, so a stale button cannot buy at a stale price.
  const [, groupId, planId, code] = data.split(':');

  const group = familyGroup(groupId);
  if (!group) {
    // Either a stale button from another bot, or a group this bot does not
    // sell. Refusing is the whole point of one bot per family.
    await ack('That group is not available from this bot.');
    return;
  }

  const pass = await passFor(groupId);
  if (!pass || planId !== pass.id) {
    await ack('That pass is no longer on sale.');
    if (pass) {
      await bot.sendMessage(user.id, 'That pass is no longer sold. Here is what is available now:');
      await sendPass(user.id, group);
    }
    return;
  }

  // The code is re-checked here, never trusted from the button: a tap on
  // yesterday's message must not buy at yesterday's price, and a code must
  // not still apply once it has been paused or used up.
  let applied = null;
  if (code) {
    const { result } = await checkCode(code, user, group);

    if (!result.ok) {
      await ack('That code cannot be used.');
      await bot.sendMessage(user.id,
        `❌ <b>${esc(pricing.normaliseCode(code))}</b>: ` + esc(result.reason),
        { parse_mode: 'HTML', reply_markup: couponRetryKeyboard(group) });
      return;
    }
    applied = result;
  }

  await ack('Creating your payment link…');

  try {
    // Buying the same fixed-date pass twice buys nothing: say so instead.
    const existing = await sheetFor(groupId).getSubscriber(user.id);

    // Paying twice for a pass that never ends buys nothing at all.
    if (existing && existing.status === 'active' && membership.isLifetimeSubscriber(existing)) {
      await bot.sendMessage(user.id,
        `✅ You already have <b>lifetime access</b> to <b>${esc(group.shortName)}</b>, so there is ` +
        'nothing to buy — you paid once and that was it.\n\nSend /status for your invite button.',
        { parse_mode: 'HTML' });
      return;
    }

    if (existing && existing.status === 'active' && !pass.lifetime) {
      const heldUntil = membership.parseIst(existing.expiry_date);
      const newUntil = pricing.endOfDayIst(pass.validUntil);
      // Stored expiries have whole seconds; the pass date ends at .999.
      if (heldUntil && newUntil && heldUntil.getTime() >= newUntil.getTime() - 1000) {
        await bot.sendMessage(user.id,
          `✅ You already have <b>${esc(existing.plan_label || pass.label)}</b> for ` +
          `<b>${esc(group.shortName)}</b> until <b>${esc(existing.expiry_date)}</b>, so there is nothing to buy.\n\n` +
          'Send /status for your invite button.',
          { parse_mode: 'HTML' });
        return;
      }
    }

    const checkout = await createCheckout(group, pass, user, applied);
    if (applied) {
      trackCode({
        type: 'link_created', code: applied.code, kind: applied.kind === 'promo' ? 'promo' : 'coupon',
        student: user, group: group.shortName, amountPaise: applied.finalPaise, linkId: checkout.linkId
      });
    }
    const amount = applied ? applied.finalPaise : pass.amountPaise;

    await bot.sendMessage(user.id,
      `${esc(pass.emoji)} <b>${esc(pass.label)}</b>\n` +
      `for <b>${esc(group.shortName)}</b>\n\n` +
      (pass.lifetime
        ? '♾️ <b>Lifetime access</b> — this is the only payment\n'
        : (pass.validUntil ? `📅 Valid until <b>${esc(pass.validUntil)}</b>\n` : '')) +
      `💰 You pay <b>${pricing.rupees(amount)}</b>` +
      (applied ? ` (${applied.kind === 'promo' ? 'promo code' : 'coupon'} ${esc(applied.code)}, ` +
        `you save ${pricing.rupees(applied.discountPaise)})` : '') +
      '\n\nTap below to pay. Your private invite arrives here the moment payment clears. ' +
      'The link is valid for 24 hours.' +
      (razorpay.isTestMode() ? '\n\n⚠️ <i>Test mode — use a Razorpay test card.</i>' : ''),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: `💳 Pay ${pricing.rupees(amount)}`, url: checkout.url }]]
        }
      });
  } catch (err) {
    console.error('[bot] could not create checkout:', err.message);
    await bot.sendMessage(user.id,
      '⚠️ Could not create your payment link just now. Please try again in a minute, ' +
      'or tap below to reach an admin if it keeps happening.',
      { reply_markup: SUPPORT_BUTTON });
  }
  });

  /**
   * createCheckout — a Razorpay payment link for the pass, at the price after
   * any coupon.
   *
   * What the student was shown rides in the link's notes — the valid-until
   * date, the pass name, the coupon — so the webhook grants exactly that even
   * if an admin changes the pass while the link is open.
   *
   * @param {Object} group The group being bought
   * @param {Object} pass  From passFor
   * @param {Object} user  Telegram user
   * @param {Object|null} applied A coupon that evaluated ok
   * @returns {Promise<{url: string}>}
   */
  async function createCheckout(group, pass, user, applied) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  const charged = Object.assign({}, pass, { amountPaise: applied ? applied.finalPaise : pass.amountPaise });

  const extraNotes = { plan_label: pass.label };
  if (pass.validUntil) extraNotes.valid_until = pass.validUntil;
  if (applied) {
    Object.assign(extraNotes, {
      original_amount: String(pass.amountPaise / 100),
      discount_amount: String(applied.discountPaise / 100)
    });
    if (applied.kind === 'promo') {
      // What the influencer earns rides in the link's notes, worked out from
      // the price the student was actually shown. The webhook then records
      // exactly that, rather than recomputing it against terms an admin may
      // have changed while the link was open.
      Object.assign(extraNotes, {
        promo_code: applied.code,
        affiliate_id: applied.affiliateId || '',
        commission_amount: String((applied.commissionPaise || 0) / 100),
        // So the Sales tab says who joined, not only their Telegram id.
        student_name: name
      });
    } else {
      extraNotes.coupon_code = applied.code;
      // So the Code Tracking tab names who paid, not only their Telegram id.
      extraNotes.student_name = name;
    }
  }

  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const link = await razorpay.createPaymentLink({
    plan: charged,
    telegramId: user.id,
    username: user.username,
    name,
    callbackUrl: base ? `${base}/payment-success.html` : undefined,
    extraNotes
  });
  return { url: link.short_url, linkId: link.id || '' };
  }

  // ---------------------------------------------------------------------------
  // Support
  // ---------------------------------------------------------------------------
  // Nothing about a conversation is kept in memory (see src/support.js): every
  // step is recovered from the message being replied to or the button tapped.

  /** How a Telegram user reads in a ticket thread. */
  function displayUser(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  if (user.username) return name ? `${name} (@${user.username})` : `@${user.username}`;
  return name || String(user.id);
  }

  /** One of this bot's groups by id, or null. */
  function groupById(groupId) {
  return groupId ? familyGroups().find((g) => g.id === groupId) || null : null;
  }

  /** The line students see when tickets are switched off or cannot be raised. */
  function contactLine(settings) {
  const parts = [];
  if (settings.support_contact) parts.push(`You can also reach us at ${esc(settings.support_contact)}.`);
  const email = support.emailFallbackLine(settings);
  if (email) parts.push(email);
  return parts.length ? '\n\n' + parts.join('\n') : '';
  }

  /** The support chat, if one is configured for this family. */
  function supportChat() {
  return support.supportChatFor(payBotEnv);
  }

  /** Options for a message into the support chat, keeping forum topics intact. */
  function supportChatOptions(chat, extra = {}) {
  const options = Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, extra);
  if (chat.threadId && !options.message_thread_id) options.message_thread_id = chat.threadId;
  // The client form-encodes every key it is given, undefined included.
  Object.keys(options).forEach((key) => {
    if (options[key] === undefined) delete options[key];
  });
  return options;
  }

  /** The support menu: one button per issue type. */
  async function sendSupportMenu(chatId) {
  const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
  await bot.sendMessage(chatId,
    '🆘 <b>Support</b>\n\nWhat do you need help with?\n\n' +
    `<i>Support hours: ${esc(settings.support_hours)}</i>` +
    (support.emailFallbackLine(settings) ? '\n\n' + support.emailFallbackLine(settings) : ''),
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: support.MENU_CATEGORIES.map((category) => ([{
          text: `${category.emoji} ${category.label}`,
          callback_data: `sup:faq:${category.id}`
        }]))
      }
    });
  }

  /**
   * Asks which group a problem is about, when this bot sells more than one.
   * A student can hold passes for both, and "which group" decides what an
   * admin checks.
   */
  async function sendGroupChoice(chatId, category) {
  const groups = familyGroups();
  await bot.sendMessage(chatId,
    `${esc(category.emoji)} <b>${esc(category.label)}</b>\n\nWhich group is this about?`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          ...groups.map((group, index) => ([{ text: group.shortName, callback_data: `sup:grp:${category.id}:${index}` }])),
          [{ text: 'Both / not sure', callback_data: `sup:grp:${category.id}:x` }]
        ]
      }
    });
  }

  /** Asks the student to describe the problem, as a message they reply to. */
  async function sendSupportPrompt(chatId, category, groupName = '') {
  const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
  if (!support.ticketsEnabled(settings)) {
    await bot.sendMessage(chatId,
      'Support tickets are not being taken through the bot right now.' + contactLine(settings),
      { parse_mode: 'HTML' });
    return;
  }
  await bot.sendMessage(chatId,
    `${esc(support.promptLine(category, groupName))}\n\n` +
    'Please describe the problem in one message.\n' +
    (['payment', 'payment_failed'].includes(category.id)
      ? 'Include your payment ID (it starts with <code>pay_</code>) or attach a screenshot of the payment.\n'
      : 'A screenshot helps if something looks wrong.\n') +
    '\n<i>Reply to this message.</i>',
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Describe your issue' }
    });
  }

  /** Resolves to `promise`, or to `fallback` after `ms`. Never rejects. */
  async function within(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
  }

  /** Runs `fn`, resolving `fallback` if it throws, rejects or takes longer than `ms`. */
  async function attempt(fn, ms, fallback) {
  try {
    return await within(fn(), ms, fallback);
  } catch (err) {
    return fallback;
  }
  }

  /** 'yes' | 'no' | 'unknown' — whether someone is in a group right now. */
  async function memberState(group, telegramId) {
  const member = await attempt(() => bot.getChatMember(group.telegramGroupId, telegramId), 5000, null);
  if (!member || !member.status) return 'unknown';
  return ['member', 'administrator', 'creator', 'restricted'].includes(member.status) ? 'yes' : 'no';
  }

  /**
   * studentSnapshot — everything an admin needs about a student's access, per
   * group: the pass, whether it would let them in right now (the same check a
   * join request uses), and whether they are in the group.
   *
   * @returns {Promise<Array<{group, subscriber, eligible, reason, inGroup, error}>>}
   */
  async function studentSnapshot(telegramId) {
  const passes = [];
  for (const group of familyGroups()) {
    let verdict;
    try {
      verdict = await membership.isEligible(group.id, telegramId);
    } catch (err) {
      passes.push({ group, subscriber: null, eligible: false, reason: `could not read the sheet (${err.message})`,
        inGroup: 'unknown', error: true });
      continue;
    }
    const entry = {
      group, subscriber: verdict.subscriber, eligible: verdict.ok, reason: verdict.reason, inGroup: 'unknown', error: false
    };
    if (verdict.subscriber) entry.inGroup = await memberState(group, telegramId);
    passes.push(entry);
  }
  return passes;
  }

  /** A sheet error in words an admin can act on. */
  function readableError(reason) {
  const text = String(reason || '');
  if (/timed out/i.test(text)) return 'could not check — the sheet took too long to answer. Tap 🎟 Pass & payment to retry.';
  return `could not check — ${text.replace(/^could not read the sheet \((.*)\)$/, '$1')}`;
  }

  /**
   * A student's passes, one block per group, for the support chat. The group
   * the ticket is about is marked, so a student in both groups is not
   * confused with the other one.
   */
  function passLines(passes, groupId = '') {
  if (!passes || !passes.length) return 'No groups found for this bot.';
  const ordered = passes.slice().sort((a, b) => Number(b.group.id === groupId) - Number(a.group.id === groupId));
  return ordered.map((p) => {
    const marker = groupId && p.group.id === groupId && passes.length > 1 ? ' · 📌 <i>this ticket</i>' : '';
    const name = `<b>${esc(p.group.shortName)}</b>${marker}`;
    if (p.error) return `⚠️ ${name}\n      ${esc(readableError(p.reason))}`;
    if (!p.subscriber) return `➖ ${name}\n      No pass`;
    const sub = p.subscriber;
    const where = p.inGroup === 'yes' ? 'in the group'
      : p.inGroup === 'no' ? '<b>not in the group</b>' : 'membership unknown';
    const state = p.eligible
      ? `Valid until ${esc(support.shortDate(sub.expiry_date))} · ${where}`
      : `<b>Not valid</b> — ${esc(p.reason)} · ${where}`;
    const paid = [
      sub.plan_label || sub.plan,
      sub.total_paid ? `₹${sub.total_paid}` + (sub.last_payment_at ? ` on ${support.shortDate(sub.last_payment_at)}` : '') : ''
    ].filter(Boolean).map(esc);
    if (sub.payment_id) paid.push(`<code>${esc(sub.payment_id)}</code>`);
    return `${p.eligible ? '✅' : '⛔'} ${name}\n      ${state}` + (paid.length ? `\n      ${paid.join(' · ')}` : '');
  }).join('\n');
  }

  /** "Newspaper · English", or why there is no group. */
  function groupLine(groupId, how) {
  const group = groupById(groupId);
  if (group) return esc(group.shortName) + (how === 'guessed' ? ' <i>(not chosen — their only pass)</i>' : '');
  return familyGroups().length > 1 ? '<i>Not specified</i>' : '—';
  }

  /** Posts one message about a ticket into the support chat, with the admin buttons. */
  async function postToAdmins(chat, ticketId, telegramId, html, { closed = false, paymentId = '', extra = {} } = {}) {
  return bot.sendMessage(chat.chatId,
    `${support.ticketHeaderHtml(ticketId, telegramId)}\n${html}`,
    supportChatOptions(chat, Object.assign({
      reply_markup: support.adminKeyboard(ticketId, telegramId, { closed, paymentId })
    }, extra)));
  }

  /** The ticket from the sheet, or null when it cannot be read in time. */
  async function readTicket(ticketId) {
  return attempt(() => sheetFor(primaryGroup().id).getTicket(ticketId), SUPPORT_SETTINGS_WAIT_MS, null);
  }

  /** Writes a non-message event to the Support Log; never throws. */
  async function logEvent(ticketId, who, action, details) {
  try {
    await sheetFor(primaryGroup().id).logTicketEvent(ticketId, { who, role: 'admin', action, details });
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not log ${action} on ${ticketId} — ${err.message}`);
  }
  }

  /**
   * notifyAdmins — posts a new ticket, or a student's reply to one, into the
   * support chat as a complete case file: who, which group, what they hold,
   * what they wrote, what to do next, and buttons to do it.
   *
   * @returns {Promise<boolean>} true when the admins were reached
   */
  async function notifyAdmins({ ticketId, user, category, groupId, groupHow, text, passes, source, followUp, conversation, status, reopened }) {
  const chat = supportChat();
  if (!chat) return false;

  // Telegram refuses anything over 4096 characters, and a refused post is a
  // ticket nobody sees. The full text is always in the sheet and 📜 History.
  const kind = support.mediaKind(source);
  const body = String(text || '');
  const shown = body.length > 1800 ? body.slice(0, 1800) + '… (cut short — tap 📜 History)' : body;
  const paymentId = support.findPaymentId(body) || support.findPaymentId(conversation);
  const message = [
    shown ? `<blockquote>${esc(shown)}</blockquote>` : '',
    kind ? `📎 <i>Sent a ${esc(kind)} — it is posted just below.</i>` : ''
  ].filter(Boolean).join('\n') || '<i>(empty message)</i>';

  const lines = [];
  if (followUp) {
    lines.push((reopened ? '🔁 <b>Reopened — the student wrote on a closed ticket</b>' : '↩️ <b>Student replied</b>'));
    lines.push(`<b>Status:</b> ${support.statusLine(status || 'open', 'admin')}`);
    lines.push('');
    lines.push(`<b>Student:</b> ${esc(displayUser(user))}`);
    if (category) lines.push(`<b>Issue:</b> ${esc(category.emoji)} ${esc(category.label)}`);
    if (familyGroups().length > 1) lines.push(`<b>Group:</b> ${groupLine(groupId)}`);
    lines.push('', '💬 <b>New message</b>', message);
    const earlier = support.earlierConversation(conversation, 1200);
    if (earlier) lines.push('', '📜 <b>Earlier in this ticket</b>', `<blockquote expandable>${esc(earlier)}</blockquote>`);
  } else {
    lines.push('🆕 <b>New ticket</b>');
    lines.push(`<b>Status:</b> ${support.statusLine('open', 'admin')}`);
    lines.push('');
    lines.push(`<b>Student:</b> ${esc(displayUser(user))}`);
    lines.push(`<b>Issue:</b> ${esc(category.emoji)} ${esc(category.label)}`);
    lines.push(`<b>Group:</b> ${groupLine(groupId, groupHow)}`);
    lines.push('', '💬 <b>Message</b>', message);
    lines.push('', '🎟 <b>Access</b>', passLines(passes, groupId));
    lines.push('', `🧭 <b>Next step:</b> ${esc(support.suggestNextStep(category.id, passes, groupId))}`);
  }

  try {
    await postToAdmins(chat, ticketId, user.id, lines.join('\n'), { paymentId });
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not reach the support chat — ${err.message}`);
    return false;
  }

  if (source && support.hasMedia(source)) {
    try {
      const caption = `${support.ticketHeader(ticketId, user.id)}\n📎 From ${displayUser(user)}` +
        (support.messageText(source) ? `:\n${support.messageText(source)}` : '');
      const options = supportChatOptions(chat, { caption: caption.slice(0, 1000) });
      delete options.parse_mode;
      delete options.disable_web_page_preview;
      await bot.copyMessage(chat.chatId, source.chat.id, source.message_id, options);
    } catch (err) {
      console.error(`[support] ${payBotEnv}: could not copy an attachment — ${err.message}`);
    }
  }
  return true;
  }

  /**
   * findActiveTicket — the ticket a student's new message belongs to: their
   * most recent one that is not closed, or failing that the most recent one
   * closed, as long as it was touched in the last week. A closed one reopens
   * as in progress when the message is added.
   *
   * A student does not use Telegram's reply feature; they just type again.
   * Without this, every such message became a separate ticket and the admin
   * saw the same problem scattered across several.
   *
   * @returns {Promise<Object|null>} Resolves null when none, or when the sheet cannot say
   */
  async function findActiveTicket(telegramId) {
  const list = await attempt(
    () => sheetFor(primaryGroup().id).listTickets({ telegramId: String(telegramId), pageSize: 10 }),
    SUPPORT_SETTINGS_WAIT_MS,
    null
  );
  const recent = ((list && list.tickets) || []).filter((t) => support.isRecent(t.updated_at, ACTIVE_TICKET_DAYS));
  return recent.find((t) => support.normaliseStatus(t.status) !== 'closed') || recent[0] || null;
  }

  /**
   * openTicket — turns a student's message into a ticket.
   *
   * The sheet and the support chat are written independently, so either one
   * being down still leaves the ticket somewhere an admin will see it.
   */
  async function openTicket(source, category, user, groupName = '') {
  const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
  if (!support.ticketsEnabled(settings)) {
    await bot.sendMessage(user.id,
      'Support tickets are not being taken through the bot right now.' + contactLine(settings),
      { parse_mode: 'HTML' });
    return;
  }

  const text = support.messageText(source);
  if (!text && !support.hasMedia(source)) {
    await bot.sendMessage(user.id, 'Please describe the problem in words, or attach a screenshot.');
    return;
  }
  if (!allowTicket(String(user.id))) {
    await bot.sendMessage(user.id,
      'You have sent several support messages in the last few minutes. An admin will get to them — ' +
      'please wait a little before sending more.');
    return;
  }

  const ticketId = support.newTicketId();
  const groups = familyGroups();
  // The group the student picked, or the only one this bot sells.
  const chosen = groups.length === 1 ? groups[0] : groups.find((g) => g.shortName === groupName) || null;
  const [saved, passes] = await Promise.all([
    Promise.resolve().then(() => sheetFor(primaryGroup().id).createTicket({
      ticket_id: ticketId,
      telegram_id: String(user.id),
      username: user.username || '',
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      category: category.id,
      bot: payBotEnv,
      message: text || `(${support.mediaKind(source) || 'attachment'})`,
      group: chosen ? chosen.id : ''
    })).then(() => true, (err) => {
      console.error(`[support] ${payBotEnv}: could not record ticket ${ticketId} — ${err.message}`);
      return false;
    }),
    studentSnapshot(user.id)
  ]);

  // Not chosen: when they hold a pass in only one group, that is almost
  // certainly the one, and it is recorded so the dashboard can say so.
  let groupId = chosen ? chosen.id : '';
  let groupHow = chosen ? 'chosen' : '';
  if (!chosen) {
    groupId = support.inferTicketGroup(passes);
    if (groupId) {
      groupHow = 'guessed';
      if (saved) {
        await attempt(() => sheetFor(primaryGroup().id).setTicketGroup(ticketId, groupId, ''), SUPPORT_SETTINGS_WAIT_MS, null);
      }
    }
  }

  const delivered = await notifyAdmins({ ticketId, user, category, groupId, groupHow, text, passes, source });

  if (!saved && !delivered) {
    await bot.sendMessage(user.id,
      '⚠️ Could not submit your ticket just now. Please try again in a few minutes.' + contactLine(settings),
      { parse_mode: 'HTML' });
    return;
  }

  const aboutGroup = groupById(groupId);
  await bot.sendMessage(user.id,
    `${esc(support.receivedLine(ticketId))}\n\n` +
    '✅ <b>Your ticket has been created.</b>\n\n' +
    `<b>Issue:</b> ${esc(category.label)}\n` +
    (groups.length > 1 && groupHow === 'chosen' && aboutGroup ? `<b>Group:</b> ${esc(aboutGroup.shortName)}\n` : '') +
    '<b>Status:</b> Open — waiting for our team\n\n' +
    `Our team will reply <b>${esc(settings.support_response_time)}</b>, right here in this chat.\n` +
    `<b>Support hours:</b> ${esc(settings.support_hours)}\n\n` +
    '<i>Need to add something? Just send another message and it will be added to this ticket.</i>' +
    (support.emailFallbackLine(settings) ? '\n\n' + support.emailFallbackLine(settings) : ''),
    { parse_mode: 'HTML' });
  }

  /**
   * followUpTicket — a student adding to a ticket that already exists. A
   * closed one reopens as in progress (the sheet applies that rule).
   *
   * @param {{wasClosed?: boolean}} [options] Whether the ticket was closed
   */
  async function followUpTicket(source, ticketId, user, options = {}) {
  const text = support.messageText(source);
  if (!text && !support.hasMedia(source)) return;
  if (!allowTicket(String(user.id))) {
    await bot.sendMessage(user.id,
      'You have sent several support messages in the last few minutes. Please wait a little before sending more.');
    return;
  }

  let ticket = null;
  let saved = false;
  try {
    ticket = await sheetFor(primaryGroup().id).appendTicketMessage(ticketId, {
      author: displayUser(user),
      text: text || `(${support.mediaKind(source) || 'attachment'})`
    });
    saved = Boolean(ticket);
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not add to ticket ${ticketId} — ${err.message}`);
  }

  const delivered = await notifyAdmins({
    ticketId, user, text, source, followUp: true,
    category: ticket && ticket.category ? support.categoryById(ticket.category) : null,
    groupId: ticket ? ticket.group : '',
    conversation: ticket && ticket.conversation,
    status: ticket ? ticket.status : 'open',
    reopened: Boolean((ticket && ticket.reopened) || options.wasClosed)
  });

  if (!saved && !delivered) {
    await bot.sendMessage(user.id,
      '⚠️ Could not add that to your ticket just now. Please try again in a few minutes.');
    return;
  }
  // This is a follow-up, so they have written at least twice. If no admin has
  // ever replied on this ticket, they have been waiting with nothing back —
  // which is exactly the moment to hand them the other door, rather than
  // repeating "our team will reply here".
  //
  // Counting replies rather than reading waiting_on is deliberate: appending
  // this very message sets waiting_on to "admin", so that field is true of
  // every follow-up and would make the escalation meaningless.
  const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
  const neverAnswered = Boolean(ticket) && Number(ticket.admin_replies || 0) === 0 &&
    String(ticket.status || '') !== 'closed';
  const escalation = support.emailFallbackLine(settings, neverAnswered);

  await bot.sendMessage(user.id,
    `${esc(support.receivedLine(ticketId))}\n\n` +
    ((ticket && ticket.reopened) || options.wasClosed
      ? '🔁 <b>Your earlier ticket has been reopened.</b> Our team will reply here.\n\n'
      : '✅ <b>Added to your ticket.</b> Our team will reply here.\n\n') +
    '<i>Different problem? Send /support to open a new ticket.</i>' +
    (escalation ? '\n\n' + escalation : ''),
    { parse_mode: 'HTML' });
  }

  /**
   * resendInvites — a fresh invite for every group in this family where the
   * student holds a valid pass, sent to them by this bot.
   *
   * @param {string|number} telegramId
   * @param {{ticketId?: string, actor?: string}} [options] Recorded on the ticket when given
   * @returns {Promise<Array<Object>>} One entry per group:
   *   { group, sent, delivered, status, reason, inviteLink, error }
   */
  async function resendInvites(telegramId, { ticketId, actor } = {}) {
  const results = [];
  for (const group of familyGroups()) {
    const entry = { group, sent: false, delivered: false, status: 'none', inviteLink: '', error: '' };
    results.push(entry);
    try {
      const outcome = await membership.resendInvite(group.id, telegramId);
      entry.status = outcome.subscriber ? outcome.subscriber.status || 'unknown' : 'none';
      entry.expiry = outcome.subscriber ? outcome.subscriber.expiry_date : '';
      entry.reason = outcome.reason || '';
      if (!outcome.sent) continue;
      entry.sent = true;
      entry.inviteLink = outcome.inviteLink;
    } catch (err) {
      entry.error = err.message;
      continue;
    }

    try {
      await bot.sendMessage(telegramId,
        `🔗 <b>Your new invite link for ${esc(group.shortName)}</b>\n\n` +
        'Tap below to join. It works only for your Telegram account and expires in 24 hours.',
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: `🔗 Join ${group.shortName}`, url: entry.inviteLink }]] }
        });
      entry.delivered = true;
    } catch (err) {
      entry.error = err.message;
    }
  }

  if (ticketId) {
    const delivered = results.filter((r) => r.delivered).map((r) => r.group.shortName);
    if (delivered.length) {
      try {
        await sheetFor(primaryGroup().id).appendTicketMessage(ticketId, {
          author: `Admin ${actor || 'unknown'}`,
          text: `Sent a fresh invite link for ${delivered.join(', ')}`,
          handledBy: actor || 'unknown',
          logAction: 'invite_sent'
        });
      } catch (err) {
        console.error(`[support] ${payBotEnv}: could not record the resent invite on ${ticketId} — ${err.message}`);
      }
    } else {
      await logEvent(ticketId, actor, 'invite_not_sent',
        results.map((r) => `${r.group.shortName}: ${r.error || r.reason || r.status}`).join('; '));
    }
  }
  return results;
  }

  /** What resendInvites did, as lines for the support chat. */
  function describeInviteResults(results) {
  const lines = results.map((r) => {
    const name = esc(r.group.shortName);
    if (r.delivered) return `✅ ${name}: new invite link sent to the student`;
    if (r.sent) {
      return `⚠️ ${name}: link created but the student could not be messaged (${esc(r.error)}). ` +
        `Send it yourself: ${esc(r.inviteLink)}`;
    }
    if (r.error) return `❌ ${name}: could not create a link — ${esc(r.error)}`;
    if (r.status === 'none') return `➖ ${name}: no pass on record`;
    return `➖ ${name}: no invite sent — ${esc(r.reason || `pass is ${r.status}`)}` +
      ` (status <b>${esc(r.status)}</b>${r.expiry ? `, expiry ${esc(r.expiry)}` : ''})`;
  });
  if (!results.some((r) => r.sent)) {
    lines.push('', 'Nobody to invite: the student needs a valid pass. If they say they paid, ' +
      'ask for the payment ID (📋 Quick replies) and 🔍 check it.');
  }
  return lines.join('\n');
  }

  /** Paise as rupees with two decimals only when needed. */
  function rupeesOf(paise) {
  return pricing.rupees(Number(paise) || 0);
  }

  /** A Razorpay unix time as an IST stamp. */
  function istFromUnix(seconds) {
  return seconds ? membership.formatIst(new Date(Number(seconds) * 1000)) : '';
  }

  /**
   * checkPayment — what Razorpay says about a payment id, for an admin.
   *
   * @returns {Promise<{found: boolean, payment?: Object, html: string, captured: boolean}>}
   */
  async function checkPayment(paymentId, telegramId) {
  let payment;
  try {
    payment = await within(razorpay.getPayment(paymentId), 10000, null);
  } catch (err) {
    return { found: false, captured: false, html: `❌ Razorpay could not find <code>${esc(paymentId)}</code>: ${esc(err.message)}` };
  }
  if (!payment) {
    return { found: false, captured: false, html: `⚠️ Razorpay did not answer in time for <code>${esc(paymentId)}</code>. Try again.` };
  }

  const meaning = {
    captured: '✅ captured — the money was received',
    authorized: '⏳ authorized — not captured yet; usually captures within minutes',
    failed: '❌ failed — no money was taken (or it will be returned by the bank)',
    refunded: '↩️ refunded',
    created: '⏳ created — the student did not finish paying'
  }[payment.status] || esc(payment.status);

  const notes = payment.notes || {};
  let owner;
  if (!notes.telegram_id) {
    owner = 'no Telegram id on the payment itself — compare the time and amount with what the student says';
  } else if (!telegramId) {
    owner = `the checkout of Telegram id <code>${esc(notes.telegram_id)}</code>`;
  } else if (String(notes.telegram_id) === String(telegramId)) {
    owner = '✅ made from this student\'s checkout';
  } else {
    owner = `⚠️ made from the checkout of Telegram id <code>${esc(notes.telegram_id)}</code>, not this student`;
  }

  const lines = [
    `🔍 <b>Payment <code>${esc(payment.id || paymentId)}</code></b>\n`,
    `<b>Status:</b> ${meaning}`,
    `<b>Amount:</b> ${rupeesOf(payment.amount)}${payment.method ? ` · ${esc(payment.method)}` : ''}`,
    `<b>Made at:</b> ${esc(istFromUnix(payment.created_at))}`,
    payment.description ? `<b>For:</b> ${esc(payment.description)}` : '',
    `<b>Belongs to:</b> ${owner}`,
    payment.error_description ? `<b>Bank said:</b> ${esc(payment.error_description)}` : ''
  ].filter(Boolean);

  return { found: true, payment, captured: payment.status === 'captured', html: lines.join('\n') };
  }

  /** Taps on any sup:* button. */
  async function handleSupportCallback(query, data, ack) {
  const user = query.from;
  const [, action, arg] = data.split(':');

  if (action === 'menu') {
    await ack();
    await sendSupportMenu(user.id);
    return;
  }

  if (action === 'faq') {
    await ack();
    const category = support.categoryById(arg);
    const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
    const buttons = support.ticketsEnabled(settings)
      ? [
        [{ text: '📨 I still need help', callback_data: `sup:ask:${category.id}` }],
        [{ text: '✅ That solved it', callback_data: 'sup:solved' }]
      ]
      : [[{ text: '✅ That solved it', callback_data: 'sup:solved' }]];
    await bot.sendMessage(user.id,
      `${esc(category.emoji)} <b>${esc(category.label)}</b>\n\n${esc(settings[category.settingKey] || category.answer)}` +
      (support.ticketsEnabled(settings) ? '' : contactLine(settings)),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (action === 'ask') {
    await ack();
    const category = support.categoryById(arg);
    if (familyGroups().length > 1) await sendGroupChoice(user.id, category);
    else await sendSupportPrompt(user.id, category);
    return;
  }

  // sup:grp:<category>:<group index | x>
  if (action === 'grp') {
    await ack();
    const index = data.split(':')[3];
    const group = /^\d+$/.test(index) ? familyGroups()[Number(index)] : null;
    await sendSupportPrompt(user.id, support.categoryById(arg), group ? group.shortName : '');
    return;
  }

  if (action === 'solved') {
    await ack('Glad that helped! Send /support any time.');
    return;
  }

  const offer = query.message;

  if (action === 'dismiss') {
    await ack();
    if (offer) {
      try {
        await bot.deleteMessage(offer.chat.id, offer.message_id);
      } catch (err) {
        // Too old to delete; harmless.
      }
    }
    return;
  }

  if (action === 'send') {
    const original = offer && offer.reply_to_message;
    if (!original || !original.from || String(original.from.id) !== String(user.id)) {
      await ack('That message is no longer available — send /support instead.');
      return;
    }
    await ack('Sending to support…');
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: offer.chat.id, message_id: offer.message_id });
    } catch (err) {
      // Buttons that stay visible are cosmetic; the ticket still goes through.
    }
    const active = await findActiveTicket(user.id);
    if (active) {
      await followUpTicket(original, active.ticket_id, user, { wasClosed: support.normaliseStatus(active.status) === 'closed' });
    } else {
      await openTicket(original, support.categoryById('other'), user);
    }
    return;
  }

  await ack();
  }

  /**
   * setStatusFromChat — an admin closing or reopening a ticket from the
   * support chat. Only this, the dashboard's close button and the "Resolved"
   * quick reply ever close a ticket.
   */
  async function setStatusFromChat(chat, ticket, status, admin, where) {
  let saved = null;
  try {
    saved = await sheetFor(primaryGroup().id).setTicketStatus(ticket.ticketId, status, admin);
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not set ${ticket.ticketId} to ${status} — ${err.message}`);
    await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
      `⚠️ <b>Not changed</b>: the sheet could not be updated (${esc(err.message)}). Try again.`, { extra: where });
    return;
  }
  const alreadyClosed = status === 'closed' && saved && saved.previous_status === 'closed';
  if (status === 'closed' && !alreadyClosed) {
    try {
      await bot.sendMessage(ticket.telegramId, support.resolvedHtml(ticket.ticketId), { parse_mode: 'HTML' });
    } catch (err) {
      // Blocked the bot; the ticket is closed either way.
    }
  }
  const heading = alreadyClosed
    ? `ℹ️ <b>Already closed</b>${saved.closed_by ? ` by ${esc(saved.closed_by)}` : ''} — nothing changed.`
    : status === 'closed'
      ? `✅ <b>Closed</b> by ${esc(admin)} — the student was told it is resolved.`
      : `🔓 <b>Reopened</b> by ${esc(admin)}`;
  await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
    `${heading}\nStatus: ${saved ? support.statusLine(saved.status, saved.waiting_on) : support.statusLabel(status)}`,
    { closed: status === 'closed', extra: where });
  }

  /** How an admin reads in the support chat and the ticket thread. */
  function adminName(user) {
  return user.username ? `@${user.username}` : displayUser(user);
  }

  /**
   * sendAdminAnswer — delivers an admin's text to a student and records it.
   *
   * @returns {Promise<{delivered: boolean, error?: string}>}
   */
  async function sendAdminAnswer(ticketId, telegramId, text, admin, { logAction } = {}) {
  try {
    await bot.sendMessage(telegramId, support.studentReplyHtml(ticketId, text), { parse_mode: 'HTML' });
  } catch (err) {
    return { delivered: false, error: err.message };
  }
  try {
    await sheetFor(primaryGroup().id).appendTicketMessage(ticketId, {
      author: `Admin ${admin}`, text, handledBy: admin, logAction
    });
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not record the answer to ${ticketId} — ${err.message}`);
  }
  return { delivered: true };
  }

  /** Taps on the buttons under a ticket in the support chat. */
  async function handleAdminCallback(query, data, ack) {
  const chat = supportChat();
  const message = query.message;
  // Buttons only mean something in the admin chat. A copy of one anywhere
  // else, or a crafted callback, gets nothing.
  if (!chat || !message || !message.chat || String(message.chat.id) !== chat.chatId) {
    await ack('This button only works in the support chat.');
    return;
  }
  const parsed = support.parseAdminCallback(data);
  if (!parsed) {
    await ack();
    return;
  }

  const { action, ticketId, telegramId, paymentId } = parsed;
  const ticket = { ticketId, telegramId };
  const admin = adminName(query.from);
  const where = { reply_to_message_id: message.message_id };
  if (message.message_thread_id) where.message_thread_id = message.message_thread_id;
  const post = (html, options = {}) => postToAdmins(chat, ticketId, telegramId, html,
    Object.assign({ extra: where }, options));

  if (action === 'reply') {
    await ack();
    await bot.sendMessage(chat.chatId,
      `${support.ticketHeaderHtml(ticketId, telegramId)}\n` +
      `✍️ ${esc(admin)}, type your answer as a <b>reply to this message</b>. It goes straight to the student.`,
      supportChatOptions(chat, Object.assign({
        reply_markup: { force_reply: true, input_field_placeholder: `Answer for ${ticketId}` }
      }, where)));
    return;
  }

  if (action === 'quickMenu') {
    await ack();
    const [found, settings] = await Promise.all([readTicket(ticketId), settingsWithin(SUPPORT_SETTINGS_WAIT_MS)]);
    const category = found ? found.category : 'other';
    const preview = support.quickRepliesFor(category).map((reply) => {
      const text = String(settings[reply.key] || reply.text);
      return `<b>${esc(reply.button)}</b>\n<i>${esc(text.length > 110 ? text.slice(0, 110) + '…' : text)}</i>`;
    });
    await bot.sendMessage(chat.chatId,
      `${support.ticketHeaderHtml(ticketId, telegramId)}\n📋 <b>Quick replies</b> — tap one to send it to the student now:\n\n` +
      preview.join('\n\n'),
      supportChatOptions(chat, Object.assign({
        reply_markup: support.quickReplyKeyboard(ticketId, telegramId, category)
      }, where)));
    return;
  }

  if (action === 'quickReply') {
    const reply = parsed.quickReply;
    await ack('Sending…');
    const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
    const text = String(settings[reply.key] || reply.text);
    const outcome = await sendAdminAnswer(ticketId, telegramId, text, admin, { logAction: `quick_reply:${reply.key}` });
    if (!outcome.delivered) {
      await post(`⚠️ <b>Not delivered</b>: ${esc(outcome.error)}\nThe student may have blocked the bot.`);
      return;
    }
    let closed = false;
    if (reply.closes) {
      try {
        await sheetFor(primaryGroup().id).setTicketStatus(ticketId, 'closed', admin);
        closed = true;
      } catch (err) {
        console.error(`[support] ${payBotEnv}: could not close ${ticketId} — ${err.message}`);
      }
    }
    await post(
      `📋 <b>Quick reply sent</b> by ${esc(admin)}: ${esc(reply.button)}\n<blockquote>${esc(text)}</blockquote>\n` +
      (reply.closes && !closed ? '⚠️ The message was sent but the ticket could not be closed — tap ✅ Close.\n' : '') +
      `Status: ${closed ? support.statusLabel('closed') : support.statusLine('in_progress', 'student')}`,
      { closed });
    return;
  }

  if (action === 'invite') {
    await ack('Creating a fresh invite link…');
    const results = await resendInvites(telegramId, { ticketId, actor: admin });
    await post(`🔗 <b>Send new invite link</b> · by ${esc(admin)}\n\n${describeInviteResults(results)}`);
    return;
  }

  if (action === 'passes') {
    await ack('Checking…');
    const [passes, found] = await Promise.all([studentSnapshot(telegramId), readTicket(ticketId)]);
    const groupId = found ? found.group : '';
    await post(
      `🎟 <b>Pass & payment</b> · checked just now\n\n${passLines(passes, groupId)}\n\n` +
      `🧭 <b>Next step:</b> ${esc(support.suggestNextStep(found ? found.category : 'other', passes, groupId))}`);
    return;
  }

  if (action === 'history') {
    await ack();
    const found = await readTicket(ticketId);
    if (!found) {
      await post('⚠️ This ticket could not be read from the sheet (it may have been raised while the sheet was unavailable).');
      return;
    }
    const recent = (found.log || []).slice(-6).map((e) =>
      `• ${esc(e.at)} — ${esc(e.who || e.role)}: ${esc(String(e.action).replace(/_/g, ' '))}`);
    const category = support.categoryById(found.category);
    const facts = [
      found.picked_up_by ? `picked up by ${esc(found.picked_up_by)}` : 'not picked up yet',
      found.handled_by ? `last handled by ${esc(found.handled_by)}` : '',
      found.admin_replies ? `${found.admin_replies} admin repl${found.admin_replies === 1 ? 'y' : 'ies'}` : ''
    ].filter(Boolean).join(' · ');
    await post(
      `📜 <b>History</b>\n` +
      `<b>Status:</b> ${support.statusLine(found.status, found.waiting_on)}\n` +
      `<b>Issue:</b> ${esc(category.emoji)} ${esc(category.label)}\n` +
      (familyGroups().length > 1 ? `<b>Group:</b> ${groupLine(found.group)}\n` : '') +
      `<b>Opened:</b> ${esc(found.created_at || '—')}\n` +
      `<i>${facts}</i>\n\n` +
      '💬 <b>Conversation</b>\n' +
      `<blockquote expandable>${esc(support.lastChars(found.conversation || found.last_message, 2600))}</blockquote>` +
      (recent.length ? `\n\n🧾 <b>Recent actions</b>\n${recent.join('\n')}` : ''),
      { closed: found.status === 'closed', paymentId: support.findPaymentId(found.conversation) });
    return;
  }

  if (action === 'close' || action === 'reopen') {
    await ack(action === 'close' ? 'Closing…' : 'Reopening…');
    await setStatusFromChat(chat, ticket, action === 'close' ? 'closed' : 'in_progress', admin, where);
    return;
  }

  if (action === 'checkPayment') {
    await ack('Asking Razorpay…');
    const result = await checkPayment(paymentId, telegramId);
    await logEvent(ticketId, admin, 'payment_checked',
      result.payment
        ? `${paymentId}: ${result.payment.status}, ${rupeesOf(result.payment.amount)}`
        : `${paymentId}: not found`);

    let followUp = '';
    const markup = { paymentId };
    if (result.captured) {
      const passes = await studentSnapshot(telegramId);
      if (!passes.some((p) => p.eligible)) {
        followUp = '\n\n🧭 <b>Money was received but the student has no valid pass</b> — the automatic grant did ' +
          'not happen. If this payment is theirs, tap "✅ Grant pass for this payment".';
      } else {
        followUp = '\n\n🧭 The student already has a valid pass. If they cannot get in, use "🔗 Send new invite link".';
      }
    }
    const keyboard = support.adminKeyboard(ticketId, telegramId, markup);
    if (result.captured) {
      keyboard.inline_keyboard.splice(2, 0, [{
        text: '✅ Grant pass for this payment',
        callback_data: `adm:g:${ticketId}:${telegramId}:${paymentId}`
      }]);
    }
    await bot.sendMessage(chat.chatId,
      `${support.ticketHeaderHtml(ticketId, telegramId)}\n${result.html}${followUp}`,
      supportChatOptions(chat, Object.assign({ reply_markup: keyboard }, where)));
    return;
  }

  if (action === 'grantAsk') {
    await ack();
    const pass = await passFor(primaryGroup().id);
    await bot.sendMessage(chat.chatId,
      `${support.ticketHeaderHtml(ticketId, telegramId)}\n` +
      `✅ <b>Grant a pass for <code>${esc(paymentId)}</code>?</b>\n\n` +
      `The student gets <b>${esc(pass ? pass.label : 'the pass')}</b>` +
      (pass && pass.validUntil ? ` until <b>${esc(pass.validUntil)}</b>` : '') +
      ' and an invite link. Razorpay is checked again before anything happens, and a payment already ' +
      'used for another student is refused.\n\nWhich group did they pay for?',
      supportChatOptions(chat, Object.assign({
        reply_markup: {
          inline_keyboard: [
            ...familyGroups().map((group, index) => ([{
              text: `✅ Yes — ${group.shortName}`,
              callback_data: `adm:g${index}:${ticketId}:${telegramId}:${paymentId}`
            }])),
            [{ text: '✖️ Cancel', callback_data: `adm:p:${ticketId}:${telegramId}` }]
          ]
        }
      }, where)));
    return;
  }

  if (action === 'grantConfirm') {
    const group = familyGroups()[parsed.groupIndex];
    if (!group) {
      await ack('That group no longer exists.');
      return;
    }
    await ack('Granting…');
    const outcome = await grantForPayment({ group, telegramId, paymentId, ticketId, admin });
    await post(outcome.html, { paymentId });
    return;
  }

  await ack();
  }

  /**
   * findRecordedPayment — a payment id in one group's sheet, from the payment
   * log or a member row. Falls back to searching members on a sheet whose
   * Apps Script predates the findPayment action.
   *
   * @returns {Promise<{telegram_id: string}|null>}
   */
  async function findRecordedPayment(group, paymentId) {
  const client = sheetFor(group.id);
  try {
    return await client.findPayment(paymentId);
  } catch (err) {
    if (!err.staleScript) throw err;
  }
  const found = await client.listSubscribers({ search: paymentId, pageSize: 5 });
  return (found.subscribers || []).find((sub) => sub.payment_id === paymentId) || null;
  }

  /**
   * lowestLegitimatePrice — the least anyone could pay for the pass today:
   * its price after the biggest discount any coupon (active or not) gives,
   * never below Rs 1. If coupons cannot be read, only Rs 1 is enforced.
   */
  async function lowestLegitimatePrice(pass) {
  if (!pass) return pricing.MIN_PAYABLE_PAISE;
  let floor = pass.amountPaise;
  try {
    const coupons = await sheetFor(primaryGroup().id).listCoupons();
    for (const coupon of coupons) {
      const value = Number(coupon.discount_value) || 0;
      const discount = coupon.discount_type === 'percent'
        ? Math.round(pass.amountPaise * value / 100)
        : Math.round(value * 100);
      floor = Math.min(floor, Math.max(pricing.MIN_PAYABLE_PAISE, pass.amountPaise - discount));
    }
  } catch (err) {
    return pricing.MIN_PAYABLE_PAISE;
  }
  return floor;
  }

  /**
   * grantForPayment — gives a student the pass for a payment Razorpay confirms
   * was captured, when the automatic grant after payment did not happen.
   *
   * Runs the same grantAccess the webhook runs, so the payment is recorded
   * once, with its real amount, and a repeat changes nothing.
   *
   * @returns {Promise<{granted: boolean, html: string}>}
   */
  async function grantForPayment({ group, telegramId, paymentId, ticketId, admin }) {
  const check = await checkPayment(paymentId, telegramId);
  if (!check.captured) {
    await logEvent(ticketId, admin, 'pass_grant_refused', `${paymentId}: not captured`);
    return { granted: false, html: `⛔ <b>Not granted.</b> Razorpay does not show this payment as captured.\n\n${check.html}` };
  }
  const payment = check.payment;
  const notes = payment.notes || {};
  if (notes.telegram_id && String(notes.telegram_id) !== String(telegramId)) {
    await logEvent(ticketId, admin, 'pass_grant_refused', `${paymentId}: belongs to ${notes.telegram_id}`);
    return { granted: false, html: `⛔ <b>Not granted.</b> This payment was made from another student's checkout (Telegram id <code>${esc(notes.telegram_id)}</code>).` };
  }

  // A payment already recorded anywhere — any group, any bot, the member row
  // or the payment log — must not buy a second pass. A payment recorded for
  // this same student in this same group is left to grantAccess, which treats
  // it as already processed.
  try {
    for (const g of groupRegistry.listGroups().filter((x) => x.ready)) {
      const record = await findRecordedPayment(g, paymentId);
      if (record && (String(record.telegram_id) !== String(telegramId) || g.id !== group.id)) {
        await logEvent(ticketId, admin, 'pass_grant_refused',
          `${paymentId}: already recorded for ${record.telegram_id} in ${g.shortName}`);
        return {
          granted: false,
          html: `⛔ <b>Not granted.</b> <code>${esc(paymentId)}</code> is already recorded for Telegram id ` +
            `<code>${esc(record.telegram_id)}</code> in ${esc(g.shortName)}.`
        };
      }
    }
  } catch (err) {
    return { granted: false, html: `⚠️ Could not check the payment records, so nothing was granted: ${esc(err.message)}` };
  }

  // A captured payment for less than anyone can pay today — a ₹1 test
  // payment, or one for something else — must not become a full pass.
  const pass = await passFor(group.id);
  const floor = await lowestLegitimatePrice(pass);
  if (Number(payment.amount) < floor) {
    await logEvent(ticketId, admin, 'pass_grant_refused',
      `${paymentId}: ${rupeesOf(payment.amount)} is below the lowest price ${rupeesOf(floor)}`);
    return {
      granted: false,
      html: `⛔ <b>Not granted.</b> This payment is ${rupeesOf(payment.amount)}, less than the lowest price ` +
        `anyone can pay for the pass today (${rupeesOf(floor)}, with the best coupon). It is not a payment for this pass.`
    };
  }

  let result;
  try {
    result = await membership.grantAccess({
      groupId: group.id,
      telegramId,
      planId: pricing.PASS_PLAN_ID,
      paymentId,
      amountPaise: payment.amount,
      event: 'manual.grant',
      validUntil: pass ? pass.validUntil : '',
      planLabel: pass ? pass.label : ''
    });
  } catch (err) {
    await logEvent(ticketId, admin, 'pass_grant_failed', `${paymentId}: ${err.message}`);
    return { granted: false, html: `❌ Could not grant the pass: ${esc(err.message)}` };
  }

  let delivered = false;
  if (result.inviteLink) {
    try {
      await bot.sendMessage(telegramId,
        `✅ <b>Your payment is confirmed — you are in.</b>\n\n` +
        `${esc(result.subscriber.plan_label || '')} for <b>${esc(group.shortName)}</b>` +
        (result.subscriber.expiry_date ? ` until <b>${esc(result.subscriber.expiry_date)}</b>` : '') +
        '\n\nTap below to join. The link works only for your Telegram account.',
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: `🔗 Join ${group.shortName}`, url: result.inviteLink }]] }
        });
      delivered = true;
    } catch (err) {
      delivered = false;
    }
  }

  try {
    await sheetFor(primaryGroup().id).appendTicketMessage(ticketId, {
      author: `Admin ${admin}`,
      text: `Granted ${group.shortName} for ${paymentId} (${rupeesOf(payment.amount)})` +
        (delivered ? ' and sent the invite link' : ''),
      handledBy: admin,
      logAction: result.alreadyProcessed ? 'pass_grant_already_done' : 'pass_granted'
    });
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not record the grant on ${ticketId} — ${err.message}`);
  }

  return {
    granted: true,
    html: (result.alreadyProcessed
      ? `ℹ️ <b>Already granted</b> — this payment was recorded before.`
      : `✅ <b>Pass granted</b> by ${esc(admin)} for ${esc(group.shortName)}.`) +
      `\nValid until <b>${esc(result.subscriber.expiry_date || '')}</b>` +
      (delivered ? '\n🔗 Invite link sent to the student.'
        : (result.inviteLink ? `\n⚠️ Could not message the student. Send them: ${esc(result.inviteLink)}` : ''))
  };
  }

  // Everything a student types that is not a command, and everything said in
  // the admin support chat.
  bot.on('message', async (msg) => {
  if (!msg || !msg.chat || !msg.from || msg.from.is_bot) return;

  const chat = supportChat();
  if (chat && String(msg.chat.id) === chat.chatId) {
    await handleSupportChatMessage(msg, chat);
    return;
  }

  // Only private chats. The bot is an admin in the paid groups and sees every
  // message there; answering those would be spam at best.
  if (msg.chat.type !== 'private') return;

  if (/^\/support(?:@\w+)?(?:\s|$)/i.test(String(msg.text || ''))) {
    await sendSupportMenu(msg.chat.id);
    return;
  }
  // Commands the bot answers have their own handlers. Every other command —
  // a typo, one from another bot, "/menu" — gets told what does work, rather
  // than nothing. Silence here is what got the bot's ad rejected.
  if (String(msg.text || '').startsWith('/')) {
    if (studentCommandNames.has(commandName(msg.text))) return;
    await bot.sendMessage(msg.chat.id,
      'Sorry, I do not know that command. Here is what I can do:\n\n' + commandListText(),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Continue ⬇️', callback_data: 'go:plans' }]] } });
    return;
  }

  const replied = msg.reply_to_message;
  if (replied && replied.from && String(replied.from.id) === botId) {
    const repliedText = support.messageText(replied);
    const couponGroup = parseCouponPrompt(repliedText);
    if (couponGroup) {
      await applyCoupon(msg, couponGroup);
      return;
    }
    const category = support.parsePrompt(repliedText);
    if (category) {
      await openTicket(msg, category, msg.from, support.parsePromptGroup(repliedText));
      return;
    }
    const ticketId = support.parseReplyLine(repliedText);
    if (ticketId) {
      await followUpTicket(msg, ticketId, msg.from);
      return;
    }
  }

  // A sticker, a location, a contact: nothing support can act on, but still a
  // person trying the bot, so they get pointed somewhere useful.
  if (!support.messageText(msg) && !support.hasMedia(msg) && isUnreadable(msg)) {
    await bot.sendMessage(msg.chat.id,
      'I can only read text and photos. Here is what I can do:\n\n' + commandListText(),
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Continue ⬇️', callback_data: 'go:plans' }]] } });
    return;
  }

  // Service messages (a join, a pinned message) carry neither.
  if (!support.messageText(msg) && !support.hasMedia(msg)) return;

  if (!allowFreeText(String(msg.from.id))) return;

  // Looking for an open ticket takes a sheet read; show that something is
  // happening rather than a silent chat.
  showTyping(msg.chat.id);

  // Someone mid-conversation with support just types again. That belongs in
  // the ticket they already have, not in a new one.
  const active = await findActiveTicket(msg.from.id);
  if (active) {
    await followUpTicket(msg, active.ticket_id, msg.from, { wasClosed: support.normaliseStatus(active.status) === 'closed' });
    return;
  }

  // Otherwise offer to turn it into a ticket. The offer replies to the
  // message, so the tap can find it again without any stored state.
  await bot.sendMessage(msg.chat.id,
    'Would you like to send this message to our support team?',
    {
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📨 Send to support', callback_data: 'sup:send' }],
          [{ text: '🆘 Browse help topics', callback_data: 'sup:menu' }],
          [{ text: '✖️ No thanks', callback_data: 'sup:dismiss' }]
        ]
      }
    });
  });

  /** A message a person sent that has no text or media support can use. */
  function isUnreadable(msg) {
  return ['sticker', 'location', 'venue', 'contact', 'poll', 'dice', 'game', 'story']
    .some((kind) => msg[kind]);
  }

  /** The influencer bot's @name, asked once and remembered. */
  let affiliateName;
  async function affiliateBotUsername() {
  if (affiliateName !== undefined) return affiliateName;
  affiliateName = String(process.env.AFFILIATE_BOT_USERNAME || '').replace(/^@/, '').trim() || null;
  if (!affiliateName && affiliateNotify.isConfigured()) {
    try {
      affiliateName = (await affiliateNotify.bot().getMe()).username || null;
    } catch (err) {
      console.error(`[bot] ${payBotEnv}: could not read the influencer bot's name — ${err.message}`);
      affiliateName = null;
    }
  }
  return affiliateName;
  }

  /** This bot's @username, fetched once. */
  let ownUsername = null;
  async function isAddressedToThisBot(mention) {
  if (!mention) return true;
  if (ownUsername === null) {
    try {
      ownUsername = String((await bot.getMe()).username || '');
    } catch (err) {
      return false;
    }
  }
  return ownUsername.toLowerCase() === String(mention).toLowerCase();
  }

  /**
   * findStudent — a Telegram id from "7234356929" or "@handle", searching this
   * family's member sheets for a handle.
   *
   * @returns {Promise<{telegramId: string, subscriber: Object|null}|null>}
   */
  async function findStudent(target) {
  const text = String(target || '').trim();
  if (/^\d{1,15}$/.test(text)) {
    const passes = await attempt(() => findSubscriptions(text), SUPPORT_SETTINGS_WAIT_MS, []);
    return { telegramId: text, subscriber: passes.length ? passes[0].subscriber : null };
  }
  const handle = text.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{4,32}$/.test(handle)) return null;
  for (const group of familyGroups()) {
    const found = await attempt(() => sheetFor(group.id).listSubscribers({ search: handle, pageSize: 20 }),
      SUPPORT_SETTINGS_WAIT_MS, null);
    const match = found && (found.subscribers || []).find((sub) => String(sub.username || '').toLowerCase() === handle);
    if (match) return { telegramId: String(match.telegram_id), subscriber: match };
  }
  return null;
  }

  /**
   * The queues an admin can list from the support chat: the query each sends
   * and how it is introduced. Keys are also the /tickets argument and the
   * sum:<key> button data.
   */
  const QUEUE_VIEWS = {
    needs: { title: '🔴 Needs reply — longest waiting first', query: { waitingOn: 'admin', sort: 'waiting' } },
    open: { title: '🆕 Open — not picked up yet', query: { status: 'open', sort: 'waiting' } },
    progress: { title: '🟡 In progress', query: { status: 'in_progress' } },
    student: { title: '⏳ Waiting for the student', query: { waitingOn: 'student' } },
    closed: { title: '✅ Recently closed', query: { status: 'closed' } }
  };

  /** "1 h 35 min" from minutes. */
  function minutesText(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '—';
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  return `${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} h` : ''}`;
  }

  /**
   * buildSupportSummary — the support numbers as one message with buttons to
   * list each queue.
   *
   * @returns {Promise<{html: string, keyboard: Object}>}
   */
  async function buildSupportSummary() {
  const family = esc(primaryGroup().label || primaryGroup().shortName);
  const stats = await sheetFor(primaryGroup().id).getSupportStats({ days: 7 });
  const c = (stats && stats.counts) || {};
  const reply = (stats && stats.first_reply_minutes) || {};
  const oldest = stats && stats.oldest_needs_reply;

  const openByIssue = Object.entries((stats && stats.by_category) || {})
    .map(([id, row]) => [id, (row.open || 0) + (row.in_progress || 0)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => {
      const category = support.categoryById(id);
      return `• ${esc(category.emoji)} ${esc(category.label)}: <b>${count}</b>`;
    });

  const groups = familyGroups();
  const byGroup = (stats && stats.by_group) || {};
  const groupRows = groups.length > 1
    ? [...groups.map((g) => [g.shortName, byGroup[g.id]]), ['Not specified', byGroup.unspecified]]
      .filter(([, row]) => row && row.open + row.in_progress > 0)
      .map(([name, row]) => `• ${esc(name)}: <b>${row.open + row.in_progress}</b> not closed` +
        (row.needs_reply ? ` · 🔴 ${row.needs_reply} need a reply` : ''))
    : [];

  const admins = Object.entries((stats && stats.by_admin) || {})
    .sort((a, b) => (b[1].replies + b[1].quick_replies) - (a[1].replies + a[1].quick_replies))
    .slice(0, 8)
    .map(([who, a]) => `• ${esc(who)}: ${a.replies + a.quick_replies} replies · ${a.closed} closed` +
      (a.invites_sent ? ` · ${a.invites_sent} invites` : '') +
      (a.passes_granted ? ` · ${a.passes_granted} passes granted` : ''));

  const oldestGroup = oldest && groupById(oldest.group);
  const lines = [
    `📊 <b>${family} — support summary</b>`,
    '',
    '<b>Tickets</b>',
    `🔴 Needs reply: <b>${c.needs_reply || 0}</b>`,
    `🆕 Open (not picked up): ${c.open || 0}`,
    `🟡 In progress: ${c.in_progress || 0}`,
    `⏳ Waiting for student: ${c.waiting_student || 0}`,
    `✅ Closed: ${c.closed || 0}`,
    `📁 All tickets: ${c.total || 0}`,
    '',
    '<b>Activity</b>',
    `📅 Today: ${stats ? stats.opened_today : 0} opened · ${stats ? stats.closed_today : 0} closed`,
    `⏱ First reply (7 days): ${reply.samples ? `average ${minutesText(reply.average)} · median ${minutesText(reply.median)}` : 'no replies yet'}`,
    oldest
      ? `⌛ Longest waiting: ${esc(oldest.name)} — <b>${minutesText(oldest.minutes)}</b> (${esc(support.categoryById(oldest.category).label)}` +
        (oldestGroup && groups.length > 1 ? ` · ${esc(oldestGroup.shortName)}` : '') + ')'
      : '⌛ Nobody is waiting for a reply 🎉'
  ];
  if (groupRows.length) lines.push('', '👥 <b>Not closed, by group</b>', ...groupRows);
  if (openByIssue.length) lines.push('', '📂 <b>Not closed, by issue</b>', ...openByIssue);
  if (admins.length) lines.push('', '🧑‍💼 <b>Admins, last 7 days</b>', ...admins);
  lines.push('', `<i>Updated ${esc(membership.formatIst(new Date()))}</i>`);

  const button = (text, view) => ({ text, callback_data: `sum:${view}` });
  const keyboard = {
    inline_keyboard: [
      [button(`🔴 Needs reply (${c.needs_reply || 0})`, 'needs'), button(`🆕 Open (${c.open || 0})`, 'open')],
      [button(`🟡 In progress (${c.in_progress || 0})`, 'progress'), button(`⏳ Waiting for student (${c.waiting_student || 0})`, 'student')],
      [button('✅ Recently closed', 'closed'), button('🔄 Refresh', 'refresh')]
    ]
  };
  return { html: lines.join('\n'), keyboard };
  }

  /**
   * postSupportSummary — sends the summary to the support chat, or updates the
   * summary message in place when refreshing.
   *
   * @returns {Promise<boolean>} true when something was posted or updated
   */
  async function postSupportSummary(chat, { extra = {}, editMessageId = null } = {}) {
  let summary;
  try {
    summary = await buildSupportSummary();
  } catch (err) {
    await bot.sendMessage(chat.chatId, `⚠️ Could not read the support numbers: ${esc(err.message)}`,
      supportChatOptions(chat, extra));
    return false;
  }
  if (editMessageId) {
    try {
      await bot.editMessageText(summary.html, {
        chat_id: chat.chatId, message_id: editMessageId, parse_mode: 'HTML', reply_markup: summary.keyboard
      });
      return true;
    } catch (err) {
      // "message is not modified" means nothing changed; anything else, post anew.
      if (/not modified/i.test(err.message)) return true;
    }
  }
  await bot.sendMessage(chat.chatId, summary.html, supportChatOptions(chat, Object.assign({ reply_markup: summary.keyboard }, extra)));
  return true;
  }

  /** A ticket from the sheet as a short card (status, issue, group, student, last message). */
  function ticketCardHtml(t) {
  const category = support.categoryById(t.category);
  const who = [t.name, t.username ? '@' + t.username : ''].filter(Boolean).join(' · ') || t.telegram_id;
  return `${support.statusLine(t.status, t.waiting_on)}\n\n` +
    `<b>Student:</b> ${esc(who)}\n` +
    `<b>Issue:</b> ${esc(category.emoji)} ${esc(category.label)}\n` +
    (familyGroups().length > 1 ? `<b>Group:</b> ${groupLine(t.group)}\n` : '') +
    `<b>Last activity:</b> ${esc(t.updated_at)} · ${t.picked_up_by ? `picked up by ${esc(t.picked_up_by)}` : 'not picked up yet'}\n` +
    `<blockquote>${esc(String(t.last_message || '').slice(0, 300))}</blockquote>`;
  }

  /** Lists one queue: a heading, then one message per ticket with its buttons. */
  async function postTicketQueue(chat, view, where = {}) {
  const spec = QUEUE_VIEWS[view] || QUEUE_VIEWS.needs;
  const reply = (html) => bot.sendMessage(chat.chatId, html, supportChatOptions(chat, where));
  let list;
  try {
    list = await sheetFor(primaryGroup().id).listTickets(Object.assign({ pageSize: 10 }, spec.query));
  } catch (err) {
    await reply(`⚠️ Could not read tickets: ${esc(err.message)}`);
    return;
  }
  const tickets = list.tickets || [];
  const counts = list.counts || {};
  await reply(
    `<b>${spec.title}</b> — ${list.total || 0} ticket${list.total === 1 ? '' : 's'}` +
    (list.total > tickets.length ? ` (showing ${tickets.length})` : '') + '\n\n' +
    `🔴 Needs reply: <b>${counts.needs_reply || 0}</b>\n` +
    `🆕 Open: ${counts.open || 0}\n` +
    `🟡 In progress: ${counts.in_progress || 0}\n` +
    `⏳ Waiting for student: ${counts.waiting_student || 0}\n` +
    `✅ Closed: ${counts.closed || 0}` +
    (tickets.length ? '' : '\n\nNothing here. 🎉'));

  // One message per ticket, each with its own buttons, so any of them can be
  // acted on straight from the list.
  for (const t of tickets) {
    await postToAdmins(chat, t.ticket_id, t.telegram_id, ticketCardHtml(t),
      { paymentId: support.findPaymentId(t.last_message), closed: support.normaliseStatus(t.status) === 'closed' });
  }
  }

  /** Taps on the summary's buttons. */
  async function handleSummaryCallback(query, data, ack) {
  const chat = supportChat();
  const message = query.message;
  if (!chat || !message || !message.chat || String(message.chat.id) !== chat.chatId) {
    await ack('This button only works in the support chat.');
    return;
  }
  const view = data.slice(4);
  if (view === 'show') {
    await ack('Counting tickets…');
    const where = {};
    if (message.message_thread_id) where.message_thread_id = message.message_thread_id;
    await postSupportSummary(chat, { extra: where });
    return;
  }
  if (view === 'refresh') {
    await ack('Refreshing…');
    await postSupportSummary(chat, { editMessageId: message.message_id });
    return;
  }
  if (!QUEUE_VIEWS[view]) {
    await ack();
    return;
  }
  await ack();
  const where = {};
  if (message.message_thread_id) where.message_thread_id = message.message_thread_id;
  await postTicketQueue(chat, view, where);
  }

  /** The newest tickets a student has, newest first, or [] when they cannot be read. */
  async function ticketsOf(telegramId, pageSize = 5) {
  const list = await attempt(
    () => sheetFor(primaryGroup().id).listTickets({ telegramId: String(telegramId), pageSize }),
    SUPPORT_SETTINGS_WAIT_MS, null);
  return (list && list.tickets) || [];
  }

  /** Short lines for a student's tickets. */
  function ticketListLines(tickets) {
  return tickets.map((t) => {
    const category = support.categoryById(t.category);
    const group = groupById(t.group);
    return `• <code>${esc(t.ticket_id)}</code> · ${support.statusLine(t.status, t.waiting_on)}\n` +
      `   ${esc(category.label)}${group && familyGroups().length > 1 ? ` · ${esc(group.shortName)}` : ''} · ${esc(support.shortDate(t.updated_at))}`;
  });
  }

  /**
   * findPaymentForAdmins — /find pay_… in the support chat: what Razorpay
   * says, which group's records hold it and for whom, and that student's
   * tickets. The buttons of their newest ticket come with it, so an admin can
   * grant or reply without searching further.
   */
  async function findPaymentForAdmins(chat, paymentId, where) {
  const result = await checkPayment(paymentId, null);
  const payerId = result.payment && result.payment.notes && result.payment.notes.telegram_id
    ? String(result.payment.notes.telegram_id) : '';

  const recorded = [];
  let recordsUnreadable = false;
  for (const group of familyGroups()) {
    try {
      const record = await within(findRecordedPayment(group, paymentId), SUPPORT_SETTINGS_WAIT_MS, undefined);
      if (record === undefined) recordsUnreadable = true;
      else if (record) recorded.push({ group, telegramId: String(record.telegram_id || '') });
    } catch (err) {
      recordsUnreadable = true;
    }
  }

  const lines = [result.html, '', '📒 <b>Our records</b>'];
  if (recorded.length) {
    recorded.forEach((r) => lines.push(`✅ Recorded in <b>${esc(r.group.shortName)}</b> for Telegram id <code>${esc(r.telegramId)}</code>`));
  } else if (recordsUnreadable) {
    lines.push('⚠️ Could not read every group\'s records just now — try again in a minute.');
  } else {
    lines.push(result.captured
      ? '⚠️ <b>Not recorded in any group.</b> The money arrived but no pass was given — open the student\'s ticket and tap "✅ Grant pass for this payment".'
      : 'Not recorded in any group.');
  }

  const studentId = payerId || (recorded[0] && recorded[0].telegramId) || '';
  let latest = null;
  if (studentId) {
    const tickets = await ticketsOf(studentId, 3);
    latest = tickets[0] || null;
    lines.push('', `🎫 <b>Tickets from <code>${esc(studentId)}</code></b>`);
    lines.push(tickets.length ? ticketListLines(tickets).join('\n') : 'None.');
    if (latest) lines.push('', `<i>Buttons below act on ${esc(latest.ticket_id)}.</i>`);
  }

  const options = supportChatOptions(chat, where);
  if (latest) {
    const keyboard = support.adminKeyboard(latest.ticket_id, studentId,
      { paymentId, closed: support.normaliseStatus(latest.status) === 'closed' });
    if (result.captured) {
      keyboard.inline_keyboard.splice(2, 0, [{
        text: '✅ Grant pass for this payment',
        callback_data: `adm:g:${latest.ticket_id}:${studentId}:${paymentId}`
      }]);
    }
    options.reply_markup = keyboard;
  }
  await bot.sendMessage(chat.chatId, lines.join('\n'), options);
  }

  /** /find T-… — the ticket as a card with its buttons. */
  async function findTicketForAdmins(chat, ticketId, where) {
  const found = await readTicket(ticketId);
  if (!found) {
    await bot.sendMessage(chat.chatId, `⚠️ No ticket <code>${esc(ticketId)}</code> in this bot's sheet.`,
      supportChatOptions(chat, where));
    return;
  }
  await postToAdmins(chat, found.ticket_id, found.telegram_id, ticketCardHtml(found), {
    extra: where,
    paymentId: support.findPaymentId(found.conversation),
    closed: support.normaliseStatus(found.status) === 'closed'
  });
  }

  /** /find 7234356929 or @username — the student's passes and tickets. */
  async function findStudentForAdmins(chat, target, where) {
  const student = await findStudent(target);
  if (!student) {
    await bot.sendMessage(chat.chatId,
      `⚠️ No student found for <code>${esc(target)}</code>. Use a Telegram id, a pay_ id, a ticket id, ` +
      'or the @username of someone who has bought a pass.', supportChatOptions(chat, where));
    return;
  }
  const [passes, tickets] = await Promise.all([studentSnapshot(student.telegramId), ticketsOf(student.telegramId, 5)]);
  const sub = student.subscriber || {};
  const who = [sub.name, sub.username ? '@' + sub.username : ''].filter(Boolean).join(' · ');
  const latest = tickets[0];
  const lines = [
    `👤 <b>Student</b> <code>${esc(student.telegramId)}</code>${who ? ` · ${esc(who)}` : ''}`,
    '',
    '🎟 <b>Access</b>',
    passLines(passes, latest ? latest.group : ''),
    '',
    '🎫 <b>Tickets</b>',
    tickets.length ? ticketListLines(tickets).join('\n') : 'None.'
  ];
  if (latest) lines.push('', `<i>Buttons below act on ${esc(latest.ticket_id)}.</i>`);
  const options = supportChatOptions(chat, where);
  if (latest) {
    options.reply_markup = support.adminKeyboard(latest.ticket_id, student.telegramId,
      { closed: support.normaliseStatus(latest.status) === 'closed' });
  }
  await bot.sendMessage(chat.chatId, lines.join('\n'), options);
  }

  /**
   * handleSupportChatMessage — admins answering from the support chat.
   *
   * Anyone in that chat is treated as an admin, so it must be a private group
   * of admins. Several family bots can share one chat: a reply is only acted on
   * by the bot that posted the ticket being replied to.
   */
  async function handleSupportChatMessage(msg, chat) {
  const command = support.parseCommand(msg.text);
  if (command && !(await isAddressedToThisBot(command.mention))) return;

  const admin = adminName(msg.from);
  const where = { reply_to_message_id: msg.message_id };
  if (msg.message_thread_id) where.message_thread_id = msg.message_thread_id;

  const replied = msg.reply_to_message;
  const ticket = replied && replied.from && String(replied.from.id) === botId
    ? support.parseTicketHeader(support.messageText(replied))
    : null;

  if (ticket) {
    if (command && (command.name === 'close' || command.name === 'reopen')) {
      await setStatusFromChat(chat, ticket, command.name === 'close' ? 'closed' : 'open', admin, where);
      return;
    }
    if (command && command.name === 'invite') {
      const results = await resendInvites(ticket.telegramId, { ticketId: ticket.ticketId, actor: admin });
      await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
        `🔗 <b>Send new invite link</b> · by ${esc(admin)}\n\n${describeInviteResults(results)}`, { extra: where });
      return;
    }
    if (command) return;

    const text = support.messageText(msg);
    if (!text && !support.hasMedia(msg)) return;

    if (support.hasMedia(msg)) {
      try {
        await bot.copyMessage(ticket.telegramId, msg.chat.id, msg.message_id, {
          caption: `${support.replyLine(ticket.ticketId)}\n\n${text}`.slice(0, 1000)
        });
      } catch (err) {
        await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
          `⚠️ <b>Not delivered</b>: ${esc(err.message)}\nThe student may have blocked the bot.`, { extra: where });
        return;
      }
      try {
        await sheetFor(primaryGroup().id).appendTicketMessage(ticket.ticketId, {
          author: `Admin ${admin}`, text: text || '(attachment)', handledBy: admin
        });
      } catch (err) {
        console.error(`[support] ${payBotEnv}: could not record the answer to ${ticket.ticketId} — ${err.message}`);
      }
    } else {
      const outcome = await sendAdminAnswer(ticket.ticketId, ticket.telegramId, text, admin);
      if (!outcome.delivered) {
        await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
          `⚠️ <b>Not delivered</b>: ${esc(outcome.error)}\nThe student may have blocked the bot.`, { extra: where });
        return;
      }
    }

    await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
      `✅ <b>Delivered to the student</b> · by ${esc(admin)}\nStatus: ${support.statusLine('in_progress', 'student')}`,
      { extra: where });
    return;
  }

  // A payment id pasted into the chat is looked up straight away.
  if (!command) {
    const pasted = support.findPaymentId(support.messageText(msg));
    if (pasted) await findPaymentForAdmins(chat, pasted, where);
    return;
  }
  const family = esc(primaryGroup().label || primaryGroup().shortName);
  const reply = (html) => bot.sendMessage(chat.chatId, html, supportChatOptions(chat, where));

  if (command.name === 'find') {
    const target = command.args.split(/\s+/)[0] || '';
    const paymentId = support.findPaymentId(target);
    const ticketId = (target.match(new RegExp(`^${support.TICKET_ID_PATTERN}$`, 'i')) || [])[0];
    if (paymentId) {
      await findPaymentForAdmins(chat, paymentId, where);
    } else if (ticketId) {
      await findTicketForAdmins(chat, ticketId.toUpperCase(), where);
    } else if (target) {
      await findStudentForAdmins(chat, target, where);
    } else {
      await reply('Usage:\n<code>/find pay_XXXXXXXXXXXXXX</code> — a payment\n' +
        '<code>/find 7234356929</code> or <code>/find @username</code> — a student\n' +
        '<code>/find T-260917-AB2C</code> — a ticket\n\n' +
        '<i>Tip: pasting a pay_ id into this chat looks it up too.</i>');
    }
    return;
  }

  if (command.name === 'msg') {
    const target = command.args.split(/\s+/)[0] || '';
    const text = command.args.slice(target.length).trim();
    if (text.length > support.MAX_MESSAGE_CHARS) {
      await reply(`⚠️ That message is ${text.length} characters; the limit is ${support.MAX_MESSAGE_CHARS}.`);
      return;
    }
    if (!target || !text) {
      await reply('Usage: <code>/msg 7234356929 your message</code> or <code>/msg @username your message</code>');
      return;
    }
    const student = await findStudent(target);
    if (!student) {
      await reply(`⚠️ No student found for <code>${esc(target)}</code>. Use their Telegram id (shown on every ticket), ` +
        'or the @username of someone who has bought a pass.');
      return;
    }
    const ticketId = support.newTicketId();
    try {
      await bot.sendMessage(student.telegramId, support.studentReplyHtml(ticketId, text), { parse_mode: 'HTML' });
    } catch (err) {
      await reply(`⚠️ <b>Not delivered</b> to <code>${esc(student.telegramId)}</code>: ${esc(err.message)}\n` +
        'They may never have started this bot, or have blocked it.');
      return;
    }
    const sub = student.subscriber || {};
    try {
      await sheetFor(primaryGroup().id).createTicket({
        ticket_id: ticketId,
        telegram_id: student.telegramId,
        username: sub.username || '',
        name: sub.name || '',
        category: 'other',
        bot: payBotEnv,
        message: text,
        opened_by: admin
      });
    } catch (err) {
      console.error(`[support] ${payBotEnv}: could not record /msg ticket ${ticketId} — ${err.message}`);
    }
    await postToAdmins(chat, ticketId, student.telegramId,
      `📤 <b>Message sent</b> by ${esc(admin)} to ${esc(sub.name || (sub.username ? '@' + sub.username : student.telegramId))}\n` +
      `<blockquote>${esc(text)}</blockquote>\nStatus: ${support.statusLine('in_progress', 'student')}`,
      { extra: where });
    return;
  }

  if (command.name === 'summary' || command.name === 'stats') {
    await postSupportSummary(chat, { extra: where });
    return;
  }

  if (command.name === 'tickets') {
    const requested = String(command.args || '').split(/\s+/)[0].toLowerCase();
    await postTicketQueue(chat, QUEUE_VIEWS[requested] ? requested : 'needs', where);
    return;
  }

  if (command.name === 'settings') {
    settingsCache.invalidate();
    const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
    const lines = support.SETTINGS.map((def) => {
      const value = String(settings[def.key] || '');
      const shown = value.length > 60 ? value.slice(0, 60) + '…' : (value || '(default)');
      return `<code>${def.key}</code>: ${esc(shown)}`;
    });
    await reply(
      `<b>${family} — bot settings</b>\n\n${lines.join('\n')}\n\n` +
      'Change one with <code>/set key new value</code>, or use the dashboard.');
    return;
  }

  if (command.name === 'set') {
    const key = command.args.split(/\s+/)[0] || '';
    const value = command.args.slice(key.length).trim();
    const checked = support.validateSettingsPatch(key ? { [key]: value } : {});
    if (!checked.ok) {
      await reply(`⚠️ ${esc(checked.error)}\n\nUsage: <code>/set key new value</code>`);
      return;
    }
    try {
      await sheetFor(primaryGroup().id).updateBotSettings(checked.value, admin);
      settingsCache.invalidate();
      await reply(`✅ <code>${esc(key)}</code> updated by ${esc(admin)}.`);
    } catch (err) {
      await reply(`⚠️ Could not save: ${esc(err.message)}`);
    }
    return;
  }

  if (command.name === 'supporthelp') {
    await reply(
      `<b>${family} — how to handle support</b>\n\n` +
      'Every ticket arrives here with the issue, <b>which group it is about</b>, the student\'s passes in each group ' +
      '(📌 marks the ticket\'s group), what they wrote, and a 🧭 next step. Buttons underneath:\n\n' +
      '✍️ <b>Write reply</b> — type your own answer\n' +
      '📋 <b>Quick replies</b> — ready answers (payment not received, send proof, still processing, pass expired, ' +
      'link sent, resolved)\n' +
      '🔗 <b>Send new invite link</b> — only works if their pass is valid\n' +
      '🎟 <b>Pass & payment</b> — their passes right now\n' +
      '🔍 <b>Check payment</b> — appears when they mention a pay_ id; asks Razorpay\n' +
      '✅ <b>Grant pass for this payment</b> — after a check shows the money arrived but no pass\n' +
      '📜 <b>History</b> — the whole conversation and recent actions\n' +
      '📊 <b>Summary</b> — how many tickets need a reply, are open, in progress or closed\n' +
      '✅ <b>Close ticket</b> / 🔓 <b>Reopen</b> — closing tells the student it is resolved\n\n' +
      'You can also simply reply to any ticket message.\n\n' +
      '<b>Statuses</b> — only an admin closes a ticket\n' +
      `${support.statusLabel('open')} — ${esc(support.STATUS_MEANINGS.open)}\n` +
      `${support.statusLabel('in_progress')} — ${esc(support.STATUS_MEANINGS.in_progress)}\n` +
      `${support.statusLabel('closed')} — ${esc(support.STATUS_MEANINGS.closed)}\n` +
      `${support.WAITING_LABELS.admin} — the student wrote last and is waiting for you\n` +
      `${support.WAITING_LABELS.student} — you wrote last\n\n` +
      '<b>Commands</b>\n' +
      '<code>/summary</code> — how many tickets need a reply, are open, in progress or closed, with buttons to list each\n' +
      '<code>/tickets</code> — tickets needing a reply (or <code>/tickets open</code>, <code>progress</code>, <code>student</code>, <code>closed</code>)\n' +
      '<code>/find pay_…</code> — look up a payment: Razorpay status, which group recorded it, the student\'s tickets. ' +
      'Pasting a pay_ id into this chat does the same.\n' +
      '<code>/find 7234356929</code>, <code>/find @username</code>, <code>/find T-…</code> — a student or a ticket\n' +
      '<code>/msg 7234356929 text</code> or <code>/msg @username text</code> — message a student first\n' +
      '<code>/settings</code> · <code>/set key value</code> — bot texts\n' +
      'Everything is logged in the sheet\'s Support and Support Log tabs.');
  }
  }

  // ---------------------------------------------------------------------------
  // Guarding the groups
  // ---------------------------------------------------------------------------

  /** Which of this bot's groups a chat id belongs to, if any. */
  function groupForChat(chatId) {
  return familyGroups().find((g) => String(g.telegramGroupId) === String(chatId)) || null;
  }

  // A join request is Telegram telling us exactly who is asking and which group
  // they are asking about — the two things an invite link cannot carry. Approve
  // only someone with a live pass FOR THAT GROUP. This is what stops an English
  // invite opening the Telugu group: the request names the chat, and the check
  // is made against that chat's sheet, not against "any group in the family".
  bot.on('chat_join_request', async (req) => {
  const user = req.from || {};
  const group = groupForChat(req.chat && req.chat.id);

  // A request for a chat this bot does not sell is somebody else's business.
  if (!group) return;

  try {
    const result = await membership.handleJoinRequest(group.id, user.id);
    console.log(
      `[join] ${group.id}: ${result.approved ? 'APPROVED' : 'DECLINED'} ` +
      `${user.id} (@${user.username}) — ${result.reason}`
    );

    // Let in: say so, with a button straight into the group, rather than
    // leaving them to notice Telegram's small "request approved" line.
    if (result.approved) {
      try {
        await bot.sendMessage(user.id,
          `🎉 <b>Welcome to ${esc(group.shortName)}!</b>\n\n` +
          'You are in. Tap below to open the group — new questions are posted there every day.' +
          (result.expiry && !/^lifetime/i.test(result.expiry) ? `\n\nYour access runs until <b>${esc(result.expiry)}</b>.` : '') +
          '\n\n<i>Send /status here any time to see your pass.</i>',
          {
            parse_mode: 'HTML',
            reply_markup: result.inviteLink
              ? { inline_keyboard: [[{ text: `📚 Open ${group.shortName}`, url: result.inviteLink }]] }
              : undefined
          });
      } catch (err) {
        // They have never messaged this bot (an admin let them in); nothing is lost.
      }
      return;
    }

    if (!result.approved) {
      // Telling them why turns a silent rejection into something they can act
      // on. The common case is a forwarded link, or a pass for the other
      // language's group.
      try {
        await bot.sendMessage(user.id,
          `❌ <b>That invite is not for this account.</b>\n\n` +
          `Access to <b>${esc(group.shortName)}</b> is tied to the Telegram account that ` +
          'paid for it, and a pass for one group does not open another.\n\n' +
          'Send /plans to buy your own.',
          { parse_mode: 'HTML' });
      } catch (err) {
        // Expected when they have never messaged this bot; nothing is lost.
      }
    }
  } catch (err) {
    console.error(`[join] ${group.id}: could not handle request from ${user.id} — ${err.message}`);
  }
  });

  // Behind the join request, a net for the ways into a group that skip it: an
  // admin adding someone by hand, or a link made in the Telegram client.
  bot.on('chat_member', async (update) => {
  const group = groupForChat(update.chat && update.chat.id);
  if (!group) return;

  const next = update.new_chat_member || {};
  const user = next.user || {};
  if (!['member', 'restricted'].includes(next.status)) return;
  if (user.is_bot) return;

  try {
    const result = await membership.enforceMembership(group.id, user.id);
    if (result.removed) {
      console.log(`[guard] ${group.id}: removed ${user.id} (@${user.username}) — ${result.reason}`);
    }
  } catch (err) {
    console.error(`[guard] ${group.id}: check failed for ${user.id} — ${err.message}`);
  }
  });

  bot.on('polling_error', (err) => {
    console.error(`[bot] ${payBotEnv} polling error: ${err.message}`);
  });

  return {
    payBotEnv, bot, familyGroups, plansFor, ALLOWED_UPDATES, settle, primaryGroup, settingsCache,
    resendInvites, describeInviteResults, studentSnapshot, suggestFor: support.suggestNextStep,
    checkPayment, grantForPayment, passFor, postSupportSummary, supportChat
  };

}

module.exports = { createPaymentBot };
