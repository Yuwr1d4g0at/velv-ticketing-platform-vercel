// Covers Microsoft Graph directory enrichment (department/job title/phone,
// photos) on the ticket detail and Agents pages - src/directory.js's cache
// on top of src/msGraph.js's app-only Graph client.
//
// Same network constraint as the SSO tests: a real Graph app-only token
// exchange needs a live Entra tenant with admin-consented Application
// permissions, so no test here makes a real Graph call. What IS covered:
// the cache-first behavior (a row already in directory_cache is served
// as-is, whether or not MS_* is configured - directory.js falls back to
// "whatever's cached" the moment Graph isn't reachable/configured) and
// that the ticket/Agents pages render the enrichment when present and
// omit it cleanly when absent.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client, db;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);
  db = app.db;

  // is_admin: this test visits the Agents page, which is admin-only.
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)")
    .run("Directory Agent", "directory-agent@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "directory-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function seedProfile(email, fields) {
  await db
    .prepare(
      `INSERT INTO directory_cache (email, display_name, department, job_title, phone, found, fetched_at)
       VALUES (?, ?, ?, ?, ?, 1, now_text())`
    )
    .run(email, fields.displayName || null, fields.department || null, fields.jobTitle || null, fields.phone || null);
}

test("a ticket page shows no directory enrichment when nothing is cached and Graph isn't configured", async () => {
  const result = await db
    .prepare(`INSERT INTO tickets (subject, description, category, requester_name, requester_email) VALUES (?, ?, 'Hardware', ?, ?)`)
    .run("No enrichment yet", "desc", "Plain Requester", "plain.requester@example.com");
  const ticketId = result.lastInsertRowid;

  const html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  // Checked against this specific requester's photo URL, not the bare
  // "directory-avatar" class name - the signed-in agent's own avatar in
  // the header (see views/partials/header.ejs) always renders regardless,
  // so that class name alone appears on every dashboard page.
  assert.doesNotMatch(html, /directory\/photo\?email=plain\.requester/);
});

test("a ticket page shows cached department/job title/phone for the requester", async () => {
  await seedProfile("enriched.requester@velv.pt", {
    displayName: "Enriched Requester",
    department: "Finance",
    jobTitle: "Analyst",
    phone: "+351 912 345 678",
  });
  const result = await db
    .prepare(`INSERT INTO tickets (subject, description, category, requester_name, requester_email) VALUES (?, ?, 'Hardware', ?, ?)`)
    .run("Enriched ticket", "desc", "Enriched Requester", "enriched.requester@velv.pt");
  const ticketId = result.lastInsertRowid;

  const html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(html, /Analyst/);
  assert.match(html, /Finance/);
  assert.match(html, /\+351 912 345 678/);
  assert.match(html, /directory-avatar/);
});

test("directory enrichment is skipped once a ticket's data has been erased (GDPR)", async () => {
  await seedProfile("erased.requester@velv.pt", { displayName: "Erased Requester", department: "Should not appear" });
  const result = await db
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, data_erased_at)
       VALUES (?, ?, 'Hardware', ?, ?, now_text())`
    )
    .run("Erased ticket", "desc", "[erased]", "erased.requester@velv.pt");
  const ticketId = result.lastInsertRowid;

  const html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.doesNotMatch(html, /Should not appear/);
});

test("the Agents page shows each agent's cached department/job title when present", async () => {
  await seedProfile("directory-agent@example.com", { department: "IT Department", jobTitle: "Helpdesk Lead" });
  const html = await (await client.get("/dashboard/agents")).text();
  assert.match(html, /Helpdesk Lead/);
  assert.match(html, /IT Department/);
});
