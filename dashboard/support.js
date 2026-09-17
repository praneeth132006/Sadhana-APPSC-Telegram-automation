// ============================================================================
// Support dashboard (dashboard/support.js)
// ============================================================================
// Tickets raised through the payment bot's /support flow, a reply box that
// sends through that same bot, and the admin-editable bot settings.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, panel, statCard, emptyState, pill,
  num, showToast, getSelectedGroup, $
} from './shared.js';

/** Current ticket filters. Open tickets first: that is the work queue. */
const filters = { status: 'open', search: '', page: 1, pageSize: 50 };

/** The ticket whose thread is open, if any. */
let openTicketId = '';

/** Maps a ticket status to a pill tone. */
function statusTone(status) {
  return { open: 'warn', answered: 'info', closed: 'ok' }[status] || 'muted';
}

/** Category id → label, filled from the settings payload. */
let categoryLabels = {};

function categoryLabel(id) {
  return categoryLabels[id] || id || '—';
}

/** Who raised a ticket, as one line. */
function studentLine(t) {
  const handle = t.username ? '@' + t.username : '';
  return [t.name, handle].filter(Boolean).join(' · ') || t.telegram_id;
}

/** Explains anything about this group that would make the page look empty or broken. */
function renderNotices(context) {
  const notes = [];
  if (!context.isPrimary) {
    const url = new URL(window.location.href);
    url.searchParams.set('group', context.primaryGroupId);
    notes.push(el('div', { class: 'banner tone-info' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: 'This group shares its payment bot. ' }),
        el('span', { text: `Tickets and bot settings for that bot are kept in ${context.primaryGroupName}'s sheet. ` }),
        el('a', { href: url.toString(), text: `Open ${context.primaryGroupName} →` })
      ])
    ]));
  }
  if (!context.botConfigured) {
    notes.push(el('div', { class: 'banner tone-warn' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: 'Payment bot not configured. ' }),
        el('span', { text: `Set ${context.payBotEnv || 'the payment bot token'} to send replies from here.` })
      ])
    ]));
  }
  if (!context.supportChatConfigured) {
    notes.push(el('div', { class: 'banner tone-info' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: 'No admin support chat. ' }),
        el('span', {
          text: 'Tickets are only visible on this page. Set SUPPORT_CHAT_ID (and add the bot to that chat) ' +
            'to also receive and answer them in Telegram.'
        })
      ])
    ]));
  }
  replaceChildren($('notices'), notes.length ? el('div', { style: 'display:grid;gap:10px;margin-bottom:18px' }, notes) : null);
}

/** Headline ticket tiles. */
function renderStats(counts = {}) {
  replaceChildren($('statGrid'),
    statCard('Open', num(counts.open || 0), { tone: counts.open ? 'warn' : 'ok', sub: 'waiting for an admin' }),
    statCard('Answered', num(counts.answered || 0), { tone: 'info', sub: 'waiting on the student' }),
    statCard('Closed', num(counts.closed || 0), { tone: 'ok', sub: 'resolved' }),
    statCard('All Tickets', num(counts.total || 0), { tone: 'muted', sub: 'since support started' })
  );
}

/** Filter controls above the ticket table. */
function filterBar() {
  const statusSelect = el('select', { class: 'field-select' }, [
    el('option', { value: '', text: 'Any status' }),
    ...['open', 'answered', 'closed'].map((s) => el('option', { value: s, text: s }))
  ]);
  statusSelect.value = filters.status;

  const searchInput = el('input', {
    type: 'search', class: 'field-input', value: filters.search,
    placeholder: 'Ticket id, Telegram id, @username or message text'
  });

  const apply = () => {
    filters.status = statusSelect.value;
    filters.search = searchInput.value.trim();
    filters.page = 1;
    loadTickets();
  };

  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  statusSelect.addEventListener('change', apply);

  return el('div', { class: 'filter-bar' }, [
    el('div', { class: 'filter-item' }, [el('label', { text: 'Status' }), statusSelect]),
    el('div', { class: 'filter-item grow' }, [el('label', { text: 'Search' }), searchInput]),
    el('button', { class: 'btn btn-primary', text: 'Apply', onclick: apply })
  ]);
}

/** The ticket table. */
function ticketsTable(rows) {
  if (!rows.length) {
    return emptyState('🎉', filters.status === 'open' ? 'No open tickets.' : 'No tickets match these filters.',
      'Students raise tickets with /support in the payment bot, or by typing a message to it.');
  }

  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'data-table' }, [
      el('thead', {}, [el('tr', {},
        ['Ticket', 'Student', 'Category', 'Status', 'Updated', 'Last message', '']
          .map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((t) => el('tr', {}, [
        el('td', { class: 'mono', style: 'font-size:0.8rem;white-space:nowrap', text: t.ticket_id }),
        el('td', {}, [
          el('div', { text: studentLine(t), style: 'font-weight:600' }),
          el('div', { class: 'muted', style: 'font-size:0.75rem;margin-top:2px', text: t.telegram_id })
        ]),
        el('td', { text: categoryLabel(t.category) }),
        el('td', {}, [pill(t.status || 'unknown', statusTone(t.status))]),
        el('td', { class: 'muted', style: 'font-size:0.78rem', text: t.updated_at || '—' }),
        el('td', { class: 'support-snippet', text: String(t.last_message || '').slice(0, 140) }),
        el('td', {}, [el('button', {
          class: 'btn btn-ghost btn-sm', text: 'Open',
          onclick: () => openTicket(t.ticket_id)
        })])
      ])))
    ])
  ]);
}

/** Loads and renders the ticket list. */
async function loadTickets() {
  const panels = $('panels');
  replaceChildren(panels, el('div', { class: 'loading-row' }, [
    el('div', { class: 'spinner' }),
    el('span', { text: 'Loading tickets…' })
  ]));

  try {
    const page = await api('/api/support/tickets', { query: filters });
    renderNotices(page.context);
    renderStats(page.counts);

    replaceChildren(panels, el('section', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('div', {}, [
          el('h2', { class: 'panel-title', text: 'Tickets' }),
          el('p', { class: 'panel-subtitle', text: `${num(page.total)} ticket(s) match · newest first` })
        ])
      ]),
      filterBar(),
      el('div', { class: 'panel-body tight' }, [ticketsTable(page.tickets || [])])
    ]));
  } catch (err) {
    replaceChildren(panels, emptyState('⚠️', 'Could not load tickets.', err.message));
    showToast('error', err.message, 9000);
  }
}

/** Opens one ticket's whole thread with the reply box. */
async function openTicket(ticketId) {
  openTicketId = ticketId;
  const host = $('ticketDetail');
  replaceChildren(host, el('div', { class: 'loading-row' }, [
    el('div', { class: 'spinner' }),
    el('span', { text: `Loading ${ticketId}…` })
  ]));
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const ticket = await api('/api/support/ticket', { query: { id: ticketId } });
    renderTicket(ticket);
  } catch (err) {
    replaceChildren(host, emptyState('⚠️', `Could not load ${ticketId}.`, err.message));
  }
}

/** The thread, reply box and status actions for one ticket. */
function renderTicket(ticket) {
  const replyBox = el('textarea', {
    class: 'field-input support-textarea', rows: '5', maxlength: '3500', 'aria-label': 'Reply to the student',
    placeholder: 'Write your reply. It is sent to the student from the payment bot.'
  });

  const sendBtn = el('button', { class: 'btn btn-primary', text: 'Send reply' });
  sendBtn.addEventListener('click', async () => {
    const text = replyBox.value.trim();
    if (!text) {
      showToast('warn', 'Write a reply first.');
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    try {
      const result = await api('/api/support/reply', { method: 'POST', body: { ticketId: ticket.ticket_id, text } });
      if (result && result.warning) showToast('warn', result.warning, 9000);
      else showToast('success', `Reply sent for ${ticket.ticket_id}.`);
      await Promise.all([openTicket(ticket.ticket_id), loadTickets()]);
    } catch (err) {
      showToast('error', err.message, 9000);
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send reply';
    }
  });

  const statusBtn = (label, status, cls) => el('button', {
    class: 'btn ' + cls,
    text: label,
    onclick: async (e) => {
      e.target.disabled = true;
      try {
        const result = await api('/api/support/status', {
          method: 'POST', body: { ticketId: ticket.ticket_id, status }
        });
        showToast('success', `${ticket.ticket_id} is now ${status}` +
          (status === 'closed' ? (result && result.notified ? ' — the student was told.' : '.') : '.'));
        await Promise.all([openTicket(ticket.ticket_id), loadTickets()]);
      } catch (err) {
        showToast('error', err.message, 9000);
        e.target.disabled = false;
      }
    }
  });

  const actions = el('div', { class: 'support-actions' }, [
    ticket.status !== 'closed' ? statusBtn('Close ticket', 'closed', 'btn-ghost') : statusBtn('Reopen', 'open', 'btn-ghost'),
    ticket.status === 'open' ? statusBtn('Mark answered', 'answered', 'btn-ghost') : null,
    el('button', {
      class: 'btn btn-ghost', text: 'Hide',
      onclick: () => { openTicketId = ''; replaceChildren($('ticketDetail')); }
    })
  ]);

  const meta = el('div', { class: 'support-meta' }, [
    pill(ticket.status, statusTone(ticket.status)),
    el('span', { text: studentLine(ticket) }),
    el('span', { class: 'muted', text: `Telegram id ${ticket.telegram_id}` }),
    el('span', { class: 'muted', text: categoryLabel(ticket.category) }),
    el('span', { class: 'muted', text: `Opened ${ticket.created_at}` }),
    ticket.handled_by ? el('span', { class: 'muted', text: `Handled by ${ticket.handled_by}` }) : null
  ]);

  replaceChildren($('ticketDetail'), panel(
    `Ticket ${ticket.ticket_id}`,
    `Via ${ticket.bot || 'unknown bot'} · last updated ${ticket.updated_at}`,
    el('div', { style: 'display:grid;gap:14px' }, [
      meta,
      el('pre', { class: 'support-thread', text: ticket.conversation || ticket.last_message || '(empty)' }),
      replyBox,
      el('div', { class: 'support-actions spread' }, [actions, sendBtn])
    ])
  ));
}

/** The bot settings form. Saves only the fields that changed. */
async function loadSettings() {
  const host = $('settingsPanel');
  try {
    const data = await api('/api/support/settings');
    categoryLabels = Object.fromEntries((data.categories || []).map((c) => [c.id, `${c.emoji} ${c.label}`]));
    renderNotices(data.context);

    const inputs = {};
    const fields = data.definitions.map((def) => {
      let input;
      if (def.type === 'toggle') {
        input = el('select', { class: 'field-select' }, [
          el('option', { value: 'yes', text: 'yes' }),
          el('option', { value: 'no', text: 'no' })
        ]);
      } else if (def.type === 'textarea') {
        input = el('textarea', { class: 'field-input support-textarea', rows: '4', maxlength: String(def.maxLength) });
      } else {
        input = el('input', { type: 'text', class: 'field-input', maxlength: String(def.maxLength) });
      }
      input.value = data.settings[def.key] ?? '';
      input.id = `setting-${def.key}`;
      inputs[def.key] = input;

      return el('div', { class: 'support-field' }, [
        el('label', { for: input.id, text: def.label }),
        input,
        el('div', { class: 'hint-text', text: def.hint })
      ]);
    });

    const saveBtn = el('button', { class: 'btn btn-primary', text: 'Save settings' });
    saveBtn.addEventListener('click', async () => {
      const changed = {};
      Object.entries(inputs).forEach(([key, input]) => {
        if (input.value.trim() !== String(data.settings[key] ?? '').trim()) changed[key] = input.value;
      });
      if (!Object.keys(changed).length) {
        showToast('info', 'Nothing has changed.');
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await api('/api/support/settings', { method: 'POST', body: { settings: changed } });
        showToast('success', `Saved ${Object.keys(changed).length} setting(s). The bot uses them within a minute.`);
        await loadSettings();
      } catch (err) {
        showToast('error', err.message, 9000);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save settings';
      }
    });

    replaceChildren(host, panel(
      'Bot Settings',
      `Stored in the "Bot Settings" tab of ${data.context.primaryGroupName}'s sheet. ` +
        'Admins in the support chat can also change these with /set.',
      el('div', { style: 'display:grid;gap:16px' }, [
        el('div', { class: 'support-fields' }, fields),
        el('div', { class: 'support-actions end' }, [saveBtn])
      ])
    ));
  } catch (err) {
    replaceChildren(host, panel('Bot Settings', null, emptyState('⚠️', 'Could not load bot settings.', err.message)));
  }
}

async function loadAll() {
  $('refreshBtn').disabled = true;
  try {
    // Settings first: they carry the category labels the ticket table shows.
    await loadSettings();
    await Promise.all([loadTickets(), openTicketId ? openTicket(openTicketId) : null]);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

initDashboard({
  page: 'support',
  onReady: async () => {
    if (!getSelectedGroup()) return;
    $('refreshBtn').addEventListener('click', loadAll);
    await loadAll();
  }
});
