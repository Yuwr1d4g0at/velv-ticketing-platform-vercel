// Optimistic locking on ticket status/assignment (src/routes/dashboard.js's
// isStale helper) - two agents editing the same ticket at once used to be
// silent last-write-wins, with no signal to whoever's change got
// overwritten. The status/assign forms now carry the ticket's updated_at
// as of when the page was loaded (expected_updated_at, see
// views/dashboard/ticket.ejs); a mismatch against the current row means
// someone else changed it in between.
//
// now_text() (src/db/index.js) only has second-level precision, so two
// real, fast HTTP round-trips can land in the same second and produce
// identical updated_at strings - a false "not stale" that would make a
// timing-based test flaky rather than actually broken. Every test here
// instead sets updated_at directly via SQL to a deterministic, unambiguous
// value before asserting against it, rather than racing two requests
// against the wall clock.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client, db;

before(async () => {
  app = await startTestApp();
  db = app.db;
  const passwordHash = bcrypt.hashSync("correct-password", 4);

  await db.prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)").run("Lock Agent", "lock-agent@example.com", passwordHash);
  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Lock Agent Two", "lock-agent-two@example.com", passwordHash);

  client = makeClient(app.baseUrl);
  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "lock-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function createTicket() {
  const res = await client.postForm("/", {
    requester_name: "Lock Requester",
    requester_email: "lock-requester@example.com",
    category: "Hardware",
    subject: "Optimistic locking test ticket",
    description: "desc",
  });
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("a stale expected_updated_at on /status is rejected with 409 and does not apply the change", async () => {
  const ticketId = await createTicket();
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  const staleUpdatedAt = (await db.prepare("SELECT updated_at FROM tickets WHERE id = ?").get(ticketId)).updated_at;

  // Simulate "someone else changed it since this agent's page loaded" by
  // moving the row's updated_at forward directly - deterministic, no
  // dependency on now_text()'s second-level precision vs. two real
  // requests' actual timing.
  await db.prepare("UPDATE tickets SET updated_at = '2099-01-01 00:00:00' WHERE id = ?").run(ticketId);

  const res = await client.postForm(`/dashboard/tickets/${ticketId}/status`, {
    status: "Resolved",
    expected_updated_at: staleUpdatedAt,
    _csrf: csrf,
  });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /Someone else updated this/);

  const ticket = await db.prepare("SELECT status FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.status, "Open", "the stale request must not have changed the ticket's status");
});

test("submitting with the current expected_updated_at succeeds", async () => {
  const ticketId = await createTicket();
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  const current = (await db.prepare("SELECT updated_at FROM tickets WHERE id = ?").get(ticketId)).updated_at;

  const res = await client.postForm(`/dashboard/tickets/${ticketId}/status`, {
    status: "In Progress",
    expected_updated_at: current,
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  const ticket = await db.prepare("SELECT status FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.status, "In Progress");
});

test("omitting expected_updated_at entirely is never treated as stale - bulk actions and older clients are unaffected", async () => {
  const ticketId = await createTicket();
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await client.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "In Progress", _csrf: csrf });
  assert.equal(res.status, 302);

  const ticket = await db.prepare("SELECT status FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.status, "In Progress");
});

test("the same optimistic-locking check applies to ticket assignment", async () => {
  const ticketId = await createTicket();
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  const before1 = await db.prepare("SELECT updated_at, assigned_to FROM tickets WHERE id = ?").get(ticketId);
  const staleUpdatedAt = before1.updated_at;
  // A new ticket is auto-assigned on creation (round-robin, see README) -
  // never actually unassigned - so the "must not have changed" assertion
  // below compares against whichever agent that was, not null.
  const originalAssignee = before1.assigned_to;

  // A different agent than whoever creation's round-robin picked, so a
  // successful (but wrongly-applied) assignment would be observable as a
  // real change rather than coincidentally matching the original value.
  const otherAgentEmail = originalAssignee === (await db.prepare("SELECT id FROM agents WHERE email = 'lock-agent@example.com'").get()).id
    ? "lock-agent-two@example.com"
    : "lock-agent@example.com";
  const otherAgentId = (await db.prepare("SELECT id FROM agents WHERE email = ?").get(otherAgentEmail)).id;

  await db.prepare("UPDATE tickets SET updated_at = '2099-01-01 00:00:00' WHERE id = ?").run(ticketId);

  const res = await client.postForm(`/dashboard/tickets/${ticketId}/assign`, {
    assigned_to: String(otherAgentId),
    expected_updated_at: staleUpdatedAt,
    _csrf: csrf,
  });
  assert.equal(res.status, 409);

  const ticket = await db.prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.assigned_to, originalAssignee, "the stale assignment attempt must not have changed who it's assigned to");
});
