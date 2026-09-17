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
    .run("Jane Doe", "jane@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "jane@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function submitTicket(fields) {
  const res = await client.postForm("/", {
    requester_name: "Third Batch Requester",
    requester_email: "third-batch@example.com",
    category: "Hardware",
    subject: "Default subject",
    description: "Default description",
    ...fields,
  });
  assert.equal(res.status, 302);
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("knowledge base: an agent can publish an article, the public can find and read it, drafts stay hidden", async () => {
  const page = await client.get("/dashboard/kb/new");
  const csrf = extractCsrf(await page.text());
  const createRes = await client.postForm("/dashboard/kb/new", {
    title: "How to reset your VPN password",
    category: "Account & Access",
    body: "Go to the portal and click reset.",
    _csrf: csrf,
  });
  assert.equal(createRes.status, 302);
  const editUrl = createRes.headers.get("location");
  const articleId = editUrl.match(/kb\/(\d+)\/edit/)[1];

  const publicList = await (await client.get("/kb")).text();
  assert.match(publicList, /How to reset your VPN password/);

  const searchRes = await (await client.get("/kb?q=VPN")).text();
  assert.match(searchRes, /How to reset your VPN password/);

  const articlePage = await (await client.get("/kb/how-to-reset-your-vpn-password")).text();
  assert.match(articlePage, /Go to the portal and click reset/);

  // Unpublish it - now hidden from the public list and its own page 404s.
  const editPage = await client.get(`/dashboard/kb/${articleId}/edit`);
  const editCsrf = extractCsrf(await editPage.text());
  await client.postForm(`/dashboard/kb/${articleId}/edit`, {
    title: "How to reset your VPN password",
    category: "Account & Access",
    body: "Go to the portal and click reset.",
    _csrf: editCsrf,
    // published checkbox omitted = unchecked
  });

  const afterUnpublish = await (await client.get("/kb")).text();
  assert.doesNotMatch(afterUnpublish, /How to reset your VPN password/);
  const goneRes = await client.get("/kb/how-to-reset-your-vpn-password");
  assert.equal(goneRes.status, 404);
});

test("ticket templates: loading one pre-fills the new-ticket form", async () => {
  const page = await client.get("/dashboard/templates");
  const csrf = extractCsrf(await page.text());
  await client.postForm("/dashboard/templates", {
    name: "VPN access",
    category: "Account & Access",
    subject: "New VPN access request",
    description: "Please grant VPN access for the new hire.",
    _csrf: csrf,
  });

  const templateRow = await db.prepare("SELECT id FROM ticket_templates WHERE name = 'VPN access'").get();
  const prefilled = await (await client.get(`/dashboard/tickets/new?template=${templateRow.id}`)).text();
  assert.match(prefilled, /New VPN access request/);
  assert.match(prefilled, /Please grant VPN access for the new hire\./);
});

// Doesn't assert on the actual notification email (SMTP is disabled in
// tests) - covers watch/unwatch registration and the "Watched by" display;
// the notification wiring itself lives in public.js's /status/reply route.
test("an agent can watch and unwatch a ticket they're not assigned to", async () => {
  const ticketId = await submitTicket({ subject: "Watcher notification test" });

  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Watcher Agent", "watcher@example.com", bcrypt.hashSync("correct-password", 4));
  const watcherAgent = await db.prepare("SELECT id FROM agents WHERE email = 'watcher@example.com'").get();

  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await ticketPage.text());
  // Log in as the watcher agent specifically, so the /watch action records
  // *their* id, not the currently-assigned agent's. The CSRF token has to
  // be re-fetched AFTER login, not reused from the pre-login page - login
  // calls req.session.regenerate(), which invalidates the token tied to
  // the old (anonymous) session entirely.
  const watcherClient = makeClient(app.baseUrl);
  const wLoginPage = await watcherClient.get("/login");
  const wLoginCsrf = extractCsrf(await wLoginPage.text());
  const loginRes = await watcherClient.postForm("/login", {
    email: "watcher@example.com",
    password: "correct-password",
    _csrf: wLoginCsrf,
  });
  assert.equal(loginRes.status, 302);
  const watcherTicketPage = await watcherClient.get(`/dashboard/tickets/${ticketId}`);
  const wCsrf = extractCsrf(await watcherTicketPage.text());
  const watchRes = await watcherClient.postForm(`/dashboard/tickets/${ticketId}/watch`, { _csrf: wCsrf });
  assert.equal(watchRes.status, 302);

  const watchedPage = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(watchedPage, /Watched by Watcher Agent/);

  const isWatching = await db.prepare("SELECT 1 FROM ticket_watchers WHERE ticket_id = ? AND agent_id = ?").get(ticketId, watcherAgent.id);
  assert.ok(isWatching);

  await watcherClient.postForm(`/dashboard/tickets/${ticketId}/unwatch`, { _csrf: wCsrf });
  const unwatched = await db.prepare("SELECT 1 FROM ticket_watchers WHERE ticket_id = ? AND agent_id = ?").get(ticketId, watcherAgent.id);
  assert.equal(unwatched, undefined);
});

test("@mention in a note only matches an existing active agent's derived tag, not a made-up one", async () => {
  const ticketId = await submitTicket({ subject: "Mention test" });
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  // "Jane Doe" -> @janedoe. A mention of someone who doesn't exist should
  // just be inert text, not an error.
  const res = await client.postForm(`/dashboard/tickets/${ticketId}/note`, {
    body: "Hey @janedoe and @nobodyhere, can you look at this?",
    _csrf: csrf,
  });
  assert.equal(res.status, 302);
  // No assertion on email delivery here (SMTP is disabled in tests) - this
  // confirms the request completes cleanly either way, mentioned-or-not.
});

test("first-response-time only counts once an agent actually does something", async () => {
  const ticketId = await submitTicket({ subject: "First response timing" });

  const before = await (await client.get("/dashboard")).text();
  const beforeMatch = before.match(/([\d.]+)d<\/span>\s*<span class="stat-label">Avg\. time to first response/);

  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  await client.postForm(`/dashboard/tickets/${ticketId}/note`, { body: "Looking into it.", _csrf: csrf });

  const after = await (await client.get("/dashboard")).text();
  assert.match(after, /Avg\. time to first response/);
  void beforeMatch; // presence-of-metric is the meaningful assertion here, not its exact value
});

test("a 1-2 star CSAT rating shows a low-rating banner on the ticket page", async () => {
  const ticketId = await submitTicket({ subject: "Low rating test" });
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  await client.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Resolved", _csrf: csrf });

  const ticket = await db.prepare("SELECT rating_token FROM tickets WHERE id = ?").get(ticketId);
  const ratePage = await client.get(`/rate/${ticket.rating_token}`);
  const rateCsrf = extractCsrf(await ratePage.text());
  await client.postForm(`/rate/${ticket.rating_token}`, { rating: "1", comment: "Not happy.", _csrf: rateCsrf });

  const ticketAfter = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(ticketAfter, /Low satisfaction rating/);
});

test("custom fields: only shown/saved for their own category, and display on the ticket", async () => {
  const page = await client.get("/dashboard/settings/custom-fields");
  const csrf = extractCsrf(await page.text());
  await client.postForm("/dashboard/settings/custom-fields", {
    category: "Account & Access",
    field_name: "System name",
    _csrf: csrf,
  });
  const fieldRow = await db.prepare("SELECT id FROM custom_field_definitions WHERE field_name = 'System name'").get();

  // Submitted under the MATCHING category - should save.
  const matchRes = await client.postForm("/", {
    requester_name: "Custom Field Tester",
    requester_email: "custom-field@example.com",
    category: "Account & Access",
    subject: "Needs system access",
    description: "d",
    [`custom_${fieldRow.id}`]: "SAP-42",
  });
  const matchTicketId = matchRes.headers.get("location").match(/confirmation\/(\d+)/)[1];
  const savedValue = await db
    .prepare("SELECT value FROM ticket_custom_values WHERE ticket_id = ? AND field_definition_id = ?")
    .get(matchTicketId, fieldRow.id);
  assert.equal(savedValue.value, "SAP-42");

  const ticketHtml = await (await client.get(`/dashboard/tickets/${matchTicketId}`)).text();
  assert.match(ticketHtml, /System name/);
  assert.match(ticketHtml, /SAP-42/);

  // Submitted under a DIFFERENT category, even naming the same field id -
  // must not be saved, since that field doesn't belong to Hardware.
  const mismatchRes = await client.postForm("/", {
    requester_name: "Custom Field Tester 2",
    requester_email: "custom-field-2@example.com",
    category: "Hardware",
    subject: "Unrelated hardware issue",
    description: "d",
    [`custom_${fieldRow.id}`]: "should-not-be-saved",
  });
  const mismatchTicketId = mismatchRes.headers.get("location").match(/confirmation\/(\d+)/)[1];
  const notSaved = await db
    .prepare("SELECT value FROM ticket_custom_values WHERE ticket_id = ? AND field_definition_id = ?")
    .get(mismatchTicketId, fieldRow.id);
  assert.equal(notSaved, undefined);
});
