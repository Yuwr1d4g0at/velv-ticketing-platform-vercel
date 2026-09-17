// In-app notifications (header bell) - a lighter-weight alternative to
// email for the same events (mention, reply, low rating, SLA/first-response
// breach), for an agent who doesn't want every little thing in their inbox.
// Purely additive: every call site that creates one already sends (or
// attempts) the equivalent email too - this never replaces that.
//
// Ported to the async Postgres adapter (see src/db/index.js). Inline
// `datetime('now')` became `now_text()`.
const db = require("./db");

async function create(agentId, type, ticketId, message) {
  if (!agentId) return; // e.g. a watcher/assignee lookup that came back empty
  await db.prepare("INSERT INTO notifications (agent_id, ticket_id, type, message) VALUES (?, ?, ?, ?)").run(agentId, ticketId, type, message);
}

async function unreadCount(agentId) {
  return (await db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE agent_id = ? AND read_at IS NULL").get(agentId)).c;
}

// Most recent notifications regardless of read state, so opening the bell
// (which marks everything read - see markAllRead) doesn't make the list
// itself go blank the moment you look at it.
async function recentFor(agentId, limit = 10) {
  return db.prepare("SELECT * FROM notifications WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, limit);
}

async function markAllRead(agentId) {
  await db.prepare("UPDATE notifications SET read_at = now_text() WHERE agent_id = ? AND read_at IS NULL").run(agentId);
}

module.exports = { create, unreadCount, recentFor, markAllRead };
