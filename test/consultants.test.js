// Consultants: a persistent HR/Legal record for external consultants
// (outside counsel, recruiters, expert witnesses, trainers, ...), modeled on
// the Assets feature (CRUD, retire-not-delete, field-level change history,
// CSV export) with department-scoped visibility and a confidential flag
// layered on top - the exact same strict model as tickets (see
// src/departments.js's file comment for why: this shipped once before and
// was fully reverted over a quiet assignment carve-out that made switching
// an agent's department appear to do nothing). The department-switch
// mid-test regression check below is the direct analogue of the one in
// test/multi-department.test.js, applied to consultants instead of tickets.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client, hrClient, legalClient, hrSecondClient, adminClient, switcherClient;

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

  // HR is department id 2, Legal is id 3 - seeded in that fixed order by
  // scripts/migrate.js (IT, HR, Legal, Marketing) on a fresh database.
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)")
    .run("HR Agent", "consultants-hr-agent@example.com", passwordHash, 2);
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)")
    .run("HR Second Agent", "consultants-hr-second-agent@example.com", passwordHash, 2);
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)")
    .run("Legal Agent", "consultants-legal-agent@example.com", passwordHash, 3);
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id, is_admin) VALUES (?, ?, ?, ?, 1)")
    .run("Admin Agent", "consultants-admin-agent@example.com", passwordHash, 1);
  // A dedicated agent for the one test that mutates its own department
  // mid-test, kept separate so that mutation can't bleed into other tests.
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)")
    .run("Switcher Agent", "consultants-switcher-agent@example.com", passwordHash, 2);

  client = makeClient(app.baseUrl);
  hrClient = makeClient(app.baseUrl);
  hrSecondClient = makeClient(app.baseUrl);
  legalClient = makeClient(app.baseUrl);
  adminClient = makeClient(app.baseUrl);
  switcherClient = makeClient(app.baseUrl);
  await loginAs(hrClient, "consultants-hr-agent@example.com");
  await loginAs(hrSecondClient, "consultants-hr-second-agent@example.com");
  await loginAs(legalClient, "consultants-legal-agent@example.com");
  await loginAs(adminClient, "consultants-admin-agent@example.com");
  await loginAs(switcherClient, "consultants-switcher-agent@example.com");
});

after(() => app.close());

function db() {
  return app.db;
}

async function agentId(email) {
  const row = await db().prepare("SELECT id FROM agents WHERE email = ?").get(email);
  return row.id;
}

// Inserts a consultant directly so each visibility test can set up exactly
// the department/assignment/confidential combination it needs, bypassing
// the create route's own department-resolution logic (covered separately
// below).
async function createConsultantDirect({ name, departmentId, assignedTo = null, confidential = 0, status = "Active" }) {
  const result = await db()
    .prepare(
      `INSERT INTO consultants (name, department_id, assigned_to, confidential, status)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, departmentId, assignedTo, confidential, status);
  return result.lastInsertRowid;
}

async function addConsultant(c, fields) {
  const page = await c.get("/dashboard/consultants");
  const csrf = extractCsrf(await page.text());
  const res = await c.postForm("/dashboard/consultants", { name: "Test Consultant", ...fields, _csrf: csrf });
  assert.equal(res.status, 302);
  return res.headers.get("location").match(/consultants\/(\d+)/)[1];
}

// ---- CRUD / retire-not-delete ---------------------------------------------

test("creating a consultant defaults its department to the creating agent's own", async () => {
  const consultantId = await addConsultant(hrClient, { name: "Freelance Recruiter", specialty: "Recruiter" });
  const row = await db().prepare("SELECT department_id FROM consultants WHERE id = ?").get(consultantId);
  assert.equal(row.department_id, 2, "a non-admin's new consultant should land in their own department");
});

test("a non-admin can't escalate department via a forged department_id on create", async () => {
  const page = await hrClient.get("/dashboard/consultants");
  const csrf = extractCsrf(await page.text());
  const res = await hrClient.postForm("/dashboard/consultants", {
    name: "Forged Department Attempt",
    department_id: "3", // Legal - not this agent's own department
    _csrf: csrf,
  });
  assert.equal(res.status, 302);
  const id = res.headers.get("location").match(/consultants\/(\d+)/)[1];
  const row = await db().prepare("SELECT department_id FROM consultants WHERE id = ?").get(id);
  assert.equal(row.department_id, 2, "the forged department_id must be ignored for a non-admin, forced to their own department");
});

test("an admin can pick a different department on create", async () => {
  const page = await adminClient.get("/dashboard/consultants");
  const csrf = extractCsrf(await page.text());
  const res = await adminClient.postForm("/dashboard/consultants", {
    name: "Admin-picked Legal Consultant",
    department_id: "3",
    _csrf: csrf,
  });
  assert.equal(res.status, 302);
  const id = res.headers.get("location").match(/consultants\/(\d+)/)[1];
  const row = await db().prepare("SELECT department_id FROM consultants WHERE id = ?").get(id);
  assert.equal(row.department_id, 3);
});

test("creating a consultant validates required fields", async () => {
  const page = await hrClient.get("/dashboard/consultants");
  const csrf = extractCsrf(await page.text());
  const res = await hrClient.postForm("/dashboard/consultants", { name: "", _csrf: csrf });
  assert.equal(res.status, 400);
});

test("editing a consultant persists changes and logs one activity row per changed field", async () => {
  const consultantId = await addConsultant(hrClient, { name: "Edit Test Consultant", company: "Acme Legal", rate: "$100/hr" });

  const detailPage = await hrClient.get(`/dashboard/consultants/${consultantId}`);
  const csrf = extractCsrf(await detailPage.text());
  const editRes = await hrClient.postForm(`/dashboard/consultants/${consultantId}`, {
    name: "Edit Test Consultant",
    company: "Acme Legal",
    status: "Active",
    rate: "$150/hr",
    _csrf: csrf,
  });
  assert.equal(editRes.status, 302);

  const updated = await hrClient.get(`/dashboard/consultants/${consultantId}`);
  const html = await updated.text();
  assert.match(html, /\$150\/hr/);

  const activity = await db().prepare("SELECT body FROM consultant_activity WHERE consultant_id = ? ORDER BY id DESC LIMIT 1").get(consultantId);
  assert.match(activity.body, /Rate changed from "\$100\/hr" to "\$150\/hr"/);
});

test("retiring a consultant sets status to Ended rather than deleting it, and it stays reachable", async () => {
  const consultantId = await addConsultant(hrClient, { name: "Retiring Consultant" });

  const detailPage = await hrClient.get(`/dashboard/consultants/${consultantId}`);
  const csrf = extractCsrf(await detailPage.text());
  const res = await hrClient.postForm(`/dashboard/consultants/${consultantId}`, {
    name: "Retiring Consultant",
    status: "Ended",
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  const row = await db().prepare("SELECT status FROM consultants WHERE id = ?").get(consultantId);
  assert.equal(row.status, "Ended");

  const stillReachable = await hrClient.get(`/dashboard/consultants/${consultantId}`);
  assert.equal(stillReachable.status, 200, "an ended consultant must still be reachable, never hard-deleted");
  assert.match(await stillReachable.text(), /Ended/);
});

// ---- Department visibility --------------------------------------------------

test("a non-admin agent only sees consultants in their own department on the list", async () => {
  const hrId = await createConsultantDirect({ name: "HR-only consultant", departmentId: 2 });
  const legalId = await createConsultantDirect({ name: "Legal-only consultant", departmentId: 3 });

  const hrList = await (await hrClient.get("/dashboard/consultants")).text();
  assert.match(hrList, new RegExp(`consultants/${hrId}"`));
  assert.doesNotMatch(hrList, new RegExp(`consultants/${legalId}"`));

  const legalList = await (await legalClient.get("/dashboard/consultants")).text();
  assert.match(legalList, new RegExp(`consultants/${legalId}"`));
  assert.doesNotMatch(legalList, new RegExp(`consultants/${hrId}"`));
});

test("visiting another department's consultant by id 404s, even though it exists", async () => {
  const legalId = await createConsultantDirect({ name: "Legal consultant for 404 check", departmentId: 3 });
  const res = await hrClient.get(`/dashboard/consultants/${legalId}`);
  assert.equal(res.status, 404);
});

test("an admin sees consultants from every department", async () => {
  const hrId = await createConsultantDirect({ name: "HR consultant for admin check", departmentId: 2 });
  const legalId = await createConsultantDirect({ name: "Legal consultant for admin check", departmentId: 3 });

  const hrDetail = await adminClient.get(`/dashboard/consultants/${hrId}`);
  assert.equal(hrDetail.status, 200);
  const legalDetail = await adminClient.get(`/dashboard/consultants/${legalId}`);
  assert.equal(legalDetail.status, 200);
});

test("CSV export only includes the acting agent's own department's consultants", async () => {
  await createConsultantDirect({ name: "CSV HR consultant", departmentId: 2 });
  await createConsultantDirect({ name: "CSV Legal consultant", departmentId: 3 });

  const csv = await (await hrClient.get("/dashboard/consultants/export.csv")).text();
  assert.match(csv, /CSV HR consultant/);
  assert.doesNotMatch(csv, /CSV Legal consultant/);
});

// REGRESSION: the exact shape of test that caught the real bug last time -
// create an HR consultant and a Legal consultant, confirm a department-2
// agent sees the HR one and 404s on the Legal one by id, then switch that
// SAME agent's department_id mid-test and confirm the visible set changes.
test("REGRESSION: creating an HR and a Legal consultant, then switching the agent's department, changes what they see", async () => {
  const hrId = await createConsultantDirect({ name: "Regression HR consultant", departmentId: 2 });
  const legalId = await createConsultantDirect({ name: "Regression Legal consultant", departmentId: 3 });

  // Before switching: sees the HR one, 404s on the Legal one by id.
  const hrDetailBefore = await switcherClient.get(`/dashboard/consultants/${hrId}`);
  assert.equal(hrDetailBefore.status, 200, "switcher agent (HR) should see the HR consultant before switching");
  const legalDetailBefore = await switcherClient.get(`/dashboard/consultants/${legalId}`);
  assert.equal(legalDetailBefore.status, 404, "switcher agent (HR) should 404 on the Legal consultant by id before switching");

  const listBefore = await (await switcherClient.get("/dashboard/consultants")).text();
  assert.match(listBefore, new RegExp(`consultants/${hrId}"`));
  assert.doesNotMatch(listBefore, new RegExp(`consultants/${legalId}"`));

  // Switch the same agent to Legal mid-test - the exact scenario that
  // silently failed to work last time this kind of feature shipped.
  await db().prepare("UPDATE agents SET department_id = 3 WHERE email = ?").run("consultants-switcher-agent@example.com");

  // After switching: the visible set flips.
  const hrDetailAfter = await switcherClient.get(`/dashboard/consultants/${hrId}`);
  assert.equal(hrDetailAfter.status, 404, "after switching to Legal, the agent must no longer see the HR consultant");
  const legalDetailAfter = await switcherClient.get(`/dashboard/consultants/${legalId}`);
  assert.equal(legalDetailAfter.status, 200, "after switching to Legal, the agent must now see the Legal consultant");

  const listAfter = await (await switcherClient.get("/dashboard/consultants")).text();
  assert.match(listAfter, new RegExp(`consultants/${legalId}"`), "the switched agent's list should now show the Legal consultant");
  assert.doesNotMatch(listAfter, new RegExp(`consultants/${hrId}"`), "the switched agent's list should no longer show the HR consultant");
});

// ---- Confidential flag -----------------------------------------------------

test("a confidential consultant is hidden from a same-department agent who isn't its assignee, but visible to the assignee and an admin", async () => {
  const hrAgentId = await agentId("consultants-hr-agent@example.com");
  const confidentialId = await createConsultantDirect({
    name: "Confidential HR consultant",
    departmentId: 2,
    assignedTo: hrAgentId,
    confidential: 1,
  });

  const hiddenRes = await hrSecondClient.get(`/dashboard/consultants/${confidentialId}`);
  assert.equal(hiddenRes.status, 404, "a same-department agent who isn't the assignee must not see a confidential consultant");

  const visibleToAssignee = await hrClient.get(`/dashboard/consultants/${confidentialId}`);
  assert.equal(visibleToAssignee.status, 200, "the assignee must still see their own confidential consultant");

  const visibleToAdmin = await adminClient.get(`/dashboard/consultants/${confidentialId}`);
  assert.equal(visibleToAdmin.status, 200, "an admin must still see a confidential consultant");

  const hiddenList = await (await hrSecondClient.get("/dashboard/consultants")).text();
  assert.doesNotMatch(hiddenList, new RegExp(`consultants/${confidentialId}"`), "the confidential consultant must not appear in a non-assignee's list either");
});

test("only an admin or the assigned agent can toggle the confidential flag; anyone else who can see the record gets 403", async () => {
  const hrAgentId = await agentId("consultants-hr-agent@example.com");
  const consultantId = await createConsultantDirect({ name: "Toggle permission test", departmentId: 2, assignedTo: hrAgentId });

  // hrSecondClient can see this consultant (not confidential yet, same
  // department) but is neither its assignee nor an admin.
  const page = await hrSecondClient.get(`/dashboard/consultants/${consultantId}`);
  assert.equal(page.status, 200);
  const csrf = extractCsrf(await page.text());

  const forbidden = await hrSecondClient.postForm(`/dashboard/consultants/${consultantId}/confidential`, { confidential: "1", _csrf: csrf });
  assert.equal(forbidden.status, 403);
  assert.equal((await db().prepare("SELECT confidential FROM consultants WHERE id = ?").get(consultantId)).confidential, 0);

  // The assignee themselves can toggle it on and off.
  const assigneePage = await hrClient.get(`/dashboard/consultants/${consultantId}`);
  const assigneeCsrf = extractCsrf(await assigneePage.text());
  const onRes = await hrClient.postForm(`/dashboard/consultants/${consultantId}/confidential`, { confidential: "1", _csrf: assigneeCsrf });
  assert.equal(onRes.status, 302);
  assert.equal((await db().prepare("SELECT confidential FROM consultants WHERE id = ?").get(consultantId)).confidential, 1);

  const offRes = await hrClient.postForm(`/dashboard/consultants/${consultantId}/confidential`, { _csrf: assigneeCsrf });
  assert.equal(offRes.status, 302);
  assert.equal((await db().prepare("SELECT confidential FROM consultants WHERE id = ?").get(consultantId)).confidential, 0);

  // An admin can also toggle it, even though they're not the assignee.
  const adminPage = await adminClient.get(`/dashboard/consultants/${consultantId}`);
  const adminCsrf = extractCsrf(await adminPage.text());
  const adminOnRes = await adminClient.postForm(`/dashboard/consultants/${consultantId}/confidential`, { confidential: "1", _csrf: adminCsrf });
  assert.equal(adminOnRes.status, 302);
  assert.equal((await db().prepare("SELECT confidential FROM consultants WHERE id = ?").get(consultantId)).confidential, 1);
});

test("confidential consultant in a different department still 404s for that department's agent, not 403", async () => {
  const legalAgentId = await agentId("consultants-legal-agent@example.com");
  const consultantId = await createConsultantDirect({
    name: "Cross-department confidential",
    departmentId: 3,
    assignedTo: legalAgentId,
    confidential: 1,
  });

  const res = await hrClient.get(`/dashboard/consultants/${consultantId}`);
  assert.equal(res.status, 404, "department scoping must still win first - out-of-department is a 404, not a 403, regardless of confidentiality");
});
