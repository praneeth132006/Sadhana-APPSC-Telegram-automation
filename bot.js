// ============================================================================
// bot.js — run the payment bots locally, by polling
// ============================================================================
// The handlers live in src/botapp.js. This file only decides WHICH families to
// run and starts them.
//
//   node bot.js                              every family that is configured
//   PAYBOT_ENV=TELEGRAM_PAYBOT_UPSC node bot.js   just that one
//
// It used to run exactly one family, chosen by PAYBOT_ENV, and refused to start
// without it — so running the payment bots meant three terminals started by
// hand. In practice one was running and two were not, and the two that were not
// simply never answered. Running all of them by default is the point of this
// file now; naming one is the exception.
//
// On the deployment there is no process to start at all: server.js serves the
// same handlers over Telegram webhooks. See set-webhooks.js.
// ============================================================================

require('dotenv').config();

const { createPaymentBot } = require('./src/botapp');
const groupRegistry = require('./src/groups');
const plans = require('./src/plans');
const razorpay = require('./src/razorpay');

/** Every payment-bot env var named by a ready group, deduplicated. */
function configuredFamilies() {
  const named = String(process.env.PAYBOT_ENV || '').trim();
  if (named) return [named];

  return [...new Set(
    groupRegistry.listGroups()
      .filter((g) => g.ready && g.paymentBotEnv)
      .map((g) => g.paymentBotEnv)
  )].filter((env) => String(process.env[env] || '').trim());
}

const families = configuredFamilies();

if (!families.length) {
  console.error(
    '❌ No payment bot to run.\n' +
    '   Every group in groups.config.json names a paymentBotEnv; set that token in .env.\n' +
    '   Expected one of: TELEGRAM_PAYBOT_NEWS, TELEGRAM_PAYBOT_SADHANA, TELEGRAM_PAYBOT_UPSC, TELEGRAM_PAYBOT_EPFO'
  );
  process.exit(1);
}

const running = [];
const failed = [];

for (const payBotEnv of families) {
  try {
    running.push(createPaymentBot({ payBotEnv, polling: true }));
  } catch (err) {
    // One misconfigured family must not stop the others: two working bots and a
    // clear message beats three silent ones.
    failed.push({ payBotEnv, message: err.message });
  }
}

console.log('════════════════════════════════════════════════════');
console.log(`🤖 Payment bots running — ${running.length} of ${families.length}`);
console.log(`   Razorpay : ${razorpay.isTestMode() ? 'TEST mode' : 'LIVE mode'}`);
for (const app of running) {
  console.log(`   ── ${app.payBotEnv}`);
  app.familyGroups().forEach((group) => {
    console.log(`      ${group.shortName}  (${group.telegramGroupId})`);
    console.log(`         ${app.plansFor(group.id)
      .map((p) => p.label + ' ' + plans.formatAmount(p.amountPaise)).join(', ')}`);
  });
}
for (const f of failed) {
  console.log(`   ❌ ${f.payBotEnv} did not start: ${f.message.split('\n')[0]}`);
}
console.log('   Commands : /start /plans /status /cancel /help');
console.log('════════════════════════════════════════════════════');

if (!running.length) process.exit(1);

// Stop cleanly so polling does not linger on restart.
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    console.log('\nStopping bots…');
    Promise.allSettled(running.map((app) => app.bot.stopPolling()))
      .then(() => process.exit(0));
  });
});
