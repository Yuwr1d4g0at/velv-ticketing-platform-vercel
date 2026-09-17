// Deterministic unit tests for the business-hours math in src/aging.js -
// deliberately NOT wall-clock-relative (no "N days ago from whenever this
// test happens to run"), since a real calendar span's business-hours
// content depends on which weekday it lands on. Fixed dates instead: known
// Mondays/Fridays/weekends, so the assertions hold regardless of when the
// suite runs.
//
// businessHoursElapsed now reads the company_holidays table (see
// src/holidays.js) once per call, so - same as every other test file that
// touches src/db, and unlike this file's own past self - this needs the
// isolated test database (see test/helpers.js), not whatever the real
// dev/prod database happens to hold. DATABASE_URL has to point there before
// src/aging (and the src/db it requires) is ever require()'d, since node
// caches both by path - this file doesn't boot the full app (no routes/
// sessions needed for pure business-hours math), so it can't reuse
// startTestApp() itself, but reuses the same isolated database and the same
// migrate()-then-wipe setup.
require("dotenv").config();
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

let businessHoursElapsed, isAgingTicket, agingHoursElapsed, holidays, db;

before(async () => {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/velv_test";
  process.env.DATABASE_URL = url.toString();

  db = require("../src/db");
  const currentDb = (await db.pool.query("SELECT current_database() AS name")).rows[0].name;
  if (currentDb !== "velv_test") {
    throw new Error(`Refusing to run against database "${currentDb}" - tests must run against "velv_test" only.`);
  }
  const { rows } = await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
  if (rows.length) {
    await db.pool.query(`TRUNCATE TABLE ${rows.map((r) => `"${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
  await require("../scripts/migrate").migrate();

  ({ businessHoursElapsed, isAgingTicket, agingHoursElapsed } = require("../src/aging"));
  holidays = require("../src/holidays");
});

after(() => db.pool.end());

// 2026-09-07 is a Monday, 2026-09-14 is the following Monday - fixed
// reference points so every case below is unambiguous.
const MON_9AM = new Date(2026, 8, 7, 9, 0, 0);
const MON_10AM = new Date(2026, 8, 7, 10, 0, 0);
const MON_6PM = new Date(2026, 8, 7, 18, 0, 0);
const TUE_9AM = new Date(2026, 8, 8, 9, 0, 0);
const WED_9AM = new Date(2026, 8, 9, 9, 0, 0);
const FRI_5PM = new Date(2026, 8, 11, 17, 0, 0);
const SAT_10AM = new Date(2026, 8, 12, 10, 0, 0);
const SUN_10AM = new Date(2026, 8, 13, 10, 0, 0);
const NEXT_MON_9AM = new Date(2026, 8, 14, 9, 0, 0);

test("businessHoursElapsed: within one business day", async () => {
  assert.equal(await businessHoursElapsed(MON_9AM, MON_10AM), 1);
  assert.equal(await businessHoursElapsed(MON_9AM, MON_6PM), 9);
});

test("businessHoursElapsed: a full business day plus the start of the next", async () => {
  assert.equal(await businessHoursElapsed(MON_9AM, TUE_9AM), 9);
});

test("businessHoursElapsed: a weekend contributes nothing", async () => {
  assert.equal(await businessHoursElapsed(FRI_5PM, SAT_10AM), 1); // just the last hour of Friday
  assert.equal(await businessHoursElapsed(SAT_10AM, SUN_10AM), 0);
});

test("businessHoursElapsed: Friday evening to the following Monday morning is one business hour, not 64", async () => {
  // A flat elapsed-time clock would call this ~64 calendar hours (Sept 11
  // 5pm to Sept 14 9am). Only the 5-6pm Friday sliver counts - the whole
  // point of this feature.
  assert.equal(await businessHoursElapsed(FRI_5PM, NEXT_MON_9AM), 1);
});

test("businessHoursElapsed: a full business week is 45 hours", async () => {
  assert.equal(await businessHoursElapsed(MON_9AM, NEXT_MON_9AM), 45);
});

test("businessHoursElapsed: end before start is zero, not negative", async () => {
  assert.equal(await businessHoursElapsed(MON_6PM, MON_9AM), 0);
});

test("isAgingTicket: priority changes the threshold given the same elapsed time", async () => {
  // isAgingTicket takes `now` as an injectable third argument specifically
  // so this can be exact and deterministic - created Monday 9am, "now" is
  // the following Monday 9am, exactly 45 business hours later (one full
  // work week). That's past Urgent's 1-day (9h) and Medium's 5-day (45h,
  // not strictly greater - not aging yet) thresholds differently.
  const thresholds = { Urgent: 1, Medium: 5 };
  const createdAt = "2026-09-07 09:00:00"; // Monday, stored/parsed as UTC like a real row
  const now = new Date("2026-09-14T09:00:00Z");
  const urgentTicket = { status: "Open", created_at: createdAt, priority: "Urgent" };
  const mediumTicket = { status: "Open", created_at: createdAt, priority: "Medium" };

  assert.equal(await isAgingTicket(urgentTicket, thresholds, now), true);
  assert.equal(await isAgingTicket(mediumTicket, thresholds, now), false);
});

test("isAgingTicket: closed/resolved tickets never age regardless of elapsed time", async () => {
  const ancient = { status: "Closed", created_at: "2000-01-01 09:00:00", priority: "Urgent" };
  assert.equal(await isAgingTicket(ancient, { Urgent: 1 }), false);
});

test("isAgingTicket: a ticket created seconds ago is never aging, any priority", async () => {
  const justNow = { status: "Open", created_at: new Date().toISOString().slice(0, 19).replace("T", " "), priority: "Urgent" };
  assert.equal(await isAgingTicket(justNow, { Urgent: 1 }), false);
});

test("agingHoursElapsed: past paused_hours are subtracted from the elapsed total", async () => {
  // Created Monday 9am, "now" is the following Monday 9am - 45 raw business
  // hours (see the full-business-week test above). 20 of those were spent
  // waiting on the customer at some earlier point (already folded into
  // paused_hours when the ticket left that status) - only 25 should count.
  const ticket = {
    created_at: "2026-09-07 09:00:00",
    status: "Open",
    paused_hours: 20,
    waiting_since: null,
  };
  const now = new Date("2026-09-14T09:00:00Z");
  assert.equal(await agingHoursElapsed(ticket, now), 25);
});

test("agingHoursElapsed: currently-waiting time is excluded even before it's folded into paused_hours", async () => {
  // Created Monday 9am, entered Waiting on Customer Tuesday 9am (9 business
  // hours in), "now" is Wednesday 9am (27 raw business hours from creation).
  // The 18 hours spent waiting so far (Tue 9am -> Wed 9am) shouldn't count
  // yet, even though waiting_since hasn't been cleared (the ticket is still
  // in that status) - only the 9 hours before it started waiting should.
  const ticket = {
    created_at: "2026-09-07 09:00:00",
    status: "Waiting on Customer",
    paused_hours: 0,
    waiting_since: "2026-09-08 09:00:00",
  };
  const now = new Date("2026-09-09T09:00:00Z");
  assert.equal(await agingHoursElapsed(ticket, now), 9);
});

test("agingHoursElapsed never goes negative even if paused_hours somehow exceeds the raw elapsed time", async () => {
  const ticket = { created_at: "2026-09-07 09:00:00", status: "Open", paused_hours: 999, waiting_since: null };
  const now = new Date("2026-09-08T09:00:00Z");
  assert.equal(await agingHoursElapsed(ticket, now), 0);
});

test("isAgingTicket: a ticket sitting in Waiting on Customer is never flagged as aging", async () => {
  const ancient = {
    status: "Waiting on Customer",
    created_at: "2000-01-01 09:00:00",
    priority: "Urgent",
    waiting_since: "2000-01-01 09:00:00",
    paused_hours: 0,
  };
  assert.equal(await isAgingTicket(ancient, { Urgent: 1 }), false);
});

test("businessHoursElapsed: a company holiday on a weekday contributes nothing, same as a weekend", async () => {
  // Baseline, no holidays yet: Monday 9am -> Wednesday 9am is two full
  // business days (Mon + Tue) = 18 hours.
  assert.equal(await businessHoursElapsed(MON_9AM, WED_9AM), 18);

  await holidays.addHoliday("2026-09-08", "Test Holiday"); // the Tuesday in between
  const added = (await holidays.listHolidays()).find((h) => h.date === "2026-09-08");
  try {
    // Tuesday is now a holiday - only Monday's 9 hours should count, same
    // as if Tuesday had been a Saturday instead.
    assert.equal(await businessHoursElapsed(MON_9AM, WED_9AM), 9);
  } finally {
    await holidays.deleteHoliday(added.id);
  }

  // Cleaned back up - back to the 18-hour baseline, confirming the holiday
  // (not some other side effect) was what changed the result above.
  assert.equal(await businessHoursElapsed(MON_9AM, WED_9AM), 18);
});
