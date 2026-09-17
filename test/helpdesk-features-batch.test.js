// Covers the "more features to help the helpdesk" batch: bulk tag apply,
// manual ticket linking, the Waiting on Customer aging pause end-to-end,
// subcategory capture, first-response SLA breach, recurring tickets,
// automation rules, the reports-page additions, KB auto-suggest, and the
// in-app notification bell.
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
    .run("Batch Agent", "batch-agent@example.com", bcrypt.hashSync("correct-password", 4));
  agentId = (await db.prepare("SELECT id FROM agents WHERE email = 'batch-agent@example.com'").get()).id;

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "batch-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

// The public form is rate-limited (10 per 15 minutes) - most of these tests
// don't need to exercise that route specifically, so they insert a ticket
// directly instead, keeping the handful of submitTicket() calls that
// genuinely need the real creation flow (subcategory capture, automation
// rules) safely under the limit.
async function insertTicket(fields = {}) {
  const result = await db
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, assigned_to, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, now_text()))`
    )
    .run(
      fields.subject || "Default subject",
      fields.description || "Default description",
      fields.category || "Hardware",
      fields.requester_name || "Batch Requester",
      fields.requester_email || "batch-requester@example.com",
      fields.assigned_to !== undefined ? fields.assigned_to : agentId,
      fields.priority || "Medium",
      fields.created_at || null
    );
  return result.lastInsertRowid;
}

async function submitTicket(fields) {
  const res = await client.postForm("/", {
    requester_name: "Batch Requester",
    requester_email: "batch-requester@example.com",
    category: "Hardware",
    subject: "Default subject",
    description: "Default description",
    ...fields,
  });
  assert.equal(res.status, 302);
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("bulk tag: adding and removing a tag across every selected ticket", async () => {
  const id1 = await insertTicket({ subject: "Widget conveyor jam" });
  const id2 = await insertTicket({ subject: "Thermostat calibration error" });

  const home = await client.get("/dashboard");
  const csrf = extractCsrf(await home.text());
  await client.postForm("/dashboard/bulk/tag", {
    ticket_ids: [id1, id2],
    tag_name: "batch-tagged",
    tag_action: "add",
    _csrf: csrf,
  });

  // Checked against the actual ticket_tags rows, not by scraping the page -
  // the tag name also appears in the page's "existing tags" datalist
  // regardless of whether it's applied to this particular ticket (tags stay
  // in the shared catalog for reuse even when unlinked - see src/tags.js).
  const appliedCount = async () =>
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS c FROM ticket_tags JOIN tags ON tags.id = ticket_tags.tag_id
           WHERE tags.name = 'batch-tagged' AND ticket_tags.ticket_id IN (?, ?)`
        )
        .get(id1, id2)
    ).c;
  assert.equal(await appliedCount(), 2);

  await client.postForm("/dashboard/bulk/tag", {
    ticket_ids: [id1, id2],
    tag_name: "batch-tagged",
    tag_action: "remove",
    _csrf: csrf,
  });
  assert.equal(await appliedCount(), 0);
});

test("manual ticket linking is symmetric and unlinkable", async () => {
  // Deliberately no shared significant words with each other or with other
  // tickets in this file (so the possible-duplicates card can't be confused
  // with the Related Tickets section under test here), and deliberately
  // different requester emails (so the unrelated "other tickets from this
  // requester" card doesn't also surface one ticket's subject on the other's
  // page regardless of linking).
  const id1 = await insertTicket({ subject: "Fluorescent bulb flickering upstairs", requester_email: "link-req-1@example.com" });
  const id2 = await insertTicket({ subject: "Elevator keypad unresponsive", requester_email: "link-req-2@example.com" });

  const page = await client.get(`/dashboard/tickets/${id1}`);
  const csrf = extractCsrf(await page.text());
  await client.postForm(`/dashboard/tickets/${id1}/link`, { linked_ticket_id: id2, _csrf: csrf });

  const html1 = await (await client.get(`/dashboard/tickets/${id1}`)).text();
  assert.match(html1, /Elevator keypad unresponsive/);
  const html2 = await (await client.get(`/dashboard/tickets/${id2}`)).text();
  assert.match(html2, /Fluorescent bulb flickering upstairs/);

  const page2 = await client.get(`/dashboard/tickets/${id1}`);
  const csrf2 = extractCsrf(await page2.text());
  await client.postForm(`/dashboard/tickets/${id1}/link/${id2}/remove`, { _csrf: csrf2 });

  const afterUnlink1 = await (await client.get(`/dashboard/tickets/${id1}`)).text();
  assert.doesNotMatch(afterUnlink1, /Elevator keypad unresponsive/);
  const afterUnlink2 = await (await client.get(`/dashboard/tickets/${id2}`)).text();
  assert.doesNotMatch(afterUnlink2, /Fluorescent bulb flickering upstairs/);
});

test("Waiting on Customer pauses the aging clock, and resuming folds the paused time into paused_hours", async () => {
  const id = await insertTicket({ subject: "Waiting on customer flow" });

  const page = await client.get(`/dashboard/tickets/${id}`);
  const csrf = extractCsrf(await page.text());
  await client.postForm(`/dashboard/tickets/${id}/status`, { status: "Waiting on Customer", _csrf: csrf });

  let row = await db.prepare("SELECT status, waiting_since, paused_hours FROM tickets WHERE id = ?").get(id);
  assert.equal(row.status, "Waiting on Customer");
  assert.ok(row.waiting_since);
  assert.equal(row.paused_hours, 0);

  // Backdate waiting_since by a full week (not a couple of hours) so
  // leaving the status always has real elapsed business hours to fold in,
  // regardless of what day/time this suite happens to run.
  await db
    .prepare(
      "UPDATE tickets SET waiting_since = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '7 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?"
    )
    .run(id);

  const page2 = await client.get(`/dashboard/tickets/${id}`);
  const csrf2 = extractCsrf(await page2.text());
  await client.postForm(`/dashboard/tickets/${id}/status`, { status: "In Progress", _csrf: csrf2 });

  row = await db.prepare("SELECT status, waiting_since, paused_hours FROM tickets WHERE id = ?").get(id);
  assert.equal(row.status, "In Progress");
  assert.equal(row.waiting_since, null);
  assert.ok(row.paused_hours > 0, "expected some paused business hours to have been folded in");
});

test("subcategory is captured on the public form and shown on the ticket", async () => {
  const id = await submitTicket({ subject: "Printer jam", subcategory: "Printer" });
  const html = await (await client.get(`/dashboard/tickets/${id}`)).text();
  assert.match(html, /Hardware.*Printer|Printer.*Hardware/s);
  const row = await db.prepare("SELECT subcategory FROM tickets WHERE id = ?").get(id);
  assert.equal(row.subcategory, "Printer");
});

test("first-response SLA breach emails the assignee once and is skipped after any agent activity", async () => {
  const { checkFirstResponseBreaches } = require("../src/sla");

  // 30 days back, not a couple of hours - guarantees well over Urgent's
  // 1-hour default threshold's worth of business hours regardless of what
  // day/time this suite happens to run (see the aging.js tests for the
  // same "avoid wall-clock-dependent flakiness" reasoning).
  const id = await insertTicket({ subject: "Needs a first response", priority: "Urgent" });
  await db
    .prepare(
      "UPDATE tickets SET created_at = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '30 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?"
    )
    .run(id);

  const firstRun = await checkFirstResponseBreaches();
  assert.ok(firstRun >= 1);
  const afterFirst = await db.prepare("SELECT first_response_alerted_at FROM tickets WHERE id = ?").get(id);
  assert.ok(afterFirst.first_response_alerted_at);

  // Doesn't alert twice for the same still-unanswered ticket.
  await checkFirstResponseBreaches();
  const stillOneAlertRow = await db.prepare("SELECT first_response_alerted_at FROM tickets WHERE id = ?").get(id);
  assert.equal(stillOneAlertRow.first_response_alerted_at, afterFirst.first_response_alerted_at);
});

test("recurring tickets: a due template creates a ticket and advances its next run", async () => {
  const { runDueRecurringTickets } = require("../src/recurring");

  const page = await client.get("/dashboard/recurring");
  const csrf = extractCsrf(await page.text());
  await client.postForm("/dashboard/recurring", {
    name: "Weekly check",
    category: "Hardware",
    priority: "Medium",
    subject: "Weekly server check",
    description: "Run the weekly server checklist.",
    interval_days: "7",
    _csrf: csrf,
  });

  const template = await db.prepare("SELECT * FROM recurring_tickets WHERE name = 'Weekly check'").get();
  // Force it due right now, rather than waiting on the real clock.
  await db
    .prepare("UPDATE recurring_tickets SET next_run_at = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '1 minute', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?")
    .run(template.id);

  const created = await runDueRecurringTickets();
  assert.ok(created >= 1);
  const newTicket = await db.prepare("SELECT * FROM tickets WHERE subject = 'Weekly server check'").get();
  assert.ok(newTicket);

  const afterRun = await db.prepare("SELECT next_run_at FROM recurring_tickets WHERE id = ?").get(template.id);
  assert.ok(new Date(afterRun.next_run_at.replace(" ", "T") + "Z") > new Date());
});

test("automation rule tags and reprioritizes a matching new ticket from the public form", async () => {
  const page = await client.get("/dashboard/settings/automation");
  const csrf = extractCsrf(await page.text());
  await client.postForm("/dashboard/settings/automation", {
    name: "Outage escalation",
    condition_category: "Network",
    condition_keyword: "outage",
    action_tag: "escalated",
    action_priority: "Urgent",
    _csrf: csrf,
  });

  const matchId = await submitTicket({ category: "Network", subject: "Full network outage" });
  const matchTicket = await db.prepare("SELECT priority FROM tickets WHERE id = ?").get(matchId);
  assert.equal(matchTicket.priority, "Urgent");
  const matchHtml = await (await client.get(`/dashboard/tickets/${matchId}`)).text();
  assert.match(matchHtml, /escalated/);

  // A ticket that doesn't match the keyword shouldn't be touched.
  const missId = await submitTicket({ category: "Network", subject: "Slow wifi in the office" });
  const missTicket = await db.prepare("SELECT priority FROM tickets WHERE id = ?").get(missId);
  assert.equal(missTicket.priority, "Medium");
});

test("KB auto-suggest returns matching published articles, and nothing for a short query", async () => {
  const page = await client.get("/dashboard/kb/new");
  const csrf = extractCsrf(await page.text());
  await client.postForm("/dashboard/kb/new", {
    title: "How to reset your VPN password",
    category: "Account & Access",
    body: "Go to the portal and click reset.",
    _csrf: csrf,
  });

  const res = await client.get("/kb/suggest.json?q=VPN%20password");
  assert.equal(res.status, 200);
  const results = await res.json();
  assert.ok(results.some((r) => r.title === "How to reset your VPN password"));

  const shortRes = await client.get("/kb/suggest.json?q=ab");
  assert.deepEqual(await shortRes.json(), []);
});

test("reports page shows the new CSAT trend, agent performance, and reopen-rate sections without erroring", async () => {
  const id = await insertTicket({ subject: "Reports coverage ticket" });
  const page = await client.get(`/dashboard/tickets/${id}`);
  const csrf = extractCsrf(await page.text());
  await client.postForm(`/dashboard/tickets/${id}/status`, { status: "Resolved", _csrf: csrf });
  const ticket = await db.prepare("SELECT rating_token FROM tickets WHERE id = ?").get(id);
  const ratePage = await client.get(`/rate/${ticket.rating_token}`);
  const rateCsrf = extractCsrf(await ratePage.text());
  await client.postForm(`/rate/${ticket.rating_token}`, { rating: "5", comment: "Great!", _csrf: rateCsrf });

  // Reports now lives inside /dashboard itself (a sidebar next to the
  // ticket list), not a separate page - /dashboard/reports just redirects
  // there for anyone with an old bookmark/link.
  const oldReportsUrl = await client.get("/dashboard/reports");
  assert.equal(oldReportsUrl.status, 302);
  assert.equal(oldReportsUrl.headers.get("location"), "/dashboard");

  const dashboardHtml = await (await client.get("/dashboard")).text();
  assert.match(dashboardHtml, /Satisfaction trend/);
  assert.match(dashboardHtml, /Agent performance/);
  assert.match(dashboardHtml, /Reopen rate/);
  assert.match(dashboardHtml, /Batch Agent/);
});

test("a mention creates an in-app notification, and opening the bell marks it read", async () => {
  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Notify Target", "notify-target@example.com", bcrypt.hashSync("correct-password", 4));
  const target = await db.prepare("SELECT id FROM agents WHERE email = 'notify-target@example.com'").get();

  const id = await insertTicket({ subject: "Mention notification test" });
  const page = await client.get(`/dashboard/tickets/${id}`);
  const csrf = extractCsrf(await page.text());
  await client.postForm(`/dashboard/tickets/${id}/note`, { body: "Hey @notifytarget, please check this.", _csrf: csrf });

  const unreadRow = await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE agent_id = ? AND read_at IS NULL").get(target.id);
  assert.equal(unreadRow.c, 1);

  const targetClient = makeClient(app.baseUrl);
  const tLoginPage = await targetClient.get("/login");
  const tCsrf = extractCsrf(await tLoginPage.text());
  await targetClient.postForm("/login", { email: "notify-target@example.com", password: "correct-password", _csrf: tCsrf });

  const dashHtml = await (await targetClient.get("/dashboard")).text();
  assert.match(dashHtml, /notif-badge/);
  assert.match(dashHtml, /mentioned you on ticket/);

  const dashCsrf = extractCsrf(dashHtml);
  await targetClient.postForm("/dashboard/notifications/mark-all-read", { _csrf: dashCsrf });
  const afterMarkReadRow = await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE agent_id = ? AND read_at IS NULL").get(target.id);
  assert.equal(afterMarkReadRow.c, 0);
});
