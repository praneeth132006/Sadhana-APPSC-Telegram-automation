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
| 🤖 | **Automation** (`/automation.html`) | Post to Telegram straight from the browser. Queue batches for a planned time, or take them back out. Hand the queue to **Autopilot** and let it post unattended. See every subject's cron cadence and remaining runway. |
| 💳 | **Members** (`/members.html`) | Paying members, revenue by plan, who is about to lapse, and a dry run of the nightly expiry sweep. |
| 🎟 | **Pass & Coupons** (`/pricing.html`) | The pass students buy — name, price, valid-until date — and coupon codes with their usage. |
| 🆘 | **Support** (`/support.html`) | Student tickets: read the conversation, reply, send a new invite link, check a payment, grant a pass, resolve. |
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

### Adding a group (EPFO is the worked example)

A group is an entry in `groups.config.json` plus five values in `.env` (and on
Vercel). Nothing else is copied: the dashboards, the bot, the webhooks and the
nightly jobs all read the list of groups from the config. For EPFO:

1. **Payment bot.** Create it with @BotFather → `TELEGRAM_PAYBOT_EPFO`.
2. **Telegram group.** Enable Topics. Add the questions bot as an admin (Manage
   Topics, Post Messages, Send Polls) and the EPFO payment bot as an admin (Invite
   Users via Link, Ban Users). Its id → `TELEGRAM_GROUP_EPFO`
   (`node group-setup.js --chat-ids` lists the groups the payment bots can see).
3. **Sheet.** Create a Google Sheet, open Extensions → Apps Script from it, paste
   **`apps-script/epfo.gs.js`** (not `google_apps_script.js` — the generated file
   already carries EPFO's 13 subjects), run `setupSpreadsheet`, set the `API_TOKEN`
   script property, and deploy as a Web App. The `/exec` URL → `SHEET_URL_EPFO`, the
   token → `SHEET_TOKEN_EPFO`.
4. **Sheets API.** Share the sheet with the service account in
   `GOOGLE_SERVICE_ACCOUNT_JSON` as an Editor, and put its link in `SHEET_ID_EPFO`.
   The same service account serves every group.
5. **Topics, webhook, profile.** Once deployed with those values:

   ```bash
   node setup-topics.js epfo
   npm run set-webhooks
   npm run bot-profile
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

`Posted`, `Sending` and `Deleted` are written by the machinery, not by hand. Each is
paired with what the `Posted` column says, and setting one by hand desynchronises the
row — the question then claims to be posted and is sent again anyway.

**Why `Dup Hash` matters:** the question text is lowercased and stripped of
punctuation and whitespace before hashing, so re-pasting the same question with
different formatting is still recognised as a duplicate rather than silently doubling
your bank.

---

## Autopilot — posting without watching

The Automation page can run the queue down on its own: **every N minutes, post the
next M questions, until there is nothing left.**

Each run is exactly what the Post button does — reserve the rows first, send each
poll, then mark the sheet — so a question is never sent twice and a run that fails
halfway hands back what it did not send. Beyond that:

- **Runs never overlap.** A job still posting is not started again, and the next run
  is timed from when the last one *finished*. A batch of 20 takes minutes; counting
  from the start would stack runs on a job that is already behind.
- **One job per subject.** Starting a subject that is already running changes its
  settings in place rather than racing a second job against the first.
- **It stops when the queue is empty** — after three empty runs in a row, not one,
  because a batch can land exactly on the end of the queue. A Telegram outage is
  never mistaken for an empty queue: it is recorded as a failure and retried.
- **It survives a restart.** Running jobs are written to `.autopilot-state.json` and
  picked back up, without replaying every run that came due while the server was
  down.
- **Every run is recorded**, so a job that quietly stopped posting can be asked why
  days later.

Optionally it also checks for deleted polls every few runs (see below).

**Autopilot needs a server that stays up.** On a serverless deployment the server
only exists while it is answering a request and is thrown away afterwards, along with
any job started from the dashboard — there is no process left to wake up five minutes
later and post the next batch. The page says so plainly when that is where it is
running. `npm run dashboard` on a machine that does not sleep, or any always-on host,
works with no extra setup. The nightly deleted-poll check is unaffected either way:
it is driven by a scheduled job rather than by a timer in the process.

---

## Deleted polls, and keeping the sheet honest

Telegram never tells a bot that one of its own messages was deleted — there is no
such notification in the Bot API, and no "get message" call either. The only way to
know is to ask about each posted poll in turn, which is what the check does.

**What happens when a poll is found missing:** the question is marked
`Status = Deleted` in the sheet, with a note saying when it was spotted. Its
`Posted` column stays `YES`, and that is the point — it is what keeps the row out of
the posting queue. Deleting a poll from the group is nearly always a decision that
the question should not be there, so it must not quietly go back out. Nothing is
erased: the row, the question, the message id and the history all stay.

**Re-queueing** is the opposite choice, for a poll deleted by accident that you do
want posted again. It sets the row back to `Approved` and clears its message id, so
it becomes eligible. It is offered on the Automation page and is never what an
unattended run does.

The check runs three ways:

| | When | What it does |
|---|---|---|
| **Check the channel for deleted polls** | You press it | Reports first, writes only after you confirm |
| **`/api/cron/reconcile`** | Nightly, per `vercel.json` | Marks, taking each group's subjects in rotation |
| **Autopilot** | Every few runs, if switched on | Marks, on the subject it is posting |

A poll Telegram will not answer about is always left alone. Guessing "deleted" would
retire a question that is live in the channel, which is worse than not knowing.

Each row costs one Telegram call and a rate-limit pause, so a channel with hundreds
of posts cannot be swept in one pass. Each pass carries on from where the last one
stopped and wraps around, so the newest posts — the ones most likely to have just
been deleted — are reached rather than being stuck behind the same first rows for
ever. A row already marked `Deleted` is settled and is not asked about again.

---

## Queueing, and taking it back

**Queue for Later** sets `Status = Scheduled` and fills `Scheduled For`, so the next
run picks those questions first. It posts nothing by itself.

**Unqueue Questions** is the way back: it takes the same number of *queued* questions,
sets them to `Approved` and clears `Scheduled For`. Nothing is deleted, and a question
already sent — or being sent right now — is never touched.

Both report what they actually changed. An id that is not in that subject's tab, and a
row the poster is holding, are each named rather than being folded into a count: a bare
"0 questions queued" cannot tell you which of the two it was.

---

## What each group sells

| Groups | Pass | Pay | Ends |
|---|---|---|---|
| **Newspaper · English, Newspaper · Telugu** | ♾️ Lifetime Pass | once | never |
| Sadhana APPSC · English, Sadhana APPSC · Telugu, UPSC | 🎯 Target 2026 Pass | once | on exam day (`EXAM_PASS_END_DATE`) |
| EPFO | 🎯 Target EPFO Pass | once | on the EPFO exam day (`EPFO_PASS_END_DATE`, tentatively 31-03-2027) |

Every pass is ₹199, paid once. There are no refunds.

Which pass a group sells is `passPlanId` in `groups.config.json`, defaulting to
`exam_pass`. The two newspaper groups and EPFO set it. The pass definitions are shared by
every group, so changing what one group sells never touches another.

A lifetime member is written with an expiry of 31-12-2099 — a real date, so every
column that sorts, filters and parses Expiry Date keeps working — but the daily sweep
does not rely on that date: it reads the pass they bought and never reminds or removes
a lifetime member.

**Members who bought the exam pass in a newspaper group before the change keep what
they paid for:** it still ends on exam day, and they can upgrade to lifetime from the
bot. Lifetime is decided by the pass a member bought, never by the group they are in,
so nobody is upgraded for free by the group changing.

---

## Tabs that are not subjects

A group's workbook holds question tabs and tabs that are nothing of the kind — Config,
Subscribers, Support, Coupons, Referrals. `src/sheet-tabs.js` names the second kind and the
server filters them out of Analytics itself, so a new tab never shows up as a paused subject
at 0% again, and fixing it never needs the Apps Script pasted into five sheets.

## The bot: what people see

Three things live on Telegram's servers rather than in this repository — the
description shown **before** anyone presses Start, the line under the bot's name,
and the ☰ Menu. Nothing in a deploy touches them, so they drift. `npm run bot-profile`
writes all three to every payment bot, and is safe to run as often as you like:

```bash
npm run bot-profile          # write commands and descriptions
npm run bot-profile:status   # show what Telegram currently holds
```

The menu is `/start`, `/about`, `/plans`, `/status`, `/referral`, `/help`, `/support`.
`/start` is one welcome message with a **Continue →** button — the pass is shown when
they tap it, not unasked.

**Where the menu is written matters.** Telegram keeps a separate list per *scope* and
shows the most specific one that has anything in it. In a private chat that is
`all_private_chats`, which beats `default` — so a list written only to `default` is
never seen by a student. The menus are written to:

| Scope | List | Why |
|---|---|---|
| Private chats | the student commands | where every one of them works |
| The bot's support chat | the admin commands | `/summary`, `/tickets`, `/find`… |
| Default | cleared | the paid groups fall back to it, and the bot answers no command there |

There is one list, in `src/bot-commands.js`. `set-webhooks` and `bot-profile` both read
it; they used to keep one each, in different scopes, and students saw neither the new
commands nor any sign that they existed. `npm run bot-profile:status` reports what a
student is actually shown, read back from Telegram.

---

## Referrals — invite a friend

A member sends `/referral` and gets a code and a share link. Whoever follows that link
pays **10% less** on their first pass, and the member earns **20% of what that person
actually paid**, in rupees.

**Commission is on what was paid, never on the list price.** The discount comes off
first, so a ₹199 pass sold through a referral is ₹179.10 to the buyer, ₹35.82 to the
inviter, and ₹143.28 kept. Paying 20% of ₹199 would quietly pay out more than the sale
brought in.

**How a member uses it**

| | |
|---|---|
| `/referral` | Their code, their share link, and their running total |
| Share link | `https://t.me/<bot>?start=ref_REFXXXXXX` — the discount is applied on the first screen the friend sees |
| Typing the code | Also works, in any case, with or without the `ref_` prefix |

**The rules**

- **One code per member**, however many times they ask. A second code would split
  their earnings in two, and neither half would ever reach a payout.
- **Any number of people can join on one code.** The limit is one referral per
  *buyer*, never a cap on the code itself.
- **A claim button appears at ₹1000** and not a rupee before. Claiming raises a
  support ticket; an admin sends the money and presses **Mark paid**.

**And why**

- **A code works once per person, on their first pass.** Otherwise a member renewing
  monthly would earn their friend a commission every month for one introduction.
- **You cannot invite yourself.** That is a discount you wrote yourself, plus
  commission on your own purchase.
- **A code is re-checked when the Pay button is tapped**, never trusted from the
  button. A tap on yesterday's message must not buy at yesterday's terms.
- **Commission is only ever created from a payment that succeeded**, recorded against
  its Razorpay payment id. Razorpay retries a webhook on any non-2xx, and without that
  id one sale would pay an inviter once per delivery.
- **A code can be switched off** without touching what it has already earned.

**Getting paid**

Earnings sit as `pending`. A member can ask to be paid once they pass **₹1000**, and
the monthly run pays everyone with anything pending. Asking raises a support ticket —
nothing here moves money. An admin sends it, then presses **Mark paid** on the
Referrals page, which records that they did.

**Where it all lives**

Two tabs on the family's primary sheet, created on first use and upgraded in place when
columns are added (new ones only ever go on the end, so no existing row moves):

**Referrals** — one row per member with a code. Besides who they are, every row carries a
live summary rebuilt from the log whenever anything changes for that code:

| Column | What it holds |
|---|---|
| Code, Telegram ID, Username, Name | who owns the code |
| Share Link | the link they send |
| Link Opens, Opened By (IDs) | every different person who opened it — including those who never paid |
| Joined, Joined IDs, Joined Usernames | everyone who paid using it |
| Total Earned, Pending, Paid Out | what it has earned, owes, and has paid |
| Last Joined At, Updated At | when |

**Referral Log** — one row per referred payment: a short referral id (`RL-0001`), who invited
(id, username, name), who joined (id, username, name), the group and pass, the Razorpay
payment id, the original price, discount, amount paid, commission, and payout status.

The summary is always worked out again from the log, never incremented, so a retried webhook
or a hand-edited row cannot leave it drifting. **🔁 Rebuild sheet** on the Referrals page
rewrites every summary on demand and fills in any blank share links.

The **Referrals** page shows the same, with detail: every referrer is a row that opens into
everyone who joined through them — name, username, Telegram ID, group, pass, date, amounts,
payment ID — and everyone who opened their link, marked joined or not. Filter by status,
group or anything searchable; **⬇ Export CSV** downloads every referral with both sides' ids.

In the bot, referrals are their own section — **🎁 My referral** on the welcome screen and
`/referral` — rather than a button under Pay. The card shows the code to tap-copy, how many
opened the link, who joined (first names only; another member's id is never shown), what
is owed, and how far there is to go before they can claim.

The percentages and the payout threshold are editable on **Pass & Coupons** without a
deploy, and referrals can be switched off there entirely.

> Referrals need the Google Sheets API — a service account and `SHEET_ID_<PREFIX>`.
> They were built after that route replaced the Apps Script, and putting them in both
> would mean pasting a script into five sheets by hand to turn the feature on.

---

## When nobody answers

Support is a chat, and a chat with nobody on the other end gives a student no way
to tell whether they have been forgotten or are simply early. So there is a second
door: **appscsadhana@gmail.com**, editable in Bot Settings.

It is offered in the same words everywhere, so it reads as a standing promise rather
than a special case:

| Where | What it says |
|---|---|
| The support menu, `/help`, `/about` | *If you do not hear back, email us at …* |
| When a ticket is raised | The same line, under the confirmation |
| On a follow-up **no admin has ever replied to** | *Still waiting? Email us at … and we will pick it up there.* |
| Tickets switched off, or a ticket that failed to submit | Alongside the fallback contact |
| A referral payout request | The same line — it is money, and one door is not enough |

The escalation counts **admin replies**, not who the ticket is waiting on: appending
the student's own message sets "waiting on admin", so that field is true of every
follow-up and would make the escalation meaningless. No reply ever, on a message they
have now sent twice, is the real signal.

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

npm run bot-profile                       # set each bot's menu and description
npm run bot-profile:status                # see what Telegram currently holds

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

**A verified email is required, always.** Being on `CURATOR_EMAILS` used to be treated
as enough on its own, and that was a hole: anyone can register a Firebase password
account for an address they do not own, so an allowlisted address that had never
actually signed in could simply be claimed. Google sign-in arrives verified, so this
costs a real curator nothing.

### When a session lapses

The server answers **401** when a new token would fix the problem — an expired session,
a drifted clock, a token from another project — and **403** only when the identity itself
is refused. Both used to be 403, so a session that had simply lapsed reached the
dashboard as a permissions problem, telling a curator to add themselves to
`CURATOR_EMAILS` when all they needed was to sign in again.

The dashboard acts on the difference:

| Server says | Dashboard does |
|---|---|
| 401 | Asks Firebase for a **fresh** token and retries once, silently |
| 401 again | Signs out and puts the sign-in card back — once, however many requests noticed |
| 403 | Shows why the account is refused, and does not retry |

If Google's certificate endpoint is unreachable, the server keeps verifying against the
keys it already holds rather than rejecting every curator for as long as the outage
lasts.

---

## Paid group access (Razorpay)

Students buy a pass from the Telegram bot and are let into a private group
automatically. Each group sells one pass, at ₹199, paid once — see
[What each group sells](#what-each-group-sells). The 30-Day Sprint and Monthly
Auto-Pay passes are retired: no longer sold, but still defined so the few members
who bought one keep resolving.

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

### The pass and coupon codes

One pass is sold: the **exam pass**, ₹199 by default, valid until a fixed date.
The 30-day and monthly auto-pay passes are retired — no longer offered, but
members who already hold one keep working (their renewals, reminders and
`/cancel` still function).

From the dashboard's **🎟 Pass & Coupons** page (or `/set` in the support chat)
an admin can change, per payment bot:

- the **pass name** (the exam it is for), **price**, **valid-until date** and
  **description** — a blank field uses the built-in value;
- **coupon codes**: ₹ off or % off, optional expiry date, optional maximum number
  of uses, one use per student or unlimited, on/off.

A student applies a code from `/plans` → **🎟 Apply coupon code**, sees the
discounted price, and pays. The code is checked again when they tap Pay, and a use
is counted only when the payment succeeds (Coupon Redemptions tab). A code that
has been used cannot be deleted — switch it off instead. The price after a
discount must stay at least ₹1. Payment links already sent keep the price and date
they were created with.

Sheet tabs involved: **Bot Settings** (pass name/price/date), **Coupons**,
**Coupon Redemptions**.

### Bot commands

| Command | What it does |
|---|---|
| `/start`, `/plans` | Show the pass (choose a group first where a bot sells two) |
| `/status` | Current pass, expiry date, days left |
| `/help` | How buying works |
| `/support` | Help topics with instant answers, and a way to raise a ticket |
| `/cancel` | Only for members still on the old monthly auto-pay: stop future charges |

Typing any ordinary message to the bot also offers to send it to support, or adds
it to the student's open ticket.

### Support: how it works

A student picks an issue in `/support` — *Paid, but no invite link*, *Invite link
not working*, *Payment failed or money deducted*, *Coupon code not working*,
*Removed from the group* or *Something else* — and gets an instant answer. If
that does not help they raise a ticket (text or a screenshot). Each ticket is:

- written to the **Support** tab of the sheet of the first group the bot sells,
  and every action on it to the **Support Log** tab;
- posted to the admin **support chat** (`SUPPORT_CHAT_ID`) as a case file:
  the student, each pass they hold, whether they are in the group, what they
  wrote, and a 🧭 suggested next step;
- listed on the dashboard's **🆘 Support** page.

Anything the student sends while they have a ticket touched in the last 7 days
joins that ticket (an open one first, otherwise the most recently closed one,
which reopens). Each follow-up in the support chat shows the earlier
conversation.

**Ticket statuses** (Status column H, and shown everywhere). Only an admin
closes a ticket — with ✅ Close, the *Resolved* quick reply, or "close after
sending" on the dashboard. Nothing closes one automatically.

| Status | Shown as | Means | Becomes |
|---|---|---|---|
| `open` | 🆕 Open | New — no admin has done anything with it yet | `in_progress` on the first admin action (reply, quick reply, invite, payment check, grant) |
| `in_progress` | 🟡 In progress | An admin has picked it up | `closed` only when an admin closes it |
| `closed` | ✅ Closed | An admin closed it | `in_progress` if the student writes again, or an admin reopens it |

Separately, **Waiting On** (column Q) says who has to act next, so an in-progress
ticket can still need a reply:

| Waiting On | Shown as | Means |
|---|---|---|
| `admin` | 🔴 Needs reply | The student wrote last |
| `student` | ⏳ Waiting for student | An admin wrote to the student last |
| blank | — | Closed |

The Support tab records, per ticket: **Handled By** (last admin), **Admin Replies**,
**Last Admin Reply At**, **Closed At / Closed By**, **Waiting On**, **Picked Up By /
Picked Up At** (the first admin to act), **First Reply At** and **Times Reopened**.
Old rows are upgraded automatically (`answered` becomes `in_progress`). The
**Support Log** tab has one row per event — ticket opened, student message,
picked up, admin reply, quick reply (which one), invite sent / not sent, payment
checked, pass granted / refused, closed, reopened — with who did it, their role
and the status afterwards.

**At a glance.** The dashboard's Support page shows Needs reply, Open, In
progress, Closed and All tickets, then average and median time to first reply
and to close, today's opened/closed, and the longest-waiting student; the
📈 Analysis section breaks tickets down by issue type and shows what each admin
did. In Telegram, `/summary` shows the same numbers with buttons to list each
queue, and the daily job posts it to the support chat every morning (around
6:30 AM IST; set `SUPPORT_DAILY_SUMMARY=off` to stop it).

### Support: the admin handbook

Everything below works both in the Telegram support chat (buttons under each
ticket) and on the dashboard's Support page, and both write to the same sheet.

| Option | Use it when | What happens |
|---|---|---|
| ✍️ **Write reply** | You need to say something specific | You type an answer; the bot sends it to the student. In Telegram you can also simply reply to any ticket message |
| 📋 **Quick replies** | A common answer fits | One tap sends a ready answer: *Ask for payment proof*, *Payment not received*, *Payment still processing*, *Pass has expired*, *New link sent*, *How to use a coupon*, *Resolved — close ticket*. Texts are editable |
| 🔗 **Send new invite link** | The pass is valid but the link failed, expired or never arrived | A fresh single-use link is sent for each group where the pass is valid. Nothing is sent without a valid pass — you are told why |
| 🎟 **Pass & payment** | You want to see what they hold | Each group: valid / expired / none, expiry, amount paid, payment id, in the group or not, plus a suggestion |
| 🔍 **Check payment** | The student sent a `pay_…` id (the button appears automatically) | Razorpay's answer: captured / failed / processing, amount, time, and whether it came from this student's checkout |
| ✅ **Grant pass for this payment** | Check payment shows *captured* but the student has no pass | Asks which group, checks Razorpay again, refuses a payment already used by another student, then gives the pass and sends the invite link |
| 📜 **History** | You are picking up someone else's ticket | The whole conversation and the recent actions |
| ✅ **Close ticket** / 🔓 **Reopen** | It is sorted / it is not | Only an admin closes a ticket; closing tells the student it is resolved. Reopening puts it back to In progress |

Typical cases:

- **"I paid but did not get the link"** — look at the 🧭 suggestion. Valid pass
  and not in the group → 🔗 Send new invite link. No pass → 📋 *Ask for payment
  proof*; when they send the `pay_` id → 🔍 Check payment → if captured,
  ✅ Grant pass; if failed → 📋 *Payment not received*; if processing →
  📋 *Payment still processing*.
- **"The link does not work"** — valid pass → 🔗 Send new invite link, then
  📋 *New link sent*. Expired → 📋 *Pass has expired*.
- **"My coupon does not work"** — check the code on Pass & Coupons (live, expired,
  used up, already used by this student), then reply.
- **"I was removed"** — 🎟 Pass & payment: expired → 📋 *Pass has expired*;
  valid → 🔗 Send new invite link.

Support chat commands:

| Command | What it does |
|---|---|
| `/summary` (or `/stats`) | Needs reply, open, in progress, waiting for student, closed; today; reply times; longest waiting; open tickets by issue; each admin's last 7 days. Buttons list each queue; 🔄 refreshes it in place |
| `/tickets` | Tickets needing a reply, longest waiting first, each with its buttons. Also `/tickets open`, `progress`, `student`, `closed` |
| `/msg 7234356929 text` or `/msg @username text` | Message a student first — it opens a ticket so their reply is tracked |
| `/settings`, `/set key value` | Bot texts, pass name, price and date |
| `/supporthelp` | This list, in Telegram |

Student commands (`/start`, `/plans`, `/status`, `/help`, `/cancel`) only answer
in a private chat with the bot, never in a group. Running `npm run set-webhooks`
also sets the "/" command menus: student commands in private chats and the admin
commands above in the support chat.

Anyone in the support chat can do all of this, so keep it to admins. Messages
sent to students from your own Telegram account are not tracked — use the bot.

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

729 tests. The ones worth knowing about:

- `test/server.test.js` — every API route, input validation, and a regression test for
  each security finding (traversal, CORS, SSRF, body limits, forged authorship).
- `test/auth.test.js` — Firebase token verification against real signing attacks:
  `alg:none`, HS256 confusion, tampered payloads, expiry, wrong audience — plus which
  failures ask for a new token and which do not, and surviving a Google outage.
- `test/dashboard-auth.test.mjs` — the browser's `api()` loaded for real with Firebase
  stubbed, so the token refresh and the lapsed-session path actually run.
- `test/referrals-page.test.mjs` — the real Referrals page rendered against a fake DOM, and
  read back: rows, Telegram ids, the drill-down. Written after that page shipped showing
  headers and nothing else.
- `test/apps-script.test.js` — the Apps Script logic in a sandboxed Google runtime:
  header resolution, the migration, duplicate detection, filtering and the runway math.
- `test/host-authorisation.test.js` — the Firebase authorised-domain matching rule,
  pinned after a hardcoded guess wrongly flagged the live Vercel host.
- `test/payments.test.js` — plan pricing and expiry arithmetic, and the webhook
  security model: forged signatures, tampered bodies, replayed deliveries, and
  identity coming only from Razorpay's echoed notes.
- `test/sheets-direct.test.js` — the posting path and the curation queue against an
  in-memory spreadsheet, checked to write exactly what the Apps Script writes: the
  two share every sheet, so each has to understand the other's marks.
- `test/autopilot.test.js` — the unattended scheduler on a fake clock: overlapping
  runs, an empty queue, a Telegram outage being mistaken for an empty queue, and a
  restart neither forgetting its jobs nor stampeding through every missed run.
- `test/referrals.test.js` — the money arithmetic: commission on what was paid rather
  than the list price, self-referral, a code used twice, rounding, and what a member
  is owed.
- `test/referral-bot.test.js` — the student side, ending in what actually reaches
  Razorpay's notes, since that is what the commission is later calculated from.

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
│   ├── referrals.html/.js    # Referral tracking and payouts
│   ├── automation.html/.js   # Automation
│   └── health.html/.js       # System health
├── src/
│   ├── auth.js               # Firebase ID token verification
│   ├── sheets.js             # Apps Script client
│   ├── sheets-direct.js      # Google Sheets API client (the posting path)
│   ├── autopilot.js          # unattended "every N minutes, post M" scheduler
│   ├── referrals.js          # referral codes, discounts, commission and payouts
│   ├── bot-commands.js       # the one command menu and description every bot uses
│   ├── sheet-tabs.js         # which workbook tabs are subjects and which are not
│   ├── data.js               # Sheets / Excel switch
│   ├── excel.js              # local Excel fallback
│   └── telegram.js           # Telegram Bot API
└── test/                     # 729 tests
```

## Notes

- Telegram caps quiz explanations at 200 characters; longer ones are truncated in the
  poll and sent in full as a spoiler message underneath.
- Questions over 290 characters are posted as a message followed by a short poll,
  because Telegram caps poll question text at 300.
- Sends are spaced 1.5 seconds apart to stay well inside Telegram's rate limits.

## License

ISC
