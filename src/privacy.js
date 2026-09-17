// Agent-initiated GDPR data export/erasure, scoped to a requester's email.
// There's no requester login system in this app (see README), so both
// actions are triggered by an agent from a ticket, not self-service.
//
// Ported to the async Postgres adapter (see src/db/index.js). eraseRequesterData
// used node:sqlite's synchronous db.exec("BEGIN")/COMMIT/ROLLBACK, which is
// NOT safely atomic against a connection pool (see db/index.js's transaction()
// doc comment for why) - rewritten to use the new transaction() helper, which
// checks out one client for the whole callback.
const db = require("./db");
const { deleteAttachmentBlob } = require("./attachments");

// Everything on file for one requester: their tickets, the full activity
// feed on each, attachment metadata (not the file bytes - an agent doing
// this export is already logged in and can pull any file individually from
// the ticket itself if actually needed), and their CSAT ratings/comments.
async function exportRequesterData(email) {
  const normalized = email.trim().toLowerCase();
  const tickets = await db.prepare("SELECT * FROM tickets WHERE requester_email = ?").all(normalized);

  const bundle = await Promise.all(
    tickets.map(async (ticket) => ({
      ticket: {
        id: ticket.id,
        subject: ticket.subject,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
      },
      activity: await db
        .prepare("SELECT type, body, created_at FROM ticket_activity WHERE ticket_id = ? ORDER BY created_at ASC")
        .all(ticket.id),
      attachments: await db
        .prepare("SELECT original_name, mime_type, size_bytes, uploaded_by, created_at FROM attachments WHERE ticket_id = ?")
        .all(ticket.id),
      rating: (await db.prepare("SELECT rating, comment, created_at FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id)) || null,
    }))
  );

  return {
    requester_email: normalized,
    exported_at: new Date().toISOString(),
    ticket_count: tickets.length,
    tickets: bundle,
  };
}

const REDACTED_NAME = "[erased]";
const REDACTED_EMAIL = "erased@redacted.invalid";
const REDACTED_TEXT = "[content erased at requester's request]";

// Identity fields (name/email) on every ticket, plus the ticket's own
// description and every note/reply/requester-reply body - anything the
// requester or an agent wrote freely, which could itself be personal or
// sensitive regardless of who's named in it. System-generated audit lines
// (status/priority/assignment changes) are left intact - they're not "free
// text" and still have operational value. Attachment files are deleted
// outright, not just unlinked, since they could easily contain personal
// documents or photos. Runs as one transaction: either the whole erasure
// applies, or none of it does.
async function eraseRequesterData(email) {
  const normalized = email.trim().toLowerCase();
  const tickets = await db.prepare("SELECT id FROM tickets WHERE requester_email = ?").all(normalized);
  if (!tickets.length) return { error: "No tickets found for that email address." };

  const ticketIds = tickets.map((t) => t.id);
  const placeholders = ticketIds.map(() => "?").join(",");

  // Delete attachment blobs before touching the DB rows - if this is
  // interrupted partway, a leftover blob with no DB row is a much safer
  // failure mode than a DB row pointing at a file that's already gone.
  const attachments = await db
    .prepare(`SELECT stored_name FROM attachments WHERE ticket_id IN (${placeholders})`)
    .all(...ticketIds);
  for (const a of attachments) {
    await deleteAttachmentBlob(a.stored_name);
  }

  await db.transaction(async (tx) => {
    await tx.prepare(`DELETE FROM attachments WHERE ticket_id IN (${placeholders})`).run(...ticketIds);
    await tx.prepare(`UPDATE ticket_ratings SET comment = NULL WHERE ticket_id IN (${placeholders})`).run(...ticketIds);
    await tx
      .prepare(`UPDATE ticket_activity SET body = ? WHERE ticket_id IN (${placeholders}) AND type IN ('note', 'reply', 'requester_reply')`)
      .run(REDACTED_TEXT, ...ticketIds);
    await tx
      .prepare(
        `UPDATE tickets SET requester_name = ?, requester_email = ?, description = ?, data_erased_at = now_text()
         WHERE id IN (${placeholders})`
      )
      .run(REDACTED_NAME, REDACTED_EMAIL, REDACTED_TEXT, ...ticketIds);
  });

  return { ticketIds };
}

module.exports = { exportRequesterData, eraseRequesterData, REDACTED_EMAIL };
