// ============================================================================
// System health dashboard (dashboard/health.js)
// ============================================================================
// Two jobs:
//   1. Connectivity — is the server up, is the Apps Script reachable, is the
//      Telegram bot answering?
//   2. Security posture — are the controls that protect this pipeline actually
//      enabled? Each check explains what it protects against and exactly what
//      to change when it fails, because a red row nobody knows how to fix is
//      just decoration.
// ============================================================================

import {
  initDashboard, api, el, replaceChildren, panel, statCard, emptyState,
  pill, showToast, escapeHtml, $
} from './shared.js';

/** Last /api/health response. */
let health = null;

/**
 * check — one row in a checklist.
 *
 * @param {'pass'|'warn'|'fail'|'info'} state Outcome
 * @param {string} title What was checked
 * @param {string} detail Why it matters and how to fix it
 * @param {string} [badge] Short label for the right-hand pill
 */
function check(state, title, detail, badge) {
  const icons = { pass: '✅', warn: '⚠️', fail: '❌', info: 'ℹ️' };
  const tones = { pass: 'ok', warn: 'warn', fail: 'danger', info: 'info' };
  const labels = { pass: 'OK', warn: 'Review', fail: 'Action needed', info: 'Info' };

  return el('div', { class: 'check-item' }, [
    el('span', { class: 'check-icon', text: icons[state] }),
    el('div', {}, [
      el('div', { class: 'check-title', text: title }),
      el('div', { class: 'check-detail', html: detail })
    ]),
    pill(badge || labels[state], tones[state])
  ]);
}

/** Top tiles: the four services at a glance. */
function renderStats(data) {
  const authOk = data.auth.enforced;
  const sheetsOk = data.sheets.reachable && data.sheets.bound !== false && data.sheets.current;
  const telegramOk = data.telegram.reachable;

  replaceChildren($('statGrid'),
    statCard('Dashboard Server', 'Online', {
      tone: 'ok',
      sub: `${data.server.host}:${data.server.port} · Node ${data.server.node}`
    }),
    statCard('Google Sheets',
      !data.sheets.configured ? 'Not set'
        : !data.sheets.reachable ? 'Error'
        : data.sheets.bound === false ? 'No Sheet'
        : !data.sheets.current ? 'Outdated'
        : 'Connected',
      {
        tone: sheetsOk ? 'ok' : 'danger',
        sub: data.sheets.spreadsheetName || data.sheets.version || data.sheets.error || 'GOOGLE_SHEET_WEBAPP_URL missing'
      }),
    statCard('Telegram Bot', telegramOk ? 'Connected' : data.telegram.configured ? 'Error' : 'Not set', {
      tone: telegramOk ? 'ok' : 'danger',
      sub: data.telegram.botUsername ? '@' + data.telegram.botUsername : (data.telegram.error || 'credentials missing')
    }),
    statCard('API Authentication', authOk ? 'Enforced' : 'Off', {
      tone: authOk ? 'ok' : 'danger',
      sub: authOk ? `project ${data.auth.projectId}` : 'FIREBASE_PROJECT_ID not set'
    }),
    statCard('Server Uptime', formatUptime(data.server.uptimeSeconds), {
      tone: 'info', sub: 'since npm run dashboard'
    }),
    // An email has no spaces, so showing the whole thing as a headline value
    // forces an ugly mid-word break. The readable half goes in the value and
    // the full address in the sub line, which wraps gracefully.
    statCard('Signed In As', (data.you.email || data.you.uid).split('@')[0], {
      tone: 'info',
      sub: `${data.you.email || data.you.uid} · ${data.you.provider} · ` +
           `${data.you.emailVerified ? 'verified' : 'unverified'}`
    })
  );
}

/** Turns seconds into a compact "2h 14m" style string. */
function formatUptime(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/** Connectivity checklist. */
function connectivityChecks(data) {
  const checks = [];

  if (!data.sheets.configured) {
    checks.push(check('fail', 'Google Apps Script Web App',
      'No <code>GOOGLE_SHEET_WEBAPP_URL</code> in <code>.env</code>. Deploy <code>google_apps_script.js</code> and paste the /exec URL there.'));
  } else if (!data.sheets.reachable) {
    checks.push(check('fail', 'Google Apps Script Web App',
      `Not reachable: ${escapeHtml(data.sheets.error)}. Redeploy the script with <code>Execute as: Me</code> and ` +
      '<code>Who has access: Anyone</code>, then confirm the /exec URL in <code>.env</code>.'));
  } else if (data.sheets.bound === false) {
    // Deployed and answering, but it cannot see any spreadsheet — the code was
    // pasted into a standalone project instead of the Sheet's own script.
    checks.push(check('fail', 'Apps Script is attached to your spreadsheet',
      'The Web App is running but is not bound to any Sheet, so it was created as a standalone project ' +
      'at script.google.com rather than from inside the Sheet. Open your Google Sheet → ' +
      '<code>Extensions → Apps Script</code>, paste <code>google_apps_script.js</code> there, run ' +
      '<code>upgradeSpreadsheet</code>, then <code>Deploy → Manage deployments → Edit → New version</code>. ' +
      'Redeploying that project keeps the URL already in your <code>.env</code>.'));
  } else if (!data.sheets.current) {
    // Reachable and bound, but an older version of the script.
    checks.push(check('fail', 'Google Apps Script version',
      `The deployed Web App is running <code>${escapeHtml(data.sheets.version || 'an unknown version')}</code>, but these ` +
      `dashboards need <code>${escapeHtml(data.sheets.requiredVersion || 'a newer version')}</code>. Analytics, the question browser and editing will not ` +
      'work until you open your Sheet → <code>Extensions → Apps Script</code>, paste the current ' +
      '<code>google_apps_script.js</code>, run <code>upgradeSpreadsheet</code>, and deploy a ' +
      '<strong>New version</strong> of that same deployment.'));
  } else {
    checks.push(check('pass', 'Google Apps Script Web App',
      `Responding with <code>${escapeHtml(data.sheets.version)}</code>` +
      (data.sheets.spreadsheetName ? `, attached to "${escapeHtml(data.sheets.spreadsheetName)}".` : '.')));
  }

  checks.push(data.telegram.configured
    ? (data.telegram.reachable
        ? check('pass', 'Telegram Bot API',
            `Bot <code>@${escapeHtml(data.telegram.botUsername)}</code> is answering getMe.`)
        : check('fail', 'Telegram Bot API',
            `Bot not reachable: ${escapeHtml(data.telegram.error)}. Check <code>TELEGRAM_BOT_TOKEN</code> is current and that the bot is still an admin of the group.`))
    : check('fail', 'Telegram Bot API',
        'Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_GROUP_ID</code> in <code>.env</code>. Without them the Automation dashboard cannot post.'));

  checks.push(check('pass', 'Dashboard server',
    `Running on Node ${data.server.node}, bound to <code>${data.server.host}</code>, up for ${formatUptime(data.server.uptimeSeconds)}.`));

  // Membership actions live in the same Apps Script, but only in a deployment
  // made after the payments release.
  if (data.sheets.reachable && data.sheets.membershipReady === false) {
    checks.push(check('fail', 'Subscription storage',
      'The deployed Apps Script does not have the membership actions, so every payment webhook will fail ' +
      'and nobody gets group access after paying. Paste the current <code>google_apps_script.js</code>, run ' +
      '<code>setupSubscriptionSheets</code>, and deploy a new version. ' +
      `<br><small>${escapeHtml(data.sheets.membershipError || '')}</small>`));
  } else if (data.sheets.membershipReady) {
    checks.push(check('pass', 'Subscription storage',
      'Subscribers and Payments tabs are reachable — paid members will be recorded.'));
  }

  // Payment pipeline.
  if (data.payments) {
    const p = data.payments;

    // Nothing removes a lapsed member unless something calls the sweep. Said
  // plainly, because the failure is silent: passes simply never end.
  checks.push(p.cronSecretSet
    ? check('pass', 'Automatic expiry sweep',
        'Scheduled sweep is armed. Lapsed members are removed without anyone running a command.')
    : check('fail', 'Automatic expiry sweep',
        'No <code>CRON_SECRET</code>, so <code>/api/cron/sweep</code> refuses to run and nothing ' +
        'removes expired members. Passes will never actually end.'));

  // Two bots is the safer arrangement: the payment bot holds admin rights over
  // the paid group, so sharing that token with the public posting bot means one
  // leak exposes both.
  const sharing = Array.isArray(p.sharedPaymentBotGroups) ? p.sharedPaymentBotGroups : [];
  checks.push(p.dedicatedPaymentBot
    ? check('pass', 'Separate payment bot',
        'Payments and group access run on their own bot tokens, apart from the questions bot.')
    : check('warn', 'Separate payment bot',
        // Name the groups and the exact variables. Saying "one bot is doing both
        // jobs" was both wrong and unactionable once each family had its own.
        (sharing.length
          ? 'Falling back to another bot\'s token for ' +
            sharing.map((g) => `<strong>${g.label}</strong> (set <code>${g.env}</code>)`).join(', ') + '. '
          : 'A payment bot is falling back to another bot\'s token. ') +
        'A leak of the posting token would also open the paid group.'));

  // Apps Script is pasted into each sheet by hand, so the dashboard routinely
  // runs ahead of it and a feature looks broken when a manual step is simply
  // outstanding. Name the actions rather than saying "outdated".
  if (Array.isArray(data.sheets.missingActions) && data.sheets.missingActions.length) {
    checks.push(check('fail', 'This sheet\'s Apps Script is out of date',
      'It has never heard of: ' +
      data.sheets.missingActions.map((a) => `<code>${escapeHtml(a)}</code>`).join(', ') + '. ' +
      'Anything using them fails. Open the sheet → <strong>Extensions → Apps Script</strong>, ' +
      'paste this group\'s file from <code>apps-script/</code> over what is there, then ' +
      '<strong>Deploy → Manage deployments → edit → Version: New version</strong>.'));
  } else if (data.sheets.scriptCurrent) {
    checks.push(check('pass', 'Apps Script is current',
      'This sheet knows every action the dashboard uses.'));
  }

  checks.push(p.configured
      ? check(p.testMode ? 'warn' : 'pass', 'Razorpay keys',
          p.testMode
            ? 'Running in <strong>TEST mode</strong>. Real money is not charged — switch to live keys when you are ready to sell.'
            : 'Live keys configured.')
      : check('fail', 'Razorpay keys',
          'Set <code>RAZORPAY_KEY_ID</code> and <code>RAZORPAY_KEY_SECRET</code> in <code>.env</code>.'));

    checks.push(p.webhookSecretSet
      ? check('pass', 'Webhook signature secret',
          'Set. Every webhook must carry a matching HMAC signature, so a forged "payment captured" cannot buy a free seat.')
      : check('fail', 'Webhook signature secret',
          'No <code>RAZORPAY_WEBHOOK_SECRET</code>. Every webhook is rejected, so nobody gets access after paying. ' +
          'Generate one, put it in <code>.env</code>, and paste the same value into Razorpay → Settings → Webhooks.'));

    checks.push(p.premiumGroupSet
      ? check('pass', 'Premium group', 'Configured — invite links will point at it.')
      : check('fail', 'Premium group',
          'Set <code>TELEGRAM_PREMIUM_GROUP_ID</code> (or <code>TELEGRAM_GROUP_ID</code>) so paid members have somewhere to join.'));

    // Auto-pay needs one Razorpay plan per group: Razorpay bakes the amount
    // into the plan, so five groups cannot share one. Name the groups that are
    // missing theirs and the exact variable each needs, rather than a single
    // "not configured" that says nothing about which of the five will break.
    const noAutopay = (p.groups || []).filter((g) => !g.autopayReady);
    checks.push(noAutopay.length === 0
      ? check('pass', 'Monthly Auto-Pay plans', 'Every group has its own Razorpay plan id.')
      : check('warn', 'Monthly Auto-Pay plans',
          `No Razorpay plan for ${noAutopay.map((g) => `<strong>${g.label}</strong>`).join(', ')}. ` +
          'The one-time passes still sell; Monthly Auto-Pay will error for those groups until you run ' +
          '<code>node setup-razorpay.js</code> and add ' +
          noAutopay.map((g) => `<code>${g.autopayMissing}</code>`).join(', ') +
          ' to <code>.env</code>.'));

    checks.push(p.publicBaseUrl
      ? check('pass', 'Public base URL', `Webhooks and redirects use <code>${p.publicBaseUrl}</code>.`)
      : check('warn', 'Public base URL',
          'No <code>PUBLIC_BASE_URL</code>. Razorpay needs a publicly reachable URL to deliver webhooks to; ' +
          'localhost will not receive them.'));
  }

  return el('div', { class: 'check-list' }, checks);
}

/**
 * securityChecks — the posture review.
 * These mirror the findings from the red/blue source review; each one names the
 * control, what it stops, and the exact setting that turns it on.
 */
function securityChecks(data) {
  const checks = [];

  // --- Server-side authentication -----------------------------------------
  checks.push(data.auth.enforced
    ? check('pass', 'Server verifies your Firebase login',
        `Every API call must carry a Firebase ID token, and the server checks its signature against Google's ` +
        `public certificates for project <code>${data.auth.projectId}</code>. The login screen alone would not ` +
        `stop anyone calling the API with curl — this is the control that does.`)
    : check('fail', 'Server verifies your Firebase login',
        'FIREBASE_PROJECT_ID is not set, so the server cannot verify tokens and refuses every data request (HTTP 503). ' +
        'Add <code>FIREBASE_PROJECT_ID=ap-gurukul-43050</code> to <code>.env</code> and restart.'));

  // --- Curator allowlist ---------------------------------------------------
  checks.push(data.auth.allowlistSize > 0
    ? check('pass', 'Curator allowlist',
        `${data.auth.allowlistSize} email address(es) in <code>CURATOR_EMAILS</code> may use this dashboard. ` +
        'Anyone else who signs in successfully is still refused by the server.')
    : check('warn', 'Curator allowlist',
        'No <code>CURATOR_EMAILS</code> set, so <em>any</em> Firebase account with a verified email can upload ' +
        'questions and post to your channel. Add the curators you trust as a comma-separated list in <code>.env</code>.'));

  // --- Apps Script shared secret ------------------------------------------
  checks.push(data.sheets.tokenRequired
    ? check('pass', 'Google Sheets Web App requires a token',
        'The Apps Script checks <code>API_TOKEN</code> before answering. Anyone who learns your /exec URL still ' +
        'cannot read or modify your question bank.')
    : check(data.sheets.reachable ? 'fail' : 'warn', 'Google Sheets Web App requires a token',
        'Your Web App is deployed as "Anyone" with no shared secret, so the /exec URL <em>is</em> the password — ' +
        'anyone who sees it can read every question and mark rows as posted. Fix: in Apps Script open ' +
        '<code>Project Settings → Script properties</code>, add <code>API_TOKEN</code> with a long random value, ' +
        'put the same value in <code>.env</code> as <code>SHEET_API_TOKEN</code>, and redeploy a new version.'));

  // --- Network exposure ----------------------------------------------------
  // Only meaningful for a server on a network someone else can be on. A Vercel
  // deployment binds 0.0.0.0 because the container requires it — there is no
  // LAN there, and "unset HOST to go back to 127.0.0.1" would stop the
  // deployment accepting any request at all. Access there is Firebase auth,
  // which has its own checks above.
  const loopback = data.server.host === '127.0.0.1' || data.server.host === 'localhost' || data.server.host === '::1';
  if (data.server.serverless) {
    checks.push(check('pass', 'Network exposure',
      `Running on Vercel, bound to <code>${data.server.host}</code> because the container requires it. ` +
      'There is no local network to expose — every request arrives through Vercel and has to pass sign-in.'));
  } else {
    checks.push(loopback
      ? check('pass', 'Server is loopback only',
          `Bound to <code>${data.server.host}</code>, so only this machine can reach the dashboard. Nothing on your ` +
          'Wi-Fi network can call the API that posts to Telegram.')
      : check('warn', 'Server is loopback only',
          `Bound to <code>${data.server.host}</code>, which exposes the dashboard to your whole network. Unset ` +
          '<code>HOST</code> in <code>.env</code> to go back to <code>127.0.0.1</code> unless you deliberately need remote access.'));
  }

  // --- Email verification --------------------------------------------------
  checks.push(data.you.emailVerified
    ? check('pass', 'Your own account is verified',
        `Signed in via <code>${data.you.provider}</code> with a verified address.`)
    : check('warn', 'Your own account is verified',
        'Your email is not verified. With no curator allowlist configured the server rejects unverified accounts, ' +
        'so verify the address from the email Firebase sent you.'));

  // --- Controls that are always on ----------------------------------------
  checks.push(check('info', 'Always-on protections',
    'Independent of configuration, this server: refuses cross-origin API calls (no permissive CORS, so another site ' +
    'you have open cannot drive it); caps request bodies at 2&nbsp;MB; rate limits to 240 requests a minute per client; ' +
    'sends a strict Content-Security-Policy plus <code>X-Frame-Options: DENY</code>; will not fetch a URL supplied by ' +
    'the browser (the Sheets endpoint comes from <code>.env</code> only, closing the SSRF path); serves only ' +
    'allowlisted file types from <code>dashboard/</code> with traversal-safe path resolution; and takes "Added By" ' +
    'from your verified token rather than the request body, so authorship cannot be forged.',
    'Enabled'));

  // --- Housekeeping reminders ---------------------------------------------
  checks.push(check('info', 'Secret hygiene',
    'Your <code>.env</code> holds the Telegram bot token and is listed in <code>.gitignore</code> — keep it that way ' +
    'and never paste it into an issue or a screenshot. If it ever leaks, revoke it with <code>/revoke</code> in ' +
    '@BotFather and issue a new one.',
    'Reminder'));

  return el('div', { class: 'check-list' }, checks);
}

/** Counts how many security checks passed, for the summary line. */
function postureSummary(data) {
  const criteria = [
    data.auth.enforced,
    data.auth.allowlistSize > 0,
    Boolean(data.sheets.tokenRequired),
    data.server.host === '127.0.0.1' || data.server.host === 'localhost' || data.server.host === '::1',
    Boolean(data.you.emailVerified)
  ];
  const passed = criteria.filter(Boolean).length;
  return { passed, total: criteria.length };
}

/** Fetches health data and renders both checklists. */
async function load() {
  const panels = $('panels');
  replaceChildren(panels, el('div', { class: 'loading-row' }, [
    el('div', { class: 'spinner' }),
    el('span', { text: 'Probing the server, Google Sheets and Telegram…' })
  ]));

  const button = $('refreshBtn');
  button.disabled = true;

  try {
    health = await api('/api/health');
    renderStats(health);

    const posture = postureSummary(health);

    replaceChildren(panels,
      panel('Connectivity',
        'Can this server actually reach the services the pipeline depends on?',
        connectivityChecks(health)),

      panel('Security Posture',
        `${posture.passed} of ${posture.total} hardening controls are switched on. ` +
        'Each row says what the control stops and exactly what to change.',
        securityChecks(health))
    );
  } catch (err) {
    replaceChildren(panels, emptyState('⚠️', 'Health check failed.', err.message));
    showToast('error', err.message, 9000);
  } finally {
    button.disabled = false;
  }
}

initDashboard({
  page: 'health',
  onReady: async () => {
    $('refreshBtn').addEventListener('click', load);
    await load();
  }
});
