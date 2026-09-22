// ============================================================================
// Support helpers (test/support.test.js)
// ============================================================================
// The bot keeps no conversation state between updates; every support step is
// recovered from the first line of the message being replied to. These tests
// pin those formats, the settings allowlist, and the cache that keeps a slow
// sheet from ever stopping the bot answering.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('../src/support');

test('a ticket id is dated in IST and matches the pattern everything parses', () => {
  // 20:00 UTC on the 17th is already the 18th in India.
  const id = support.newTicketId(new Date('2026-09-17T20:00:00Z'));
  assert.match(id, /^T-260918-[A-Z0-9]{4}$/);
  assert.notEqual(support.newTicketId(), support.newTicketId(), 'two ids in a row should differ');
});

test('a ticket header round-trips through the parser', () => {
  const header = support.ticketHeader('T-260917-AB2C', 123456789);
  assert.deepEqual(support.parseTicketHeader(`${header}\nNew ticket\n\nhello`), {
    ticketId: 'T-260917-AB2C', telegramId: '123456789'
  });
});

test('a ticket header is only recognised on the first line', () => {
  // A student cannot make their own text look like a ticket for someone else.
  const spoof = 'Please help\n🎫 T-260917-AB2C · user 42';
  assert.equal(support.parseTicketHeader(spoof), null);
  assert.equal(support.parseReplyLine('hi\n💬 Support reply · T-260917-AB2C'), null);
  assert.equal(support.parsePrompt('hi\n📨 Support request · Paid but no access'), null);
});

test('a support prompt names its category, and an unknown label falls back to other', () => {
  const payment = support.categoryById('payment');
  assert.equal(support.parsePrompt(support.promptLine(payment) + '\n\nDescribe the problem').id, 'payment');
  assert.equal(support.parsePrompt('📨 Support request · Not a real category').id, 'other');
  assert.equal(support.parsePrompt('some other message'), null);
  const withGroup = support.promptLine(payment, 'Newspaper · Telugu');
  assert.equal(support.parsePrompt(withGroup).id, 'payment');
  assert.equal(support.parsePromptGroup(withGroup + '\n\nDescribe'), 'Newspaper · Telugu');
  assert.equal(support.parsePromptGroup(support.promptLine(payment)), '');
});

test('replies to the confirmation and to an admin answer both find the ticket', () => {
  assert.equal(support.parseReplyLine(support.receivedLine('T-260917-AB2C') + '\n\nThanks'), 'T-260917-AB2C');
  assert.equal(support.parseReplyLine(support.replyLine('T-260917-ZZ99') + '\n\nAnswer'), 'T-260917-ZZ99');
});

test('normaliseSettings fills defaults and ignores unknown keys', () => {
  const settings = support.normaliseSettings({ support_hours: '24x7', junk: 'x', faq_payment: '   ' });
  assert.equal(settings.support_hours, '24x7');
  assert.equal(settings.junk, undefined);
  assert.equal(settings.faq_payment, support.categoryById('payment').answer, 'a blank answer should fall back');
  assert.equal(settings.support_enabled, 'yes');
  assert.equal(settings.welcome_note, '');
  assert.deepEqual(Object.keys(settings).sort(), [...support.SETTING_KEYS].sort());
});

test('the enabled toggle reads common spellings of no', () => {
  for (const off of ['no', 'NO', 'false', 'off', '0']) {
    assert.equal(support.ticketsEnabled({ support_enabled: off }), false, off);
  }
  assert.equal(support.ticketsEnabled({ support_enabled: 'yes' }), true);
  assert.equal(support.ticketsEnabled({}), true);
});

test('validateSettingsPatch refuses unknown keys, bad toggles and oversized values', () => {
  assert.equal(support.validateSettingsPatch({ nope: 'x' }).ok, false);
  assert.equal(support.validateSettingsPatch({ support_enabled: 'maybe' }).ok, false);
  assert.equal(support.validateSettingsPatch({ support_hours: 'x'.repeat(121) }).ok, false);
  assert.equal(support.validateSettingsPatch({}).ok, false);
  assert.equal(support.validateSettingsPatch(null).ok, false);
  assert.equal(support.validateSettingsPatch(['a']).ok, false);

  const good = support.validateSettingsPatch({ support_enabled: 'NO', support_hours: '  9-5  ' });
  assert.deepEqual(good, { ok: true, value: { support_enabled: 'no', support_hours: '9-5' } });
});

test('supportChatFor prefers the family chat and ignores non-numeric ids', () => {
  const saved = { ...process.env };
  try {
    delete process.env.SUPPORT_CHAT_UPSC;
    delete process.env.SUPPORT_THREAD_UPSC;
    process.env.SUPPORT_CHAT_ID = '-1001';
    process.env.SUPPORT_THREAD_ID = '7';
    assert.deepEqual(support.supportChatFor('TELEGRAM_PAYBOT_UPSC'), { chatId: '-1001', threadId: 7 });

    process.env.SUPPORT_CHAT_UPSC = '-1002';
    assert.deepEqual(support.supportChatFor('TELEGRAM_PAYBOT_UPSC'), { chatId: '-1002', threadId: null },
      'the shared chat\'s topic id must not be applied to a different chat');
    process.env.SUPPORT_THREAD_UPSC = '12';
    assert.deepEqual(support.supportChatFor('TELEGRAM_PAYBOT_UPSC'), { chatId: '-1002', threadId: 12 });
    process.env.SUPPORT_THREAD_UPSC = 'not-a-number';
    assert.deepEqual(support.supportChatFor('TELEGRAM_PAYBOT_UPSC'), { chatId: '-1002', threadId: null });

    process.env.SUPPORT_CHAT_UPSC = '@somechat';
    process.env.SUPPORT_CHAT_ID = '';
    assert.equal(support.supportChatFor('TELEGRAM_PAYBOT_UPSC'), null);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('parseCommand handles mentions and multi-line arguments', () => {
  assert.deepEqual(support.parseCommand('/set@MyBot faq_other line one\nline two'), {
    name: 'set', mention: 'MyBot', args: 'faq_other line one\nline two'
  });
  assert.deepEqual(support.parseCommand('/close'), { name: 'close', mention: '', args: '' });
  assert.equal(support.parseCommand('close'), null);
  assert.equal(support.parseCommand(undefined), null);
});

test('botIdFromToken reads the numeric prefix', () => {
  assert.equal(support.botIdFromToken('123456:ABC-def'), '123456');
  assert.equal(support.botIdFromToken(''), '');
});

test('messageText uses the caption for media and caps the length', () => {
  assert.equal(support.messageText({ caption: ' screenshot ' , photo: [{}] }), 'screenshot');
  assert.equal(support.messageText({ text: 'x'.repeat(5000) }).length, support.MAX_MESSAGE_CHARS);
  assert.equal(support.hasMedia({ photo: [{}] }), true);
  assert.equal(support.hasMedia({ text: 'hi' }), false);
});

test('the settings cache reads once per ttl, and a sheet that never answered gives defaults', async () => {
  let clock = 0;
  let loads = 0;
  let fail = true;
  const cache = support.createSettingsCache({
    load: async () => {
      loads++;
      if (fail) throw new Error('Unknown GET action: getBotSettings');
      return { support_hours: 'from sheet' };
    },
    ttlMs: 1000,
    failureTtlMs: 100,
    now: () => clock
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await cache.get()).support_hours, support.normaliseSettings({}).support_hours);
    assert.equal(cache.peek(), null, 'defaults are not passed off as what the sheet said');
    clock = 50;
    await cache.get();
    assert.equal(loads, 1, 'a failure should not be retried on every message');

    fail = false;
    clock = 200;
    assert.equal((await cache.get()).support_hours, 'from sheet');
    assert.equal((await cache.get()).support_hours, 'from sheet');
    assert.equal(loads, 2, 'second read inside the ttl should be cached');
  } finally {
    console.error = originalError;
  }
});

test('stale settings are served at once while a refresh runs behind them', async () => {
  let clock = 0;
  let loads = 0;
  let release;
  const background = [];
  const cache = support.createSettingsCache({
    load: async () => {
      loads++;
      if (loads === 1) return { support_hours: 'first' };
      await new Promise((r) => { release = r; });
      return { support_hours: 'second' };
    },
    ttlMs: 1000,
    staleMs: 10000,
    now: () => clock,
    background: (work) => background.push(work)
  });
  await cache.get();
  clock = 5000;   // expired, but not too old to show
  assert.equal((await cache.get()).support_hours, 'first', 'a stale read made the student wait');
  assert.equal(background.length, 1, 'the refresh was not handed over to be kept alive');
  release();
  await background[0];
  assert.equal((await cache.get()).support_hours, 'second');
});

test('a failed refresh keeps the last settings the sheet gave, never the defaults', async () => {
  // Defaults would quote the built-in price while an admin has set another.
  let clock = 0;
  let fail = false;
  const cache = support.createSettingsCache({
    load: async () => { if (fail) throw new Error('down'); return { pass_price: '149' }; },
    ttlMs: 1000,
    staleMs: 10000,
    now: () => clock
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await cache.get();
    fail = true;
    clock = 20000;   // too old to serve stale: this read waits, and fails
    assert.equal((await cache.get()).pass_price, '149');
  } finally {
    console.error = originalError;
  }
});

test('concurrent reads share one sheet call', async () => {
  let loads = 0;
  const cache = support.createSettingsCache({
    load: async () => { loads++; await new Promise((r) => setTimeout(r, 20)); return {}; }
  });
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(loads, 1);
});

test('the throttle allows a burst up to the limit, then refuses until the window passes', () => {
  let clock = 0;
  const allow = support.createThrottle({ limit: 2, windowMs: 1000, now: () => clock });
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), true);
  assert.equal(allow('a'), false);
  assert.equal(allow('b'), true, 'limits are per person');
  clock = 1001;
  assert.equal(allow('a'), true);
});

// ---------------------------------------------------------------------------
// Member referrals are gone
// ---------------------------------------------------------------------------

test('the old referral settings are no longer offered or accepted', () => {
  // Influencer promo codes replaced member referrals; their terms are set per
  // code on the Influencers page, not in a group's Bot Settings.
  const settings = support.normaliseSettings({});
  assert.ok(!Object.keys(settings).some((key) => key.startsWith('referral_')));
  assert.equal(support.validateSettingsPatch({ referral_enabled: 'no' }).ok, false);
});
