// Company-wide non-working days (see company_holidays in src/db/index.js) -
// business-hours aging/SLA math (src/aging.js) treats each of these as a
// zero-business-hour day, same as a weekend.
//
// Ported to the async Postgres adapter (see src/db/index.js). `INSERT OR
// IGNORE` -> `ON CONFLICT (date) DO NOTHING` (company_holidays.date is the
// unique column).
const db = require("./db");

// One query, returned as a Set for O(1) per-day lookups inside the
// day-by-day loop in aging.js's businessHoursElapsed() - fetched fresh each
// call (not cached at module load) so an edit here takes effect
// immediately, same "always read live" convention as sla_thresholds.
async function holidaySet() {
  const rows = await db.prepare("SELECT date FROM company_holidays").all();
  return new Set(rows.map((r) => r.date));
}

async function listHolidays() {
  return db.prepare("SELECT * FROM company_holidays ORDER BY date").all();
}

async function addHoliday(date, name) {
  await db.prepare("INSERT INTO company_holidays (date, name) VALUES (?, ?) ON CONFLICT (date) DO NOTHING").run(date, name);
}

async function deleteHoliday(id) {
  await db.prepare("DELETE FROM company_holidays WHERE id = ?").run(id);
}

module.exports = { holidaySet, listHolidays, addHoliday, deleteHoliday };
