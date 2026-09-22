#!/usr/bin/env node
// ============================================================================
// Per-group setup helper (group-setup.js)
// ============================================================================
// Setting up five groups by hand means five Apps Script deployments, five
// script properties, five Telegram groups and five sets of .env variables.
// Doing that from memory is how one sheet ends up with another's subjects, or
// a group quietly points at the wrong chat.
//
// This prints exactly what to paste, per group, and can find a Telegram group
// id rather than making you hunt for one.
//
//   node group-setup.js                 — status of every group
//   node group-setup.js <groupId>       — what that group still needs
//   node group-setup.js --chat-ids      — group ids the payment bots can see
//   node group-setup.js --invite-links  — links that add each bot with the right rights
// ============================================================================

require('dotenv').config();

const groups = require('./src/groups');

const args = process.argv.slice(2);

/** Prints a heading with a rule under it. */
function heading(text) {
  console.log('\n' + text);
  console.log('─'.repeat(Math.min(text.length, 70)));
}

/** One line per group: is it usable yet, and if not what is missing. */
function status() {
  heading('Groups');
  groups.listGroups().forEach((g) => {
    const mark = g.ready ? '✅' : '⬜';
    console.log(`${mark} ${g.id.padEnd(15)} ${g.displayName}`);
    console.log(`   subjects: ${g.subjects ? g.subjects.length : 0}` +
                `   payment bot: ${g.paymentBotEnv}`);
    if (!g.ready) console.log(`   missing: ${g.missing.join(', ')}`);
  });

  console.log('\nRun `node group-setup.js <groupId>` for what one group still needs.');
}

/** Everything needed to bring one group online, in the order it is needed. */
function detail(groupId) {
  const g = groups.requireGroup(groupId);
  const prefix = g.envPrefix;

  heading(`${g.displayName}  (${g.id})`);

  console.log('\n1. Create a Google Sheet for this group, then Extensions > Apps Script.');
  console.log('   Paste the CURRENT google_apps_script.js. The same file goes into every');
  console.log('   sheet — what differs is the script property in step 2.');
  console.log(`   (Or paste apps-script/${g.id}.gs.js, which has the list below built in`);
  console.log('   and needs no SUBJECTS_JSON. Either way gives the same result.)');

  console.log('\n2. Apps Script > Project Settings > Script Properties, add:');
  console.log('\n   SUBJECTS_JSON =');
  // With fixed Question ID prefixes the entries carry them, so a sheet set up
  // this way numbers questions exactly as the generated script would.
  console.log('   ' + JSON.stringify(g.subjectCodes
    ? g.subjects.map((subject) => ({ subject, code: groups.subjectCode(g, subject) }))
    : g.subjects));
  console.log('\n   API_TOKEN =');
  console.log('   ' + require('crypto').randomBytes(32).toString('hex'));
  console.log('   (a fresh one, printed for you — do not reuse another group\'s)');

  console.log('\n3. Run setupSpreadsheet. It creates every tab: subjects, Config, Subscribers,');
  console.log('   Payments, Support, Bot Settings and Coupons.');
  console.log('   Deploy > New deployment > Web app, Execute as Me, Access Anyone.');

  console.log('\n4. Create the Telegram group and add BOTH bots as admins:');
  console.log('   - the posting bot        (TELEGRAM_BOT_TOKEN)');
  console.log(`   - the payment bot        (${g.paymentBotEnv})`);
  console.log('   The payment bot needs "Invite Users via Link" and "Ban Users".');
  console.log('   Then: node group-setup.js --chat-ids');

  console.log('\n5. Put these in .env:');
  console.log(`   SHEET_URL_${prefix}=<the /exec URL from step 3>`);
  console.log(`   SHEET_TOKEN_${prefix}=<the API_TOKEN from step 2>`);
  console.log(`   TELEGRAM_GROUP_${prefix}=<the chat id from step 4>`);
  if (Object.keys(g.plans || {}).includes('autopay_monthly')) {
    console.log(`   RAZORPAY_PLAN_${prefix}=<from: node setup-razorpay.js>`);
    console.log('   (recurring passes need their own Razorpay plan per group,');
    console.log('    because the amount is baked into the plan and prices differ)');
  }

  console.log('\nCurrent state:');
  console.log('  ' + (g.ready ? 'ready ✅' : 'missing: ' + g.missing.join(', ')));
}

/**
 * chatIds — asks each payment bot which chats it can see.
 *
 * Telegram gives no "list my groups" call, so this reads pending updates. A
 * group appears once the bot has been added and someone has posted, which is
 * why step 4 says to add the bot first.
 */
async function chatIds() {
  const seenBots = new Set();
  const rows = [];

  for (const group of groups.listGroups()) {
    const envName = group.paymentBotEnv;
    if (seenBots.has(envName)) continue;
    seenBots.add(envName);

    const token = String(process.env[envName] || process.env.TELEGRAM_PAYMENT_BOT_TOKEN || '').trim();
    if (!token) {
      rows.push([envName, 'no token set', '']);
      continue;
    }

    try {
      const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
      const updates = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
      const chats = new Map();
      (updates.result || []).forEach((u) => {
        const chat = (u.message || u.my_chat_member || u.chat_member || {}).chat;
        if (chat && chat.type !== 'private') chats.set(String(chat.id), chat.title || '');
      });

      if (!chats.size) {
        rows.push([envName, '@' + (me.result || {}).username, 'no groups seen yet']);
      } else {
        chats.forEach((title, id) => rows.push([envName, '@' + (me.result || {}).username, `${id}  ${title}`]));
      }
    } catch (err) {
      rows.push([envName, 'error', err.message]);
    }
  }

  heading('Telegram chats the payment bots can see');
  rows.forEach((r) => console.log(`  ${r[0].padEnd(24)} ${String(r[1]).padEnd(22)} ${r[2]}`));
  console.log('\nA group only appears after the bot is added AND someone posts in it.');
  console.log('If a group is missing, send any message there and run this again.');
}


/**
 * inviteLinks — deep links that add each bot with its rights already ticked.
 *
 * A bot cannot add itself to a group: Telegram requires a person to do it, and
 * there is no API for it at all. What Telegram does support is ?startgroup with
 * an admin= list, which opens the group picker with exactly those rights
 * pre-selected — so the rights cannot be got wrong by hand, which is the part
 * that actually breaks setups. Manage Topics missing on the posting bot means
 * no topic can be created; invite_users missing on a payment bot means nobody
 * who pays can be let in.
 */
async function inviteLinks() {
  const postingToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();

  heading('Add the POSTING bot to all five groups');
  if (!postingToken) {
    console.log('  TELEGRAM_BOT_TOKEN is not set.');
  } else {
    const me = await (await fetch(`https://api.telegram.org/bot${postingToken}/getMe`)).json();
    const username = me.result && me.result.username;
    // manage_topics is the one that matters; the other two are conveniences.
    const rights = 'manage_topics+pin_messages+delete_messages';
    console.log(`\n  Bot: @${username}`);
    console.log('  Open this link once PER GROUP — it pre-ticks the rights:\n');
    console.log(`  https://t.me/${username}?startgroup=true&admin=${rights}`);
    console.log('\n  Tap it, choose a group, confirm. Repeat for all five.');
  }

  heading('Payment bots (already done, here for reference)');
  const seen = new Set();
  for (const group of groups.listGroups()) {
    if (seen.has(group.paymentBotEnv)) continue;
    seen.add(group.paymentBotEnv);
    const token = String(process.env[group.paymentBotEnv] || '').trim();
    if (!token) {
      console.log(`\n  ${group.paymentBotEnv}: no token set`);
      continue;
    }
    const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
    const username = me.result && me.result.username;
    console.log(`\n  @${username}`);
    console.log(`  https://t.me/${username}?startgroup=true&admin=invite_users+restrict_members`);
  }
  console.log('');
}

(async () => {
  try {
    if (args.includes('--chat-ids')) return await chatIds();
    if (args.includes('--invite-links')) return await inviteLinks();
    if (args[0] && !args[0].startsWith('--')) return detail(args[0]);
    return status();
  } catch (err) {
    console.error('❌ ' + err.message);
    process.exit(1);
  }
})();
