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
    const [stats, page, planInfo, pricing] = await Promise.all([
      api('/api/members/revenue'),
      api('/api/members', { query: filters }),
      api('/api/plans'),
      // The pass as students see it, including the price and date admins set.
      // A sheet that cannot answer yet must not take the member list down.
      api('/api/pricing').catch(() => null)
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
