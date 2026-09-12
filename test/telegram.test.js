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
