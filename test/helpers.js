// Test scaffolding: boots the real app (src/app.js) against a dedicated,
// isolated Postgres database ("velv_test" - a separate database on the same
// Neon project as dev/prod, created once via `CREATE DATABASE velv_test`,
// never the same database dev/prod use) instead of a throwaway SQLite file,
// since this app no longer has a synchronous, file-based database to spin up
// fresh per test run. A tiny cookie-jar fetch client sits on top since
// node's built-in fetch doesn't carry cookies between requests on its own.
// No test framework dependency - just node:test + node:assert.
//
// node:test runs each test FILE in its own child process by default, so
// there's no cross-file require-cache contamination the way there could be
// within a single process - but every file shares the SAME velv_test
// database, so `npm test` forces serial file execution
// (--test-concurrency=1, see package.json) rather than letting multiple
// files race each other truncating/seeding the same tables at once.
require("dotenv").config();

// Same host/user/password/pooling params as the real DATABASE_URL, just a
// different database name - swapping only the pathname, not hand-building a
// connection string, so this stays correct however the pooler/SSL/etc.
// query params are set up.
function testDatabaseUrl() {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/velv_test";
  return url.toString();
}

// Call once per test file (in a top-level `before`), not once per test case:
// src/app.js and src/db/index.js are cached by node's require() the first
// time they're loaded in this process, so a second call here would silently
// reuse the first call's pool/app rather than getting a fresh one.
async function startTestApp() {
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.SESSION_SECRET = "test-secret-not-for-production";
  process.env.COOKIE_SECURE = "false";
  process.env.CRON_SECRET = "test-cron-secret-not-for-production";
  // Suppresses the dashboard route's opportunistic background-checks trigger
  // (see src/periodicChecks.js) - fire-and-forget by design, so it can still
  // be mid-run when a later request starts, which against this shared,
  // connection-limited test database is a real source of flakiness rather
  // than the harmless wasted work a rare double-fire is in production.
  process.env.NODE_ENV = "test";
  delete process.env.SMTP_HOST; // keep email notifications a no-op in tests
  delete process.env.MS_TENANT_ID; // keep SSO/Graph a no-op in tests
  delete process.env.MS_CLIENT_ID;
  delete process.env.MS_CLIENT_SECRET;

  // Wipe BEFORE migrating, not after: migrate() seed-if-empty's default
  // reference data (departments, categories, SLA thresholds, ...) that
  // agents/tickets/etc. depend on via foreign keys - wiping afterward would
  // truncate that seed data right back out again, leaving e.g. every
  // agent's department_id (DEFAULT 1) pointing at a department row that no
  // longer exists.
  const db = require("../src/db");
  await wipeTestDatabase(db);

  const { migrate } = require("../scripts/migrate");
  await migrate();

  const app = require("../src/app");

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address();

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await db.pool.end();
  }

  return { baseUrl: `http://127.0.0.1:${port}`, close, db };
}

// Wipes every application table so each test file starts from a genuinely
// blank slate, regardless of what a previous file left behind - the direct
// analogue of the old SQLite version always starting from a brand new,
// empty temp file. RESTART IDENTITY resets SERIAL sequences back to 1 too,
// so tests can assert on predictable ids (ticket #1, agent #1, ...) the same
// way they could against a fresh SQLite file.
//
// Safe here specifically because velv_test is a dedicated, isolated
// database that only ever holds throwaway test data - this would be a
// catastrophic operation against the real dev/prod database, which is
// exactly why this refuses to run against anything else (belt-and-braces on
// top of testDatabaseUrl() above always pointing startTestApp() somewhere
// else in the first place).
async function wipeTestDatabase(db) {
  const currentDb = (await db.pool.query("SELECT current_database() AS name")).rows[0].name;
  if (currentDb !== "velv_test") {
    throw new Error(`Refusing to wipe database "${currentDb}" - tests must run against "velv_test" only.`);
  }
  const { rows } = await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  if (!rows.length) return;
  const tableList = rows.map((r) => `"${r.tablename}"`).join(", ");
  await db.pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}

function makeClient(baseUrl) {
  const cookies = {};

  function cookieHeader() {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  function captureCookies(res) {
    const setCookie =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of setCookie) {
      const pair = raw.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
  }

  // Eagerly reads the whole body here, always - regardless of whether the
  // caller ever calls .text() itself. A LOT of call sites across this test
  // suite only check .status/.headers and never touch the body at all
  // (e.g. `assert.equal(res.status, 302)` on a redirect). Undici (node's
  // fetch client) needs a response body fully drained before its underlying
  // socket is safe to reuse for a later request on this same client/agent -
  // leaving a body unconsumed was a genuine, reproduced source of
  // intermittent failures against this suite's real remote database (an
  // in-flight next request occasionally landing before the previous
  // connection had actually finished, most visible on the TOTP 2FA flow's
  // tight timing). Wrapping every response so its body is read exactly once
  // here removes the whole class of bug - every test call site keeps
  // working unchanged (`.status`, `.headers.get(...)`, `await res.text()`).
  async function request(method, urlPath, { body, headers = {}, redirect = "manual" } = {}) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      redirect,
      headers: { ...headers, cookie: cookieHeader() },
      body,
    });
    captureCookies(res);
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      ok: res.ok,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  return {
    get: (urlPath, opts) => request("GET", urlPath, opts),
    post: (urlPath, opts) => request("POST", urlPath, opts),
    // Array values become repeated keys (ticket_ids=1&ticket_ids=2), matching
    // how a browser actually submits multiple checkboxes sharing one name -
    // and how Express/qs parses req.body back into an array server-side.
    // `new URLSearchParams({ x: [1, 2] })` does NOT do this on its own (it
    // stringifies the array into one comma-joined value instead).
    postForm: (urlPath, fields) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(fields)) {
        for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
      }
      return request("POST", urlPath, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
    },
    cookies: () => ({ ...cookies }),
  };
}

function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

module.exports = { startTestApp, makeClient, extractCsrf };
