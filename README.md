# Velv Ticketing Platform

[![Tests](https://github.com/Yuwr1d4g0at/velv-ticketing-platform-vercel/actions/workflows/test.yml/badge.svg)](https://github.com/Yuwr1d4g0at/velv-ticketing-platform-vercel/actions/workflows/test.yml)

A basic internal helpdesk ticketing tool: a public request form for people to
submit issues, and a staff dashboard to triage, assign, and resolve them.

## Stack

- **Node.js + Express**, server-rendered with **EJS** templates (no frontend build step)
- **Postgres** via [Neon](https://neon.tech) (provisioned through the Vercel Marketplace, `vercel install neon`) — accessed through a thin sync-shaped `prepare()` adapter (`src/db/index.js`) over `@neondatabase/serverless`
- Session-based auth (**express-session**) with **connect-pg-simple** (Postgres-backed), so logins survive a redeploy
- File attachments stored in **Vercel Blob**, not local disk
- Full-text ticket search via Postgres `tsvector`/`ts_rank` (a generated column + GIN index on `tickets`)
- Background jobs (SLA/warranty/contract/consultant-engagement/recurring/digest checks, nightly backups) run via **Vercel Cron** hitting `/api/cron/*`, plus an opportunistic in-request trigger during business hours — see `src/periodicChecks.js`
- Passwords hashed with **bcryptjs**
- **helmet** for security headers, **express-rate-limit** on the login form, and a hand-rolled CSRF token on every state-changing form
- Optional "Sign in with Microsoft" (Entra ID) via **openid-client** — off unless configured, see below
- Optional error tracking via **Sentry** (`SENTRY_DSN`) — off unless configured; without it, unhandled errors and cron-job failures only show up in Vercel's function logs

Deployed on **Vercel** (Hobby plan) — live at [helpdesk.velv.pt](https://helpdesk.velv.pt). Requires **Node.js 22.5+**.

## Getting started

```bash
npm install
vercel link                # link this project to the Vercel project
vercel env pull .env       # pulls DATABASE_URL, BLOB_READ_WRITE_TOKEN, etc.
```

Or, without the Vercel CLI, `cp .env.example .env` and fill in `DATABASE_URL`
(a Neon Postgres connection string) and `BLOB_READ_WRITE_TOKEN` (a Vercel
Blob store token) by hand from the Vercel dashboard's Storage tab.

Then:
- Set `SESSION_SECRET` and `CRON_SECRET` to long random strings if `vercel
  env pull` didn't already set them. Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- Run `npm run migrate` once against the database before starting the app
  for the first time — creates every table if it doesn't exist yet.
- Leave `PORT` and `COOKIE_SECURE` as-is for local development.
- Email notifications are optional and off by default — leave `SMTP_HOST` blank
  to skip them entirely. Fill in the `SMTP_*` vars (and optionally `APP_URL`,
  for a clickable link in the emails) to have requesters get an email when
  their ticket is created and whenever its status changes.

Create the first helpdesk agent account:

```bash
npm run seed
```

This prompts for a name, email, and password (min. 8 characters). Run it
again any time to add more agents — or use the "Add an agent" form on the
dashboard's Agents page once you're logged in.

Start the server:

```bash
npm start          # production
npm run dev         # restarts automatically on file changes
```

Visit `http://localhost:3000` for the request form, and
`http://localhost:3000/login` for the staff dashboard.

## Microsoft 365 SSO (optional)

One Entra ID app registration, two separate uses of it - both controlled by
the same `MS_TENANT_ID`/`MS_CLIENT_ID`/`MS_CLIENT_SECRET` env vars, both off
entirely until you configure them:

- **Agent login** - agents can sign in with their Microsoft 365 account
  instead of a password, on top of the existing username+password login
  (kept as a fallback either way). Signing in with Microsoft only ever logs
  someone in if their email already matches an existing, active agent
  (added the normal way, from the dashboard's Agents page or `npm run
  seed`) — it never creates a new agent by itself.
- **Requester identification on the public request form** - once
  configured, submitting a ticket *requires* signing in with a Microsoft
  365 account first (the public form is no longer reachable without it),
  and the ticket's name/email are taken from that verified account, not
  freely typed. Unlike agent login, there's no allow-list here - any
  successfully authenticated account in your tenant can file a ticket.

**Important:** adding someone to your Microsoft 365 tenant does **not** by
itself give them dashboard/agent access - that still requires an explicit
agent row. It's enough, on its own, for them to sign in and submit tickets.

Setup (needs Azure AD / Entra ID admin rights on your tenant):

1. Go to [entra.microsoft.com](https://entra.microsoft.com) (or the Azure
   Portal → Microsoft Entra ID) → **App registrations** → **New registration**.
2. Name it anything (e.g. "Velv Ticketing Platform"). Under **Supported
   account types**, choose **"Accounts in this organizational directory
   only"** (single tenant) — this is an internal tool, not a multi-tenant app.
3. Under **Redirect URI**, choose platform **Web** and enter
   `<APP_URL>/auth/microsoft/callback` (the agent login one) — using the
   exact same `APP_URL` you'll set below (e.g.
   `https://helpdesk.velv.pt/auth/microsoft/callback`).
4. Click **Register**. On the app's **Authentication** page, add **two
   more** redirect URIs (same Web platform):
   `<APP_URL>/auth/microsoft/requester/callback` (the request-form one), and
   `http://localhost:3000/auth/microsoft/callback` +
   `http://localhost:3000/auth/microsoft/requester/callback` too if you
   also want to test locally (four URIs total on one app registration).
5. On the **Overview** page, note the **Application (client) ID** and
   **Directory (tenant) ID**.
6. Go to **Certificates & secrets** → **New client secret**. Copy the
   secret's **Value** immediately — it's only ever shown once.
7. The default delegated Microsoft Graph permissions (`openid`, `profile`,
   `email`) are enough for sign-in — no extra API permissions or admin
   consent should be needed for a single-tenant app, but check under **API
   permissions** if sign-in fails with a consent-related error.

Fill in `.env`:
```
APP_URL=https://helpdesk.velv.pt      # must match the redirect URIs above
MS_TENANT_ID=<Directory (tenant) ID>
MS_CLIENT_ID=<Application (client) ID>
MS_CLIENT_SECRET=<the secret Value from step 6>
```

### Directory enrichment & the SharePoint asset sync (also optional)

Two more things reuse this same app registration and the same three env
vars above, but need **Application permissions** (not just the Delegated
sign-in scopes above) with **admin consent**, since they run without any
one person being signed in:

- **Directory enrichment** (`src/directory.js`) — shows a requester's or
  agent's department, job title, phone, and photo (pulled from the tenant
  directory, cached for 24h) on the ticket detail and Agents pages. Needs
  the `User.Read.All` Application permission.
- **Asset inventory sync** (`src/assetSync.js`,
  `/dashboard/settings/asset-sync`) — pulls the Hardware Inventory
  SharePoint list on a schedule (`ASSET_SYNC_INTERVAL_HOURS`, default 24;
  or "Sync now" on that settings page) instead of the one-time manual CSV
  import (`scripts/import-assets.js`). Needs `Sites.Read.All`.

Both degrade silently (no enrichment shown, sync run logged as failed)
until consent is granted — nothing breaks in the meantime. To grant it:

1. On the app registration → **API permissions** → **Add a permission** →
   **Microsoft Graph** → **Application permissions** (not Delegated).
2. Add `User.Read.All` and `Sites.Read.All`.
3. Click **Grant admin consent for &lt;your tenant&gt;** — permissions
   alone don't do anything until this is clicked.

The asset sync is a **one-way sync**: SharePoint's Asset Type, Status,
Current Owner, Serial Number, Brand, and Purchase Date fields overwrite
this app's `category`/`status`/`assigned_to_name`/`serial_number`/`vendor`/
`purchase_date` on every run, for any asset already matched by its
`HW-<source ID>` tag. `location` and `warranty_expires` have no SharePoint
source and are never touched by a sync run. A manual edit made directly in
this app's own Assets page to one of the SharePoint-sourced fields will be
overwritten the next time the sync runs.

Restart the app — the login page now shows a "Sign in with Microsoft"
button above the password form, and the public request form (`/`) now
requires signing in with Microsoft before it'll show the actual form.

## How it works

**Public (no login required, unless Microsoft SSO is configured - see above)**
- `/` — request form (name, email, category, optional freeform subcategory, subject, description, optional file attachments, optional related asset, and any custom fields defined for the chosen category). If `MS_*` SSO env vars are set, this requires signing in with Microsoft first instead - name/email then come from that account (shown as locked text, not editable fields) rather than being typed. Priority isn't set here — see below. As you type a subject, matching published KB articles are suggested live below the field, in case self-service already answers it. Submitting shows a ticket number and, if email is configured, sends a confirmation. Available in English or Portuguese — the EN/PT toggle in the header sets a `velv_lang` cookie; the dashboard itself stays English-only. Attachments can be dragged onto the file field, not just picked from a dialog. A submission can also be auto-tagged, reprioritized, and/or reassigned by any matching **automation rule** (`/dashboard/settings/automation` — simple category/keyword conditions, evaluated once at creation; agent-initiated tickets aren't affected, since those already have a human's explicit judgment applied).
- `/status` — look up a ticket's status by ticket number + the email it was submitted with, including any attachments (download requires that same ticket number + email). Image attachments (PNG/JPEG/GIF/WebP only) get a small inline preview thumbnail; everything else still only ever force-downloads.
- `/kb` — a public, searchable help center. Agents write and publish articles from the dashboard; a request form or ticket-status page reader can browse without logging in.

Both of the above are rate-limited per IP (like the login form already was) since they're unauthenticated and, for the request form, now touch disk via file uploads. A ticket is auto-assigned on creation to whichever active agent currently has the fewest open tickets, rather than starting Unassigned.

The status page also shows the requester-visible conversation (agent replies + the requester's own past replies — never internal notes) and a reply box. Replying to a Resolved or Closed ticket reopens it. The assigned agent gets a best-effort email when the requester replies, if notifications are configured.

- `/rate/:token` — a one-click satisfaction survey (1–5 stars + optional comment). The link is emailed automatically the moment a ticket is marked Resolved (only if email is configured); the token is a bearer link, not a login, since rating a ticket doesn't expose anything sensitive.

**Dashboard (login required, any active agent account)**
- `/dashboard` — all tickets, paginated, with counts by status (including **Waiting on Customer**, see below), a filter bar (status/priority/category/assignment/tag/**full-text search**), bulk status-change/reassignment/**tag add-or-remove** (select rows, apply to all of them), and a CSV export of whatever's currently filtered. Search is backed by Postgres full-text search (`tsvector`/`ts_rank`) over subject/description, not a plain substring match — requester name/email search is still a plain substring match. Tickets still open past a priority-scaled threshold (Urgent ages fastest, Low slowest, counted in **business hours** — Mon-Fri 09:00-18:00, not raw calendar time, so a ticket filed Friday evening doesn't visibly age all weekend) are flagged on the dashboard *and* proactively emailed to whoever they're assigned to (see `SLA_CHECK_INTERVAL_MINUTES` below) — once per breach, not repeatedly. A separate, usually tighter **first-response target** (editable alongside the aging thresholds) triggers its own one-time breach email if a ticket gets no agent activity at all in time. The notification bell in the header mirrors these and a few other agent-facing emails (mentions, replies, low ratings) as in-app notifications, for anyone who'd rather glance at a badge than watch their inbox. Save the current filter combo as a named view (personal to you, not shared) to jump back to it later. A **+ New ticket** button opens agent-initiated creation (see below).

  **Reports** live right alongside the ticket list, not a separate page — a sidebar next to it (below it on narrower screens) showing the running average satisfaction rating, time-to-first-response, time-to-resolution, and **reopen rate** (of tickets ever resolved, how many later got reopened — a rough proxy for "are we actually fixing things") as stat tiles, plus ticket volume for the last 30 days, a **satisfaction trend** chart by month, a per-**agent performance** table (resolved count, average resolution time, average CSAT), and breakdowns by category, status, and current agent workload. (`/dashboard/reports` still works as a link — it just redirects here now.)
- `/dashboard/tickets/:id` — full ticket detail: set priority, change status (emails the requester if notifications are configured), assign/reassign to any active agent, link/change/unlink the related asset, add/remove freeform tags, and add notes — internal by default, or marked "visible to requester" to reply publicly (emailed to them too). Note and description text supports a small safe subset of markdown (`**bold**`, `*italic*`, `[links](https://...)`); `@firstnamelastname` in a note emails that agent directly. **Watch** a ticket you're not assigned to, to get the same reply notifications as the assignee. Setting status to **Waiting on Customer** pauses the aging/first-response clock for as long as it sits there — time spent waiting on the requester never counts against the team. A 1-2 star rating shows a banner here and emails the whole active team the moment it comes in. Shows the requester's other tickets, for context. Every change is logged automatically alongside manual notes in the ticket's activity feed. A **Possible duplicates** card suggests other open tickets with an overlapping subject (ranked by relevance, not an exact-phrase match) with a one-click merge. **Related tickets** links two genuinely separate-but-connected tickets to each other (symmetric — showing up on both) without merging them. **Merge** folds an actual duplicate into another ticket (activity/attachments/tags all move over; the duplicate closes and redirects here from then on). **Print / Save as PDF** opens a clean print-styled view (just the browser's own Print dialog, not a rendering dependency). **Requester data** is a GDPR export (JSON bundle of everything on file for that email) or erasure (redacts name/email/description/note-and-reply text across *all* of that requester's tickets, and deletes their attachment files — irreversible, confirmed before it runs).
- `/dashboard/tickets/new` — agent-initiated ticket creation, for a phone call or walk-in. Unlike the public form, priority and assignment can be set immediately instead of always going through round-robin (and automation rules don't apply here — see `/` above). Optionally starts from a saved template (`/dashboard/templates`) that pre-fills category/subject/description.
- `/dashboard/recurring` — templates that auto-create a new ticket on a fixed day interval (e.g. "monthly server check"), so a routine task doesn't depend on someone remembering to file it. Pause or delete a template any time; next-run date advances automatically each time it fires, catching up by at most one ticket even if the server was down a while.
- `/dashboard/assets` — a small asset-management view: add/edit company equipment or software (name, tag, category, status, who has it, location, serial number, vendor, purchase date, warranty, notes), a CSV export, and see every ticket raised against one *and* a field-level change history (who changed what, and when) from its own page. Never hard-deleted, same philosophy as agents — retire it instead. Retired/Lost assets stop showing up as a pickable option (the request form, the ticket-linking dropdown) but stay reachable and editable. An asset within `WARRANTY_ALERT_DAYS` of its warranty expiring gets a badge on the list *and* a one-time email digest to every active agent (changing the warranty date lets it alert again later).
- `/dashboard/consultants` — a persistent record HR and Legal use to track external consultants they engage (outside counsel, recruiters, expert witnesses, trainers, ...) — not a ticket, its own lifecycle: name, company, specialty, contact details, department, status (Active/Ended), engagement start/end dates, rate, an assigned internal agent, notes, a field-level change history, and CSV export, modeled closely on Assets. Strictly department-scoped like tickets (an HR agent sees only HR's consultants, Legal only Legal's, admins see everyone), with a confidential flag that's gated even tighter than a ticket's — only an admin or the consultant's own assigned agent can toggle it or see one that's marked confidential. A consultant within `CONSULTANT_ENGAGEMENT_ALERT_DAYS` of their `engagement_end` date gets a one-time email digest to that consultant's own department's active agents (changing the date lets it alert again later, same idea as the asset warranty/Legal contract-reminder alerts).
- `/dashboard/kb` — write and publish/unpublish knowledge-base articles (see `/kb` above). Link one into a ticket note in one click from the note form.
- `/dashboard/canned-responses` — a shared library of reusable note text any agent can insert into a note in one click.
- `/dashboard/agents` — list of agents (active and deactivated) and a form to add new ones, plus deactivate/reactivate. All agents currently share one role — anyone logged in can manage any ticket and add other agents. Deactivating (never deleting, to keep their activity history intact) revokes login immediately, even for an already-open session, and excludes them from new assignments; you can't deactivate your own account or the last active agent.
- `/dashboard/settings` — editable aging thresholds and first-response targets (used for the "Aging" badge and both SLA emails, previously a hardcoded constant), plus links to:
  - `/dashboard/settings/webhooks` — POST a signed JSON payload (HMAC-SHA256 in an `X-Velv-Signature` header) to any URL on `ticket.created` / `ticket.status_changed` / `ticket.assigned`.
  - `/dashboard/settings/login-log` — every login attempt, successful or not, with IP and user agent — for spotting a compromised account.
  - `/dashboard/settings/custom-fields` — a text field scoped to one category (e.g. "System name" only on Account & Access), shown on the public form, agent-initiated tickets, and the ticket detail page whenever that category's picked.
  - `/dashboard/settings/automation` — simple "if category/keyword, then tag/priority/assignment" rules, evaluated once when a ticket comes in through the public form (see `/` above).

Each active agent can also get a **daily digest** email (their own open/aging tickets, once a day at `DIGEST_HOUR`, default 8am) if notifications are configured — same opt-in-via-`SMTP_HOST` rule as every other email in this app, nothing to turn on separately.

`/healthz` (no login) reports `{"status":"ok"}` after a real DB connectivity check — for a host or uptime monitor to poll, not a browser.

**Accessibility**: a "Skip to main content" link (visible on keyboard focus), `role="alert"`/`role="status"` on validation messages and banners so a screen reader announces them, and `scope="col"` on data table headers.

## Data

Everything lives in Postgres (Neon, via `DATABASE_URL`) — see `scripts/migrate.js`
for the full schema. Sessions live in the same database, in a `session`
table managed by `connect-pg-simple`.

Uploaded attachments live in Vercel Blob, named with a random id (never the
original filename), with the real filename, size, uploader, and whether the
requester can see it kept in the database alongside the Blob pathname.

### Backups

```bash
npm run backup
```

Writes a timestamped JSON export of every real data table (see
`scripts/backup.js`'s `TABLES` list — everything except `session`, which is
ephemeral login state, and `directory_cache`, a self-healing 24h cache) plus
a manifest of every attachment currently in Vercel Blob (pathname/size/
upload time, not the file bytes themselves — Blob already handles its own
durability, so a backup only needs to record what exists and where). The
whole thing is written to Blob itself, under `backups/`, since this runs
from a Vercel Function with no persistent disk to write to. Keeps the 14
most recent backups by default and prunes older ones — override with
`BACKUP_KEEP` in `.env`.

Runs nightly at 3am UTC via Vercel Cron (`vercel.json`'s `crons` entry hits
`/api/cron/backup`, gated by `CRON_SECRET` the same way
`/api/cron/periodic-checks` is) — no separate scheduling setup needed once
deployed. Run it manually any time with the command above.

#### Restoring from a backup

```bash
npm run restore -- latest --yes
# or a specific one:
npm run restore -- backups/2026-01-15T03-00-00-000Z.json --yes
```

**Destructive** — truncates every table the backup covers and replaces it
with that snapshot's rows, inside one transaction (all-or-nothing: a failure
partway through rolls the whole thing back rather than leaving a
half-restored database). Refuses to run without `--yes`. Fixes up each
table's auto-increment sequence afterward so new rows don't collide with
restored ids.

Attachment file bytes are never touched by a restore — they were never
duplicated into the backup in the first place (see above), so a restore
brings the database back but leaves Blob exactly as it was. If a restored
`attachments` row points at a Blob pathname that's since been deleted,
that's the same "orphaned reference" situation as any other point-in-time
database restore and isn't something this script tries to reconcile.

## Deploying

Deployed on Vercel, connected to this repo's `main` branch — every push
triggers a build, and every PR gets its own preview deployment.

One-time setup for a new Vercel project:

```bash
vercel link
vercel install neon          # provisions Postgres, injects DATABASE_URL
vercel blob create-store     # provisions Blob, injects BLOB_READ_WRITE_TOKEN
vercel env add SESSION_SECRET
vercel env add CRON_SECRET
vercel env pull .env         # to run npm run migrate locally against it once
npm run migrate
```

`vercel.json` declares two Cron Jobs (`/api/cron/periodic-checks` at 6am UTC,
`/api/cron/backup` at 3am UTC) — Vercel schedules these automatically on
deploy, nothing extra to configure. `COOKIE_SECURE` should be `true` in the
deployed environment (Vercel terminates TLS automatically, so this is never
an "if" the way it was behind a self-managed reverse proxy).

## Testing

```bash
npm test
```

Runs Node's built-in test runner (`node --test`) — no test framework
dependency. Every test file boots the real app against `velv_test`, a
dedicated, isolated Postgres database on the same Neon project as dev/prod
(see `test/helpers.js`) — never dev or prod data.

Runs automatically on every push and PR to `main` via
[GitHub Actions](.github/workflows/test.yml).

## Known limitations (kept out of scope for this "basic" version)

- Single flat agent role — no admin/agent distinction or per-agent permissions.
- No password reset flow — an existing agent can add a new account via the Agents page, but there's no self-service "forgot password."

These are reasonable next steps if the tool needs to grow beyond "basic."
