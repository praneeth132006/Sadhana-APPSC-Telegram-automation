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

const plans = require('./plans');
const sheets = require('./sheets');
const membership = require('./membership');
const razorpay = require('./razorpay');
const groupRegistry = require('./groups');
const support = require('./support');

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

  /** The passes for one group, as buttons that carry the group with them. */
  function planKeyboard(groupId) {
  return {
    inline_keyboard: plansFor(groupId).map((plan) => ([{
      text: `${plan.emoji} ${plan.label} — ${plans.formatAmount(plan.amountPaise)}`,
      // The group travels in the callback data, so a tap can never be applied
      // to a different group than the one the student was reading about.
      callback_data: `buy:${groupId}:${plan.id}`
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

  /** The passes message for one group. */
  function plansMessage(groupId) {
  const group = groupRegistry.requireGroup(groupId);
  const lines = plansFor(groupId).map((plan, index) =>
    `${index + 1}. ${plan.emoji} <b>${esc(plan.label)}</b> — ${plans.formatAmount(plan.amountPaise)}` +
    (plan.type === 'recurring' ? '/month' : '') +
    `\n<i>${esc(plan.tagline)}</i>`
  );

  return `<b>${esc(group.shortName)}</b>\n\nChoose a pass:\n\n` + lines.join('\n\n');
  }

  /**
   * offerGroups — the entry point for a student.
   *
   * With one group in the family this goes straight to that group's passes;
   * with two it asks first. Either way the student only ever sees groups this
   * bot is responsible for.
   */
  async function offerGroups(chatId) {
  const groups = familyGroups();

  if (groups.length === 1) {
    await bot.sendMessage(chatId, plansMessage(groups[0].id), {
      parse_mode: 'HTML',
      reply_markup: planKeyboard(groups[0].id)
    });
    return;
  }

  await bot.sendMessage(chatId, chooseGroupMessage(), {
    parse_mode: 'HTML',
    reply_markup: groupKeyboard()
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

  bot.onText(/^\/start/, async (msg) => {
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

  bot.onText(/^\/plans/, async (msg) => {
  await offerGroups(msg.chat.id);
  });

  bot.onText(/^\/status/, async (msg) => {
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

  bot.onText(/^\/help/, async (msg) => {
  const many = familyGroups().length > 1;
  await bot.sendMessage(msg.chat.id,
    '<b>How it works</b>\n\n' +
    (many ? '1. Send /plans and choose which group you want.\n2. Pick a pass.\n'
          : '1. Send /plans and tap the pass you want.\n') +
    `${many ? '3' : '2'}. Pay on the secure Razorpay page that opens.\n` +
    `${many ? '4' : '3'}. This bot sends you a private invite link.\n` +
    `${many ? '5' : '4'}. Tap it and you are let in automatically.\n\n` +
    (many ? '<i>Your pass is for the group you chose. The invite will not let you ' +
            'into the other one, and forwarding it will not let anyone else in.</i>\n\n'
          : '<i>The invite is tied to your account — forwarding it will not let ' +
            'anyone else in.</i>\n\n') +
    'You will get a reminder before your pass runs out. Check /status any time.\n\n' +
    '<b>On Monthly Auto-Pay?</b> Send /cancel to stop future charges. You keep the ' +
    'access you have already paid for, right up to its expiry date.\n\n' +
    'Trouble? Send /support, or just type your question here.',
    { parse_mode: 'HTML', reply_markup: SUPPORT_BUTTON }
  );
  });

  bot.onText(/^\/cancel/, async (msg) => {
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
  if (data.startsWith('pick:')) {
    const group = familyGroup(data.slice(5));
    if (!group) {
      await ack('That group is not available here.');
      return;
    }
    await ack();
    await bot.sendMessage(user.id, plansMessage(group.id), {
      parse_mode: 'HTML',
      reply_markup: planKeyboard(group.id)
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

  if (!data.startsWith('buy:')) {
    await ack();
    return;
  }

  // ---- buying a pass ------------------------------------------------------
  // buy:<groupId>:<planId> — the group is carried on the button rather than
  // held in memory, so a tap on yesterday's message still buys the group it
  // was offering, and a restart cannot silently redirect it to another.
  const [, groupId, planId] = data.split(':');

  const group = familyGroup(groupId);
  if (!group) {
    // Either a stale button from another bot, or a group this bot does not
    // sell. Refusing is the whole point of one bot per family.
    await ack('That group is not available from this bot.');
    return;
  }

  const plan = planFor(groupId, planId);
  if (!plan) {
    await ack('That pass no longer exists.');
    return;
  }

  await ack('Creating your payment link…');

  try {
    // If they already hold this group, say so rather than quietly selling again.
    const existing = await sheetFor(groupId).getSubscriber(user.id);
    if (existing && existing.status === 'active') {
      await bot.sendMessage(user.id,
        `ℹ️ You already have an active <b>${esc(existing.plan_label)}</b> for ` +
        `<b>${esc(group.shortName)}</b> until <b>${esc(existing.expiry_date)}</b>.\n\n` +
        'Paying again extends your access from that date — you will not lose the days you have.',
        { parse_mode: 'HTML' });
    }

    const checkout = await createCheckout(group, plan, user);

    await bot.sendMessage(user.id,
      `${plan.emoji} <b>${esc(plan.label)}</b> — ${plans.formatAmount(plan.amountPaise)}` +
      (plan.type === 'recurring' ? ' per month' : '') + '\n' +
      `for <b>${esc(group.shortName)}</b>\n\n` +
      `${esc(plan.description)}\n\n` +
      // Anyone signing up for a recurring mandate has to be told, at the moment
      // they sign up, that it keeps charging and exactly how to stop it. This
      // said nothing: /cancel existed and was mentioned nowhere a buyer looks.
      (plan.type === 'recurring'
        ? `🔁 This renews automatically every month at ${plans.formatAmount(plan.amountPaise)} ` +
          'until you stop it.\n' +
          '<b>Send /cancel to this bot any time to stop future charges</b> — you keep ' +
          'the access you have already paid for.\n\n'
        : '') +
      'Tap below to pay. Your private invite arrives here the moment payment clears.' +
      (razorpay.isTestMode() ? '\n\n⚠️ <i>Test mode — use a Razorpay test card.</i>' : ''),
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: `💳 Pay ${plans.formatAmount(plan.amountPaise)}`, url: checkout.url }]]
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
   * createCheckout — a Razorpay link or subscription for one group's pass.
   *
   * @param {Object} group The group being bought
   * @param {Object} plan  The pass, already carrying its group's price
   * @param {Object} user  Telegram user
   * @returns {Promise<{url: string}>}
   */
  async function createCheckout(group, plan, user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');

  if (plan.type === 'recurring') {
    // Each group needs its own Razorpay plan, because the price is baked into
    // the plan and the groups do not all charge the same.
    const razorpayPlanId = String(plan.razorpayPlanId || '').trim();
    if (!razorpayPlanId) {
      throw new Error(
        `RAZORPAY_PLAN_${group.envPrefix} is not set — run setup-razorpay.js for ${group.displayName}.`
      );
    }
    const subscription = await razorpay.createSubscription({
      plan, razorpayPlanId, telegramId: user.id, username: user.username
    });
    return { url: subscription.short_url };
  }

  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const link = await razorpay.createPaymentLink({
    plan,
    telegramId: user.id,
    username: user.username,
    name,
    callbackUrl: base ? `${base}/payment-success.html` : undefined
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
        inline_keyboard: support.CATEGORIES.map((category) => ([{
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

  /** How a student's passes read in the support chat. */
  function passLines(held) {
  if (!held || !held.length) return '🎟 No pass on record';
  return held.map(({ group, subscriber }) =>
    `🎟 ${esc(group.shortName)}: <b>${esc(subscriber.status || 'unknown')}</b>` +
    (subscriber.expiry_date ? ` until ${esc(subscriber.expiry_date)}` : '')).join('\n');
  }

  /** Posts one message about a ticket into the support chat, with the admin buttons. */
  async function postToAdmins(chat, ticketId, telegramId, html, { closed = false, extra = {} } = {}) {
  return bot.sendMessage(chat.chatId,
    `${support.ticketHeader(ticketId, telegramId)}\n${html}`,
    supportChatOptions(chat, Object.assign({
      reply_markup: support.adminKeyboard(ticketId, telegramId, { closed })
    }, extra)));
  }

  /**
   * notifyAdmins — posts a new ticket, or a student's reply to one, into the
   * support chat.
   *
   * A reply carries the conversation before it, so whoever picks it up sees
   * what already happened without scrolling back through other tickets.
   *
   * @returns {Promise<boolean>} true when the admins were reached
   */
  async function notifyAdmins({ ticketId, user, category, text, held, source, followUp, conversation }) {
  const chat = supportChat();
  if (!chat) return false;

  const lines = followUp
    ? [`↩️ <b>Student replied</b> · ${esc(displayUser(user))}`]
    : [`🆕 <b>New ticket</b> · ${esc(category.emoji)} ${esc(category.label)}`, `👤 ${esc(displayUser(user))}`];
  if (held) lines.push(passLines(held));

  const earlier = followUp ? support.earlierConversation(conversation, 1200) : '';
  if (earlier) lines.push('', '📜 <b>Earlier in this ticket</b>', `<blockquote>${esc(earlier)}</blockquote>`);

  // Telegram refuses anything over 4096 characters, and a refused post is a
  // ticket nobody sees. The full text is always in the sheet and 📜 Full history.
  const body = String(text || '(attachment below)');
  const shown = body.length > 2200 ? body.slice(0, 2200) + '… (cut short — tap 📜 Full history)' : body;
  lines.push('', `💬 ${esc(shown)}`);

  try {
    await postToAdmins(chat, ticketId, user.id, lines.join('\n'));
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
   * findActiveTicket — this student's most recent ticket that is still open
   * or answered and was touched in the last week.
   *
   * A student does not use Telegram's reply feature; they just type again.
   * Without this, every such message became a separate ticket and the admin
   * saw the same problem scattered across several.
   *
   * @returns {Promise<Object|null>} Resolves null when none, or when the sheet cannot say
   */
  async function findActiveTicket(telegramId) {
  const list = await within(
    sheetFor(primaryGroup().id).listTickets({ telegramId: String(telegramId), pageSize: 10 }),
    SUPPORT_SETTINGS_WAIT_MS,
    null
  );
  const tickets = (list && list.tickets) || [];
  return tickets.find((t) => t.status !== 'closed' && support.isRecent(t.updated_at, ACTIVE_TICKET_DAYS)) || null;
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
  const [saved, held] = await Promise.all([
    sheetFor(primaryGroup().id).createTicket({
      ticket_id: ticketId,
      telegram_id: String(user.id),
      username: user.username || '',
      name: [user.first_name, user.last_name].filter(Boolean).join(' '),
      category: category.id,
      bot: payBotEnv,
      message: text || '(attachment)'
    }).then(() => true, (err) => {
      console.error(`[support] ${payBotEnv}: could not record ticket ${ticketId} — ${err.message}`);
      return false;
    }),
    findSubscriptions(user.id)
  ]);

  const delivered = await notifyAdmins({ ticketId, user, category, text, held, source });

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

  /** A student adding to a ticket that already exists. */
  async function followUpTicket(source, ticketId, user) {
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
      text: text || '(attachment)',
      status: 'open'
    });
    saved = Boolean(ticket);
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not add to ticket ${ticketId} — ${err.message}`);
  }

  const delivered = await notifyAdmins({
    ticketId, user, text, source, followUp: true, conversation: ticket && ticket.conversation
  });

  if (!saved && !delivered) {
    await bot.sendMessage(user.id,
      '⚠️ Could not add that to your ticket just now. Please try again in a few minutes.');
    return;
  }
  await bot.sendMessage(user.id,
    `${esc(support.receivedLine(ticketId))}\n\nAdded to your ticket. An admin will reply here.\n\n` +
    '<i>Different problem? Send /support to open a new ticket.</i>',
    { parse_mode: 'HTML' });
  }

  /**
   * resendInvites — a fresh invite for every group in this family where the
   * student holds an active pass, sent to them by this bot.
   *
   * @param {string|number} telegramId
   * @param {{ticketId?: string, actor?: string}} [options] Recorded on the ticket when given
   * @returns {Promise<Array<Object>>} One entry per group:
   *   { group, sent, delivered, status, inviteLink, error }
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

  const delivered = results.filter((r) => r.delivered).map((r) => r.group.shortName);
  if (ticketId && delivered.length) {
    try {
      await sheetFor(primaryGroup().id).appendTicketMessage(ticketId, {
        author: `Admin ${actor || 'unknown'}`,
        text: `Sent a fresh invite link for ${delivered.join(', ')}`,
        status: 'answered',
        handledBy: actor || ''
      });
    } catch (err) {
      console.error(`[support] ${payBotEnv}: could not record the resent invite on ${ticketId} — ${err.message}`);
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
    lines.push('', 'Nobody to invite: the student needs an active pass. They can buy one with /plans.');
  }
  return lines.join('\n');
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
      `${esc(category.emoji)} <b>${esc(category.label)}</b>\n\n${esc(settings[category.settingKey])}` +
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
      await followUpTicket(original, active.ticket_id, user);
    } else {
      await openTicket(original, support.categoryById('other'), user);
    }
    return;
  }

  await ack();
  }

  /** Changes a ticket's status from the support chat and tells whoever needs telling. */
  async function setStatusFromChat(chat, ticket, status, admin, where) {
  try {
    await sheetFor(primaryGroup().id).setTicketStatus(ticket.ticketId, status, admin);
  } catch (err) {
    console.error(`[support] ${payBotEnv}: could not set ${ticket.ticketId} to ${status} — ${err.message}`);
  }
  if (status === 'closed') {
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
  await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
    (status === 'closed' ? '✅ Closed by ' : '🔓 Reopened by ') + esc(admin),
    { closed: status === 'closed', extra: where });
  }

  /** How an admin reads in the support chat and the ticket thread. */
  function adminName(user) {
  return user.username ? `@${user.username}` : displayUser(user);
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

  const { action, ticketId, telegramId } = parsed;
  const ticket = { ticketId, telegramId };
  const admin = adminName(query.from);
  const where = { reply_to_message_id: message.message_id };
  if (message.message_thread_id) where.message_thread_id = message.message_thread_id;

  if (action === 'reply') {
    await ack();
    await bot.sendMessage(chat.chatId,
      `${support.ticketHeader(ticketId, telegramId)}\n` +
      `✍️ ${esc(admin)}, type your answer as a reply to this message. It goes straight to the student.`,
      supportChatOptions(chat, Object.assign({
        reply_markup: { force_reply: true, input_field_placeholder: `Answer for ${ticketId}` }
      }, where)));
    return;
  }

  if (action === 'invite') {
    await ack('Creating a fresh invite link…');
    const results = await resendInvites(telegramId, { ticketId, actor: admin });
    await postToAdmins(chat, ticketId, telegramId,
      `🔗 <b>Resend invite</b> · by ${esc(admin)}\n\n${describeInviteResults(results)}`, { extra: where });
    return;
  }

  if (action === 'passes') {
    await ack();
    const held = await findSubscriptions(telegramId);
    await postToAdmins(chat, ticketId, telegramId, `🎟 <b>Pass status</b>\n${passLines(held)}`, { extra: where });
    return;
  }

  if (action === 'history') {
    await ack();
    let found = null;
    try {
      found = await sheetFor(primaryGroup().id).getTicket(ticketId);
    } catch (err) {
      await postToAdmins(chat, ticketId, telegramId,
        `⚠️ Could not read the history: ${esc(err.message)}`, { extra: where });
      return;
    }
    if (!found) {
      await postToAdmins(chat, ticketId, telegramId,
        '⚠️ This ticket is not in the sheet (it may have been raised while the sheet was unavailable).',
        { extra: where });
      return;
    }
    await postToAdmins(chat, ticketId, telegramId,
      `📜 <b>Full history</b> · status <b>${esc(found.status)}</b>` +
      (found.handled_by ? ` · last handled by ${esc(found.handled_by)}` : '') + '\n' +
      `<blockquote>${esc(support.lastChars(found.conversation || found.last_message, 3300))}</blockquote>`,
      { closed: found.status === 'closed', extra: where });
    return;
  }

  if (action === 'close' || action === 'reopen') {
    await ack(action === 'close' ? 'Closing…' : 'Reopening…');
    await setStatusFromChat(chat, ticket, action === 'close' ? 'closed' : 'open', admin, where);
    return;
  }

  await ack();
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

  // Someone mid-conversation with support just types again. That belongs in
  // the ticket they already have, not in a new one.
  const active = await findActiveTicket(msg.from.id);
  if (active) {
    await followUpTicket(msg, active.ticket_id, msg.from);
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
        `🔗 <b>Resend invite</b> · by ${esc(admin)}\n\n${describeInviteResults(results)}`, { extra: where });
      return;
    }
    if (command) return;

    const text = support.messageText(msg);
    if (!text && !support.hasMedia(msg)) return;

    try {
      if (support.hasMedia(msg)) {
        await bot.copyMessage(ticket.telegramId, msg.chat.id, msg.message_id, {
          caption: `${support.replyLine(ticket.ticketId)}\n\n${text}`.slice(0, 1000)
        });
      } else {
        await bot.sendMessage(ticket.telegramId,
          `${esc(support.replyLine(ticket.ticketId))}\n\n${esc(text)}\n\n` +
          '<i>You can reply here, or just send another message.</i>',
          { parse_mode: 'HTML' });
      }
    } catch (err) {
      await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
        `⚠️ Not delivered: ${esc(err.message)}\nThe student may have blocked the bot.`, { extra: where });
      return;
    }

    try {
      await sheetFor(primaryGroup().id).appendTicketMessage(ticket.ticketId, {
        author: `Admin ${admin}`,
        text: text || '(attachment)',
        status: 'answered',
        handledBy: admin
      });
    } catch (err) {
      console.error(`[support] ${payBotEnv}: could not record the answer to ${ticket.ticketId} — ${err.message}`);
    }

    await postToAdmins(chat, ticket.ticketId, ticket.telegramId,
      `✅ Delivered to the student · by ${esc(admin)}`, { extra: where });
    return;
  }

  if (!command) return;
  const family = esc(primaryGroup().label || primaryGroup().shortName);
  const reply = (html) => bot.sendMessage(chat.chatId, html, supportChatOptions(chat, where));

  if (command.name === 'tickets') {
    try {
      const [open, answered] = await Promise.all([
        sheetFor(primaryGroup().id).listTickets({ status: 'open', pageSize: 10 }),
        sheetFor(primaryGroup().id).listTickets({ status: 'answered', pageSize: 10 })
      ]);
      const counts = open.counts || {};
      await reply(
        `<b>${family} — support</b>\n` +
        `🟠 Open ${counts.open || 0} · 🔵 Answered ${counts.answered || 0} · ✅ Closed ${counts.closed || 0}`);

      // One message per ticket, each with its own buttons, so any of them can
      // be acted on straight from this list.
      for (const t of [...(open.tickets || []), ...(answered.tickets || [])]) {
        await postToAdmins(chat, t.ticket_id, t.telegram_id,
          `${t.status === 'open' ? '🟠 Open' : '🔵 Answered'} · ` +
          `${esc(support.categoryById(t.category).label)} · ` +
          `${esc(t.username ? '@' + t.username : (t.name || t.telegram_id))}\n` +
          `🕒 ${esc(t.updated_at)}\n\n💬 ${esc(String(t.last_message || '').slice(0, 300))}`);
      }
      if (!(open.tickets || []).length && !(answered.tickets || []).length) {
        await reply('Nothing waiting. 🎉');
      }
    } catch (err) {
      await reply(`⚠️ Could not read tickets: ${esc(err.message)}`);
    }
    return;
  }

  if (command.name === 'settings') {
    settingsCache.invalidate();
    const settings = await settingsWithin(SUPPORT_SETTINGS_WAIT_MS);
    const lines = support.SETTINGS.map((def) => {
      const value = String(settings[def.key] || '');
      const shown = value.length > 80 ? value.slice(0, 80) + '…' : (value || '(empty)');
      return `<code>${def.key}</code>: ${esc(shown)}`;
    });
    await reply(
      `<b>${family} — bot settings</b>\n\n${lines.join('\n')}\n\n` +
      'Change one with <code>/set key new value</code>, or use the Support page on the dashboard.');
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
      `<b>${family} — how support works</b>\n\n` +
      'Every ticket arrives here with buttons underneath:\n' +
      '✍️ <b>Reply</b> — answer the student\n' +
      '🔗 <b>Resend invite</b> — send a fresh invite link (only if their pass is active)\n' +
      '🎟 <b>Pass status</b> — what they have paid for and until when\n' +
      '📜 <b>Full history</b> — the whole conversation\n' +
      '✅ <b>Close ticket</b> — tells the student it is resolved\n\n' +
      'You can also just reply to any ticket message to answer it.\n\n' +
      '<code>/tickets</code> — everything waiting, with buttons\n' +
      '<code>/settings</code> — the texts the bot uses · <code>/set key value</code> to change one');
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
    resendInvites, describeInviteResults
  };

}

module.exports = { createPaymentBot };
