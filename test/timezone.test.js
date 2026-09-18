// src/app.js defaults process.env.TZ to "Europe/Lisbon" so the "local
// timezone" business-hours window (src/aging.js) and DIGEST_HOUR
// (src/digest.js) mean Lisbon time even on a Vercel Function, which has no
// timezone of its own and defaults to UTC. Requiring test/helpers.js's
// startTestApp() pulls in src/app.js, which is what actually sets TZ - this
// file doesn't need a running app for anything else, just that side effect.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("./helpers");

let app;

before(async () => {
  app = await startTestApp();
});

after(() => app.close());

test("TZ defaults to Europe/Lisbon, not UTC", () => {
  assert.equal(process.env.TZ, "Europe/Lisbon");
});

test("local-time Date methods reflect Lisbon's DST offset, not UTC - the actual behavior this is meant to fix", () => {
  // 2026-07-15 23:30 UTC is 2026-07-16 00:30 in Lisbon (WEST, UTC+1 in
  // July) - a date that only differs between the two interpretations
  // because of DST, so this genuinely distinguishes "TZ correctly applied"
  // from "silently still UTC" rather than coincidentally matching either
  // way (Lisbon and UTC agree for half the year - WET, UTC+0 - which would
  // make a winter date a false-positive test).
  const summerNight = new Date("2026-07-15T23:30:00Z");
  assert.equal(summerNight.getDate(), 16, "in Lisbon's summer DST offset (+1), this instant is already the 16th");
  assert.equal(summerNight.getHours(), 0);
  assert.equal(summerNight.getMinutes(), 30);
});
