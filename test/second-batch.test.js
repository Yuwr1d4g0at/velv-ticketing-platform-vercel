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
    .run("Batch Two Agent", "batch-two@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "batch-two@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function submitTicket(fields) {
  const res = await client.postForm("/", {
    requester_name: "Batch Two Requester",
    requester_email: "batch-two-requester@example.com",
    category: "Hardware",
    subject: "Default subject",
    description: "Default description",
    ...fields,
  });
  assert.equal(res.status, 302);
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("failed and successful logins are both recorded in the login log", async () => {
  // A fresh, unauthenticated client - reusing the already-logged-in `client`
  // here would make GET /login redirect straight to /dashboard instead of
  // rendering the form (see its early-return for an existing session),
  // leaving no CSRF token to extract and the POST rejected before ever
  // reaching the password check.
  const anonClient = makeClient(app.baseUrl);
  const loginPage = await anonClient.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await anonClient.postForm("/login", { email: "batch-two@example.com", password: "wrong-password", _csrf: csrf });

  const logHtml = await (await client.get("/dashboard/settings/login-log")).text();
  assert.match(logHtml, /batch-two@example\.com/);
  assert.match(logHtml, /Failed/);
  assert.match(logHtml, /Success/);
});

test("SLA thresholds are editable and the change takes effect without a restart", async () => {
  const page = await client.get("/dashboard/settings");
  const csrf = extractCsrf(await page.text());

  const badRes = await client.postForm("/dashboard/settings", {
    days_Urgent: "0",
    days_High: "2",
    days_Medium: "5",
    days_Low: "7",
    fr_hours_Urgent: "1",
    fr_hours_High: "4",
    fr_hours_Medium: "8",
    fr_hours_Low: "24",
    _csrf: csrf,
  });
  assert.equal(badRes.status, 400);

  const okRes = await client.postForm("/dashboard/settings", {
    days_Urgent: "3",
    days_High: "2",
    days_Medium: "5",
    days_Low: "7",
    fr_hours_Urgent: "1",
    fr_hours_High: "4",
    fr_hours_Medium: "8",
    fr_hours_Low: "24",
    _csrf: csrf,
  });
  assert.equal(okRes.status, 302);

  const row = await db.prepare("SELECT days FROM sla_thresholds WHERE priority = 'Urgent'").get();
  assert.equal(row.days, 3);

  // A ticket 2 days old at Urgent priority is now within the new 3-day
  // threshold (would have been "aging" under the old 1-day default).
  const ticketId = await submitTicket({ subject: "Should not be aging now" });
  await db
    .prepare(
      "UPDATE tickets SET priority = 'Urgent', created_at = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '2 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?"
    )
    .run(ticketId);
  const ticketHtml = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.doesNotMatch(ticketHtml, /badge-aging/);
});

test("webhooks: create, receive a signed POST on ticket creation, pause, and delete", async () => {
  const received = [];
  const { createServer } = require("http");
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise((resolve) => receiver.listen(0, resolve));
  const receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  const page = await client.get("/dashboard/settings/webhooks");
  const csrf = extractCsrf(await page.text());
  await client.postForm("/dashboard/settings/webhooks", { url: receiverUrl, events: "ticket.created", _csrf: csrf });

  await submitTicket({ subject: "Triggers a webhook" });
  await new Promise((resolve) => setTimeout(resolve, 200)); // fire-and-forget delivery

  assert.equal(received.length, 1);
  assert.ok(received[0].headers["x-velv-signature"]);
  const payload = JSON.parse(received[0].body);
  assert.equal(payload.event, "ticket.created");
  assert.equal(payload.data.subject, "Triggers a webhook");

  const listHtml = await (await client.get("/dashboard/settings/webhooks")).text();
  const webhookId = listHtml.match(/webhooks\/(\d+)\/toggle/)[1];
  await client.postForm(`/dashboard/settings/webhooks/${webhookId}/toggle`, { _csrf: csrf });
  await submitTicket({ subject: "Should not trigger, webhook paused" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(received.length, 1); // no new delivery while paused

  await client.postForm(`/dashboard/settings/webhooks/${webhookId}/delete`, { _csrf: csrf });
  const afterDelete = await (await client.get("/dashboard/settings/webhooks")).text();
  assert.doesNotMatch(afterDelete, new RegExp(receiverUrl.replace(/\//g, "\\/")));

  await new Promise((resolve) => receiver.close(resolve));
});

test("agent-initiated ticket creation sets priority and assignment immediately, no round-robin", async () => {
  const page = await client.get("/dashboard/tickets/new");
  const csrf = extractCsrf(await page.text());
  const agentRow = await db.prepare("SELECT id FROM agents WHERE email = 'batch-two@example.com'").get();

  const res = await client.postForm("/dashboard/tickets/new", {
    requester_name: "Phone Caller",
    requester_email: "phone-caller@example.com",
    category: "Hardware",
    subject: "Called in about a broken monitor",
    description: "Reported over the phone.",
    priority: "Urgent",
    assigned_to: agentRow.id,
    _csrf: csrf,
  });
  assert.equal(res.status, 302);
  const ticketId = res.headers.get("location").match(/tickets\/(\d+)/)[1];

  const ticket = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.priority, "Urgent");
  assert.equal(ticket.assigned_to, agentRow.id);

  const html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(html, /Created by Batch Two Agent on behalf of Phone Caller/);
});

test("the print view renders the ticket without the normal site nav", async () => {
  const ticketId = await submitTicket({ subject: "Printable ticket" });
  const res = await client.get(`/dashboard/tickets/${ticketId}/print`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Printable ticket/);
  assert.match(html, /print-button/);
  assert.doesNotMatch(html, /site-header/);
});

test("possible-duplicates card finds a real duplicate even with only partial word overlap, and merges it in one click", async () => {
  // Deliberately NOT near-identical rewording - two different people
  // describing the same printer in their own words, sharing only "Printer"
  // and "fire". An earlier version of this query ANDed every subject word
  // together and missed exactly this case - this is the regression test
  // for that, not just a proof the feature exists at all.
  const originalId = await submitTicket({ subject: "Printer on fire (not literally)" });
  const dupId = await submitTicket({ subject: "Printer smells hot, might be on fire" });

  const dupPage = await client.get(`/dashboard/tickets/${dupId}`);
  const dupHtml = await dupPage.text();
  assert.match(dupHtml, new RegExp(`tickets/${originalId}`));
  assert.match(dupHtml, /Possible duplicates/);

  const csrf = extractCsrf(dupHtml);
  const mergeRes = await client.postForm(`/dashboard/tickets/${dupId}/merge`, { target_ticket_id: originalId, _csrf: csrf });
  assert.equal(mergeRes.status, 302);
});

test("warranty-expiry check emails active agents once, and a date change lets it alert again", async () => {
  const { checkWarrantyAlerts } = require("../src/warranty");

  const assetPage = await client.get("/dashboard/assets");
  const assetCsrf = extractCsrf(await assetPage.text());
  const createRes = await client.postForm("/dashboard/assets", {
    name: "Soon Expiring Laptop",
    category: "Laptop",
    warranty_expires: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    _csrf: assetCsrf,
  });
  const assetId = createRes.headers.get("location").match(/assets\/(\d+)/)[1];

  const firstRun = await checkWarrantyAlerts();
  assert.ok(firstRun >= 1);
  let asset = await db.prepare("SELECT warranty_alerted_at FROM assets WHERE id = ?").get(assetId);
  assert.ok(asset.warranty_alerted_at);

  const secondRun = await checkWarrantyAlerts();
  assert.equal(secondRun, 0); // already alerted, not re-sent

  // Renewing the warranty date clears the alert flag so it can fire again later.
  const detailPage = await client.get(`/dashboard/assets/${assetId}`);
  const editCsrf = extractCsrf(await detailPage.text());
  await client.postForm(`/dashboard/assets/${assetId}`, {
    name: "Soon Expiring Laptop",
    category: "Laptop",
    status: "In Use",
    warranty_expires: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    _csrf: editCsrf,
  });
  asset = await db.prepare("SELECT warranty_alerted_at FROM assets WHERE id = ?").get(assetId);
  assert.equal(asset.warranty_alerted_at, null);

  const listHtml = await (await client.get("/dashboard/assets")).text();
  assert.doesNotMatch(listHtml, /Warranty expiring/);
});
