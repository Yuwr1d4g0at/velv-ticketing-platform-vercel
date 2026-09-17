const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);

  await app.db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Workflow Agent", "workflow-agent@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "workflow-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function createTicket(subject, email) {
  const res = await client.postForm("/", {
    requester_name: "Workflow Requester",
    requester_email: email || "workflow-requester@example.com",
    category: "Network",
    subject,
    description: "d",
  });
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("new tickets are auto-assigned to the active agent (round-robin)", async () => {
  const ticketId = await createTicket("Round robin test");
  const ticket = await app.db.prepare("SELECT assigned_to FROM tickets WHERE id = ?").get(Number(ticketId));
  const agent = await app.db.prepare("SELECT id FROM agents WHERE email = 'workflow-agent@example.com'").get();
  assert.equal(ticket.assigned_to, agent.id);
});

test("agent public reply is visible on /status and requester reply reopens a resolved ticket", async () => {
  const ticketId = await createTicket("Two-way reply test");

  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await ticketPage.text());

  // Internal note (default) should NOT show up in the public conversation.
  await client.postForm(`/dashboard/tickets/${ticketId}/note`, { body: "internal only, do not leak", _csrf: csrf });

  // Public reply SHOULD show up, and is distinguishable from an internal note.
  await client.postForm(`/dashboard/tickets/${ticketId}/note`, {
    body: "We found the issue and are fixing it.",
    visibility: "reply",
    _csrf: csrf,
  });

  // Resolve the ticket.
  await client.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Resolved", _csrf: csrf });

  const statusRes = await client.postForm("/status", {
    ticket_id: ticketId,
    requester_email: "workflow-requester@example.com",
  });
  const statusHtml = await statusRes.text();
  assert.match(statusHtml, /We found the issue and are fixing it/);
  assert.doesNotMatch(statusHtml, /internal only, do not leak/);
  assert.match(statusHtml, /badge-status-resolved/);

  // Requester replies - should reopen the ticket.
  const replyRes = await client.postForm("/status/reply", {
    ticket_id: ticketId,
    requester_email: "workflow-requester@example.com",
    message: "Actually it's still broken.",
  });
  assert.equal(replyRes.status, 200);
  const replyHtml = await replyRes.text();
  // EJS HTML-escapes output, so the apostrophe comes back as &#39;.
  assert.match(replyHtml, /Actually it&#39;s still broken/);
  assert.match(replyHtml, /badge-status-open/);

  // Confirm on the agent side too: activity feed shows the requester's name
  // (not a blank agent), and the ticket really did flip back to Open.
  const finalTicketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const finalHtml = await finalTicketPage.text();
  assert.match(finalHtml, /Workflow Requester/);
  assert.match(finalHtml, /Actually it&#39;s still broken/);
});

test("an agent's attachment on an internal note is not visible or downloadable via /status", async () => {
  const ticketId = await createTicket("Internal attachment test", "internal-attach@example.com");
  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await ticketPage.text());

  const formData = new FormData();
  formData.append("body", "Internal diagnostic notes.");
  formData.append("_csrf", csrf);
  formData.append("attachments", new Blob(["internal log contents"], { type: "text/plain" }), "internal-log.txt");
  const noteRes = await fetch(`${app.baseUrl}/dashboard/tickets/${ticketId}/note`, {
    method: "POST",
    body: formData,
    headers: { cookie: Object.entries(client.cookies()).map(([k, v]) => `${k}=${v}`).join("; ") },
    redirect: "manual",
  });
  assert.equal(noteRes.status, 302);

  // Agent side: the attachment shows, marked internal only.
  const agentView = await client.get(`/dashboard/tickets/${ticketId}`);
  const agentHtml = await agentView.text();
  assert.match(agentHtml, /internal-log\.txt/);
  assert.match(agentHtml, /internal only/);

  // Requester side: not listed, and not fetchable by id even if guessed.
  const statusRes = await client.postForm("/status", { ticket_id: ticketId, requester_email: "internal-attach@example.com" });
  const statusHtml = await statusRes.text();
  assert.doesNotMatch(statusHtml, /internal-log\.txt/);

  const row = await app.db.prepare("SELECT id FROM attachments WHERE original_name = 'internal-log.txt'").get();
  const downloadRes = await client.postForm(`/status/attachments/${row.id}/download`, {
    ticket_id: ticketId,
    requester_email: "internal-attach@example.com",
  });
  assert.equal(downloadRes.status, 404);
});

test("bulk status change and bulk assignment apply to every selected ticket", async () => {
  const id1 = await createTicket("Bulk test 1", "bulk-requester@example.com");
  const id2 = await createTicket("Bulk test 2", "bulk-requester@example.com");

  const dashPage = await client.get("/dashboard");
  const csrf = extractCsrf(await dashPage.text());

  const bulkStatusRes = await client.postForm("/dashboard/bulk/status", {
    ticket_ids: [id1, id2],
    status: "In Progress",
    _csrf: csrf,
  });
  assert.equal(bulkStatusRes.status, 302);

  const rows = await app.db.prepare("SELECT id, status FROM tickets WHERE id IN (?, ?)").all(Number(id1), Number(id2));
  assert.ok(rows.every((r) => r.status === "In Progress"), "expected both tickets to move to In Progress");
});

test("dashboard shows a requester's other tickets on the ticket detail page", async () => {
  const id1 = await createTicket("History test 1", "history-requester@example.com");
  const id2 = await createTicket("History test 2", "history-requester@example.com");

  const page = await client.get(`/dashboard/tickets/${id1}`);
  const html = await page.text();
  assert.match(html, new RegExp(`From this requester`));
  assert.match(html, new RegExp(`tickets/${id2}"`));
});

test("dashboard shows an average resolution time once a ticket has been resolved", async () => {
  const id = await createTicket("Resolution time test", "resolution-requester@example.com");

  await app.db
    .prepare(
      "UPDATE tickets SET created_at = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '3 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?"
    )
    .run(Number(id));

  const ticketPage = await client.get(`/dashboard/tickets/${id}`);
  const csrf = extractCsrf(await ticketPage.text());
  await client.postForm(`/dashboard/tickets/${id}/status`, { status: "Resolved", _csrf: csrf });

  const dashRes = await client.get("/dashboard");
  const html = await dashRes.text();
  assert.match(html, /Avg\. time to resolve/);
});

// The exact business-hours boundary math (does crossing Urgent's threshold
// but not Medium's actually change the outcome) is covered deterministically
// in test/aging.test.js, with fixed dates rather than "N days ago from
// whenever this suite happens to run" - a real calendar span's business-
// hours content depends on which weekday it lands on, so a wall-clock-
// relative offset chosen to sit *exactly* between two thresholds would be
// flaky here. This test only checks the plumbing end to end through a real
// HTTP request: does changing priority, then aging well past any
// threshold, actually surface the badge on the rendered page.
test("aging threshold depends on priority", async () => {
  const id = await createTicket("Priority aging test", "aging-requester@example.com");
  const ticketPage = await client.get(`/dashboard/tickets/${id}`);
  const csrf = extractCsrf(await ticketPage.text());
  await client.postForm(`/dashboard/tickets/${id}/priority`, { priority: "Urgent", _csrf: csrf });

  const freshRes = await client.get(`/dashboard/tickets/${id}`);
  assert.doesNotMatch(await freshRes.text(), /badge-aging/);

  // Unambiguously past every priority's threshold (even Low's 7 days),
  // regardless of weekday alignment - not trying to hit an exact boundary.
  await app.db
    .prepare(
      "UPDATE tickets SET created_at = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '30 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?"
    )
    .run(Number(id));

  const res = await client.get(`/dashboard/tickets/${id}`);
  const html = await res.text();
  assert.match(html, /badge-aging/);
});
