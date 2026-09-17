// One-time (idempotent) schema setup against the real Postgres database -
// run by hand (`node scripts/migrate.js`) or once per environment, NOT as a
// side effect of requiring src/db/index.js the way the old SQLite version
// worked. That pattern was fine for one long-lived process on Railway, but
// running CREATE TABLE / seed-check DDL on every cold start of every
// serverless invocation would be wasteful and risky (concurrent invocations
// racing the same guarded migration). This is the Postgres port of the old
// src/db/index.js's schema block - one clean canonical schema (no replayed
// SQLite migration history, since there's no existing Postgres data to
// evolve incrementally) - see the plan's "Key design decisions" #3.
//
// Deliberate porting choices, applied uniformly below (see the plan for the
// full reasoning):
// - Every `INTEGER PRIMARY KEY AUTOINCREMENT` -> `SERIAL PRIMARY KEY`.
// - Every 0/1 "boolean" column (active, published, confidential, ...) stays
//   INTEGER, not a real Postgres BOOLEAN - every "= 1"/"? 1 : 0" comparison
//   throughout the app keeps working verbatim, no call-site changes needed
//   just for this.
// - Every created_at/updated_at/etc. TEXT timestamp stays TEXT, with a
//   default expression that reproduces SQLite's own `datetime('now')`
//   output format exactly ("YYYY-MM-DD HH:MM:SS", UTC) - not TIMESTAMPTZ.
//   This is the single biggest de-risking choice in this port: the app has
//   388 call sites touching these columns (string slicing, direct
//   comparisons, passing straight into `new Date(...)`), and keeping the
//   exact on-the-wire string shape means none of that code needs to change
//   just because the database changed underneath it. Lexicographic
//   ordering/comparison on this format still works correctly, same as it
//   always did in SQLite.
// - `tags.name`'s SQLite `COLLATE NOCASE` unique constraint becomes a
//   case-insensitive unique index (`LOWER(name)`) instead - Postgres has no
//   direct column-level NOCASE collation for this without an extension.
//   src/tags.js's `INSERT OR IGNORE` will need `ON CONFLICT ((LOWER(name)))
//   DO NOTHING` in Phase 2 to match.
// - `directory_cache.photo_blob` BLOB -> BYTEA.
// - Full-text search (tickets_fts) is deliberately NOT ported here - see
//   the plan's Phase 4 (Postgres tsvector/ts_rank rewrite). This script
//   creates no FTS structures at all yet.
// - The `sessions` table is dropped entirely - connect-pg-simple manages
//   its own session table (see src/app.js).
require("dotenv").config(); // standalone script - not loaded by src/app.js's own require chain

const { Pool } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL in the environment. Copy .env.example to .env and set one (see README's Vercel/Neon setup section).");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Reproduces SQLite's `datetime('now')` exactly: "YYYY-MM-DD HH:MM:SS", UTC.
const NOW_TEXT = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;

// A real Postgres function so every INLINE `datetime('now')` call in
// application SQL (UPDATE ... SET updated_at = datetime('now'), etc. -
// dozens of call sites across src/, not just column DEFAULTs) can become a
// short, drop-in `now_text()` instead of repeating the to_char(...)
// expression above everywhere or hand-computing a JS timestamp string at
// every call site. Table DEFAULTs below still use NOW_TEXT directly rather
// than calling this function, purely so the schema reads standalone without
// a forward reference to a function defined later in the same script -
// same underlying expression either way.
const NOW_TEXT_FUNCTION_SQL = `
  CREATE OR REPLACE FUNCTION now_text() RETURNS TEXT AS $$
    SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  $$ LANGUAGE SQL STABLE;
`;

const SCHEMA_SQL = `
  -- Dependency order matters here (unlike the old SQLite file, which could
  -- lean on SQLite's laxer forward-reference handling) - Postgres requires a
  -- referenced table to already exist. Tables are ordered so every
  -- REFERENCES target is created first.

  CREATE TABLE IF NOT EXISTS departments (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  CREATE TABLE IF NOT EXISTS agents (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT ${NOW_TEXT},
    last_digest_at TEXT,
    department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL DEFAULT 1,
    is_admin       INTEGER NOT NULL DEFAULT 0,
    totp_secret    TEXT,
    totp_enabled   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS categories (
    id                SERIAL PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    department_id     INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
    active            INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT ${NOW_TEXT},
    requires_approval INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_categories_department_id ON categories(department_id);

  CREATE TABLE IF NOT EXISTS assets (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    asset_tag           TEXT UNIQUE,
    category            TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'In Use',
    assigned_to_name    TEXT,
    location            TEXT,
    serial_number       TEXT,
    vendor              TEXT,
    purchase_date       TEXT,
    warranty_expires    TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT ${NOW_TEXT},
    updated_at          TEXT NOT NULL DEFAULT ${NOW_TEXT},
    warranty_alerted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);

  CREATE TABLE IF NOT EXISTS tickets (
    id                        SERIAL PRIMARY KEY,
    subject                   TEXT NOT NULL,
    description               TEXT NOT NULL,
    category                  TEXT NOT NULL,
    priority                  TEXT NOT NULL DEFAULT 'Medium',
    status                    TEXT NOT NULL DEFAULT 'Open',
    requester_name            TEXT NOT NULL,
    requester_email           TEXT NOT NULL,
    assigned_to               INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at                TEXT NOT NULL DEFAULT ${NOW_TEXT},
    updated_at                TEXT NOT NULL DEFAULT ${NOW_TEXT},
    rating_token              TEXT,
    asset_id                  INTEGER REFERENCES assets(id) ON DELETE SET NULL,
    sla_alerted_at            TEXT,
    merged_into_id            INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    data_erased_at            TEXT,
    subcategory               TEXT,
    waiting_since             TEXT,
    paused_hours              REAL NOT NULL DEFAULT 0,
    first_response_alerted_at TEXT,
    confidential              INTEGER NOT NULL DEFAULT 0,
    approval_status           TEXT,
    approval_note             TEXT,
    reminder_date             TEXT,
    reminder_alerted_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);

  CREATE TABLE IF NOT EXISTS ticket_activity (
    id         SERIAL PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    type       TEXT NOT NULL DEFAULT 'note' CHECK (type IN ('note', 'status_change', 'assignment', 'priority_change', 'reply', 'requester_reply', 'approval_change')),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_activity_ticket_id ON ticket_activity(ticket_id);

  -- File bytes live in Vercel Blob as of Phase 3 (see src/attachments.js) -
  -- stored_name stays the server-generated random identifier, now used as
  -- the blob pathname instead of a local disk filename.
  CREATE TABLE IF NOT EXISTS attachments (
    id                    SERIAL PRIMARY KEY,
    ticket_id             INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    stored_name           TEXT NOT NULL,
    original_name         TEXT NOT NULL,
    mime_type             TEXT NOT NULL,
    size_bytes            INTEGER NOT NULL,
    uploaded_by           TEXT NOT NULL CHECK (uploaded_by IN ('requester', 'agent')),
    agent_id              INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    visible_to_requester  INTEGER NOT NULL DEFAULT 1,
    created_at            TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_ticket_id ON attachments(ticket_id);

  -- name has no UNIQUE constraint of its own here - see idx_tags_name_lower
  -- below, which is the actual (case-insensitive) uniqueness guard.
  CREATE TABLE IF NOT EXISTS tags (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_lower ON tags (LOWER(name));

  CREATE TABLE IF NOT EXISTS ticket_tags (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, tag_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_tags_tag_id ON ticket_tags(tag_id);

  CREATE TABLE IF NOT EXISTS ticket_ratings (
    ticket_id  INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment    TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  CREATE TABLE IF NOT EXISTS canned_responses (
    id            SERIAL PRIMARY KEY,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT ${NOW_TEXT},
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS asset_activity (
    id         SERIAL PRIMARY KEY,
    asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_asset_activity_asset_id ON asset_activity(asset_id);

  CREATE TABLE IF NOT EXISTS saved_views (
    id           SERIAL PRIMARY KEY,
    agent_id     INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    query_string TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_saved_views_agent_id ON saved_views(agent_id);

  CREATE TABLE IF NOT EXISTS sla_thresholds (
    priority TEXT PRIMARY KEY,
    days     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id            SERIAL PRIMARY KEY,
    url           TEXT NOT NULL,
    events        TEXT NOT NULL,
    secret        TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT ${NOW_TEXT},
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS login_log (
    id         SERIAL PRIMARY KEY,
    email      TEXT NOT NULL,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    success    INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_login_log_created_at ON login_log(created_at);

  CREATE TABLE IF NOT EXISTS kb_articles (
    id            SERIAL PRIMARY KEY,
    title         TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,
    body          TEXT NOT NULL,
    category      TEXT,
    published     INTEGER NOT NULL DEFAULT 1,
    agent_id      INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT ${NOW_TEXT},
    updated_at    TEXT NOT NULL DEFAULT ${NOW_TEXT},
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS ticket_templates (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  CREATE TABLE IF NOT EXISTS ticket_watchers (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent_id  INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (ticket_id, agent_id)
  );

  CREATE TABLE IF NOT EXISTS custom_field_definitions (
    id         SERIAL PRIMARY KEY,
    category   TEXT NOT NULL,
    field_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE TABLE IF NOT EXISTS ticket_custom_values (
    ticket_id           INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    field_definition_id INTEGER NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
    value               TEXT,
    PRIMARY KEY (ticket_id, field_definition_id)
  );

  CREATE TABLE IF NOT EXISTS ticket_links (
    ticket_id        INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    linked_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    created_at       TEXT NOT NULL DEFAULT ${NOW_TEXT},
    PRIMARY KEY (ticket_id, linked_ticket_id)
  );

  CREATE TABLE IF NOT EXISTS automation_rules (
    id                 SERIAL PRIMARY KEY,
    name               TEXT NOT NULL,
    condition_category TEXT,
    condition_keyword  TEXT,
    action_tag         TEXT,
    action_priority    TEXT,
    action_assigned_to INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    active             INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL DEFAULT ${NOW_TEXT},
    department_id      INTEGER REFERENCES departments(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS recurring_tickets (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL,
    subject       TEXT NOT NULL,
    description   TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'Medium',
    interval_days INTEGER NOT NULL,
    next_run_at   TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    agent_id   INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    message    TEXT NOT NULL,
    read_at    TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_agent_id ON notifications(agent_id);

  CREATE TABLE IF NOT EXISTS first_response_thresholds (
    priority TEXT PRIMARY KEY,
    hours    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS company_holidays (
    id         SERIAL PRIMARY KEY,
    date       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  CREATE TABLE IF NOT EXISTS directory_cache (
    email              TEXT PRIMARY KEY,
    display_name       TEXT,
    department         TEXT,
    job_title          TEXT,
    phone              TEXT,
    photo_blob         BYTEA,
    photo_content_type TEXT,
    found              INTEGER NOT NULL DEFAULT 1,
    fetched_at         TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id         SERIAL PRIMARY KEY,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent_id   INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    minutes    INTEGER NOT NULL CHECK (minutes > 0),
    note       TEXT,
    logged_on  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_time_entries_ticket_id ON time_entries(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_time_entries_logged_on ON time_entries(logged_on);

  CREATE TABLE IF NOT EXISTS asset_sync_runs (
    id            SERIAL PRIMARY KEY,
    started_at    TEXT NOT NULL DEFAULT ${NOW_TEXT},
    finished_at   TEXT,
    created_count INTEGER,
    updated_count INTEGER,
    failed_count  INTEGER,
    error         TEXT
  );

  CREATE TABLE IF NOT EXISTS template_checklist_items (
    id             SERIAL PRIMARY KEY,
    template_id    INTEGER NOT NULL REFERENCES ticket_templates(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    spawn_category TEXT,
    position       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_checklist_items_template_id ON template_checklist_items(template_id);

  CREATE TABLE IF NOT EXISTS agent_activity (
    id              SERIAL PRIMARY KEY,
    target_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    actor_agent_id  INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );
  CREATE INDEX IF NOT EXISTS idx_agent_activity_target_agent_id ON agent_activity(target_agent_id);

  -- Singleton row driving the opportunistic background-check trigger (see
  -- Phase 5) - how long since runPeriodicChecks() last actually ran,
  -- regardless of whether that was the daily Vercel Cron hit or an
  -- in-request opportunistic fire.
  CREATE TABLE IF NOT EXISTS periodic_check_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    last_run_at   TEXT
  );
`;

async function seedIfEmpty(client, table, countSql, insertFn) {
  const { rows } = await client.query(countSql);
  if (Number(rows[0].c) === 0) await insertFn();
}

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(NOW_TEXT_FUNCTION_SQL);
    await client.query(SCHEMA_SQL);

    // Same seed-if-empty data as the old src/db/index.js - historical
    // defaults, never re-applied once a real row exists.
    await seedIfEmpty(client, "sla_thresholds", "SELECT COUNT(*) AS c FROM sla_thresholds", async () => {
      const DEFAULT_SLA_DAYS = { Urgent: 1, High: 2, Medium: 5, Low: 7 };
      for (const [priority, days] of Object.entries(DEFAULT_SLA_DAYS)) {
        await client.query("INSERT INTO sla_thresholds (priority, days) VALUES ($1, $2)", [priority, days]);
      }
    });

    await seedIfEmpty(client, "first_response_thresholds", "SELECT COUNT(*) AS c FROM first_response_thresholds", async () => {
      const DEFAULT_FIRST_RESPONSE_HOURS = { Urgent: 1, High: 4, Medium: 8, Low: 24 };
      for (const [priority, hours] of Object.entries(DEFAULT_FIRST_RESPONSE_HOURS)) {
        await client.query("INSERT INTO first_response_thresholds (priority, hours) VALUES ($1, $2)", [priority, hours]);
      }
    });

    await seedIfEmpty(client, "departments", "SELECT COUNT(*) AS c FROM departments", async () => {
      // IT first so it lands on id 1 - agents.department_id's DEFAULT 1
      // and every pre-existing category (all IT-flavored) depend on that,
      // same reasoning as the original SQLite seed.
      for (const name of ["IT", "HR", "Legal", "Marketing"]) {
        await client.query("INSERT INTO departments (name) VALUES ($1)", [name]);
      }
    });

    await seedIfEmpty(client, "categories", "SELECT COUNT(*) AS c FROM categories", async () => {
      const DEFAULT_CATEGORIES = {
        IT: ["Hardware", "Software", "Network", "Account & Access", "Other"],
        HR: ["Onboarding", "Benefits", "Employee Relations"],
        Legal: ["Contract Review", "Compliance", "NDA / Confidentiality", "Litigation & Disputes"],
        Marketing: ["Campaign Request", "Content & Design", "Brand Assets", "Event Support"],
      };
      const { rows: depts } = await client.query("SELECT id, name FROM departments");
      const departmentIdByName = Object.fromEntries(depts.map((d) => [d.name, d.id]));
      for (const [deptName, names] of Object.entries(DEFAULT_CATEGORIES)) {
        for (const name of names) {
          const requiresApproval = ["Content & Design", "Campaign Request"].includes(name) ? 1 : 0;
          await client.query("INSERT INTO categories (name, department_id, requires_approval) VALUES ($1, $2, $3)", [
            name,
            departmentIdByName[deptName],
            requiresApproval,
          ]);
        }
      }
    });

    await seedIfEmpty(client, "periodic_check_state", "SELECT COUNT(*) AS c FROM periodic_check_state", async () => {
      await client.query("INSERT INTO periodic_check_state (id, last_run_at) VALUES (1, NULL)");
    });

    console.log("Migration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
