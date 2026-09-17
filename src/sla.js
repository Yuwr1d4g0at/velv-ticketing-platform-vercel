// Proactive SLA breach alerts: periodically (see server.js) check for
// tickets that have crossed their priority-scaled aging threshold and email
// whoever they're assigned to, instead of only showing a passive "Aging"
// badge on the dashboard that nobody's necessarily looking at.
//
// Business-hours-aware aging (see src/aging.js) can't be expressed as a SQL
// predicate, so this fetches every not-yet-alerted open/in-progress
// assigned ticket and filters with isAgingTicket() in JS - fine at the
// scale of one internal team's open queue, not something that needs to
// stay a pure SQL WHERE clause.
//
// Idempotent by design: sla_alerted_at is set the moment an alert goes out,
// so a ticket only ever gets one email per breach - not one every time this
// runs. It's cleared back to NULL whenever a ticket reopens (see
// applyStatusChange in dashboard.js and the requester-reply auto-reopen in
// public.js), so a ticket that breaches, gets fixed, and later reopens can
// alert again rather than staying silenced forever.
const db = require("./db");
const { isAgingTicket, agingHoursElapsed, currentFirstResponseThresholds, BUSINESS_HOURS_PER_DAY } = require("./aging");
const { sendSlaBreachEmail, sendFirstResponseBreachEmail } = require("./mailer");
const notifications = require("./notifications");

async function checkSlaBreaches() {
  const candidates = await db
    .prepare(
      `SELECT tickets.id, tickets.subject, tickets.priority, tickets.status, tickets.created_at,
              tickets.waiting_since, tickets.paused_hours, agents.id AS agent_id, agents.email AS agent_email
       FROM tickets
       JOIN agents ON agents.id = tickets.assigned_to AND agents.active = 1
       WHERE tickets.status IN ('Open', 'In Progress') AND tickets.sla_alerted_at IS NULL`
    )
    .all();
  const aging = await Promise.all(candidates.map((t) => isAgingTicket(t)));
  const breaching = candidates.filter((_, i) => aging[i]);

  for (const ticket of breaching) {
    // Business hours, not raw calendar hours - matches what actually
    // crossed the threshold (and excludes any time spent paused waiting on
    // the customer), rather than a wall-clock age that could read as "past
    // due" much sooner than the business-hours math actually says.
    const ageDays = (await agingHoursElapsed(ticket)) / BUSINESS_HOURS_PER_DAY;
    sendSlaBreachEmail({
      to: ticket.agent_email,
      ticketId: ticket.id,
      subject: ticket.subject,
      priority: ticket.priority,
      ageDays,
    }).catch((err) => console.error("Could not send SLA breach email:", err.message));
    await notifications.create(
      ticket.agent_id,
      "sla_breach",
      ticket.id,
      `Ticket #${ticket.id} is past its aging threshold (${ticket.priority}).`
    );
    await db.prepare("UPDATE tickets SET sla_alerted_at = now_text() WHERE id = ?").run(ticket.id);
  }

  return breaching.length;
}

// Same idempotent-alert shape as checkSlaBreaches above, but for the
// separate, usually much tighter, first-response target (see
// first_response_thresholds in src/db/index.js). A ticket stops being a
// candidate the moment any agent-authored activity exists on it at all
// (note, reply, status/priority change, reassignment) - "first response"
// doesn't require a public reply specifically, just evidence someone's
// looked at it.
async function checkFirstResponseBreaches() {
  const thresholds = await currentFirstResponseThresholds();
  const candidates = await db
    .prepare(
      `SELECT tickets.id, tickets.subject, tickets.priority, tickets.status, tickets.created_at,
              tickets.waiting_since, tickets.paused_hours, agents.id AS agent_id, agents.email AS agent_email
       FROM tickets
       JOIN agents ON agents.id = tickets.assigned_to AND agents.active = 1
       WHERE tickets.status IN ('Open', 'In Progress')
         AND tickets.first_response_alerted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ticket_activity WHERE ticket_id = tickets.id AND agent_id IS NOT NULL
         )`
    )
    .all();

  const hoursElapsed = await Promise.all(candidates.map((t) => agingHoursElapsed(t)));
  const breaching = candidates.filter((t, i) => {
    const thresholdHours = thresholds[t.priority];
    return thresholdHours != null && hoursElapsed[i] > thresholdHours;
  });

  for (const ticket of breaching) {
    sendFirstResponseBreachEmail({
      to: ticket.agent_email,
      ticketId: ticket.id,
      subject: ticket.subject,
      priority: ticket.priority,
    }).catch((err) => console.error("Could not send first-response breach email:", err.message));
    await notifications.create(
      ticket.agent_id,
      "first_response_breach",
      ticket.id,
      `Ticket #${ticket.id} still has no response (${ticket.priority}).`
    );
    await db.prepare("UPDATE tickets SET first_response_alerted_at = now_text() WHERE id = ?").run(ticket.id);
  }

  return breaching.length;
}

module.exports = { checkSlaBreaches, checkFirstResponseBreaches };
