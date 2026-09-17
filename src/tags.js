// Ported to the async Postgres adapter (see src/db/index.js). Two SQLite-
// specific idioms needed translating, not just async/await:
// - `INSERT OR IGNORE` -> `ON CONFLICT ... DO NOTHING`. tags' own conflict
//   target is the functional unique index on LOWER(name) (see scripts/
//   migrate.js's idx_tags_name_lower - Postgres has no COLLATE NOCASE
//   without an extension), so the ON CONFLICT clause has to name that exact
//   expression, `((LOWER(name)))`, for Postgres to recognize it as the same
//   constraint. ticket_tags' conflict target is just its own composite
//   primary key (ticket_id, tag_id).
// - `WHERE name = ? COLLATE NOCASE` -> `WHERE LOWER(name) = LOWER(?)`.
const db = require("./db");

const MAX_TAG_LENGTH = 30;

function normalizeTagName(raw) {
  return (raw || "").trim().slice(0, MAX_TAG_LENGTH);
}

// Reuses an existing tag regardless of case ("Billing" and "billing" are the
// same tag - see idx_tags_name_lower in scripts/migrate.js), creating a new
// one only if no case-insensitive match exists yet.
async function addTagToTicket(ticketId, rawName) {
  const name = normalizeTagName(rawName);
  if (!name) return null;

  await db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT ((LOWER(name))) DO NOTHING").run(name);
  const tag = await db.prepare("SELECT id, name FROM tags WHERE LOWER(name) = LOWER(?)").get(name);
  await db.prepare("INSERT INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?) ON CONFLICT (ticket_id, tag_id) DO NOTHING").run(ticketId, tag.id);
  return tag;
}

// Only unlinks the tag from this ticket - the tag itself stays in the
// catalog (for reuse / the filter dropdown) even if now unused everywhere.
async function removeTagFromTicket(ticketId, tagId) {
  await db.prepare("DELETE FROM ticket_tags WHERE ticket_id = ? AND tag_id = ?").run(ticketId, tagId);
}

async function tagsForTicket(ticketId) {
  return db
    .prepare(
      `SELECT tags.id, tags.name FROM ticket_tags
       JOIN tags ON tags.id = ticket_tags.tag_id
       WHERE ticket_tags.ticket_id = ?
       ORDER BY tags.name`
    )
    .all(ticketId);
}

async function allTags() {
  return db.prepare("SELECT id, name FROM tags ORDER BY name").all();
}

module.exports = { MAX_TAG_LENGTH, addTagToTicket, removeTagFromTicket, tagsForTicket, allTags };
