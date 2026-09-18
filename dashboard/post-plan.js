// ============================================================================
// Post planning (dashboard/post-plan.js)
// ============================================================================
// Pure helpers behind the "How many" choice on the Automation dashboard: how
// many questions a subject can post, what a selection resolves to, and the
// loop that splits a large run into server-sized batches.
//
// Kept free of DOM and network code so the rules can be unit tested directly
// (test/post-plan.test.mjs).
// ============================================================================

/** Most questions the server posts in one request (MAX_POST_BATCH in server.js). */
export const SERVER_BATCH_LIMIT = 20;

/**
 * Rough seconds per question: the Telegram sends, the 3s pacing between polls,
 * and the sheet write that records it — Apps Script alone takes 3–15s. The old
 * figure of 3 counted only the pacing, so "under a minute" runs took five.
 */
export const SECONDS_PER_QUESTION = 12;

/**
 * availableToPost — how many questions in a subject could go out right now.
 *
 * Mirrors the server's eligibility: Approved and Scheduled always count,
 * Drafts only when the curator allows them. Rejected, Archived, Sending and
 * Posted rows are never eligible. Capped by `pending` so a status count that
 * still includes posted rows can never overstate the stock.
 */
export function availableToPost(entry, requireApproved) {
  if (!entry) return 0;
  const n = (v) => Math.max(0, Number(v) || 0);
  const eligible = n(entry.approved) + n(entry.scheduled) + (requireApproved ? 0 : n(entry.draft));
  return Math.min(eligible, n(entry.pending));
}

/**
 * resolvePostCount — turns the select value (and custom input) into a count.
 *
 * @param {string} choice      A number as a string, "all" or "custom".
 * @param {string} customValue Raw text of the custom number input.
 * @param {number} available   Result of availableToPost().
 * @returns {{ ok: true, count: number } | { ok: false, error: string }}
 */
export function resolvePostCount(choice, customValue, available) {
  const max = Math.max(0, Math.floor(Number(available) || 0));
  if (max === 0) {
    return { ok: false, error: 'There are no eligible questions to post in this subject.' };
  }

  if (choice === 'all') return { ok: true, count: max };

  if (choice === 'custom') {
    const raw = String(customValue ?? '').trim();
    if (raw === '') return { ok: false, error: 'Enter how many questions to post.' };
    if (!/^\d+$/.test(raw)) return { ok: false, error: 'Enter a whole number, like 25.' };
    const count = Number(raw);
    if (count < 1) return { ok: false, error: 'Post at least 1 question.' };
    if (count > max) {
      return { ok: false, error: `Only ${max} question${max === 1 ? ' is' : 's are'} eligible — enter ${max} or fewer.` };
    }
    return { ok: true, count };
  }

  const count = Math.floor(Number(choice));
  if (!Number.isFinite(count) || count < 1) return { ok: false, error: 'Choose how many questions to post.' };
  // A preset larger than the stock simply posts what there is; the server
  // explains the shortfall, as it always has.
  return { ok: true, count };
}

/** Human estimate of how long a run of `count` questions takes. */
export function estimateDuration(count) {
  const seconds = Math.max(0, Number(count) || 0) * SECONDS_PER_QUESTION;
  if (seconds < 60) return 'under a minute';
  const minutes = Math.ceil(seconds / 60);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return `about ${plural(minutes, 'minute')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${plural(hours, 'hour')}${rest ? ' ' + plural(rest, 'minute') : ''}`;
}

/**
 * runPostBatches — posts `total` questions as a series of server-sized batches.
 *
 * Stops early, and says why, when:
 *   - the curator asks to stop (checked between batches, never mid-batch),
 *   - a batch comes back with any failure — a stranded or refused poll needs a
 *     person before more go out,
 *   - the queue runs dry (fewer eligible than requested, or nothing posted).
 *
 * @param {object}   opts
 * @param {number}   opts.total        Questions to post in all.
 * @param {Function} opts.postBatch    async (size) => server response.
 * @param {Function} [opts.onBatch]    (response, { batch, size, postedSoFar }) => void.
 * @param {Function} [opts.shouldStop] () => boolean.
 * @param {number}   [opts.batchLimit] Largest batch to request.
 * @returns {Promise<{ posted: number, failed: number, batches: number, stopReason: string }>}
 *   stopReason is one of: "done", "stopped", "failed", "exhausted".
 */
export async function runPostBatches({ total, postBatch, onBatch, shouldStop, batchLimit = SERVER_BATCH_LIMIT }) {
  let posted = 0;
  let failed = 0;
  let batches = 0;
  const limit = Math.max(1, Math.floor(batchLimit));

  while (posted < total) {
    if (batches > 0 && shouldStop && shouldStop()) {
      return { posted, failed, batches, stopReason: 'stopped' };
    }

    const size = Math.min(limit, total - posted);
    const response = await postBatch(size);
    batches++;

    const batchPosted = Math.max(0, Number(response && response.postedCount) || 0);
    const batchFailed = Math.max(0, Number(response && response.failedCount) || 0);
    posted += batchPosted;
    failed += batchFailed;

    if (onBatch) onBatch(response, { batch: batches, size, postedSoFar: posted });

    if (batchFailed > 0) return { posted, failed, batches, stopReason: 'failed' };

    const eligible = response && response.eligibleCount !== undefined
      ? Number(response.eligibleCount) || 0
      : batchPosted;
    if (batchPosted === 0 || eligible < size) {
      return { posted, failed, batches, stopReason: posted >= total ? 'done' : 'exhausted' };
    }
  }

  return { posted, failed, batches, stopReason: 'done' };
}
