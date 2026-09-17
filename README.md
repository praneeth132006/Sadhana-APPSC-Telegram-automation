# Sadhana APPSC — Telegram Quiz Automation

Curate APPSC exam questions in a browser, track them in Google Sheets, and publish
them to Telegram forum topics as quiz polls.

Five dashboards, one Google Sheet with 30 tracked columns per question, and a Telegram
bot that posts on a schedule or on demand.

---

## The six dashboards

Live at <https://appscsadhana.vercel.app>, or locally with `npm run dashboard` at
<http://localhost:3000>.

| | Dashboard | What it is for |
|---|---|---|
| 📤 | **Upload** (`/`) | Paste a JSON batch, review it as editable cards, push it into the sheet. Duplicates are detected and skipped. |
| 📊 | **Analytics** (`/analytics.html`) | How many questions exist per subject, how many are posted, what is pending, the workflow and difficulty mix, curator contributions, posting timeline, and how many days of content each subject has left. |
| 📚 | **Questions** (`/questions.html`) | Browse and search the whole bank. Filter by subject, status, difficulty or posted state. Edit any question in place, approve or reject in bulk, delete. |
| 🤖 | **Automation** (`/automation.html`) | Post to Telegram straight from the browser. Queue batches for a planned time. See every subject's cron cadence and remaining runway. |
| 💳 | **Members** (`/members.html`) | Paying members, revenue by plan, who is about to lapse, and a dry run of the nightly expiry sweep. |
| 🩺 | **Health** (`/health.html`) | Is the server, the sheet and the bot reachable — and are the security controls that protect them actually switched on. |

---

## Uploading questions — for everyone except the admin

**Open <https://appscsadhana.vercel.app> and sign in with Google. That is the whole setup.**

Nothing to install, no server to run, no `.env`, no Apps Script. It writes to the same
Google Sheet as everything else.

To let a new person in, the admin adds their email to the `CURATOR_EMAILS`
environment variable on Vercel (Project → Settings → Environment Variables) and
redeploys. Without that they will sign in successfully and then see a banner saying
the account is not on the curator allowlist — that is the allowlist doing its job, not
a bug.

The rest of this README is for the **admin**: the one machine that also runs the
Telegram bot and the scheduler. Everyone else can stop reading here.

---

## Setup — admin only

Only needed on the machine that posts to Telegram and runs the scheduler. Curators
uploading questions do not need any of this.


### 1. Install

```bash
npm install
```

### 2. Telegram bot

1. Message **@BotFather**, send `/newbot`, copy the token.
2. Create a group, enable **Topics** in settings, add the bot as an **admin** with
   Manage Topics, Post Messages and Send Polls.
3. Add **@raw_data_bot** to the group to learn the chat id (it starts with `-100`).

### 3. Google Sheet backend

> **Open the script from inside the Sheet, not from script.google.com.**
> This is the one step that catches everyone. Going to script.google.com creates a
> *standalone* project — the title bar says "Untitled project" — which has its own
> separate Web App URL and cannot see your spreadsheet at all
> (`getActiveSpreadsheet()` returns `null`). Deploying it changes nothing, because
> your `.env` still points at the old deployment. The Health dashboard detects both
> of these and tells you which one you have hit.

1. Create a Google Sheet.
2. From **that Sheet**, choose **Extensions → Apps Script**. The project that opens
   is bound to the Sheet — redeploying it keeps the same Web App URL, so nothing
   else needs changing.
3. Delete everything in `Code.gs` and paste all of `google_apps_script.js`.
4. Run **`setupSpreadsheet`** from the function dropdown (first time), or
   **`upgradeSpreadsheet`** if you already have questions in an older layout — it
   migrates every row by header name, so nothing is lost.

   Running a function in the editor does **not** deploy it. Step 6 does that.
5. Generate a shared secret and register it in **both** places:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   - Apps Script → **Project Settings → Script properties** → add `API_TOKEN`
   - your `.env` → `SHEET_API_TOKEN`

   Without this, the `/exec` URL alone grants full access to your question bank.
6. **Deploy → Manage deployments →** pencil icon **→ Version: New version → Deploy.**
   Execute as **Me**, Who has access **Anyone**.

   Use *Manage deployments* on the existing deployment rather than *New deployment*,
   so the URL stays the same as the one in your `.env`. If you do create a new
   deployment, copy its `/exec` URL into `GOOGLE_SHEET_WEBAPP_URL`.

Check it worked by opening the **Health** dashboard: Google Sheets should read
**Connected** with `v5 (30 columns)` and your spreadsheet's name.

### 4. Configure

```bash
cp .env.example .env
```

Fill in `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `GOOGLE_SHEET_WEBAPP_URL`,
`SHEET_API_TOKEN`, `FIREBASE_PROJECT_ID` and `CURATOR_EMAILS`. Every variable is
documented inline in `.env.example`.

> `FIREBASE_PROJECT_ID` is required. Without it the server cannot verify logins and
> refuses every data request with HTTP 503.

### 5. Create the Telegram topics

```bash
node setup.js
```

Creates a forum topic per subject and writes the thread ids into the Config tab.

### 6. Run

```bash
npm run dashboard
```

---

## The 30-column schema

Each subject gets its own sheet tab. Columns A–AD:

| Col | Field | What it gives you |
|---|---|---|
| A | S.No | Serial number within the subject |
| B | **Question ID** | Stable unique id (`POL-20260905-0007`) — the handle for editing, deleting and cross-referencing |
| C | Date | Publication date; becomes the `#DD_MM_YYYY` hashtag on the post |
| D | Newspaper | Source publication; becomes the `#Newspaper` hashtag |
| E | Subject | Mirrors the tab name |
| F | **Topic** | Sub-topic inside the subject, so revision can be filtered finer than "Polity" |
| G | Question | Full question text and statements |
| H–K | Option A–D | The four choices |
| L | Correct Answer | A / B / C / D |
| M | Explanation | Shown on the quiz poll and in the spoiler message |
| N | **Difficulty** | Easy / Medium / Hard — dropdown, colour coded |
| O | **Tags** | Comma-separated keywords for search and revision sets |
| P | **Source URL** | Link back to the article or PIB release |
| Q | **Status** | Draft → Review → Approved → Scheduled → Posted, plus Rejected and Archived |
| R | Posted | YES / NO |
| S | Posted At | IST timestamp of the Telegram post |
| T | **Scheduled For** | Planned posting time |
| U | **Thread ID** | Which forum topic it went to |
| V | Telegram Msg ID | Message id of the poll |
| W | **Poll ID** | Telegram poll id, for attributing votes later |
| X | **Times Posted** | Repost counter |
| Y | Added At | When it was uploaded |
| Z | Added By | Curator email, taken from the verified login |
| AA | **Updated At** | Last edit |
| AB | **Updated By** | Who made the last edit |
| AC | **Dup Hash** | Normalised fingerprint of the question text — how duplicates are caught |
| AD | **Review Notes** | Free-text QA remarks |

Bold entries are new in this release.

**Why `Status` matters alongside `Posted`:** `Posted` is a fact about the past.
`Status` is a decision about the future. A question can be written but unreviewed
(`Draft`), reviewed and cleared (`Approved`), or thrown out (`Rejected`) — all three
have `Posted = NO`, and only one of them should ever reach the channel. The Automation
dashboard sends only `Approved` or `Scheduled` questions by default, and `Rejected`
and `Archived` rows are never eligible.

**Why `Dup Hash` matters:** the question text is lowercased and stripped of
punctuation and whitespace before hashing, so re-pasting the same question with
different formatting is still recognised as a duplicate rather than silently doubling
your bank.

---

## Command line

The CLI still does everything it did, and now records the fuller tracking trail.

```bash
node send.js --subject Polity --count 5   # send five Polity questions now
node send.js --all --count 3              # three from every active subject
node send.js --stats                      # totals per subject
node send.js --test                       # check the bot token and group

node schedule.js                          # run the cron scheduler
node schedule.js --dry-run                # show the schedule without sending

node setup.js                             # create the Telegram forum topics
node verify-topics.js                     # check every subject's topic still exists
node verify-topics.js --fix               # …and recreate any that are missing
```

Apps Script editor only (destructive, deliberately not exposed over HTTP):

| Function | What it does |
|---|---|
| `upgradeSpreadsheet` | Migrate an existing sheet to the 30-column schema, lossless |
| `clearAllQuestions` | Delete every question from every subject tab; Config untouched |
| `clearSubjectQuestions("Polity")` | Delete every question in one subject |
| `backfillQuestionIds` | Give a Question ID and duplicate hash to rows missing them |

Common cron expressions for the Config tab:

| Expression | Meaning |
|---|---|
| `0 */2 * * *` | every 2 hours |
| `0 */3 * * *` | every 3 hours |
| `0 9 * * *` | daily at 9 AM |
| `0 9,18 * * *` | 9 AM and 6 PM |
| `0 8,14,20 * * *` | 8 AM, 2 PM and 8 PM |

---

## Security

The dashboards are protected by Firebase Auth, and — this is the part that actually
matters — **the server verifies that login itself** rather than trusting the browser.
Every API call must carry a Firebase ID token whose RS256 signature is checked against
Google's published certificates before anything touches the sheet or the bot.

On top of that: a curator allowlist, a shared secret between the server and the Apps
Script, loopback-only binding, no cross-origin access, request size caps, rate
limiting, and a strict Content-Security-Policy.

The **Health dashboard** shows which of these are switched on and exactly what to
change for any that are not.

The full review, including what was wrong before this release and how each issue was
proven, is in [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

---

## Paid group access (Razorpay)

Students buy a pass from the Telegram bot and are let into a private group
automatically. Three options:

| Pass | Price | Type | Access ends |
|---|---|---|---|
| 🗓️ 30-Day Sprint | ₹299 | one-time | 30 days after payment |
| 🔄 Monthly Auto-Pay | ₹249/mo | recurring | keeps renewing until cancelled |
| 🎯 Target APPSC 2026 | ₹799 | one-time | fixed exam date (`EXAM_PASS_END_DATE`) |

Everything is stored in the same Google Sheet — a **Subscribers** tab with one row
per member, and an append-only **Payments** log.

### How access is granted

```
student taps a plan  →  bot creates a Razorpay link carrying their Telegram id
       ↓
student pays         →  Razorpay POSTs a signed webhook to /api/payments/webhook
       ↓
signature verified   →  expiry computed, row written, single-use invite DMed
       ↓
nightly sweep        →  reminds before expiry, removes after it
```

**The signature is the whole security model.** The webhook is the only path from
money to group access, and a request without a valid HMAC over the exact bytes
Razorpay sent is rejected before a single field is read. Without that check, anyone
who found the URL could POST "payment captured" and be handed a paid seat.

Two more things worth knowing:

- **Invite links are single-use** (`member_limit: 1`). Forwarding one gives away your
  own seat rather than creating a free second one.
- **Renewing early never costs you days.** A new term extends from your current
  expiry, not from today.

### Setup

1. Put your Razorpay keys in `.env` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`) and
   generate a webhook secret:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

2. In Apps Script, paste the current `google_apps_script.js`, run
   **`setupSubscriptionSheets`**, and deploy a new version.

3. Create the recurring plan and print the webhook settings:

   ```bash
   npm run setup-razorpay
   ```

4. In Razorpay → **Settings → Webhooks**, add `<PUBLIC_BASE_URL>/api/payments/webhook`
   with that secret and these events:
   `payment_link.paid`, `subscription.charged`, `subscription.cancelled`,
   `subscription.halted`.

5. Run the bot and the nightly sweep:

   ```bash
   npm run bot
   ```

   ```bash
   npm run membership-cron -- --watch
   ```

The **Health** dashboard checks every one of these and names what is missing.

### Testing it without real money

The keys in `.env` are **test keys** — no real money moves. Use Razorpay's test
cards (e.g. `4111 1111 1111 1111`, any future expiry, any CVV) or test UPI.

Webhooks cannot reach `localhost`, so during local testing expose the server:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Put that HTTPS URL in `PUBLIC_BASE_URL` and in the Razorpay webhook, then buy a pass
from the bot with a test card and watch the invite arrive.

### Bot commands

| Command | What it does |
|---|---|
| `/start`, `/plans` | Show the three passes as buttons |
| `/status` | Current pass, expiry date, days left |
| `/cancel` | Stop auto-renewal, keeping the paid period |
| `/help` | How the flow works |
| `/support` | Help topics with instant answers, and a way to raise a ticket |

Typing any ordinary message to the bot also offers to send it to support.

### Support tickets and bot settings

A student picks an issue in `/support`, gets the instant answer for it, and can
then raise a ticket (text or a screenshot). Each ticket is:

- written to the **Support** tab of the sheet of the first group the bot sells,
- posted to the admin **support chat**, if one is configured, together with the
  student's current pass status, and
- listed on the dashboard's **🆘 Support** page.

Admins answer either by **replying to the ticket message in the support chat**
or from the **Support** page. The student's reply to an answer goes back into
the same ticket. In the support chat, reply `/close` or `/reopen` to a ticket;
`/tickets` lists open ones, `/settings` shows the bot texts and
`/set key value` changes one. `/supporthelp` lists these.

The texts students see — support hours, response time, a fallback contact, an
extra `/start` note, and the instant answer for each issue — live in the sheet's
**Bot Settings** tab and are edited from the Support page or with `/set`. No
deploy is needed; the bot picks changes up within a minute.

Setup:

1. Re-paste the generated `apps-script/<group>.gs.js` into each sheet and deploy a
   new version. Until then the bot still answers with the default texts and still
   delivers tickets to the support chat, but cannot save them to the sheet.
2. Optional: create a **private** Telegram group for admins, add each payment bot,
   and set `SUPPORT_CHAT_ID` (see `.env.example` for per-bot chats and forum
   topics). Everyone in that group can answer students and change bot texts.

---

## Troubleshooting

### Signing in

**Banner says "Sign-in will fail on …" but the site works.**
Fixed. That check used to compare against a hardcoded guess at the authorised hosts,
so it wrongly flagged the live Vercel domain. It now reads the project's real
`authorizedDomains` list and stays silent if it cannot reach it — a false alarm is
worse than none.

### Payments

**Someone paid but got no invite link.**
Check the **Health** dashboard first — it tests each link in the chain. The usual
causes, in order: the Apps Script was not redeployed with the membership actions;
`RAZORPAY_WEBHOOK_SECRET` does not match what is set in the Razorpay dashboard; or
`PUBLIC_BASE_URL` points somewhere Razorpay cannot reach. Razorpay retries a failed
webhook, so fix the cause and the delivery will succeed on its own — the payment is
not lost. Razorpay → Settings → Webhooks shows every delivery attempt and its
response.

Telegram also forbids a bot from opening a conversation, so a student who has never
messaged the bot cannot be DMed. They will still be recorded as active; `/status`
gives them their link.

**Every webhook returns 401.**
The secret in `.env` and the one in the Razorpay dashboard differ. They must match
exactly.

### Signing in

**Google sign-in shows "500. That's an error" from accounts.google.com.**
Almost always the host the page is open on. Firebase authorises sign-in per
*domain*, and it treats `localhost` and `127.0.0.1` as different domains — only
`localhost` is on the default list. Loading the dashboard on `127.0.0.1` or a LAN IP
makes Google reject the request, often as a bare 500 with no explanation.

The server now redirects `127.0.0.1` to `localhost` automatically, so open
**http://localhost:3000**. For any other host, either use localhost or add that host
under **Firebase Console → Authentication → Settings → Authorised domains**. The
dashboard shows a red banner up front when the current host cannot work.

**A second person signs in but every panel errors.**
Their account authenticated; the server refuses it because it is not on the curator
allowlist. Add their address to `CURATOR_EMAILS` in `.env` (comma separated) and
restart. The dashboard names the account and the fix in a banner.

Each person needs their **own** copy of the server running on their own machine — it
binds to loopback only, so one person cannot reach another's.

**A brief splash when moving between dashboards.**
Expected — that is the session being restored from local storage. If you see the
*sign-in form* instead, your browser is blocking site data for localhost, which stops
Firebase persisting the session.

**HTTP 503 "Server auth is not configured".**
`FIREBASE_PROJECT_ID` is missing from `.env`. Set it and restart.

### Google Sheets

**Opening the Sheet gives ERR_TOO_MANY_REDIRECTS.**
Not the dashboard. The URL in that loop is
`accounts.google.com/ServiceLogin?service=wise`, which is Google's own sign-in for
Docs and Sheets. It loops when the browser's Google cookies are in a bad state,
usually from several Google accounts being signed in at once. Fix it in the browser:
clear cookies for `google.com` and `accounts.google.com`, or open the sheet in a
fresh profile or incognito window and sign in with one account.

**I deleted a question in the dashboard but it is still in the sheet.**
Two buttons look like "delete":
- The **Upload** page's per-card button only removes a card from the batch you are
  about to send — nothing has been written to the sheet yet. It is labelled
  *Remove from batch*.
- The **Questions** page's 🗑️ is the real one and deletes the sheet row.

If a Questions-page delete genuinely did not stick, the row had no **Question ID**
(rows written before the 30-column migration have that cell empty). Fixed: the
dashboard now also sends the row number and question text, and the sheet acts on
that row only when the text still matches. Run **`backfillQuestionIds`** once from
the Apps Script editor to give every old row a proper id.

**Clear every question and start fresh.**
Run **`clearAllQuestions`** from the Apps Script editor. It empties every subject tab,
rebuilds the canonical headers, and leaves **Config** and its Telegram thread ids
untouched. For one subject: `clearSubjectQuestions("Polity")`. Neither is reachable
over HTTP, so no dashboard button or stray request can trigger a wipe.

### Telegram

**Topics are missing, or posts go to the wrong thread.**
Run `node verify-topics.js` to check every subject's thread id against the group, then
`node verify-topics.js --fix` to create any missing ones and write the new ids back to
Config. Telegram has no API to *list* topics, so this probes each with a no-op rename.

Be careful with **`setupSpreadsheet`**: it rebuilds the Config tab. It now preserves
existing thread ids, emojis, cron settings and Active flags, but `upgradeSpreadsheet`
is the right function for an existing sheet.

### Apps Script deployment

**Already-posted questions reappeared as pending after upgrading.**
The v2 layout stored the flag and the time in one cell (`YES | 05/09/2026, 01:16 PM`)
rather than a bare `YES`. Any script version that tests for an exact `YES` reads those
rows as unposted and will send them to Telegram again. The current
`google_apps_script.js` handles the combined format and moves the buried timestamp
into `Posted At` — **paste the current version before running `upgradeSpreadsheet`.**

**"Google Apps Script needs upgrading" banner won't go away.**
The Web App at your `GOOGLE_SHEET_WEBAPP_URL` is still serving old code. Either you
ran the function in the editor without deploying (running ≠ deploying — you need
**Deploy → Manage deployments → Edit → New version**), or you pasted the code into a
different project from the one that URL points at.

**"The Apps Script is not attached to your spreadsheet".**
The code is in a standalone project created at script.google.com. Open your Sheet →
**Extensions → Apps Script** and paste it there instead. If you would rather keep the
standalone project, add a Script property `SPREADSHEET_ID` set to the long id from
your Sheet's URL, and copy that project's new `/exec` URL into `.env`.

**Analytics or the question browser show "Unknown action".**
Same cause — the deployed script predates those actions. Redeploy a new version.

## Tests

```bash
npm test
```

87 tests across three suites:

- `test/server.test.js` — every API route, input validation, and a regression test for
  each security finding (traversal, CORS, SSRF, body limits, forged authorship).
- `test/auth.test.js` — Firebase token verification against real signing attacks:
  `alg:none`, HS256 confusion, tampered payloads, expiry, wrong audience.
- `test/apps-script.test.js` — the Apps Script logic in a sandboxed Google runtime:
  header resolution, the migration, duplicate detection, filtering and the runway math.
- `test/host-authorisation.test.js` — the Firebase authorised-domain matching rule,
  pinned after a hardcoded guess wrongly flagged the live Vercel host.
- `test/payments.test.js` — plan pricing and expiry arithmetic, and the webhook
  security model: forged signatures, tampered bodies, replayed deliveries, and
  identity coming only from Razorpay's echoed notes.

---

## Project structure

```
├── server.js                 # dashboard server + JSON API (the security boundary)
├── google_apps_script.js     # Google Sheets backend — paste into Apps Script
├── send.js                   # CLI: post questions now
├── schedule.js               # CLI: cron scheduler
├── setup.js                  # CLI: create Telegram forum topics
├── dashboard/
│   ├── shared.js             # auth gate, nav, API client, shared UI
│   ├── shared.css            # dashboard chrome
│   ├── style.css             # design tokens and the upload workspace
│   ├── index.html/app.js     # Upload
│   ├── analytics.html/.js    # Analytics
│   ├── questions.html/.js    # Question bank
│   ├── automation.html/.js   # Automation
│   └── health.html/.js       # System health
├── src/
│   ├── auth.js               # Firebase ID token verification
│   ├── sheets.js             # Apps Script client
│   ├── data.js               # Sheets / Excel switch
│   ├── excel.js              # local Excel fallback
│   └── telegram.js           # Telegram Bot API
└── test/                     # 75 tests
```

## Notes

- Telegram caps quiz explanations at 200 characters; longer ones are truncated in the
  poll and sent in full as a spoiler message underneath.
- Questions over 290 characters are posted as a message followed by a short poll,
  because Telegram caps poll question text at 300.
- Sends are spaced 1.5 seconds apart to stay well inside Telegram's rate limits.

## License

ISC
