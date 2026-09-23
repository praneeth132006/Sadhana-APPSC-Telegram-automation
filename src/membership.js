// ============================================================================
// Membership lifecycle (src/membership.js)
// ============================================================================
// Everything that happens between "a student paid" and "a student is in the
// group", plus the daily job that reminds and removes people.
//
// The one rule this file exists to enforce: access is granted from the
// PAYMENT, never from anything the student's browser or Telegram client says.
// A webhook whose signature checked out, carrying a Telegram id Razorpay
// echoed back from our own `notes`, is the only thing that opens the door.
// ============================================================================

const sheets = require('./sheets');
const paybot = require('./paybot');
const groups = require('./groups');
const plans = require('./plans');
const pricing = require('./pricing');

/** Escapes text for a Telegram HTML message. Pass names are admin-edited. */
function esc(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * contextFor — everything one group needs for a membership operation.
 *
 * Which chat to invite into, which bot does the inviting, and which sheet
 * records it. Resolving all three together means a group can never be invited
 * into with one family's bot while its members are recorded in another's
 * sheet — the three have to agree, so they are fetched as one.
 *
 * @param {string} groupId
 * @returns {{groupId: string, label: string, chatId: string, botEnv: string, sheet: Object}}
 */
function contextFor(groupId) {
  const group = groups.requireGroup(groupId);
  if (!group.telegramGroupId) {
    throw new Error(`No Telegram group configured for ${group.displayName}.`);
  }
  return {
    groupId: group.id,
    label: group.displayName,
    chatId: group.telegramGroupId,
    botEnv: group.paymentBotEnv,
    sheet: sheets.forGroup(group.id)
  };
}

/** The chat id paying members of one group join. */
function getPremiumGroupId(groupId) {
  return groups.requireGroup(groupId).telegramGroupId;
}

function formatIst(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).formatToParts(date);

  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  const meridiem = get('dayPeriod').toUpperCase();

  return `${get('day')}-${get('month')}-${get('year')}, ` +
         `${get('hour')}:${get('minute')}:${get('second')} ${meridiem} IST`;
}

/** India is UTC+05:30 all year — no daylight saving — so one constant is exact. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * parseIst — reads back a timestamp this project wrote.
 *
 * The text is an IST wall-clock reading, so it must be interpreted as IST no
 * matter where the process runs. This used to build the Date from local parts
 * (`new Date(y, m, d, h, ...)`), which is only correct on a machine already set
 * to Asia/Kolkata. On Vercel, which runs in UTC, every expiry read back 5 hours
 * 30 minutes later than it was written: reminders fired late, lapsed members
 * kept access for an extra evening, and the 5-minute test pass never expired
 * inside the window it was meant to be watched in.
 *
 * @param {string} value
 * @returns {Date|null}
 */
function parseIst(value) {
  const text = String(value || '').trim();
  if (!text || text === '-') return null;

  const match = text.match(/^(\d{2})-(\d{2})-(\d{4})(?:,\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM))?/i);
  if (!match) return null;

  let hour = match[4] ? Number(match[4]) : 23;
  const minute = match[5] ? Number(match[5]) : 59;
  const second = match[6] ? Number(match[6]) : 59;

  if (match[7]) {
    const meridiem = match[7].toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
  }

  // Build the instant in UTC from the IST reading, then step back by the
  // offset, so the result is the same moment regardless of the server's TZ.
  const utcMs = Date.UTC(
    Number(match[3]), Number(match[2]) - 1, Number(match[1]), hour, minute, second
  );
  const date = new Date(utcMs - IST_OFFSET_MS);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * isEligible — may this Telegram id be in the premium group right now?
 *
 * The single source of truth for admission. A join request, a manual add and
 * a rejoin after payment all ask this same question, so there is one place
 * that decides and one place to change if the rule changes.
 *
 * @param {string|number} telegramId
 * @returns {Promise<{ok: boolean, reason: string, subscriber: Object|null}>}
 */
async function isEligible(groupId, telegramId) {
  const ctx = contextFor(groupId);
  const subscriber = await ctx.sheet.getSubscriber(telegramId);
  if (!subscriber) return { ok: false, reason: 'no subscription on record', subscriber: null };
  // A free preview is a real, time-limited membership: it is let in the same
  // way, and the expiry check below is what ends it.
  if (subscriber.status !== 'active' && subscriber.status !== 'trial') {
    return { ok: false, reason: `subscription is ${subscriber.status}`, subscriber };
  }

  // No readable expiry means we cannot say the pass is still valid, and this is
  // the single check standing between a stranger and a paid group. It used to
  // fall through to "eligible" when parseIst returned null, so one blank or
  // hand-mangled expiry cell granted access that never ended and that the
  // nightly sweep also could not see, because it skips rows it cannot read.
  // Refusing is recoverable — the member messages an admin — where admitting
  // for ever is not.
  const expiry = parseIst(subscriber.expiry_date);
  if (!expiry) {
    return {
      ok: false,
      reason: `expiry date "${subscriber.expiry_date || '(blank)'}" could not be read`,
      subscriber
    };
  }
  if (expiry.getTime() <= Date.now()) {
    return { ok: false, reason: 'subscription has expired', subscriber };
  }
  return { ok: true, reason: 'active subscription', subscriber };
}

/**
 * handleJoinRequest — approve the buyer, turn away everyone else.
 *
 * This is what makes a forwarded invite worthless. The link no longer admits
 * whoever holds it; Telegram tells us who is asking, and only an id with a
 * live subscription gets in.
 *
 * @param {string|number} telegramId The account asking to join
 * @returns {Promise<{approved: boolean, reason: string}>}
 */
async function handleJoinRequest(groupId, telegramId) {
  const ctx = contextFor(groupId);
  const verdict = await isEligible(groupId, telegramId);

  try {
    if (verdict.ok) {
      await paybot.approveJoinRequest(ctx.botEnv, ctx.chatId, telegramId);
      // A preview reads; it does not post. Best effort: being let in matters
      // more than being muted, and the preview ends either way.
      if (verdict.subscriber && verdict.subscriber.status === 'trial') {
        const until = parseIst(verdict.subscriber.expiry_date);
        try {
          await paybot.readOnlyMember(ctx.botEnv, ctx.chatId, telegramId,
            until ? until.getTime() / 1000 + 60 : undefined);
        } catch (err) {
          console.error(`[membership] could not mute the preview for ${telegramId}: ${err.message}`);
        }
      }
      return {
        approved: true,
        reason: verdict.reason,
        trial: Boolean(verdict.subscriber && verdict.subscriber.status === 'trial'),
        // For the welcome: tapping their own invite link once inside opens the group.
        inviteLink: (verdict.subscriber && verdict.subscriber.invite_link) || '',
        expiry: (verdict.subscriber && verdict.subscriber.expiry_date) || ''
      };
    }
    await paybot.declineJoinRequest(ctx.botEnv, ctx.chatId, telegramId);
    return { approved: false, reason: verdict.reason };
  } catch (err) {
    // A request already handled, or withdrawn, is not worth failing over.
    console.error(`[membership] join request for ${telegramId} failed: ${err.message}`);
    return { approved: false, reason: err.message };
  }
}

/**
 * enforceMembership — removes someone who is in the group without paying.
 *
 * A safety net behind handleJoinRequest, for the ways into a group that do not
 * go through a join request at all: an admin adding a friend by hand, or a
 * link minted in the Telegram client rather than by this code.
 *
 * @param {string|number} telegramId Whoever just appeared in the group
 * @returns {Promise<{removed: boolean, reason: string}>}
 */
async function enforceMembership(groupId, telegramId) {
  const verdict = await isEligible(groupId, telegramId);
  if (verdict.ok) return { removed: false, reason: verdict.reason };

  const removed = await removeMember(groupId, telegramId);
  return { removed, reason: verdict.reason };
}

/**
 * createSingleUseInvite — a private invite link only one person can use.
 *
 * member_limit 1 means the link dies the moment it is used, so a student who
 * forwards it to a friend gives away their own seat rather than creating a
 * second free one. It also expires on its own if never used.
 *
 * @param {string|number} telegramId Who it is for, used only for the link name
 * @returns {Promise<string>} The invite URL
 */
async function createSingleUseInvite(groupId, telegramId) {
  const ctx = contextFor(groupId);
  return paybot.createJoinRequestInvite(ctx.botEnv, ctx.chatId, telegramId);
}

/**
 * resendInvite — a fresh invite for someone who already holds an active pass.
 *
 * For the student who paid and says the link never arrived, expired, or was
 * used up. Nothing is extended and nothing is charged: only the invite changes.
 * The join request it produces is still checked against the pass, so a link
 * sent to the wrong person lets nobody in.
 *
 * @param {string} groupId
 * @param {string|number} telegramId
 * @returns {Promise<{sent: boolean, inviteLink?: string, reason?: string, subscriber: Object|null}>}
 *   sent is false, with the reason, when the student could not use an invite
 */
async function resendInvite(groupId, telegramId) {
  const ctx = contextFor(groupId);
  // The same test the join request will apply, so a link is never sent that
  // would only be declined when it is used.
  const verdict = await isEligible(groupId, telegramId);
  const subscriber = verdict.subscriber;
  if (!verdict.ok) return { sent: false, reason: verdict.reason, subscriber };

  const inviteLink = await createSingleUseInvite(groupId, telegramId);
  try {
    await ctx.sheet.upsertSubscriber({
      telegram_id: String(telegramId),
      invite_link: inviteLink,
      is_payment: false
    }, 'invite.resent');
  } catch (err) {
    // The link works whether or not the sheet remembers it.
    console.error(`[membership] ${groupId}: could not record the resent invite for ${telegramId}: ${err.message}`);
  }
  return { sent: true, inviteLink, subscriber };
}

/**
 * grantAccess — the single path from a verified payment to group membership.
 *
 * Idempotent by design: Razorpay retries webhooks, and a duplicate delivery
 * must not double-charge the ledger or extend the expiry twice. A payment id
 * already recorded against the member is treated as already handled.
 *
 * @param {Object} options
 * @param {string|number} options.telegramId Buyer, from Razorpay notes
 * @param {string} options.planId Plan id, from Razorpay notes
 * @param {string} options.paymentId Razorpay payment id
 * @param {number} options.amountPaise Amount actually captured
 * @param {string} [options.username] Telegram @handle
 * @param {string} [options.name] Display name
 * @param {string} [options.linkId] Payment link id
 * @param {string} [options.subscriptionId] Subscription id, recurring only
 * @param {string} [options.event] Label for the payment log
 * @returns {Promise<Object>} { subscriber, inviteLink, alreadyProcessed }
 */
async function grantAccess(options) {
  const {
    groupId, telegramId, planId, paymentId, amountPaise,
    username, name, linkId, subscriptionId, event, validUntil, planLabel
  } = options;

  const ctx = contextFor(groupId);
  const plan = groups.getPlanFor(groupId, planId);
  if (!plan) throw new Error(`Unknown plan "${planId}"`);
  if (!telegramId) throw new Error('grantAccess requires a telegramId');

  const existing = await ctx.sheet.getSubscriber(telegramId);

  // Razorpay retries on any non-2xx, so the same payment can arrive twice.
  if (existing && paymentId && existing.payment_id === paymentId) {
    return { subscriber: existing, inviteLink: existing.invite_link, alreadyProcessed: true };
  }

  // A renewal extends from the current expiry, so paying early never costs days.
  const currentExpiry = existing ? parseIst(existing.expiry_date) : null;
  // The pass's end date as the student was shown it at checkout, carried in
  // the link's notes. A date already past would grant nothing, so it is only
  // used when it is still ahead.
  const promised = validUntil ? pricing.endOfDayIst(validUntil) : null;
  const expiry = promised && promised.getTime() > Date.now()
    ? promised
    : plans.computeExpiry(plan, new Date(), currentExpiry);

  // Reuse a still-valid invite rather than minting a second live link.
  let inviteLink = existing && existing.invite_link ? existing.invite_link : '';
  const isRejoining = !existing || existing.status !== 'active';
  if (!inviteLink || isRejoining) {
    try {
      inviteLink = await createSingleUseInvite(groupId, telegramId);
    } catch (err) {
      // The payment is real even if Telegram is briefly unreachable. Record it
      // and let the student retry with /status rather than losing the sale.
      console.error('[membership] could not create invite link:', err.message);
      inviteLink = existing ? existing.invite_link : '';
    }
  }

  const subscriber = await ctx.sheet.upsertSubscriber({
    telegram_id: String(telegramId),
    username: username || (existing ? existing.username : ''),
    name: name || (existing ? existing.name : ''),
    plan: plan.id,
    plan_label: String(planLabel || '').trim() || plan.label,
    status: 'active',
    start_date: existing && existing.start_date ? existing.start_date : formatIst(new Date()),
    expiry_date: formatIst(expiry),
    amount: (Number(amountPaise) || plan.amountPaise) / 100,
    payment_id: paymentId || '',
    link_id: linkId || '',
    subscription_id: subscriptionId || (existing ? existing.subscription_id : ''),
    invite_link: inviteLink,
    // A fresh expiry invalidates any reminder already sent.
    reminder_sent: '',
    is_payment: true
  }, event || 'payment.captured');

  // isRejoining tells the caller whether this person needs an invite at all.
  // A renewal by someone already sitting in the group does not, and sending a
  // fresh link every month would train members to expect one and to share it.
  return { subscriber, inviteLink, alreadyProcessed: false, expiry, isRejoining };
}

// ---------------------------------------------------------------------------
// The free preview
// ---------------------------------------------------------------------------
// A newcomer sees the group for a few minutes, read-only, before being asked
// for money — the bot proves what it is selling instead of demanding payment
// on the first screen. One per person per group, ever: the Subscribers row it
// writes is what says they have had theirs.

/** The plan id a preview is recorded under, and its label in the sheet. */
const TRIAL_PLAN_ID = 'trial';
const TRIAL_PLAN_LABEL = 'Free preview';

/**
 * startTrial — gives someone their one free preview of a group.
 *
 * @param {string} groupId
 * @param {Object} user Telegram user
 * @param {number} minutes How long it lasts
 * @returns {Promise<{ok: boolean, reason?: string, inviteLink?: string, expiry?: Date, subscriber?: Object}>}
 */
async function startTrial(groupId, user, minutes) {
  const ctx = contextFor(groupId);
  const existing = await ctx.sheet.getSubscriber(user.id);
  if (existing) {
    // Anyone with a row has either had their preview or bought the pass.
    const reason = existing.status === 'active' ? 'already a member'
      : existing.plan === TRIAL_PLAN_ID ? 'preview already used' : 'was a member before';
    return { ok: false, reason, subscriber: existing };
  }

  const now = new Date();
  const expiry = new Date(now.getTime() + Math.max(1, Number(minutes) || 10) * 60 * 1000);
  // The invite is made first: a row saying they are in a group they never got
  // into would cost them their one preview for nothing.
  const inviteLink = await createSingleUseInvite(groupId, user.id);
  const subscriber = await ctx.sheet.upsertSubscriber({
    telegram_id: String(user.id),
    username: user.username || '',
    name: [user.first_name, user.last_name].filter(Boolean).join(' '),
    plan: TRIAL_PLAN_ID,
    plan_label: TRIAL_PLAN_LABEL,
    status: 'trial',
    start_date: formatIst(now),
    expiry_date: formatIst(expiry),
    amount: 0,
    invite_link: inviteLink,
    reminder_sent: '',
    notes: `Free preview of ${minutes} minute(s)`,
    is_payment: false
  }, 'trial.started');
  return { ok: true, inviteLink, expiry, subscriber };
}

/** Marks a preview as warned, so nobody is told twice. */
async function markTrialWarned(groupId, subscriber) {
  return contextFor(groupId).sheet.upsertSubscriber({
    telegram_id: subscriber.telegram_id,
    reminder_sent: 'warned',
    is_payment: false
  }, 'trial.warned');
}

/**
 * endTrial — the preview is over: out of the group, and the row says so, so
 * the same person is never given a second one.
 */
async function endTrial(groupId, subscriber) {
  const removed = await removeMember(groupId, subscriber.telegram_id);
  await contextFor(groupId).sheet.upsertSubscriber({
    telegram_id: subscriber.telegram_id,
    status: 'trial_expired',
    invite_link: '',
    notes: `Free preview ended ${formatIst(new Date())}`,
    is_payment: false
  }, 'trial.ended');
  return removed;
}

/**
 * removeMember — kicks someone from the premium group.
 *
 * Uses ban-then-unban: an outright ban would stop them rejoining after they
 * pay again, which is the opposite of what a lapsed subscriber needs.
 *
 * @param {string|number} telegramId
 * @returns {Promise<boolean>} Whether Telegram accepted the removal
 */
async function removeMember(groupId, telegramId) {
  const ctx = contextFor(groupId);

  try {
    await paybot.removeFromChat(ctx.botEnv, ctx.chatId, telegramId);
    return true;
  } catch (err) {
    // Already gone, or never joined — not a failure worth stopping the run for.
    console.error(`[membership] could not remove ${telegramId}: ${err.message}`);
    return false;
  }
}

/**
 * markExpired — flips a member to expired without touching the money columns.
 *
 * @param {Object} subscriber The stored member
 * @param {boolean} removed Whether they were actually removed from the group
 */
async function markExpired(groupId, subscriber, removed) {
  return contextFor(groupId).sheet.upsertSubscriber({
    telegram_id: subscriber.telegram_id,
    status: removed ? 'removed' : 'expired',
    // Clear the invite so a lapsed member cannot rejoin on an old link.
    invite_link: '',
    notes: `Access ended ${formatIst(new Date())}`,
    is_payment: false
  }, 'expired');
}

/**
 * planForSubscriber — the pass a member holds, as THEIR group defines it.
 *
 * plans.getPlan() is the legacy global table: same wording for everyone, so a
 * UPSC member was reminded about their "Target APPSC 2026 Pass". Falls back to
 * the global entry only for a plan id the group no longer sells, so a member on
 * a retired pass still gets a sensible label rather than none.
 *
 * @param {string} groupId
 * @param {string} planId
 * @returns {Object|null}
 */
function planForSubscriber(groupId, planId) {
  if (!planId) return null;
  return groups.getPlanFor(groupId, planId) || plans.getPlan(planId);
}

/**
 * isLifetimeSubscriber — did this member buy a pass that never ends?
 *
 * Read from the plan they bought, never from the group they are in. A member
 * who bought the exam pass in a newspaper group before it went lifetime still
 * holds an exam pass; they are not upgraded for free by the group changing.
 */
function isLifetimeSubscriber(subscriber) {
  if (!subscriber || !subscriber.plan) return false;
  const shapes = groups.planShapes ? groups.planShapes() : null;
  if (shapes && shapes[subscriber.plan]) return plans.isLifetimePlan(shapes[subscriber.plan]);
  return String(subscriber.plan) === 'lifetime_pass';
}

/**
 * sendRenewalReminder — nudges a member whose access is about to end.
 *
 * @param {Object} subscriber The stored member
 * @param {number} daysLeft Days until expiry
 */
async function sendRenewalReminder(groupId, subscriber, daysLeft) {
  const ctx = contextFor(groupId);

  const plan = planForSubscriber(groupId, subscriber.plan);
  // The name the student bought it under, which an admin may have changed since.
  const label = subscriber.plan_label || (plan ? plan.label : 'your pass');
  const when = daysLeft <= 0
    ? 'today'
    : daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;

  const message =
    `⏳ <b>Your ${esc(label)} expires ${when}.</b>\n\n` +
    `Renew to keep your access to the APPSC premium group and daily quizzes.\n\n` +
    `Send /plans to this bot to renew in a couple of taps.`;

  await paybot.sendDirectMessage(ctx.botEnv, subscriber.telegram_id, message);

  // Record which expiry this reminder was for, so a renewal (new expiry) makes
  // the member eligible for a reminder again, but today's is not repeated.
  await ctx.sheet.upsertSubscriber({
    telegram_id: subscriber.telegram_id,
    reminder_sent: subscriber.expiry_date,
    is_payment: false
  }, 'reminder');
}

/**
 * runDailyCheck — the daily job: remind whoever is close to expiry, remove
 * whoever is past it.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun] Report what would happen, change nothing
 * @returns {Promise<Object>} Summary of the run
 */
async function runDailyCheck({ groupId, dryRun = false } = {}) {
  const ctx = contextFor(groupId);
  const summary = { checked: 0, reminded: [], removed: [], failed: [], dryRun };

  // Widest reminder window of any pass THIS group sells, so one query covers
  // every case without reaching for the legacy global table.
  const lookAhead = Math.max(
    ...groups.plansFor(groupId).map((p) => p.reminderDaysBefore || 0), 0
  );
  const candidates = await ctx.sheet.getExpiring(lookAhead);
  summary.checked = candidates.length;

  for (const subscriber of candidates) {
    const expiry = parseIst(subscriber.expiry_date);
    if (!expiry) {
      summary.failed.push({ telegram_id: subscriber.telegram_id, reason: 'unreadable expiry date' });
      continue;
    }

    const daysLeft = plans.daysUntil(expiry);
    const plan = planForSubscriber(groupId, subscriber.plan);

    // A lifetime member is never reminded and never removed. Their expiry is
    // set decades out, so the date alone would already keep them safe — but
    // this is the one sweep that takes paying students out of the group, and
    // "they paid for life" should be a rule it reads, not an accident of
    // arithmetic that a mistyped date could undo.
    if (plans.isLifetimePlan(plan)) continue;

    try {
      if (daysLeft <= 0) {
        // Past expiry: remove from the group and mark the row.
        if (!dryRun) {
          const removed = await removeMember(groupId, subscriber.telegram_id);
          await markExpired(groupId, subscriber, removed);
          try {
            await paybot.sendDirectMessage(ctx.botEnv,
              subscriber.telegram_id,
              `Your <b>${esc(subscriber.plan_label || 'pass')}</b> has expired and your group access has ended.\n\n` +
              `Send /plans to rejoin whenever you are ready — your progress and history are kept.`
            );
          } catch (err) {
            // A student who blocked the bot still gets removed; that is fine.
          }
        }
        summary.removed.push({
          telegram_id: subscriber.telegram_id,
          username: subscriber.username,
          plan: subscriber.plan
        });
        continue;
      }

      // Still active: remind once, if this plan uses reminders.
      const window = plan ? plan.reminderDaysBefore : 3;
      const alreadyReminded = subscriber.reminder_sent === subscriber.expiry_date;

      if (window > 0 && daysLeft <= window && !alreadyReminded) {
        if (!dryRun) await sendRenewalReminder(groupId, subscriber, daysLeft);
        summary.reminded.push({
          telegram_id: subscriber.telegram_id,
          username: subscriber.username,
          daysLeft
        });
      }
    } catch (err) {
      summary.failed.push({ telegram_id: subscriber.telegram_id, reason: err.message });
    }
  }

  return summary;
}

/**
 * describeStatus — the text behind /status in the bot.
 *
 * @param {Object|null} subscriber
 * @returns {string} HTML-formatted status message
 */
function describeStatus(subscriber) {
  if (!subscriber || subscriber.status === 'pending') {
    return '📋 You do not have an active pass yet.\n\nSend /plans to see the options.';
  }

  const expiry = parseIst(subscriber.expiry_date);
  const daysLeft = expiry ? plans.daysUntil(expiry) : null;

  // "Expires 31-12-2099, 26765 days remaining" is technically true and reads
  // like a bug. A lifetime pass says what it is.
  if (subscriber.status === 'active' && isLifetimeSubscriber(subscriber)) {
    return `✅ <b>${esc(subscriber.plan_label || 'Lifetime Pass')}</b> — active\n\n` +
           '♾️ <b>Lifetime access.</b> You paid once — there is nothing to renew and no expiry date.\n' +
           `Total paid: ₹${subscriber.total_paid}`;
  }

  if (subscriber.status === 'active' && daysLeft !== null && daysLeft > 0) {
    return `✅ <b>${esc(subscriber.plan_label)}</b> — active\n\n` +
           `Expires: <b>${esc(subscriber.expiry_date)}</b>\n` +
           `Days remaining: <b>${daysLeft}</b>\n` +
           `Total paid: ₹${subscriber.total_paid}\n\n` +
           (subscriber.subscription_id
             ? 'This renews automatically. Send /cancel to stop it.'
             : 'Send /plans to renew before it runs out.');
  }

  return `⌛ Your <b>${esc(subscriber.plan_label || 'pass')}</b> has ended.\n\n` +
         `It expired on ${esc(subscriber.expiry_date)}.\n\n` +
         `Send /plans to rejoin.`;
}

/**
 * runDailyCheckAllGroups — sweeps every group that is ready.
 *
 * The scheduled job must not stop at the first group with a bad token or an
 * unreachable sheet: the other four still have members whose passes have run
 * out, and skipping them means those seats never expire. Failures are recorded
 * per group and the sweep continues.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<Object>} Per-group summaries plus totals
 */
async function runDailyCheckAllGroups({ dryRun = false } = {}) {
  const results = [];
  let reminded = 0;
  let removed = 0;

  for (const group of groups.listGroups()) {
    if (!group.ready) {
      results.push({ groupId: group.id, skipped: 'not configured' });
      continue;
    }
    try {
      const summary = await runDailyCheck({ groupId: group.id, dryRun });
      reminded += (summary.reminded || []).length;
      removed += (summary.removed || []).length;
      results.push(Object.assign({ groupId: group.id }, summary));
    } catch (err) {
      console.error(`[membership] sweep failed for ${group.id}: ${err.message}`);
      results.push({ groupId: group.id, error: err.message });
    }
  }

  return { groups: results, totals: { reminded, removed }, dryRun };
}

module.exports = {
  TRIAL_PLAN_ID,
  TRIAL_PLAN_LABEL,
  startTrial,
  markTrialWarned,
  endTrial,
  isLifetimeSubscriber,
  IST_OFFSET_MS,
  contextFor,
  runDailyCheckAllGroups,
  getPremiumGroupId,
  isEligible,
  handleJoinRequest,
  enforceMembership,
  formatIst,
  parseIst,
  createSingleUseInvite,
  resendInvite,
  grantAccess,
  removeMember,
  markExpired,
  sendRenewalReminder,
  runDailyCheck,
  describeStatus
};
