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
    .run("Time Agent", "time-agent@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "time-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function createTicket(subject) {
  const res = await client.postForm("/", {
    requester_name: "Time Requester",
    requester_email: "time-requester@example.com",
    category: "Software",
    subject,
    description: "d",
  });
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("logging time on a ticket shows the entry and running total, and can be removed again", async () => {
  const ticketId = await createTicket("Time tracking test");

  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const logRes = await client.postForm(`/dashboard/tickets/${ticketId}/time`, {
    minutes: "90",
    note: "Diagnosed the issue",
    _csrf: csrf,
  });
  assert.equal(logRes.status, 302);

  let html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(html, /Total: <strong>1h 30m<\/strong>/);
  assert.match(html, /Diagnosed the issue/);
  assert.match(html, /Time Agent/);

  // A second entry adds to the running total.
  const csrf2 = extractCsrf(html);
  await client.postForm(`/dashboard/tickets/${ticketId}/time`, { minutes: "30", _csrf: csrf2 });
  html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(html, /Total: <strong>2h<\/strong>/);

  // Removing the first entry brings the total back down.
  const entryMatch = html.match(/tickets\/\d+\/time\/(\d+)\/delete/);
  assert.ok(entryMatch, "expected a delete form for a logged entry");
  const csrf3 = extractCsrf(html);
  await client.postForm(`/dashboard/tickets/${ticketId}/time/${entryMatch[1]}/delete`, { _csrf: csrf3 });
  html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.doesNotMatch(html, /Total: <strong>2h<\/strong>/);
});

test("logging time rejects a non-numeric or out-of-range minutes value", async () => {
  const ticketId = await createTicket("Bad time entry test");
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());

  const badRes = await client.postForm(`/dashboard/tickets/${ticketId}/time`, { minutes: "not-a-number", _csrf: csrf });
  assert.equal(badRes.status, 400);

  const tooMuchRes = await client.postForm(`/dashboard/tickets/${ticketId}/time`, { minutes: "99999", _csrf: csrf });
  assert.equal(tooMuchRes.status, 400);

  const html = await (await client.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(html, /No time logged yet/);
});

test("the Dashboard's Time tracked report shows a per-agent and per-ticket breakdown for the selected range", async () => {
  const ticketId = await createTicket("Reported time test");
  const page = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await page.text());
  await client.postForm(`/dashboard/tickets/${ticketId}/time`, { minutes: "45", _csrf: csrf });

  const home = await (await client.get("/dashboard")).text();
  assert.match(home, /Time tracked/);
  assert.match(home, /Time Agent/);
  assert.match(home, new RegExp(`tickets/${ticketId}`));
  assert.match(home, /45m/);
});
