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

  /** Keyboard with a single button that opens the support menu. */
  const SUPPORT_BUTTON = { inline_keyboard: [[{ text: '🆘 Support', callback_data: 'sup:menu' }]] };

  /** How long /start waits for settings before greeting without the extra note. */
  const START_SETTINGS_WAIT_MS = 2500;

  /** How long a support flow waits for settings before using the defaults. */
  const SUPPORT_SETTINGS_WAIT_MS = 8000;

  /**
   * The family's first group. A bot's settings are read from, and its tickets
   * written to, this group's sheet, so a student in a two-group family never
   * has a ticket split across sheets.
   */
  function primaryGroup() {
  return familyGroups()[0];
  }

  const botId = support.botIdFromToken(process.env[payBotEnv]);

  const settingsCache = support.createSettingsCache({
    load: () => sheetFor(primaryGroup().id).getBotSettings()
  });

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
  function groupKeyboard() {
  return {
    inline_keyboard: familyGroups().map((group) => ([{
      text: `${group.language === 'Telugu' ? '🇮🇳' : '🔤'} ${group.shortName}`,
      callback_data: `pick:${group.id}`
    }]))
  };
  }

  /** The "which group?" message. */
  function chooseGroupMessage() {
  const groups = familyGroups();
  return '<b>Which group do you want to join?</b>\n\n' +
    groups.map((g, i) => `${i + 1}. <b>${esc(g.shortName)}</b>`).join('\n') +
    '\n\n<i>Both cost the same. Your pass and invite are for the group you pick — ' +
    'the link will not let you into the other one.</i>';
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
  if (pass.validUntil) lines.push(`📅 Valid until <b>${esc(pass.validUntil)}</b>`);
  if (applied) {
    lines.push(`🎟 Coupon <b>${esc(applied.code)}</b> applied — ${esc(applied.label)}`);
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
  return {
    inline_keyboard: [
      [{
        text: `💳 Pay ${pricing.rupees(amount)}`,
        callback_data: `buy:${group.id}:${pass.id}${applied ? ':' + applied.code : ''}`
      }],
      applied
        ? [{ text: '✖️ Remove coupon', callback_data: `pick:${group.id}` }]
        : [{ text: '🎟 Apply coupon code', callback_data: `cpn:${group.id}` }]
    ]
  };
  }

  /** Sends one group's pass, optionally with a coupon applied. */
  async function sendPass(chatId, group, applied = null) {
  const pass = await passFor(group.id);
  if (!pass) {
    await bot.sendMessage(chatId, 'Nothing is on sale for this group right now. Please check back soon.');
    return;
  }
  await bot.sendMessage(chatId, passMessage(group, pass, applied), {
    parse_mode: 'HTML',
    reply_markup: passKeyboard(group, pass, applied)
  });
  }

  /**
   * offerGroups — the entry point for a student.
   *
   * With one group in the family this goes straight to that group's pass;
   * with two it asks first. Either way the student only ever sees groups this
   * bot is responsible for.
   */
  async function offerGroups(chatId) {
  const groups = familyGroups();

  if (groups.length === 1) {
    await sendPass(chatId, groups[0]);
    return;
  }

  await bot.sendMessage(chatId, chooseGroupMessage(), {
    parse_mode: 'HTML',
    reply_markup: groupKeyboard()
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
  if (!allowCouponCheck(String(telegramId))) {
    return {
      pass,
      result: { ok: false, reason: 'Too many coupon attempts. Please wait a few minutes before trying another code.' }
    };
  }
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
  return { pass, result: pricing.evaluateCoupon(coupon, { amountPaise: pass.amountPaise }) };
  }

  /** Buttons after a coupon was refused. */
  function couponRetryKeyboard(group) {
  return {
    inline_keyboard: [
      [{ text: '🎟 Try another code', callback_data: `cpn:${group.id}` }],
      [{ text: '💳 Continue at full price', callback_data: `pick:${group.id}` }]
    ]
  };
  }

  /** A student's reply to the coupon prompt. */
  async function applyCoupon(msg, group) {
  const code = pricing.normaliseCode(msg.text);
  if (!pricing.COUPON_CODE_PATTERN.test(code)) {
    await bot.sendMessage(msg.chat.id,
      '❌ That does not look like a coupon code. Codes are letters and numbers without spaces.',
      { reply_markup: couponRetryKeyboard(group) });
    return;
  }
  const { pass, result } = await checkCoupon(code, msg.from.id, group);
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
  const found = [];
  for (const group of familyGroups()) {
    try {
      const subscriber = await sheetFor(group.id).getSubscriber(telegramId);
      if (subscriber) found.push({ group, subscriber });
    } catch (err) {
      console.error(`[bot] could not read ${group.id}: ${err.message}`);
    }
  }
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
  function studentCommand(pattern, handler) {
    bot.onText(pattern, async (msg, match) => {
      if (!msg || !msg.chat || msg.chat.type !== 'private') return;
      await handler(msg, match);
    });
  }

  studentCommand(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
  const name = msg.from.first_name || 'there';
  const groups = familyGroups();
  const what = groups.length === 1
    ? `the <b>${esc(groups[0].shortName)}</b> group`
    : `our <b>${esc(groups[0].label)}</b> groups`;

  // Bounded: a slow sheet must never hold up the greeting.
  const settings = await settingsWithin(START_SETTINGS_WAIT_MS);
  const note = settings.welcome_note ? `${esc(settings.welcome_note)}\n\n` : '';

  await bot.sendMessage(msg.chat.id,
    `👋 Hello ${esc(name)}!\n\n` +
    `This bot gives you access to ${what} — daily practice questions with ` +
    'explanations.\n\n' +
    note +
    'Commands:\n' +
    '/plans — see the passes and subscribe\n' +
    '/status — check your current pass\n' +
    '/help — how it all works\n' +
    '/support — get help with a problem',
    { parse_mode: 'HTML' }
  );
  await offerGroups(msg.chat.id);
  });

  studentCommand(/^\/plans(?:@\w+)?(?:\s|$)/, async (msg) => {
  await offerGroups(msg.chat.id);
  });

  studentCommand(/^\/status(?:@\w+)?(?:\s|$)/, async (msg) => {
  try {
    const held = await findSubscriptions(msg.from.id);

    if (!held.length) {
      await bot.sendMessage(msg.chat.id,
        'You do not have a pass yet.\n\nSend /plans to see the options.',
        { parse_mode: 'HTML' });
      await offerGroups(msg.chat.id);
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

  studentCommand(/^\/help(?:@\w+)?(?:\s|$)/, async (msg) => {
  const many = familyGroups().length > 1;
  const steps = [
    many ? 'Send /plans and choose your group.' : 'Send /plans to see the pass.',
    'Got a coupon? Tap <b>🎟 Apply coupon code</b> and type it — the new price is shown before you pay.',
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
    'You will get a reminder before your pass ends. Check /status any time.\n\n' +
    'Trouble? Send /support, or just type your question here.',
    { parse_mode: 'HTML', reply_markup: SUPPORT_BUTTON }
  );
  });

  studentCommand(/^\/cancel(?:@\w+)?(?:\s|$)/, async (msg) => {
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

  // ---------------------------------------------------------------------------
  // Buying a pass
  // ---------------------------------------------------------------------------

  bot.on('callback_query', async (query) => {
  const data = String(query.data || '');
  const user = query.from;

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

  // ---- picking a group ----------------------------------------------------
  // pick:<groupId> also means "show the pass again without a coupon".
  if (data.startsWith('pick:')) {
    const group = familyGroup(data.slice(5));
    if (!group) {
      await ack('That group is not available here.');
      return;
    }
    await ack();
    await sendPass(user.id, group);
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
      `${esc(couponPromptLine(group))}\n\nType your coupon code and send it as a reply to this message.`,
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

  let applied = null;
  if (code) {
    const { result } = await checkCoupon(code, user.id, group);
    if (!result.ok) {
      await ack('That coupon cannot be used.');
      await bot.sendMessage(user.id, `❌ <b>${esc(pricing.normaliseCode(code))}</b>: ${esc(result.reason)}`,
        { parse_mode: 'HTML', reply_markup: couponRetryKeyboard(group) });
      return;
    }
    applied = result;
  }

  await ack('Creating your payment link…');

  try {
    // Buying the same fixed-date pass twice buys nothing: say so instead.
    const existing = await sheetFor(groupId).getSubscriber(user.id);
    if (existing && existing.status === 'active') {
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
    const amount = applied ? applied.finalPaise : pass.amountPaise;

    await bot.sendMessage(user.id,
      `${esc(pass.emoji)} <b>${esc(pass.label)}</b>\n` +
      `for <b>${esc(group.shortName)}</b>\n\n` +
      (pass.validUntil ? `📅 Valid until <b>${esc(pass.validUntil)}</b>\n` : '') +
      `💰 You pay <b>${pricing.rupees(amount)}</b>` +
      (applied ? ` (coupon ${esc(applied.code)}, you save ${pricing.rupees(applied.discountPaise)})` : '') +
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
      coupon_code: applied.code,
      original_amount: String(pass.amountPaise / 100),
      discount_amount: String(applied.discountPaise / 100)
    });
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
  return { url: link.short_url };
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

  /** The line students see when tickets are switched off or cannot be raised. */
  function contactLine(settings) {
  return settings.support_contact ? `\n\nYou can also reach us at ${esc(settings.support_contact)}.` : '';
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
    `<i>Support hours: ${esc(settings.support_hours)}</i>`,
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

  /** Asks the student to describe the problem, as a message they reply to. */
  async function sendSupportPrompt(chatId, category) {
  const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
  if (!support.ticketsEnabled(settings)) {
    await bot.sendMessage(chatId,
      'Support tickets are not being taken through the bot right now.' + contactLine(settings),
      { parse_mode: 'HTML' });
    return;
  }
  await bot.sendMessage(chatId,
    `${esc(support.promptLine(category))}\n\n` +
    'Describe the problem in one message. If it is about a payment, include the payment ID or ' +
    'attach a screenshot.\n\n<i>Reply to this message.</i>',
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

  /** A student's passes, one bullet per group, for the support chat. */
  function passLines(passes) {
  if (!passes || !passes.length) return '• No groups found for this bot';
  return passes.map((p) => {
    const name = esc(p.group.shortName);
    if (p.error) return `• <b>${name}</b>: ⚠️ ${esc(p.reason)}`;
    if (!p.subscriber) return `• <b>${name}</b>: no pass on record`;
    const sub = p.subscriber;
    const state = p.eligible ? `✅ valid until ${esc(sub.expiry_date)}` : `⛔ ${esc(p.reason)}`;
    const where = p.inGroup === 'yes' ? 'in the group'
      : p.inGroup === 'no' ? '<b>NOT in the group</b>' : 'group membership unknown';
    const details = [
      sub.plan_label || sub.plan,
      sub.total_paid ? `paid ₹${sub.total_paid}` : '',
      sub.payment_id ? sub.payment_id : '',
      sub.last_payment_at ? `last payment ${sub.last_payment_at}` : ''
    ].filter(Boolean).map(esc).join(' · ');
    return `• <b>${name}</b>: ${state} · ${where}` + (details ? `\n   ${details}` : '');
  }).join('\n');
  }

  /** Posts one message about a ticket into the support chat, with the admin buttons. */
  async function postToAdmins(chat, ticketId, telegramId, html, { closed = false, paymentId = '', extra = {} } = {}) {
  return bot.sendMessage(chat.chatId,
    `${support.ticketHeader(ticketId, telegramId)}\n${html}`,
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

  const DIVIDER = '━━━━━━━━━━━━━━';

  /**
   * notifyAdmins — posts a new ticket, or a student's reply to one, into the
   * support chat as a complete case file: who, what they hold, what they
   * wrote, what to do next, and buttons to do it.
   *
   * @returns {Promise<boolean>} true when the admins were reached
   */
  async function notifyAdmins({ ticketId, user, category, text, passes, source, followUp, conversation, status, reopened }) {
  const chat = supportChat();
  if (!chat) return false;

  // Telegram refuses anything over 4096 characters, and a refused post is a
  // ticket nobody sees. The full text is always in the sheet and 📜 History.
  const body = String(text || '(attachment below)');
  const shown = body.length > 2000 ? body.slice(0, 2000) + '… (cut short — tap 📜 History)' : body;
  const paymentId = support.findPaymentId(body) || support.findPaymentId(conversation);

  const lines = [];
  if (followUp) {
    lines.push(reopened
      ? `🔁 <b>STUDENT WROTE ON A CLOSED TICKET — REOPENED</b> · ${esc(displayUser(user))}`
      : `↩️ <b>STUDENT REPLIED</b> · ${esc(displayUser(user))}`);
    lines.push(`Status: ${support.statusLine(status || 'open', 'admin')}`);
    const earlier = support.earlierConversation(conversation, 1200);
    if (earlier) lines.push('', '📜 <b>Earlier in this ticket</b>', `<blockquote>${esc(earlier)}</blockquote>`);
    lines.push('💬 <b>New message</b>', `<blockquote>${esc(shown)}</blockquote>`);
  } else {
    lines.push(`🆕 <b>NEW TICKET</b> · ${esc(category.emoji)} ${esc(category.label)}`);
    lines.push(`Status: ${support.statusLine('open', 'admin')}`);
    lines.push(DIVIDER);
    lines.push(`👤 <b>Student:</b> ${esc(displayUser(user))} · <code>${esc(user.id)}</code>`);
    lines.push('🎟 <b>Passes</b>', passLines(passes));
    lines.push(DIVIDER);
    lines.push('💬 <b>What they wrote</b>', `<blockquote>${esc(shown)}</blockquote>`);
    lines.push(`🧭 <b>Suggested:</b> ${esc(support.suggestNextStep(category.id, passes))}`);
  }

  try {
    await postToAdmins(chat, ticketId, user.id, lines.join('\n'), { paymentId });
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not reach the support chat — ${err.message}`);
    return false;
  }

  if (source && support.hasMedia(source)) {
    try {
      const caption = `${support.ticketHeader(ticketId, user.id)}\n${support.messageText(source)}`.slice(0, 1000);
      const options = supportChatOptions(chat, { caption });
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
  async function openTicket(source, category, user) {
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
  const [saved, passes] = await Promise.all([
    Promise.resolve().then(() => sheetFor(primaryGroup().id).createTicket({
      ticket_id: ticketId,
      telegram_id: String(user.id),
      username: user.username || '',
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      category: category.id,
      bot: payBotEnv,
      message: text || '(attachment)'
    })).then(() => true, (err) => {
      console.error(`[support] ${payBotEnv}: could not record ticket ${ticketId} — ${err.message}`);
      return false;
    }),
    studentSnapshot(user.id)
  ]);

  const delivered = await notifyAdmins({ ticketId, user, category, text, passes, source });

  if (!saved && !delivered) {
    await bot.sendMessage(user.id,
      '⚠️ Could not submit your ticket just now. Please try again in a few minutes.' + contactLine(settings),
      { parse_mode: 'HTML' });
    return;
  }

  await bot.sendMessage(user.id,
    `${esc(support.receivedLine(ticketId))}\n\n` +
    `Thanks — an admin will reply <b>${esc(settings.support_response_time)}</b>, right here in this chat.\n` +
    `Support hours: ${esc(settings.support_hours)}\n\n` +
    '<i>To add more details, just send another message.</i>',
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
      text: text || '(attachment)'
    });
    saved = Boolean(ticket);
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not add to ticket ${ticketId} — ${err.message}`);
  }

  const delivered = await notifyAdmins({
    ticketId, user, text, source, followUp: true,
    conversation: ticket && ticket.conversation,
    status: ticket ? ticket.status : 'open',
    reopened: Boolean((ticket && ticket.reopened) || options.wasClosed)
  });

  if (!saved && !delivered) {
    await bot.sendMessage(user.id,
      '⚠️ Could not add that to your ticket just now. Please try again in a few minutes.');
    return;
  }
  await bot.sendMessage(user.id,
    `${esc(support.receivedLine(ticketId))}\n\n` +
    ((ticket && ticket.reopened) || options.wasClosed
      ? 'Your earlier ticket has been reopened and an admin will reply here.\n\n'
      : 'Added to your ticket. An admin will reply here.\n\n') +
    '<i>Different problem? Send /support to open a new ticket.</i>',
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
  const owner = notes.telegram_id
    ? (String(notes.telegram_id) === String(telegramId)
      ? '✅ made from this student\'s checkout'
      : `⚠️ made from the checkout of Telegram id <code>${esc(notes.telegram_id)}</code>, not this student`)
    : 'no Telegram id on the payment itself — compare the time and amount with what the student says';

  const lines = [
    `🔍 <b>Payment <code>${esc(payment.id || paymentId)}</code></b>`,
    `Status: ${meaning}`,
    `Amount: <b>${rupeesOf(payment.amount)}</b>${payment.method ? ` · ${esc(payment.method)}` : ''}`,
    `Made at: ${esc(istFromUnix(payment.created_at))}`,
    payment.description ? `For: ${esc(payment.description)}` : '',
    `Belongs to: ${owner}`,
    payment.error_description ? `Bank said: ${esc(payment.error_description)}` : ''
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
    await sendSupportPrompt(user.id, support.categoryById(arg));
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
      await bot.sendMessage(ticket.telegramId,
        `${esc(support.replyLine(ticket.ticketId))}\n\n` +
        '✅ This ticket has been marked as resolved. If you still need help, just send another message ' +
        'or /support.',
        { parse_mode: 'HTML' });
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
    await bot.sendMessage(telegramId,
      `${esc(support.replyLine(ticketId))}\n\n${esc(text)}\n\n` +
      '<i>You can reply here, or just send another message.</i>',
      { parse_mode: 'HTML' });
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
      `${support.ticketHeader(ticketId, telegramId)}\n` +
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
      `${support.ticketHeader(ticketId, telegramId)}\n📋 <b>Quick replies</b> — tap one to send it to the student now:\n\n` +
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
    await post(
      `🎟 <b>Pass & payment</b>\n${passLines(passes)}\n\n` +
      `🧭 <b>Suggested:</b> ${esc(support.suggestNextStep(found ? found.category : 'other', passes))}`);
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
      `• ${esc(e.at)} — ${esc(e.who || e.role)}: ${esc(e.action)}`);
    await post(
      `📜 <b>History</b> · ${support.statusLine(found.status, found.waiting_on)}` +
      (found.picked_up_by ? ` · picked up by ${esc(found.picked_up_by)}` : '') +
      (found.handled_by ? ` · last handled by ${esc(found.handled_by)}` : '') +
      (found.admin_replies ? ` · ${found.admin_replies} admin repl${found.admin_replies === 1 ? 'y' : 'ies'}` : '') + '\n' +
      `<blockquote>${esc(support.lastChars(found.conversation || found.last_message, 2800))}</blockquote>` +
      (recent.length ? `\n<b>Recent actions</b>\n${recent.join('\n')}` : ''),
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
      `${support.ticketHeader(ticketId, telegramId)}\n${result.html}${followUp}`,
      supportChatOptions(chat, Object.assign({ reply_markup: keyboard }, where)));
    return;
  }

  if (action === 'grantAsk') {
    await ack();
    const pass = await passFor(primaryGroup().id);
    await bot.sendMessage(chat.chatId,
      `${support.ticketHeader(ticketId, telegramId)}\n` +
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
  // Other commands have their own handlers.
  if (String(msg.text || '').startsWith('/')) return;

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
      await openTicket(msg, category, msg.from);
      return;
    }
    const ticketId = support.parseReplyLine(repliedText);
    if (ticketId) {
      await followUpTicket(msg, ticketId, msg.from);
      return;
    }
  }

  // Service messages (a join, a pinned message) carry neither.
  if (!support.messageText(msg) && !support.hasMedia(msg)) return;

  if (!allowFreeText(String(msg.from.id))) return;

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

  const admins = Object.entries((stats && stats.by_admin) || {})
    .sort((a, b) => (b[1].replies + b[1].quick_replies) - (a[1].replies + a[1].quick_replies))
    .slice(0, 8)
    .map(([who, a]) => `• ${esc(who)}: ${a.replies + a.quick_replies} replies · ${a.closed} closed` +
      (a.invites_sent ? ` · ${a.invites_sent} invites` : '') +
      (a.passes_granted ? ` · ${a.passes_granted} passes granted` : ''));

  const lines = [
    `📊 <b>${family} — support summary</b>`,
    '',
    `🔴 Needs reply: <b>${c.needs_reply || 0}</b>` + (stats && stats.not_picked_up ? `  (🆕 ${stats.not_picked_up} not picked up yet)` : ''),
    `🟡 In progress: ${c.in_progress || 0} · ⏳ Waiting for student: ${c.waiting_student || 0}`,
    `✅ Closed: ${c.closed || 0} · All tickets: ${c.total || 0}`,
    '',
    `📅 Today: ${stats ? stats.opened_today : 0} opened · ${stats ? stats.closed_today : 0} closed`,
    `⏱ First reply, last 7 days: ${reply.samples ? `average ${minutesText(reply.average)} · median ${minutesText(reply.median)}` : 'no replies yet'}`,
    oldest
      ? `⌛ Longest waiting: ${esc(oldest.name)} — <b>${minutesText(oldest.minutes)}</b> (${esc(support.categoryById(oldest.category).label)})`
      : '⌛ Nobody is waiting for a reply 🎉'
  ];
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
    (list.total > tickets.length ? ` (showing ${tickets.length})` : '') + '\n' +
    `🔴 Needs reply ${counts.needs_reply || 0} · 🆕 Open ${counts.open || 0} · 🟡 In progress ${counts.in_progress || 0} · ` +
    `⏳ Waiting for student ${counts.waiting_student || 0} · ✅ Closed ${counts.closed || 0}` +
    (tickets.length ? '' : '\n\nNothing here. 🎉'));

  // One message per ticket, each with its own buttons, so any of them can be
  // acted on straight from the list.
  for (const t of tickets) {
    const category = support.categoryById(t.category);
    await postToAdmins(chat, t.ticket_id, t.telegram_id,
      `${support.statusLine(t.status, t.waiting_on)} · ${esc(category.emoji)} ${esc(category.label)}\n` +
      `👤 ${esc(t.username ? '@' + t.username : (t.name || t.telegram_id))} · 🕒 last activity ${esc(t.updated_at)}` +
      (t.picked_up_by ? ` · picked up by ${esc(t.picked_up_by)}` : ' · not picked up yet') + '\n' +
      `<blockquote>${esc(String(t.last_message || '').slice(0, 300))}</blockquote>`,
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

  if (!command) return;
  const family = esc(primaryGroup().label || primaryGroup().shortName);
  const reply = (html) => bot.sendMessage(chat.chatId, html, supportChatOptions(chat, where));

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
      await bot.sendMessage(student.telegramId,
        `${esc(support.replyLine(ticketId))}\n\n${esc(text)}\n\n<i>You can reply here, or just send another message.</i>`,
        { parse_mode: 'HTML' });
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
      'Every ticket arrives here with the student\'s passes, whether they are in the group, what they wrote, ' +
      'and a 🧭 suggestion. Buttons underneath:\n\n' +
      '✍️ <b>Write reply</b> — type your own answer\n' +
      '📋 <b>Quick replies</b> — ready answers (payment not received, send proof, still processing, pass expired, ' +
      'link sent, resolved)\n' +
      '🔗 <b>Send new invite link</b> — only works if their pass is valid\n' +
      '🎟 <b>Pass & payment</b> — their passes right now\n' +
      '🔍 <b>Check payment</b> — appears when they mention a pay_ id; asks Razorpay\n' +
      '✅ <b>Grant pass for this payment</b> — after a check shows the money arrived but no pass\n' +
      '📜 <b>History</b> — the whole conversation and recent actions\n' +
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
