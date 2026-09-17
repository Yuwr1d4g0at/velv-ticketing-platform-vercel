// Covers "Sign in with Microsoft" for requesters on the public request form
// (src/routes/public.js + src/msSso.js) - a separate flow from agent login
// (test/auth.test.js), sharing the same Entra app registration but with no
// allow-list: any successfully authenticated velv.pt account is accepted.
//
// Same network constraint as the agent SSO tests: a real Microsoft
// round-trip needs a live Entra tenant, so it isn't covered here. What IS
// covered: the feature-flag behavior (unconfigured = today's plain
// anonymous form, unchanged), the "must sign in first" gate once
// configured, and - the one genuinely security-relevant behavior of this
// whole feature - that a signed-in requester's ticket is attributed to
// their verified session identity even if the submitted form fields try to
// claim someone else. That last part is tested by injecting a requester
// identity directly into the session store's own data column (see
// src/session-store.js), the same trick used to reach otherwise
// network-gated states in test/auth.test.js's sibling suite.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp, makeClient } = require("./helpers");

let app, client, db;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);
  db = app.db;
});

after(() => app.close());

// Injects a verified requester identity directly into a client's session
// row (see the file-level comment above for why - no live Microsoft
// round-trip in this test suite). `client` must have already made at least
// one request so its session row exists. The session table is
// connect-pg-simple's own (see src/sessionStore.js): sid/sess/expire, no
// SQLite-style rowid - "most recently created" is approximated by the
// furthest-out expire timestamp instead (each session's expiry is set from
// its own creation time + a fixed maxAge, so the newest session also has the
// latest expiry). `sess` is a genuine json column - the driver hands it
// back already parsed, no JSON.parse/stringify needed on either side.
async function injectRequesterSession(identity = { email: "verified.person@velv.pt", name: "Verified Person" }) {
  const sessionRow = await db.prepare("SELECT sid, sess FROM session ORDER BY expire DESC LIMIT 1").get();
  const data = sessionRow.sess;
  data.requester = identity;
  await db.prepare("UPDATE session SET sess = ? WHERE sid = ?").run(JSON.stringify(data), sessionRow.sid);
  return identity;
}

test("request form behaves exactly as before when Microsoft SSO isn't configured", async () => {
  const html = await (await client.get("/")).text();
  assert.doesNotMatch(html, /Sign in with Microsoft/);
  assert.match(html, /name="requester_email"/);
});

test("once SSO is configured, the landing page replaces the form and submitting without signing in is rejected", async () => {
  process.env.MS_TENANT_ID = "test-tenant";
  process.env.MS_CLIENT_ID = "test-client";
  process.env.MS_CLIENT_SECRET = "test-secret";
  try {
    const html = await (await client.get("/")).text();
    assert.match(html, /Sign in with Microsoft/);
    assert.doesNotMatch(html, /name="requester_email"/);

    const before = (await db.prepare("SELECT COUNT(*) c FROM tickets").get()).c;
    const res = await client.postForm("/", {
      requester_name: "Nobody",
      requester_email: "nobody@example.com",
      category: "Hardware",
      subject: "Should not be created",
      description: "No requester session yet.",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
    assert.equal((await db.prepare("SELECT COUNT(*) c FROM tickets").get()).c, before);
  } finally {
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
  }
});

test("once signed in, the form locks the identity and a submitted ticket always uses the session's verified identity, never the posted fields", async () => {
  process.env.MS_TENANT_ID = "test-tenant";
  process.env.MS_CLIENT_ID = "test-client";
  process.env.MS_CLIENT_SECRET = "test-secret";
  try {
    const ssoClient = makeClient(app.baseUrl);
    await ssoClient.get("/"); // establishes a real session row (CSRF token generation writes to it)
    await injectRequesterSession();

    const formHtml = await (await ssoClient.get("/")).text();
    assert.match(formHtml, /Submitting as/);
    assert.match(formHtml, /Verified Person/);
    assert.match(formHtml, /verified\.person@velv\.pt/);
    assert.doesNotMatch(formHtml, /name="requester_email"/); // locked, not an editable input

    const res = await ssoClient.postForm("/", {
      requester_name: "Attacker Name",
      requester_email: "attacker@evil.com",
      category: "Hardware",
      subject: "Locked identity test",
      description: "Should use the session identity, not these fields.",
    });
    assert.equal(res.status, 302);
    const ticketId = res.headers.get("location").match(/confirmation\/(\d+)/)[1];
    const ticket = await db.prepare("SELECT requester_name, requester_email FROM tickets WHERE id = ?").get(ticketId);
    assert.equal(ticket.requester_email, "verified.person@velv.pt");
    assert.equal(ticket.requester_name, "Verified Person");
  } finally {
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
  }
});

test("the requester SSO routes 404 when unconfigured, same as the agent ones", async () => {
  assert.equal((await client.get("/auth/microsoft/requester")).status, 404);
  assert.equal((await client.get("/auth/microsoft/requester/callback")).status, 404);
});

test("/status and /kb behave exactly as before when SSO isn't configured", async () => {
  const statusHtml = await (await client.get("/status")).text();
  assert.match(statusHtml, /name="requester_email"/);
  assert.equal((await client.get("/kb")).status, 200);
});

test("/status and /kb redirect to the sign-in landing page once SSO is configured and require signing in", async () => {
  process.env.MS_TENANT_ID = "test-tenant";
  process.env.MS_CLIENT_ID = "test-client";
  process.env.MS_CLIENT_SECRET = "test-secret";
  try {
    const statusRes = await client.get("/status");
    assert.equal(statusRes.status, 302);
    assert.equal(statusRes.headers.get("location"), "/");

    const kbRes = await client.get("/kb");
    assert.equal(kbRes.status, 302);
    assert.equal(kbRes.headers.get("location"), "/");
  } finally {
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
  }
});

test("once signed in, /status locks the email field to the session identity and can't be tricked into looking up someone else's ticket", async () => {
  process.env.MS_TENANT_ID = "test-tenant";
  process.env.MS_CLIENT_ID = "test-client";
  process.env.MS_CLIENT_SECRET = "test-secret";
  try {
    const ssoClient = makeClient(app.baseUrl);
    await ssoClient.get("/");
    const identity = await injectRequesterSession({ email: "status.checker@velv.pt", name: "Status Checker" });

    // A ticket that belongs to the signed-in identity should be findable...
    const mineResult = await db
      .prepare(
        `INSERT INTO tickets (subject, description, category, requester_name, requester_email) VALUES (?, ?, 'Hardware', ?, ?)`
      )
      .run("My own ticket", "desc", identity.name, identity.email);
    const mine = mineResult.lastInsertRowid;
    // ...but one belonging to someone else should not, even if the client
    // tries to submit that other email directly in the form body.
    const someoneElsesResult = await db
      .prepare(
        `INSERT INTO tickets (subject, description, category, requester_name, requester_email) VALUES (?, ?, 'Hardware', ?, ?)`
      )
      .run("Someone else's ticket", "desc", "Other Person", "other.person@velv.pt");
    const someoneElses = someoneElsesResult.lastInsertRowid;

    const statusFormHtml = await (await ssoClient.get("/status")).text();
    assert.match(statusFormHtml, /Checking status as/);
    assert.doesNotMatch(statusFormHtml, /name="requester_email"/);

    const ownLookup = await ssoClient.postForm("/status", { ticket_id: mine, requester_email: "other.person@velv.pt" });
    assert.match(await ownLookup.text(), /My own ticket/);

    const otherLookup = await ssoClient.postForm("/status", { ticket_id: someoneElses, requester_email: "other.person@velv.pt" });
    assert.doesNotMatch(await otherLookup.text(), /Someone else's ticket/);
  } finally {
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
  }
});
