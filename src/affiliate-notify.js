// ============================================================================
// src/affiliate-notify.js — what the affiliate bot says, and to whom
// ============================================================================
// Two audiences:
//
//   the influencer — told when the admin decides their application, on every
//                    sale through their code, and when a withdrawal is paid or
//                    turned down
//   the admins     — told in the Support Team chat when an application or a
//                    withdrawal request arrives, with a button to the page
//                    where it is decided
//
// Every message is built here, so the bot, the webhook and the dashboard
// cannot describe the same terms three different ways. Sending never throws:
// a message that cannot be delivered is logged, and whatever caused it — an
// approval, a sale, a payout — has already happened and stays done.
// ============================================================================

const TelegramBot = require('node-telegram-bot-api');

const affiliates = require('./affiliates');
const pricing = require('./pricing');
const support = require('./support');

/** The env var holding the affiliate bot's token. */
const BOT_ENV = 'TELEGRAM_AFFILIATE_BOT';

const esc = support.esc;

function token() {
  return String(process.env[BOT_ENV] || '').trim();
}

/** True when the affiliate bot has a token. */
function isConfigured() {
  return Boolean(token());
}

let client = null;
let clientToken = '';
/** A non-polling client for sending, rebuilt if the token changes (tests). */
function bot() {
  if (!client || clientToken !== token()) {
    client = new TelegramBot(token(), { polling: false });
    clientToken = token();
  }
  return client;
}

/** For tests: send through a stand-in. */
function useClient(stub) {
  client = stub;
  clientToken = token();
}

/**
 * Where admin alerts go: AFFILIATE_ADMIN_CHAT_ID when set, otherwise the
 * Support Team chat every payment bot already posts to.
 */
function adminChat() {
  const own = String(process.env.AFFILIATE_ADMIN_CHAT_ID || '').trim();
  const chatId = own || String(process.env.SUPPORT_CHAT_ID || '').trim();
  if (!/^-?\d+$/.test(chatId)) return null;
  const thread = own ? String(process.env.AFFILIATE_ADMIN_THREAD_ID || '').trim()
    : String(process.env.SUPPORT_THREAD_ID || '').trim();
  return { chatId, threadId: /^\d+$/.test(thread) ? Number(thread) : null };
}

/** The Influencers dashboard, for the button under an alert. */
function dashboardUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\//.test(base) ? `${base}/influencers.html` : '';
}

async function send(chatId, html, extra = {}) {
  if (!isConfigured()) return false;
  try {
    await bot().sendMessage(chatId, html, Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, extra));
    return true;
  } catch (err) {
    console.error(`[affiliates] could not message ${chatId}: ${err.message}`);
    return false;
  }
}

/** A short alert for the admins, with a button to decide it. */
async function alertAdmins(html) {
  const chat = adminChat();
  if (!chat) return false;
  const extra = {};
  if (chat.threadId) extra.message_thread_id = chat.threadId;
  const url = dashboardUrl();
  if (url) extra.reply_markup = { inline_keyboard: [[{ text: '🤝 Open Influencers', url }]] };
  return send(chat.chatId, html, extra);
}

async function tellInfluencer(telegramId, html, extra) {
  return send(telegramId, html, extra);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** "Ravi Kumar (@ravi)" / "@ravi" / "ID 501". */
function who(person) {
  const name = String(person.name || '').trim();
  const handle = String(person.username || '').replace(/^@/, '').trim();
  if (name && handle) return `${esc(name)} (@${esc(handle)})`;
  if (name) return esc(name);
  if (handle) return '@' + esc(handle);
  return `ID ${esc(person.telegram_id || person.influencer_id || '')}`;
}

function examLabel(examId) {
  const exam = affiliates.getExam(examId);
  return exam ? exam.label : String(examId || '').toUpperCase();
}

/** The terms of a code, the same way everywhere they are shown. */
function termsLines(code) {
  const lines = [
    `🎁 Students get: <b>${esc(affiliates.describeDiscount(code))}</b>`,
    `💰 You earn: <b>${esc(affiliates.describeCommission(code))}</b>`,
    `🗓 Withdraw: <b>${esc(code.payout_cycle)}</b>` +
      (Number(code.min_payout) > 0 ? `, from <b>${pricing.rupees(Number(code.min_payout) * 100)}</b>` : '')
  ];
  if (code.expires_on) lines.push(`⏳ Code valid until <b>${esc(code.expires_on)}</b>`);
  if (code.max_uses !== '' && code.max_uses !== undefined && code.max_uses !== null) {
    lines.push(`🔢 Up to <b>${esc(code.max_uses)}</b> uses`);
  }
  if (/^(yes|true)$/i.test(String(code.one_per_student)) || code.one_per_student === true) {
    lines.push('👤 One use per student');
  }
  return lines;
}

function applicationAlert(request) {
  return `📝 <b>New influencer application</b>\n\n` +
    `${who(request)} · <code>${esc(request.telegram_id)}</code>\n` +
    `Exam: <b>${esc(examLabel(request.exam))}</b>\n` +
    `Request: <code>${esc(request.request_id)}</code>\n\n` +
    `${esc(String(request.details || '').slice(0, 600))}\n\n` +
    '<i>Approve it with your terms, or reject it, on the Influencers page.</i>';
}

function withdrawalAlert(payout) {
  return `💸 <b>Withdrawal requested</b>\n\n` +
    `${who(payout)} · <code>${esc(payout.influencer_id)}</code>\n` +
    `Code <b>${esc(payout.code)}</b> (${esc(examLabel(payout.exam))})\n` +
    `Amount: <b>${pricing.rupees(payout.amount_paise)}</b> for ${esc(payout.sales)} sale(s)\n` +
    `UPI: <code>${esc(payout.upi_id)}</code>\n` +
    `Request: <code>${esc(payout.payout_id)}</code>\n\n` +
    '<i>Send the money, then mark it paid with the UPI reference on the Influencers page.</i>';
}

function approvedMessage(code) {
  const link = code.share_link || '';
  return [
    `✅ <b>You're approved for ${esc(examLabel(code.exam))}!</b>`,
    '',
    `🔑 Your promo code: <code>${esc(code.code)}</code>  <i>(tap to copy)</i>`,
    '',
    ...termsLines(code),
    '',
    link
      ? `🔗 <b>Your link</b> — share this. It opens the payment bot with your code already applied:\n${esc(link)}`
      : 'Students type your code at checkout in the payment bot.',
    '',
    `<i>Your code works only in the ${esc(examLabel(code.exam))} payment bot. ` +
      'Send /codes any time to see your sales and earnings.</i>',
    '',
    '🔒 <i>Your email and mobile number are now fixed. To change them, send /support.</i>'
  ].join('\n');
}

/** A code paused or resumed by the admin. */
function codeStatusMessage(code) {
  return code.status === 'paused'
    ? `⏸ <b>Your code ${esc(code.code)} has been paused</b> by the admin, so students cannot use it for now.\n\n` +
      'What you have already earned stays yours, and you can still withdraw it. Send /support to ask why.'
    : `▶️ <b>Your code ${esc(code.code)} is active again.</b> Students can use it from now.`;
}

function rejectedMessage(request) {
  return `🙏 <b>Your application for ${esc(examLabel(request.exam))} was not approved this time.</b>` +
    (request.reason ? `\n\nReason: ${esc(request.reason)}` : '') +
    '\n\nYou are welcome to apply again later with /apply.';
}

function saleMessage(sale, stats) {
  return `🎉 <b>New sale with your code ${esc(sale.code)}</b>\n\n` +
    `A student joined ${esc(examLabel(sale.exam))} and paid ${pricing.rupees(sale.paid_paise)}.\n` +
    `You earned <b>${pricing.rupees(sale.commission_paise)}</b>.\n\n` +
    (stats ? `Available to withdraw: <b>${pricing.rupees(stats.availablePaise)}</b> · ` +
      `total earned ${pricing.rupees(stats.earnedPaise)}\n\n` : '') +
    'Send /codes for everything, or /withdraw when you are ready.';
}

function payoutPaidMessage(payout) {
  // Said the way it was paid: a bank transfer has no UPI ID to name.
  const bank = payout.payout_method === 'bank';
  const account = String(payout.account_number || '');
  const masked = account.length > 4 ? 'X'.repeat(Math.min(account.length - 4, 8)) + account.slice(-4) : account;
  return `✅ <b>Paid: ${pricing.rupees(payout.amount_paise)}</b>\n\n` +
    (bank
      ? `Sent to your bank account <code>${esc(masked)}</code> for code ${esc(payout.code)}.\n` +
        `Bank reference (UTR): <code>${esc(payout.reference)}</code>\n\n`
      : `Sent to <code>${esc(payout.upi_id)}</code> for code ${esc(payout.code)}.\n` +
        `UPI reference: <code>${esc(payout.reference)}</code>\n\n`) +
    'Thank you for promoting us!';
}

function payoutRejectedMessage(payout) {
  return `⚠️ <b>Your withdrawal ${esc(payout.payout_id)} was not paid.</b>` +
    (payout.reason ? `\n\nReason: ${esc(payout.reason)}` : '') +
    '\n\nThe amount is back in your balance. Fix anything mentioned above (for example your UPI ID or bank account with /payout), ' +
    'then send /withdraw again.';
}

module.exports = {
  BOT_ENV,
  isConfigured,
  bot,
  useClient,
  adminChat,
  dashboardUrl,
  alertAdmins,
  tellInfluencer,
  termsLines,
  examLabel,
  applicationAlert,
  withdrawalAlert,
  approvedMessage,
  rejectedMessage,
  saleMessage,
  payoutPaidMessage,
  payoutRejectedMessage,
  codeStatusMessage
};
