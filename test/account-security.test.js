// Two independent features, both about an agent's own account/session
// rather than ticket data itself, so they share one test file:
//   1. Admin-only "view as requester" ticket preview (read-only, logged).
//   2. Optional TOTP two-factor login (src/totp.js), end to end: setup,
//      verify-before-enable, login gate, disable, and the admin lost-device
//      reset.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");
const totp = require("../src/totp");

let app, adminClient, agentClient;

async function loginAs(c, email, password = "correct-password") {
  const loginPage = await c.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  return c.postForm("/login", { email, password, _csrf: csrf });
}

function db() {
  return app.db;
}

before(async () => {
  app = await startTestApp();

  const d = db();
  const passwordHash = bcrypt.hashSync("correct-password", 4);
  await d
    .prepare("INSERT INTO agents (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)")
    .run("Admin Agent", "admin@example.com", passwordHash);
  await d
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Regular Agent", "regular@example.com", passwordHash);

  adminClient = makeClient(app.baseUrl);
  agentClient = makeClient(app.baseUrl);
  await loginAs(adminClient, "admin@example.com");
  await loginAs(agentClient, "regular@example.com");
});

after(() => app.close());

async function createTicketDirect({ subject = "A ticket", category = "Hardware" } = {}) {
  const result = await db()
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email)
       VALUES (?, 'desc', ?, 'Rita Requester', 'rita@example.com')`
    )
    .run(subject, category);
  return result.lastInsertRowid;
}

// ---- View as requester ----------------------------------------------------

test("a non-admin agent can't use view-as-requester", async () => {
  const ticketId = await createTicketDirect({ subject: "Non-admin blocked" });
  const res = await agentClient.get(`/dashboard/tickets/${ticketId}/view-as-requester`);
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /Admins only/);
});

test("an admin sees the exact public status page for the ticket, bannered as preview-only and with no way to act as the requester", async () => {
  const ticketId = await createTicketDirect({ subject: "Preview me", category: "Software" });

  const res = await adminClient.get(`/dashboard/tickets/${ticketId}/view-as-requester`);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Same content a requester would see on /status for this ticket.
  assert.match(html, /Preview me/);
  assert.match(html, /Rita Requester/);

  // Bannered as a preview, not indistinguishable from the real page.
  assert.match(html, /Viewing as requester/);
  assert.match(html, /preview only/);

  // Read-only: no reply form, no ticket-lookup form, no "switch requester" -
  // none of the ways the real public page lets a requester act.
  assert.doesNotMatch(html, /action="\/status\/reply"/);
  assert.doesNotMatch(html, /action="\/status"/);
  assert.doesNotMatch(html, /action="\/requester\/switch"/);
});

test("every view-as-requester use is logged as auditable ticket activity", async () => {
  const ticketId = await createTicketDirect({ subject: "Audited preview" });

  await adminClient.get(`/dashboard/tickets/${ticketId}/view-as-requester`);

  const row = await db()
    .prepare("SELECT body FROM ticket_activity WHERE ticket_id = ? AND type = 'note' ORDER BY id DESC LIMIT 1")
    .get(ticketId);

  assert.ok(row, "expected a ticket_activity row logging the preview");
  assert.match(row.body, /Admin Agent previewed this ticket as the requester/);

  // And it shows up on the ticket's own activity feed in the dashboard.
  const ticketPage = await (await adminClient.get(`/dashboard/tickets/${ticketId}`)).text();
  assert.match(ticketPage, /previewed this ticket as the requester/);
});

test("view-as-requester 404s for a ticket id that doesn't exist", async () => {
  const res = await adminClient.get("/dashboard/tickets/999999/view-as-requester");
  assert.equal(res.status, 404);
});

// ---- TOTP two-factor: the algorithm itself, against RFC 6238's vectors ----

test("TOTP implementation matches RFC 6238's own test vectors (SHA1, 8-digit truncation, decoded through our own base32)", () => {
  // RFC 6238 Appendix B - ASCII secret "12345678901234567890" used directly
  // as the HMAC key (not base32 in the RFC itself); round-tripped through
  // our base32Encode so the same secret shape agents.totp_secret actually
  // stores is what's under test, not just the raw hotp() primitive.
  const secretBuffer = Buffer.from("12345678901234567890", "ascii");
  const secretBase32 = totp.base32Encode(secretBuffer);
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];
  for (const [timeSeconds, expected8Digit] of vectors) {
    const counter = Math.floor(timeSeconds / totp.STEP_SECONDS);
    assert.equal(totp.hotp(secretBuffer, counter, 8), expected8Digit);
    // Our app always uses 6 digits - mod 10^6 of the same binary code is
    // exactly the last 6 digits of the RFC's 8-digit vector.
    assert.equal(totp.generateToken(secretBase32, { time: timeSeconds * 1000 }), expected8Digit.slice(-6));
  }
});

test("TOTP verifyToken accepts one step of clock drift either way and rejects two", () => {
  const secret = totp.generateSecret();
  const now = Date.now();
  const code = totp.generateToken(secret, { time: now });

  assert.equal(totp.verifyToken(secret, code, { time: now }), true);
  assert.equal(totp.verifyToken(secret, code, { time: now + totp.STEP_SECONDS * 1000 }), true);
  assert.equal(totp.verifyToken(secret, code, { time: now - totp.STEP_SECONDS * 1000 }), true);
  assert.equal(totp.verifyToken(secret, code, { time: now + 2 * totp.STEP_SECONDS * 1000 }), false);
  assert.equal(totp.verifyToken(secret, "000000", { time: now }), false);
  assert.equal(totp.verifyToken(secret, "not-a-code", { time: now }), false);
});

// ---- TOTP two-factor: the app's setup/login/disable/reset flows ----------

function extractBetween(html, tagOpenRegex) {
  const match = html.match(tagOpenRegex);
  return match ? match[1] : null;
}

test("2FA setup shows a secret only after starting setup, requires a real code before it's enabled, and rejects a wrong code", async () => {
  const client = makeClient(app.baseUrl);
  await loginAs(client, "regular@example.com");

  const before = await (await client.get("/dashboard/settings/security")).text();
  assert.match(before, /Not enabled/);
  assert.doesNotMatch(before, /Secret/);

  const setupCsrf = extractCsrf(before);
  const setupRes = await client.postForm("/dashboard/settings/security/2fa/setup", { _csrf: setupCsrf });
  assert.equal(setupRes.status, 302); // redirects back to the (now setup-in-progress) settings page
  const afterSetup = await (await client.get("/dashboard/settings/security")).text();
  const secret = extractBetween(afterSetup, /<code>([A-Z2-7]+)<\/code>/);
  assert.ok(secret, "expected a base32 secret on the setup-in-progress page");
  assert.match(afterSetup, /otpauth:\/\/totp\//);

  // A DB row isn't enabled yet - the secret only exists in the session
  // until it's actually verified.
  const row = await db().prepare("SELECT totp_enabled, totp_secret FROM agents WHERE email = ?").get("regular@example.com");
  assert.equal(row.totp_enabled, 0);
  assert.equal(row.totp_secret, null);

  const verifyCsrf = extractCsrf(afterSetup);
  const wrongCodeRes = await client.postForm("/dashboard/settings/security/2fa/verify", {
    code: "000000",
    _csrf: verifyCsrf,
  });
  assert.equal(wrongCodeRes.status, 400);
  const wrongCodeHtml = await wrongCodeRes.text();
  assert.match(wrongCodeHtml, /That code/);
  assert.match(wrongCodeHtml, /Check your device/);

  const rightCode = totp.generateToken(secret);
  const okRes = await client.postForm("/dashboard/settings/security/2fa/verify", {
    code: rightCode,
    _csrf: extractCsrf(wrongCodeHtml),
  });
  assert.equal(okRes.status, 200);
  const okHtml = await okRes.text();
  assert.match(okHtml, /now on/);

  const row2 = await db().prepare("SELECT totp_enabled, totp_secret FROM agents WHERE email = ?").get("regular@example.com");
  assert.equal(row2.totp_enabled, 1);
  assert.equal(row2.totp_secret, secret);
});

test("once 2FA is enabled, login requires the password AND a valid code, and a wrong code is logged as a failed attempt without logging in", async () => {
  const passwordHash = bcrypt.hashSync("correct-password", 4);
  const secret = totp.generateSecret();
  await db()
    .prepare("INSERT INTO agents (name, email, password_hash, totp_secret, totp_enabled) VALUES (?, ?, ?, ?, 1)")
    .run("2FA Agent", "twofactor@example.com", passwordHash, secret);

  const client = makeClient(app.baseUrl);
  const passwordRes = await loginAs(client, "twofactor@example.com");
  // Not logged in yet - redirected to the code step instead of /dashboard.
  assert.equal(passwordRes.status, 302);
  assert.equal(passwordRes.headers.get("location"), "/login/2fa");

  const stillLoggedOut = await client.get("/dashboard");
  assert.equal(stillLoggedOut.status, 302);
  assert.equal(stillLoggedOut.headers.get("location"), "/login");

  const codePage = await (await client.get("/login/2fa")).text();
  const csrf = extractCsrf(codePage);

  const wrongCodeRes = await client.postForm("/login/2fa", { code: "000000", _csrf: csrf });
  assert.equal(wrongCodeRes.status, 401);
  const stillLoggedOut2 = await client.get("/dashboard");
  assert.equal(stillLoggedOut2.status, 302);
  assert.equal(stillLoggedOut2.headers.get("location"), "/login");

  const failedLog = await db()
    .prepare("SELECT success FROM login_log WHERE email = ? ORDER BY id DESC LIMIT 1")
    .get("twofactor@example.com");
  assert.equal(Number(failedLog.success), 0, "a wrong 2FA code should show up as a failed login attempt, not a success");

  const codePage2 = await (await client.get("/login/2fa")).text();
  const csrf2 = extractCsrf(codePage2);
  const rightCode = totp.generateToken(secret);
  const rightCodeRes = await client.postForm("/login/2fa", { code: rightCode, _csrf: csrf2 });
  assert.equal(rightCodeRes.status, 302);
  assert.equal(rightCodeRes.headers.get("location"), "/dashboard");

  const dashboard = await (await client.get("/dashboard")).text();
  assert.equal((await client.get("/dashboard")).status, 200);
  assert.match(dashboard, /Signed in as 2FA Agent/);

  const successLog = await db()
    .prepare("SELECT success, agent_id FROM login_log WHERE email = ? ORDER BY id DESC LIMIT 1")
    .get("twofactor@example.com");
  assert.equal(Number(successLog.success), 1);
});

test("logging in without 2FA enabled is unaffected - straight to the dashboard, same as before this feature existed", async () => {
  const client = makeClient(app.baseUrl);
  // admin@example.com has no 2FA - logs straight in, no /login/2fa detour.
  const res = await loginAs(client, "admin@example.com");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/dashboard");
  assert.equal((await client.get("/dashboard")).status, 200);
});

test("disabling 2FA requires the correct current password", async () => {
  const passwordHash = bcrypt.hashSync("correct-password", 4);
  const secret = totp.generateSecret();
  await db()
    .prepare("INSERT INTO agents (name, email, password_hash, totp_secret, totp_enabled) VALUES (?, ?, ?, ?, 1)")
    .run("Disable Me", "disableme@example.com", passwordHash, secret);

  const client = makeClient(app.baseUrl);
  await loginAs(client, "disableme@example.com");
  const codePage = await (await client.get("/login/2fa")).text();
  await client.postForm("/login/2fa", { code: totp.generateToken(secret), _csrf: extractCsrf(codePage) });
  assert.equal((await client.get("/dashboard")).status, 200);

  const securityPage = await (await client.get("/dashboard/settings/security")).text();
  assert.match(securityPage, /Enabled/);

  const wrongPasswordRes = await client.postForm("/dashboard/settings/security/2fa/disable", {
    password: "not-the-password",
    _csrf: extractCsrf(securityPage),
  });
  assert.equal(wrongPasswordRes.status, 400);
  assert.match(await wrongPasswordRes.text(), /Incorrect password/);

  const stillOn = await db().prepare("SELECT totp_enabled FROM agents WHERE email = ?").get("disableme@example.com");
  assert.equal(stillOn.totp_enabled, 1);

  const rightPasswordRes = await client.postForm("/dashboard/settings/security/2fa/disable", {
    password: "correct-password",
    _csrf: extractCsrf(securityPage),
  });
  assert.equal(rightPasswordRes.status, 200);
  assert.match(await rightPasswordRes.text(), /turned off/);

  const nowOff = await db().prepare("SELECT totp_enabled, totp_secret FROM agents WHERE email = ?").get("disableme@example.com");
  assert.equal(nowOff.totp_enabled, 0);
  assert.equal(nowOff.totp_secret, null);

  // And logging in again no longer asks for a code.
  const freshClient = makeClient(app.baseUrl);
  const loginRes = await loginAs(freshClient, "disableme@example.com");
  assert.equal(loginRes.headers.get("location"), "/dashboard");
});

test("an admin can reset another agent's 2FA (lost device), and it's logged as an auditable admin action", async () => {
  const passwordHash = bcrypt.hashSync("correct-password", 4);
  const secret = totp.generateSecret();
  const insertResult = await db()
    .prepare("INSERT INTO agents (name, email, password_hash, totp_secret, totp_enabled) VALUES (?, ?, ?, ?, 1)")
    .run("Lost Device", "lostdevice@example.com", passwordHash, secret);
  const targetId = insertResult.lastInsertRowid;

  const agentsPage = await (await adminClient.get("/dashboard/agents")).text();
  const csrf = extractCsrf(agentsPage);

  const resetRes = await adminClient.postForm(`/dashboard/agents/${targetId}/reset-2fa`, { _csrf: csrf });
  assert.equal(resetRes.status, 302);

  const row = await db().prepare("SELECT totp_enabled, totp_secret FROM agents WHERE id = ?").get(targetId);
  assert.equal(row.totp_enabled, 0);
  assert.equal(row.totp_secret, null);

  const activityRow = await db()
    .prepare("SELECT body FROM agent_activity WHERE target_agent_id = ? ORDER BY id DESC LIMIT 1")
    .get(targetId);
  assert.ok(activityRow, "expected an agent_activity row for the reset");
  assert.match(activityRow.body, /reset two-factor authentication for Lost Device/);

  const logPage = await (await adminClient.get("/dashboard/settings/login-log")).text();
  assert.match(logPage, /reset two-factor authentication for Lost Device/);

  // The agent can now log in without a code.
  const freshClient = makeClient(app.baseUrl);
  const loginRes = await loginAs(freshClient, "lostdevice@example.com");
  assert.equal(loginRes.headers.get("location"), "/dashboard");
});

test("a non-admin agent can't reset another agent's 2FA", async () => {
  const passwordHash = bcrypt.hashSync("correct-password", 4);
  const insertResult = await db()
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Someone Else", "someoneelse@example.com", passwordHash);
  const targetId = insertResult.lastInsertRowid;

  const page = await (await agentClient.get("/dashboard")).text();
  const csrf = extractCsrf(page);
  const res = await agentClient.postForm(`/dashboard/agents/${targetId}/reset-2fa`, { _csrf: csrf });
  assert.equal(res.status, 403);
});
