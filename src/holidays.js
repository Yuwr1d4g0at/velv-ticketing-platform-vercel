// Company-wide non-working days (see company_holidays in src/db/index.js) -
// business-hours aging/SLA math (src/aging.js) treats each of these as a
// zero-business-hour day, same as a weekend.
//
// Ported to the async Postgres adapter (see src/db/index.js). `INSERT OR
// IGNORE` -> `ON CONFLICT (date) DO NOTHING` (company_holidays.date is the
// unique column).
const db = require("./db");

// One query, returned as a Set for O(1) per-day lookups inside the
// day-by-day loop in aging.js's businessHoursElapsed() - businessHoursElapsed
// is called once per ticket in any list/report render, which was issuing a
// fresh SELECT per ticket (an N+1 query pattern, ~25-50 queries just for
// holiday lookups on a 25-ticket dashboard page). Cached in-process now,
// explicitly invalidated by addHoliday/deleteHoliday below rather than on a
// timer - "always read live" (the original design intent here) still holds
// exactly, since the only two ways this data ever changes are those two
// functions, and both bust the cache immediately. Safe to hand out the same
// Set instance to every caller - nothing here ever mutates it, only reads
// via .has().
let cache = null;

async function holidaySet() {
  if (cache) return cache;
  const rows = await db.prepare("SELECT date FROM company_holidays").all();
  cache = new Set(rows.map((r) => r.date));
  return cache;
}

async function listHolidays() {
  return db.prepare("SELECT * FROM company_holidays ORDER BY date").all();
}

async function addHoliday(date, name) {
  await db.prepare("INSERT INTO company_holidays (date, name) VALUES (?, ?) ON CONFLICT (date) DO NOTHING").run(date, name);
  cache = null;
}

async function deleteHoliday(id) {
  await db.prepare("DELETE FROM company_holidays WHERE id = ?").run(id);
  cache = null;
}

module.exports = { holidaySet, listHolidays, addHoliday, deleteHoliday };
