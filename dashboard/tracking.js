// ============================================================================
// Code Tracking dashboard (dashboard/tracking.js)
// ============================================================================
// One coupon or promo code at a time (or all of them): how many clicked its
// link, applied it, made a payment link and paid, and a row per student saying
// exactly how far they got — so an ad's code can be judged, and the people who
// made a payment link but never paid can be found.
//
// Data: GET /api/pricing/tracking?code=… and, to ask Razorpay about links that
// were never paid, POST /api/pricing/tracking/refresh.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, panel, statCard, emptyState, pill, num, barRow, showToast, getSelectedGroup, $
} from './shared.js';

/** Latest /api/pricing/tracking payload. */
let data = null;
/** The code being looked at; '' for every code. */
let selectedCode = '';
/** Which people are listed. */
let view = 'all';
/** Free-text filter on name, username or id. */
let search = '';

const STAGE_TONE = {
  paid: 'ok',
  paid_unrecorded: 'danger',
  link_pending: 'warn',
  link_expired: 'danger',
  applied: 'info',
  refused: 'muted',
  clicked: 'muted'
};

/** The list tabs: which stages each shows. */
const VIEWS = [
  { id: 'all', label: 'Everyone', stages: null },
  { id: 'unpaid', label: 'Made a link, did not pay', stages: ['link_pending', 'link_expired', 'paid_unrecorded'] },
  { id: 'paid', label: 'Paid', stages: ['paid'] },
  { id: 'applied', label: 'Applied, no link', stages: ['applied'] },
  { id: 'clicked', label: 'Clicked only', stages: ['clicked'] },
  { id: 'refused', label: 'Code refused', stages: ['refused'] }
];

const rupees = (n) => {
  const v = Number(n) || 0;
  return '₹' + (Number.isInteger(v) ? v : v.toFixed(2));
};

async function busy(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function field(label, input, hint) {
  return el('div', { class: 'support-field' }, [
    el('label', { for: input.id, text: label }),
    input,
    hint ? el('div', { class: 'hint-text', text: hint }) : null
  ]);
}

/** The rows the current tab and search box let through. */
function visibleRows() {
  const rows = (data && data.rows) || [];
  const tab = VIEWS.find((v) => v.id === view) || VIEWS[0];
  const needle = search.trim().toLowerCase().replace(/^@/, '');
  return rows.filter((r) => {
    if (tab.stages && !tab.stages.includes(r.stage)) return false;
    if (!needle) return true;
    return [r.name, r.username, r.student_id, r.code].some((v) => String(v || '').toLowerCase().includes(needle));
  });
}

function countFor(viewId) {
  const rows = (data && data.rows) || [];
  const tab = VIEWS.find((v) => v.id === viewId);
  return tab.stages ? rows.filter((r) => tab.stages.includes(r.stage)).length : rows.length;
}

// ---------------------------------------------------------------------------
// Controls: which code, its ad link
// ---------------------------------------------------------------------------

function renderControls() {
  const codes = data.codes || [];
  const select = el('select', { id: 'codeSelect', class: 'field-select' }, [
    el('option', { value: '', text: `All codes (${num(codes.length)})` }),
    ...codes.map((c) => el('option', {
      value: c.code,
      text: `${c.code}${c.kind ? ` · ${c.kind}` : ''} — ${num(c.people)} ${c.people === 1 ? 'person' : 'people'}`
    }))
  ]);
  select.value = selectedCode;
  select.addEventListener('change', () => {
    selectedCode = select.value;
    load();
  });

  const find = el('input', { id: 'searchInput', type: 'search', class: 'field-input', placeholder: 'Name, @username or Telegram ID' });
  find.value = search;
  find.addEventListener('input', () => {
    search = find.value;
    renderPeople();
  });

  let linkBox = null;
  if (selectedCode && data.linkBase) {
    const link = data.linkBase + selectedCode;
    const copy = el('button', { id: 'copyLinkBtn', class: 'btn btn-ghost btn-sm', text: 'Copy link' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        showToast('success', 'Link copied. Put it in your ad so every click is counted.');
      } catch (err) {
        showToast('warn', 'Could not copy. Select the link and copy it by hand.');
      }
    });
    linkBox = el('div', { class: 'tr-link' }, [
      el('span', { class: 'hint-text', text: 'Ad link for this code:' }),
      el('code', { id: 'adLink', text: link }),
      copy
    ]);
  } else if (selectedCode) {
    linkBox = el('p', { class: 'hint-text', text: 'The bot\'s username could not be read, so the ad link cannot be shown right now.' });
  }

  replaceChildren($('controlPanel'), panel(
    '🔎 Which code',
    'Clicks are counted only when people open the bot through the code\'s link. Someone who types the code ' +
      'still appears here from the moment they apply it.',
    [
      el('div', { class: 'tr-toolbar' }, [
        field('Code', select),
        field('Find a person', find)
      ]),
      linkBox
    ]
  ));
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

function renderSummary() {
  const t = data.totals;
  const title = selectedCode ? `📈 ${selectedCode}` : '📈 All codes';
  const funnelMax = Math.max(t.people, 1);

  const cards = el('div', { class: 'stat-grid' }, [
    statCard('People', num(t.people), { tone: 'info', sub: 'used the code in any way' }),
    statCard('Clicked the link', num(t.clicked), { tone: 'info', sub: `${num(t.clicks)} click(s) in all` }),
    statCard('Applied the code', num(t.applied), { tone: 'info', sub: `${num(t.fromLink)} from the link · ${num(t.typed)} typed` }),
    statCard('Made a payment link', num(t.linkCreated), { tone: 'warn', sub: `${num(t.links)} link(s) in all` }),
    statCard('Paid', num(t.paid), { tone: 'ok', sub: `${rupees(t.revenue)} · ${t.conversion}% of people` }),
    statCard('Made a link, did not pay', num(t.notPaid), {
      tone: t.notPaid ? 'danger' : 'ok',
      sub: `${num(t.pending)} link(s) still open · ${num(t.expired)} expired`
    })
  ]);

  const funnel = el('div', { class: 'tr-funnel' }, [
    barRow('Clicked the link', t.clicked, funnelMax, { tone: 'info' }),
    barRow('Applied the code', t.applied, funnelMax, { tone: 'info' }),
    barRow('Made a payment link', t.linkCreated, funnelMax, { tone: 'warn' }),
    barRow('Paid', t.paid, funnelMax, { tone: 'ok' })
  ]);

  const warning = t.unrecorded
    ? el('div', { class: 'banner tone-danger', style: 'margin-top:12px' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: `${num(t.unrecorded)} paid on Razorpay but were never recorded. ` }),
        el('span', { text: 'Their payment went through but no webhook reached the server, so they may not have been let in. ' +
          'Check them on the Members page, or send them an invite from Support.' })
      ])
    ])
    : null;

  const body = [cards, funnel, warning];

  // With every code on show, a table of codes: the quickest way to compare ads.
  if (!selectedCode && (data.codes || []).length) {
    body.push(el('div', { class: 'table-wrap', style: 'margin-top:16px' }, [
      el('table', { class: 'data-table', id: 'codeTable' }, [
        el('thead', {}, [el('tr', {}, ['Code', 'People', 'Clicked', 'Applied', 'Made a link', 'Paid', 'Did not pay', 'Revenue', 'Conversion']
          .map((h) => el('th', { text: h })))]),
        el('tbody', {}, data.codes.map((c) => {
          const row = el('tr', { class: 'tr-code-row', title: `Show ${c.code}` }, [
            el('td', {}, [el('div', { class: 'pc-code', text: c.code }), c.kind ? el('div', { class: 'tr-sub', text: c.kind }) : null]),
            el('td', { class: 'num', text: num(c.people) }),
            el('td', { class: 'num', text: num(c.clicked) }),
            el('td', { class: 'num', text: num(c.applied) }),
            el('td', { class: 'num', text: num(c.linkCreated) }),
            el('td', { class: 'num', text: num(c.paid) }),
            el('td', { class: 'num', text: num(c.notPaid) }),
            el('td', { class: 'num', text: rupees(c.revenue) }),
            el('td', { class: 'num', text: `${c.conversion}%` })
          ]);
          row.addEventListener('click', () => {
            selectedCode = c.code;
            load();
          });
          return row;
        }))
      ])
    ]));
  }

  replaceChildren($('summaryPanel'), panel(title, 'Each person is counted once per step they reached.', body));
}

// ---------------------------------------------------------------------------
// The people
// ---------------------------------------------------------------------------

function studentCell(r) {
  return el('td', {}, [
    el('div', { text: r.name || (r.username ? '@' + r.username : r.student_id) }),
    r.username
      ? el('div', { class: 'tr-sub' }, [el('a', { href: `https://t.me/${r.username}`, target: '_blank', rel: 'noopener', text: '@' + r.username })])
      : null,
    el('div', { class: 'tr-id', text: r.student_id })
  ]);
}

function when(text) {
  return text ? el('div', { class: 'tr-when', text: String(text).replace(/ IST$/, '') }) : el('span', { class: 'muted', text: '—' });
}

function linkCell(r) {
  if (!r.link_created_at) return el('td', {}, [el('span', { class: 'muted', text: '—' })]);
  const count = Number(r.links_created) || 1;
  return el('td', {}, [
    el('div', { text: `${rupees(r.amount)}${count > 1 ? ` · ${count} links` : ''}` }),
    when(r.link_created_at),
    r.failed_attempts ? el('div', { class: 'tr-sub', text: `${r.failed_attempts} failed payment attempt(s)` }) : null
  ]);
}

function paidCell(r) {
  if (!r.paid_at) return el('td', {}, [el('span', { class: 'muted', text: '—' })]);
  return el('td', {}, [
    el('div', { class: 'inf-money', text: rupees(r.paid_amount) }),
    when(r.paid_at),
    r.payment_id ? el('div', { class: 'tr-id', text: r.payment_id }) : null
  ]);
}

function personRow(r) {
  return el('tr', { class: 'tr-person' }, [
    studentCell(r),
    el('td', {}, [el('div', { class: 'pc-code', text: r.code }), r.group ? el('div', { class: 'tr-sub', text: r.group }) : null]),
    el('td', { text: r.source === 'link' ? '🔗 Link' : r.source === 'typed' ? '⌨️ Typed' : '—' }),
    el('td', {}, [
      pill(r.stage_label || r.stage, STAGE_TONE[r.stage] || 'muted'),
      r.stage === 'refused' && r.refused_reason ? el('div', { class: 'tr-reason', text: r.refused_reason }) : null
    ]),
    el('td', {}, [when(r.clicked_at), Number(r.clicks) > 1 ? el('div', { class: 'tr-sub', text: `${r.clicks} clicks` }) : null]),
    el('td', {}, [when(r.applied_at)]),
    linkCell(r),
    paidCell(r),
    el('td', {}, [when(r.last_activity)])
  ]);
}

/** The visible rows as a CSV file the admin can open in a spreadsheet. */
function downloadCsv(rows) {
  const headers = ['Name', 'Username', 'Telegram ID', 'Code', 'Group', 'Came from', 'Stage', 'Clicked at', 'Clicks',
    'Applied at', 'Refused reason', 'Link created at', 'Links', 'Amount', 'Link status', 'Failed attempts',
    'Paid at', 'Paid amount', 'Payment ID', 'Last activity'];
  const cells = rows.map((r) => [r.name, r.username, r.student_id, r.code, r.group, r.source, r.stage_label || r.stage,
    r.clicked_at, r.clicks, r.applied_at, r.refused_reason, r.link_created_at, r.links_created, r.amount, r.link_status,
    r.failed_attempts, r.paid_at, r.paid_amount, r.payment_id, r.last_activity]);
  const quote = (v) => {
    const text = String(v === undefined || v === null ? '' : v);
    // A leading = + - @ would be run as a formula by a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? "'" + text : text;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = [headers, ...cells].map((line) => line.map(quote).join(',')).join('\n');
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `code-tracking-${selectedCode || 'all'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    showToast('error', 'Could not create the file: ' + err.message);
  }
  return csv;
}

function renderPeople() {
  const rows = visibleRows();
  const tabs = el('div', { class: 'sp-tabs tr-tabs', id: 'viewTabs' }, VIEWS.map((v) => {
    const count = countFor(v.id);
    const tab = el('button', {
      id: `view-${v.id}`,
      class: 'sp-tab' + (v.id === view ? ' active' : ''),
      type: 'button'
    }, [v.label, el('span', { class: 'sp-tab-count' + (v.id === 'unpaid' && count ? ' alert' : ''), text: num(count) })]);
    tab.addEventListener('click', () => {
      view = v.id;
      renderPeople();
    });
    return tab;
  }));

  const csv = el('button', { id: 'csvBtn', class: 'btn btn-ghost btn-sm', text: 'Download CSV' });
  csv.addEventListener('click', () => downloadCsv(rows));

  const table = rows.length
    ? el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table', id: 'peopleTable' }, [
        el('thead', {}, [el('tr', {}, ['Student', 'Code', 'Came from', 'Where they got to', 'Clicked', 'Applied', 'Payment link', 'Paid', 'Last activity']
          .map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows.map(personRow))
      ])
    ])
    : emptyState('🔍', (data.rows || []).length ? 'Nobody matches this filter.' : 'Nobody has used this code yet.',
      (data.rows || []).length ? 'Try another tab or clear the search.' : 'People appear here the moment they click the link or type the code.');

  replaceChildren($('peoplePanel'), panel(
    '👥 People',
    'Newest activity first. A payment link lasts 24 hours; after that it shows as expired.',
    [tabs, table],
    rows.length ? csv : null
  ));
}

function renderNotices() {
  const notes = [];
  if (data && data.configured === false) {
    notes.push(el('div', { class: 'banner tone-warn' }, [el('div', { class: 'banner-body' }, [
      el('strong', { text: 'Tracking is not set up for this bot. ' }),
      el('span', { text: 'It needs the group\'s SHEET_ID and the Google service account (GOOGLE_SERVICE_ACCOUNT_JSON).' })
    ])]));
  }
  replaceChildren($('notices'), notes.length ? el('div', { class: 'sp-notices' }, notes) : null);
}

async function load() {
  $('refreshBtn').disabled = true;
  replaceChildren($('summaryPanel'), el('div', { class: 'loading-row' }, [el('div', { class: 'spinner' }), el('span', { text: 'Loading code tracking…' })]));
  try {
    // Through `query`, not the path: api() adds ?group= itself.
    data = await api('/api/pricing/tracking', { query: { code: selectedCode } });
    // A code that is no longer offered falls back to all codes.
    if (selectedCode && !(data.codes || []).some((c) => c.code === selectedCode) && !(data.rows || []).length) selectedCode = '';
    renderNotices();
    renderControls();
    renderSummary();
    renderPeople();
  } catch (err) {
    replaceChildren($('summaryPanel'), emptyState('⚠️', 'Could not load code tracking.', err.message));
    showToast('error', err.message, 9000);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

async function checkWithRazorpay() {
  const button = $('checkBtn');
  await busy(button, 'Checking…', async () => {
    try {
      const result = await api('/api/pricing/tracking/refresh', { method: 'POST', body: { code: selectedCode } });
      const parts = [`Checked ${num(result.checked)} unpaid payment link(s)`];
      if (result.changed) parts.push(`${num(result.changed)} updated`);
      if (result.failed) parts.push(`${num(result.failed)} could not be read`);
      if (result.remaining) parts.push(`${num(result.remaining)} more — press again`);
      const unrecorded = (result.unrecorded || []).length;
      if (unrecorded) parts.push(`${num(unrecorded)} paid but never recorded — see the warning`);
      showToast(unrecorded ? 'warn' : 'success', parts.join(' · ') + '.', 9000);
      await load();
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  });
}

initDashboard({
  page: 'tracking',
  onReady: async () => {
    if (!getSelectedGroup()) return;
    // Opened from a coupon's Track button: tracking.html?code=DIWALI50
    try {
      const wanted = String(new URLSearchParams(window.location.search).get('code') || '').trim().toUpperCase();
      if (/^[A-Z0-9]{3,20}$/.test(wanted)) selectedCode = wanted;
    } catch (err) {
      // No query string to read; show every code.
    }
    $('refreshBtn').addEventListener('click', load);
    $('checkBtn').addEventListener('click', checkWithRazorpay);
    await load();
  }
});
