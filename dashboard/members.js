// ============================================================================
// Members dashboard (dashboard/members.js)
// ============================================================================
// Paying members, revenue by plan, who lapses soon, and a dry-run of the
// nightly expiry sweep so an admin can see what it will do before it does it.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, panel, statCard, barRow,
  emptyState, pill, num, showToast, $
} from './shared.js';

/** Latest revenue payload. */
let revenue = null;

/** Current member filters. */
const filters = { status: '', plan: '', search: '', page: 1, pageSize: 50 };

// ---------------------------------------------------------------------------
// Pie charts
// ---------------------------------------------------------------------------
// Donuts drawn as inline SVG: a slice per part of a whole, a 2px gap between
// slices, the total in the middle, and a legend beside it that names every
// slice with its count and share — so nothing is read from colour alone, and
// the legend doubles as the table view.

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
  return node;
};

/** Fixed colours per meaning, so a slice keeps its colour whatever its size. */
const STATUS_COLOURS = { active: '#0ca30c', cancelled: '#fab219', removed: '#ec835a', expired: '#d03b3b', pending: '#8a8a86', other: '#8a8a86' };
// The dark-surface categorical palette, in its fixed order (validated on #0f0f12).
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const FIXED_COLOURS = {
  full: SERIES[0], discounted: SERIES[1], free: SERIES[5],
  week: '#d03b3b', month: '#fab219', quarter: SERIES[0], later: SERIES[2], lifetime: SERIES[5], unknown: '#8a8a86',
  once: SERIES[0], again: SERIES[2]
};

/** A colour for a slice: by meaning where it has one, else by its place in a fixed order. */
function colourFor(key, index, palette) {
  if (palette === 'status') return STATUS_COLOURS[key] || STATUS_COLOURS.other;
  return FIXED_COLOURS[key] || SERIES[index % SERIES.length];
}

/**
 * donut — one pie chart with its legend.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {string} opts.title
 * @param {string} opts.subtitle
 * @param {Array} opts.slices { key, label, count, percent }
 * @param {string} opts.centre Big number in the middle
 * @param {string} opts.centreLabel Caption under it
 * @param {Function} [opts.format] count -> text, for rupee charts
 * @param {string} [opts.palette] 'status' for member states
 */
function donut({ id, title, subtitle, slices, centre, centreLabel, format = num, palette = '' }) {
  const size = 180;
  const r = 80;
  const inner = 54;
  const c = size / 2;
  const chart = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'mb-donut-svg', role: 'img', 'aria-label': `${title}: ` +
    slices.map((sl) => `${sl.label} ${format(sl.count)} (${sl.percent}%)`).join(', ') });
  const total = slices.reduce((sum, sl) => sum + sl.count, 0);

  if (!total) {
    chart.append(svg('circle', { cx: c, cy: c, r: (r + inner) / 2, fill: 'none', stroke: 'rgba(255,255,255,0.08)', 'stroke-width': r - inner }));
  } else if (slices.length === 1) {
    const ring = svg('circle', { cx: c, cy: c, r: (r + inner) / 2, fill: 'none', stroke: colourFor(slices[0].key, 0, palette),
      'stroke-width': r - inner, class: 'mb-slice' });
    const tip = svg('title');
    tip.textContent = `${slices[0].label}: ${format(slices[0].count)} (100%)`;
    ring.append(tip);
    chart.append(ring);
  } else {
    let angle = -Math.PI / 2;
    slices.forEach((sl, i) => {
      const sweep = (sl.count / total) * Math.PI * 2;
      const end = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (rad, radius) => `${(c + radius * Math.cos(rad)).toFixed(2)} ${(c + radius * Math.sin(rad)).toFixed(2)}`;
      const d = `M ${p(angle, r)} A ${r} ${r} 0 ${large} 1 ${p(end, r)} L ${p(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${p(angle, inner)} Z`;
      // The card colour as a 2px outline is the gap between slices.
      const slice = svg('path', { d, fill: colourFor(sl.key, i, palette), stroke: '#0f0f12', 'stroke-width': 2, class: 'mb-slice' });
      const tip = svg('title');
      tip.textContent = `${sl.label}: ${format(sl.count)} (${sl.percent}%)`;
      slice.append(tip);
      chart.append(slice);
      angle = end;
    });
  }
  const big = svg('text', { x: c, y: c - 2, 'text-anchor': 'middle', class: 'mb-donut-total' });
  big.textContent = centre;
  const small = svg('text', { x: c, y: c + 18, 'text-anchor': 'middle', class: 'mb-donut-caption' });
  small.textContent = centreLabel;
  chart.append(big, small);

  const legend = el('ul', { class: 'mb-legend' }, slices.length
    ? slices.map((sl, i) => el('li', {}, [
      el('span', { class: 'mb-swatch', style: `background:${colourFor(sl.key, i, palette)}` }),
      el('span', { class: 'mb-legend-label', text: sl.label }),
      el('span', { class: 'mb-legend-value', text: `${format(sl.count)} · ${sl.percent}%` })
    ]))
    : [el('li', { class: 'muted', text: 'Nothing to show yet.' })]);

  return el('div', { class: 'mb-chart', id }, [
    el('h3', { class: 'mb-chart-title', text: title }),
    el('p', { class: 'mb-chart-sub', text: subtitle }),
    el('div', { class: 'mb-chart-body' }, [chart, legend])
  ]);
}

const rupeeText = (n) => '₹' + num(Math.round(Number(n) || 0));

/** One week's bar. A week with nobody new has no bar at all, not a stub that reads as "a few". */
function weekRow(week, max) {
  const width = week.count ? Math.max(3, Math.round((week.count / max) * 100)) : 0;
  return el('div', { class: 'bar-row', title: `${week.label}: ${week.count} new member(s)${week.revenue ? `, ${rupeeText(week.revenue)}` : ''}` }, [
    el('div', { class: 'bar-label', text: week.label }),
    el('div', { class: 'bar-track' }, [width ? el('div', { class: 'bar-fill tone-info', style: `width:${width}%` }) : null]),
    el('div', { class: 'bar-value', text: week.count ? `${num(week.count)}${week.revenue ? ` · ${rupeeText(week.revenue)}` : ''}` : '—' })
  ]);
}

/** The whole analysis panel: headline numbers, five pies, and new members per week. */
function analysisPanel(a) {
  const t = a.totals;
  if (!t.members) {
    return panel('📊 Member analysis', 'Pie charts of who your members are and what they bought',
      emptyState('📊', 'No members yet.', 'The charts fill in as soon as the first student pays.'));
  }
  const pct = (part) => (t.members ? `${Math.round((part / t.members) * 100)}%` : '0%');
  const weekMax = Math.max(...a.weekly.map((w) => w.count), 1);
  return panel('📊 Member analysis', 'Everyone who has ever bought a pass in this group, broken down. Hover a slice for its numbers.', [
    // Only what the tiles above do not already say.
    el('div', { class: 'stat-grid mb-headline' }, [
      statCard('Still active', pct(t.active), { tone: 'ok', sub: `${num(t.active)} of ${num(t.members)} members` }),
      statCard('Average paid', rupeeText(t.averagePaid), { tone: 'ok', sub: 'per member, all time' }),
      statCard('Joined in 30 days', num(t.joinedLast30Days), { tone: 'info', sub: 'new members this month' }),
      statCard('Discount given', rupeeText(t.discountGiven), { tone: 'warn', sub: 'through coupons and promo codes' })
    ]),
    el('div', { class: 'mb-charts' }, [
      donut({ id: 'chartStatus', title: 'Where members stand', subtitle: 'Active, expired, cancelled or removed',
        slices: a.status, centre: num(t.members), centreLabel: 'members', palette: 'status' }),
      donut({ id: 'chartPasses', title: 'Which pass they bought', subtitle: 'Members per pass',
        slices: a.passes, centre: num(t.members), centreLabel: 'members' }),
      donut({ id: 'chartRevenue', title: 'Where the money came from', subtitle: 'Revenue per pass, in rupees',
        slices: a.revenueByPass, centre: rupeeText(t.revenue), centreLabel: 'revenue', format: rupeeText }),
      donut({ id: 'chartPrice', title: 'What they paid', subtitle: 'Full price, discounted with a code, or free',
        slices: a.price, centre: num(a.price.reduce((s, x) => s + x.count, 0)), centreLabel: 'paid' }),
      donut({ id: 'chartExpiry', title: 'When access ends', subtitle: 'For members who are active now',
        slices: a.expiry, centre: num(t.active), centreLabel: 'active' }),
      donut({ id: 'chartLoyalty', title: 'New or returning', subtitle: 'How many times each member has paid',
        slices: a.loyalty, centre: num(a.loyalty.reduce((s, x) => s + x.count, 0)), centreLabel: 'members' })
    ]),
    el('div', { class: 'mb-weekly', id: 'chartWeekly' }, [
      el('h3', { class: 'mb-chart-title', text: 'New members per week' }),
      el('p', { class: 'mb-chart-sub', text: 'The last 12 weeks, oldest first' }),
      ...a.weekly.map((w) => weekRow(w, weekMax))
    ])
  ]);
}

/** Maps a member status to a pill tone. */
function statusTone(status) {
  return {
    active: 'ok', pending: 'warn', expired: 'danger',
    cancelled: 'warn', removed: 'muted'
  }[status] || 'muted';
}

/** Headline revenue and membership tiles. */
function renderStats(stats) {
  replaceChildren($('statGrid'),
    statCard('Active Members', num(stats.active), { tone: 'ok', sub: 'currently have group access' }),
    statCard('Total Revenue', '₹' + num(stats.totalRevenue), { tone: 'ok', sub: 'lifetime, all plans' }),
    statCard('Expiring in 7 Days', num(stats.expiringIn7Days), {
      tone: stats.expiringIn7Days > 0 ? 'warn' : 'ok', sub: 'renewal reminders due'
    }),
    statCard('Expired', num(stats.expired + stats.removed), { tone: 'muted', sub: 'lapsed or removed' }),
    statCard('Cancelled', num(stats.cancelled), { tone: 'warn', sub: 'auto-renew switched off' }),
    statCard('All Time Members', num(stats.totalMembers), { tone: 'info', sub: 'everyone who ever paid' })
  );
}

/** Revenue split across the three passes. */
function planBreakdown(stats) {
  const entries = Object.entries(stats.byPlan || {});
  if (!entries.length) {
    return emptyState('💳', 'No payments recorded yet.',
      'Members appear here as soon as the first payment webhook arrives.');
  }

  const max = Math.max(...entries.map(([, v]) => v.revenue), 1);
  return el('div', {}, entries
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([planId, data]) => barRow(
      `${data.label || planId} (${data.count})`,
      data.revenue, max, { tone: 'ok', suffix: '' }
    ))
  );
}

/** The member table. */
function membersTable(rows) {
  if (!rows.length) {
    return emptyState('👥', 'No members match these filters.');
  }

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {},
        ['Member', 'Plan', 'Status', 'Expires', 'Paid', 'Renewals', 'Last Payment']
          .map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((m) => el('tr', {}, [
        el('td', {}, [
          el('div', { text: m.name || m.username || m.telegram_id, style: 'font-weight:600' }),
          el('div', { class: 'muted', style: 'font-size:0.75rem;margin-top:2px',
            text: (m.username ? '@' + m.username + ' · ' : '') + m.telegram_id })
        ]),
        el('td', { text: m.plan_label || m.plan || '—' }),
        el('td', {}, [pill(m.status || 'unknown', statusTone(m.status))]),
        el('td', { class: 'muted', style: 'font-size:0.8rem', text: m.expiry_date || '—' }),
        el('td', { class: 'num', text: '₹' + num(m.total_paid) }),
        el('td', { class: 'num', text: num(m.renewals) }),
        el('td', { class: 'muted', style: 'font-size:0.78rem', text: m.last_payment_at || '—' })
      ])))
    ])
  ]);
}

/** The one pass on sale, or the configured catalogue if the sheet could not say. */
function passSummary(pricing, planInfo) {
  const pass = pricing && pricing.pass;
  const link = el('a', { href: `pricing.html${window.location.search}`, text: 'Change the pass or manage coupons →' });
  if (!pass) {
    return el('div', {}, [
      ...planInfo.plans.map((p) => el('div', { class: 'check-item' }, [
        el('span', { class: 'check-icon', text: p.emoji }),
        el('div', {}, [el('div', { class: 'check-title', text: `${p.label} — ${p.price}` })])
      ])),
      el('p', { class: 'hint-text' }, [link])
    ]);
  }
  const liveCoupons = (pricing.coupons || []).filter((c) => c.state === 'live').length;
  return el('div', {}, [
    el('div', { class: 'check-item' }, [
      el('span', { class: 'check-icon', text: '🎯' }),
      el('div', {}, [
        el('div', { class: 'check-title', text: `${pass.name} — ${pass.priceText}` }),
        el('div', { class: 'check-detail', text: pass.validUntil ? `Valid until ${pass.validUntil}` : 'No valid-until date set' })
      ])
    ]),
    el('div', { class: 'check-item' }, [
      el('span', { class: 'check-icon', text: '🎟' }),
      el('div', {}, [el('div', { class: 'check-title', text: `${liveCoupons} live coupon code${liveCoupons === 1 ? '' : 's'}` })])
    ]),
    el('p', { class: 'hint-text' }, [link])
  ]);
}

/** Recent payment activity from the immutable log. */
function recentPayments(stats) {
  const rows = stats.recentPayments || [];
  if (!rows.length) return emptyState('🧾', 'No payments logged yet.');

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {},
        ['When', 'Member', 'Plan', 'Amount', 'Event'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((p) => el('tr', {}, [
        el('td', { class: 'muted', style: 'font-size:0.8rem', text: p.timestamp }),
        el('td', { text: (p.username ? '@' + p.username : p.telegram_id) }),
        el('td', { text: p.plan || '—' }),
        el('td', { class: 'num', text: '₹' + num(p.amount) }),
        el('td', {}, [pill(p.event || 'payment', 'info')])
      ])))
    ])
  ]);
}

/** Filter controls above the member table. */
function filterBar(onApply) {
  const statusSelect = el('select', { class: 'field-select' }, [
    el('option', { value: '', text: 'Any status' }),
    ...['active', 'pending', 'expired', 'cancelled', 'removed']
      .map((s) => el('option', { value: s, text: s }))
  ]);
  const searchInput = el('input', {
    type: 'search', class: 'field-input',
    placeholder: 'Telegram id, @username or payment id'
  });

  const apply = () => {
    filters.status = statusSelect.value;
    filters.search = searchInput.value.trim();
    filters.page = 1;
    onApply();
  };

  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  statusSelect.addEventListener('change', apply);

  return el('div', { class: 'filter-bar' }, [
    el('div', { class: 'filter-item' }, [el('label', { text: 'Status' }), statusSelect]),
    el('div', { class: 'filter-item grow' }, [el('label', { text: 'Search' }), searchInput]),
    el('button', { class: 'btn btn-primary', text: 'Apply', onclick: apply })
  ]);
}

/** Renders the result of a dry-run expiry sweep. */
function sweepResult(summary) {
  const line = (icon, text, tone) => el('div', { class: 'log-line ' + tone, text: icon + ' ' + text });

  const body = [];
  body.push(line('🔎', `${summary.checked} member(s) at or near expiry`, 'muted'));

  if (!summary.reminded.length && !summary.removed.length) {
    body.push(line('✅', 'Nothing to do — no reminders due and nobody past expiry.', 'ok'));
  }
  summary.reminded.forEach((m) =>
    body.push(line('📨', `Would remind ${m.username ? '@' + m.username : m.telegram_id} — ${m.daysLeft} day(s) left`, 'ok')));
  summary.removed.forEach((m) =>
    body.push(line('✂️', `Would remove ${m.username ? '@' + m.username : m.telegram_id} — ${m.plan} expired`, 'fail')));
  summary.failed.forEach((f) =>
    body.push(line('⚠️', `${f.telegram_id}: ${f.reason}`, 'fail')));

  return el('div', { class: 'log-output' }, body);
}

/** Loads everything the page shows. */
async function load() {
  const panels = $('panels');
  replaceChildren(panels, el('div', { class: 'loading-row' }, [
    el('div', { class: 'spinner' }),
    el('span', { text: 'Loading members and revenue…' })
  ]));

  $('refreshBtn').disabled = true;

  try {
    const [stats, page, planInfo, pricing, analysis] = await Promise.all([
      api('/api/members/revenue'),
      api('/api/members', { query: filters }),
      api('/api/plans'),
      // The pass as students see it, including the price and date admins set.
      // A sheet that cannot answer yet must not take the member list down.
      api('/api/pricing').catch(() => null),
      // The charts are extra: if they fail, the rest of the page still loads.
      api('/api/members/analysis').catch(() => null)
    ]);

    revenue = stats;
    renderStats(stats);

    $('modeBadge').textContent = planInfo.configured
      ? (planInfo.testMode ? '⚠️ Razorpay TEST mode' : '🟢 Razorpay live')
      : '❌ Razorpay not configured';

    const membersPanel = el('section', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('div', {}, [
          el('h2', { class: 'panel-title', text: 'Members' }),
          el('p', { class: 'panel-subtitle', text: `${num(page.total)} member(s) match` })
        ])
      ]),
      filterBar(load),
      el('div', { class: 'panel-body tight' }, [membersTable(page.subscribers || [])])
    ]);

    replaceChildren(panels,
      // Only a complete analysis is drawn; anything else must not take the page down.
      analysis && analysis.totals ? analysisPanel(analysis) : null,
      el('div', { class: 'two-col' }, [
        panel('Revenue by Plan', 'Lifetime rupees and member count per pass', planBreakdown(stats)),
        panel('The Pass on Sale', 'What students buy from the bot right now',
          passSummary(pricing, planInfo))
      ]),
      membersPanel,
      panel('Recent Payments', 'Straight from the Payments log in the sheet', recentPayments(stats)),
      el('div', { id: 'sweepPanel' })
    );
  } catch (err) {
    replaceChildren(panels, emptyState('⚠️', 'Could not load members.', err.message));
    showToast('error', err.message, 9000);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

/** Runs the expiry sweep in dry-run mode and shows what it would do. */
async function previewSweep() {
  const button = $('dryRunBtn');
  button.disabled = true;
  button.textContent = 'Checking…';

  try {
    const summary = await api('/api/members/run-check', { method: 'POST', body: { dryRun: true } });
    replaceChildren($('sweepPanel'),
      panel('Expiry Sweep — Preview',
        'Exactly what tonight’s run would do. Nothing has been changed.',
        sweepResult(summary)));
    showToast('info', `${summary.reminded.length} reminder(s), ${summary.removed.length} removal(s) pending.`);
  } catch (err) {
    showToast('error', err.message, 9000);
  } finally {
    button.disabled = false;
    button.textContent = 'Preview expiry sweep';
  }
}

initDashboard({
  page: 'members',
  onReady: async () => {
    $('refreshBtn').addEventListener('click', load);
    $('dryRunBtn').addEventListener('click', previewSweep);
    await load();
  }
});
