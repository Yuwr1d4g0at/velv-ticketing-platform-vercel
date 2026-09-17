// Restores every table from a backup written by scripts/backup.js (see that
// file's header for the export format and what's deliberately NOT included -
// attachment file bytes stay in Vercel Blob, only their metadata is backed
// up, so a restore brings the database back but never touches Blob).
//
// DESTRUCTIVE: truncates every table this app owns and replaces it with the
// backup's rows, inside one transaction (all-or-nothing - either the whole
// restore applies, or a failure partway through rolls all of it back, never
// leaving half-old/half-restored data). Requires --yes on the command line;
// refuses to run without it, on purpose.
//
// Usage:
//   npm run restore -- latest --yes
//   npm run restore -- backups/2026-01-15T03-00-00-000Z.json --yes
require("dotenv").config();
const { get, list } = require("@vercel/blob");
const db = require("../src/db");
const { TABLES, BACKUP_PREFIX } = require("./backup");

// Same as db/index.js's own TABLES_WITHOUT_ID (composite-key join tables,
// plus the couple of lookup tables keyed by something other than a SERIAL
// id) - these never need their sequence fixed up after a restore, because
// they never had one to begin with.
const TABLES_WITHOUT_ID_SEQUENCE = new Set([
  "ticket_tags",
  "ticket_ratings",
  "sla_thresholds",
  "ticket_watchers",
  "ticket_custom_values",
  "ticket_links",
  "first_response_thresholds",
  "periodic_check_state",
]);

async function resolveBackupPathname(arg) {
  if (arg && arg !== "latest") return arg;

  const backups = [];
  let cursor;
  do {
    const page = await list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
    backups.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  if (!backups.length) throw new Error(`No backups found under ${BACKUP_PREFIX}`);
  backups.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return backups[0].pathname;
}

async function fetchBackup(pathname) {
  const result = await get(pathname, { access: "private" });
  if (!result) throw new Error(`Backup not found: ${pathname}`);
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString());
}

async function runRestore(pathname) {
  const backup = await fetchBackup(pathname);
  const tableList = backup.tables && backup.tables.length ? backup.tables : TABLES;

  await db.transaction(async (tx) => {
    // CASCADE + all tables in one statement so FK ordering doesn't matter
    // for the truncate itself - only the subsequent inserts need to go in
    // dependency order.
    const quoted = tableList.map((t) => `"${t}"`).join(", ");
    await tx.prepare(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`).run();

    for (const table of tableList) {
      const rows = backup.data[table] || [];
      if (!rows.length) continue;

      // search_vector (tickets) is a GENERATED ALWAYS ... STORED column
      // (see scripts/migrate.js's Phase 4 full-text search work) - it comes
      // back from the backup's own SELECT * same as any other column, but
      // Postgres refuses an explicit INSERT into a generated column
      // outright. Recomputed automatically from subject/description the
      // instant the row lands, so simply never included here.
      const columns = Object.keys(rows[0]).filter((c) => c !== "search_vector");
      const columnList = columns.map((c) => `"${c}"`).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const insert = tx.prepare(`INSERT INTO "${table}" (${columnList}) VALUES (${placeholders})`);
      for (const row of rows) {
        await insert.run(...columns.map((c) => row[c]));
      }

      if (!TABLES_WITHOUT_ID_SEQUENCE.has(table)) {
        await tx
          .prepare(
            `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1), (SELECT MAX(id) FROM "${table}") IS NOT NULL)`
          )
          .run();
      }
    }
  });

  return { pathname, createdAt: backup.createdAt, rowCounts: backup.rowCounts };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const target = args.find((a) => a !== "--yes");

  if (!confirmed) {
    console.error(
      "Refusing to restore without --yes - this replaces every row in every table with the backup's data.\n" +
        "Usage: npm run restore -- <backup pathname or \"latest\"> --yes"
    );
    process.exit(1);
  }

  resolveBackupPathname(target)
    .then((pathname) => {
      console.log(`Restoring from ${pathname}...`);
      return runRestore(pathname);
    })
    .then(({ pathname, createdAt, rowCounts }) => {
      const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
      console.log(`Restored ${totalRows} row(s) from ${pathname} (backed up ${createdAt}).`);
      console.log("Note: attachment file bytes were not touched - they were never duplicated into the backup (see scripts/backup.js).");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Restore failed:", err.message);
      process.exit(1);
    });
}

module.exports = { runRestore, resolveBackupPathname };
