// Departments + department-scoped categories, and the one place that
// decides whether an agent can see a given ticket.
//
// This exact feature shipped once before and was fully reverted the same
// day: visibility had a quiet carve-out ("you can still see a ticket you're
// personally assigned to or watching, even outside your department"), and
// because the only two real test tickets happened to both be assigned to
// the one agent testing it, switching that agent's department appeared to
// do nothing - the carve-out always won. It passed every automated test
// written for it (synthetic multi-department fixtures that never exercised
// that gap) and still shipped broken.
//
// canSeeTicket() below has NO such carve-out for a regular agent: it's a
// strict department match, full stop. Confidentiality (see tickets.
// confidential) only ever narrows what a same-department agent can see,
// never widens it across departments. The ONLY bypass is agents.is_admin -
// a real, visible, opt-in role (shown on the Agents page), never a default
// anyone quietly ends up with.
//
// Ported to the async Postgres adapter (see src/db/index.js) - every
// function that touches the database is now async; callers must await
// them. canSeeTicket/isEligibleAssignee in particular gate real access
// control - a caller that forgets to await one gets back a Promise (always
// truthy), which would silently defeat the check it's guarding (e.g.
// `!ticket || !canSeeTicket(...)` would short-circuit on `!ticket` alone
// and never actually deny access) - every call site in src/routes/*.js was
// updated to await these, not left to chance.
const db = require("./db");

async function all() {
  return db.prepare("SELECT * FROM departments WHERE active = 1 ORDER BY name").all();
}

async function allIncludingInactive() {
  return db.prepare("SELECT * FROM departments ORDER BY active DESC, name").all();
}

async function get(id) {
  return db.prepare("SELECT * FROM departments WHERE id = ?").get(id);
}

async function create(name) {
  const trimmed = (name || "").trim().slice(0, 100);
  if (!trimmed) return { error: "Name is required." };
  // COLLATE NOCASE (SQLite) -> LOWER(name) = LOWER(?) (Postgres has no
  // built-in case-insensitive text collation without an extension) - same
  // "does a case-variant already exist" pre-insert check either way, not a
  // change to the column's own UNIQUE constraint (still case-sensitive at
  // the DB level, exactly as it was in SQLite - this check is what actually
  // prevents a user-visible near-duplicate in normal use).
  const existing = await db.prepare("SELECT id FROM departments WHERE LOWER(name) = LOWER(?)").get(trimmed);
  if (existing) return { error: "A department with that name already exists." };
  const result = await db.prepare("INSERT INTO departments (name) VALUES (?)").run(trimmed);
  return { id: result.lastInsertRowid };
}

async function setActive(id, active) {
  await db.prepare("UPDATE departments SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

// ---- Categories ----------------------------------------------------------

async function categoriesAll() {
  return db
    .prepare(
      `SELECT categories.*, departments.name AS department_name
       FROM categories JOIN departments ON departments.id = categories.department_id
       WHERE categories.active = 1
       ORDER BY departments.name, categories.name`
    )
    .all();
}

async function allCategoriesIncludingInactive() {
  return db
    .prepare(
      `SELECT categories.*, departments.name AS department_name
       FROM categories JOIN departments ON departments.id = categories.department_id
       ORDER BY categories.active DESC, departments.name, categories.name`
    )
    .all();
}

// Flat list of category names - the direct replacement for the old
// CATEGORIES constant everywhere a plain "is this a valid category" check
// or an unstructured <select> needs one.
async function categoryNames() {
  return (await categoriesAll()).map((c) => c.name);
}

// Same categories, grouped by department name - for any view that presents
// categories organized by department, whether that's a dashboard view
// scoped to one department at a time (custom fields, automation, templates,
// recurring tickets) or the public request form's <optgroup>-per-department
// category picker (see src/routes/public.js). Purely a presentation
// grouping - it doesn't change which category a requester can pick, or how
// a ticket's department gets derived (still departmentIdForCategory() below,
// off whichever category name actually gets submitted).
async function categoriesByDepartment() {
  const grouped = {};
  for (const c of await categoriesAll()) {
    (grouped[c.department_name] = grouped[c.department_name] || []).push(c);
  }
  return grouped;
}

async function isValidCategoryName(name) {
  return Boolean(await db.prepare("SELECT 1 FROM categories WHERE name = ? AND active = 1").get(name));
}

async function departmentIdForCategory(name) {
  const row = await db.prepare("SELECT department_id FROM categories WHERE name = ?").get(name);
  return row ? row.department_id : null;
}

async function createCategory(name, departmentId) {
  const trimmed = (name || "").trim().slice(0, 100);
  if (!trimmed) return { error: "Category name is required." };
  const dept = await get(departmentId);
  if (!dept) return { error: "Choose a valid department." };
  const existing = await db.prepare("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)").get(trimmed);
  if (existing) return { error: "A category with that name already exists." };
  const result = await db.prepare("INSERT INTO categories (name, department_id) VALUES (?, ?)").run(trimmed, departmentId);
  return { id: result.lastInsertRowid };
}

async function setCategoryActive(id, active) {
  await db.prepare("UPDATE categories SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

// ---- Approval gate ---------------------------------------------------------

// Whether closing a ticket filed under `categoryName` has to go through the
// approval gate (see applyStatusChange in src/routes/dashboard.js) instead of
// closing directly. Off by default for every category - see the
// requires_approval migration in src/db/index.js, which flips it on for
// Marketing's Content & Design and Campaign Request out of the box, and
// leaves every other category (including everything that predates this
// feature) closing exactly as it always has.
async function categoryRequiresApproval(categoryName) {
  const row = await db.prepare("SELECT requires_approval FROM categories WHERE name = ?").get(categoryName);
  return Boolean(row && row.requires_approval);
}

async function setCategoryRequiresApproval(id, requiresApproval) {
  await db.prepare("UPDATE categories SET requires_approval = ? WHERE id = ?").run(requiresApproval ? 1 : 0, id);
}

// ---- Ticket visibility ----------------------------------------------------

// Whether `agent` can see `ticket`. `agent` needs at least
// {id, department_id, is_admin}; `ticket` needs at least
// {category, confidential, assigned_to}. See the file comment above for
// why there is deliberately no assignment/watcher carve-out here.
async function canSeeTicket(agent, ticket) {
  if (!agent) return false;
  if (agent.is_admin) return true;
  const ticketDeptId = await departmentIdForCategory(ticket.category);
  if (ticketDeptId == null || ticketDeptId !== agent.department_id) return false;
  if (ticket.confidential) return ticket.assigned_to === agent.id;
  return true;
}

// The SQL equivalent of canSeeTicket(), for filtering a list/count/CSV/
// report query at the database level instead of fetching everything and
// filtering in application code. Assumes the query already makes an
// unaliased `tickets` table available (every caller in this app does).
// Returns an empty fragment for an admin - nothing to restrict. Doesn't
// touch the database itself (just builds a SQL fragment from the agent
// object already in hand) - deliberately NOT async, unlike everything else
// in this file.
function ticketVisibilitySql(agent) {
  if (!agent || agent.is_admin) return { sql: "", params: [] };
  return {
    sql: ` AND tickets.category IN (SELECT name FROM categories WHERE department_id = ?) AND (tickets.confidential = 0 OR tickets.assigned_to = ?)`,
    params: [agent.department_id, agent.id],
  };
}

// Whether `assignee` is allowed to be assigned a ticket filed under
// `categoryName`. An admin can be assigned anything; anyone else has to
// actually belong to that category's department. Used for both automatic
// (round-robin, on ticket creation) and manual (agent-initiated ticket,
// single/bulk assign) assignment, so "only agents in that department are
// eligible" is one rule enforced everywhere, not a policy that quietly
// differs by how the assignment happens.
async function isEligibleAssignee(assignee, categoryName) {
  if (!assignee) return false;
  if (assignee.is_admin) return true;
  return assignee.department_id === (await departmentIdForCategory(categoryName));
}

// ---- Consultant visibility -------------------------------------------------

// Same strict department-match model as canSeeTicket() above, applied to
// consultants.department_id directly - no category indirection needed here,
// a consultant stores its department id straight on the row. See the file
// comment at the top for why there is deliberately NO assignment/watcher
// carve-out for a regular agent - the same rule, the same reason, just a
// different table. `agent` needs at least {id, department_id, is_admin};
// `consultant` needs at least {department_id, confidential, assigned_to}.
async function canSeeConsultant(agent, consultant) {
  if (!agent) return false;
  if (agent.is_admin) return true;
  if (consultant.department_id !== agent.department_id) return false;
  if (consultant.confidential) return consultant.assigned_to === agent.id;
  return true;
}

// The SQL equivalent of canSeeConsultant(), for filtering a list/count/CSV
// query at the database level - see ticketVisibilitySql()'s own comment for
// the reasoning (unaliased `consultants` table assumed, empty fragment for
// an admin, deliberately NOT async).
function consultantVisibilitySql(agent) {
  if (!agent || agent.is_admin) return { sql: "", params: [] };
  return {
    sql: ` AND consultants.department_id = ? AND (consultants.confidential = 0 OR consultants.assigned_to = ?)`,
    params: [agent.department_id, agent.id],
  };
}

module.exports = {
  all,
  allIncludingInactive,
  get,
  create,
  setActive,
  categoriesAll,
  allCategoriesIncludingInactive,
  categoryNames,
  categoriesByDepartment,
  isValidCategoryName,
  departmentIdForCategory,
  createCategory,
  setCategoryActive,
  categoryRequiresApproval,
  setCategoryRequiresApproval,
  canSeeTicket,
  ticketVisibilitySql,
  isEligibleAssignee,
  canSeeConsultant,
  consultantVisibilitySql,
};
