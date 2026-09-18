// Optional email notifications for requesters. Entirely off by default - if
// SMTP_HOST isn't set in .env, every send function below silently resolves
// without doing anything, so the app works exactly as before for anyone who
// hasn't configured it. See .env.example for the full list of SMTP_* vars.
const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_FROM = process.env.SMTP_FROM || "Velv Ticketing <no-reply@localhost>";
// Optional. If set, emails link straight to the status page instead of just
// naming it (e.g. "https://helpdesk.example.com"). No trailing slash.
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");

const enabled = Boolean(SMTP_HOST);

let transporter = null;
if (enabled) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
} else {
  console.log("Email notifications are disabled (SMTP_HOST not set in .env). See .env.example.");
}

function statusPageInstructions(ticketId) {
  const where = APP_URL ? `${APP_URL}/status` : "the status page";
  return `Check on it anytime at ${where} with ticket number #${ticketId} and this email address.`;
}

function send(to, subject, text) {
  if (!enabled) return Promise.resolve({ skipped: true });
  return transporter.sendMail({ from: SMTP_FROM, to, subject, text });
}

function sendTicketCreatedEmail({ to, ticketId, subject }) {
  return send(
    to,
    `We've got your request - ticket #${ticketId}`,
    `Thanks for reaching out. Your request "${subject}" is now ticket #${ticketId}.\n\n` +
      `${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

function sendStatusChangeEmail({ to, ticketId, subject, oldStatus, newStatus }) {
  return send(
    to,
    `Ticket #${ticketId} is now ${newStatus}`,
    `Your ticket #${ticketId} ("${subject}") changed from ${oldStatus} to ${newStatus}.\n\n` +
      `${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// Sent instead of sendStatusChangeEmail specifically for the -> Resolved
// transition, so it can fold in a one-click satisfaction survey link. The
// link needs an absolute URL to be worth anything in an email, so it's only
// included when APP_URL is configured - without it this just falls back to
// a plain resolved notice.
function sendResolvedEmail({ to, ticketId, subject, oldStatus, ratingToken }) {
  const ask = APP_URL
    ? `\nHow did we do? Rate this ticket: ${APP_URL}/rate/${ratingToken}\n`
    : "";
  return send(
    to,
    `Ticket #${ticketId} is now Resolved`,
    `Your ticket #${ticketId} ("${subject}") changed from ${oldStatus} to Resolved.\n` +
      ask +
      `\n${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// An agent's note marked "visible to requester" (see the visibility field on
// the note form) - the one way, besides a status change, that a message
// actually reaches the requester's inbox.
function sendReplyEmail({ to, ticketId, subject, message }) {
  return send(
    to,
    `New reply on ticket #${ticketId}`,
    `${message}\n\n---\nRe: ticket #${ticketId} ("${subject}")\n${statusPageInstructions(ticketId)}\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// Best-effort nudge to whoever the ticket is assigned to when the requester
// replies - agents otherwise have no way to know without opening every
// ticket. Silently skipped if the ticket is unassigned (nothing to notify).
function sendAgentNotifiedOfReply({ to, ticketId, subject, message }) {
  if (!to) return Promise.resolve({ skipped: true });
  return send(
    to,
    `New reply from the requester on ticket #${ticketId}`,
    `The requester replied on ticket #${ticketId} ("${subject}"):\n\n${message}`
  );
}

// @mentioned in a note - see src/mentions.js for how the mention itself is
// parsed out of the note body.
function sendMentionEmail({ to, ticketId, subject, mentionedBy, message }) {
  return send(
    to,
    `${mentionedBy} mentioned you on ticket #${ticketId}`,
    `${mentionedBy} mentioned you in a note on ticket #${ticketId} ("${subject}"):\n\n${message}`
  );
}

// A 1-2 star rating just came in - flagged to the whole active team so a
// bad experience doesn't quietly go unnoticed (see the /rate/:token route).
function sendLowRatingEscalation({ to, ticketId, subject, rating, comment }) {
  return send(
    to,
    `Low satisfaction rating (${rating}/5) on ticket #${ticketId}`,
    `Ticket #${ticketId} ("${subject}") just got a ${rating}-star rating.\n\n` +
      (comment ? `Their comment:\n${comment}\n\n` : "") +
      `${APP_URL ? `${APP_URL}/dashboard/tickets/${ticketId}` : "Check the dashboard"} for details.\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// Proactive nudge for whoever's assigned once a ticket crosses its priority-
// scaled aging threshold - see src/sla.js for when this actually fires.
function sendSlaBreachEmail({ to, ticketId, subject, priority, ageDays }) {
  return send(
    to,
    `SLA warning: ticket #${ticketId} is aging (${priority})`,
    `Ticket #${ticketId} ("${subject}") is ${priority} priority and has been open for ${ageDays.toFixed(1)} days - past its aging threshold.\n\n` +
      `${APP_URL ? `${APP_URL}/dashboard/tickets/${ticketId}` : "Check the dashboard"} for details.\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// A separate, usually much tighter warning than sendSlaBreachEmail above -
// nobody's touched this ticket at all yet, past its priority's
// first-response target (see first_response_thresholds in src/db/index.js).
function sendFirstResponseBreachEmail({ to, ticketId, subject, priority }) {
  return send(
    to,
    `First-response warning: ticket #${ticketId} hasn't been touched yet (${priority})`,
    `Ticket #${ticketId} ("${subject}") is ${priority} priority and still has no response - past its first-response target.\n\n` +
      `${APP_URL ? `${APP_URL}/dashboard/tickets/${ticketId}` : "Check the dashboard"} for details.\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// One email per agent per day summarizing their own open queue - see
// src/digest.js for when this fires and how "once per day" is enforced.
// Skipped entirely (by the caller) for an agent with nothing open, so this
// never has to handle an empty list gracefully.
function sendDailyDigest({ to, openCount, agingCount, tickets }) {
  const lines = tickets
    .map((t) => `- #${t.id} (${t.priority}${t.is_aging ? ", aging" : ""}): ${t.subject}`)
    .join("\n");
  return send(
    to,
    `Your daily digest: ${openCount} open ticket${openCount === 1 ? "" : "s"}${agingCount ? `, ${agingCount} aging` : ""}`,
    `${lines}\n\n${APP_URL ? `${APP_URL}/dashboard` : "Check the dashboard"} for details.\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// One digest per agent listing every asset that just entered its
// warranty-expiry window, rather than a separate email per asset - see
// src/warranty.js for when this fires.
function sendWarrantyExpiryDigest({ to, assets }) {
  const lines = assets
    .map((a) => `- ${a.name}${a.asset_tag ? ` (${a.asset_tag})` : ""}: warranty expires ${a.warranty_expires}`)
    .join("\n");
  return send(
    to,
    `Warranty expiring soon: ${assets.length} asset${assets.length === 1 ? "" : "s"}`,
    `${lines}\n\n${APP_URL ? `${APP_URL}/dashboard/assets` : "Check the dashboard"} for details.\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// One digest per agent listing every ticket in their own department whose
// reminder date just entered its alert window - see src/contractReminders.js
// for when this fires and why it's scoped per-department (unlike
// sendWarrantyExpiryDigest, which has no department to scope by).
function sendContractReminderDigest({ to, tickets }) {
  const lines = tickets.map((t) => `- #${t.id} (${t.category}): ${t.subject} - reminder date ${t.reminder_date}`).join("\n");
  return send(
    to,
    `Reminder date approaching: ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`,
    `${lines}\n\n${APP_URL ? `${APP_URL}/dashboard` : "Check the dashboard"} for details.\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// One digest per agent listing every consultant in their own department
// whose engagement is about to end - see src/consultantReminders.js for
// when this fires and why it's scoped per-department (consultants have a
// real department_id, unlike tickets' derived-from-category one).
function sendConsultantEngagementEndingDigest({ to, consultants }) {
  const lines = consultants
    .map((c) => `- ${c.name}${c.company ? ` (${c.company})` : ""} - engagement ends ${c.engagement_end}`)
    .join("\n");
  return send(
    to,
    `Consultant engagement ending soon: ${consultants.length} consultant${consultants.length === 1 ? "" : "s"}`,
    `${lines}\n\n${APP_URL ? `${APP_URL}/dashboard/consultants` : "Check the dashboard"} for details.\n\n` +
      `Our Team. Remotely Yours.\nVelv`
  );
}

// A scheduled job (see src/routes/cron.js) threw instead of completing -
// otherwise this would only ever surface in Vercel's own function logs,
// which nobody's watching day to day. Goes to every active admin, not the
// whole team, since this is an infra/ops concern, not something a regular
// agent needs to act on.
function sendCronFailureAlert({ to, jobName, error }) {
  return send(
    to,
    `Cron job failed: ${jobName}`,
    `The "${jobName}" scheduled job failed on its most recent run:\n\n${error}\n\n` +
      `Check the function logs in the Vercel dashboard for the full stack trace.`
  );
}

module.exports = {
  enabled,
  sendTicketCreatedEmail,
  sendStatusChangeEmail,
  sendResolvedEmail,
  sendReplyEmail,
  sendAgentNotifiedOfReply,
  sendSlaBreachEmail,
  sendFirstResponseBreachEmail,
  sendDailyDigest,
  sendMentionEmail,
  sendLowRatingEscalation,
  sendWarrantyExpiryDigest,
  sendContractReminderDigest,
  sendConsultantEngagementEndingDigest,
  sendCronFailureAlert,
};
