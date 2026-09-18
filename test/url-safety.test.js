// src/urlSafety.js's SSRF guard for webhook URLs. Uses IP-literal URLs
// throughout (http://127.0.0.1/, http://10.0.0.5/, ...) rather than
// hostnames - dns.lookup() resolves an IP literal instantly with no real
// network call, so these stay fast and don't depend on external DNS being
// reachable from wherever the test suite runs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isUrlSafeForWebhook } = require("../src/urlSafety");

test("a normal public IPv4 address is allowed", async () => {
  assert.equal(await isUrlSafeForWebhook("http://8.8.8.8/hook"), true);
});

test("loopback (127.0.0.1) is blocked outside the test suite", async () => {
  const original = process.env.NODE_ENV;
  delete process.env.NODE_ENV; // simulate a non-test environment
  try {
    assert.equal(await isUrlSafeForWebhook("http://127.0.0.1/hook"), false);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test("loopback (127.0.0.1) is allowed under NODE_ENV=test - the exception test/second-batch.test.js relies on", async () => {
  // Set explicitly here rather than assumed from the ambient environment -
  // this file has no startTestApp() (see test/helpers.js) to set it the
  // way every DB-backed test file does, so NODE_ENV is otherwise whatever
  // (or nothing) the process happened to start with.
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    assert.equal(await isUrlSafeForWebhook("http://127.0.0.1:1/hook"), true);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test("private ranges (10/8, 172.16/12, 192.168/16) are blocked even under NODE_ENV=test", async () => {
  assert.equal(await isUrlSafeForWebhook("http://10.0.0.5/hook"), false);
  assert.equal(await isUrlSafeForWebhook("http://172.16.0.5/hook"), false);
  assert.equal(await isUrlSafeForWebhook("http://192.168.1.5/hook"), false);
});

test("the cloud metadata endpoint (169.254.169.254) is blocked", async () => {
  assert.equal(await isUrlSafeForWebhook("http://169.254.169.254/latest/meta-data"), false);
});

test("the literal hostname 'localhost' is blocked regardless of NODE_ENV", async () => {
  assert.equal(await isUrlSafeForWebhook("http://localhost/hook"), false);
});

test("a normal public IPv6 address is allowed (regression: URL.hostname keeps the [brackets], which broke dns.lookup entirely)", async () => {
  assert.equal(await isUrlSafeForWebhook("http://[2001:4860:4860::8888]/hook"), true);
});

test("IPv6 loopback and link-local are blocked (link-local unconditionally, loopback outside tests)", async () => {
  assert.equal(await isUrlSafeForWebhook("http://[fe80::1]/hook"), false);

  const original = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    assert.equal(await isUrlSafeForWebhook("http://[::1]/hook"), false);
  } finally {
    process.env.NODE_ENV = original;
  }
});

test("a non-http(s) protocol is rejected", async () => {
  assert.equal(await isUrlSafeForWebhook("ftp://8.8.8.8/hook"), false);
  assert.equal(await isUrlSafeForWebhook("file:///etc/passwd"), false);
});

test("an unparseable URL is rejected, not thrown", async () => {
  assert.equal(await isUrlSafeForWebhook("not a url at all"), false);
});
