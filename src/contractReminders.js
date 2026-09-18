// Proactive contract/reminder-date alerts, mirroring src/warranty.js's
// pattern exactly (see that file's header) but for tickets.reminder_date
// instead of assets.warranty_expires: periodically (see server.js) check
// for tickets whose reminder date is approaching and email a digest, once
// per ticket (reminder_alerted_at, same idempotent-alert idea as
// tickets.sla_alerted_at / assets.warranty_alerted_at), re-alerting if the
// date changes (see the /tickets/:id/reminder route in
// src/routes/dashboard.js, which clears reminder_alerted_at exactly like
// src/assets.js's update() clears warranty_alerted_at on a changed date).
//
// reminder_date is a plain, generic column any ticket can set - not
// restricted to any one department at the DB level - but it's most
// relevant to Legal's own categories (Contract Review, Compliance,
// NDA / Confidentiality, Litigation & Disputes). Unlike warranty (which has
// no per-asset "owner" and so emails every active agent), a ticket already
// has a department (departments.departmentIdForCategory), so this emails
// only that ticket's own department's active agents - one digest per
// department per run, never handing a Legal ticket's subject to an IT/HR/
// Marketing inbox just because their agents are also "active".
//
// Confidential tickets are excluded outright (confidential = 0 in the query
// below), not just narrowed - this digest goes to the whole department, not
// just the ticket's assignee, and departments.canSeeTicket()'s confidential
// rule restricts a confidential ticket to admins and its own assignee. The
// assignee still sees the approaching reminder date via the ticket's own
// (correctly-scoped) detail page; they just don't get it pushed to every
// department inbox by email.
const db = require("./db");
const departments = require("./departments");
const { sendContractReminderDigest } = require("./mailer");

const CONTRACT_REMINDER_ALERT_DAYS = parseInt(process.env.CONTRACT_REMINDER_ALERT_DAYS, 10) || 30;

async function checkContractReminders() {
  const expiringSoon = await db
    .prepare(
      `SELECT id, subject, category, reminder_date
       FROM tickets
       WHERE reminder_date IS NOT NULL
         AND reminder_alerted_at IS NULL
         AND status NOT IN ('Resolved', 'Closed')
         AND merged_into_id IS NULL
         AND confidential = 0
         AND reminder_date::date <= (CURRENT_DATE + (?::integer * INTERVAL '1 day'))::date`
    )
    .all(CONTRACT_REMINDER_ALERT_DAYS);

  if (!expiringSoon.length) return 0;

  // Grouped by department so each agent gets one digest listing only their
  // own department's tickets - the same boundary departments.
  // ticketVisibilitySql draws everywhere else, just applied to an email
  // instead of a page.
  const byDepartment = new Map();
  for (const ticket of expiringSoon) {
    const deptId = await departments.departmentIdForCategory(ticket.category);
    if (deptId == null) continue; // orphaned/renamed category safety net; shouldn't happen
    if (!byDepartment.has(deptId)) byDepartment.set(deptId, []);
    byDepartment.get(deptId).push(ticket);
  }

  for (const [deptId, tickets] of byDepartment) {
    const activeAgents = await db.prepare("SELECT email FROM agents WHERE active = 1 AND department_id = ?").all(deptId);
    for (const agent of activeAgents) {
      sendContractReminderDigest({ to: agent.email, tickets }).catch((err) =>
        console.error("Could not send contract reminder digest:", err.message)
      );
    }
  }

  const markAlerted = db.prepare("UPDATE tickets SET reminder_alerted_at = now_text() WHERE id = ?");
  for (const ticket of expiringSoon) await markAlerted.run(ticket.id);

  return expiringSoon.length;
}

module.exports = { checkContractReminders, CONTRACT_REMINDER_ALERT_DAYS };
