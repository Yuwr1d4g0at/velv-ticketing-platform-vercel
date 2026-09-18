// Multi-department support: strict department-scoped visibility, the admin
// bypass, and the confidential flag. See src/departments.js's file comment
// for the history here - this exact feature shipped once before and was
// fully reverted because visibility had a quiet assignment/watcher
// carve-out that made switching an agent's department appear to do
// nothing. These tests deliberately include the regression case (change an
// agent's department, confirm their visible list actually changes) rather
// than only exercising fresh synthetic fixtures, since that's exactly the
// gap the old test suite missed.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

// express-rate-limit's login limiter (10 attempts / 15 min / IP - see
// src/routes/public.js's sibling in src/routes/auth.js) is shared across
// every test in this file (one app instance, one in-memory store), so every
// role logs in exactly ONCE here and every test below reuses that same
// already-authenticated client - not a fresh loginAs() per test, which
// would exhaust the limiter partway through this file and make later tests
// fail with an unrelated "redirected to /login" rather than the thing
// they're actually testing.
let app, client, itClient, hrClient, adminClient, secondItClient, switcherClient, legalClient;

async function loginAs(c, email) {
  const loginPage = await c.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await c.postForm("/login", { email, password: "correct-password", _csrf: csrf });
}

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);

  const db = app.db;
  const passwordHash = bcrypt.hashSync("correct-password", 4);

  // IT is department id 1, HR is id 2 - seeded in that fixed order by
  // src/db/index.js on a fresh database (see DEFAULT_DEPARTMENTS there).
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)")
    .run("IT Agent", "it-agent@example.com", passwordHash, 1);
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)")
    .run("HR Agent", "hr-agent@example.com", passwordHash, 2);
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id, is_admin) VALUES (?, ?, ?, ?, 1)")
    .run("Admin Agent", "admin-agent@example.com", passwordHash, 1);
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, 1)")
    .run("Second IT Agent", "second-it-agent@example.com", passwordHash);
  // A dedicated agent for the one test that actually mutates its own
  // department mid-test (the exact "switch department, does the visible
  // list change" regression) - kept separate from it-agent/hr-agent so that
  // mutation can't bleed into every other test in this file.
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, 1)")
    .run("Switcher Agent", "switcher-agent@example.com", passwordHash);
  // A Legal-department agent (department id 3 - Legal is seeded third, see
  // DEFAULT_DEPARTMENTS in src/db/index.js) - used by the department
  // transfer and department-capacity tests below, both of which want a
  // department untouched by every other test in this file so its
  // tickets/agents start from a known, deterministic zero.
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, 3)")
    .run("Legal Agent", "legal-agent@example.com", passwordHash);

  itClient = makeClient(app.baseUrl);
  hrClient = makeClient(app.baseUrl);
  adminClient = makeClient(app.baseUrl);
  secondItClient = makeClient(app.baseUrl);
  switcherClient = makeClient(app.baseUrl);
  legalClient = makeClient(app.baseUrl);
  await loginAs(itClient, "it-agent@example.com");
  await loginAs(hrClient, "hr-agent@example.com");
  await loginAs(adminClient, "admin-agent@example.com");
  await loginAs(secondItClient, "second-it-agent@example.com");
  await loginAs(switcherClient, "switcher-agent@example.com");
  await loginAs(legalClient, "legal-agent@example.com");
});

after(() => app.close());

function db() {
  return app.db;
}

async function agentId(email) {
  const row = await db().prepare("SELECT id FROM agents WHERE email = ?").get(email);
  return row.id;
}

// Inserts a ticket directly (bypassing auto-assignment/round-robin, which
// has its own dedicated test below) so each visibility test can set up
// exactly the category/assignment/confidential combination it needs.
async function createTicketDirect({ subject, category, assignedTo = null, confidential = 0, requesterEmail = "req@example.com" }) {
  const result = await db()
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, assigned_to, confidential)
       VALUES (?, 'desc', ?, 'Req', ?, ?, ?)`
    )
    .run(subject, category, requesterEmail, assignedTo, confidential);
  return result.lastInsertRowid;
}

test("a non-admin agent only sees tickets in their own department's categories on the dashboard list", async () => {
  const itTicketId = await createTicketDirect({ subject: "IT-only ticket", category: "Hardware" });
  const hrTicketId = await createTicketDirect({ subject: "HR-only ticket", category: "Onboarding" });

  const itHome = await (await itClient.get("/dashboard")).text();
  assert.match(itHome, new RegExp(`tickets/${itTicketId}"`));
  assert.doesNotMatch(itHome, new RegExp(`tickets/${hrTicketId}"`));

  const hrHome = await (await hrClient.get("/dashboard")).text();
  assert.match(hrHome, new RegExp(`tickets/${hrTicketId}"`));
  assert.doesNotMatch(hrHome, new RegExp(`tickets/${itTicketId}"`));
});

test("visiting another department's ticket by id 404s, even though it exists", async () => {
  const hrTicketId = await createTicketDirect({ subject: "HR ticket for 404 check", category: "Benefits" });

  const res = await itClient.get(`/dashboard/tickets/${hrTicketId}`);
  assert.equal(res.status, 404);
});

test("assignment does NOT grant visibility across departments - the exact carve-out that broke this feature last time", async () => {
  const itAgentId = await agentId("it-agent@example.com");
  // An HR-category ticket assigned to the IT agent - this is the precise
  // shape of bug that shipped and was reverted before: a ticket assigned to
  // the one agent being tested made a department switch look like a no-op.
  const hrTicketAssignedToItAgent = await createTicketDirect({
    subject: "HR ticket incorrectly assigned to an IT agent",
    category: "Benefits",
    assignedTo: itAgentId,
  });

  const detailRes = await itClient.get(`/dashboard/tickets/${hrTicketAssignedToItAgent}`);
  assert.equal(detailRes.status, 404, "being assigned to the ticket must not make it visible outside the agent's department");

  const listHtml = await (await itClient.get("/dashboard")).text();
  assert.doesNotMatch(listHtml, new RegExp(`tickets/${hrTicketAssignedToItAgent}"`));
});

test("watching a ticket does not grant visibility across departments either", async () => {
  // There's no route to watch a ticket you can't already see (getTicketOr404
  // gates it), so this proves the point indirectly: confirm the watch route
  // itself 404s for an out-of-department ticket rather than silently
  // succeeding and creating a visibility loophole.
  const hrTicketId = await createTicketDirect({ subject: "HR ticket for watch check", category: "Employee Relations" });
  const page = await itClient.get("/dashboard");
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm(`/dashboard/tickets/${hrTicketId}/watch`, { _csrf: csrf });
  assert.equal(res.status, 404);
});

test("REGRESSION: changing an agent's department changes what they see, without touching the tickets", async () => {
  // Uses the dedicated switcherClient/switcher-agent (see before()), not
  // itClient/it-agent - this test permanently mutates its agent's
  // department, and every other test in this file needs it-agent to stay
  // in IT for its own assumptions to hold.
  const itTicketId = await createTicketDirect({ subject: "Stays IT", category: "Network" });
  const hrTicketId = await createTicketDirect({ subject: "Stays HR", category: "Onboarding" });

  const before1 = await (await switcherClient.get("/dashboard")).text();
  assert.match(before1, new RegExp(`tickets/${itTicketId}"`), "switcher agent should see the IT ticket before switching");
  assert.doesNotMatch(before1, new RegExp(`tickets/${hrTicketId}"`), "switcher agent should not see the HR ticket before switching");

  // Switch the same agent to HR - the exact scenario that silently failed
  // to work last time (department field changed, visible list didn't).
  
  await db().prepare("UPDATE agents SET department_id = 2 WHERE email = ?").run("switcher-agent@example.com");


  const afterHome = await (await switcherClient.get("/dashboard")).text();
  assert.match(afterHome, new RegExp(`tickets/${hrTicketId}"`), "after switching to HR, the agent must now see the HR ticket");
  assert.doesNotMatch(afterHome, new RegExp(`tickets/${itTicketId}"`), "after switching to HR, the agent must no longer see the IT ticket");
});

test("an admin sees tickets from every department", async () => {
  const itTicketId = await createTicketDirect({ subject: "IT ticket for admin check", category: "Software" });
  const hrTicketId = await createTicketDirect({ subject: "HR ticket for admin check", category: "Onboarding" });

  const home = await (await adminClient.get("/dashboard")).text();
  assert.match(home, new RegExp(`tickets/${itTicketId}"`));
  assert.match(home, new RegExp(`tickets/${hrTicketId}"`));

  const itDetail = await adminClient.get(`/dashboard/tickets/${itTicketId}`);
  assert.equal(itDetail.status, 200);
  const hrDetail = await adminClient.get(`/dashboard/tickets/${hrTicketId}`);
  assert.equal(hrDetail.status, 200);
});

test("a confidential ticket is hidden from a same-department agent who isn't its assignee, but visible to the assignee and an admin", async () => {
  const itAgentId = await agentId("it-agent@example.com");

  const confidentialTicketId = await createTicketDirect({
    subject: "Confidential IT ticket",
    category: "Hardware",
    assignedTo: itAgentId,
    confidential: 1,
  });

  const hiddenRes = await secondItClient.get(`/dashboard/tickets/${confidentialTicketId}`);
  assert.equal(hiddenRes.status, 404, "a same-department agent who isn't the assignee must not see a confidential ticket");

  const visibleToAssignee = await itClient.get(`/dashboard/tickets/${confidentialTicketId}`);
  assert.equal(visibleToAssignee.status, 200, "the assignee must still see their own confidential ticket");

  const visibleToAdmin = await adminClient.get(`/dashboard/tickets/${confidentialTicketId}`);
  assert.equal(visibleToAdmin.status, 200, "an admin must still see a confidential ticket");
});

test("toggling the confidential flag on and off works from the ticket page", async () => {
  const itAgentId = await agentId("it-agent@example.com");
  const ticketId = await createTicketDirect({ subject: "Toggle confidential", category: "Hardware", assignedTo: itAgentId });

  const page = await itClient.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const onRes = await itClient.postForm(`/dashboard/tickets/${ticketId}/confidential`, { confidential: "1", _csrf: csrf });
  assert.equal(onRes.status, 302);
  assert.equal((await db().prepare("SELECT confidential FROM tickets WHERE id = ?").get(ticketId)).confidential, 1);

  const offRes = await itClient.postForm(`/dashboard/tickets/${ticketId}/confidential`, { _csrf: csrf });
  assert.equal(offRes.status, 302);
  assert.equal((await db().prepare("SELECT confidential FROM tickets WHERE id = ?").get(ticketId)).confidential, 0);
});

test("CSV export only includes the acting agent's own department's tickets", async () => {
  await createTicketDirect({ subject: "CSV IT ticket", category: "Hardware" });
  await createTicketDirect({ subject: "CSV HR ticket", category: "Benefits" });

  const csv = await (await itClient.get("/dashboard/export.csv")).text();
  assert.match(csv, /CSV IT ticket/);
  assert.doesNotMatch(csv, /CSV HR ticket/);
});

test("a ticket page's 'other tickets from this requester' and 'linked tickets' lists don't leak subject/status across departments", async () => {
  // Same requester files an IT ticket and an HR ticket - before the fix,
  // "other tickets" on the IT ticket's page (matched purely by
  // requester_email, no department filter) would have shown the HR
  // ticket's subject/status to the IT agent.
  const itTicketId = await createTicketDirect({
    subject: "Cross-dept requester IT ticket",
    category: "Hardware",
    requesterEmail: "cross-dept-requester@example.com",
  });
  const hrTicketId = await createTicketDirect({
    subject: "Cross-dept requester HR ticket",
    category: "Onboarding",
    requesterEmail: "cross-dept-requester@example.com",
  });

  const itTicketDetail = await (await itClient.get(`/dashboard/tickets/${itTicketId}`)).text();
  assert.doesNotMatch(itTicketDetail, /Cross-dept requester HR ticket/);

  // Admin still sees it - "other tickets" isn't scoped away for the one
  // role that's supposed to see everything.
  const adminItTicketDetail = await (await adminClient.get(`/dashboard/tickets/${itTicketId}`)).text();
  assert.match(adminItTicketDetail, /Cross-dept requester HR ticket/);

  // Same story for the Link feature - link an IT and an HR ticket together
  // (the app's ordinary cross-department Link, unrelated to "same
  // requester"), and confirm the IT agent viewing their own ticket doesn't
  // see the linked HR ticket's subject/status either.
  const linkedItTicketId = await createTicketDirect({ subject: "Link target IT ticket", category: "Hardware" });
  const linkedHrTicketId = await createTicketDirect({ subject: "Link target HR ticket", category: "Onboarding" });
  await db()
    .prepare("INSERT INTO ticket_links (ticket_id, linked_ticket_id) VALUES (?, ?), (?, ?)")
    .run(linkedItTicketId, linkedHrTicketId, linkedHrTicketId, linkedItTicketId);

  const linkedItTicketDetail = await (await itClient.get(`/dashboard/tickets/${linkedItTicketId}`)).text();
  assert.doesNotMatch(linkedItTicketDetail, /Link target HR ticket/);

  const adminLinkedItTicketDetail = await (await adminClient.get(`/dashboard/tickets/${linkedItTicketId}`)).text();
  assert.match(adminLinkedItTicketDetail, /Link target HR ticket/);
});

test("dashboard full-text search never surfaces a result outside the acting agent's department", async () => {
  await createTicketDirect({ subject: "Searchable widget failure", category: "Hardware" });
  await createTicketDirect({ subject: "Searchable widget failure but HR", category: "Benefits" });

  const html = await (await itClient.get("/dashboard?q=widget")).text();
  assert.match(html, /Searchable widget failure</);
  assert.doesNotMatch(html, /Searchable widget failure but HR/);
});

test("bulk actions silently skip a ticket id outside the acting agent's department instead of applying to it", async () => {
  const hrTicketId = await createTicketDirect({ subject: "Bulk-targeted HR ticket", category: "Onboarding" });

  const page = await itClient.get("/dashboard");
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm("/dashboard/bulk/status", {
    ticket_ids: [String(hrTicketId)],
    status: "Resolved",
    redirect_to: "/dashboard",
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  
  const row = await db().prepare("SELECT status FROM tickets WHERE id = ?").get(hrTicketId);

  assert.equal(row.status, "Open", "a ticket outside the agent's department must not be changed by a bulk action");
});

test("merging two tickets from different departments is rejected, even though both individually exist", async () => {
  const itAgentId = await agentId("it-agent@example.com");
  const itTicketId = await createTicketDirect({ subject: "IT side of a bad merge", category: "Hardware", assignedTo: itAgentId });

  // The target has to be visible to the acting agent to even attempt the
  // merge - use an admin (who can see both sides) to exercise the
  // department-mismatch rejection itself, not the separate 404 visibility
  // check already covered above.
  const hrTicketId = await createTicketDirect({ subject: "HR side of a bad merge", category: "Benefits" });

  const page = await adminClient.get(`/dashboard/tickets/${itTicketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await adminClient.postForm(`/dashboard/tickets/${itTicketId}/merge`, {
    target_ticket_id: String(hrTicketId),
    _csrf: csrf,
  });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /different departments/);

  
  const row = await db().prepare("SELECT merged_into_id FROM tickets WHERE id = ?").get(itTicketId);

  assert.equal(row.merged_into_id, null, "the merge must not have gone through");
});

test("auto-assignment (round-robin) on a publicly submitted ticket only ever picks an agent in that category's department", async () => {
  const res = await client.postForm("/", {
    requester_name: "Dept Test Requester",
    requester_email: "dept-test@example.com",
    category: "Onboarding", // HR
    subject: "Public HR request",
    description: "d",
  });
  const ticketId = res.headers.get("location").match(/confirmation\/(\d+)/)[1];

  
  const ticket = await db().prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(Number(ticketId));
  const assignee = ticket.assigned_to ? await db().prepare("SELECT department_id FROM agents WHERE id = ?").get(ticket.assigned_to) : null;


  assert.ok(assignee, "an HR agent exists in this test's fixtures, so the ticket should have been auto-assigned");
  assert.equal(assignee.department_id, 2, "an HR-category ticket must only ever be auto-assigned to an HR agent");
});

test("an agent can only file a walk-in ticket under their own department's categories", async () => {
  const page = await itClient.get("/dashboard/tickets/new");
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm("/dashboard/tickets/new", {
    requester_name: "Walk-in",
    requester_email: "walkin@example.com",
    category: "Onboarding", // HR category, not the IT agent's own department
    subject: "Should be rejected",
    description: "d",
    _csrf: csrf,
  });
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /choose a valid category/i);
});

test("assigning a ticket to an agent outside its department is rejected", async () => {
  const hrAgentId = await agentId("hr-agent@example.com");
  const itTicketId = await createTicketDirect({ subject: "Cross-department assign attempt", category: "Hardware" });

  const page = await itClient.get(`/dashboard/tickets/${itTicketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm(`/dashboard/tickets/${itTicketId}/assign`, {
    assigned_to: String(hrAgentId),
    _csrf: csrf,
  });
  assert.equal(res.status, 400);

  
  const row = await db().prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(itTicketId);

  assert.equal(row.assigned_to, null, "the cross-department assignment must not have gone through");
});

test("an admin can be assigned any ticket regardless of department", async () => {
  const adminId = await agentId("admin-agent@example.com");
  const hrTicketId = await createTicketDirect({ subject: "Assign to admin", category: "Benefits" });

  const page = await adminClient.get(`/dashboard/tickets/${hrTicketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await adminClient.postForm(`/dashboard/tickets/${hrTicketId}/assign`, {
    assigned_to: String(adminId),
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  
  const row = await db().prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(hrTicketId);

  assert.equal(row.assigned_to, adminId);
});

test("the dashboard reports (volume/category/status) are scoped to the acting agent's own department", async () => {
  await createTicketDirect({ subject: "Report scope IT", category: "Software" });
  await createTicketDirect({ subject: "Report scope HR", category: "Employee Relations" });

  const html = await (await itClient.get("/dashboard?report_range=30d")).text();
  assert.match(html, /Software/);
  assert.doesNotMatch(html, /Employee Relations/);
});

test("KB articles and canned responses scoped to a department don't show up for a different department's agent", async () => {
  
  await db().prepare("INSERT INTO kb_articles (title, slug, body, department_id) VALUES (?, ?, ?, 2)").run(
    "HR-only article",
    "hr-only-article",
    "body text"
  );
  await db().prepare("INSERT INTO canned_responses (title, body, department_id) VALUES (?, ?, 2)").run(
    "HR-only canned response",
    "canned body"
  );


  const kbHtml = await (await itClient.get("/dashboard/kb")).text();
  assert.doesNotMatch(kbHtml, /HR-only article/);

  const cannedHtml = await (await itClient.get("/dashboard/canned-responses")).text();
  assert.doesNotMatch(cannedHtml, /HR-only canned response/);

  const kbHtmlHr = await (await hrClient.get("/dashboard/kb")).text();
  assert.match(kbHtmlHr, /HR-only article/);

  const cannedHtmlHr = await (await hrClient.get("/dashboard/canned-responses")).text();
  assert.match(cannedHtmlHr, /HR-only canned response/);
});

test("a department-scoped automation rule only fires for that department's tickets", async () => {
  
  // action_tag-only rule, scoped to HR (department_id 2), triggered by any
  // ticket in the "Onboarding" category (also HR) - keeps the test to one
  // rule/one condition while still proving cross-department isolation.
  await db().prepare(
    `INSERT INTO automation_rules (name, condition_category, action_tag, department_id) VALUES (?, 'Onboarding', 'hr-tagged', 2)`
  ).run("HR-only tagging rule");


  const hrRes = await client.postForm("/", {
    requester_name: "Automation HR",
    requester_email: "automation-hr@example.com",
    category: "Onboarding",
    subject: "HR automation test",
    description: "d",
  });
  const hrTicketId = hrRes.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const hrTags = await db()
    .prepare("SELECT tags.name FROM ticket_tags JOIN tags ON tags.id = ticket_tags.tag_id WHERE ticket_id = ?")
    .all(Number(hrTicketId));

  assert.ok(hrTags.some((t) => t.name === "hr-tagged"), "the HR-scoped rule should have tagged the HR ticket");
});

test("departments and categories settings page lists seeded departments and can add a new one", async () => {
  const page = await adminClient.get("/dashboard/settings/departments");
  const html = await page.text();
  assert.match(html, /IT/);
  assert.match(html, /HR/);
  const csrf = extractCsrf(html);

  // "Operations" rather than "Legal"/"Marketing" - those are now seeded by
  // default (see DEFAULT_DEPARTMENTS in src/db/index.js), so creating one of
  // them here would collide with the name-uniqueness check instead of
  // testing this route.
  const res = await adminClient.postForm("/dashboard/settings/departments", { name: "Operations", _csrf: csrf });
  assert.equal(res.status, 302);

  
  const row = await db().prepare("SELECT id FROM departments WHERE name = ?").get("Operations");

  assert.ok(row, "the new department should have been created");
});

test("the Agents page shows and can change an agent's department and admin flag", async () => {
  const page = await adminClient.get("/dashboard/agents");
  const html = await page.text();
  const csrf = extractCsrf(html);

  const targetId = await agentId("hr-agent@example.com");
  const res = await adminClient.postForm(`/dashboard/agents/${targetId}/department`, { department_id: "1", _csrf: csrf });
  assert.equal(res.status, 302);

  
  const row = await db().prepare("SELECT department_id FROM agents WHERE id = ?").get(targetId);

  assert.equal(row.department_id, 1, "the agent's department should now be IT");
});

test("a non-admin agent can't view or manage the Agents page, including granting admin", async () => {
  const getRes = await itClient.get("/dashboard/agents");
  assert.equal(getRes.status, 403);

  // Even without ever seeing the real form/CSRF token, confirm a forged
  // request can't grant admin either - this is the exact gap being closed:
  // is_admin used to be settable by any logged-in agent.
  const homeCsrf = extractCsrf(await (await itClient.get("/dashboard")).text());
  const targetId = await agentId("hr-agent@example.com");
  const postRes = await itClient.postForm(`/dashboard/agents/${targetId}/admin`, { is_admin: "1", _csrf: homeCsrf });
  assert.equal(postRes.status, 403);

  
  const row = await db().prepare("SELECT is_admin FROM agents WHERE id = ?").get(targetId);

  assert.equal(row.is_admin, 0, "the target agent must not have been granted admin");
});

// ---- Department transfer -------------------------------------------------
// The only sanctioned way to move a ticket across the strict department
// boundary: an admin changes its category, which is what actually moves it
// (department is always derived from category, never a stored field on the
// ticket - see departments.departmentIdForCategory). Transferring into
// Legal specifically (rather than reusing IT/HR) so this exercises a
// department none of the tests above have touched yet.
test("Transfer to department: admin can move a ticket, which logs activity and immediately flips visibility to the target department", async () => {
  const itTicketId = await createTicketDirect({ subject: "Misfiled with IT, actually a Legal matter", category: "Hardware" });

  // Visible to the sending department before the transfer...
  const beforeIt = await itClient.get(`/dashboard/tickets/${itTicketId}`);
  assert.equal(beforeIt.status, 200, "the IT agent should see the ticket before it's transferred away");
  // ...and not yet visible to the target department.
  const beforeLegal = await legalClient.get(`/dashboard/tickets/${itTicketId}`);
  assert.equal(beforeLegal.status, 404, "the Legal agent should not see an IT ticket before it's transferred to Legal");

  const page = await adminClient.get(`/dashboard/tickets/${itTicketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await adminClient.postForm(`/dashboard/tickets/${itTicketId}/transfer`, {
    category: "Contract Review", // Legal
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  
  const row = await db().prepare("SELECT category FROM tickets WHERE id = ?").get(itTicketId);
  const activity = await db().prepare("SELECT body FROM ticket_activity WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(itTicketId);

  assert.equal(row.category, "Contract Review", "the ticket's category should now be the Legal category that was picked");
  assert.match(activity.body, /Transferred from IT to Legal by Admin Agent\./, "the transfer should be logged as ticket activity naming both departments and who did it");

  // Visibility flips immediately: the sending department's agent can no
  // longer see it, and the target department's agent now can - the exact
  // pair of assertions the task calls out, since this is the one place a
  // quiet visibility carve-out could sneak back in.
  const afterIt = await itClient.get(`/dashboard/tickets/${itTicketId}`);
  assert.equal(afterIt.status, 404, "the sending department's agent must no longer see the transferred ticket");
  const afterLegal = await legalClient.get(`/dashboard/tickets/${itTicketId}`);
  assert.equal(afterLegal.status, 200, "the target department's agent must now see the transferred ticket");
});

test("Transfer to department unassigns a ticket whose current assignee isn't in the target department", async () => {
  const itAgentId = await agentId("it-agent@example.com");
  const ticketId = await createTicketDirect({ subject: "Assigned in IT, transferred to Legal", category: "Software", assignedTo: itAgentId });

  const page = await adminClient.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  const res = await adminClient.postForm(`/dashboard/tickets/${ticketId}/transfer`, { category: "Compliance", _csrf: csrf });
  assert.equal(res.status, 302);

  
  const row = await db().prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(ticketId);

  assert.equal(row.assigned_to, null, "the IT agent is not in Legal, so the transfer should have unassigned the ticket rather than leave a stale cross-department assignment");
});

test("a non-admin agent can't transfer a ticket to another department", async () => {
  const ticketId = await createTicketDirect({ subject: "Non-admin transfer attempt", category: "Hardware" });

  const page = await itClient.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await itClient.postForm(`/dashboard/tickets/${ticketId}/transfer`, { category: "Contract Review", _csrf: csrf });
  assert.equal(res.status, 403);

  
  const row = await db().prepare("SELECT category FROM tickets WHERE id = ?").get(ticketId);

  assert.equal(row.category, "Hardware", "a non-admin's transfer attempt must not have changed the ticket's category");
});

test("transferring to the ticket's own current category is a harmless no-op", async () => {
  const ticketId = await createTicketDirect({ subject: "Transfer to same category", category: "Hardware" });

  const page = await adminClient.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  const res = await adminClient.postForm(`/dashboard/tickets/${ticketId}/transfer`, { category: "Hardware", _csrf: csrf });
  assert.equal(res.status, 302);

  
  const row = await db().prepare("SELECT category FROM tickets WHERE id = ?").get(ticketId);
  const activityCountRow = await db().prepare("SELECT COUNT(*) AS c FROM ticket_activity WHERE ticket_id = ?").get(ticketId);

  assert.equal(row.category, "Hardware");
  assert.equal(activityCountRow.c, 0, "picking the ticket's own current category should not log a spurious transfer activity row");
});

// ---- Department capacity --------------------------------------------------
// Marketing is untouched by every test above (unlike Legal, which the
// transfer tests just moved tickets into), so its counts are exactly
// whatever this test itself creates. Legal's own counts are computed from
// the db rather than hardcoded, since earlier tests in this file have
// already transferred a couple of tickets into it - an exact hardcoded
// count would make this test fragile/order-dependent.
test("department capacity: a regular agent sees only their own department's row, an admin sees every department", async () => {
  await createTicketDirect({ subject: "Legal capacity ticket 1", category: "Contract Review" });
  await createTicketDirect({ subject: "Legal capacity ticket 2", category: "NDA / Confidentiality" });
  await createTicketDirect({ subject: "Marketing capacity ticket (resolved, should not count)", category: "Campaign Request" });
  await db().prepare("UPDATE tickets SET status = 'Resolved' WHERE subject = 'Marketing capacity ticket (resolved, should not count)'").run();

  // One genuinely open Marketing ticket, and no Marketing agent at all -
  // exercises the "0 agents" edge case in the same assertion pass.
  await createTicketDirect({ subject: "Marketing capacity ticket (open)", category: "Brand Assets" });

  async function capacityPattern(departmentId) {
    const openCountRow = await db()
      .prepare(
        `SELECT COUNT(*) AS c FROM tickets
         JOIN categories ON categories.name = tickets.category
         WHERE categories.department_id = ? AND tickets.status IN ('Open', 'In Progress')`
      )
      .get(departmentId);
    const agentCountRow = await db()
      .prepare("SELECT COUNT(*) AS c FROM agents WHERE department_id = ? AND active = 1 AND is_admin = 0")
      .get(departmentId);

    return new RegExp(`${openCountRow.c} open[^<]*&middot;[^<]*${agentCountRow.c} agent`);
  }

  const legalPattern = await capacityPattern(3);
  const marketingPattern = await capacityPattern(4); // 1 open, 0 agents

  const legalHtml = await (await legalClient.get("/dashboard")).text();
  assert.match(legalHtml, /Department capacity/);
  assert.match(legalHtml, /in your own department/, "a non-admin's capacity card should say it's scoped to their own department");
  assert.match(legalHtml, legalPattern, "Legal's capacity card should show Legal's own open-ticket and active-agent counts");
  assert.doesNotMatch(legalHtml, /Marketing/, "a non-admin must not see another department's row in the capacity card");

  const adminHtml = await (await adminClient.get("/dashboard")).text();
  assert.doesNotMatch(adminHtml, /in your own department/, "an admin's capacity card should not claim to be scoped to just one department");
  assert.match(adminHtml, legalPattern, "admin view should still show Legal's own numbers");
  assert.match(adminHtml, marketingPattern, "admin view should show Marketing's 1 open ticket against 0 active agents there");
});
