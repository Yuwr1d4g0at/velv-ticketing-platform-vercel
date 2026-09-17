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
    .run("Feature Agent", "feature-agent@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "feature-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function createTicket(subject) {
  const res = await client.postForm("/", {
    requester_name: "Feature Test",
    requester_email: "feature-test@example.com",
    category: "Network",
    subject,
    description: "d",
  });
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("tags: adding, filtering, and removing a tag", async () => {
  const ticketId = await createTicket("Tag test ticket");
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const addRes = await client.postForm(`/dashboard/tickets/${ticketId}/tags`, { tag: "Billing", _csrf: csrf });
  assert.equal(addRes.status, 302);

  const withTag = await client.get(`/dashboard/tickets/${ticketId}`);
  const html = await withTag.text();
  assert.match(html, /Billing/);

  // Case-insensitive reuse: "billing" should not create a second tag row.
  await client.postForm(`/dashboard/tickets/${ticketId}/tags`, { tag: "billing", _csrf: csrf });
  const tagCountRow = await app.db.prepare("SELECT COUNT(*) AS c FROM tags WHERE LOWER(name) = LOWER('Billing')").get();
  assert.equal(tagCountRow.c, 1);

  const filtered = await client.get("/dashboard?tag=billing");
  const filteredHtml = await filtered.text();
  assert.match(filteredHtml, /Tag test ticket/);

  const tagRow = await app.db.prepare("SELECT id FROM tags WHERE LOWER(name) = LOWER('Billing')").get();

  const removeRes = await client.postForm(`/dashboard/tickets/${ticketId}/tags/${tagRow.id}/remove`, { _csrf: csrf });
  assert.equal(removeRes.status, 302);
  const afterRemove = await client.get(`/dashboard?tag=billing`);
  const afterRemoveHtml = await afterRemove.text();
  assert.doesNotMatch(afterRemoveHtml, /Tag test ticket/);
});

test("canned responses: create, list, and delete", async () => {
  const listPage = await client.get("/dashboard/canned-responses");
  const csrf = extractCsrf(await listPage.text());

  // Deliberately not "Ask for a screenshot" - that exact phrase is already on
  // the page as the title field's placeholder text, which would make these
  // assertions pass even if create/delete were both silently broken.
  const createRes = await client.postForm("/dashboard/canned-responses", {
    title: "Zzz canned response fixture",
    body: "Could you send a screenshot of the error?",
    _csrf: csrf,
  });
  assert.equal(createRes.status, 302);

  const afterCreate = await client.get("/dashboard/canned-responses");
  const html = await afterCreate.text();
  assert.match(html, /Zzz canned response fixture/);

  const row = await app.db.prepare("SELECT id FROM canned_responses WHERE title = 'Zzz canned response fixture'").get();

  const deleteRes = await client.postForm(`/dashboard/canned-responses/${row.id}/delete`, { _csrf: csrf });
  assert.equal(deleteRes.status, 302);
  const afterDelete = await client.get("/dashboard/canned-responses");
  assert.doesNotMatch(await afterDelete.text(), /Zzz canned response fixture/);
});

test("CSAT: resolving a ticket enables its rating link, which accepts one rating", async () => {
  const ticketId = await createTicket("CSAT test ticket");
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  await client.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Resolved", _csrf: csrf });

  const { rating_token: token } = await app.db.prepare("SELECT rating_token FROM tickets WHERE id = ?").get(Number(ticketId));
  assert.ok(token, "expected a rating_token to be generated on resolve");

  const ratePage = await client.get(`/rate/${token}`);
  assert.equal(ratePage.status, 200);
  const ratePageHtml = await ratePage.text();
  assert.match(ratePageHtml, /How did we do/);

  const badRating = await client.postForm(`/rate/${token}`, { rating: "9" });
  assert.equal(badRating.status, 400);

  const submitRes = await client.postForm(`/rate/${token}`, { rating: "5", comment: "Great help!" });
  assert.equal(submitRes.status, 200);
  assert.match(await submitRes.text(), /Thanks for the feedback/);

  // A bogus token should never resolve to a real ticket.
  const bogus = await client.get("/rate/not-a-real-token");
  assert.equal(bogus.status, 404);
});
