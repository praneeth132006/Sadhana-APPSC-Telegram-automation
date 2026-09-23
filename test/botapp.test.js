// ============================================================================
// Payment bot handler lifetime (test/botapp.test.js)
// ============================================================================
// Run with: npm test
//
// The regression this file exists for: every payment bot answered nobody from
// the deployment while Telegram reported clean delivery and zero errors.
//
// processUpdate() dispatches handlers synchronously and throws their promises
// away. A long-lived `node bot.js` does not care — the process stays up and the
// reply goes out whenever it is ready. On Vercel the instance is frozen the
// moment the response is sent, so the handler's outbound call to Telegram died
// mid-TLS-handshake every time:
//
//   Unhandled Rejection: RequestError: Client network socket disconnected
//   before secure TLS connection was established
//   Node.js process exited with exit status: 128
//
// settle() is what lets server.js wait for that work. Nothing here talks to
// Telegram or Razorpay: these assert the tracking mechanism itself, which is
// the part that was missing.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret';
process.env.SHEET_URL_UPSC = process.env.SHEET_URL_UPSC || 'https://script.google.com/macros/s/test-upsc/exec';
process.env.SHEET_TOKEN_UPSC = process.env.SHEET_TOKEN_UPSC || 'token-for-tests';
process.env.TELEGRAM_GROUP_UPSC = process.env.TELEGRAM_GROUP_UPSC || '-1009999999999';
process.env.TELEGRAM_PAYBOT_UPSC = process.env.TELEGRAM_PAYBOT_UPSC || '123:TEST';

const { createPaymentBot } = require('../src/botapp');
// Code tracking off: a local .env would otherwise point it at the real sheets.
require('../src/code-tracking').isConfigured = () => false;

// No test may reach the real Telegram API. The server reads .env, which holds
// real bot tokens and the real SUPPORT_CHAT_ID; without this, any code path a
// test forgot to stub would post into the live support group. A test that
// wants Telegram replaces the specific method it needs, which runs instead.
require('node-telegram-bot-api').prototype._request = async function (method) {
  throw new Error(`Telegram API call "${method}" attempted in a test — stub it`);
};

// Nor the live Google Sheets or Razorpay: .env points at real ones.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(url, ...rest) {
    const target = String(url && url.url ? url.url : url);
    if (/^https:\/\/(script\.google(usercontent)?\.com|api\.razorpay\.com|api\.telegram\.org)\//.test(target)) {
      return Promise.reject(new Error(`Network call to ${target.split('?')[0]} attempted in a test — stub it`));
    }
    return realFetch.call(this, url, ...rest);
  };
}

/** A bot with no polling and no network, for asserting handler bookkeeping. */
function makeBot() {
  return createPaymentBot({ payBotEnv: 'TELEGRAM_PAYBOT_UPSC', polling: false });
}

test('settle() waits for an async handler to finish', async () => {
  const app = makeBot();
  let finished = false;

  app.bot.on('chat_member', async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    finished = true;
  });

  app.bot.processUpdate({ update_id: 1, chat_member: { chat: { id: 1 }, from: { id: 2 } } });

  // The exact shape of the bug: dispatch returns with the work still pending,
  // so answering here is answering before anything has been sent.
  assert.equal(finished, false, 'processUpdate should return before the work is done');

  await app.settle();
  assert.equal(finished, true, 'settle() returned while handler work was still outstanding');
});

test('settle() waits for work a handler starts while being awaited', async () => {
  // Handlers do not do one thing: they reply, then write to the sheet. Awaiting
  // the pending set once would return between those two steps.
  const app = makeBot();
  const done = [];

  app.bot.on('chat_member', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    done.push('reply');
    await new Promise((resolve) => setTimeout(resolve, 20));
    done.push('sheet write');
  });

  app.bot.processUpdate({ update_id: 2, chat_member: { chat: { id: 1 }, from: { id: 2 } } });
  await app.settle();

  assert.deepEqual(done, ['reply', 'sheet write']);
});

test('a throwing handler does not become an unhandled rejection', async () => {
  // This is what exited the process with status 128 and took the whole
  // instance down mid-reply, so settle() must absorb it and still resolve.
  const app = makeBot();

  app.bot.on('chat_member', async () => {
    throw new Error('Client network socket disconnected');
  });

  app.bot.processUpdate({ update_id: 3, chat_member: { chat: { id: 1 }, from: { id: 2 } } });

  await assert.doesNotReject(() => app.settle());
});

test('settle() resolves when there is no work at all', async () => {
  const app = makeBot();
  await assert.doesNotReject(() => app.settle());
});
