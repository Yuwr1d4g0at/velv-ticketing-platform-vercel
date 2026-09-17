// Manual time-tracking entries against a ticket - see the /tickets/:id/time
// routes in src/routes/dashboard.js (logging on the ticket page) and the
// "Time tracked" report on the Dashboard (src/routes/dashboard.js's
// buildReportsData). Deliberately manual-entry only for a first version: a
// live start/stop timer is real added complexity (surviving page reloads,
// multiple open tabs, what happens to a running timer once its ticket gets
// merged) that this app doesn't need yet - typing "45" after doing the work
// is already how every other ticket-page action here works (e.g. typing a
// note after a call, rather than the app recording the call itself).
//
// Ported to the async Postgres adapter (see src/db/index.js).
const db = require("./db");

const MAX_MINUTES = 24 * 60; // a single entry can't claim more than a full day
const MAX_NOTE_LENGTH = 500;

// UTC calendar date, matching how every other date-ish column in this app
// (created_at, logged_on itself) is stored and compared.
function today() {
  return new Date().toISOString().slice(0, 10);
}

async function forTicket(ticketId) {
  return db
    .prepare(
      `SELECT time_entries.*, agents.name AS agent_name
       FROM time_entries
       LEFT JOIN agents ON agents.id = time_entries.agent_id
       WHERE ticket_id = ?
       ORDER BY logged_on DESC, created_at DESC`
    )
    .all(ticketId);
}

async function totalMinutesForTicket(ticketId) {
  return (await db.prepare("SELECT COALESCE(SUM(minutes), 0) AS total FROM time_entries WHERE ticket_id = ?").get(ticketId)).total;
}

// Takes the raw POST body so callers don't have to destructure/parse
// themselves - same shape as custom-fields.js's saveSubmittedCustomFields.
// Rejects (rather than clamping) an out-of-range or non-numeric minutes
// value: silently clamping a typo like "1440000" down to a day would log
// time the agent never actually said, which is worse than just asking them
// to fix it.
async function create(ticketId, agentId, body) {
  const minutes = parseInt(body.minutes, 10);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return { error: `Enter a whole number of minutes between 1 and ${MAX_MINUTES}.` };
  }
  const loggedOn = /^\d{4}-\d{2}-\d{2}$/.test(body.logged_on) ? body.logged_on : today();
  const note = (body.note || "").trim().slice(0, MAX_NOTE_LENGTH) || null;

  await db
    .prepare("INSERT INTO time_entries (ticket_id, agent_id, minutes, note, logged_on) VALUES (?, ?, ?, ?, ?)")
    .run(ticketId, agentId, minutes, note, loggedOn);
  return {};
}

async function remove(ticketId, entryId) {
  await db.prepare("DELETE FROM time_entries WHERE id = ? AND ticket_id = ?").run(entryId, ticketId);
}

// "1h 15m" / "45m" / "2h" - never bare minutes once over an hour, so a report
// full of numbers never reads as ambiguous ("90" what?).
function formatMinutes(minutes) {
  const m = Math.round(minutes || 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${rest}m`;
  if (!rest) return `${h}h`;
  return `${h}h ${rest}m`;
}

// Per-agent and per-ticket time summaries for a report date range - matched
// against logged_on (the date the work happened), not created_at (when the
// entry was typed in), since picking a date range on a report is asking
// "how much time went in during this window", not "when was the entry saved".
// deptWhere is an optional {sql, params} fragment (see
// departments.ticketVisibilitySql) that references `tickets` - every time
// entry has a NOT NULL, ON DELETE CASCADE ticket_id, so joining to tickets
// to apply it is always safe (no entry can outlive its ticket). Defaults to
// no-op so every other caller (the ticket detail page's own time log,
// which is about one specific already-visible ticket) is unaffected.
async function summaryByAgent(from, to, deptWhere = { sql: "", params: [] }) {
  return db
    .prepare(
      `SELECT COALESCE(agents.name, 'Unknown / removed agent') AS label, COUNT(*) AS entries, SUM(time_entries.minutes) AS minutes
       FROM time_entries
       LEFT JOIN agents ON agents.id = time_entries.agent_id
       JOIN tickets ON tickets.id = time_entries.ticket_id
       WHERE time_entries.logged_on >= ? AND time_entries.logged_on <= ?${deptWhere.sql}
       GROUP BY time_entries.agent_id, agents.name
       ORDER BY minutes DESC`
    )
    .all(from, to, ...deptWhere.params);
}

// Top tickets by time logged within the range, not every ticket that has
// any - a report card is for spotting where the time is actually going,
// which a long tail of one-entry tickets would just bury.
async function summaryByTicket(from, to, deptWhere = { sql: "", params: [] }, limit = 10) {
  return db
    .prepare(
      `SELECT tickets.id, tickets.subject, COUNT(*) AS entries, SUM(time_entries.minutes) AS minutes
       FROM time_entries
       JOIN tickets ON tickets.id = time_entries.ticket_id
       WHERE time_entries.logged_on >= ? AND time_entries.logged_on <= ?${deptWhere.sql}
       GROUP BY time_entries.ticket_id, tickets.id, tickets.subject
       ORDER BY minutes DESC
       LIMIT ?`
    )
    .all(from, to, ...deptWhere.params, limit);
}

async function totalMinutesInRange(from, to, deptWhere = { sql: "", params: [] }) {
  return (
    await db
      .prepare(
        `SELECT COALESCE(SUM(time_entries.minutes), 0) AS total
         FROM time_entries
         JOIN tickets ON tickets.id = time_entries.ticket_id
         WHERE time_entries.logged_on >= ? AND time_entries.logged_on <= ?${deptWhere.sql}`
      )
      .get(from, to, ...deptWhere.params)
  ).total;
}

module.exports = {
  MAX_MINUTES,
  MAX_NOTE_LENGTH,
  today,
  forTicket,
  totalMinutesForTicket,
  create,
  remove,
  formatMinutes,
  summaryByAgent,
  summaryByTicket,
  totalMinutesInRange,
};
