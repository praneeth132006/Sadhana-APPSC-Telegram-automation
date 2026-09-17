#!/usr/bin/env node
// ============================================================================
// set-webhooks.js — point every payment bot at the deployment
// ============================================================================
// Tells Telegram to deliver each bot's updates to the deployed server instead
// of waiting for a laptop to poll for them.
//
//   node set-webhooks.js            register all of them
//   node set-webhooks.js --status   just report what Telegram currently has
//   node set-webhooks.js --delete   go back to polling (node bot.js)
//
// Run this once, and after any change to PUBLIC_BASE_URL or CRON_SECRET.
//
// Polling and webhooks are mutually exclusive per bot: setting a webhook stops
// getUpdates working, and a local `node bot.js` will then log 409 Conflict.
// That is Telegram telling you the deployment owns this bot now, which is the
// point — use --delete before going back to a local process.
// ============================================================================

require('dotenv').config();

const crypto = require('crypto');
const groups = require('./src/groups');
const support = require('./src/support');

/** Must match telegramWebhookSecret() in server.js exactly. */
function webhookSecret() {
  const base = String(process.env.TELEGRAM_WEBHOOK_SECRET || process.env.CRON_SECRET || '').trim();
  if (!base) return '';
  return crypto.createHash('sha256').update('telegram-webhook:' + base).digest('hex').slice(0, 48);
}

// Must match ALLOWED_UPDATES in src/botapp.js. Telegram remembers the last list
// it was given and silently drops every other type, so callback_query and
// chat_join_request being absent means taps and join requests vanish with no
// error anywhere.
const ALLOWED_UPDATES = [
  'message', 'callback_query', 'my_chat_member', 'chat_member', 'chat_join_request'
];

/** Every payment-bot env var a ready group names, deduplicated. */
function families() {
  return [...new Set(
    groups.listGroups().filter((g) => g.ready && g.paymentBotEnv).map((g) => g.paymentBotEnv)
  )].filter((env) => String(process.env[env] || '').trim());
}

async function call(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

/** What students see when they type "/" to the bot. */
const STUDENT_COMMANDS = [
  { command: 'plans', description: 'See the pass and buy it' },
  { command: 'status', description: 'Your pass and expiry date' },
  { command: 'support', description: 'Get help with a problem' },
  { command: 'help', description: 'How it works' }
];

/** What admins see when they type "/" in the support chat. */
const ADMIN_COMMANDS = [
  { command: 'summary', description: 'How many tickets need a reply, are open, in progress, closed' },
  { command: 'tickets', description: 'Tickets needing a reply (or: open, progress, student, closed)' },
  { command: 'find', description: 'Look up a pay_ id, a student (id or @username) or a ticket id' },
  { command: 'msg', description: 'Message a student: /msg <id or @username> text' },
  { command: 'settings', description: 'Bot texts, pass name and price' },
  { command: 'supporthelp', description: 'How to handle support' }
];

/**
 * registerCommandMenus — the "/" menus: student commands in private chats,
 * admin commands in this bot's support chat. Failure is reported, never fatal.
 */
async function registerCommandMenus(token, payBotEnv) {
  const students = await call(token, 'setMyCommands', {
    commands: STUDENT_COMMANDS, scope: { type: 'all_private_chats' }
  });
  console.log(students.ok ? '   ✅ student command menu' : `   ⚠️ student command menu: ${students.description}`);

  const chat = support.supportChatFor(payBotEnv);
  if (!chat) return;
  const admins = await call(token, 'setMyCommands', {
    commands: ADMIN_COMMANDS, scope: { type: 'chat', chat_id: chat.chatId }
  });
  console.log(admins.ok
    ? '   ✅ admin command menu in the support chat'
    : `   ⚠️ admin command menu: ${admins.description} (is the bot a member of the support chat?)`);
}

async function main() {
  const mode = process.argv.includes('--delete') ? 'delete'
    : process.argv.includes('--status') ? 'status' : 'set';

  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const secret = webhookSecret();

  if (mode === 'set') {
    if (!base) {
      console.error('❌ PUBLIC_BASE_URL is not set — there is nowhere to send updates.');
      process.exit(1);
    }
    if (!secret) {
      console.error(
        '❌ Neither TELEGRAM_WEBHOOK_SECRET nor CRON_SECRET is set.\n' +
        '   The server refuses unauthenticated bot webhooks, so registering one now\n' +
        '   would leave every bot silently unable to answer.'
      );
      process.exit(1);
    }
  }

  const list = families();
  if (!list.length) {
    console.error('❌ No configured payment bots. Check groups.config.json and .env.');
    process.exit(1);
  }

  // Registering a webhook stops Telegram delivering updates any other way. If
  // the deployment does not serve the route yet, doing that turns every bot off
  // at once and the only symptom is silence. So prove the endpoint is there
  // first — and prove it with the SECRET, sending an update with no content for
  // any handler to act on.
  //
  // An unauthenticated probe is not proof: a server without this route falls
  // through to the Firebase auth gate, which answers 401 to a request with no
  // token — exactly what a deployed-but-unauthenticated route returns. I
  // registered the webhooks against an old deployment on that reasoning and
  // took all three bots down until I noticed. Only 200 to a correctly-signed
  // probe distinguishes the two.
  if (mode === 'set') {
    const probe = `${base}/api/telegram/bot/${encodeURIComponent(list[0])}`;
    let status = 0;
    try {
      status = (await fetch(probe, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': secret
        },
        // update_id only: nothing here matches a command, a tap or a join
        // request, so no handler does anything with it.
        body: JSON.stringify({ update_id: 0 })
      })).status;
    } catch (err) {
      console.error(`❌ Could not reach ${base} — ${err.message}`);
      process.exit(1);
    }

    if (status === 200) {
      console.log('✅ The deployment serves the bot webhook route and accepts the secret.\n');
    } else if (status === 401) {
      console.error(
        `❌ ${base} rejected a correctly-signed probe.\n` +
        '   Either the deployment is older than this checkout, or its CRON_SECRET\n' +
        '   differs from the one in .env. Deploy and run ./push-env-to-vercel.sh —\n' +
        '   registering webhooks now would leave every bot unable to answer.'
      );
      process.exit(1);
    } else if (status === 503) {
      console.error(
        '❌ The deployment has the route but refuses to use it: no CRON_SECRET\n' +
        '   (or TELEGRAM_WEBHOOK_SECRET) in its environment. Push it with\n' +
        '   ./push-env-to-vercel.sh first, or every bot would go silent.'
      );
      process.exit(1);
    } else {
      console.error(
        `❌ ${base} answered ${status} for the bot webhook route, not 200.\n` +
        '   That deployment is older than this checkout. Deploy first — registering\n' +
        '   webhooks now would stop Telegram delivering updates any other way and\n' +
        '   leave every bot unable to answer, with nothing in any log to say why.'
      );
      process.exit(1);
    }
  }

  const failures = [];

  console.log('════════════════════════════════════════════════════');
  console.log(`🔗 Telegram webhooks — ${mode}`);
  console.log('════════════════════════════════════════════════════\n');

  for (const payBotEnv of list) {
    const token = String(process.env[payBotEnv]).trim();
    const me = await call(token, 'getMe');
    const name = me.ok ? '@' + me.result.username : '(unreachable)';
    const served = groups.listGroups().filter((g) => g.paymentBotEnv === payBotEnv && g.ready);

    console.log(`── ${payBotEnv}  ${name}`);
    console.log(`   sells: ${served.map((g) => g.shortName).join(', ') || '(nothing)'}`);

    if (mode === 'status') {
      const info = await call(token, 'getWebhookInfo');
      const r = info.result || {};
      console.log(`   webhook       : ${r.url || '(none — this bot needs a local `node bot.js`)'}`);
      console.log(`   pending       : ${r.pending_update_count || 0}`);
      if (r.last_error_message) {
        console.log(`   ❌ last error : ${r.last_error_message} (${new Date((r.last_error_date || 0) * 1000).toISOString()})`);
      }
      console.log('');
      continue;
    }

    if (mode === 'delete') {
      const out = await call(token, 'deleteWebhook', { drop_pending_updates: false });
      console.log(out.ok ? '   ✅ webhook removed — polling works again\n' : `   ❌ ${out.description}\n`);
      continue;
    }

    const url = `${base}/api/telegram/bot/${encodeURIComponent(payBotEnv)}`;
    const out = await call(token, 'setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ALLOWED_UPDATES,
      // Keep whatever queued up while nothing was listening: those are real
      // students who pressed a button and got no answer.
      drop_pending_updates: false,
      max_connections: 20
    });
    if (!out.ok) {
      console.log(`   ❌ ${out.description}\n`);
      failures.push(payBotEnv);
      continue;
    }

    // Telegram answering ok is not proof the webhook stuck. A local `node
    // bot.js` polling this same token calls deleteWebhook, so a poller running
    // anywhere wipes the registration a moment after it is made — leaving a ✅
    // on screen and a bot that answers nothing. Read it back and believe only
    // that. This is the failure that took all three bots down silently.
    const check = await call(token, 'getWebhookInfo');
    if ((check.result || {}).url !== url) {
      console.log(
        `   ❌ Telegram accepted the webhook, then it vanished.\n` +
        `      Something is still polling ${payBotEnv} and deleting it — almost\n` +
        `      always a running \`node bot.js\`. Stop it, then run this again.\n`
      );
      failures.push(payBotEnv);
      continue;
    }

    console.log(`   ✅ ${url}`);
    await registerCommandMenus(token, payBotEnv);
    console.log('');
  }

  // A per-bot readback only proves the webhook survived that instant. A poller
  // deletes on its own schedule, so one that wiped a bot registered earlier in
  // this loop would still have printed ✅. Sweep every bot once at the end,
  // after the last write, and report on that.
  if (mode === 'set') {
    for (const payBotEnv of list) {
      if (failures.includes(payBotEnv)) continue;
      const token = String(process.env[payBotEnv]).trim();
      const url = `${base}/api/telegram/bot/${encodeURIComponent(payBotEnv)}`;
      const check = await call(token, 'getWebhookInfo');
      if ((check.result || {}).url !== url) failures.push(payBotEnv);
    }
  }

  if (failures.length) {
    console.error(
      `❌ ${failures.length} of ${list.length} bots are NOT registered: ${failures.join(', ')}\n` +
      '   Those bots answer nothing until this succeeds.\n' +
      '   Stop every running `node bot.js` (pkill -f "node bot.js"), then re-run.'
    );
    process.exit(1);
  }

  if (mode === 'set') {
    console.log('────────────────────────────────────────────────────');
    console.log('Every bot now answers from the deployment. There is no');
    console.log('local process to start, and a price change takes effect');
    console.log('when you deploy.');
    console.log('');
    console.log('Stop any running `node bot.js` — polling and webhooks are');
    console.log('mutually exclusive, and the local one will now log 409s.');
    console.log('────────────────────────────────────────────────────');
  }
}

main().catch((err) => {
  console.error('❌ ' + err.message);
  process.exit(1);
});
