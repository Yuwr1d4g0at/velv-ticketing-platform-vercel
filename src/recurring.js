// Templates that spawn a new ticket on a fixed cadence (e.g. "monthly server
// check") instead of someone remembering to file it by hand - see
// recurring_tickets in src/db/index.js. Checked on the same periodic
// interval as SLA/warranty checks (see src/server.js), not its own timer.
//
// Ported to the async Postgres adapter (see src/db/index.js). Inline
// `datetime('now')` calls (not just column DEFAULTs) became `now_text()`.
const db = require("./db");
const { triggerWebhooks } = require("./webhooks");

// No real requester for a system-generated ticket - a fixed, recognizable
// placeholder rather than an empty string, since requester_name/email are
// NOT NULL and every other part of the app (the status page, GDPR tools)
// assumes a real-looking value.
const SYSTEM_REQUESTER_NAME = "Recurring Task";
const SYSTEM_REQUESTER_EMAIL = "recurring-tasks@internal";

async function all() {
  return db.prepare("SELECT * FROM recurring_tickets ORDER BY active DESC, name").all();
}

async function create(fields) {
  const name = (fields.name || "").trim().slice(0, 200);
  const category = fields.category || "";
  const subject = (fields.subject || "").trim().slice(0, 200);
  const description = (fields.description || "").trim().slice(0, 5000);
  const priority = fields.priority || "Medium";
  const intervalDays = parseInt(fields.interval_days, 10);

  if (!name) return { error: "Name is required." };
  if (!subject) return { error: "Subject is required." };
  if (!description) return { error: "Description is required." };
  if (!Number.isInteger(intervalDays) || intervalDays < 1) return { error: "Interval must be a whole number of days, at least 1." };

  const result = await db
    .prepare(
      `INSERT INTO recurring_tickets (name, category, subject, description, priority, interval_days, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, now_text())`
    )
    .run(name, category, subject, description, priority, intervalDays);
  return { id: result.lastInsertRowid };
}

async function setActive(id, active) {
  await db.prepare("UPDATE recurring_tickets SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

// Creates one ticket per due template (never more than one per check, even
// if the server was down long enough to miss several intervals - catches up
// by advancing next_run_at past "now" rather than backfilling every missed
// occurrence, which would spam a burst of duplicate tickets) and advances
// next_run_at by interval_days past the point it's caught up to.
async function runDueRecurringTickets() {
  const due = await db.prepare("SELECT * FROM recurring_tickets WHERE active = 1 AND next_run_at <= now_text()").all();
  let created = 0;

  for (const template of due) {
    const result = await db
      .prepare(
        `INSERT INTO tickets (subject, description, category, priority, requester_name, requester_email)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(template.subject, template.description, template.category, template.priority, SYSTEM_REQUESTER_NAME, SYSTEM_REQUESTER_EMAIL);
    await db
      .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'note', ?)`)
      .run(result.lastInsertRowid, `Auto-created by the recurring task "${template.name}".`);
    await triggerWebhooks("ticket.created", {
      ticket_id: result.lastInsertRowid,
      subject: template.subject,
      category: template.category,
      requester_email: SYSTEM_REQUESTER_EMAIL,
    });
    created += 1;

    let nextRun = new Date(`${template.next_run_at.replace(" ", "T")}Z`);
    const now = new Date();
    while (nextRun <= now) {
      nextRun = new Date(nextRun.getTime() + template.interval_days * 24 * 60 * 60 * 1000);
    }
    await db
      .prepare("UPDATE recurring_tickets SET next_run_at = ? WHERE id = ?")
      .run(nextRun.toISOString().slice(0, 19).replace("T", " "), template.id);
  }

  return created;
}

module.exports = { all, create, setActive, runDueRecurringTickets, SYSTEM_REQUESTER_EMAIL };
