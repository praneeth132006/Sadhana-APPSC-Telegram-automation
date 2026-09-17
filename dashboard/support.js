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
  initDashboard, api, el, replaceChildren, emptyState, pill, num, showToast, getSelectedGroup, $
} from './shared.js';

/** Which tickets the list shows. */
const filters = { status: 'open', search: '' };

/** Loaded once from /api/support/settings. */
let meta = { categories: [], statuses: [], quickReplies: [], definitions: [], settings: {}, context: null };

/** The ticket open in the workspace. */
let selectedId = '';

/** The newest list, for re-rendering the selection highlight. */
let lastTickets = [];

const STATUS_TONE = { open: 'warn', answered: 'info', closed: 'ok' };

const ACTION_WORDS = {
  ticket_opened: 'opened the ticket',
  student_message: 'wrote a message',
  admin_reply: 'replied',
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
  status_answered: 'marked it as waiting for the student',
  status_open: 'marked it as waiting for an admin'
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function statusInfo(id) {
  return meta.statuses.find((s) => s.id === id) || { id, label: id || 'unknown', meaning: '' };
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
  const statuses = meta.statuses.map((s) => el('li', {}, [
    pill(s.label, STATUS_TONE[s.id]), ' ', el('span', { text: s.meaning })
  ]));
  replaceChildren($('howItWorks'), el('div', { class: 'panel-body sp-howto-body' }, [
    el('div', {}, [
      el('h3', { text: 'What the statuses mean' }),
      el('ul', { class: 'sp-plain-list' }, statuses)
    ]),
    el('div', {}, [
      el('h3', { text: 'How to answer a ticket' }),
      el('ol', { class: 'sp-plain-list' }, [
        el('li', { text: 'Pick a ticket under "Waiting for you".' }),
        el('li', { text: 'Read "Student\'s access" — it shows their pass, whether they are in the group, and a suggested next step.' }),
        el('li', { text: 'Type a reply, or insert a quick reply, and press Send. Tick "close after sending" when that answer settles it.' }),
        el('li', { text: 'Link problem with a valid pass? Use "Send new invite link". Says they paid? Ask for the payment id, then "Check payment".' })
      ])
    ]),
    el('div', {}, [
      el('h3', { text: 'In Telegram' }),
      el('p', { class: 'hint-text', text: 'The same tickets arrive in the support chat with buttons for all of this. Send /supporthelp there for the full list. Replies made in either place show up in both.' })
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
  const tabs = [
    { id: 'open', label: '🟠 Waiting for you', count: counts.open },
    { id: 'answered', label: '🔵 Waiting for student', count: counts.answered },
    { id: 'closed', label: '✅ Resolved', count: counts.closed },
    { id: '', label: 'All', count: counts.total }
  ];
  replaceChildren($('statusTabs'), tabs.map((tab) => el('button', {
    class: 'sp-tab' + (filters.status === tab.id ? ' active' : ''),
    role: 'tab',
    'aria-selected': filters.status === tab.id ? 'true' : 'false',
    onclick: () => {
      filters.status = tab.id;
      loadTickets();
    }
  }, [
    el('span', { text: tab.label }),
    el('span', { class: 'sp-tab-count', text: num(tab.count || 0) })
  ])));
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
      pill(statusInfo(t.status).label, STATUS_TONE[t.status]),
      el('span', { class: 'sp-card-time', text: timeAgo(t.updated_at), title: t.updated_at })
    ]),
    el('div', { class: 'sp-card-issue', text: `${cat.emoji} ${cat.label}` }),
    el('div', { class: 'sp-card-student', text: studentName(t) }),
    el('div', { class: 'sp-card-snippet', text: String(t.last_message || '') }),
    t.handled_by ? el('div', { class: 'sp-card-handler', text: `Last handled by ${t.handled_by}` }) : null
  ]);
}

async function loadTickets() {
  const list = $('ticketList');
  replaceChildren(list, el('div', { class: 'loading-row' }, [el('div', { class: 'spinner' }), el('span', { text: 'Loading tickets…' })]));
  try {
    const page = await api('/api/support/tickets', { query: { status: filters.status, search: filters.search, pageSize: 100 } });
    renderNotices(page.context);
    renderTabs(page.counts);
    lastTickets = page.tickets || [];
    if (!lastTickets.length) {
      const empty = filters.status === 'open'
        ? emptyState('🎉', 'Nobody is waiting for you.', 'New tickets appear here as students raise them.')
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
  await Promise.all([openTicket(ticketId), loadTickets()]);
}

function renderWorkspace(ticket) {
  const cat = category(ticket.category);
  const status = statusInfo(ticket.status);

  const header = el('div', { class: 'sp-ws-header' }, [
    el('div', { class: 'sp-ws-title-row' }, [
      el('h2', { class: 'sp-ws-title', text: `${cat.emoji} ${cat.label}` }),
      pill(status.label, STATUS_TONE[ticket.status])
    ]),
    el('p', { class: 'sp-ws-meaning', text: status.meaning }),
    el('div', { class: 'sp-ws-facts' }, [
      el('span', { class: 'sp-strong', text: studentName(ticket) }),
      el('span', { text: `Telegram id ${ticket.telegram_id}` }),
      el('span', { text: `Ticket ${ticket.ticket_id}` }),
      el('span', { text: `Opened ${timeAgo(ticket.created_at)}`, title: ticket.created_at }),
      ticket.handled_by ? el('span', { text: `Last handled by ${ticket.handled_by}` }) : null,
      ticket.admin_replies ? el('span', { text: `${ticket.admin_replies} admin repl${ticket.admin_replies === 1 ? 'y' : 'ies'}` }) : null,
      ticket.closed_by ? el('span', { text: `Closed by ${ticket.closed_by}` }) : null
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
    const rows = data.passes.map((p) => {
      let state;
      if (!p.hasPass) state = pill('No pass', 'muted');
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
      return el('div', { class: 'sp-pass-row' }, [
        el('div', { class: 'sp-pass-group', text: p.group }),
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
  const statusButton = el('button', { class: 'btn btn-ghost', text: closed ? '🔓 Reopen' : '✅ Resolve & close' });
  statusButton.addEventListener('click', () => busy(statusButton, closed ? 'Reopening…' : 'Closing…', async () => {
    try {
      const result = await api('/api/support/status', {
        method: 'POST', body: { ticketId: ticket.ticket_id, status: closed ? 'open' : 'closed' }
      });
      showToast('success', closed ? 'Ticket reopened.' : (result.notified ? 'Resolved — the student was told.' : 'Resolved.'));
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
    actionCard(closed ? 'Reopen' : 'Resolve & close',
      closed ? 'Move it back to "Waiting for admin".' : 'Marks it resolved and tells the student in Telegram.', statusButton)
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

async function loadMeta() {
  const data = await api('/api/support/settings');
  meta = data;
  renderNotices(data.context);
  renderHowItWorks();
  renderSettings();
}

async function loadAll() {
  $('refreshBtn').disabled = true;
  try {
    await loadMeta();
    await loadTickets();
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
