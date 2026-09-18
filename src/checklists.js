// Checklist items attached to a ticket template - see src/db/index.js's
// template_checklist_items table and views/dashboard/templates.ejs. A plain
// line (spawn_category null) is just a checklist entry with nothing else
// to do; a line with a spawn_category is what makes e.g. an HR "New Hire
// Onboarding" template also spawn an IT ticket ("Configure PC for
// {name}") and a Marketing ticket ("Create profile picture for {name}")
// the moment the template is used for an agent-initiated ticket (see the
// /tickets/new POST route in src/routes/dashboard.js).
//
// Every spawned ticket is a completely ordinary, first-class ticket in its
// own category/department - own visibility (departments.canSeeTicket
// applies to it exactly as it would to any other ticket; HR gets no extra
// access to the IT ticket this creates), own assignment, own everything.
// It is linked back to the originating ticket using the app's existing
// cross-department "Link" feature (ticket_links - the same table/shape the
// /tickets/:id/link route uses), never a merge: merging is deliberately
// restricted to tickets in the same department (see the /merge route's own
// comment), and Link is the feature that already exists for "related but
// shouldn't become one" - which is exactly this relationship, just created
// by a template instead of an agent typing a ticket number.
//
// NOTE on Link's own visibility behavior (see the /tickets/:id page in
// dashboard.js, `linkedTickets`): once linked, a ticket's page shows every
// linked ticket's id/subject/status via a plain join with NO department
// filter - so the HR agent who used this template WILL see the spawned IT
// and Marketing tickets' subjects and statuses (not their full detail: no
// activity/attachments/etc, since that still requires opening the ticket
// itself, which canSeeTicket blocks) on their own HR ticket's page. That's
// pre-existing Link behavior, unchanged by this file - flagged here (and
// in this feature's PR description) rather than fixed, since fixing Link's
// own display is out of scope for this feature.
//
// Ported to the async Postgres adapter (see src/db/index.js). `INSERT OR
// IGNORE INTO ticket_links` -> `ON CONFLICT (ticket_id, linked_ticket_id)
// DO NOTHING` (that table's own composite primary key).
const db = require("./db");
const departments = require("./departments");
const { triggerWebhooks } = require("./webhooks");

async function itemsForTemplate(templateId) {
  return db.prepare("SELECT * FROM template_checklist_items WHERE template_id = ? ORDER BY position, id").all(templateId);
}

async function addChecklistItem(templateId, { label, spawnCategory }) {
  const trimmedLabel = (label || "").trim().slice(0, 200);
  if (!trimmedLabel) return { error: "A checklist item needs a label." };
  const category = (spawnCategory || "").trim();
  if (category && !(await departments.isValidCategoryName(category))) {
    return { error: "Choose a valid category to spawn a ticket in, or leave it blank for a plain checklist line." };
  }

  const position = (
    await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM template_checklist_items WHERE template_id = ?").get(templateId)
  ).next;
  const result = await db
    .prepare("INSERT INTO template_checklist_items (template_id, label, spawn_category, position) VALUES (?, ?, ?, ?)")
    .run(templateId, trimmedLabel, category || null, position);
  return { id: result.lastInsertRowid };
}

async function removeChecklistItem(id) {
  await db.prepare("DELETE FROM template_checklist_items WHERE id = ?").run(id);
}

function substituteName(text, name) {
  return (text || "").split("{name}").join(name || "");
}

// Applies a template's spawn-on-use checklist items against a just-created
// origin ticket. originTicket needs {id, subject, requester_name,
// requester_email}. Returns the spawned ticket ids (empty array if this
// template has no spawn-flagged items).
async function applyTemplateSpawns({ templateId, originTicket, agentId }) {
  const items = (await itemsForTemplate(templateId)).filter((i) => i.spawn_category);
  if (!items.length) return [];

  const insertTicket = db.prepare(
    `INSERT INTO tickets (subject, description, category, requester_name, requester_email)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertActivity = db.prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`);
  // Symmetric insert - same shape as the /tickets/:id/link route, so either
  // ticket's own page finds the link with a plain "WHERE ticket_id = ?".
  const insertLink = db.prepare("INSERT INTO ticket_links (ticket_id, linked_ticket_id) VALUES (?, ?) ON CONFLICT (ticket_id, linked_ticket_id) DO NOTHING");

  const spawnedIds = [];
  for (const item of items) {
    const subject = substituteName(item.label, originTicket.requester_name).slice(0, 200);
    const description = `Spawned from ticket #${originTicket.id} ("${originTicket.subject}") via its onboarding checklist.`;

    const result = await insertTicket.run(subject, description, item.spawn_category, originTicket.requester_name, originTicket.requester_email);
    const spawnedId = result.lastInsertRowid;

    await insertActivity.run(spawnedId, agentId, `Created from ticket #${originTicket.id}'s onboarding checklist.`);
    // No subject here, unlike the spawned ticket's own activity line above -
    // this lands in the origin ticket's activity feed, which isn't
    // department-filtered the way linkedTickets now is (see
    // src/routes/dashboard.js's ticket detail route), so embedding the
    // spawned ticket's subject would leak it to anyone who can see the
    // origin ticket, regardless of whether they could see the spawned one.
    // The ticket number alone is safe - clicking through still 404s for an
    // out-of-department agent.
    await insertActivity.run(originTicket.id, agentId, `Spawned ticket #${spawnedId} from the onboarding checklist.`);

    await insertLink.run(originTicket.id, spawnedId);
    await insertLink.run(spawnedId, originTicket.id);

    await triggerWebhooks(
      "ticket.created",
      { ticket_id: spawnedId, subject, category: item.spawn_category, requester_email: originTicket.requester_email },
      await departments.departmentIdForCategory(item.spawn_category)
    );

    spawnedIds.push(spawnedId);
  }

  return spawnedIds;
}

module.exports = { itemsForTemplate, addChecklistItem, removeChecklistItem, applyTemplateSpawns, substituteName };
