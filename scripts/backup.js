// Creates a timestamped, portable JSON export of every real data table plus
// a manifest of every file actually stored in Vercel Blob, and writes it to
// Blob itself (under backups/) - not local disk, since this runs from a
// Vercel Cron function (see src/routes/cron.js) that has no persistent
// filesystem to write to, same reasoning as everything else this migration
// moved off local disk. The old version VACUUM INTO'd a local SQLite file
// and copied a local attachments/ folder - neither exists anymore.
//
// This is a logical (row-level) export, not a binary pg_dump - no pg_dump
// binary is available in a Vercel Function's runtime anyway, and a portable
// JSON snapshot restorable with nothing but this app's own tooling
// (scripts/restore.js) is arguably more useful for disaster recovery than a
// provider-specific binary format. Attachment *bytes* are deliberately not
// duplicated into the backup - Vercel Blob already provides its own
// durability guarantees, so this only records what exists and where
// (pathname/size/uploadedAt) for cross-checking against the attachments
// table's own rows, not a second copy of every file's bytes on every run.
//
// Run manually:      npm run backup
// Run on a schedule: see vercel.json's crons entry (Hobby plan allows up to
//   100 cron jobs/project, once per day each, +-59min precision - see
//   https://vercel.com/docs/cron-jobs/usage-and-pricing).
// Restore:            npm run restore -- <backup pathname or "latest">
//   (see scripts/restore.js and the README's Backups section)
require("dotenv").config();
const { put, list, del } = require("@vercel/blob");
const db = require("../src/db");

// Overridable so the test suite can point backups at a throwaway prefix
// instead of mixing test runs into the real backups/ used by production -
// this shares one Vercel Blob store across dev/test/prod (there's no
// separate token per environment the way DATABASE_URL has velv_test), so
// without this a test run's aggressive BACKUP_KEEP pruning could delete
// real production backups sitting under the same prefix.
const BACKUP_PREFIX = process.env.BACKUP_PREFIX || "backups/";
const KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 14; // backups to retain; oldest pruned first

// Every real application table, in the same dependency order
// scripts/migrate.js creates them in (a child table always appears after
// the parent(s) its foreign keys point at) - scripts/restore.js inserts in
// this exact order so FK constraints are satisfied without having to defer
// them. Two deliberate exclusions:
// - `session` (connect-pg-simple's own store) - ephemeral login state, not
//   data anyone's disaster-recovery plan should depend on, and restoring it
//   would just log every agent out anyway.
// - `directory_cache` (src/directory.js) - a pure, self-healing Microsoft
//   Graph lookup cache with a 24-hour TTL, no authoritative data of its
//   own; also holds photo_blob as raw BYTEA, which doesn't round-trip
//   through JSON.stringify/parse the way every other column here does.
const TABLES = [
  "departments",
  "agents",
  "categories",
  "assets",
  "tickets",
  "ticket_activity",
  "attachments",
  "tags",
  "ticket_tags",
  "ticket_ratings",
  "canned_responses",
  "asset_activity",
  "saved_views",
  "sla_thresholds",
  "webhooks",
  "login_log",
  "kb_articles",
  "ticket_templates",
  "ticket_watchers",
  "custom_field_definitions",
  "ticket_custom_values",
  "ticket_links",
  "automation_rules",
  "recurring_tickets",
  "notifications",
  "first_response_thresholds",
  "company_holidays",
  "time_entries",
  "asset_sync_runs",
  "template_checklist_items",
  "agent_activity",
  "periodic_check_state",
];

// Every blob actually in the store right now, excluding backups/ itself -
// list() is paginated (1000/page), so this loops on the cursor until
// hasMore is false rather than assuming one call sees everything.
async function listAllBlobs() {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ cursor, limit: 1000 });
    for (const blob of page.blobs) {
      if (!blob.pathname.startsWith(BACKUP_PREFIX)) blobs.push(blob);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function runBackup() {
  const tables = {};
  for (const table of TABLES) {
    tables[table] = await db.prepare(`SELECT * FROM "${table}"`).all();
  }

  const blobManifest = (await listAllBlobs()).map((b) => ({
    pathname: b.pathname,
    size: b.size,
    uploadedAt: b.uploadedAt,
  }));

  const payload = {
    createdAt: new Date().toISOString(),
    tables: TABLES,
    rowCounts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])),
    data: tables,
    blobManifest,
  };

  const pathname = `${BACKUP_PREFIX}${payload.createdAt.replace(/[:.]/g, "-")}.json`;
  await put(pathname, JSON.stringify(payload), { access: "private", contentType: "application/json", addRandomSuffix: false });

  const pruned = await pruneOldBackups();

  return {
    pathname,
    rowCounts: payload.rowCounts,
    attachmentCount: blobManifest.length,
    pruned,
  };
}

async function pruneOldBackups() {
  const backups = [];
  let cursor;
  do {
    const page = await list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
    backups.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  backups.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const toDelete = backups.slice(KEEP);
  if (toDelete.length) await del(toDelete.map((b) => b.pathname));
  return toDelete.map((b) => b.pathname);
}

if (require.main === module) {
  runBackup()
    .then(({ pathname, rowCounts, attachmentCount, pruned }) => {
      const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
      console.log(`Backup written to ${pathname} (${totalRows} row(s) across ${TABLES.length} tables, ${attachmentCount} attachment(s) in the manifest).`);
      if (pruned.length) console.log(`Pruned ${pruned.length} old backup(s): ${pruned.join(", ")}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Backup failed:", err.message);
      process.exit(1);
    });
}

module.exports = { runBackup, TABLES, BACKUP_PREFIX, KEEP };
