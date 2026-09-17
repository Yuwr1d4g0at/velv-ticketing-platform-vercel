// Ported to the async Postgres adapter (see src/db/index.js).
const db = require("./db");

const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 5000;

async function all() {
  return db
    .prepare(
      `SELECT canned_responses.id, canned_responses.title, canned_responses.body, canned_responses.department_id,
              departments.name AS department_name
       FROM canned_responses
       LEFT JOIN departments ON departments.id = canned_responses.department_id
       ORDER BY title`
    )
    .all();
}

// What `agent` is allowed to insert - every shared (department_id IS NULL)
// response, plus their own department's, plus everything for an admin. Used
// by the ticket page's "Insert a canned response" picker (see item 7 of the
// multi-department feature: canned responses stay separate per department,
// same as KB articles).
async function forAgent(agent) {
  if (agent && agent.is_admin) return all();
  return db
    .prepare(
      `SELECT canned_responses.id, canned_responses.title, canned_responses.body, canned_responses.department_id,
              departments.name AS department_name
       FROM canned_responses
       LEFT JOIN departments ON departments.id = canned_responses.department_id
       WHERE canned_responses.department_id IS NULL OR canned_responses.department_id = ?
       ORDER BY title`
    )
    .all(agent && agent.department_id);
}

async function get(id) {
  return db.prepare("SELECT id, title, body, department_id FROM canned_responses WHERE id = ?").get(id);
}

async function create(title, body, departmentId = null) {
  return db
    .prepare("INSERT INTO canned_responses (title, body, department_id) VALUES (?, ?, ?)")
    .run(title.trim().slice(0, MAX_TITLE_LENGTH), body.trim().slice(0, MAX_BODY_LENGTH), departmentId);
}

async function remove(id) {
  return db.prepare("DELETE FROM canned_responses WHERE id = ?").run(id);
}

module.exports = { MAX_TITLE_LENGTH, MAX_BODY_LENGTH, all, forAgent, get, create, remove };
