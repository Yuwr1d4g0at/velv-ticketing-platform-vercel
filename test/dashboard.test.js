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
    .run("Dash Agent", "dash-agent@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "dash-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function createTicket(subject) {
  const res = await client.postForm("/", {
    requester_name: "Filter Test",
    requester_email: "filter-test@example.com",
    category: "Network",
    subject,
    description: "d",
  });
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("changing priority updates the badge and logs it to the activity feed", async () => {
  const ticketId = await createTicket("Priority test ticket");
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await client.postForm(`/dashboard/tickets/${ticketId}/priority`, { priority: "Urgent", _csrf: csrf });
  assert.equal(res.status, 302);

  const updated = await client.get(`/dashboard/tickets/${ticketId}`);
  const html = await updated.text();
  assert.match(html, /badge-priority-urgent/);
  // EJS HTML-escapes output, so the quotes come back as &#34;.
  assert.match(html, /Priority changed from &#34;Medium&#34; to &#34;Urgent&#34;/);
});

test("priority is rejected if it isn't one of the known values", async () => {
  const ticketId = await createTicket("Bad priority ticket");
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const res = await client.postForm(`/dashboard/tickets/${ticketId}/priority`, { priority: "Catastrophic", _csrf: csrf });
  assert.equal(res.status, 400);
});

test("a ticket older than the aging threshold is flagged on the dashboard", async () => {
  const ticketId = await createTicket("Old forgotten ticket");

  await app.db
    .prepare("UPDATE tickets SET created_at = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '10 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?")
    .run(Number(ticketId));

  const res = await client.get("/dashboard");
  const html = await res.text();
  const rowMatch = html.match(new RegExp(`tickets/${ticketId}"[\\s\\S]{0,400}`));
  assert.ok(rowMatch, "expected to find the ticket's row in the dashboard table");
  assert.match(rowMatch[0], /badge-aging/);
});

test("CSV export returns a well-formed CSV with a header row", async () => {
  await createTicket("CSV export coverage ticket");
  const res = await client.get("/dashboard/export.csv?q=CSV%20export%20coverage");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  const csv = await res.text();
  const lines = csv.trim().split("\r\n");
  assert.equal(lines[0], "ID,Subject,Requester name,Requester email,Category,Subcategory,Priority,Status,Assigned to,Created,Updated");
  assert.ok(lines.some((line) => line.includes("CSV export coverage ticket")));
});

test("dashboard pagination shows page 2 once there are enough tickets", async () => {
  // PAGE_SIZE is 25 (src/constants.js). Inserted directly rather than via the
  // public form: that route is rate-limited (by design - see the
  // "submitting is rate-limited" test in public.test.js), and 30 requests
  // from the same fixture would trip it, which isn't what this test is
  // about.
  const insert = app.db.prepare(
    `INSERT INTO tickets (subject, description, category, requester_name, requester_email)
     VALUES (?, 'd', 'Network', 'Filter Test', 'filter-test@example.com')`
  );
  for (let i = 0; i < 30; i++) {
    await insert.run(`Pagination filler ${i}`);
  }

  const page1 = await client.get("/dashboard?q=Pagination%20filler");
  const page1Html = await page1.text();
  assert.match(page1Html, /Page 1 of/);

  const page2 = await client.get("/dashboard?q=Pagination%20filler&page=2");
  const page2Html = await page2.text();
  assert.match(page2Html, /Page 2 of/);

  // The two pages must not show the exact same set of tickets.
  assert.notEqual(page1Html, page2Html);
});
