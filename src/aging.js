// Shared "is this ticket aging past its priority-scaled threshold" logic -
// used by the dashboard list, the SLA breach checker, and the ticket detail
// header. Kept in one place so the three can never quietly drift apart on
// what "aging" means.
//
// Counts business hours only (Mon-Fri, 09:00-18:00, in the server process's
// own local timezone - not UTC, not a per-agent setting), not raw calendar
// time - a ticket filed Friday evening shouldn't visibly "age" all weekend
// the way it would under a flat elapsed-time clock. Business hours are a
// fixed constant for now, not yet an editable setting like the thresholds
// themselves.
//
// This can no longer be expressed as a single SQL predicate (there's no
// reasonable way to do business-hours arithmetic in plain SQL), so
// consumers fetch candidate rows in SQL (open/in-progress, etc.) and filter
// or annotate them with isAgingTicket() in JS instead of a WHERE clause.
//
// Thresholds live in the sla_thresholds table (editable from
// /dashboard/settings), not a hardcoded constant - read fresh on every call
// rather than cached, since a settings change should take effect
// immediately without a restart.
//
// Ported to the async Postgres adapter (see src/db/index.js). One real
// shape change beyond plain async/await: isAgingTicket's `thresholds`
// parameter used to default to `currentThresholds()` (a function call
// inline in the parameter list) - that doesn't work once currentThresholds
// is async (a default expression can't await), so the default was moved
// into the function body instead (`if (thresholds === undefined) thresholds
// = await currentThresholds();`), same effective behavior.
const db = require("./db");
const { holidaySet } = require("./holidays");

const FALLBACK_DAYS = 7; // used only if a priority somehow has no row at all
const BUSINESS_HOURS_START = 9; // 09:00
const BUSINESS_HOURS_END = 18; // 18:00
const BUSINESS_HOURS_PER_DAY = BUSINESS_HOURS_END - BUSINESS_HOURS_START;

async function currentThresholds() {
  const rows = await db.prepare("SELECT priority, days FROM sla_thresholds").all();
  return Object.fromEntries(rows.map((r) => [r.priority, r.days]));
}

// Same shape as currentThresholds() above, but for the separate
// time-to-first-response target (see first_response_thresholds in
// src/db/index.js) - a distinct, usually much tighter, expectation from
// overall resolution.
async function currentFirstResponseThresholds() {
  const rows = await db.prepare("SELECT priority, hours FROM first_response_thresholds").all();
  return Object.fromEntries(rows.map((r) => [r.priority, r.hours]));
}

// Local (not UTC) Y-M-D key, matching how company_holidays.date is entered
// and stored - all the surrounding date math here already works in the
// server process's own local timezone (see the module comment above), so
// this has to match that, not toISOString()'s UTC day which can shift near
// midnight in some timezones.
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isBusinessDay(date, holidays) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  return !holidays.has(localDateKey(date));
}

// Business hours between two Dates, restricted to one calendar day (`day`,
// only its date part is used) - 0 outside Mon-Fri or on a company holiday,
// otherwise the overlap between that day's 09:00-18:00 window and
// [rangeStart, rangeEnd].
function businessHoursOnDay(day, rangeStart, rangeEnd, holidays) {
  if (!isBusinessDay(day, holidays)) return 0;
  const dayStart = new Date(day);
  dayStart.setHours(BUSINESS_HOURS_START, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setHours(BUSINESS_HOURS_END, 0, 0, 0);
  const start = Math.max(dayStart.getTime(), rangeStart.getTime());
  const end = Math.min(dayEnd.getTime(), rangeEnd.getTime());
  return end > start ? (end - start) / (1000 * 60 * 60) : 0;
}

async function businessHoursElapsed(startDate, endDate) {
  if (endDate <= startDate) return 0;
  // Fetched once per call (not once per day inside the loop below) - still
  // always a fresh read, so an edit to the holiday list takes effect on the
  // very next calculation, without needing a caching/invalidation scheme.
  const holidays = await holidaySet();
  let total = 0;
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= endDate) {
    total += businessHoursOnDay(cursor, startDate, endDate, holidays);
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

// Business hours elapsed since a ticket was created, minus any time it's
// spent in "Waiting on Customer" - both past pauses already folded into
// paused_hours when the ticket left that status (see applyStatusChange in
// dashboard.js), and, if it's *currently* waiting, the hours since
// waiting_since - so time spent waiting on the requester never counts
// against the team's own aging clock.
async function agingHoursElapsed(ticket, now = new Date()) {
  const created = new Date(`${ticket.created_at.replace(" ", "T")}Z`);
  let elapsed = (await businessHoursElapsed(created, now)) - (ticket.paused_hours || 0);
  if (ticket.status === "Waiting on Customer" && ticket.waiting_since) {
    const waitingSince = new Date(`${ticket.waiting_since.replace(" ", "T")}Z`);
    elapsed -= await businessHoursElapsed(waitingSince, now);
  }
  return Math.max(0, elapsed);
}

// `thresholds` defaults to a fresh currentThresholds() read when omitted;
// `now` defaults to the real clock in production use, but tests pass a
// fixed Date instead so a boundary case (crossing one priority's threshold
// but not another's) is exact and deterministic rather than depending on
// which weekday the test suite happens to run on.
async function isAgingTicket(ticket, thresholds, now = new Date()) {
  if (thresholds === undefined) thresholds = await currentThresholds();
  if (!["Open", "In Progress"].includes(ticket.status)) return false;
  const thresholdDays = thresholds[ticket.priority] ?? FALLBACK_DAYS;
  return (await agingHoursElapsed(ticket, now)) > thresholdDays * BUSINESS_HOURS_PER_DAY;
}

// Annotates a batch of already-fetched ticket rows with is_aging, reading
// thresholds once for the whole batch rather than once per row.
async function annotateAging(tickets) {
  const thresholds = await currentThresholds();
  return Promise.all(tickets.map(async (t) => ({ ...t, is_aging: await isAgingTicket(t, thresholds) })));
}

module.exports = {
  isAgingTicket,
  annotateAging,
  currentThresholds,
  currentFirstResponseThresholds,
  businessHoursElapsed,
  agingHoursElapsed,
  BUSINESS_HOURS_PER_DAY,
  FALLBACK_DAYS,
};
