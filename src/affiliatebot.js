// ============================================================================
// src/affiliatebot.js — the influencer (affiliate) bot
// ============================================================================
// Separate from the payment bots on purpose: influencers are not students,
// and nothing an influencer does here should be one tap away from buying a
// pass, or the other way round.
//
// An influencer can:
//   /apply     — pick an exam (one per payment bot) and describe where they
//                will promote it; the admin gets an alert and decides on the
//                Influencers dashboard
//   /codes     — every code they hold: its terms, share link, sales, and
//                what is earned, requested and paid
//   /withdraw  — ask for a code's available earnings (weekly or monthly, as
//                the admin set, above the admin's minimum)
//   /upi       — the UPI ID they are paid on
//
// The admin decides everything else — the discount, the commission, the
// cycle — so the influencer never negotiates terms in chat.
//
// Nothing about a conversation is kept in memory. A multi-step answer (the
// application details, the UPI ID) is a reply to a prompt, and the prompt's
// first line says what it is for, so a restart between the question and the
// answer loses nothing.
// ============================================================================

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');

const affiliates = require('./affiliates');
const store = require('./affiliate-store');
const notify = require('./affiliate-notify');
const botCommands = require('./bot-commands');
const pricing = require('./pricing');
const support = require('./support');

const esc = support.esc;

/** First lines of the prompts whose replies this bot reads back. */
const PROMPT = {
  application: '📝 Application — ',
  upi: '💳 UPI ID for payouts',
  question: '🆘 Question for the admin'
};

/**
 * createAffiliateBot — the bot with every handler attached.
 *
 * @param {Object} [options]
 * @param {boolean} [options.polling] true for a local process, false for the webhook
 * @returns {{bot: Object, settle: Function}}
 */
function createAffiliateBot({ polling = false } = {}) {
  const token = String(process.env[notify.BOT_ENV] || '').trim();
  if (!token) throw new Error(`${notify.BOT_ENV} is not set, so there is no affiliate bot to run.`);

  const bot = new TelegramBot(token, polling
    ? { polling: { params: { allowed_updates: JSON.stringify(['message', 'callback_query']) } } }
    : { polling: false });

  // ---- keeping handler work alive on the deployment ------------------------
  // Same reason as src/botapp.js: processUpdate throws the handlers' promises
  // away, and on Vercel the instance freezes once the webhook has answered.
  const pending = new Set();
  const track = (handler) => function tracked(...args) {
    const work = Promise.resolve().then(() => handler.apply(this, args)).catch((err) => {
      console.error(`[affiliate-bot] handler failed: ${err && err.message}`);
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
    return work;
  };
  const registerOn = bot.on.bind(bot);
  const registerOnText = bot.onText.bind(bot);
  bot.on = (event, handler) => registerOn(event, track(handler));
  bot.onText = (regexp, handler) => registerOnText(regexp, track(handler));
  async function settle() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  // ---- small helpers --------------------------------------------------------

  const commandNames = new Set();

  function showTyping(chatId) {
    Promise.resolve().then(() => bot.sendChatAction(chatId, 'typing')).catch(() => {});
  }

  async function reply(chatId, html, extra = {}) {
    return bot.sendMessage(chatId, html, Object.assign({ parse_mode: 'HTML', disable_web_page_preview: true }, extra));
  }

  async function apologise(chatId) {
    try {
      await reply(chatId, '⚠️ Something went wrong on our side. Please try again in a moment.');
    } catch (err) {
      console.error(`[affiliate-bot] could not even apologise: ${err.message}`);
    }
  }

  const MAIN_MENU = {
    inline_keyboard: [
      [{ text: '📝 Apply to promote', callback_data: 'aff:apply' }],
      [{ text: '📊 My codes & earnings', callback_data: 'aff:codes' }],
      [{ text: '💸 Withdraw', callback_data: 'aff:withdraw' }, { text: '💳 UPI ID', callback_data: 'aff:upi' }]
    ]
  };

  function commandListText() {
    return botCommands.AFFILIATE_COMMANDS
      .map(({ command, description }) => `/${command} — ${esc(description.charAt(0).toLowerCase() + description.slice(1))}`)
      .join('\n');
  }

  function commandName(text) {
    const match = String(text || '').match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?=\s|$)/);
    return match ? match[1].toLowerCase() : '';
  }

  /** A command answered only in a private chat. The bot may sit in the admin chat. */
  function command(name, handler) {
    commandNames.add(name);
    const pattern = new RegExp(`^\\/${name}(?:@\\w+)?(?=\\s|$)(?:\\s+(\\S+))?`, 'i');
    bot.onText(pattern, async (msg, match) => {
      if (!msg || !msg.chat || msg.chat.type !== 'private') return;
      showTyping(msg.chat.id);
      try {
        await handler(msg, match);
      } catch (err) {
        console.error(`[affiliate-bot] /${name} failed: ${err && err.message}`);
        await apologise(msg.chat.id);
      }
    });
  }

  /** Without the sheet nothing here can work; say so plainly rather than fail. */
  async function requireStore(chatId) {
    if (store.isConfigured()) return true;
    await reply(chatId, '⚠️ The influencer programme is being set up. Please try again a little later.');
    return false;
  }

  // ---- screens --------------------------------------------------------------

  async function sendWelcome(chatId, user) {
    await reply(chatId,
      `👋 <b>Hello ${esc(user.first_name || 'there')}! Welcome to our influencer programme.</b>\n\n` +
      esc(botCommands.AFFILIATE_ABOUT) + '\n\n' +
      '<b>How it works</b>\n' +
      '1. Tap <b>Apply</b> and choose the exam you want to promote.\n' +
      '2. Tell us where you will promote it. An admin reviews your application.\n' +
      '3. Once approved you get your own promo code and link. Your followers get a discount.\n' +
      '4. You earn on every student who pays with your code, and withdraw over UPI.\n\n' +
      'The discount, your commission and how often you can withdraw are set by the admin when approving.',
      { reply_markup: MAIN_MENU });
  }

  async function sendExamChoice(chatId) {
    if (!(await requireStore(chatId))) return;
    const exams = affiliates.listExams();
    if (!exams.length) {
      await reply(chatId, 'No exams are open for promotion right now. Please check back soon.');
      return;
    }
    await reply(chatId,
      '<b>Which exam channel will you promote?</b>\n\n' +
      'Your code will work only in that exam\'s payment bot. You can apply for more than one — ' +
      'each is approved separately.',
      { reply_markup: { inline_keyboard: exams.map((exam) => [{ text: exam.label, callback_data: `aff:exam:${exam.id}` }]) } });
  }

  async function askForDetails(chatId, user, examId) {
    if (!(await requireStore(chatId))) return;
    const exam = affiliates.getExam(examId);
    if (!exam) {
      await reply(chatId, 'That exam is not open for promotion any more. Send /apply to see what is.');
      return;
    }
    // Checked before asking, so nobody types a whole application to be told no.
    const [requests, codes] = await Promise.all([store.listRequests(), store.listCodes()]);
    const id = String(user.id);
    if (requests.some((r) => r.telegram_id === id && r.exam === exam.id && r.status === 'pending')) {
      await reply(chatId, `Your application for <b>${esc(exam.label)}</b> is already with the admin. ` +
        'You will get a message here as soon as it is decided.');
      return;
    }
    const held = codes.find((c) => c.telegram_id === id && c.exam === exam.id && c.status === 'active');
    if (held) {
      await reply(chatId, `You already have the code <code>${esc(held.code)}</code> for <b>${esc(exam.label)}</b>. ` +
        'Send /codes to see it.');
      return;
    }
    await reply(chatId,
      `${PROMPT.application}${esc(exam.label)}\n\n` +
      'Reply to this message with:\n' +
      '• your name\n' +
      '• where you will promote it (links to your YouTube, Instagram, Telegram channel…)\n' +
      '• roughly how many followers you have\n\n' +
      '<i>Example: Ravi Kumar — youtube.com/@ravi, t.me/ravichannel — 40k subscribers</i>',
      { reply_markup: { force_reply: true, input_field_placeholder: 'Name, links, followers' } });
  }

  async function submitApplication(msg, examLabel) {
    const exam = affiliates.listExams().find((e) => e.label === examLabel);
    if (!exam) {
      await reply(msg.chat.id, 'That exam is not open for promotion any more. Send /apply to see what is.');
      return;
    }
    const result = await store.createRequest(msg.from, exam.id, support.messageText(msg));
    if (!result.ok) {
      await reply(msg.chat.id, `❌ ${esc(result.reason)}`);
      return;
    }
    const influencer = await store.getInfluencer(msg.from.id);
    await reply(msg.chat.id,
      `✅ <b>Application sent for ${esc(exam.label)}.</b>\n\n` +
      `Reference: <code>${esc(result.request.request_id)}</code>\n` +
      'An admin will review it and you will get a message here with your code and terms.' +
      (influencer && influencer.upi_id ? '' : '\n\n💳 While you wait, set the UPI ID we will pay you on with /upi.'));
    await notify.alertAdmins(notify.applicationAlert(result.request));
  }

  async function askForUpi(chatId, user) {
    if (!(await requireStore(chatId))) return;
    const influencer = await store.getInfluencer(user.id);
    await reply(chatId,
      `${PROMPT.upi}\n\n` +
      'Reply to this message with the UPI ID we should send your earnings to, e.g. <code>ravi@okicici</code>.' +
      (influencer && influencer.upi_id ? `\n\nCurrent: <code>${esc(influencer.upi_id)}</code>` : ''),
      { reply_markup: { force_reply: true, input_field_placeholder: 'name@bank' } });
  }

  async function saveUpi(msg) {
    const result = await store.setUpi(msg.from, support.messageText(msg));
    await reply(msg.chat.id, result.ok
      ? `✅ UPI ID saved: <code>${esc(result.influencer.upi_id)}</code>`
      : `❌ ${esc(result.reason)}`,
      result.ok ? {} : { reply_markup: { inline_keyboard: [[{ text: '💳 Try again', callback_data: 'aff:upi' }]] } });
  }

  /** "Mon, 29 Sep" in IST, for "you can withdraw again on …". */
  function day(date) {
    return new Date(date.getTime() + 5.5 * 60 * 60 * 1000).toUTCString().slice(0, 11);
  }

  async function sendCodes(chatId, user) {
    if (!(await requireStore(chatId))) return;
    const id = String(user.id);
    const [requests, codes, influencer] = await Promise.all([
      store.listRequests(), store.listCodes(), store.getInfluencer(id)
    ]);
    const mine = codes.filter((c) => c.telegram_id === id);
    const waiting = requests.filter((r) => r.telegram_id === id && r.status === 'pending');
    const turnedDown = requests.filter((r) => r.telegram_id === id && r.status === 'rejected').slice(-3);

    if (!mine.length && !waiting.length) {
      await reply(chatId, 'You have no promo codes yet.' +
        (turnedDown.length ? ` Your last application (${esc(notify.examLabel(turnedDown[turnedDown.length - 1].exam))}) ` +
          'was not approved.' : '') +
        '\n\nTap below to apply.',
      { reply_markup: { inline_keyboard: [[{ text: '📝 Apply to promote', callback_data: 'aff:apply' }]] } });
      return;
    }

    const blocks = [];
    const keyboard = [];
    for (const code of mine) {
      const { stats, check } = await store.withdrawalStatus(code, influencer);
      const lines = [
        `🔑 <b>${esc(code.code)}</b> — ${esc(notify.examLabel(code.exam))}` +
          (code.status === 'active' ? '' : ` <i>(${esc(code.status)})</i>`),
        ...notify.termsLines(code),
        `👥 Students joined: <b>${stats.uses}</b> · paid ${pricing.rupees(stats.revenuePaise)}`,
        `💰 Earned: <b>${pricing.rupees(stats.earnedPaise)}</b>`,
        `   ✅ Available: <b>${pricing.rupees(stats.availablePaise)}</b>` +
          (stats.requestedPaise ? ` · ⏳ requested ${pricing.rupees(stats.requestedPaise)}` : '') +
          ` · 🏦 paid ${pricing.rupees(stats.paidPaise)}`
      ];
      if (!check.ok && check.nextAt) lines.push(`🗓 Next withdrawal from ${esc(day(check.nextAt))}`);
      if (code.share_link) lines.push(`🔗 ${esc(code.share_link)}`);
      blocks.push(lines.join('\n'));

      const row = [];
      if (code.share_link) {
        row.push({
          text: `📤 Share ${code.code}`,
          url: `https://t.me/share/url?url=${encodeURIComponent(code.share_link)}` +
            `&text=${encodeURIComponent(`Use my code ${code.code} for ${affiliates.describeDiscount(code)}`)}`
        });
      }
      if (check.ok) row.push({ text: `💸 Withdraw ${pricing.rupees(check.amountPaise)}`, callback_data: `aff:wd:${code.code}` });
      if (row.length) keyboard.push(row);
    }
    for (const r of waiting) {
      blocks.push(`⏳ <b>${esc(notify.examLabel(r.exam))}</b> — application <code>${esc(r.request_id)}</code> is with the admin.`);
    }
    if (!influencer || !influencer.upi_id) blocks.push('💳 <b>No UPI ID yet</b> — set it with /upi so we can pay you.');
    keyboard.push([{ text: '🔄 Refresh', callback_data: 'aff:codes' }, { text: '📝 Apply for another', callback_data: 'aff:apply' }]);

    await reply(chatId, '<b>Your promo codes</b>\n\n' + blocks.join('\n\n'), { reply_markup: { inline_keyboard: keyboard } });
  }

  async function sendWithdrawChoice(chatId, user) {
    if (!(await requireStore(chatId))) return;
    const id = String(user.id);
    const [codes, influencer] = await Promise.all([store.listCodes(), store.getInfluencer(id)]);
    const mine = codes.filter((c) => c.telegram_id === id);
    if (!mine.length) {
      await reply(chatId, 'You have no promo codes yet, so there is nothing to withdraw. Send /apply to get one.');
      return;
    }
    const lines = [];
    const keyboard = [];
    for (const code of mine) {
      const { check } = await store.withdrawalStatus(code, influencer);
      if (check.ok) {
        lines.push(`✅ <b>${esc(code.code)}</b>: ${pricing.rupees(check.amountPaise)} ready`);
        keyboard.push([{ text: `💸 Withdraw ${pricing.rupees(check.amountPaise)} (${code.code})`, callback_data: `aff:wd:${code.code}` }]);
      } else {
        lines.push(`• <b>${esc(code.code)}</b>: ${esc(check.reason)}` +
          (check.nextAt ? ` Next withdrawal from ${esc(day(check.nextAt))}.` : ''));
      }
    }
    if (!influencer || !influencer.upi_id) keyboard.push([{ text: '💳 Set UPI ID', callback_data: 'aff:upi' }]);
    await reply(chatId,
      '<b>Withdraw</b>\n\n' + lines.join('\n') +
      (influencer && influencer.upi_id ? `\n\nWe pay to <code>${esc(influencer.upi_id)}</code> (change with /upi).` : ''),
      keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
  }

  async function withdraw(chatId, user, code) {
    if (!(await requireStore(chatId))) return;
    const result = await store.requestPayout(code, user.id);
    if (!result.ok) {
      await reply(chatId, `❌ ${esc(result.reason)}` +
        (result.nextAt ? ` You can withdraw again from ${esc(day(result.nextAt))}.` : ''));
      return;
    }
    await reply(chatId,
      `✅ <b>Withdrawal requested: ${pricing.rupees(result.payout.amount_paise)}</b>\n\n` +
      `Reference: <code>${esc(result.payout.payout_id)}</code>\n` +
      `We will send it to <code>${esc(result.payout.upi_id)}</code> and message you here with the UPI reference.`);
    await notify.alertAdmins(notify.withdrawalAlert(result.payout));
  }

  async function sendHelp(chatId) {
    await reply(chatId,
      '<b>How the influencer programme works</b>\n\n' +
      '1. /apply — choose an exam channel and tell us where you will promote it.\n' +
      '2. The admin reviews it and sets your terms: the discount your followers get, what you earn per ' +
      'student, and whether you withdraw weekly or monthly.\n' +
      '3. You get a promo code and a link. Your code works only in that exam\'s payment bot.\n' +
      '4. Every student who pays with your code earns you the commission — you get a message each time.\n' +
      '5. /withdraw — when your cycle comes round and you are above the minimum. We pay by UPI (/upi) ' +
      'and send you the reference.\n\n' +
      'Commands:\n' + commandListText(),
      { reply_markup: MAIN_MENU });
  }

  async function sendTerms(chatId) {
    await reply(chatId,
      '<b>Programme terms</b>\n\n' +
      '1. The student discount, your commission, the payout cycle and the minimum withdrawal are set by the ' +
      'admin for each code, and shown to you when it is approved.\n' +
      '2. Commission is earned only on payments that succeed, and is worked out on what the student actually paid.\n' +
      '3. A code works only in the payment bot of the exam it was approved for.\n' +
      '4. You cannot use your own code.\n' +
      '5. Withdrawals are paid by UPI to the ID you set, by hand, after the admin checks them. You get the UPI ' +
      'reference when it is sent.\n' +
      '6. The admin may pause a code — for example if it is misused. What you have already earned stays yours.\n' +
      '7. Students\' payments are final: there are no refunds.');
  }

  async function askQuestion(chatId) {
    await reply(chatId, `${PROMPT.question}\n\nReply to this message with your question and an admin will get back to you.`,
      { reply_markup: { force_reply: true, input_field_placeholder: 'Your question' } });
  }

  async function forwardQuestion(msg) {
    const text = support.messageText(msg);
    if (!text) {
      await reply(msg.chat.id, 'Please type your question as text.');
      return;
    }
    const sent = await notify.alertAdmins(
      `🆘 <b>Question from an influencer</b>\n\n` +
      `${msg.from.username ? '@' + esc(msg.from.username) : esc(msg.from.first_name || '')} · ` +
      `<code>${esc(msg.from.id)}</code>\n\n${esc(text.slice(0, 1500))}`);
    await reply(msg.chat.id, sent
      ? '✅ Sent to the admin. They will reply to you on Telegram.'
      : '⚠️ Could not reach the admin just now. Please try again later.');
  }

  // ---- commands ---------------------------------------------------------------

  command('start', async (msg) => { await sendWelcome(msg.chat.id, msg.from); });
  command('apply', async (msg) => { await sendExamChoice(msg.chat.id); });
  command('codes', async (msg) => { await sendCodes(msg.chat.id, msg.from); });
  command('status', async (msg) => { await sendCodes(msg.chat.id, msg.from); });
  command('earnings', async (msg) => { await sendCodes(msg.chat.id, msg.from); });
  command('withdraw', async (msg) => { await sendWithdrawChoice(msg.chat.id, msg.from); });
  command('upi', async (msg) => { await askForUpi(msg.chat.id, msg.from); });
  command('help', async (msg) => { await sendHelp(msg.chat.id); });
  command('terms', async (msg) => { await sendTerms(msg.chat.id); });
  command('support', async (msg) => { await askQuestion(msg.chat.id); });
  command('settings', async (msg) => {
    await reply(msg.chat.id,
      '<b>Settings</b>\n\n/upi — the UPI ID we pay you on\n/codes — your codes and their terms\n\n' +
      'Your discount, commission and payout cycle are set by the admin for each code.',
      { reply_markup: MAIN_MENU });
  });

  // ---- buttons ----------------------------------------------------------------

  bot.on('callback_query', async (query) => {
    const data = String(query.data || '');
    const user = query.from;
    const ack = async (text) => {
      try { await bot.answerCallbackQuery(query.id, text ? { text } : undefined); } catch (err) { /* stale button */ }
    };
    const chatId = user.id;
    try {
      if (data === 'aff:apply') { await ack(); await sendExamChoice(chatId); return; }
      if (data.startsWith('aff:exam:')) { await ack(); await askForDetails(chatId, user, data.slice(9)); return; }
      if (data === 'aff:codes') { await ack(); await sendCodes(chatId, user); return; }
      if (data === 'aff:withdraw') { await ack(); await sendWithdrawChoice(chatId, user); return; }
      if (data === 'aff:upi') { await ack(); await askForUpi(chatId, user); return; }
      if (data.startsWith('aff:wd:')) { await ack('Requesting…'); await withdraw(chatId, user, data.slice(7)); return; }
      await ack();
    } catch (err) {
      console.error(`[affiliate-bot] ${data} failed: ${err.message}`);
      await apologise(chatId);
    }
  });

  // ---- everything else ----------------------------------------------------------

  bot.on('message', async (msg) => {
    if (!msg || !msg.chat || !msg.from || msg.from.is_bot || msg.chat.type !== 'private') return;
    const text = String(msg.text || '');

    if (text.startsWith('/')) {
      if (commandNames.has(commandName(text))) return;
      await reply(msg.chat.id, 'Sorry, I do not know that command. Here is what I can do:\n\n' + commandListText(),
        { reply_markup: MAIN_MENU });
      return;
    }

    try {
      const replied = msg.reply_to_message;
      const prompt = replied && replied.from && replied.from.is_bot ? support.messageText(replied) : '';
      if (prompt.startsWith(PROMPT.application)) {
        await submitApplication(msg, prompt.split('\n')[0].slice(PROMPT.application.length).trim());
        return;
      }
      if (prompt.startsWith(PROMPT.upi)) { await saveUpi(msg); return; }
      if (prompt.startsWith(PROMPT.question)) { await forwardQuestion(msg); return; }
    } catch (err) {
      console.error(`[affiliate-bot] reply handling failed: ${err.message}`);
      await apologise(msg.chat.id);
      return;
    }

    // A sticker, a photo, a message typed without replying to a prompt: point
    // the way rather than stay silent.
    await reply(msg.chat.id,
      'To apply, check your codes or withdraw, use the buttons below or one of these:\n\n' + commandListText(),
      { reply_markup: MAIN_MENU });
  });

  return { bot, settle };
}

module.exports = { createAffiliateBot, PROMPT };
