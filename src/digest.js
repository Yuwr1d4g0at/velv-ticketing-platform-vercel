// One "here's your open queue" email per agent per day, for anyone who'd
// rather get a morning summary than rely on remembering to check the
// dashboard. Off by default in the sense that it only ever fires if email
// notifications are configured at all (see src/mailer.js) - same as every
// other notification in this app.
const db = require("./db");
const { annotateAging } = require("./aging");
const { sendDailyDigest } = require("./mailer");

// Which local hour to send at - checked on the same periodic interval as
// SLA/warranty checks (see src/server.js), not its own timer, so this only
// actually sends during whichever check happens to land in that hour.
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR, 10) || 8;

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Sends at most one digest per agent per calendar day (tracked via
// agents.last_digest_at), and only during DIGEST_HOUR - both guards matter:
// without the hour check this would fire on every periodic check until the
// date rolls over; without the once-per-day check it'd fire on every check
// *within* that hour too.
async function sendDueDigests() {
  if (new Date().getHours() !== DIGEST_HOUR) return 0;

  const agents = await db
    .prepare(
      `SELECT id, name, email FROM agents
       WHERE active = 1 AND (last_digest_at IS NULL OR last_digest_at::date != CURRENT_DATE)`
    )
    .all();

  let sent = 0;
  for (const agent of agents) {
    const rows = await db
      .prepare(
        `SELECT id, subject, priority, status, created_at, waiting_since, paused_hours FROM tickets
         WHERE assigned_to = ? AND status IN ('Open', 'In Progress')
         ORDER BY CASE priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, created_at ASC
         LIMIT 20`
      )
      .all(agent.id);
    const tickets = await annotateAging(rows);

    // Marked as sent regardless of whether there was anything to report -
    // an empty queue is still worth knowing "nothing's outstanding", and
    // either way it stops this agent being re-checked again today.
    await db.prepare("UPDATE agents SET last_digest_at = now_text() WHERE id = ?").run(agent.id);
    if (!tickets.length) continue;

    sendDailyDigest({
      to: agent.email,
      openCount: tickets.length,
      agingCount: tickets.filter((t) => t.is_aging).length,
      tickets,
    }).catch((err) => console.error("Could not send daily digest email:", err.message));
    sent += 1;
  }

  return sent;
}

module.exports = { sendDueDigests, DIGEST_HOUR };
