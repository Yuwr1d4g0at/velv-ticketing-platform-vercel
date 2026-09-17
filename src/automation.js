// Simple condition/action automation, evaluated once at ticket creation
// (both the public form and agent-initiated creation) - see
// automation_rules in src/db/index.js. Deliberately not evaluated on every
// later update too - that would risk a rule silently re-firing (e.g.
// re-tagging) every time an unrelated field changes, which is more
// surprising than useful for a "basic" tool.
//
// Ported to the async Postgres adapter (see src/db/index.js) - every
// function touching the database (directly or via departments.js/tags.js)
// is now async.
const db = require("./db");
const { addTagToTicket } = require("./tags");
const departments = require("./departments");

async function all() {
  return db
    .prepare(
      `SELECT automation_rules.*, agents.name AS assignee_name, departments.name AS department_name
       FROM automation_rules
       LEFT JOIN agents ON agents.id = automation_rules.action_assigned_to
       LEFT JOIN departments ON departments.id = automation_rules.department_id
       ORDER BY automation_rules.active DESC, automation_rules.name`
    )
    .all();
}

async function create(fields) {
  const name = (fields.name || "").trim().slice(0, 200);
  const conditionCategory = (fields.condition_category || "").trim() || null;
  const conditionKeyword = (fields.condition_keyword || "").trim().slice(0, 100) || null;
  const actionTag = (fields.action_tag || "").trim().slice(0, 30) || null;
  const actionPriority = (fields.action_priority || "").trim() || null;
  const actionAssignedTo = fields.action_assigned_to ? parseInt(fields.action_assigned_to, 10) : null;
  // NULL means platform-wide (every rule that existed before this feature) -
  // a real id scopes the rule to firing only for that one department's
  // tickets, on top of whatever category/keyword condition it already has.
  const departmentId = fields.department_id ? parseInt(fields.department_id, 10) : null;

  if (!name) return { error: "Name is required." };
  if (!conditionCategory && !conditionKeyword) {
    return { error: "At least one condition (category or keyword) is required." };
  }
  if (!actionTag && !actionPriority && !actionAssignedTo) {
    return { error: "At least one action (tag, priority, or assignment) is required." };
  }

  const result = await db
    .prepare(
      `INSERT INTO automation_rules
         (name, condition_category, condition_keyword, action_tag, action_priority, action_assigned_to, department_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, conditionCategory, conditionKeyword, actionTag, actionPriority, actionAssignedTo, departmentId);
  return { id: result.lastInsertRowid };
}

async function setActive(id, active) {
  await db.prepare("UPDATE automation_rules SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

async function remove(id) {
  await db.prepare("DELETE FROM automation_rules WHERE id = ?").run(id);
}

async function matches(rule, ticket) {
  if (rule.condition_category && rule.condition_category !== ticket.category) return false;
  if (rule.condition_keyword) {
    const haystack = `${ticket.subject} ${ticket.description}`.toLowerCase();
    if (!haystack.includes(rule.condition_keyword.toLowerCase())) return false;
  }
  // A department-scoped rule (see create() above) only fires for tickets
  // filed under that department's own categories.
  if (rule.department_id && (await departments.departmentIdForCategory(ticket.category)) !== rule.department_id) {
    return false;
  }
  return true;
}

// Applies every active rule that matches this ticket, in rule-creation
// order - a ticket can match and be affected by more than one rule (e.g.
// one rule tags it, another sets its priority). Called right after a
// ticket is inserted (and after auto-assignment already ran), so a rule's
// own assignment action is a deliberate override of the round-robin pick,
// not a race with it.
async function applyRules(ticketId, ticket, agentIdForActivity = null) {
  const rules = await db.prepare("SELECT * FROM automation_rules WHERE active = 1 ORDER BY id").all();
  const applied = [];

  for (const rule of rules) {
    if (!(await matches(rule, ticket))) continue;
    applied.push(rule.name);

    if (rule.action_tag) {
      await addTagToTicket(ticketId, rule.action_tag);
    }
    if (rule.action_priority) {
      await db.prepare("UPDATE tickets SET priority = ? WHERE id = ?").run(rule.action_priority, ticketId);
      await db.prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'priority_change', ?)`).run(
        ticketId,
        agentIdForActivity,
        `Priority set to "${rule.action_priority}" by automation rule "${rule.name}".`
      );
    }
    if (rule.action_assigned_to) {
      const assignee = await db.prepare("SELECT name FROM agents WHERE id = ? AND active = 1").get(rule.action_assigned_to);
      if (assignee) {
        await db.prepare("UPDATE tickets SET assigned_to = ? WHERE id = ?").run(rule.action_assigned_to, ticketId);
        await db.prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'assignment', ?)`).run(
          ticketId,
          agentIdForActivity,
          `Assigned to ${assignee.name} by automation rule "${rule.name}".`
        );
      }
    }
  }

  return applied;
}

module.exports = { all, create, setActive, remove, applyRules };
