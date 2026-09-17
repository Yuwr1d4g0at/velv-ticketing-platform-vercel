// Covers what's testable about the SharePoint asset-inventory sync
// (src/assetSync.js) without a live Entra tenant with Sites.Read.All
// admin-consented: the "off unless configured" skip behavior, the
// isDue()/recentRuns() run-history bookkeeping, and the settings page
// rendering both states. The actual Graph field-mapping/category-status
// logic is carried over verbatim from scripts/import-assets.js (already
// verified against a real CSV export of this list) but hasn't been
// exercised against a live Graph response yet - see the honesty note at
// the top of src/assetSync.js itself.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client, db;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);
  db = app.db;

  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Sync Agent", "sync-agent@example.com", bcrypt.hashSync("correct-password", 4));
  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "sync-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

test("runSync() is a no-op when Microsoft Graph isn't configured", async () => {
  const assetSync = require("../src/assetSync");
  const result = await assetSync.runSync();
  assert.ok(result.skipped);
  // No run row should be logged for a skip - there was nothing to run.
  const row = await db.prepare("SELECT COUNT(*) c FROM asset_sync_runs").get();
  assert.equal(row.c, 0);
});

test("isDue() is true with no prior runs, and false right after a logged run within the interval", async () => {
  const assetSync = require("../src/assetSync");
  assert.equal(await assetSync.isDue(24), true);

  await db
    .prepare(
      `INSERT INTO asset_sync_runs (started_at, finished_at, created_count, updated_count, failed_count) VALUES (now_text(), now_text(), 5, 2, 0)`
    )
    .run();
  assert.equal(await assetSync.isDue(24), false);
  assert.equal(await assetSync.isDue(0), true); // a 0-hour interval is always due
});

test("the asset-sync settings page shows the disabled state and past run history", async () => {
  const html = await (await client.get("/dashboard/settings/asset-sync")).text();
  assert.match(html, /isn't configured/);
  assert.match(html, /disabled/); // the "Sync now" button is disabled
  assert.match(html, /<td>5<\/td>/); // created_count from the run logged above
  assert.match(html, /<td>2<\/td>/); // updated_count
});
