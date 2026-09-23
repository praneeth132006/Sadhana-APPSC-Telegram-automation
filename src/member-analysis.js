// ============================================================================
// src/member-analysis.js — the Members page's analysis
// ============================================================================
// Pure: every member row of one group in, the breakdowns the page draws out.
// Each breakdown is a list of { key, label, count, value? } slices that add up
// to a stated whole, so the page can draw a pie that means what it says — and
// so the arithmetic is tested here rather than eyeballed in a chart.
//
// Free previews (plan "trial") are not members: they are left out of every
// breakdown and counted on their own.
// ============================================================================

const { parseIst } = require('./membership');

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_LABELS = {
  active: 'Active — has access',
  cancelled: 'Cancelled — access until expiry',
  expired: 'Expired',
  removed: 'Removed from the group',
  pending: 'Payment pending'
};

/** "12-09-2026" or "12-09-2026, 10:00:00 AM IST" → Date, or null. */
function dateOf(text) {
  return text ? parseIst(String(text)) : null;
}

const rupees = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Slices sorted largest first, empty ones dropped, and each given its share. */
function slices(entries, whole) {
  const total = whole === undefined ? entries.reduce((s, e) => s + e.count, 0) : whole;
  return entries
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((e) => Object.assign({}, e, { percent: total ? Math.round((e.count / total) * 1000) / 10 : 0 }));
}

/**
 * analyseMembers — everything the Members page charts.
 *
 * @param {Object[]} subscribers Every row of the group's Subscribers tab
 * @param {Object} options
 * @param {Function} [options.priceFor] (subscriber) => full price in paise of the pass THEY bought,
 *   to tell full-price buyers from discounted ones; 0 when unknown
 * @param {Function} [options.isLifetime] (subscriber) => true for a pass that never ends
 * @param {Date} [options.now]
 */
function analyseMembers(subscribers, { priceFor = () => 0, isLifetime = () => false, now = new Date() } = {}) {
  const all = Array.isArray(subscribers) ? subscribers : [];
  const previews = all.filter((s) => s.plan === 'trial' || /^trial/.test(String(s.status || '')));
  const members = all.filter((s) => !previews.includes(s));

  // ---- Where everyone stands ------------------------------------------------
  const statusCounts = {};
  for (const m of members) {
    const status = STATUS_LABELS[m.status] ? m.status : 'other';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  const status = slices(Object.entries(statusCounts).map(([key, count]) => ({
    key, label: STATUS_LABELS[key] || 'Other', count
  })));

  // ---- Which pass, and what each brought in ---------------------------------
  const byPass = new Map();
  for (const m of members) {
    const key = m.plan || 'unknown';
    const entry = byPass.get(key) || { key, label: m.plan_label || m.plan || 'Unknown pass', count: 0, value: 0 };
    entry.count += 1;
    entry.value = rupees(entry.value + (Number(m.total_paid) || 0));
    byPass.set(key, entry);
  }
  const passes = slices([...byPass.values()]);
  const revenueByPass = slices([...byPass.values()].map((p) => Object.assign({}, p, { count: p.value })))
    .map((p) => Object.assign({}, p, { members: byPass.get(p.key).count }));

  // ---- What they paid: full price, a discount, or nothing -------------------
  const paid = members.filter((m) => m.status !== 'pending');
  const priceGroups = { full: 0, discounted: 0, free: 0 };
  let discountTotal = 0;
  for (const m of paid) {
    const amount = Number(m.amount) || 0;
    // Against the price of the pass this member bought, so a cheap pass
    // (a test pass, an old ₹10 sprint) is not mistaken for a discount.
    const fullPrice = (Number(priceFor(m)) || 0) / 100;
    if (amount <= 0) priceGroups.free += 1;
    else if (fullPrice && amount < fullPrice - 0.005) {
      priceGroups.discounted += 1;
      discountTotal += fullPrice - amount;
    } else priceGroups.full += 1;
  }
  const price = slices([
    { key: 'full', label: 'Full price', count: priceGroups.full },
    { key: 'discounted', label: 'With a coupon or promo code', count: priceGroups.discounted },
    { key: 'free', label: 'Given free by an admin', count: priceGroups.free }
  ]);

  // ---- When active members' access ends --------------------------------------
  const active = members.filter((m) => m.status === 'active');
  const outlook = { week: 0, month: 0, quarter: 0, later: 0, lifetime: 0, unknown: 0 };
  for (const m of active) {
    if (isLifetime(m)) { outlook.lifetime += 1; continue; }
    const end = dateOf(m.expiry_date);
    if (!end) { outlook.unknown += 1; continue; }
    const days = (end.getTime() - now.getTime()) / DAY_MS;
    if (days <= 7) outlook.week += 1;
    else if (days <= 30) outlook.month += 1;
    else if (days <= 90) outlook.quarter += 1;
    else outlook.later += 1;
  }
  const expiry = slices([
    { key: 'week', label: 'Ends within 7 days', count: outlook.week },
    { key: 'month', label: 'Ends in 8–30 days', count: outlook.month },
    { key: 'quarter', label: 'Ends in 1–3 months', count: outlook.quarter },
    { key: 'later', label: 'Ends in 3+ months', count: outlook.later },
    { key: 'lifetime', label: 'Lifetime — never ends', count: outlook.lifetime },
    { key: 'unknown', label: 'Expiry unreadable', count: outlook.unknown }
  ]);

  // ---- New and returning -------------------------------------------------------
  const loyalty = slices([
    { key: 'once', label: 'Paid once', count: paid.filter((m) => (Number(m.renewals) || 0) <= 1).length },
    { key: 'again', label: 'Paid more than once', count: paid.filter((m) => (Number(m.renewals) || 0) > 1).length }
  ]);

  // ---- New members per week, last 12 weeks ------------------------------------
  const weeks = [];
  const startOfToday = new Date(now.getTime());
  for (let i = 11; i >= 0; i--) {
    const end = new Date(startOfToday.getTime() - i * 7 * DAY_MS);
    const start = new Date(end.getTime() - 7 * DAY_MS);
    weeks.push({ start, end, count: 0, revenue: 0 });
  }
  for (const m of members) {
    const joined = dateOf(m.joined_at || m.start_date);
    if (!joined) continue;
    const week = weeks.find((w) => joined.getTime() > w.start.getTime() && joined.getTime() <= w.end.getTime());
    if (week) {
      week.count += 1;
      week.revenue = rupees(week.revenue + (Number(m.amount) || 0));
    }
  }
  const day = (d) => {
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return `${String(ist.getUTCDate()).padStart(2, '0')}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  const revenue = rupees(members.reduce((s, m) => s + (Number(m.total_paid) || 0), 0));
  return {
    totals: {
      members: members.length,
      active: active.length,
      paying: paid.filter((m) => (Number(m.total_paid) || 0) > 0).length,
      revenue,
      averagePaid: paid.length ? rupees(revenue / paid.length) : 0,
      discountGiven: rupees(discountTotal),
      previews: previews.length,
      joinedLast30Days: members.filter((m) => {
        const joined = dateOf(m.joined_at || m.start_date);
        return joined && now.getTime() - joined.getTime() <= 30 * DAY_MS && joined.getTime() <= now.getTime();
      }).length
    },
    status,
    passes,
    revenueByPass,
    price,
    expiry,
    loyalty,
    weekly: weeks.map((w) => ({ label: `${day(new Date(w.start.getTime() + DAY_MS))} – ${day(w.end)}`, count: w.count, revenue: w.revenue }))
  };
}

module.exports = { analyseMembers, STATUS_LABELS };
