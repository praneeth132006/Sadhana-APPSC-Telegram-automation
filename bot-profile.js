// ============================================================================
// bot-profile.js — the commands menu and the "What can this bot do?" screen
// ============================================================================
// Telegram keeps three pieces of text per bot on its own servers, not in this
// repository:
//
//   description       the screen a stranger reads BEFORE pressing Start
//   short description the line under the bot's name in search and its profile
//   commands          what the ☰ Menu button lists
//
// They are set once, over the API, and then remembered by Telegram for ever —
// which is exactly why they drift: nothing in a deploy touches them, so they
// keep saying whatever they were told years ago. This script writes all three
// from the values here, for every payment bot configured in .env, and is safe
// to run as often as you like.
//
// Usage:
//   node bot-profile.js            → write commands and descriptions
//   node bot-profile.js --status   → show what Telegram currently holds
//   node bot-profile.js --dry-run  → print what would be written
// ============================================================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const groupRegistry = require('./src/groups');

/**
 * What the bot is, in one paragraph.
 *
 * This is the same text as ABOUT_TEXT in src/botapp.js, which is what /about
 * replies. Two copies of one paragraph is a smell, but the alternative is
 * importing the bot factory — and that refuses to load without a Razorpay key,
 * which this script has no business needing. Keep them in step.
 */
const DESCRIPTION =
  'Join our APPSC prep group via this bot. Get daily practice questions from ' +
  'Eenadu, Sakshi & Nipuna in poll format. Available in both Telugu and English mediums.';

/** The line under the bot's name. Telegram allows 120 characters. */
const SHORT_DESCRIPTION =
  'Daily APPSC practice questions from Eenadu, Sakshi & Nipuna — in Telugu and English.';

/**
 * The ☰ Menu.
 *
 * Ordered by how often a student needs them, not alphabetically: /start and
 * /about are what a newcomer wants, /plans and /status what a member wants.
 */
const COMMANDS = [
  { command: 'start', description: 'Start here — what this bot is' },
  { command: 'about', description: 'About this group and the questions' },
  { command: 'plans', description: 'See the pass and join' },
  { command: 'status', description: 'Check your current pass' },
  { command: 'referral', description: 'Invite a friend and earn 20%' },
  { command: 'help', description: 'How it all works' },
  { command: 'support', description: 'Get help with a problem' }
];

const statusOnly = process.argv.includes('--status');
const dryRun = process.argv.includes('--dry-run');

/** Every payment bot named by a configured group, without repeats. */
function payBotEnvs() {
  const envs = new Set();
  for (const group of groupRegistry.listGroups()) {
    if (group.paymentBotEnv && String(process.env[group.paymentBotEnv] || '').trim()) {
      envs.add(group.paymentBotEnv);
    }
  }
  return [...envs];
}

async function main() {
  const envs = payBotEnvs();
  if (!envs.length) {
    console.error('No payment bot tokens are set. Check TELEGRAM_PAYBOT_* in .env.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n${statusOnly ? 'Reading' : dryRun ? 'Would write' : 'Writing'} ` +
    `the profile of ${envs.length} bot(s)\n`);

  for (const env of envs) {
    const bot = new TelegramBot(String(process.env[env]).trim(), { polling: false });
    let me;
    try {
      me = await bot.getMe();
    } catch (err) {
      console.log(`  ${env}\n    ❌ token rejected: ${err.message}\n`);
      process.exitCode = 1;
      continue;
    }
    console.log(`  ${env}  →  @${me.username}`);

    if (statusOnly) {
      const [description, short, commands] = await Promise.all([
        bot.getMyDescription().catch(() => ({})),
        bot.getMyShortDescription().catch(() => ({})),
        bot.getMyCommands().catch(() => [])
      ]);
      console.log(`    description: ${description.description || '(none)'}`);
      console.log(`    short:       ${short.short_description || '(none)'}`);
      console.log(`    commands:    ${commands.length
        ? commands.map((c) => '/' + c.command).join(' ') : '(none)'}\n`);
      continue;
    }

    if (dryRun) {
      console.log(`    description: ${DESCRIPTION}`);
      console.log(`    short:       ${SHORT_DESCRIPTION}`);
      console.log(`    commands:    ${COMMANDS.map((c) => '/' + c.command).join(' ')}\n`);
      continue;
    }

    try {
      // Each is a separate call, and each is reported on its own: a bot whose
      // commands were set but whose description was refused should not look
      // like a success.
      await bot.setMyCommands(COMMANDS);
      console.log(`    ✅ commands    (${COMMANDS.length})`);

      // These two take a FORM, not a string. Handed a string the library sends
      // an empty form, Telegram answers ok, and the description stays blank —
      // a silent success that reads exactly like a real one. Hence the
      // read-back below rather than trusting what the call said.
      await bot.setMyDescription({ description: DESCRIPTION });
      await bot.setMyShortDescription({ short_description: SHORT_DESCRIPTION });

      const [wroteLong, wroteShort] = await Promise.all([
        bot.getMyDescription().then((r) => (r && r.description) || ''),
        bot.getMyShortDescription().then((r) => (r && r.short_description) || '')
      ]);
      if (wroteLong === DESCRIPTION) {
        console.log('    ✅ description');
      } else {
        console.log(`    ❌ description did not take (Telegram holds: "${wroteLong}")`);
        process.exitCode = 1;
      }
      if (wroteShort === SHORT_DESCRIPTION) {
        console.log('    ✅ short description\n');
      } else {
        console.log(`    ❌ short description did not take (Telegram holds: "${wroteShort}")\n`);
        process.exitCode = 1;
      }
    } catch (err) {
      console.log(`    ❌ ${err.message}\n`);
      process.exitCode = 1;
    }
  }

  if (!statusOnly && !dryRun && !process.exitCode) {
    console.log('Done. Telegram caches these — reopen the chat, or clear the app cache, to see them.\n');
  }
}

main().catch((err) => {
  console.error('bot-profile failed:', err.message);
  process.exitCode = 1;
});
