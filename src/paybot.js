// ============================================================================
// Payment bot client (src/paybot.js)
// ============================================================================
// The bot that sells passes and guards the premium group, kept separate from
// the one that posts questions.
//
// Why a second module rather than reusing src/telegram.js: that module holds a
// single bot instance and a single group id at module level. server.js both
// posts questions and handles payment webhooks, so one shared instance would
// mean whichever ran last silently decided which bot sent everything — a
// question posted by the payment bot, or an invite sent by the posting bot.
// Separate clients make that impossible.
//
// TELEGRAM_PAYMENT_BOT_TOKEN is optional. Without it this falls back to
// TELEGRAM_BOT_TOKEN, so an existing single-bot setup keeps working unchanged
// until a second bot actually exists.
// ============================================================================

const TelegramBot = require('node-telegram-bot-api');

// One client per payment bot, keyed by the env var holding its token. Groups
// are sold by families — both newspaper groups share a bot, both Sadhana APPSC
// groups share another, UPSC has its own — so there are three clients, not one
// and not five.
const clients = new Map();

/**
 * tokenFor — the token behind one payment-bot env var.
 *
 * Falls back to TELEGRAM_PAYMENT_BOT_TOKEN and then TELEGRAM_BOT_TOKEN, so a
 * setup that has not yet split its bots keeps working while the new tokens are
 * created one at a time.
 *
 * @param {string} envName e.g. 'TELEGRAM_PAYBOT_UPSC'
 * @returns {{token: string, source: string}}
 */
function tokenFor(envName) {
  const candidates = [envName, 'TELEGRAM_PAYMENT_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'];
  for (const name of candidates) {
    if (!name) continue;
    const value = String(process.env[name] || '').trim();
    if (value) return { token: value, source: name };
  }
  return { token: '', source: '' };
}

/** Whether this payment bot has a token of its very own. */
function hasDedicatedBot(envName) {
  return Boolean(String(process.env[envName] || '').trim());
}

/** Which env var a payment bot's token actually came from. */
function getTokenSource(envName) {
  return tokenFor(envName).source || null;
}

/**
 * botFor — the client for one payment bot, created on first use.
 *
 * polling is false: these clients only make API calls. bot.js runs its own
 * polling client per bot for commands and join requests.
 *
 * @param {string} envName Which payment bot
 * @returns {TelegramBot}
 */
function botFor(envName) {
  if (clients.has(envName)) return clients.get(envName);

  const { token } = tokenFor(envName);
  if (!token) {
    throw new Error(
      `No token for payment bot ${envName}. Set ${envName} in .env ` +
      '(or TELEGRAM_PAYMENT_BOT_TOKEN as a fallback).'
    );
  }

  const client = new TelegramBot(token, { polling: false });
  clients.set(envName, client);
  return client;
}

/**
 * forGroup — the payment bot that sells a given group.
 *
 * Every membership operation goes through here, so a group can never be
 * invited into, or removed from, by another family's bot.
 *
 * @param {string} groupId
 * @returns {TelegramBot}
 */
function forGroup(groupId) {
  const groups = require('./groups');
  return botFor(groups.requireGroup(groupId).paymentBotEnv);
}

/** Drops cached clients, so a token change is picked up. Tests use this. */
function reset() {
  clients.clear();
}

/**
 * createJoinRequestInvite — an invite that asks to join rather than joining.
 *
 * A plain invite link cannot be tied to an account: whoever opens it first
 * gets in. That let a buyer hand their link to someone else, who then joined
 * in their place — and because the expiry sweep bans the id recorded on the
 * sheet, the person actually sitting in the group was never removed. A free
 * seat, forever, invisible on the dashboard.
 *
 * creates_join_request turns the link into a request the bot must approve, so
 * identity is checked by Telegram at the moment of joining rather than assumed
 * from who is holding a URL. Telegram rejects member_limit alongside it, which
 * is fine: the approval is the limit.
 *
 * @param {string|number} chatId    The premium group
 * @param {string|number} telegramId Who it is for, recorded in the link name
 * @param {number} [ttlSeconds]     How long the link stays usable
 * @returns {Promise<string>} The invite URL
 */
async function createJoinRequestInvite(envName, chatId, telegramId, ttlSeconds = 24 * 60 * 60) {
  return (await botFor(envName).createChatInviteLink(chatId, {
    creates_join_request: true,
    name: `member-${telegramId}`.slice(0, 32),
    expire_date: Math.floor(Date.now() / 1000) + ttlSeconds
  })).invite_link;
}

/**
 * approveJoinRequest — lets someone in.
 *
 * @param {string|number} chatId
 * @param {string|number} userId
 */
async function approveJoinRequest(envName, chatId, userId) {
  return botFor(envName).approveChatJoinRequest(chatId, userId);
}

/**
 * readOnlyMember — lets someone read a group without posting in it.
 *
 * What a free preview is: every question visible, nothing they can send. The
 * bot needs "Ban Users" for this, which it already has for removals. Telegram
 * takes the permissions as a JSON string on the form.
 *
 * @param {string|number} chatId
 * @param {string|number} userId
 * @param {number} [untilSeconds] Unix time the restriction lifts itself
 */
async function readOnlyMember(envName, chatId, userId, untilSeconds) {
  const form = {
    permissions: JSON.stringify({
      can_send_messages: false, can_send_audios: false, can_send_documents: false,
      can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
      can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
      can_add_web_page_previews: false, can_change_info: false, can_invite_users: false,
      can_pin_messages: false, can_manage_topics: false
    })
  };
  // Telegram lifts it on its own if we never get to: a preview that ends while
  // the server is down must not leave someone muted for ever.
  if (untilSeconds) form.until_date = Math.floor(untilSeconds);
  return botFor(envName).restrictChatMember(chatId, userId, form);
}

/**
 * declineJoinRequest — turns someone away.
 *
 * @param {string|number} chatId
 * @param {string|number} userId
 */
async function declineJoinRequest(envName, chatId, userId) {
  return botFor(envName).declineChatJoinRequest(chatId, userId);
}

/**
 * sendDirectMessage — HTML message to one user.
 *
 * Telegram forbids a bot from opening a conversation, so this only works once
 * the student has messaged this bot. With two bots that is worth remembering:
 * having messaged the questions bot does not help.
 *
 * @param {string|number} userId
 * @param {string} text HTML
 * @param {Object} [extra] Extra sendMessage options
 */
async function sendDirectMessage(envName, userId, text, extra) {
  return botFor(envName).sendMessage(userId, text, Object.assign({
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, extra || {}));
}

/**
 * removeFromChat — ban then unban, so a lapsed member can rejoin after paying.
 *
 * @param {string|number} chatId
 * @param {string|number} userId
 */
async function removeFromChat(envName, chatId, userId) {
  await botFor(envName).banChatMember(chatId, userId);
  await botFor(envName).unbanChatMember(chatId, userId);
}

/**
 * getMemberStatus — 'member', 'administrator', 'left', 'kicked', …
 *
 * @param {string|number} chatId
 * @param {string|number} userId
 * @returns {Promise<string|null>} The status, or null if it cannot be read
 */
async function getMemberStatus(envName, chatId, userId) {
  try {
    const member = await botFor(envName).getChatMember(chatId, userId);
    return (member && member.status) || null;
  } catch (err) {
    return null;
  }
}

/** getMe, for the health dashboard. */
async function getMe(envName) {
  return botFor(envName).getMe();
}

module.exports = {
  botFor,
  forGroup,
  tokenFor,
  reset,
  hasDedicatedBot,
  getTokenSource,
  createJoinRequestInvite,
  approveJoinRequest,
  readOnlyMember,
  declineJoinRequest,
  sendDirectMessage,
  removeFromChat,
  getMemberStatus,
  getMe
};
