// ============================================================================
// Support dashboard (dashboard/support.js)
// ============================================================================
// Tickets raised through the payment bot. A list on the left, the selected
// ticket on the right: who the student is and what they hold, the
// conversation, a reply box with quick replies, and the other actions
// (new invite link, payment check, grant, resolve). Every action goes through
// the same bot and the same sheet log as the Telegram support chat.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, emptyState, pill, num, showToast, statCard, getSelectedGroup, $
} from './shared.js';

/** Which tickets the list shows. Starts on the queue that needs work. */
const filters = { tab: 'needs_reply', search: '', group: '' };

/** The list tabs, and the query each one sends. */
const TABS = [
  { id: 'needs_reply', label: '🔴 Needs reply', count: 'needs_reply', query: { waitingOn: 'admin', sort: 'waiting' } },
  { id: 'open', label: '🆕 Open', count: 'open', query: { status: 'open', sort: 'waiting' } },
  { id: 'in_progress', label: '🟡 In progress', count: 'in_progress', query: { status: 'in_progress' } },
  { id: 'waiting_student', label: '⏳ Waiting for student', count: 'waiting_student', query: { waitingOn: 'student' } },
  { id: 'closed', label: '✅ Closed', count: 'closed', query: { status: 'closed' } },
  { id: 'all', label: 'All', count: 'total', query: {} }
];

/** Analysis period in days. */
let statsDays = 30;

/** Loaded once from /api/support/settings. */
let meta = { categories: [], statuses: [], waiting: [], quickReplies: [], definitions: [], settings: {}, context: null };

/** The ticket open in the workspace. */
let selectedId = '';

/** The newest list, for re-rendering the selection highlight. */
let lastTickets = [];

const STATUS_TONE = { open: 'warn', in_progress: 'info', closed: 'ok' };
const WAITING_TONE = { admin: 'danger', student: 'muted' };

const ACTION_WORDS = {
  ticket_opened: 'opened the ticket',
  student_message: 'wrote a message',
  admin_reply: 'replied',
  picked_up: 'picked up the ticket',
  admin_started_conversation: 'messaged the student first',
  invite_sent: 'sent a new invite link',
  invite_not_sent: 'tried to send an invite link (not sent)',
  payment_checked: 'checked a payment',
  pass_granted: 'granted a pass',
  pass_grant_already_done: 'granted a pass (already done before)',
  pass_grant_refused: 'tried to grant a pass (refused)',
  pass_grant_failed: 'tried to grant a pass (failed)',
  closed: 'resolved and closed the ticket',
  reopened: 'reopened the ticket',
  group_changed: 'changed which group the ticket is about'
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function statusInfo(id) {
  const status = id === 'answered' ? 'in_progress' : id;
  return meta.statuses.find((s) => s.id === status) || { id: status, label: status || 'unknown', meaning: '' };
}

/** The status pill, plus who has to act next unless it is closed. */
function statusPills(ticket) {
  const status = statusInfo(ticket.status);
  const waiting = status.id !== 'closed' && meta.waiting.find((w) => w.id === ticket.waiting_on);
  return [pill(status.label, STATUS_TONE[status.id]), waiting ? pill(waiting.label, WAITING_TONE[waiting.id]) : null];
}

/** 95 → "1 h 35 min". */
function duration(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '—';
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  return `${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} h` : ''}`;
}

/** The groups this page's payment bot sells. */
function familyGroups() {
  return (meta.context && meta.context.groups) || [];
}

/** Whether tickets need to say which group they are about. */
function multiGroup() {
  return familyGroups().length > 1;
}

function groupName(id) {
  const group = familyGroups().find((g) => g.id === id);
  return group ? group.name : '';
}

/** A pill naming the group a ticket is about, or saying it was not given. */
function groupPill(id) {
  const name = groupName(id);
  return name ? pill(`👥 ${name}`, 'info') : pill('👥 Group not specified', 'muted');
}

function category(id) {
  return meta.categories.find((c) => c.id === id) || { id, label: id || 'Something else', emoji: '💬' };
}

function studentName(t) {
  return [t.name, t.username ? '@' + t.username : ''].filter(Boolean).join(' · ') || `Telegram id ${t.telegram_id}`;
}

/** "17-09-2026, 03:04:10 PM IST" → Date, or null. */
function parseIst(stamp) {
  const m = String(stamp || '').match(/^(\d{2})-(\d{2})-(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (m[7].toUpperCase() === 'PM') hour += 12;
  return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], hour, +m[5], +m[6]) - 330 * 60 * 1000);
}

/** "5 min ago", "3 h ago", "2 days ago", or the stamp itself. */
function timeAgo(stamp) {
  const date = parseIst(stamp);
  if (!date) return stamp || '';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * The stored conversation as messages. Each entry in the sheet is
 * "[time] author:\ntext", separated by a blank line.
 */
function parseConversation(text) {
  const source = String(text || '');
  const starts = [];
  const pattern = /(?:^|\n\n)(?=\[[^\]\n]{6,40}\] [^\n]*:\n)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    starts.push(match.index + (match[0].startsWith('\n\n') ? 2 : 0));
    if (match[0] === '') pattern.lastIndex++;
  }
  return starts.map((start, i) => {
    const chunk = source.slice(start, i + 1 < starts.length ? starts[i + 1] - 2 : source.length);
    const head = chunk.match(/^\[([^\]]+)\] ([^\n]*):\n/);
    const author = head ? head[2] : '';
    return {
      at: head ? head[1] : '',
      author: author.replace(/^Admin /, ''),
      fromAdmin: author.startsWith('Admin '),
      text: head ? chunk.slice(head[0].length) : chunk
    };
  });
}

/** Runs an async action on a button, showing progress and restoring it after. */
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

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

function renderHowItWorks() {
  const statuses = [
    ...meta.statuses.map((s) => el('li', {}, [pill(s.label, STATUS_TONE[s.id]), ' ', el('span', { text: s.meaning })])),
    el('li', {}, [pill('🔴 Needs reply', 'danger'), ' ', el('span', { text: 'The student wrote last and is waiting for an admin.' })]),
    el('li', {}, [pill('⏳ Waiting for student', 'muted'), ' ', el('span', { text: 'An admin wrote last.' })]),
    el('li', {}, [el('strong', { text: 'Only an admin closes a ticket' }), el('span', { text: ' — with Close, the "Resolved" quick reply, or "close after sending".' })])
  ];
  replaceChildren($('howItWorks'), el('div', { class: 'panel-body sp-howto-body' }, [
    el('div', {}, [
      el('h3', { text: 'What the statuses mean' }),
      el('ul', { class: 'sp-plain-list' }, statuses)
    ]),
    el('div', {}, [
      el('h3', { text: 'How to answer a ticket' }),
      el('ol', { class: 'sp-plain-list' }, [
        el('li', { text: 'Start with "Needs reply" — longest waiting first.' }),
        el('li', { text: 'Check which group the ticket is about. A student can be in both — "Student\'s access" puts that group first and marks it. If they did not say, set it at the top of the ticket.' }),
        el('li', { text: 'Read "Student\'s access" — it shows their pass, whether they are in the group, and a suggested next step.' }),
        el('li', { text: 'Type a reply, or insert a quick reply, and press Send. Tick "close after sending" when that answer settles it.' }),
        el('li', { text: 'Link problem with a valid pass? Use "Send new invite link". Says they paid? Ask for the payment id, then "Check payment".' })
      ])
    ]),
    el('div', {}, [
      el('h3', { text: 'In Telegram' }),
      el('p', { class: 'hint-text', text: 'The same tickets arrive in the support chat with buttons for all of this. There, /summary shows the counts, and /find pay_… (or pasting a payment id) looks up a payment. Send /supporthelp for the full list. Replies made in either place show up in both.' })
    ])
  ]));
}

function renderNotices(context) {
  const notes = [];
  if (!context) return;
  if (!context.isPrimary) {
    notes.push(el('div', { class: 'banner tone-info' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: 'Shared bot. ' }),
        el('span', { text: `This group uses the same payment bot as ${context.primaryGroupName}, so you are seeing that bot's tickets.` })
      ])
    ]));
  }
  if (!context.botConfigured) {
    notes.push(el('div', { class: 'banner tone-warn' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: 'Payment bot not configured. ' }),
        el('span', { text: `Set ${context.payBotEnv || 'the payment bot token'} so replies can be sent from here.` })
      ])
    ]));
  }
  if (!context.supportChatConfigured) {
    notes.push(el('div', { class: 'banner tone-info' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: 'No Telegram support chat. ' }),
        el('span', { text: 'Tickets only appear on this page. Set SUPPORT_CHAT_ID and add the bot to that chat to handle them in Telegram too.' })
      ])
    ]));
  }
  replaceChildren($('notices'), notes.length ? el('div', { class: 'sp-notices' }, notes) : null);
}

function renderTabs(counts = {}) {
  replaceChildren($('statusTabs'), TABS.map((tab) => el('button', {
    class: 'sp-tab' + (filters.tab === tab.id ? ' active' : ''),
    role: 'tab',
    'aria-selected': filters.tab === tab.id ? 'true' : 'false',
    onclick: () => {
      filters.tab = tab.id;
      loadTickets();
    }
  }, [
    el('span', { text: tab.label }),
    el('span', { class: 'sp-tab-count' + (tab.id === 'needs_reply' && counts.needs_reply ? ' alert' : ''), text: num(counts[tab.count] || 0) })
  ])));
}

// ---------------------------------------------------------------------------
// At a glance and analysis
// ---------------------------------------------------------------------------

async function loadStats() {
  try {
    const stats = await api('/api/support/stats', { query: { days: statsDays } });
    renderStats(stats);
  } catch (err) {
    replaceChildren($('statGrid'), emptyState('⚠️', 'Could not load the support numbers.', err.message));
    replaceChildren($('statGridSecondary'));
  }
}

function renderStats(stats) {
  const c = stats.counts || {};
  const oldest = stats.oldest_needs_reply;
  replaceChildren($('statGrid'),
    statCard('Needs reply', num(c.needs_reply || 0), { tone: c.needs_reply ? 'danger' : 'ok', sub: 'student is waiting for an admin' }),
    statCard('Open', num(c.open || 0), { tone: c.open ? 'warn' : 'ok', sub: 'not picked up by anyone yet' }),
    statCard('In progress', num(c.in_progress || 0), { tone: 'info', sub: 'an admin is on it' }),
    statCard('Closed', num(c.closed || 0), { tone: 'ok', sub: 'closed by an admin' }),
    statCard('All tickets', num(c.total || 0), { tone: 'muted', sub: 'since support started' })
  );
  const reply = stats.first_reply_minutes || {};
  const close = stats.close_hours || {};
  replaceChildren($('statGridSecondary'),
    statCard('First reply (average)', duration(reply.average), { tone: 'info', sub: `median ${duration(reply.median)} · ${num(reply.samples || 0)} tickets, last ${stats.period_days} days` }),
    statCard('Time to close (average)', close.average === null || close.average === undefined ? '—' : duration(close.average * 60),
      { tone: 'info', sub: `median ${close.median === null || close.median === undefined ? '—' : duration(close.median * 60)} · ${num(close.samples || 0)} closed` }),
    statCard('Today', `${num(stats.opened_today || 0)} in · ${num(stats.closed_today || 0)} closed`, { tone: 'muted', sub: 'tickets opened and closed today' }),
    statCard('Longest waiting', oldest ? duration(oldest.minutes) : '—', {
      tone: oldest && oldest.minutes > 24 * 60 ? 'danger' : oldest ? 'warn' : 'ok',
      sub: oldest
        ? [oldest.name, category(oldest.category).label, multiGroup() ? groupName(oldest.group) : ''].filter(Boolean).join(' · ')
        : 'nobody is waiting'
    })
  );
  renderAnalysis(stats);
}

function renderAnalysis(stats) {
  const period = el('select', { class: 'field-select', 'aria-label': 'Analysis period' },
    [7, 30, 90].map((d) => el('option', { value: String(d), text: `Last ${d} days` })));
  period.value = String(statsDays);
  period.addEventListener('change', () => {
    statsDays = Number(period.value);
    loadStats();
  });

  const categories = Object.entries(stats.by_category || {}).sort((a, b) => b[1].total - a[1].total);
  const categoryTable = categories.length
    ? el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Issue', 'Open', 'In progress', 'Closed', 'Total'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, categories.map(([id, row]) => el('tr', {}, [
        el('td', { text: `${category(id).emoji} ${category(id).label}` }),
        el('td', { class: 'num', text: num(row.open) }),
        el('td', { class: 'num', text: num(row.in_progress) }),
        el('td', { class: 'num', text: num(row.closed) }),
        el('td', { class: 'num', text: num(row.total) })
      ])))
    ])])
    : emptyState('📭', 'No tickets yet.');

  const admins = Object.entries(stats.by_admin || {}).sort((a, b) => (b[1].replies + b[1].quick_replies) - (a[1].replies + a[1].quick_replies));
  const adminTable = admins.length
    ? el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Admin', 'Picked up', 'Replies', 'Quick replies', 'Invites sent', 'Payments checked', 'Passes granted', 'Closed', 'Last action'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, admins.map(([who, a]) => el('tr', {}, [
        el('td', { class: 'sp-strong', text: who }),
        el('td', { class: 'num', text: num(a.picked_up) }),
        el('td', { class: 'num', text: num(a.replies) }),
        el('td', { class: 'num', text: num(a.quick_replies) }),
        el('td', { class: 'num', text: num(a.invites_sent) }),
        el('td', { class: 'num', text: num(a.payments_checked) }),
        el('td', { class: 'num', text: num(a.passes_granted) }),
        el('td', { class: 'num', text: num(a.closed) }),
        el('td', { class: 'muted', text: timeAgo(a.last_action_at), title: a.last_action_at })
      ])))
    ])])
    : emptyState('🧑‍💼', `No admin activity in the last ${stats.period_days} days.`);

  const byGroup = stats.by_group || {};
  const groupRows = multiGroup()
    ? [...familyGroups().map((g) => [g.name, byGroup[g.id]]), ['Not specified', byGroup.unspecified]].filter(([, row]) => row)
    : [];
  const groupTable = groupRows.length
    ? el('div', { class: 'table-wrap' }, [el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {}, ['Group', 'Needs reply', 'Open', 'In progress', 'Closed', 'Total'].map((h) => el('th', { text: h })))]),
      el('tbody', {}, groupRows.map(([name, row]) => el('tr', {}, [
        el('td', { class: 'sp-strong', text: name }),
        el('td', { class: 'num', text: num(row.needs_reply) }),
        el('td', { class: 'num', text: num(row.open) }),
        el('td', { class: 'num', text: num(row.in_progress) }),
        el('td', { class: 'num', text: num(row.closed) }),
        el('td', { class: 'num', text: num(row.total) })
      ])))
    ])])
    : null;

  replaceChildren($('analysisBody'),
    el('div', { class: 'sp-analysis-head' }, [
      el('p', { class: 'hint-text', text: `${num(stats.opened_in_period || 0)} tickets opened and ${num(stats.closed_in_period || 0)} closed in the last ${stats.period_days} days. Everything here is counted from the Support and Support Log tabs.` }),
      period
    ]),
    groupTable ? el('h3', { class: 'sp-box-title', text: 'By group (all tickets)' }) : null,
    groupTable,
    el('h3', { class: 'sp-box-title', text: 'By issue type (all tickets)' }),
    categoryTable,
    el('h3', { class: 'sp-box-title', text: `By admin (last ${stats.period_days} days)` }),
    adminTable
  );
}

// ---------------------------------------------------------------------------
// Ticket list
// ---------------------------------------------------------------------------

function ticketCard(t) {
  const cat = category(t.category);
  return el('button', {
    class: 'sp-card' + (t.ticket_id === selectedId ? ' selected' : ''),
    'aria-current': t.ticket_id === selectedId ? 'true' : undefined,
    onclick: () => openTicket(t.ticket_id)
  }, [
    el('div', { class: 'sp-card-top' }, [
      el('div', { class: 'sp-pills' }, statusPills(t)),
      el('span', { class: 'sp-card-time', text: timeAgo(t.updated_at), title: t.updated_at })
    ]),
    el('div', { class: 'sp-card-issue', text: `${cat.emoji} ${cat.label}` }),
    multiGroup() ? el('div', { class: 'sp-card-meta' }, [groupPill(t.group)]) : null,
    el('div', { class: 'sp-card-student', text: studentName(t) }),
    el('div', { class: 'sp-card-snippet', text: String(t.last_message || '') }),
    el('div', { class: 'sp-card-handler', text: t.picked_up_by ? `Picked up by ${t.picked_up_by}` : 'Not picked up yet' })
  ]);
}

async function loadTickets() {
  const list = $('ticketList');
  replaceChildren(list, el('div', { class: 'loading-row' }, [el('div', { class: 'spinner' }), el('span', { text: 'Loading tickets…' })]));
  try {
    const tab = TABS.find((t) => t.id === filters.tab) || TABS[0];
    const page = await api('/api/support/tickets', {
      // `ticketGroup`, never `group`: api() already sends `group` to say which
      // dashboard group this is, and reusing it filtered the list to that
      // group's tickets while the counts still included every ticket.
      query: Object.assign({ search: filters.search, ticketGroup: filters.group, pageSize: 100 }, tab.query)
    });
    renderNotices(page.context);
    renderTabs(page.counts);
    lastTickets = page.tickets || [];
    if (!lastTickets.length) {
      const empty = filters.tab === 'needs_reply'
        ? emptyState('🎉', 'Nobody is waiting for a reply.', 'Tickets appear here when a student writes and an admin has not answered yet.')
        : emptyState('🔍', 'No tickets here.', filters.search ? 'Try a different search.' : '');
      replaceChildren(list, empty);
      return;
    }
    replaceChildren(list, lastTickets.map(ticketCard));
  } catch (err) {
    replaceChildren(list, emptyState('⚠️', 'Could not load tickets.', err.message));
  }
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

function renderWorkspaceEmpty() {
  replaceChildren($('workspace'), el('div', { class: 'sp-empty-workspace' }, [
    el('div', { class: 'empty-icon', text: '👈' }),
    el('p', { text: 'Pick a ticket to see the conversation and answer it.' })
  ]));
}

async function openTicket(ticketId) {
  selectedId = ticketId;
  replaceChildren($('ticketList'), lastTickets.map(ticketCard));
  const host = $('workspace');
  replaceChildren(host, el('div', { class: 'loading-row' }, [el('div', { class: 'spinner' }), el('span', { text: `Opening ${ticketId}…` })]));
  if (window.matchMedia('(max-width: 1023px)').matches) host.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const ticket = await api('/api/support/ticket', { query: { id: ticketId } });
    renderWorkspace(ticket);
  } catch (err) {
    replaceChildren(host, emptyState('⚠️', `Could not open ${ticketId}.`, err.message));
  }
}

/** Re-reads the open ticket and the list after an action. */
async function refreshAfterAction(ticketId) {
  await Promise.all([openTicket(ticketId), loadTickets(), loadStats()]);
}

function renderWorkspace(ticket) {
  const cat = category(ticket.category);
  const status = statusInfo(ticket.status);

  const firstReply = ticket.first_reply_at && parseIst(ticket.created_at) && parseIst(ticket.first_reply_at)
    ? duration((parseIst(ticket.first_reply_at) - parseIst(ticket.created_at)) / 60000) : '';
  const header = el('div', { class: 'sp-ws-header' }, [
    el('div', { class: 'sp-ws-title-row' }, [
      el('h2', { class: 'sp-ws-title', text: `${cat.emoji} ${cat.label}` }),
      el('div', { class: 'sp-pills' }, statusPills(ticket))
    ]),
    el('p', { class: 'sp-ws-meaning', text: status.meaning }),
    aboutPanel(ticket, cat),
    el('div', { class: 'sp-ws-facts' }, [
      el('span', { class: 'sp-strong', text: studentName(ticket) }),
      el('span', { text: `Telegram id ${ticket.telegram_id}` }),
      el('span', { text: `Ticket ${ticket.ticket_id}` }),
      el('span', { text: `Opened ${timeAgo(ticket.created_at)}`, title: ticket.created_at }),
      el('span', { text: ticket.picked_up_by ? `Picked up by ${ticket.picked_up_by}` : 'Not picked up yet', title: ticket.picked_up_at || '' }),
      firstReply ? el('span', { text: `First reply after ${firstReply}` }) : null,
      ticket.handled_by ? el('span', { text: `Last handled by ${ticket.handled_by}` }) : null,
      ticket.admin_replies ? el('span', { text: `${ticket.admin_replies} admin repl${ticket.admin_replies === 1 ? 'y' : 'ies'}` }) : null,
      ticket.times_reopened ? el('span', { text: `Reopened ${ticket.times_reopened}×` }) : null,
      ticket.closed_by ? el('span', { text: `Closed by ${ticket.closed_by} ${timeAgo(ticket.closed_at)}`, title: ticket.closed_at }) : null
    ])
  ]);

  const studentBox = el('div', { class: 'sp-box', id: 'studentBox' }, [
    el('h3', { class: 'sp-box-title', text: '🎟 Student\'s access' }),
    el('div', { class: 'loading-row' }, [el('div', { class: 'spinner' }), el('span', { text: 'Checking their pass and group membership…' })])
  ]);

  const conversation = el('div', { class: 'sp-box' }, [
    el('h3', { class: 'sp-box-title', text: '💬 Conversation' }),
    conversationView(ticket)
  ]);

  replaceChildren($('workspace'),
    header,
    studentBox,
    conversation,
    replyBox(ticket),
    actionsBox(ticket),
    activityLog(ticket)
  );

  loadStudent(ticket);
}

/**
 * Issue, group and student at a glance. With two groups the group can be
 * corrected here, since a student in both may not have said which.
 */
function aboutPanel(ticket, cat) {
  const rows = [
    ['Issue', el('span', { text: `${cat.emoji} ${cat.label}` })],
    ['Student', el('span', { text: `${studentName(ticket)} · Telegram id ${ticket.telegram_id}` })]
  ];
  if (multiGroup()) {
    const select = el('select', { class: 'field-select', 'aria-label': 'Which group this ticket is about' }, [
      el('option', { value: '', text: 'Not specified' }),
      ...familyGroups().map((g) => el('option', { value: g.id, text: g.name }))
    ]);
    select.value = ticket.group || '';
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        await api('/api/support/group', { method: 'POST', body: { ticketId: ticket.ticket_id, group: select.value } });
        showToast('success', select.value ? `Ticket filed under ${groupName(select.value)}.` : 'Group cleared.');
        await refreshAfterAction(ticket.ticket_id);
      } catch (err) {
        select.value = ticket.group || '';
        showToast('error', err.message, 9000);
      } finally {
        select.disabled = false;
      }
    });
    rows.splice(1, 0, ['Group', el('span', { class: 'sp-inline-form' }, [
      select,
      ticket.group ? null : el('span', { class: 'hint-text', text: 'The student did not say — check "Student\'s access" below.' })
    ])]);
  }
  return el('dl', { class: 'sp-ws-about' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, [v])]));
}

function conversationView(ticket) {
  const messages = parseConversation(ticket.conversation);
  if (!messages.length) {
    return el('p', { class: 'hint-text', text: ticket.last_message || 'No messages yet.' });
  }
  return el('div', { class: 'sp-chat' }, messages.map((m) => el('div', { class: 'sp-bubble-row' + (m.fromAdmin ? ' admin' : '') }, [
    el('div', { class: 'sp-bubble' }, [
      el('div', { class: 'sp-bubble-meta' }, [
        el('span', { class: 'sp-strong', text: m.fromAdmin ? `${m.author} (admin)` : m.author }),
        el('span', { text: timeAgo(m.at), title: m.at })
      ]),
      el('div', { class: 'sp-bubble-text', text: m.text })
    ])
  ])));
}

async function loadStudent(ticket) {
  const box = $('studentBox');
  if (!box) return;
  try {
    const data = await api('/api/support/student', { query: { ticketId: ticket.ticket_id } });
    // The ticket's own group first, so it is the first thing read.
    const passes = data.passes.slice().sort((a, b) => Number(b.aboutThisTicket) - Number(a.aboutThisTicket));
    const rows = passes.map((p) => {
      let state;
      if (p.error) state = pill('Could not check just now — press Refresh', 'warn');
      else if (!p.hasPass) state = pill('No pass', 'muted');
      else if (p.valid) state = pill(`Valid until ${String(p.expiry).split(',')[0]}`, 'ok');
      else state = pill(p.reason, 'danger');
      const inGroup = p.hasPass
        ? pill(p.inGroup === 'yes' ? 'In the group' : p.inGroup === 'no' ? 'Not in the group' : 'Membership unknown',
          p.inGroup === 'yes' ? 'ok' : p.inGroup === 'no' ? 'warn' : 'muted')
        : null;
      const details = p.hasPass
        ? [p.passName, p.totalPaid ? `paid ₹${p.totalPaid}` : '', p.paymentId, p.lastPaymentAt ? `last payment ${p.lastPaymentAt}` : '']
          .filter(Boolean).join(' · ')
        : '';
      const rowClass = 'sp-pass-row' + (p.aboutThisTicket ? ' about' : data.ticketGroup ? ' other' : '');
      return el('div', { class: rowClass }, [
        el('div', { class: 'sp-pass-head' }, [
          el('span', { class: 'sp-pass-group', text: p.group }),
          p.aboutThisTicket && passes.length > 1 ? pill('📌 This ticket is about this group', 'info') : null
        ]),
        el('div', { class: 'sp-pass-state' }, [state, inGroup]),
        details ? el('div', { class: 'sp-pass-details', text: details }) : null
      ]);
    });
    const paymentHint = data.paymentIdInTicket && document.getElementById('paymentIdInput');
    if (paymentHint && !paymentHint.value) paymentHint.value = data.paymentIdInTicket;

    replaceChildren(box,
      el('h3', { class: 'sp-box-title', text: '🎟 Student\'s access' }),
      ...rows,
      el('div', { class: 'sp-suggestion' }, [el('strong', { text: '🧭 Suggested next step: ' }), el('span', { text: data.suggestion })])
    );
  } catch (err) {
    replaceChildren(box,
      el('h3', { class: 'sp-box-title', text: '🎟 Student\'s access' }),
      el('p', { class: 'hint-text', text: `Could not check: ${err.message}` }));
  }
}

function orderedQuickReplies(categoryId) {
  const relevant = meta.quickReplies.filter((q) => q.for.includes(categoryId));
  const rest = meta.quickReplies.filter((q) => !q.for.includes(categoryId) && !q.closes);
  return [...relevant, ...rest, ...meta.quickReplies.filter((q) => q.closes)];
}

function replyBox(ticket) {
  const textarea = el('textarea', {
    class: 'field-input support-textarea', rows: '5', maxlength: '3500', id: 'replyText',
    'aria-label': 'Reply to the student',
    placeholder: 'Write your answer. It is sent to the student in Telegram from the payment bot.'
  });

  const closeAfter = el('input', { type: 'checkbox', id: 'closeAfter' });

  const quick = el('select', { class: 'field-select', id: 'quickReplySelect', 'aria-label': 'Insert a quick reply' }, [
    el('option', { value: '', text: '📋 Insert a quick reply…' }),
    ...orderedQuickReplies(ticket.category).map((q) => el('option', { value: q.id, text: q.button }))
  ]);
  quick.addEventListener('change', () => {
    const reply = meta.quickReplies.find((q) => q.id === quick.value);
    if (!reply) return;
    textarea.value = meta.settings[reply.key] || '';
    closeAfter.checked = reply.closes;
    textarea.focus();
    quick.value = '';
  });

  const send = el('button', { class: 'btn btn-primary', text: 'Send reply' });
  send.addEventListener('click', () => busy(send, 'Sending…', async () => {
    const text = textarea.value.trim();
    if (!text) {
      showToast('warn', 'Write a reply first.');
      return;
    }
    try {
      const result = await api('/api/support/reply', { method: 'POST', body: { ticketId: ticket.ticket_id, text } });
      if (result && result.warning) showToast('warn', result.warning, 9000);
      if (closeAfter.checked) {
        await api('/api/support/status', { method: 'POST', body: { ticketId: ticket.ticket_id, status: 'closed' } });
        showToast('success', 'Reply sent and ticket resolved.');
      } else {
        showToast('success', 'Reply sent to the student.');
      }
      await refreshAfterAction(ticket.ticket_id);
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  return el('div', { class: 'sp-box sp-reply' }, [
    el('h3', { class: 'sp-box-title', text: '✍️ Reply to the student' }),
    quick,
    textarea,
    el('div', { class: 'support-actions spread' }, [
      el('label', { class: 'sp-check', for: 'closeAfter' }, [closeAfter, el('span', { text: 'Close the ticket after sending' })]),
      send
    ])
  ]);
}

function actionCard(title, description, control) {
  return el('div', { class: 'sp-action' }, [
    el('div', {}, [el('div', { class: 'sp-strong', text: title }), el('div', { class: 'hint-text', text: description })]),
    control
  ]);
}

function actionsBox(ticket) {
  const invite = el('button', { class: 'btn btn-ghost', text: '🔗 Send new invite link' });
  invite.addEventListener('click', () => busy(invite, 'Sending…', async () => {
    try {
      const { results } = await api('/api/support/resend-invite', { method: 'POST', body: { ticketId: ticket.ticket_id } });
      const delivered = results.filter((r) => r.delivered).map((r) => r.group);
      if (delivered.length) showToast('success', `New invite link sent for ${delivered.join(', ')}.`, 7000);
      results.filter((r) => r.sent && !r.delivered).forEach((r) => showToast('warn',
        `${r.group}: link created but the student could not be messaged (${r.error}). Send it yourself: ${r.inviteLink}`, 20000));
      if (!results.some((r) => r.sent)) {
        showToast('warn', `No link sent — no valid pass. ${results.map((r) => `${r.group}: ${r.reason || r.error || r.status}`).join(' · ')}`, 12000);
      }
      await refreshAfterAction(ticket.ticket_id);
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  const paymentInput = el('input', {
    type: 'text', class: 'field-input', id: 'paymentIdInput', placeholder: 'pay_XXXXXXXXXXXXXX',
    'aria-label': 'Razorpay payment id', autocomplete: 'off', spellcheck: 'false'
  });
  const paymentResult = el('div', { class: 'sp-payment-result', id: 'paymentResult' });
  const check = el('button', { class: 'btn btn-ghost', text: '🔍 Check payment' });
  check.addEventListener('click', () => busy(check, 'Checking…', async () => {
    const paymentId = paymentInput.value.trim();
    if (!/^pay_[A-Za-z0-9]{8,30}$/.test(paymentId)) {
      showToast('warn', 'Enter a Razorpay payment id — it starts with pay_.');
      return;
    }
    try {
      const data = await api('/api/support/check-payment', { method: 'POST', body: { ticketId: ticket.ticket_id, paymentId } });
      renderPaymentResult(paymentResult, ticket, paymentId, data);
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  const closed = ticket.status === 'closed';
  const statusButton = el('button', { class: 'btn btn-ghost', text: closed ? '🔓 Reopen' : '✅ Close ticket' });
  statusButton.addEventListener('click', () => busy(statusButton, closed ? 'Reopening…' : 'Closing…', async () => {
    try {
      const result = await api('/api/support/status', {
        method: 'POST', body: { ticketId: ticket.ticket_id, status: closed ? 'in_progress' : 'closed' }
      });
      showToast('success', closed ? 'Reopened — it is in progress again.'
        : (result.notified ? 'Closed — the student was told it is resolved.' : 'Closed.'));
      await refreshAfterAction(ticket.ticket_id);
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  return el('div', { class: 'sp-box' }, [
    el('h3', { class: 'sp-box-title', text: '🛠 Other actions' }),
    actionCard('Send new invite link', 'For each group where their pass is valid. Nothing is sent without a valid pass.', invite),
    actionCard('Check a payment', 'Ask Razorpay about a payment id the student sent. If money arrived but no pass was given, you can grant it.',
      el('div', { class: 'sp-inline-form' }, [paymentInput, check])),
    paymentResult,
    actionCard(closed ? 'Reopen' : 'Close ticket',
      closed ? 'Moves it back to In progress, needing a reply.'
        : 'Only an admin can close a ticket. It stays In progress until you do. The student is told it is resolved.', statusButton)
  ]);
}

function renderPaymentResult(host, ticket, paymentId, data) {
  if (!data.found || !data.payment) {
    replaceChildren(host, el('div', { class: 'banner tone-warn' }, [el('div', { class: 'banner-body', text: data.message })]));
    return;
  }
  const p = data.payment;
  const tone = p.status === 'captured' ? 'ok' : p.status === 'failed' ? 'danger' : 'warn';
  const rows = [
    ['Status', pill(p.status, tone)],
    ['Amount', `${p.amount}${p.method ? ' · ' + p.method : ''}`],
    ['Made at', p.createdAt],
    ['For', p.description],
    ['Belongs to', p.belongsTo],
    ['Bank said', p.error]
  ].filter(([, v]) => v);

  const parts = [
    el('dl', { class: 'sp-dl' }, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, [v])]))
  ];

  if (data.captured) {
    const groupSelect = el('select', { class: 'field-select', 'aria-label': 'Group they paid for' },
      data.groups.map((g) => el('option', { value: g.id, text: g.name })));
    const grant = el('button', { class: 'btn btn-primary', text: '✅ Grant pass for this payment' });
    grant.addEventListener('click', () => {
      const groupName = groupSelect.options[groupSelect.selectedIndex].text;
      if (!window.confirm(`Grant the pass for ${groupName} to ${studentName(ticket)} using ${paymentId}?\n\nOnly do this if this payment is theirs and they have no pass.`)) return;
      busy(grant, 'Granting…', async () => {
        try {
          const result = await api('/api/support/grant-pass', {
            method: 'POST', body: { ticketId: ticket.ticket_id, paymentId, groupId: groupSelect.value }
          });
          // The toast has its own icon; the bot's message starts with one too.
          showToast(result.granted ? 'success' : 'warn', result.message.replace(/^(✅|⛔|❌|⚠️|ℹ️)\s*/u, ''), 12000);
          await refreshAfterAction(ticket.ticket_id);
        } catch (err) {
          showToast('error', err.message, 9000);
        }
      });
    });
    parts.push(el('div', { class: 'sp-grant' }, [
      el('p', { class: 'hint-text', text: 'Money was received. If the student has no valid pass, the automatic grant did not happen — you can grant it now. Razorpay is checked again, and a payment already used by someone else is refused.' }),
      el('div', { class: 'sp-inline-form' }, [groupSelect, grant])
    ]));
  }
  replaceChildren(host, el('div', { class: 'sp-payment-card' }, parts));
}

function activityLog(ticket) {
  const log = ticket.log || [];
  const body = log.length
    ? el('ol', { class: 'sp-log' }, log.slice().reverse().map((e) => {
      const action = e.action.startsWith('quick_reply:')
        ? `sent quick reply "${(meta.quickReplies.find((q) => q.key === e.action.slice(12)) || {}).button || e.action.slice(12)}"`
        : (ACTION_WORDS[e.action] || e.action);
      return el('li', {}, [
        el('span', { class: 'sp-log-time', text: e.at }),
        el('span', { class: 'sp-strong', text: e.who || e.role || 'System' }),
        el('span', { text: ` ${action}` }),
        e.details && !['student_message', 'admin_reply'].includes(e.action) && !e.action.startsWith('quick_reply:')
          ? el('div', { class: 'sp-log-details', text: e.details }) : null
      ]);
    }))
    : el('p', { class: 'hint-text', text: 'No activity recorded yet. (Tickets from before the Support Log existed have no history here.)' });

  return el('details', { class: 'sp-box sp-activity' }, [
    el('summary', { class: 'sp-box-title', text: `🧾 Activity log (${log.length})` }),
    body
  ]);
}

// ---------------------------------------------------------------------------
// Bot texts
// ---------------------------------------------------------------------------

const SECTION_TITLES = {
  support: 'General',
  answers: 'Instant answers students see in /support',
  quick: 'Quick replies for admins'
};

function renderSettings() {
  const inputs = {};
  const sections = ['support', 'answers', 'quick'].map((section) => {
    const defs = meta.definitions.filter((d) => d.section === section);
    return el('fieldset', { class: 'sp-fieldset' }, [
      el('legend', { text: SECTION_TITLES[section] }),
      el('div', { class: 'support-fields' }, defs.map((def) => {
        let input;
        if (def.type === 'toggle') {
          input = el('select', { class: 'field-select' }, [el('option', { value: 'yes', text: 'yes' }), el('option', { value: 'no', text: 'no' })]);
        } else if (def.type === 'textarea') {
          input = el('textarea', { class: 'field-input support-textarea', rows: '4', maxlength: String(def.maxLength) });
        } else {
          input = el('input', { type: 'text', class: 'field-input', maxlength: String(def.maxLength) });
        }
        input.id = `setting-${def.key}`;
        input.value = meta.settings[def.key] ?? '';
        inputs[def.key] = input;
        return el('div', { class: 'support-field' }, [
          el('label', { for: input.id, text: def.label }),
          input,
          el('div', { class: 'hint-text', text: def.hint })
        ]);
      }))
    ]);
  });

  const save = el('button', { class: 'btn btn-primary', text: 'Save texts' });
  save.addEventListener('click', () => busy(save, 'Saving…', async () => {
    const changed = {};
    Object.entries(inputs).forEach(([key, input]) => {
      if (input.value.trim() !== String(meta.settings[key] ?? '').trim()) changed[key] = input.value;
    });
    if (!Object.keys(changed).length) {
      showToast('info', 'Nothing has changed.');
      return;
    }
    try {
      const saved = await api('/api/support/settings', { method: 'POST', body: { settings: changed } });
      meta.settings = saved.settings;
      showToast('success', `Saved ${Object.keys(changed).length} text(s). The bot uses them within a minute.`);
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  replaceChildren($('settingsBody'), ...sections, el('div', { class: 'support-actions end' }, [save]));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** The group filter, shown only when this bot sells more than one group. */
function renderGroupFilter() {
  const select = $('groupFilter');
  select.hidden = !multiGroup();
  if (!multiGroup()) {
    filters.group = '';
    return;
  }
  replaceChildren(select,
    el('option', { value: '', text: 'All groups' }),
    ...familyGroups().map((g) => el('option', { value: g.id, text: g.name })));
  select.value = familyGroups().some((g) => g.id === filters.group) ? filters.group : '';
}

async function loadMeta() {
  const data = await api('/api/support/settings');
  meta = data;
  renderGroupFilter();
  renderNotices(data.context);
  renderHowItWorks();
  renderSettings();
}

async function loadAll() {
  $('refreshBtn').disabled = true;
  try {
    await loadMeta();
    await Promise.all([loadTickets(), loadStats()]);
    if (selectedId) await openTicket(selectedId);
    else renderWorkspaceEmpty();
  } catch (err) {
    replaceChildren($('ticketList'), emptyState('⚠️', 'Could not load support.', err.message));
    showToast('error', err.message, 9000);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

initDashboard({
  page: 'support',
  onReady: async () => {
    if (!getSelectedGroup()) return;

    $('refreshBtn').addEventListener('click', loadAll);
    $('helpBtn').addEventListener('click', () => {
      const panel = $('howItWorks');
      panel.hidden = !panel.hidden;
      $('helpBtn').setAttribute('aria-expanded', String(!panel.hidden));
    });

    $('groupFilter').addEventListener('change', (e) => {
      filters.group = e.target.value;
      loadTickets();
    });

    let searchTimer;
    $('searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        filters.search = e.target.value.trim();
        loadTickets();
      }, 300);
    });

    await loadAll();
  }
});
