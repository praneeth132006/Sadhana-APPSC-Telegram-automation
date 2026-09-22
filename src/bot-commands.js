// ============================================================================
// src/bot-commands.js — what every payment bot tells Telegram about itself
// ============================================================================
// The ☰ Menu, the "What can this bot do?" screen and the /about paragraph, in
// ONE place.
//
// They used to live in two scripts that each wrote their own list, and the
// two lists landed in different scopes:
//
//   set-webhooks.js  → four commands, to all_private_chats
//   bot-profile.js   → seven commands, to default
//
// Telegram shows the MOST SPECIFIC scope that has commands. In a private
// chat that is all_private_chats, so the seven-command list — with /start,
// /about and /referral — was never shown to a single student, and every
// routine run of set-webhooks put the old four back. Both scripts now read
// from here, so there is only one list to be right about.
// ============================================================================

/**
 * What a student sees in a private chat with the bot.
 *
 * Ordered by how often a student needs them, not alphabetically: /start and
 * /about are what a newcomer wants, /plans and /status what a member wants.
 * Every command here must be one the bot actually answers in a private chat —
 * a menu entry that does nothing is worse than no entry.
 */
const STUDENT_COMMANDS = [
  { command: 'start', description: 'Start here — what this bot is' },
  { command: 'about', description: 'About this group and the questions' },
  { command: 'plans', description: 'See the pass and join' },
  { command: 'status', description: 'Check your current pass' },
  { command: 'referral', description: 'Invite a friend and earn 20%' },
  { command: 'help', description: 'How it all works' },
  { command: 'support', description: 'Get help with a problem' },
  { command: 'terms', description: 'Terms of the pass and payments' }
];

/** What admins see when they type "/" in a bot's support chat. */
const ADMIN_COMMANDS = [
  { command: 'summary', description: 'How many tickets need a reply, are open, in progress, closed' },
  { command: 'tickets', description: 'Tickets needing a reply (or: open, progress, student, closed)' },
  { command: 'find', description: 'Look up a pay_ id, a student (id or @username) or a ticket id' },
  { command: 'msg', description: 'Message a student: /msg <id or @username> text' },
  { command: 'settings', description: 'Bot texts, pass name and price' },
  { command: 'supporthelp', description: 'How to handle support' }
];

/** The paragraph the admin wrote, word for word. Plain text: Telegram shows it as-is. */
const ABOUT = 'Join our APPSC prep group via this bot. Get daily practice questions from ' +
  'Eenadu, Sakshi & Nipuna in poll format. Available in both Telugu and English mediums.';

/** The line under the bot's name in search and on its profile. Telegram allows 120. */
const SHORT_DESCRIPTION =
  'Daily APPSC practice questions from Eenadu, Sakshi & Nipuna — in Telugu and English.';

/**
 * Bots that sell something other than the APPSC groups say so.
 *
 * The UPSC bot used to carry the APPSC paragraph too — a profile promising
 * Eenadu and Telugu medium, in front of a bot that sells UPSC Prelims in
 * English. An ad reviewer reads the profile first and then tries the bot; the
 * two have to describe the same thing.
 */
const PROFILES = {
  TELEGRAM_PAYBOT_UPSC: {
    about: 'Join our UPSC Prelims prep group via this bot. Get daily practice questions ' +
      'in poll format across History, Geography, Polity, Economy, Environment, ' +
      'Science & Tech and Current Affairs. In English.',
    short: 'Daily UPSC Prelims practice questions in poll format — History, Polity, Economy and more.'
  }
};

/** The /about paragraph and Telegram description for one payment bot. */
function aboutFor(payBotEnv) {
  return (PROFILES[payBotEnv] && PROFILES[payBotEnv].about) || ABOUT;
}

/** The short description for one payment bot. */
function shortDescriptionFor(payBotEnv) {
  return (PROFILES[payBotEnv] && PROFILES[payBotEnv].short) || SHORT_DESCRIPTION;
}

/**
 * registerMenus — writes the menus to the scopes students and admins are in.
 *
 *   all_private_chats → STUDENT_COMMANDS   (where every one of them works)
 *   the support chat  → ADMIN_COMMANDS
 *   default           → cleared
 *
 * Default is cleared on purpose. It is what the paid groups fall back to, and
 * the bot deliberately answers no student command there — so a menu in the
 * group would be seven commands that do nothing when tapped.
 *
 * @param {Function} call async (method, params) => Telegram's JSON answer
 * @param {Object|null} supportChat { chatId } for this bot, or null
 * @returns {Promise<Array<{what: string, ok: boolean, detail?: string}>>}
 */
async function registerMenus(call, supportChat) {
  const results = [];
  const record = (what, answer) => {
    results.push({ what, ok: Boolean(answer && answer.ok), detail: answer && answer.description });
  };

  record('student menu (private chats)', await call('setMyCommands', {
    commands: STUDENT_COMMANDS, scope: { type: 'all_private_chats' }
  }));

  // deleteMyCommands, not an empty setMyCommands: Telegram treats the empty
  // list as "delete" too, but saying so is clearer to the next reader.
  record('default menu cleared', await call('deleteMyCommands', { scope: { type: 'default' } }));

  if (supportChat && supportChat.chatId) {
    record('admin menu (support chat)', await call('setMyCommands', {
      commands: ADMIN_COMMANDS, scope: { type: 'chat', chat_id: supportChat.chatId }
    }));
  }
  return results;
}

/**
 * menuStudentsSee — the list a student is actually shown in a private chat.
 *
 * Read back from the private-chat scope rather than trusted from what was
 * written, because "the call said ok" is exactly what looked like success last
 * time while students saw something else entirely.
 */
async function menuStudentsSee(call) {
  const answer = await call('getMyCommands', { scope: { type: 'all_private_chats' } });
  let list = (answer && answer.result) || [];
  // An empty private-chat scope falls back to default, which is what Telegram
  // would then show.
  if (!list.length) {
    const fallback = await call('getMyCommands', { scope: { type: 'default' } });
    list = (fallback && fallback.result) || [];
  }
  return list.map((c) => c.command);
}

module.exports = {
  STUDENT_COMMANDS,
  ADMIN_COMMANDS,
  ABOUT,
  SHORT_DESCRIPTION,
  aboutFor,
  shortDescriptionFor,
  registerMenus,
  menuStudentsSee
};
