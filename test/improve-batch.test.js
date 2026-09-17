// Covers the "improve the platform" round: custom date-range reports
// (including the SLA compliance trend) and the company holidays settings
// page. (The "My day" personal view this batch also added was removed
// again shortly after - see [[velv-ticketing-rebrand]].)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client, db, agentId;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);
  db = app.db;

  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Improve Agent", "improve-agent@example.com", bcrypt.hashSync("correct-password", 4));
  agentId = (await db.prepare("SELECT id FROM agents WHERE email = 'improve-agent@example.com'").get()).id;

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "improve-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function insertTicket(fields = {}) {
  const result = await db
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, assigned_to, priority, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, now_text()))`
    )
    .run(
      fields.subject || "Default subject",
      fields.description || "Default description",
      fields.category || "Hardware",
      fields.requester_name || "Improve Requester",
      fields.requester_email || "improve-requester@example.com",
      fields.assigned_to !== undefined ? fields.assigned_to : agentId,
      fields.priority || "Medium",
      fields.status || "Open",
      fields.created_at || null
    );
  return result.lastInsertRowid;
}

async function insertResolvedActivity(ticketId, happenedAt) {
  await db
    .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body, created_at) VALUES (?, ?, 'status_change', ?, ?)`)
    .run(ticketId, agentId, 'Status changed from "Open" to "Resolved".', happenedAt);
}

test("Reports date range: defaults to Last 30 days, and presets change the label", async () => {
  const defaultHtml = await (await client.get("/dashboard")).text();
  assert.match(defaultHtml, /Last 30 days/);

  const sevenDayHtml = await (await client.get("/dashboard?report_range=7d")).text();
  assert.match(sevenDayHtml, /Last 7 days/);

  const ninetyDayHtml = await (await client.get("/dashboard?report_range=90d")).text();
  assert.match(ninetyDayHtml, /Last 90 days/);
});

test("Reports date range: picking Custom range without dates yet reveals the date inputs instead of silently falling back", async () => {
  const html = await (await client.get("/dashboard?report_range=custom")).text();
  assert.match(html, /name="report_from"/);
  assert.match(html, /name="report_to"/);
});

test("Reports date range: a custom range scopes the ticket-created volume and category breakdown to that window", async () => {
  const inRange = await insertTicket({ subject: "In-range widget", category: "Network", created_at: "2026-01-15 09:00:00" });
  const outOfRange = await insertTicket({ subject: "Out-of-range widget", category: "Network", created_at: "2020-01-15 09:00:00" });

  const html = await (await client.get("/dashboard?report_range=custom&report_from=2026-01-01&report_to=2026-01-31")).text();
  assert.match(html, /2026-01-01 to 2026-01-31/);
  // The volume chart should include the in-range day...
  assert.match(html, /2026-01-15/);
  // ...but a ticket from 2020 has no business appearing in a Jan 2026 window.
  assert.doesNotMatch(html, /2020-01-15/);

  await db.prepare("DELETE FROM tickets WHERE id IN (?, ?)").run(inRange, outOfRange);
});

test("SLA compliance trend: mixes a met and a breached resolution into one bucket's percentage", async () => {
  // Both created and resolved on the same Monday (2026-01-19) so they land
  // in the same day-bucket - one resolved within Medium's 45-business-hour
  // threshold, the other resolved two full weeks (90+ business hours) later
  // than its own creation, well past it.
  const onTime = await insertTicket({
    subject: "Resolved quickly",
    priority: "Medium",
    status: "Resolved",
    created_at: "2026-01-19 09:00:00",
  });
  await insertResolvedActivity(onTime, "2026-01-19 11:00:00");

  const late = await insertTicket({
    subject: "Resolved very late",
    priority: "Medium",
    status: "Resolved",
    created_at: "2026-01-05 09:00:00",
  });
  await insertResolvedActivity(late, "2026-01-19 10:00:00");

  const html = await (
    await client.get("/dashboard?report_range=custom&report_from=2026-01-01&report_to=2026-01-31")
  ).text();
  assert.match(html, /2026-01-19: 50% met \(1\/2 resolved\)/);

  await db.prepare("DELETE FROM ticket_activity WHERE ticket_id IN (?, ?)").run(onTime, late);
  await db.prepare("DELETE FROM tickets WHERE id IN (?, ?)").run(onTime, late);
});

test("Company holidays: add, list, reject invalid input, and delete", async () => {
  const page = await client.get("/dashboard/settings/holidays");
  const csrf = extractCsrf(await page.text());

  const bad = await client.postForm("/dashboard/settings/holidays", { date: "not-a-date", name: "Bad Holiday", _csrf: csrf });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Enter a valid date/);
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM company_holidays WHERE name = 'Bad Holiday'").get()).c, 0);

  await client.postForm("/dashboard/settings/holidays", { date: "2026-12-25", name: "Test Christmas", _csrf: csrf });
  const listHtml = await (await client.get("/dashboard/settings/holidays")).text();
  assert.match(listHtml, /Test Christmas/);
  assert.match(listHtml, /2026-12-25/);

  const row = await db.prepare("SELECT id FROM company_holidays WHERE date = '2026-12-25'").get();
  assert.ok(row);

  const csrf2 = extractCsrf(listHtml);
  await client.postForm(`/dashboard/settings/holidays/${row.id}/delete`, { _csrf: csrf2 });
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM company_holidays WHERE id = ?").get(row.id)).c, 0);
});
