// Import the built-in Node.js test runner module
const test = require('node:test');
// Import Node.js strict assertion module for verifying expected outputs
const assert = require('node:assert/strict');
// Import the formatDateHashtag and formatNewspaperHashtag functions from the telegram service module
const { formatDateHashtag, formatNewspaperHashtag } = require('../src/telegram');

// Test suite for Telegram hashtag generation
test('formatDateHashtag converts dates to clickable #Date_DD_MM_YYYY hashtags', () => {
  // Verify DD-MM-YYYY format converts with #Date_ prefix
  assert.equal(formatDateHashtag('05-09-2026'), '#Date_05_09_2026');
  // Verify slash delimiter DD/MM/YYYY converts correctly
  assert.equal(formatDateHashtag('05/09/2026'), '#Date_05_09_2026');
  // Verify unpadded single-digit day/month pads with zeros
  assert.equal(formatDateHashtag('5-9-2026'), '#Date_05_09_2026');
  // Verify ISO format YYYY-MM-DD converts to #Date_DD_MM_YYYY
  assert.equal(formatDateHashtag('2026-09-05'), '#Date_05_09_2026');
  // Verify full JavaScript Date string parses into #Date_DD_MM_YYYY
  assert.equal(formatDateHashtag('Sat Sep 05 2026 00:00:00 GMT+0530'), '#Date_05_09_2026');
  // Verify falsy input returns empty string
  assert.equal(formatDateHashtag(''), '');
  assert.equal(formatDateHashtag(null), '');
  assert.equal(formatDateHashtag(undefined), '');
});

test('formatDateHashtag fallbacks ensure hashtag starts with letter so Telegram parses as clickable entity', () => {
  // When input is an unparseable numeric/symbol string, ensure Date_ prefix is prepended
  assert.equal(formatDateHashtag('123_test'), '#Date_123_test');
  // When input starts with letters and is not a date, preserve it as a clean hashtag
  assert.equal(formatDateHashtag('General_Tag'), '#General_Tag');
});

test('formatNewspaperHashtag formats into PascalCase hashtag', () => {
  // Test common newspaper names
  assert.equal(formatNewspaperHashtag('The Hindu'), '#TheHindu');
  assert.equal(formatNewspaperHashtag('Indian Express'), '#IndianExpress');
  assert.equal(formatNewspaperHashtag('Eenadu'), '#Eenadu');
  // Test empty string handling
  assert.equal(formatNewspaperHashtag(''), '');
});

test('formatNewspaperHashtag keeps non-Latin scripts and drops punctuation', () => {
  assert.equal(formatNewspaperHashtag('ఈనాడు'), '#ఈనాడు');
  assert.equal(formatNewspaperHashtag('the hindu'), '#TheHindu');
  assert.equal(formatNewspaperHashtag("Times of India."), '#TimesOfIndia');
});

test('formatDateHashtag reads an Excel date serial', () => {
  // 46275 is 10 Sep 2026 in Excel's day count.
  assert.equal(formatDateHashtag('46275'), '#Date_10_09_2026');
});

const { buildQuizPost } = require('../src/telegram');

const base = {
  question_text: 'Who is the head of the Lok Sabha?',
  option_a: 'Speaker', option_b: 'President', option_c: 'Prime Minister', option_d: 'Chief Justice',
  correct_answer: 'A', date: '10-09-2026', newspaper: 'The Hindu', topic: 'Fundamental Rights'
};

test('buildQuizPost keeps short options in the poll and tags the post', () => {
  const post = buildQuizPost(base);
  assert.equal(post.pollQuestion, base.question_text);
  assert.deepEqual(post.options, ['Speaker', 'President', 'Prime Minister', 'Chief Justice']);
  assert.equal(post.tagLine, '📅 #Date_10_09_2026  📰 #TheHindu  🏷️ #FundamentalRights');
  // The poll cannot render hashtags and there is no question message, so the
  // tags fall back to the answer message.
  assert.equal(post.leadMessage, null);
  assert.equal(post.answerTagLine, post.tagLine);
});

test('buildQuizPost moves every option into the question when one passes 100 characters', () => {
  const longOption = 'The Speaker need not be a member of the House at the time of election, but must be elected within six months';
  assert.ok(longOption.length > 100);
  const post = buildQuizPost({ ...base, option_b: longOption, option_c: 'x < y & z' });
  assert.deepEqual(post.options, ['A', 'B', 'C', 'D']);
  assert.equal(post.pollQuestion, 'Choose the correct option for the above question');
  assert.ok(post.leadMessage.includes(base.question_text));
  assert.ok(post.leadMessage.includes('A) Speaker\nB) ' + longOption + '\nC) x &lt; y &amp; z\nD) Chief Justice'));
  assert.ok(post.leadMessage.endsWith('\n\n' + post.tagLine));
  assert.equal(post.answerTagLine, '');
});

test('buildQuizPost sends only the question ahead when the question alone is too long', () => {
  const longQ = 'Consider the following statements. '.repeat(10) + '\nWhich of the above are correct?';
  const post = buildQuizPost({ ...base, question_text: longQ });
  assert.ok(post.leadMessage.includes('Consider the following'));
  assert.ok(post.leadMessage.endsWith('\n\n' + post.tagLine));
  assert.equal(post.answerTagLine, '');
  assert.equal(post.pollQuestion, '👆 Which of the above are correct? (Refer to statements above)');
  assert.deepEqual(post.options, ['Speaker', 'President', 'Prime Minister', 'Chief Justice']);
});

test('buildQuizPost omits the tag line when the sheet has no date or newspaper', () => {
  const untagged = buildQuizPost({ ...base, date: '', newspaper: '', topic: '' });
  assert.equal(untagged.tagLine, '');
  assert.equal(untagged.leadMessage, null);
  assert.equal(untagged.answerTagLine, '');
  assert.equal(buildQuizPost({ ...base, date: '', topic: '' }).tagLine, '📰 #TheHindu');
});

const { formatListLayout } = require('../src/telegram');

test('formatListLayout puts a flattened match-the-following list on separate lines', () => {
  const flat = 'Match the following historical inscriptions:\nList I (Inscription)\n' +
    '1. Mangallu Inscription 2. Bayyaram Tank Inscription 3. Draksharama Inscription ' +
    '4. Vilasa Copper Plate Grant List II (Associated Figure) A) Danarnava B) Mailamba ' +
    'C) Hemadri Reddy D) Musunuri Prolaya Nayaka';
  assert.equal(formatListLayout(flat), [
    'Match the following historical inscriptions:',
    'List I (Inscription)',
    '1. Mangallu Inscription',
    '2. Bayyaram Tank Inscription',
    '3. Draksharama Inscription',
    '4. Vilasa Copper Plate Grant',
    'List II (Associated Figure)',
    'A) Danarnava',
    'B) Mailamba',
    'C) Hemadri Reddy',
    'D) Musunuri Prolaya Nayaka'
  ].join('\n'));
});

test('formatListLayout splits statements and the closing prompt, but not stray numbers', () => {
  const flat = 'Consider the following statements: 1. Article 21. It protects life. ' +
    '2. It applies to citizens. Which of the statements given above is/are correct?';
  assert.equal(formatListLayout(flat),
    'Consider the following statements:\n1. Article 21. It protects life.\n' +
    '2. It applies to citizens.\nWhich of the statements given above is/are correct?');
  assert.equal(formatListLayout('Who was Dr. A. P. J. Abdul Kalam in 1998?'),
    'Who was Dr. A. P. J. Abdul Kalam in 1998?');
  assert.equal(formatListLayout('Assertion (A): X is true. Reason (R): Y causes X.'),
    'Assertion (A): X is true.\nReason (R): Y causes X.');
  assert.equal(formatListLayout('Already\n1. fine\n2. okay'), 'Already\n1. fine\n2. okay');
});

test('buildQuizPost posts list questions with their line breaks', () => {
  const post = buildQuizPost({ ...base, question_text: 'Consider: 1. Alpha 2. Beta' });
  assert.equal(post.pollQuestion, 'Consider:\n1. Alpha\n2. Beta');
});

test('buildQuizPost sends a question with more than two line breaks as a message, since polls flatten them', () => {
  // The exact text from the sheet that Telegram posted as one run-on line.
  const listQ = 'Match the following historical inscriptions:\nList I (Inscription)\n1. Mangallu Inscription\n' +
    '2. Bayyaram Tank Inscription\n3. Draksharama Inscription\n4. Vilasa Copper Plate Grant\n' +
    'List II (Associated Figure)\nA) Danarnava\nB) Mailamba\nC) Hemadri Reddy\nD) Musunuri Prolaya Nayaka';
  assert.ok(listQ.length < 290, 'short enough that length alone would have kept it in the poll');
  const post = buildQuizPost({ ...base, question_text: listQ, option_a: '1-A, 2-B, 3-C, 4-D' });
  assert.ok(post.leadMessage.includes('\n1. Mangallu Inscription\n2. Bayyaram Tank Inscription\n'));
  assert.ok(post.leadMessage.includes('\nC) Hemadri Reddy\nD) Musunuri Prolaya Nayaka'));
  assert.ok(!post.pollQuestion.includes('\n'));
  assert.equal(post.options[0], '1-A, 2-B, 3-C, 4-D');
  assert.equal(post.answerTagLine, '');

  const twoBreaks = buildQuizPost({ ...base, question_text: 'Consider:\n1. Alpha\n2. Beta' });
  assert.equal(twoBreaks.leadMessage, null);
});

test('a quiz explanation with < or & is escaped, so Telegram accepts the poll', async () => {
  // Telegram parses the explanation as HTML. A raw "<" or "&" — "rainfall < 50 cm",
  // "NDMA & SDMA" — made it refuse the whole poll with "can't parse entities".
  const TelegramBot = require('node-telegram-bot-api');
  const telegram = require('../src/telegram');
  const seen = {};
  const original = { sendPoll: TelegramBot.prototype.sendPoll, sendMessage: TelegramBot.prototype.sendMessage };
  TelegramBot.prototype.sendPoll = async function (chat, q, options, config) {
    seen.config = config;
    return { message_id: 7, poll: { id: 'p' } };
  };
  TelegramBot.prototype.sendMessage = async function () { return { message_id: 8 }; };
  try {
    telegram.init('123:test', '-1001');
    await telegram.sendQuizPoll(5, {
      question_text: 'విపత్తు నిర్వహణ చట్టం ఏ సంవత్సరంలో వచ్చింది?',
      option_a: '2005', option_b: '2004', option_c: '2010', option_d: '2001',
      correct_answer: 'A',
      explanation: 'NDMA & SDMA; rainfall < 50 cm'
    });
    assert.equal(seen.config.explanation, 'NDMA &amp; SDMA; rainfall &lt; 50 cm');
    assert.equal(seen.config.explanation_parse_mode, 'HTML');
  } finally {
    Object.assign(TelegramBot.prototype, original);
  }
});
