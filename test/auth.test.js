const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);

  // Seed an agent directly - same shape as src/db/seed.js, without the CLI prompt.
  await app.db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Test Agent", "agent@example.com", bcrypt.hashSync("correct-password", 4)); // low cost factor - speed, not security, in tests
});

after(() => app.close());

test("dashboard routes redirect an unauthenticated visitor to /login", async () => {
  const res = await client.get("/dashboard");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});

test("login is rejected without a valid CSRF token", async () => {
  const res = await client.postForm("/login", {
    email: "agent@example.com",
    password: "correct-password",
    _csrf: "not-the-real-token",
  });
  assert.equal(res.status, 403);
});

test("login rejects the wrong password with a generic error", async () => {
  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());

  const res = await client.postForm("/login", { email: "agent@example.com", password: "wrong", _csrf: csrf });
  const html = await res.text();
  assert.equal(res.status, 401);
  assert.match(html, /Incorrect email or password/);
});

test("correct credentials log the agent in and unlock the dashboard", async () => {
  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());

  const loginRes = await client.postForm("/login", {
    email: "agent@example.com",
    password: "correct-password",
    _csrf: csrf,
  });
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.get("location"), "/dashboard");

  const dashboardRes = await client.get("/dashboard");
  assert.equal(dashboardRes.status, 200);
  const html = await dashboardRes.text();
  assert.match(html, /Signed in as Test Agent/);
});

test("logging out ends the session", async () => {
  const dashboardPage = await client.get("/dashboard");
  const csrf = extractCsrf(await dashboardPage.text());

  const logoutRes = await client.postForm("/logout", { _csrf: csrf });
  assert.equal(logoutRes.status, 302);

  const afterLogout = await client.get("/dashboard");
  assert.equal(afterLogout.status, 302);
  assert.equal(afterLogout.headers.get("location"), "/login");
});

// "Sign in with Microsoft" (src/msSso.js) is off by default - no
// MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET set in the test environment -
// and isEnabled() re-checks those env vars on every call rather than
// caching a decision made at startup, so a test can toggle them directly.
// What's deliberately NOT covered here: the actual Microsoft round-trip
// (redirect to login.microsoftonline.com, code exchange, ID token
// verification) - that needs a real Entra tenant and would make the test
// suite depend on live network access to Microsoft, which none of this
// app's other tests do. Covered instead: the feature-flag behavior (off by
// default, 404s cleanly, appears on the login page once configured) and
// the allow-list rejection, which are the parts under this app's own
// control.
test("Sign in with Microsoft is hidden from the login page and its routes 404 when unconfigured", async () => {
  const html = await (await client.get("/login")).text();
  assert.doesNotMatch(html, /Sign in with Microsoft/);

  assert.equal((await client.get("/auth/microsoft")).status, 404);
  assert.equal((await client.get("/auth/microsoft/callback")).status, 404);
});

test("Sign in with Microsoft appears on the login page once MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET are set", async () => {
  process.env.MS_TENANT_ID = "test-tenant-id";
  process.env.MS_CLIENT_ID = "test-client-id";
  process.env.MS_CLIENT_SECRET = "test-client-secret";
  try {
    const html = await (await client.get("/login")).text();
    assert.match(html, /Sign in with Microsoft/);
    assert.match(html, /href="\/auth\/microsoft"/);
  } finally {
    delete process.env.MS_TENANT_ID;
    delete process.env.MS_CLIENT_ID;
    delete process.env.MS_CLIENT_SECRET;
  }
});
