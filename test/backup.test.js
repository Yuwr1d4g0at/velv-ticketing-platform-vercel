// Exercises the real scripts/backup.js / scripts/restore.js against the
// isolated velv_test database (see test/helpers.js) and the real Vercel
// Blob store - but under a throwaway BACKUP_PREFIX, never the "backups/"
// prefix production actually uses. Blob has no per-environment token the
// way DATABASE_URL has velv_test, so writing test backups under the real
// prefix would mix them into production's backup history and risk this
// suite's aggressive BACKUP_KEEP pruning deleting a real backup.
process.env.BACKUP_PREFIX = "test-backups/";
process.env.BACKUP_KEEP = "2";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp, makeClient } = require("./helpers");

let app, db, backup, restore, blobList, blobGet, blobDel;

before(async () => {
  app = await startTestApp();
  db = app.db;
  backup = require("../scripts/backup");
  restore = require("../scripts/restore");
  ({ list: blobList, get: blobGet, del: blobDel } = require("@vercel/blob"));
});

after(async () => {
  const page = await blobList({ prefix: backup.BACKUP_PREFIX });
  if (page.blobs.length) await blobDel(page.blobs.map((b) => b.pathname));
  await app.close();
});

test("runBackup snapshots every table into a JSON blob under the test prefix", async () => {
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)")
    .run("Backup Agent", "backup-agent@example.com", "hash");

  const result = await backup.runBackup();
  assert.match(result.pathname, /^test-backups\/.*\.json$/);
  assert.ok(result.rowCounts.agents >= 1);

  const fetched = await blobGet(result.pathname, { access: "private" });
  const chunks = [];
  for await (const chunk of fetched.stream) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString());

  assert.ok(payload.tables.includes("agents"));
  assert.ok(payload.data.agents.some((a) => a.email === "backup-agent@example.com"));
  // session and directory_cache are deliberately excluded - see backup.js.
  assert.ok(!payload.tables.includes("session"));
  assert.ok(!payload.tables.includes("directory_cache"));
});

test("runRestore round-trips data and fixes up sequences afterward", async () => {
  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Round Trip Agent", "round-trip@example.com", "hash");
  const agentBefore = await db.prepare("SELECT id FROM agents WHERE email = ?").get("round-trip@example.com");

  const { pathname } = await backup.runBackup();

  // Simulate disaster: wipe every table, same as a real restore scenario.
  const { rows } = await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  await db.pool.query(`TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM agents").get()).c, 0);

  await restore.runRestore(pathname);

  const restored = await db.prepare("SELECT id, name FROM agents WHERE email = ?").get("round-trip@example.com");
  assert.equal(restored.name, "Round Trip Agent");
  assert.equal(restored.id, agentBefore.id);

  // Sequence fixed up post-restore - a fresh insert must not collide with a
  // restored id.
  const inserted = await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Post Restore Agent", "post-restore@example.com", "hash");
  assert.ok(inserted.lastInsertRowid > agentBefore.id);
});

test("resolveBackupPathname('latest') picks the most recently uploaded backup", async () => {
  await backup.runBackup();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { pathname: second } = await backup.runBackup();

  const resolved = await restore.resolveBackupPathname("latest");
  assert.equal(resolved, second);
});

test("old backups are pruned beyond BACKUP_KEEP", async () => {
  for (let i = 0; i < 4; i++) {
    await backup.runBackup();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const page = await blobList({ prefix: backup.BACKUP_PREFIX });
  assert.equal(page.blobs.length, 2); // BACKUP_KEEP=2, set at the top of this file
});

test("GET /api/cron/backup requires the CRON_SECRET bearer token", async () => {
  const client = makeClient(app.baseUrl);

  const unauthorized = await client.get("/api/cron/backup");
  assert.equal(unauthorized.status, 401);

  const authorized = await client.get("/api/cron/backup", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).ok, true);
});

test("a failed cron job alerts every active admin agent by email", async () => {
  // SMTP is disabled in tests (see test/helpers.js), so mailer.send() itself
  // is a no-op regardless - what's under test here is src/routes/cron.js's
  // own alertAdmins() wiring: does it look up admins and call
  // sendCronFailureAlert at all when a job throws. Both mailer.enabled and
  // mailer.sendCronFailureAlert are read as properties on the required
  // module object at call time (never destructured), so overwriting them
  // here is visible to cron.js's own `require("../mailer")` - same cached
  // module instance.
  const mailer = require("../src/mailer");
  const originalEnabled = mailer.enabled;
  const originalSend = mailer.sendCronFailureAlert;
  const sent = [];
  mailer.enabled = true;
  mailer.sendCronFailureAlert = async (args) => sent.push(args);

  await db
    .prepare("INSERT INTO agents (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)")
    .run("Alert Admin", "alert-admin@example.com", "hash");

  // Force a real failure inside runBackup() by pushing a nonexistent table
  // onto backup.js's own TABLES array - exported by reference, not copied,
  // so mutating it here reaches the same array runBackup() iterates.
  backup.TABLES.push("does_not_exist_table");
  let response;
  try {
    const client = makeClient(app.baseUrl);
    response = await client.get("/api/cron/backup", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
  } finally {
    backup.TABLES.pop();
    mailer.enabled = originalEnabled;
    mailer.sendCronFailureAlert = originalSend;
  }

  assert.equal(response.status, 500);
  assert.ok(sent.some((s) => s.to === "alert-admin@example.com" && s.jobName === "backup"));
});
