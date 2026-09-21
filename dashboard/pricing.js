// ============================================================================
// Pass & Coupons dashboard (dashboard/pricing.js)
// ============================================================================
// The one pass on sale (name, price, valid-until date, description) and the
// coupon codes that discount it. Both belong to a payment bot, so the two
// languages of a family always share them.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, panel, statCard, emptyState, pill, num, showToast, getSelectedGroup, $
} from './shared.js';

/** Latest /api/pricing payload. */
let data = null;

const STATE = {
  live: { label: 'Live', tone: 'ok', help: 'Students can use it now.' },
  off: { label: 'Switched off', tone: 'muted', help: 'Turned off by an admin.' },
  expired: { label: 'Expired', tone: 'danger', help: 'Its expiry date has passed.' },
  used_up: { label: 'Used up', tone: 'warn', help: 'It reached its maximum number of uses.' }
};

/** dd-mm-yyyy → yyyy-mm-dd for a date input, and back. */
const toInputDate = (text) => {
  const m = String(text || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};
const fromInputDate = (value) => {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
};

const rupees = (n) => '₹' + (Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2));

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

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

function renderPass() {
  const pass = data.pass;
  if (!pass) {
    replaceChildren($('passPanel'), panel('The pass on sale', null,
      emptyState('⚠️', 'This group sells no pass.', 'Check groups.config.json.')));
    return;
  }
  const defaults = pass.defaults;
  const stored = data.passSettings;

  const name = el('input', { id: 'passName', type: 'text', class: 'field-input', maxlength: '80', placeholder: defaults.name });
  name.value = stored.name;
  const price = el('input', { id: 'passPrice', type: 'number', class: 'field-input', min: '1', step: '1', inputmode: 'numeric', placeholder: String(defaults.price) });
  price.value = stored.price;
  const validUntil = el('input', { id: 'passValidUntil', type: 'date', class: 'field-input' });
  validUntil.value = toInputDate(stored.validUntil);
  const description = el('textarea', { id: 'passDescription', class: 'field-input support-textarea', rows: '2', maxlength: '300', placeholder: defaults.description });
  description.value = stored.description;

  const preview = el('div', { class: 'pc-preview', 'aria-live': 'polite' });
  const renderPreview = () => {
    const shownName = name.value.trim() || defaults.name;
    const shownPrice = price.value.trim() || defaults.price;
    const shownDate = fromInputDate(validUntil.value) || defaults.validUntil;
    replaceChildren(preview,
      el('div', { class: 'pc-preview-label', text: 'Students see' }),
      el('div', { class: 'pc-preview-name', text: `🎯 ${shownName}` }),
      el('div', { class: 'hint-text', text: description.value.trim() || defaults.description }),
      el('div', { class: 'pc-preview-facts' }, [
        stored.lifetime
          ? el('span', { text: '♾️ Lifetime access — pay once, never renew' })
          : (shownDate ? el('span', { text: `📅 Valid until ${shownDate}` }) : el('span', { class: 'pc-warn', text: '⚠️ No valid-until date set' })),
        el('span', { class: 'pc-price', text: `💰 ${rupees(shownPrice)}` })
      ])
    );
  };
  [name, price, validUntil, description].forEach((input) => input.addEventListener('input', renderPreview));
  renderPreview();

  const save = el('button', { class: 'btn btn-primary', text: 'Save pass' });
  save.addEventListener('click', () => busy(save, 'Saving…', async () => {
    try {
      const result = await api('/api/pricing/pass', {
        method: 'POST',
        body: {
          name: name.value, price: price.value,
          validUntil: stored.lifetime ? '' : fromInputDate(validUntil.value),
          description: description.value
        }
      });
      showToast('success', `Saved. Students now see ${result.pass.name} at ${result.pass.priceText}.`, 7000);
      await load();
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  replaceChildren($('passPanel'), panel(
    '🎯 The pass on sale',
    'One pass per bot. Leave a field empty to use the built-in value shown in grey.',
    el('div', { class: 'pc-pass' }, [
      el('div', { class: 'support-fields' }, [
        field('Pass name (the exam it is for)', name, `e.g. "Target APPSC Group 2 – 2026". Built-in: ${defaults.name}`),
        field('Price in rupees', price, `Whole rupees. Built-in: ₹${defaults.price}`),
        // A lifetime pass has no end date, so there is no box to fill in —
        // offering one that is silently ignored is worse than not offering it.
        stored.lifetime
          ? field('Access', el('div', { class: 'hint-text', text: '♾️ Lifetime — students pay once and keep access for good. There is no end date to set.' }), '')
          : field('Valid until', validUntil, `Access ends at the end of this day. Built-in: ${defaults.validUntil || 'not set'}`),
        field('Description', description, 'One or two lines shown with the price.')
      ]),
      preview,
      el('p', { class: 'hint-text', text: 'Payment links already sent keep the price and date they were created with. Students who already bought keep their current expiry.' }),
      el('div', { class: 'support-actions end' }, [save])
    ])
  ));
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

function couponForm(existing) {
  const editing = Boolean(existing);
  const c = existing || { code: '', discount_type: 'flat', discount_value: '', active: true, expires_on: '', max_uses: '', one_per_student: true, note: '' };
  const basePrice = data.pass ? data.pass.price : 199;

  const code = el('input', { id: 'couponCode', type: 'text', class: 'field-input pc-code-input', maxlength: '20', placeholder: 'e.g. DIWALI50', autocomplete: 'off', spellcheck: 'false' });
  code.value = c.code;
  if (editing) code.disabled = true;
  code.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/\s+/g, ''); });

  const type = el('select', { id: 'couponType', class: 'field-select' }, [
    el('option', { value: 'flat', text: '₹ off (fixed amount)' }),
    el('option', { value: 'percent', text: '% off (percentage)' })
  ]);
  type.value = c.discount_type;

  const value = el('input', { id: 'couponValue', type: 'number', class: 'field-input', min: '1', step: '1', inputmode: 'numeric' });
  value.value = c.discount_value;

  const expires = el('input', { id: 'couponExpires', type: 'date', class: 'field-input' });
  expires.value = toInputDate(c.expires_on);

  const maxUses = el('input', { id: 'couponMax', type: 'number', class: 'field-input', min: '1', step: '1', inputmode: 'numeric', placeholder: 'Unlimited' });
  maxUses.value = c.max_uses === null || c.max_uses === undefined ? '' : c.max_uses;

  const once = el('input', { id: 'couponOnce', type: 'checkbox' });
  once.checked = c.one_per_student !== false;
  const active = el('input', { id: 'couponActive', type: 'checkbox' });
  active.checked = c.active !== false;

  const note = el('input', { id: 'couponNote', type: 'text', class: 'field-input', maxlength: '500', placeholder: 'Only admins see this' });
  note.value = c.note || '';

  const preview = el('div', { class: 'pc-coupon-preview', 'aria-live': 'polite' });
  const renderPreview = () => {
    const v = Number(value.value);
    if (!v) {
      replaceChildren(preview, el('span', { class: 'hint-text', text: `Enter a discount to see what students pay (pass price ${rupees(basePrice)}).` }));
      return;
    }
    const discount = type.value === 'percent' ? Math.round(basePrice * v) / 100 : v;
    const final = Math.round((basePrice - discount) * 100) / 100;
    replaceChildren(preview, final < 1
      ? el('span', { class: 'pc-warn', text: `⚠️ This takes ${rupees(discount)} off a ${rupees(basePrice)} pass — the price must stay at least ₹1.` })
      : el('span', {}, [el('s', { text: rupees(basePrice) }), ' → ', el('strong', { text: rupees(final) }), el('span', { class: 'hint-text', text: `  (students save ${rupees(discount)})` })]));
  };
  [type, value].forEach((input) => input.addEventListener('input', renderPreview));
  renderPreview();

  const save = el('button', { class: 'btn btn-primary', text: editing ? 'Save changes' : 'Create coupon' });
  const cancel = el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => replaceChildren($('couponFormHost')) });
  save.addEventListener('click', () => busy(save, 'Saving…', async () => {
    try {
      await api('/api/pricing/coupon', {
        method: 'POST',
        body: {
          mode: editing ? 'edit' : 'create',
          coupon: {
            code: code.value, discount_type: type.value, discount_value: value.value,
            expires_on: fromInputDate(expires.value), max_uses: maxUses.value,
            one_per_student: once.checked, active: active.checked, note: note.value
          }
        }
      });
      showToast('success', editing ? `${c.code} updated.` : `${code.value} created.`);
      await load();
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  return el('div', { class: 'pc-form' }, [
    el('h3', { class: 'sp-box-title', text: editing ? `Edit ${c.code}` : 'New coupon code' }),
    el('div', { class: 'support-fields' }, [
      field('Code', code, editing ? 'A code cannot be renamed. Create a new one instead.' : '3–20 letters or numbers, no spaces. Students type this.'),
      field('Discount type', type),
      field('Discount amount', value, 'A number: rupees for "₹ off", percent for "% off" (1–99). The price must stay at least ₹1.'),
      field('Expires on (optional)', expires, 'Works until the end of this day. Empty = never expires.'),
      field('Maximum uses (optional)', maxUses, 'Counted only when a payment succeeds. Empty = unlimited.'),
      field('Internal note (optional)', note)
    ]),
    el('div', { class: 'pc-checks' }, [
      el('label', { class: 'sp-check', for: 'couponOnce' }, [once, el('span', { text: 'Each student can use it only once' })]),
      el('label', { class: 'sp-check', for: 'couponActive' }, [active, el('span', { text: 'Active (students can use it)' })])
    ]),
    preview,
    el('div', { class: 'support-actions end' }, [cancel, save])
  ]);
}

function couponRow(c) {
  const state = STATE[c.state] || { label: c.state, tone: 'muted', help: '' };

  const edit = el('button', { class: 'btn btn-ghost btn-sm', text: 'Edit', onclick: () => {
    replaceChildren($('couponFormHost'), couponForm(c));
    $('couponFormHost').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } });

  const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: c.active ? 'Switch off' : 'Switch on' });
  toggle.addEventListener('click', () => busy(toggle, '…', async () => {
    try {
      await api('/api/pricing/coupon', {
        method: 'POST',
        body: { mode: 'edit', coupon: Object.assign({}, c, { active: !c.active, max_uses: c.max_uses === null ? '' : c.max_uses }) }
      });
      showToast('success', `${c.code} ${c.active ? 'switched off' : 'switched on'}.`);
      await load();
    } catch (err) {
      showToast('error', err.message, 9000);
    }
  }));

  const remove = el('button', { class: 'btn btn-ghost btn-sm', text: 'Delete' });
  remove.addEventListener('click', () => {
    if (!window.confirm(`Delete ${c.code}? This cannot be undone.`)) return;
    busy(remove, '…', async () => {
      try {
        await api('/api/pricing/coupon/delete', { method: 'POST', body: { code: c.code } });
        showToast('success', `${c.code} deleted.`);
        await load();
      } catch (err) {
        showToast('warn', err.message, 9000);
      }
    });
  });

  return el('tr', {}, [
    el('td', {}, [
      el('div', { class: 'pc-code', text: c.code }),
      c.note ? el('div', { class: 'muted', style: 'font-size:0.75rem;margin-top:2px', text: c.note }) : null
    ]),
    el('td', { text: c.discountText }),
    el('td', {}, [pill(state.label, state.tone)]),
    el('td', { class: 'num', text: c.max_uses ? `${num(c.times_used)} / ${num(c.max_uses)}` : num(c.times_used) }),
    el('td', { class: 'muted', text: c.expires_on || 'Never' }),
    el('td', { class: 'muted', text: c.one_per_student ? 'Once each' : 'Any number' }),
    el('td', {}, [el('div', { class: 'pc-row-actions' }, [edit, toggle, c.times_used ? null : remove])])
  ]);
}

function renderCoupons() {
  const coupons = data.coupons || [];
  const redemptions = (data.redemptions && data.redemptions.redemptions) || [];
  const live = coupons.filter((c) => c.state === 'live').length;
  const used = coupons.reduce((sum, c) => sum + (Number(c.times_used) || 0), 0);
  const saved = redemptions.reduce((sum, r) => sum + (Number(r.discount) || 0), 0);

  const newButton = el('button', { class: 'btn btn-primary', text: '+ New coupon', onclick: () => {
    replaceChildren($('couponFormHost'), couponForm(null));
    $('couponCode').focus();
  } });

  const table = coupons.length
    ? el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['Code', 'Discount', 'Status', 'Used', 'Expires', 'Per student', '']
          .map((h) => el('th', { text: h })))]),
        el('tbody', {}, coupons.map(couponRow))
      ])
    ])
    : emptyState('🎟', 'No coupon codes yet.', 'Create one — students apply it with "🎟 Apply coupon code" in /plans.');

  replaceChildren($('couponPanel'),
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel-head' }, [
        el('div', {}, [
          el('h2', { class: 'panel-title', text: '🎟 Coupon codes' }),
          el('p', { class: 'panel-subtitle', text: 'A use is counted only when the payment succeeds. Codes that have been used cannot be deleted — switch them off instead.' })
        ]),
        newButton
      ]),
      el('div', { class: 'panel-body' }, [
        el('div', { class: 'stat-grid' }, [
          statCard('Live codes', num(live), { tone: 'ok', sub: 'usable right now' }),
          statCard('Times used', num(used), { tone: 'info', sub: 'successful payments' }),
          statCard('Discount given', rupees(saved), { tone: 'warn', sub: `across the last ${num(redemptions.length)} uses` })
        ]),
        el('div', { id: 'couponFormHost' })
      ]),
      el('div', { class: 'panel-body tight' }, [table])
    ]));
}

function renderRedemptions() {
  const rows = (data.redemptions && data.redemptions.redemptions) || [];
  const body = rows.length
    ? el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table' }, [
        el('thead', {}, [el('tr', {}, ['When', 'Code', 'Student', 'Group', 'Paid', 'Saved', 'Payment']
          .map((h) => el('th', { text: h })))]),
        el('tbody', {}, rows.map((r) => el('tr', {}, [
          el('td', { class: 'muted', style: 'font-size:0.8rem', text: r.at }),
          el('td', { class: 'pc-code', text: r.code }),
          el('td', { text: r.username ? '@' + r.username : r.telegram_id }),
          el('td', { text: r.group }),
          el('td', { class: 'num', text: rupees(r.paid_amount) }),
          el('td', { class: 'num', text: rupees(r.discount) }),
          el('td', { class: 'muted', style: 'font-size:0.78rem', text: r.payment_id })
        ])))
      ])
    ])
    : emptyState('🧾', 'No coupon has been used yet.');
  replaceChildren($('redemptionPanel'), panel('🧾 Recent coupon uses', 'Newest first, from the Coupon Redemptions tab', body));
}

function renderNotices(context) {
  replaceChildren($('notices'), context && !context.isPrimary
    ? el('div', { class: 'sp-notices' }, [el('div', { class: 'banner tone-info' }, [
      el('div', { class: 'banner-body' }, [
        el('strong', { text: 'Shared bot. ' }),
        el('span', { text: `This group uses the same payment bot as ${context.primaryGroupName}. The pass and coupons below apply to both.` })
      ])
    ])])
    : null);
}

async function load() {
  $('refreshBtn').disabled = true;
  replaceChildren($('passPanel'), el('div', { class: 'loading-row' }, [el('div', { class: 'spinner' }), el('span', { text: 'Loading the pass and coupons…' })]));
  try {
    data = await api('/api/pricing');
    renderNotices(data.context);
    renderPass();
    renderCoupons();
    renderRedemptions();
  } catch (err) {
    replaceChildren($('passPanel'), emptyState('⚠️', 'Could not load the pass and coupons.', err.message));
    showToast('error', err.message, 9000);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

initDashboard({
  page: 'pricing',
  onReady: async () => {
    if (!getSelectedGroup()) return;
    $('refreshBtn').addEventListener('click', load);
    await load();
  }
});
