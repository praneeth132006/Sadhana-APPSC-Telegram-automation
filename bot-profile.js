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

const botCommands = require('./src/bot-commands');
const support = require('./src/support');


/** A plain Telegram API caller for one bot, for the calls the library lacks. */
function telegramFor(env) {
  const token = String(process.env[env] || '').trim();
  return (method, params) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params || {})
  }).then((r) => r.json());
}
const COMMANDS = botCommands.STUDENT_COMMANDS;

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
    const DESCRIPTION = botCommands.aboutFor(env);
    const SHORT_DESCRIPTION = botCommands.shortDescriptionFor(env);

    if (statusOnly) {
      const [description, short] = await Promise.all([
        bot.getMyDescription().catch(() => ({})),
        bot.getMyShortDescription().catch(() => ({}))
      ]);
      const shown = await botCommands.menuStudentsSee(telegramFor(env));
      console.log(`    description:   ${description.description || '(none)'}`);
      console.log(`    short:         ${short.short_description || '(none)'}`);
      console.log(`    students see:  ${shown.length ? shown.map((c) => '/' + c).join(' ') : '(nothing)'}\n`);
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
      // The menus go to the scopes students and admins are actually in. This
      // script used to write the default scope, which Telegram never shows in
      // a private chat while set-webhooks has filled the private-chat scope —
      // so the new commands were invisible to every student.
      const telegram = telegramFor(env);
      const results = await botCommands.registerMenus(telegram, support.supportChatFor(env));
      for (const r of results) {
        if (!r.ok) {
          console.log(`    ❌ ${r.what}: ${r.detail}`);
          process.exitCode = 1;
        }
      }

      // What a student is really shown, read back from Telegram.
      const shown = await botCommands.menuStudentsSee(telegram);
      const wanted = COMMANDS.map((c) => c.command);
      if (shown.join(' ') === wanted.join(' ')) {
        console.log(`    ✅ students see ${shown.map((c) => '/' + c).join(' ')}`);
      } else {
        console.log(`    ❌ students see ${shown.length ? shown.map((c) => '/' + c).join(' ') : 'nothing'}, ` +
          `not ${wanted.map((c) => '/' + c).join(' ')}`);
        process.exitCode = 1;
      }

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
