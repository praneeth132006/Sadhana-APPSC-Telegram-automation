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
  applyEmail: '✉️ Apply for ',
  applyPhone: '📱 Mobile number for ',
  upi: '💳 UPI ID for payouts',
  legal_name: '✏️ Your name as on your bank account',
  phone: '📱 Your mobile number',
  email: '✉️ Your email address',
  pan: '🪪 Your PAN',
  bank: '🏦 Bank account for payouts',
  question: '🆘 Question for the admin'
};

/** What each single-field prompt asks for, with an example. */
const FIELD_PROMPTS = {
  legal_name: ['legal_name', 'Reply with your full name exactly as it appears on your bank account.', 'Ravi Kumar'],
  phone: ['phone', 'Reply with your 10-digit mobile number. RazorpayX needs it to pay you.', '9876543210'],
  email: ['email', 'Reply with your email address. Payout receipts go here.', 'ravi@gmail.com'],
  upi_id: ['upi', 'Reply with the UPI ID we should send your earnings to.', 'ravi@okicici'],
  pan: ['pan', 'Optional — only needed for tax records on larger payouts. Reply with your PAN.', 'ABCDE1234F']
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
      [{ text: '💸 Withdraw', callback_data: 'aff:withdraw' }, { text: '💳 Payout details', callback_data: 'aff:payout' }]
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
      `${PROMPT.applyEmail}${esc(exam.label)}\n\n` +
      'Reply with your <b>email address</b>. We use it for your account and for payout receipts.\n' +
      '<i>Example: ravi@gmail.com</i>',
      { reply_markup: { force_reply: true, input_field_placeholder: 'ravi@gmail.com' } });
  }

  /** Step one of an application: the email. Then we ask for the mobile. */
  async function saveApplyEmail(msg, examLabel) {
  const exam = affiliates.listExams().find((e) => e.label === examLabel);
  if (!exam) {
    await reply(msg.chat.id, 'That exam is not open for promotion any more. Send /apply to see what is.');
    return;
  }
  const saved = await store.setPayoutField(msg.from, 'email', support.messageText(msg));
  if (!saved.ok) {
    await reply(msg.chat.id, `❌ ${esc(saved.reason)}`,
      { reply_markup: { inline_keyboard: [[{ text: '↩️ Try again', callback_data: `aff:exam:${exam.id}` }]] } });
    return;
  }
  await reply(msg.chat.id,
    `${PROMPT.applyPhone}${esc(exam.label)}\n\n` +
    'Reply with your <b>10-digit mobile number</b>. RazorpayX needs it to pay you.\n' +
    '<i>Example: 9876543210</i>',
    { reply_markup: { force_reply: true, input_field_placeholder: '9876543210' } });
  }

  /** Step two: the mobile — and with it, the application goes to the admin. */
  async function saveApplyPhone(msg, examLabel) {
  const exam = affiliates.listExams().find((e) => e.label === examLabel);
  if (!exam) {
    await reply(msg.chat.id, 'That exam is not open for promotion any more. Send /apply to see what is.');
    return;
  }
  const saved = await store.setPayoutField(msg.from, 'phone', support.messageText(msg));
  if (!saved.ok) {
    await reply(msg.chat.id, `❌ ${esc(saved.reason)}`,
      { reply_markup: { inline_keyboard: [[{ text: '↩️ Try again', callback_data: `aff:exam:${exam.id}` }]] } });
    return;
  }

  const influencer = saved.influencer;
  const result = await store.createRequest(msg.from, exam.id,
    `Email: ${influencer.email} · Mobile: ${influencer.phone}`);
  if (!result.ok) {
    await reply(msg.chat.id, `❌ ${esc(result.reason)}`);
    return;
  }
  const details = affiliates.payoutDetails(influencer);
  await reply(msg.chat.id,
    `✅ <b>Application sent for ${esc(exam.label)}.</b>\n\n` +
    `Reference: <code>${esc(result.request.request_id)}</code>\n` +
    `Email: <b>${esc(influencer.email)}</b> · Mobile: <b>${esc(influencer.phone)}</b>\n\n` +
    'An admin will review it and you will get a message here with your promo code and terms.' +
    (details.complete ? '' : '\n\n💳 While you wait, finish your payout details so we can pay you — tap below.'),
    details.complete ? {} : { reply_markup: PAYOUT_BUTTON });
  await notify.alertAdmins(notify.applicationAlert(result.request));
  }

  // ---- payout details --------------------------------------------------------
  // Everything RazorpayX needs to pay them, one detail per prompt, each shown
  // with a tick or a cross so it is obvious what is left and how to change it.

  const PAYOUT_BUTTON = { inline_keyboard: [[{ text: '💳 Payout details', callback_data: 'aff:payout' }]] };

  async function sendPayoutCard(chatId, user, heading = '') {
    if (!(await requireStore(chatId))) return;
    const i = (await store.getInfluencer(user.id)) || {};
    const status = affiliates.payoutDetails(i);
    const line = (label, value, required = true) =>
      `${value ? '✅' : required ? '❌' : '➖'} ${label}: ${value ? `<b>${esc(value)}</b>` : '<i>not set</i>'}`;
    const bank = i.account_number
      ? `${i.account_holder || ''}, ${affiliates.maskAccount(i.account_number)}, ${i.ifsc || ''}` : '';
    const lines = [
      heading,
      '<b>💳 Your payout details</b>',
      'We pay by RazorpayX, which needs all of these.',
      '',
      line('Name as on bank account', i.legal_name),
      line('Mobile', i.phone),
      line('Email', i.email),
      '',
      `Pay me by: <b>${status.method === 'bank' ? '🏦 Bank transfer' : '💳 UPI'}</b>`,
      line('UPI ID', i.upi_id, status.method === 'upi'),
      line('Bank account', bank, status.method === 'bank'),
      line('PAN (optional)', i.pan, false),
      '',
      status.complete
        ? '✅ <b>All set</b> — you can withdraw as soon as your cycle allows.'
        : `Still needed: <b>${esc(status.missingLabels.join(', '))}</b>. Tap below to add ${status.missing.length > 1 ? 'them' : 'it'}.`
    ].filter((l, idx) => idx !== 0 || l);
    const set = (text, field) => ({ text, callback_data: `aff:set:${field}` });
    await reply(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [set(i.legal_name ? '✏️ Change name' : '✏️ Add name', 'legal_name'), set(i.phone ? '📱 Change mobile' : '📱 Add mobile', 'phone')],
          [set(i.email ? '✉️ Change email' : '✉️ Add email', 'email'), set(i.pan ? '🪪 Change PAN' : '🪪 Add PAN', 'pan')],
          [set(i.upi_id ? '💳 Change UPI ID' : '💳 Add UPI ID', 'upi_id'), set(i.account_number ? '🏦 Change bank account' : '🏦 Add bank account', 'bank')],
          [
            { text: (status.method === 'upi' ? '● ' : '○ ') + 'Pay me by UPI', callback_data: 'aff:method:upi' },
            { text: (status.method === 'bank' ? '● ' : '○ ') + 'Pay me by bank', callback_data: 'aff:method:bank' }
          ]
        ]
      }
    });
  }

  async function askForField(chatId, user, field) {
    if (!(await requireStore(chatId))) return;
    const i = (await store.getInfluencer(user.id)) || {};
    if (field === 'bank') {
      await reply(chatId,
        `${PROMPT.bank}\n\n` +
        'Reply with three lines:\n1. account holder name\n2. account number\n3. IFSC\n\n' +
        '<i>Example:\nRavi Kumar\n123456789012\nHDFC0001234</i>' +
        (i.account_number ? `\n\nCurrent: ${esc(i.account_holder)}, ${esc(affiliates.maskAccount(i.account_number))}, ${esc(i.ifsc)}` : ''),
        { reply_markup: { force_reply: true, input_field_placeholder: 'Name / account number / IFSC' } });
      return;
    }
    const [promptKey, ask, example] = FIELD_PROMPTS[field] || [];
    if (!promptKey) return;
    await reply(chatId,
      `${PROMPT[promptKey]}\n\n${ask}\n<i>Example: ${esc(example)}</i>` +
      (i[field] ? `\n\nCurrent: <code>${esc(i[field])}</code>` : ''),
      { reply_markup: { force_reply: true, input_field_placeholder: example } });
  }

  async function saveField(msg, field) {
    const result = await store.setPayoutField(msg.from, field, support.messageText(msg));
    if (!result.ok) {
      await reply(msg.chat.id, `❌ ${esc(result.reason)}`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Try again', callback_data: `aff:set:${field}` }]] } });
      return;
    }
    await sendPayoutCard(msg.chat.id, msg.from, `✅ Saved: <b>${esc(affiliates.PAYOUT_FIELDS[field].label)}</b>\n`);
  }

  async function saveBank(msg) {
    const parts = support.messageText(msg).split(/\r?\n|,/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 3) {
      await reply(msg.chat.id, '❌ Please send three lines: the account holder name, the account number, and the IFSC.',
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Try again', callback_data: 'aff:set:bank' }]] } });
      return;
    }
    const [holder, number, ifsc] = [parts[0], parts[1], parts[2]];
    const result = await store.setBankAccount(msg.from, { holder, number, ifsc });
    if (!result.ok) {
      await reply(msg.chat.id, `❌ ${esc(result.reason)}`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Try again', callback_data: 'aff:set:bank' }]] } });
      return;
    }
    await sendPayoutCard(msg.chat.id, msg.from, '✅ Bank account saved — you will be paid by bank transfer.\n');
  }

  async function chooseMethod(chatId, user, method) {
    if (!(await requireStore(chatId))) return;
    const result = await store.setPayoutMethod(user, method);
    if (!result.ok) {
      await askForField(chatId, user, method === 'bank' ? 'bank' : 'upi_id');
      return;
    }
    await sendPayoutCard(chatId, user, `✅ You will be paid by <b>${method === 'bank' ? 'bank transfer' : 'UPI'}</b>.\n`);
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
    const details = affiliates.payoutDetails(influencer);
    if (!details.complete) blocks.push(`💳 <b>Payout details missing</b>: ${esc(details.missingLabels.join(', '))}.`);
    keyboard.push([{ text: '🔄 Refresh', callback_data: 'aff:codes' }, { text: '📝 Apply for another', callback_data: 'aff:apply' }]);
    keyboard.push([{ text: details.complete ? '💳 Payout details' : '💳 Add payout details', callback_data: 'aff:payout' }]);

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
    const details = affiliates.payoutDetails(influencer);
    keyboard.push([{ text: details.complete ? '💳 Change payout details' : '💳 Add payout details', callback_data: 'aff:payout' }]);
    const payTo = details.method === 'bank'
      ? `bank account ${esc(affiliates.maskAccount(influencer.account_number))} (${esc(influencer.ifsc)})`
      : `<code>${esc(influencer && influencer.upi_id)}</code>`;
    await reply(chatId,
      '<b>Withdraw</b>\n\n' + lines.join('\n') +
      (details.complete ? `\n\nWe pay to ${payTo}.` : ''),
      keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
  }

  async function withdraw(chatId, user, code) {
    if (!(await requireStore(chatId))) return;
    const result = await store.requestPayout(code, user.id);
    if (!result.ok) {
      await reply(chatId, `❌ ${esc(result.reason)}` +
        (result.nextAt ? ` You can withdraw again from ${esc(day(result.nextAt))}.` : ''),
        /payout details/.test(result.reason) ? { reply_markup: PAYOUT_BUTTON } : {});
      return;
    }
    await reply(chatId,
      `✅ <b>Withdrawal requested: ${pricing.rupees(result.payout.amount_paise)}</b>\n\n` +
      `Reference: <code>${esc(result.payout.payout_id)}</code>\n` +
      `We will send it to ${result.payout.payout_method === 'bank'
        ? `your bank account ${esc(affiliates.maskAccount(result.payout.account_number))}`
        : `<code>${esc(result.payout.upi_id)}</code>`} and message you here with the payment reference.`);
    await notify.alertAdmins(notify.withdrawalAlert(result.payout));
  }

  async function sendHelp(chatId) {
    await reply(chatId,
      '<b>How the influencer programme works</b>\n\n' +
      '1. /apply — choose an exam channel and give your email and mobile number.\n' +
      '2. The admin reviews it and sets your terms: the discount your followers get, what you earn per ' +
      'student, and whether you withdraw weekly or monthly.\n' +
      '3. You get a promo code and a link. Your code works only in that exam\'s payment bot.\n' +
      '4. Every student who pays with your code earns you the commission — you get a message each time.\n' +
      '5. /payout — your name, mobile, email and UPI ID or bank account, so we can pay you through RazorpayX.\n' +
      '6. /withdraw — when your cycle comes round and you are above the minimum. We send you the payment reference.\n\n' +
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
      '5. Withdrawals are paid through RazorpayX, by UPI or bank transfer, to the details you give in /payout, ' +
      'after the admin checks them. You get the payment reference when it is sent.\n' +
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
  command('payout', async (msg) => { await sendPayoutCard(msg.chat.id, msg.from); });
  command('upi', async (msg) => { await sendPayoutCard(msg.chat.id, msg.from); });
  command('bank', async (msg) => { await sendPayoutCard(msg.chat.id, msg.from); });
  command('help', async (msg) => { await sendHelp(msg.chat.id); });
  command('terms', async (msg) => { await sendTerms(msg.chat.id); });
  command('support', async (msg) => { await askQuestion(msg.chat.id); });
  command('settings', async (msg) => {
    await reply(msg.chat.id,
      '<b>Settings</b>\n\n/payout — how we pay you: UPI or bank, name, mobile, email\n/codes — your codes and their terms\n\n' +
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
      if (data === 'aff:payout' || data === 'aff:upi') { await ack(); await sendPayoutCard(chatId, user); return; }
      if (data.startsWith('aff:set:')) { await ack(); await askForField(chatId, user, data.slice(8)); return; }
      if (data.startsWith('aff:method:')) { await ack(); await chooseMethod(chatId, user, data.slice(11)); return; }
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
      if (prompt.startsWith(PROMPT.applyEmail)) {
        await saveApplyEmail(msg, prompt.split('\n')[0].slice(PROMPT.applyEmail.length).trim());
        return;
      }
      if (prompt.startsWith(PROMPT.applyPhone)) {
        await saveApplyPhone(msg, prompt.split('\n')[0].slice(PROMPT.applyPhone.length).trim());
        return;
      }
      if (prompt.startsWith(PROMPT.bank)) { await saveBank(msg); return; }
      const field = Object.keys(FIELD_PROMPTS).find((f) => prompt.startsWith(PROMPT[FIELD_PROMPTS[f][0]]));
      if (field) { await saveField(msg, field); return; }
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
