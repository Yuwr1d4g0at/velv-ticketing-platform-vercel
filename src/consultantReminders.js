// Proactive consultant-engagement-ending alerts, mirroring
// src/contractReminders.js's pattern exactly (see that file's header) but
// for consultants.engagement_end instead of tickets.reminder_date:
// periodically (see server.js) check for active consultants whose
// engagement is about to end and email a digest to that consultant's own
// department's active agents, once per consultant
// (engagement_end_alerted_at, same idempotent-alert idea as
// tickets.sla_alerted_at / assets.warranty_alerted_at /
// tickets.reminder_alerted_at), re-alerting if the date changes (see
// src/consultants.js's update(), which clears engagement_end_alerted_at
// exactly like contractReminders' own reminder-date-change handling).
//
// Consultants already have a real department_id column (unlike tickets,
// which only have one indirectly via category), so this skips
// contractReminders' departmentIdForCategory lookup and groups directly.
//
// Confidential consultants are excluded outright (confidential = 0 below),
// not just narrowed - this digest goes to the whole department, not just
// the consultant's assigned agent, and departments.canSeeConsultant()'s
// confidential rule restricts a confidential record to admins and its own
// assigned agent. The assigned agent still sees the approaching
// engagement_end date via the consultant's own (correctly-scoped) detail
// page; they just don't get it pushed to every department inbox by email.
const db = require("./db");
const { sendConsultantEngagementEndingDigest } = require("./mailer");

const CONSULTANT_ENGAGEMENT_ALERT_DAYS = parseInt(process.env.CONSULTANT_ENGAGEMENT_ALERT_DAYS, 10) || 30;

async function checkConsultantEngagementReminders() {
  const endingSoon = await db
    .prepare(
      `SELECT id, name, company, department_id, engagement_end
       FROM consultants
       WHERE status = 'Active'
         AND engagement_end IS NOT NULL
         AND engagement_end_alerted_at IS NULL
         AND confidential = 0
         AND engagement_end::date <= (CURRENT_DATE + (?::integer * INTERVAL '1 day'))::date`
    )
    .all(CONSULTANT_ENGAGEMENT_ALERT_DAYS);

  if (!endingSoon.length) return 0;

  // Grouped by department so each agent gets one digest listing only their
  // own department's consultants - the same boundary
  // departments.consultantVisibilitySql draws everywhere else, just applied
  // to an email instead of a page.
  const byDepartment = new Map();
  for (const consultant of endingSoon) {
    if (!byDepartment.has(consultant.department_id)) byDepartment.set(consultant.department_id, []);
    byDepartment.get(consultant.department_id).push(consultant);
  }

  for (const [deptId, consultants] of byDepartment) {
    const activeAgents = await db.prepare("SELECT email FROM agents WHERE active = 1 AND department_id = ?").all(deptId);
    for (const agent of activeAgents) {
      sendConsultantEngagementEndingDigest({ to: agent.email, consultants }).catch((err) =>
        console.error("Could not send consultant engagement-ending digest:", err.message)
      );
    }
  }

  const markAlerted = db.prepare("UPDATE consultants SET engagement_end_alerted_at = now_text() WHERE id = ?");
  for (const consultant of endingSoon) await markAlerted.run(consultant.id);

  return endingSoon.length;
}

module.exports = { checkConsultantEngagementReminders, CONSULTANT_ENGAGEMENT_ALERT_DAYS };
