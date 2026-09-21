// ============================================================================
// src/sheet-tabs.js — which tabs in a group's workbook hold questions
// ============================================================================
// A group's spreadsheet holds one tab per subject, and also tabs that are not
// questions at all: Config, Subscribers, Support, Coupons, Referrals… The
// Apps Script decides which is which from a fixed list, and when the two
// referral tabs arrived that list did not know them — so Analytics showed
// "Referrals" and "Referral Log" as subjects, paused, with 0% complete.
//
// Fixing it only in the Apps Script would mean pasting it into five sheets
// again. So the server filters what the Apps Script sends back, from the list
// here, and a tab created tomorrow only needs adding in one place.
// ============================================================================

/**
 * Tabs that are configuration, membership, support or money — never questions.
 * Mirrors RESERVED_SHEETS in google_apps_script.js, plus everything the server
 * itself has added since.
 */
const NON_QUESTION_TABS = [
  'Config', 'Dashboard', 'README', 'Subscribers', 'Payments',
  'Support', 'Support Log', 'Bot Settings', 'Coupons', 'Coupon Redemptions',
  'Referrals', 'Referral Log', 'Referral Summary'
];

const reserved = new Set(NON_QUESTION_TABS.map((name) => name.trim().toLowerCase()));

/** True when a tab name is a subject's question bank. */
function isQuestionTab(name) {
  const clean = String(name || '').trim().toLowerCase();
  return Boolean(clean) && !reserved.has(clean);
}

/**
 * cleanAnalytics — the Analytics payload without the tabs that are not subjects.
 *
 * The per-subject rows are filtered, and the headline counts that were
 * computed from them are worked out again: two empty "subjects" that are
 * really referral tabs also inflated "subjects" and "empty subjects" at the
 * top of the page. Question totals are left alone — a non-question tab
 * contributes no questions, so they were already right.
 */
function cleanAnalytics(analytics) {
  if (!analytics || !Array.isArray(analytics.subjects)) return analytics;
  const subjects = analytics.subjects.filter((s) => isQuestionTab(s && s.subject));
  if (subjects.length === analytics.subjects.length) return analytics;

  const totals = Object.assign({}, analytics.totals, {
    subjects: subjects.length,
    activeSubjects: subjects.filter((s) => s.active).length,
    emptySubjects: subjects.filter((s) => Number(s.total) === 0).length,
    lowStockSubjects: subjects.filter((s) => Number(s.total) > 0 && Number(s.pending) < 10).length
  });
  return Object.assign({}, analytics, { subjects, totals });
}

/** The per-subject stats list, without the tabs that are not subjects. */
function cleanStats(stats) {
  return Array.isArray(stats) ? stats.filter((s) => isQuestionTab(s && s.subject)) : stats;
}

module.exports = { NON_QUESTION_TABS, isQuestionTab, cleanAnalytics, cleanStats };
