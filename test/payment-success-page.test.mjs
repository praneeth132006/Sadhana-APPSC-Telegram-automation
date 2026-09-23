// ============================================================================
// The thank-you page after paying (test/payment-success-page.test.mjs)
// ============================================================================
// Runs the page's own script against a fake DOM and a fake server: it must
// wait for the pass to be granted and then take the student straight into the
// group — never leave them on a page that says "go back to Telegram".
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('dashboard/payment-success.html', 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

const PAID = { status: 'paid', paid: true, amountPaise: 19900, planLabel: 'Target 2026', planEmoji: '🎯',
  recurring: false, groupName: 'UPSC Prelims', botUsername: 'prelimspaymentbot' };

async function runPage(answers, { search = '?razorpay_payment_link_id=plink_1&razorpay_signature=x' } = {}) {
  const nodes = {};
  const node = (id) => (nodes[id] ||= {
    id, hidden: ['receipt', 'rowPlan', 'rowGroup', 'rowAmount', 'renewNote', 'cta'].includes(id), textContent: '', innerHTML: '',
    href: 'https://t.me/', attributes: {}, classList: { add(c) { this.list = (this.list || []).concat(c); } },
    setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; }
  });
  const steps = { hidden: false };
  const location = { search, href: 'https://appscsadhana.vercel.app/payment-success.html' + search };
  let calls = 0;
  const timers = [];
  const context = vm.createContext({
    URLSearchParams, location,
    document: { getElementById: node, querySelector: () => steps },
    fetch: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls++;
      return { ok: answer.ok !== false, json: async () => answer.body };
    },
    // Nothing waits for real: every pause resolves at once, and the redirect is recorded.
    setTimeout: (fn, ms) => { timers.push(ms); fn(); return timers.length; }
  });
  const mod = new vm.SourceTextModule(script, { context });
  await mod.link(() => { throw new Error('the page imports nothing'); });
  await mod.evaluate();
  return { node, location, calls: () => calls, timers };
}

test('paid and granted: the page goes straight into the group', async () => {
  const page = await runPage([{ body: { success: true, data: Object.assign({}, PAID, { inviteLink: 'https://t.me/+mine' }) } }]);
  assert.equal(page.location.href, 'https://t.me/+mine', 'the student was not sent into the group');
  assert.match(page.node('title').textContent, /You're in/);
  assert.equal(page.node('cta').href, 'https://t.me/+mine', 'no button as a backup');
  assert.equal(page.node('cta').hidden, false);
  assert.match(page.node('cta').textContent, /Join UPSC Prelims now/);
  assert.equal(page.calls(), 1);
});

test('paid but the webhook is a moment behind: the page waits, then goes in', async () => {
  const waiting = { body: { success: true, data: Object.assign({}, PAID, { inviteLink: null }) } };
  const ready = { body: { success: true, data: Object.assign({}, PAID, { inviteLink: 'https://t.me/+mine' }) } };
  const page = await runPage([waiting, waiting, waiting, ready]);
  assert.equal(page.calls(), 4);
  assert.equal(page.location.href, 'https://t.me/+mine');
});

test('never granted within the wait: the page points at the bot instead of hanging', async () => {
  const waiting = { body: { success: true, data: Object.assign({}, PAID, { inviteLink: null }) } };
  const page = await runPage([waiting]);
  assert.equal(page.calls(), 20, 'it should keep asking for about a minute, then stop');
  assert.ok(!/t\.me\/\+/.test(page.location.href), 'redirected without an invite');
  assert.equal(page.node('cta').href, 'https://t.me/prelimspaymentbot');
  assert.equal(page.node('cta').hidden, false);
  assert.match(page.node('subtitle').textContent, /being activated/);
});

test('an unpaid link is said to be unpaid, and nothing redirects', async () => {
  const page = await runPage([{ body: { success: true, data: Object.assign({}, PAID, { paid: false, status: 'expired' }) } }]);
  assert.equal(page.calls(), 1);
  assert.match(page.node('title').textContent, /Payment not completed/);
  assert.ok(!/t\.me\/\+/.test(page.location.href));
});

test('a confirmation that fails does not claim the payment failed', async () => {
  const page = await runPage([{ ok: false, body: { success: false, error: 'Could not reach Razorpay' } }]);
  assert.match(page.node('subtitle').textContent, /being activated/);
  assert.doesNotMatch(page.node('title').textContent, /not completed/);
});

test('opened directly, with no payment in the address, the page asks nothing', async () => {
  const page = await runPage([], { search: '' });
  assert.equal(page.calls(), 0);
});
