// Generic approval gate (a category flagged requires_approval can't be
// closed directly - see src/departments.js's categoryRequiresApproval and
// applyStatusChange/submitForApproval in src/routes/dashboard.js) plus its
// configuration for Marketing's content-review pipeline (Content & Design /
// Campaign Request default to requiring approval - see the requires_approval
// migration in src/db/index.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, agentClient, marketingClient, adminClient;

async function loginAs(c, email) {
  const loginPage = await c.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await c.postForm("/login", { email, password: "correct-password", _csrf: csrf });
}

before(async () => {
  app = await startTestApp();

  const d = app.db;
  const passwordHash = bcrypt.hashSync("correct-password", 4);
  // IT (id 1) and Marketing (id 4) - seeded in that fixed order by
  // src/db/index.js's DEFAULT_DEPARTMENTS on a fresh database. Content &
  // Design / Campaign Request are Marketing categories, so a non-admin agent
  // exercising the approval gate on them has to actually belong to
  // Marketing (department-scoped visibility - see src/departments.js -
  // still applies underneath the approval gate; it's a layer on top, not a
  // replacement).
  await d
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, 1)")
    .run("Approval Test IT Agent", "approval-it-agent@example.com", passwordHash);
  await d
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, 4)")
    .run("Approval Test Marketing Agent", "approval-marketing-agent@example.com", passwordHash);
  await d
    .prepare("INSERT INTO agents (name, email, password_hash, department_id, is_admin) VALUES (?, ?, ?, 1, 1)")
    .run("Approval Test Admin", "approval-admin@example.com", passwordHash);

  agentClient = makeClient(app.baseUrl);
  marketingClient = makeClient(app.baseUrl);
  adminClient = makeClient(app.baseUrl);
  await loginAs(agentClient, "approval-it-agent@example.com");
  await loginAs(marketingClient, "approval-marketing-agent@example.com");
  await loginAs(adminClient, "approval-admin@example.com");
});

after(() => app.close());

function db() {
  return app.db;
}

async function createTicketDirect({ subject, category, assignedTo = null }) {
  const result = await db()
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, assigned_to)
       VALUES (?, 'desc', ?, 'Req', 'req@example.com', ?)`
    )
    .run(subject, category, assignedTo);
  return result.lastInsertRowid;
}

async function statusCsrf(client, ticketId) {
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  return extractCsrf(await page.text());
}

test("Marketing's Content & Design and Campaign Request categories require approval by default; other categories don't", async () => {
  const rows = await db().prepare("SELECT name, requires_approval FROM categories").all();

  const byName = Object.fromEntries(rows.map((r) => [r.name, r.requires_approval]));
  assert.equal(byName["Content & Design"], 1, "Content & Design should default to requiring approval");
  assert.equal(byName["Campaign Request"], 1, "Campaign Request should default to requiring approval");
  assert.equal(byName["Brand Assets"], 0, "a Marketing category not part of the content pipeline should NOT require approval");
  assert.equal(byName["Hardware"], 0, "a pre-existing IT category must default to NOT requiring approval (backward compatible)");
});

test("REGRESSION: a category that does NOT require approval closes directly, exactly as before", async () => {
  const ticketId = await createTicketDirect({ subject: "Plain IT close", category: "Hardware" });
  const csrf = await statusCsrf(agentClient, ticketId);

  const res = await agentClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });
  assert.equal(res.status, 302);

  const row = await db().prepare("SELECT status, approval_status FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(row.status, "Closed", "a non-gated category should close immediately");
  assert.equal(row.approval_status, null, "approval_status must stay untouched for a category that doesn't use the gate");
});

test("a category flagged requires_approval blocks a direct close and parks the ticket pending instead", async () => {
  const ticketId = await createTicketDirect({ subject: "Needs sign-off", category: "Content & Design" });
  const csrf = await statusCsrf(marketingClient, ticketId);

  const res = await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });
  assert.equal(res.status, 302);

  const row = await db().prepare("SELECT status, approval_status FROM tickets WHERE id = ?").get(ticketId);
  assert.notEqual(row.status, "Closed", "the ticket must not actually close while approval is pending");
  assert.equal(row.approval_status, "pending");

  const html = await (await marketingClient.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(html, /Pending Approval/);
});

test("submitting for approval is logged as ticket activity", async () => {
  const ticketId = await createTicketDirect({ subject: "Activity on submit", category: "Content & Design" });
  const csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  const row = await db()
    .prepare("SELECT type, body FROM ticket_activity WHERE ticket_id = ? AND type = 'approval_change'")
    .get(ticketId);
  assert.ok(row, "an approval_change activity row should exist");
  assert.match(row.body, /Submitted for approval/i);
});

test("a non-admin agent cannot approve or reject a pending ticket", async () => {
  const ticketId = await createTicketDirect({ subject: "Non-admin approve attempt", category: "Content & Design", assignedTo: null });
  const csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  const csrf2 = await statusCsrf(marketingClient, ticketId);
  const approveRes = await marketingClient.postForm(`/dashboard/tickets/${ticketId}/approval/approve`, { _csrf: csrf2 });
  assert.equal(approveRes.status, 403);
  const rejectRes = await marketingClient.postForm(`/dashboard/tickets/${ticketId}/approval/reject`, { _csrf: csrf2 });
  assert.equal(rejectRes.status, 403);

  const row = await db().prepare("SELECT status, approval_status FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(row.approval_status, "pending", "neither forged action should have changed the pending decision");
  assert.notEqual(row.status, "Closed");
});

test("an admin can approve a pending ticket, which then actually closes and logs activity", async () => {
  const ticketId = await createTicketDirect({ subject: "Approve me", category: "Campaign Request" });
  const csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  const csrf2 = await statusCsrf(adminClient, ticketId);
  const res = await adminClient.postForm(`/dashboard/tickets/${ticketId}/approval/approve`, { _csrf: csrf2 });
  assert.equal(res.status, 302);

  const row = await db().prepare("SELECT status, approval_status FROM tickets WHERE id = ?").get(ticketId);
  const activity = await db().prepare("SELECT type, body FROM ticket_activity WHERE ticket_id = ? ORDER BY id").all(ticketId);
  assert.equal(row.status, "Closed", "approval should let the ticket actually close");
  assert.equal(row.approval_status, "approved");
  assert.ok(activity.some((a) => a.type === "approval_change" && /Approved/.test(a.body)));
  assert.ok(activity.some((a) => a.type === "status_change" && /to "Closed"/.test(a.body)), "the underlying status change should also be logged, same as any other close");
});

test("an admin can reject a pending ticket with a reviewer note; it stays open and the note shows on the ticket page", async () => {
  const ticketId = await createTicketDirect({ subject: "Reject me", category: "Content & Design" });
  const csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  const csrf2 = await statusCsrf(adminClient, ticketId);
  const res = await adminClient.postForm(`/dashboard/tickets/${ticketId}/approval/reject`, {
    note: "Please fix the brand colors before resubmitting.",
    _csrf: csrf2,
  });
  assert.equal(res.status, 302);

  const row = await db().prepare("SELECT status, approval_status, approval_note FROM tickets WHERE id = ?").get(ticketId);
  const activity = await db()
    .prepare("SELECT type, body FROM ticket_activity WHERE ticket_id = ? AND type = 'approval_change'")
    .all(ticketId);
  assert.notEqual(row.status, "Closed", "a rejected ticket must not close");
  assert.equal(row.approval_status, "rejected");
  assert.equal(row.approval_note, "Please fix the brand colors before resubmitting.");
  assert.ok(activity.some((a) => /Rejected/.test(a.body) && /brand colors/.test(a.body)));

  const html = await (await marketingClient.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(html, /Please fix the brand colors before resubmitting\./, "the reviewer note should be visible on the ticket page");
  assert.match(html, /Approval Rejected/);
});

test("after a rejection, resubmitting (selecting Closed again) re-enters the pending gate", async () => {
  const ticketId = await createTicketDirect({ subject: "Resubmit after reject", category: "Content & Design" });
  let csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  csrf = await statusCsrf(adminClient, ticketId);
  await adminClient.postForm(`/dashboard/tickets/${ticketId}/approval/reject`, { note: "Not yet.", _csrf: csrf });

  csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  const row = await db().prepare("SELECT status, approval_status, approval_note FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(row.approval_status, "pending", "resubmitting should move it back to pending");
  assert.notEqual(row.status, "Closed");
  assert.equal(row.approval_note, null, "the stale rejection note should be cleared on resubmit");
});

test("approve/reject 400s if the ticket isn't actually pending", async () => {
  const ticketId = await createTicketDirect({ subject: "Not pending", category: "Content & Design" });
  const csrf = await statusCsrf(adminClient, ticketId);

  const res = await adminClient.postForm(`/dashboard/tickets/${ticketId}/approval/approve`, { _csrf: csrf });
  assert.equal(res.status, 400);
});

test("reopening a previously approved-and-closed ticket clears the old approval decision, so it needs a fresh one to close again", async () => {
  const ticketId = await createTicketDirect({ subject: "Reopen after approval", category: "Campaign Request" });
  let csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  csrf = await statusCsrf(adminClient, ticketId);
  await adminClient.postForm(`/dashboard/tickets/${ticketId}/approval/approve`, { _csrf: csrf });

  csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Open", _csrf: csrf });

  let row = await db().prepare("SELECT status, approval_status FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(row.status, "Open");
  assert.equal(row.approval_status, null, "reopening should clear the previous approval decision");

  csrf = await statusCsrf(marketingClient, ticketId);
  await marketingClient.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Closed", _csrf: csrf });

  row = await db().prepare("SELECT status, approval_status FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(row.approval_status, "pending", "closing again after a reopen must go through the gate again, not sail through on the old approval");
  assert.notEqual(row.status, "Closed");
});

test("the departments/categories settings page can toggle a category's approval requirement", async () => {
  const page = await adminClient.get("/dashboard/settings/departments");
  const html = await page.text();
  const csrf = extractCsrf(html);

  const category = await db().prepare("SELECT id, requires_approval FROM categories WHERE name = 'Brand Assets'").get();
  assert.equal(category.requires_approval, 0);

  const res = await adminClient.postForm(`/dashboard/settings/departments/categories/${category.id}/approval-toggle`, { _csrf: csrf });
  assert.equal(res.status, 302);

  const updated = await db().prepare("SELECT requires_approval FROM categories WHERE id = ?").get(category.id);
  assert.equal(updated.requires_approval, 1, "toggling should now require approval for this category");

  // Toggle back off so this test doesn't leak state into any test that runs after it.
  const csrf2 = extractCsrf(await (await adminClient.get("/dashboard/settings/departments")).text());
  await adminClient.postForm(`/dashboard/settings/departments/categories/${category.id}/approval-toggle`, { _csrf: csrf2 });
});
