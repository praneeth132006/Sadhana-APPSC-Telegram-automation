// ============================================
// Telegram Service — Sends quiz polls to Telegram forum topics
// ============================================
// This module handles all Telegram Bot API interactions:
// - Initializing the bot with the token from .env
// - Creating forum topics for each subject in the supergroup
// - Sending quiz-type polls with correct answer + 💡 explanation
// - Testing the bot connection
//
// The bot must be an admin in the supergroup with "Manage topics" permission.
// Changes are visible in the Telegram supergroup as new topics and quiz polls.

const TelegramBot = require('node-telegram-bot-api'); // Telegram Bot API wrapper library

/**
 * POST_SPACING_MS — pause between questions in a posting batch.
 *
 * Telegram caps a bot at roughly 20 messages a minute into a single group, and
 * one question costs two or three messages (the long-question message, the
 * poll, the explanation). Pacing keeps a batch under that ceiling; a 429 that
 * still slips through is absorbed by sendWithFloodWait below.
 */
const POST_SPACING_MS = Number(process.env.POST_SPACING_MS) || 3000;

let bot = null;     // Module-level variable to hold the bot instance
let groupId = null;  // Module-level variable to store the supergroup chat ID

/**
 * init — Creates and configures the Telegram bot instance.
 * Uses polling: false because we only SEND messages, never receive commands.
 *
 * @param {string} token — Bot token from @BotFather
 * @param {string} chatGroupId — Supergroup chat ID (starts with -100...)
 */
function init(token, chatGroupId) {
  // Create the bot — polling disabled since we only send, never listen
  bot = new TelegramBot(token, { polling: false });
  // Store the group ID for use in all send functions
  groupId = chatGroupId;
  console.log('🤖 Telegram bot initialized');
}

/**
 * escapeHtml — Escapes special HTML characters (&, <, >) to avoid Telegram parse errors.
 *
 * @param {string} text — Raw unescaped string
 * @returns {string} Sanitized string safe for Telegram HTML parse_mode
 */
function escapeHtml(text) {
  // Replace HTML special characters with their corresponding entities
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * formatDateHashtag — Converts a date string into a Telegram-clickable hashtag.
 * What it does: Parses DD-MM-YYYY, YYYY-MM-DD, or full JS Date strings into #Date_DD_MM_YYYY (e.g. #Date_05_09_2026).
 * What it brings: Telegram requires hashtags to contain letters; prefixing with "Date_" ensures Telegram renders it as a blue clickable hashtag entity rather than plain text.
 * Where changes can be seen: Appended directly to the question prompt message in Telegram forum topics.
 *
 * @param {string|Date} dateStr — Date string or object from Google Sheets
 * @returns {string} Formatted hashtag like "#Date_05_09_2026", or empty string if invalid
 */
function formatDateHashtag(dateStr) {
  // Check if date argument is falsy or null
  if (!dateStr) return '';
  // Convert date input to string and strip surrounding whitespace
  const clean = String(dateStr).trim();
  // Return empty string if cleaned text has zero length
  if (!clean) return '';

  // Case 1: Match DD-MM-YYYY or DD/MM/YYYY format (e.g., "05-09-2026" or "5/9/2026")
  const ddmmyyyy = clean.match(/^(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{4})/);
  // If matched, format into canonical 2-digit day and month
  if (ddmmyyyy) {
    // Zero-pad day component to ensure 2 digits (e.g. "05")
    const day = ddmmyyyy[1].padStart(2, '0');
    // Zero-pad month component to ensure 2 digits (e.g. "09")
    const month = ddmmyyyy[2].padStart(2, '0');
    // Extract full 4-digit year component (e.g. "2026")
    const year = ddmmyyyy[3];
    // Return #Date_DD_MM_YYYY with "Date_" letter prefix for Telegram hashtag entity recognition
    return '#Date_' + day + '_' + month + '_' + year;
  }

  // Case 2: Match YYYY-MM-DD or YYYY/MM/DD ISO format (e.g., "2026-09-05")
  const yyyymmdd = clean.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
  // If matched, format into canonical 2-digit day and month
  if (yyyymmdd) {
    // Extract full 4-digit year component
    const year = yyyymmdd[1];
    // Zero-pad month component to ensure 2 digits
    const month = yyyymmdd[2].padStart(2, '0');
    // Zero-pad day component to ensure 2 digits
    const day = yyyymmdd[3].padStart(2, '0');
    // Return #Date_DD_MM_YYYY with "Date_" letter prefix for Telegram hashtag entity recognition
    return '#Date_' + day + '_' + month + '_' + year;
  }

  // Case 3: A bare Excel date serial (days since 1899-12-30), which is what a
  // date-formatted cell reads as from a local .xlsx. 20000–80000 is 1954–2119.
  if (/^\d{5}$/.test(clean) && Number(clean) >= 20000 && Number(clean) <= 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(clean) * 86400000);
    return '#Date_' + String(d.getUTCDate()).padStart(2, '0') + '_' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '_' + d.getUTCFullYear();
  }

  // Case 4: Parse full JavaScript Date string from Google Sheets (e.g., "Sat Sep 05 2026 00:00:00 GMT+0530")
  const parsed = new Date(clean);
  // Validate that the parsed timestamp is a real calendar date
  if (!isNaN(parsed.getTime())) {
    // Read the calendar parts in IST, not in whatever zone the server happens
    // to run in. getDate()/getMonth() are local: on Vercel (UTC) a sheet date
    // of "Sat Sep 05 2026 00:00:00 GMT+0530" is the instant 04 Sep 18:30 UTC,
    // so the tag came out a day early for every question posted from the cloud.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric'
    }).formatToParts(parsed);
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    // Return #Date_DD_MM_YYYY with "Date_" letter prefix for Telegram hashtag entity recognition
    return '#Date_' + get('day') + '_' + get('month') + '_' + get('year');
  }

  // Case 5: Fallback for non-standard formats — strip special symbols and ensure Telegram hashtag compatibility
  const fallback = clean.replace(/[^a-zA-Z0-9_]/g, '_');
  // Check if cleaned fallback text contains any valid characters
  if (!fallback) return '';
  // Check if string contains at least one letter and does not start with a digit
  const startsWithLetter = /^[a-zA-Z]/.test(fallback);
  // Prefix with Date_ if string begins with a number so Telegram parses it as a clickable entity
  const validTag = startsWithLetter ? fallback : 'Date_' + fallback;
  // Return hashtag with hash symbol prefix
  return '#' + validTag;
}

/**
 * formatNewspaperHashtag — Converts a newspaper name to a Telegram-clickable hashtag.
 * What it does: Removes spaces and special characters, joining words in PascalCase.
 * What it brings: Users can tap the hashtag in Telegram to find all questions from that newspaper.
 * Where changes can be seen: The tag line posted with each question (also used for the Topic tag).
 *
 * Examples: "The Hindu" → "#TheHindu", "Indian Express" → "#IndianExpress", "Eenadu" → "#Eenadu"
 *
 * @param {string} name — Newspaper name string
 * @returns {string} Formatted hashtag like "#TheHindu", or empty string if invalid
 */
function formatNewspaperHashtag(name) {
  // Return empty if no name provided
  if (!name || !name.trim()) return '';
  // Split into words, capitalize first letter of each, join without spaces
  const words = name.trim().split(/\s+/);
  const pascal = words.map(function(w) {
    // Capitalize first letter, keep rest as-is
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
  // Remove anything a hashtag cannot hold (periods, hyphens, apostrophes).
  // Letters, marks and digits of any script stay: Telegram renders #ఈనాడు as a
  // hashtag, and an ASCII-only filter turned every Telugu paper into nothing.
  const clean = pascal.replace(/[^\p{L}\p{M}\p{N}_]/gu, '');
  return clean ? '#' + clean : '';
}

/**
 * testConnection — Verifies the bot token is valid and the group is accessible.
 * Prints bot info and group info to the console.
 *
 * @returns {Promise<boolean>} true if connection is successful, false otherwise
 */
async function testConnection() {
  // Check if init() was called first
  if (!bot) {
    console.error('❌ Bot not initialized. Call init() first.');
    return false;
  }

  try {
    // Test 1: Verify bot token by calling getMe
    const botInfo = await bot.getMe();
    console.log(`✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);

    // Test 2: Verify group access by calling getChat
    const chat = await bot.getChat(groupId);
    console.log(`✅ Group found: "${chat.title}" (type: ${chat.type})`);
    console.log(`   Forum topics: ${chat.is_forum ? '✅ Enabled' : '❌ Disabled'}`);

    return true;
  } catch (error) {
    // Print the specific error for debugging
    console.error(`❌ Connection failed: ${error.message}`);
    return false;
  }
}

/**
 * getBotInfo — Returns structured bot and group details for the dashboard.
 * What it does: Calls getMe and getChat and returns the results as an object
 * instead of printing them, so the Health and Automation dashboards can show
 * the real values rather than a bare true/false.
 * What it brings: A machine-readable health probe alongside the CLI-oriented
 * testConnection().
 * Where changes can be seen: The Telegram tiles on /health.html and /automation.html.
 *
 * @returns {Promise<Object>} { username, firstName, groupTitle, groupType, isForum }
 * @throws {Error} When the bot is uninitialised or Telegram rejects the call
 */
async function getBotInfo() {
  if (!bot) throw new Error('Bot not initialized');

  // Verify the token is valid and identify the bot.
  const botInfo = await bot.getMe();

  // Group access is a separate permission, so a failure here is reported
  // without hiding the fact that the token itself is fine.
  let chat = null;
  try {
    chat = await bot.getChat(groupId);
  } catch (err) {
    chat = null;
  }

  return {
    username: botInfo.username,
    firstName: botInfo.first_name,
    groupTitle: chat ? chat.title : null,
    groupType: chat ? chat.type : null,
    isForum: chat ? Boolean(chat.is_forum) : false,
    groupReachable: Boolean(chat)
  };
}

/**
 * createForumTopic — Creates a new forum topic (thread) in the supergroup.
 * Each APPSC subject gets its own topic so questions are organized.
 *
 * @param {string} name — Topic name (e.g., "⚖️ Polity")
 * @returns {Promise<number>} The message_thread_id of the created topic
 */
async function createForumTopic(name) {
  if (!bot) throw new Error('Bot not initialized');

  // Call Telegram API to create a new forum topic in the supergroup
  // The bot must have "Manage topics" admin permission for this to work
  const topic = await bot.createForumTopic(groupId, name, {
    icon_color: 0x6FB9F0 // Light blue icon color
  });

  // Log the created topic details
  console.log(`📌 Created topic: "${name}" → Thread ID: ${topic.message_thread_id}`);

  // Return the thread ID — needed for sending messages to this topic
  return topic.message_thread_id;
}

/**
 * retryAfterSeconds — Reads Telegram's "wait this long" hint off a 429 error.
 *
 * node-telegram-bot-api surfaces the API payload on err.response.body, so a
 * flood-wait arrives as { error_code: 429, parameters: { retry_after: 12 } }.
 * Anything else returns 0, meaning "not a rate limit, do not retry".
 *
 * @param {Error} err — Error thrown by a bot.* call
 * @returns {number} Seconds to wait, or 0 when the error is not a 429
 */
function retryAfterSeconds(err) {
  const body = (err && err.response && err.response.body) || {};
  if (Number(body.error_code) !== 429) return 0;
  const params = body.parameters || {};
  // Telegram always sends retry_after with a 429; default to 3s if it did not.
  return Math.max(1, Number(params.retry_after) || 3);
}

/**
 * wasRejectedBeforeDelivery — did Telegram refuse this, or did the answer vanish?
 *
 * The distinction decides whether a question can safely be sent again. A 4xx
 * carrying a description is Telegram saying no before it did anything: a poll
 * question over 300 characters, a thread that no longer exists, a bot removed
 * from the group. Nothing was delivered, so the row can be handed back.
 *
 * A timeout, a socket error or a 5xx is NOT that. Telegram may well have
 * accepted the poll and only the reply went missing, which is exactly how two
 * questions ended up live in the channel while the sheet still called them
 * unposted — and re-sent on every run after. Those keep their claim.
 *
 * 429 is excluded deliberately: a flood-wait can arrive after the message was
 * accepted, so it is never proof of non-delivery.
 *
 * @param {Error} err Error thrown by a bot.* call
 * @returns {boolean} True only when Telegram definitely did not deliver
 */
function wasRejectedBeforeDelivery(err) {
  const body = (err && err.response && err.response.body) || {};
  const code = Number(body.error_code);
  if (!code) return false;
  if (code === 429) return false;
  return code >= 400 && code < 500;
}

/**
 * sendWithFloodWait — Runs a Telegram send, honouring 429 flood-wait replies.
 *
 * Groups are limited to roughly 20 messages a minute, and each question costs
 * two or three messages, so a batch of any size will hit that ceiling. Without
 * this the first 429 aborted the whole batch mid-way — which is what made a
 * 20-question run stop after 8.
 *
 * @param {Function} send — Zero-argument function performing the send
 * @param {number} [attempts] — How many flood-waits to sit through
 * @returns {Promise<Object>} Whatever the send resolved to
 */
async function sendWithFloodWait(send, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await send();
    } catch (err) {
      const wait = retryAfterSeconds(err);
      // Not a rate limit (bad HTML, question too long, bot kicked out): fail now.
      if (!wait || attempt === attempts) throw err;
      lastErr = err;
      console.warn(`⏳ Telegram rate limit — waiting ${wait}s before retrying`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
  throw lastErr;
}

/** Telegram's hard limits for a poll: question text and each option. */
const POLL_QUESTION_MAX = 300;
const POLL_OPTION_MAX = 100;

/**
 * buildQuizPost — decides how one question is laid out across its messages.
 *
 * Telegram refuses a poll whose question passes 300 characters or any option
 * passes 100. Statement-style APPSC questions hit both, so:
 *
 *   - every option fits    → options go in the poll, as they always have
 *   - any option too long  → question AND all four options go out as a normal
 *                            message, and the poll carries just A / B / C / D
 *   - only the question is too long → the question goes out as a message and
 *                            the poll keeps the real options
 *
 * The Date, Newspaper and Topic hashtags go with the question, never the
 * answer. Poll text never renders hashtags as tappable, so they are added to
 * the lead message when there is one. When the poll holds the whole question
 * there is no lead message, so they fall back to the answer message instead
 * (answerTagLine), outside the spoiler so they are tappable before revealing.
 *
 * Pure — no bot calls — so the layout can be tested without Telegram.
 *
 * @param {Object} question Question object from the sheet
 * @returns {{leadMessage: string|null, pollQuestion: string, options: string[], tagLine: string, answerTagLine: string}}
 */
function buildQuizPost(question) {
  const text = formatListLayout(question.question_text);
  const realOptions = ['option_a', 'option_b', 'option_c', 'option_d']
    .map((key) => String(question[key] || '').trim());
  const letters = ['A', 'B', 'C', 'D'];

  const optionsTooLong = realOptions.some((opt) => opt.length > POLL_OPTION_MAX);
  // Leave a little headroom under 300 for the pointer text added below.
  const questionTooLong = text.length > POLL_QUESTION_MAX - 10;

  const dateTag = formatDateHashtag(question.date);
  const newspaperTag = formatNewspaperHashtag(question.newspaper);
  // A topic tags the same way a paper name does: "Fundamental Rights" → #FundamentalRights.
  const topicTag = formatNewspaperHashtag(question.topic);
  const tagLine = [
    dateTag && '📅 ' + dateTag,
    newspaperTag && '📰 ' + newspaperTag,
    topicTag && '🏷️ ' + topicTag
  ].filter(Boolean).join('  ');
  const withTags = (message) => (tagLine ? `${message}\n\n${tagLine}` : message);

  if (optionsTooLong) {
    const optionLines = realOptions.map((opt, i) => `${letters[i]}) ${escapeHtml(opt)}`).join('\n');
    return {
      leadMessage: withTags(`📝 <b>Question:</b>\n\n${escapeHtml(text)}\n\n${optionLines}`),
      pollQuestion: 'Choose the correct option for the above question',
      options: letters.slice(),
      tagLine,
      answerTagLine: ''
    };
  }

  if (questionTooLong) {
    // Reuse the concluding prompt (e.g. "Which of the statements given above
    // are correct?") as the poll question when it is short enough to fit.
    const lines = text.split('\n');
    const lastLine = lines[lines.length - 1].trim();
    const pollQuestion = lastLine.endsWith('?') && lastLine.length < 250
      ? `👆 ${lastLine} (Refer to statements above)`
      : '👆 Choose the correct answer for the question above:';
    return {
      leadMessage: withTags(`📝 <b>Question:</b>\n\n${escapeHtml(text)}`),
      pollQuestion,
      options: realOptions,
      tagLine,
      answerTagLine: ''
    };
  }

  return { leadMessage: null, pollQuestion: text, options: realOptions, tagLine, answerTagLine: tagLine };
}

// Markers that start a new line. Each item pattern captures the item's label
// so runs can be checked for counting order (1, 2, 3 … / A, B, C …).
const LIST_ITEM_PATTERNS = [
  { re: /(?<!\S)(?:\((\d{1,2})\)|(\d{1,2})[.)])(?=\s)/g, index: (s) => Number(s) },
  { re: /(?<!\S)(?:\(([a-hA-H])\)|([a-hA-H])\))(?=\s)/g, index: (s) => s.toUpperCase().charCodeAt(0) - 64 },
  {
    re: /(?<!\S)(?:\((i|ii|iii|iv|v|vi|vii|viii)\)|(i|ii|iii|iv|v|vi|vii|viii)[.)])(?=\s)/g,
    index: (s) => ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii'].indexOf(s) + 1
  }
];
const LIST_HEADER_RE = /(?<!\S)(?:(?:List|Column)[\s-]*(?:IV|I{1,3}|[1-4])(?![\w-])|Statement[\s-]*(?:IV|I{1,3}|[1-4])\s*[:.–-]|Assertion\s*\(A\)|Reason\s*\(R\))/g;
const CLOSING_PROMPT_RE = /(?<!\S)(?:Select the correct|Choose the correct|Which of the (?:statements|above|following|given)|How many of the (?:above|statements|pairs)|Codes?\s*:)/gi;

/**
 * formatListLayout — puts list items back on their own lines.
 *
 * Sheet cells often hold a match-the-following or multi-statement question as
 * one flat line ("List I 1. Mangallu 2. Bayyaram … A) Danarnava B) …"), which
 * Telegram shows as a single wall of text. This breaks the line before:
 *   - numbered items 1. 2. 3. / (1) (2), lettered A) B) / (a) (b), roman (i) (ii)
 *   - headers such as List I, List II, Statement I:, Assertion (A), Reason (R)
 *   - a closing prompt ("Select the correct answer…") that follows a list
 *
 * Item labels only count when they form a run that starts at 1 / A / i and
 * counts up, so a stray "Article 21. It…" is left as written. Text that
 * already has its line breaks comes back unchanged.
 *
 * @param {string} raw Question or explanation text
 * @returns {string} The text with list items on separate lines, trimmed
 */
function formatListLayout(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const breaks = new Set();
  for (const { re, index } of LIST_ITEM_PATTERNS) {
    let run = [];
    let expected = 1;
    const flush = () => { if (run.length >= 2) run.forEach((pos) => breaks.add(pos)); run = []; };
    for (const m of text.matchAll(re)) {
      const n = index(m[1] || m[2]);
      if (n === 1) { flush(); run = [m.index]; expected = 2; }
      else if (run.length && n === expected) { run.push(m.index); expected++; }
    }
    flush();
  }

  const hasList = breaks.size > 0;
  for (const m of text.matchAll(LIST_HEADER_RE)) breaks.add(m.index);
  if (hasList) {
    const lastBreak = Math.max(...breaks);
    for (const m of text.matchAll(CLOSING_PROMPT_RE)) {
      if (m.index > lastBreak) breaks.add(m.index);
    }
  }

  let out = '';
  let from = 0;
  for (const pos of [...breaks].sort((a, b) => a - b)) {
    if (pos === 0) continue;
    out += text.slice(from, pos).replace(/[ \t]+$/, '');
    if (!out.endsWith('\n')) out += '\n';
    from = pos;
  }
  return (out + text.slice(from)).trim();
}

/**
 * sendQuizPoll — Sends a quiz-type poll to a specific forum topic.
 * The poll shows 4 options, marks the correct one, and shows
 * an explanation via the 💡 (lightbulb) icon after the user answers.
 * Layout for over-long questions and options is decided by buildQuizPost.
 *
 * @param {number} threadId — The message_thread_id of the target forum topic
 * @param {Object} question — Question object from the sheet
 * @param {string} question.question_text — The question text
 * @param {string} question.option_a — Option A text
 * @param {string} question.option_b — Option B text
 * @param {string} question.option_c — Option C text
 * @param {string} question.option_d — Option D text
 * @param {string} question.correct_answer — Correct answer letter (A/B/C/D)
 * @param {string} question.explanation — Explanation for the 💡 popup
 * @param {string} [question.date] — Date column, posted as #Date_DD_MM_YYYY
 * @param {string} [question.newspaper] — Newspaper column, posted as #PaperName
 * @param {string} [question.topic] — Topic column, posted as #TopicName
 * @returns {Promise<Object>} The sent message object from Telegram
 */
async function sendQuizPoll(threadId, question) {
  if (!bot) throw new Error('Bot not initialized');

  const post = buildQuizPost(question);

  // Map correct answer letter (A/B/C/D) to 0-based index
  const correctMap = { 'A': 0, 'B': 1, 'C': 2, 'D': 3 };
  const correctIndex = correctMap[String(question.correct_answer || '').toUpperCase()];

  // Truncate explanation to 200 chars (Telegram's hard limit for quiz explanations)
  let explanation = question.explanation || '';
  if (explanation.length > 200) {
    explanation = explanation.substring(0, 197) + '...'; // Truncate with ellipsis
  }

  // Build poll configuration
  const pollConfig = {
    type: 'quiz',                       // Quiz mode — shows correct/incorrect after answering
    correct_option_id: correctIndex,     // Which option is the correct answer (0-based index)
    is_anonymous: false,                 // Show who voted (not anonymous)
    message_thread_id: threadId          // Send to specific forum topic thread
  };

  // Only add explanation if there's actual text to show
  if (explanation) {
    pollConfig.explanation = explanation;           // Text shown when user taps 💡
    pollConfig.explanation_parse_mode = 'HTML';     // Allow basic HTML formatting
  }

  if (post.leadMessage) {
    await sendWithFloodWait(() => bot.sendMessage(groupId, post.leadMessage, {
      message_thread_id: threadId, // Direct message to the specific subject forum topic
      parse_mode: 'HTML'           // Format as HTML for clean readability
    }));
  }
  const pollQuestion = post.pollQuestion;
  const options = post.options;

  // Send the quiz poll to the Telegram group, targeting the specific topic
  const sent = await sendWithFloodWait(() => bot.sendPoll(groupId, pollQuestion, options, pollConfig));

  // Send the detailed Answer & Explanation message using Telegram's native <tg-spoiler> tag
  // This guarantees:
  // 1. The full, untruncated explanation is immediately available in the chat thread.
  // 2. The correct answer option is prominently displayed.
  // 3. The answer and explanation remain hidden behind a tap-to-reveal blur so users can attempt the poll first.
  if (question.explanation || question.correct_answer) {
    // Format the correct answer option letter (e.g. "D")
    const answerLetter = String(question.correct_answer || '').toUpperCase();
    // Sanitize the explanation text against HTML entity parsing issues
    const explanationText = escapeHtml(formatListLayout(question.explanation) || 'No detailed explanation provided.');

    // Construct the formatted spoiler message payload
    const spoilerMessage =
      `💡 <b>Answer &amp; Explanation</b> <i>(Tap below to reveal)</i>:\n` +
      `<tg-spoiler>✅ <b>Correct Answer: Option ${answerLetter}</b>\n\n` +
      `📖 <b>Explanation:</b>\n${explanationText}</tg-spoiler>` +
      // Only when the question had no message of its own to carry the tags.
      // Outside the spoiler so they are tappable before revealing.
      (post.answerTagLine ? `\n\n${post.answerTagLine}` : '');

    // Send the spoiler message to the specific forum topic thread
    // The poll itself is already out and the row is about to be marked posted,
    // so a failure here must not undo that — log it and move on.
    try {
      await sendWithFloodWait(() => bot.sendMessage(groupId, spoilerMessage, {
        message_thread_id: threadId,
        parse_mode: 'HTML'
      }));
    } catch (err) {
      console.warn(`⚠️  Poll sent but its explanation message failed: ${err.message}`);
    }
  }

  return sent; // Return the sent message object (contains message_id)
}

/**
 * pollStillExists — is this message still in the channel, or was it deleted?
 *
 * Telegram never tells a bot that a message was deleted, and there is no "get
 * message" call. Editing is the probe: asking to set the reply markup a poll
 * already has changes nothing visible, and the error distinguishes the cases.
 *
 *   "message is not modified"   → still there
 *   "message to edit not found" → deleted
 *
 * Anything else is treated as "still there", because guessing "deleted" would
 * put a question back in the queue and post it a second time. The whole point
 * of this is to avoid duplicates, not create them.
 *
 * @param {number|string} messageId The poll's message id
 * @returns {Promise<boolean|null>} true/false, or null when it cannot be told
 */
async function pollStillExists(messageId) {
  if (!bot) throw new Error('Bot not initialized');
  if (!messageId) return null;

  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: groupId, message_id: Number(messageId) }
    );
    // An edit that succeeds means the message is certainly there.
    return true;
  } catch (err) {
    const description = String(
      (err && err.response && err.response.body && err.response.body.description) || err.message || ''
    ).toLowerCase();

    if (description.includes('message is not modified')) return true;
    if (description.includes('message to edit not found')) return false;
    if (description.includes("message can't be edited")) return true;
    // Rate limits, network trouble, an unexpected refusal: not proof of
    // anything, and treated as such.
    return null;
  }
}

/**
 * createSingleUseInviteLink — mints a private invite only one person can use.
 * What it does: Calls createChatInviteLink with member_limit 1 and an expiry.
 * What it brings: A paid seat cannot be shared — the link dies on first use, so
 * forwarding it gives away your own place rather than creating a free one.
 * Where changes can be seen: The link DMed to a student after they pay.
 *
 * @param {string|number} chatId — Group to invite into
 * @param {string} name — Label shown in the group's invite-link list
 * @param {number} [expireUnix] — Unix time the unused link stops working
 * @returns {Promise<Object>} The invite link object, with `invite_link`
 */
async function createSingleUseInviteLink(chatId, name, expireUnix) {
  if (!bot) throw new Error('Bot not initialized');

  const options = { member_limit: 1 };
  if (name) options.name = String(name).slice(0, 32);
  if (expireUnix) options.expire_date = expireUnix;

  return bot.createChatInviteLink(chatId, options);
}

/**
 * sendDirectMessage — sends a private message to one user.
 * What it does: Posts to the user's own chat with the bot.
 * What it brings: Invite links, renewal reminders and expiry notices reach the
 * student privately instead of being posted in the group.
 * Where changes can be seen: The student's DM thread with the bot.
 *
 * Note: Telegram forbids a bot from opening a conversation, so this only works
 * after the student has messaged the bot at least once.
 *
 * @param {string|number} userId — Telegram user id
 * @param {string} text — HTML-formatted message
 * @param {Object} [extra] — Extra sendMessage options, e.g. reply_markup
 * @returns {Promise<Object>} The sent message
 */
async function sendDirectMessage(userId, text, extra) {
  if (!bot) throw new Error('Bot not initialized');

  return bot.sendMessage(userId, text, Object.assign({
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, extra || {}));
}

/**
 * banChatMember — removes a user from a group.
 * Paired with unbanChatMember to kick without a permanent ban.
 *
 * @param {string|number} chatId — Group id
 * @param {string|number} userId — User to remove
 */
async function banChatMember(chatId, userId) {
  if (!bot) throw new Error('Bot not initialized');
  return bot.banChatMember(chatId, userId);
}

/**
 * unbanChatMember — lifts a ban so the user can rejoin later.
 * What it brings: A lapsed subscriber who pays again can come straight back;
 * without this, removal would be permanent.
 *
 * @param {string|number} chatId — Group id
 * @param {string|number} userId — User to unban
 */
async function unbanChatMember(chatId, userId) {
  if (!bot) throw new Error('Bot not initialized');
  return bot.unbanChatMember(chatId, userId, { only_if_banned: true });
}

/**
 * getChatMemberStatus — whether a user is currently in the group.
 *
 * @param {string|number} chatId — Group id
 * @param {string|number} userId — User to check
 * @returns {Promise<string>} 'member', 'administrator', 'left', 'kicked', or 'unknown'
 */
async function getChatMemberStatus(chatId, userId) {
  if (!bot) throw new Error('Bot not initialized');
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member && member.status ? member.status : 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

/**
 * setGroupId — Updates the internal supergroup chat ID in the telegram module.
 * What it does: Replaces the module-level groupId variable with a newly discovered or user-provided ID.
 * What it brings: Allows dynamic runtime configuration of the group ID without restarting the process.
 * Where changes can be seen: In subsequent API calls made by createForumTopic or sendQuizPoll.
 *
 * @param {string|number} newGroupId — The Telegram chat ID (starting with -100)
 */
function setGroupId(newGroupId) {
  // Update the module-level groupId variable
  groupId = String(newGroupId);
}

/**
 * extractGroupIdFromLink — Extracts the standard Telegram chat ID from a web URL or raw ID string.
 * What it does: Parses formats like https://t.me/c/3814998988/3 into the canonical -1003814998988 format.
 * What it brings: Convenience for users who copy/paste browser or app topic links instead of raw chat IDs.
 * Where changes can be seen: Used by setup.js and CLI tools to parse input arguments.
 *
 * @param {string} input — Link or raw string provided by the user
 * @returns {string|null} Canonical chat ID formatted as -100..., or null if unrecognized
 */
function extractGroupIdFromLink(input) {
  // Trim leading and trailing whitespace from the user input string
  const cleanInput = String(input || '').trim();
  // Match standard private supergroup URL format: https://t.me/c/<numeric_id>/...
  const linkMatch = cleanInput.match(/t\.me\/c\/(\d+)/);
  // If matched, prefix with -100 to convert internal telegram channel ID to supergroup chat ID
  if (linkMatch && linkMatch[1]) {
    return `-100${linkMatch[1]}`;
  }
  // If the user already provided a raw ID beginning with -100
  if (cleanInput.startsWith('-100')) {
    return cleanInput;
  }
  // Return null if the string pattern does not match expected Telegram formats
  return null;
}

/**
 * detectGroupId — Scans Telegram Bot API updates to discover supergroup IDs automatically.
 * What it does: Retrieves recent updates from bot.getUpdates() and inspects chat payloads.
 * What it brings: Zero-configuration group discovery when the bot is added to a group or receives /start.
 * Where changes can be seen: Terminal logs during setup.js execution.
 *
 * @returns {Promise<{id: string, title: string}|null>} Discovered chat info or null
 */
async function detectGroupId() {
  // Verify bot instance is initialized before attempting API call
  if (!bot) throw new Error('Bot not initialized. Call init() first.');

  try {
    // Query Telegram Bot API getUpdates endpoint requesting message and membership change events
    const updates = await bot.getUpdates({
      limit: 50,
      allowed_updates: ['message', 'my_chat_member', 'chat_member', 'channel_post']
    });

    // Loop through retrieved updates in reverse to check the most recent events first
    for (let i = updates.length - 1; i >= 0; i--) {
      const u = updates[i];
      // Check message chat object
      const chat = (u.message && u.message.chat) ||
                   (u.my_chat_member && u.my_chat_member.chat) ||
                   (u.channel_post && u.channel_post.chat);

      // Verify that the chat object exists, is a supergroup or group, and has a negative ID
      if (chat && chat.id && (chat.type === 'supergroup' || chat.type === 'group')) {
        // Return the discovered chat ID and group title
        return {
          id: String(chat.id),
          title: chat.title || 'Untitled Group'
        };
      }
    }

    // Return null if no supergroup activity was discovered in the update buffer
    return null;
  } catch (error) {
    // Log warning if update fetch encountered an error
    console.warn(`⚠️ Could not query getUpdates: ${error.message}`);
    return null;
  }
}

// Export all functions for use by send.js, setup.js, and scheduler.js
module.exports = {
  getBotInfo,
  createSingleUseInviteLink,
  sendDirectMessage,
  banChatMember,
  unbanChatMember,
  getChatMemberStatus,
  init,
  testConnection,
  createForumTopic,
  sendQuizPoll,
  buildQuizPost,
  formatListLayout,
  setGroupId,
  extractGroupIdFromLink,
  detectGroupId,
  formatDateHashtag,
  formatNewspaperHashtag,
  wasRejectedBeforeDelivery,
  pollStillExists,
  POST_SPACING_MS
};
