// Consultants: a persistent record HR and Legal use to track external
// consultants they engage (outside counsel, HR consultants/recruiters,
// expert witnesses, trainers, ...) - NOT a ticket, its own lifecycle.
// Modeled closely on src/assets.js (CRUD, retire-not-delete via status
// rather than DELETE, field-level change history in consultant_activity,
// CSV export), with one addition assets don't have: strict department-scoped
// visibility plus a confidential flag, both with the exact same semantics
// tickets already use (see src/departments.js's canSeeConsultant/
// consultantVisibilitySql, and its file comment for why that model has NO
// assignment/watcher carve-out - deliberately not repeated here either).
//
// Async Postgres adapter throughout (see src/db/index.js) - every function
// that touches the database is async, every call site awaits it.
const db = require("./db");
const departments = require("./departments");
const { CONSULTANT_STATUSES } = require("./constants");

// department_id and confidential are deliberately NOT in this list:
// department_id because only an admin may change it (the route decides
// whether a submitted value is honored before calling update(), passing the
// resolved value in separately - see newDepartmentId below); confidential
// because toggling it is gated by a different permission (admin or the
// assigned agent only) than every other field here - see
// POST /dashboard/consultants/:id/confidential in src/routes/dashboard.js.
const FIELDS = ["name", "company", "specialty", "email", "phone", "status", "engagement_start", "engagement_end", "rate", "assigned_to", "notes"];

// For readable audit-trail lines - "Status changed..." rather than "status
// changed...". assigned_to is handled separately in update() below (it logs
// agent *names*, not raw ids), so it has no entry here.
const FIELD_LABELS = {
  name: "Name",
  company: "Company",
  specialty: "Specialty",
  email: "Email",
  phone: "Phone",
  status: "Status",
  engagement_start: "Engagement start",
  engagement_end: "Engagement end",
  rate: "Rate",
  notes: "Notes",
};

// Shared between all()/count()/countsByStatus() so none of them can quietly
// filter differently from each other. Always folds in
// departments.consultantVisibilitySql(agent) - every read path in this
// module goes through this one function, which is what makes "every read
// path is scoped" true by construction rather than by remembering to add
// the check at each call site.
function buildFilterWhere(agent, { status = "", department_id = "", q = "" } = {}) {
  let where = " WHERE 1 = 1";
  const params = [];
  if (CONSULTANT_STATUSES.includes(status)) {
    where += " AND consultants.status = ?";
    params.push(status);
  }
  // Only an admin's department filter is honored here - a non-admin is
  // already fully scoped to their own single department by
  // consultantVisibilitySql below, so a department_id they submit (there's
  // no UI control for it, but nothing stops a forged query string) is simply
  // ignored rather than trusted to narrow (or, worse, misused to imply they
  // could ever widen) what visibility already enforces.
  if (agent && agent.is_admin && department_id) {
    where += " AND consultants.department_id = ?";
    params.push(parseInt(department_id, 10));
  }
  if (q.trim()) {
    where += " AND (consultants.name LIKE ? OR consultants.company LIKE ?)";
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  const visibility = departments.consultantVisibilitySql(agent);
  where += visibility.sql;
  params.push(...visibility.params);
  return { where, params };
}

// `pagination` is optional ({limit, offset}) - omitted entirely for CSV
// export, which always needs every matching (and visible) row regardless of
// what page the dashboard list happens to be showing.
async function all(agent, filters = {}, pagination = null) {
  const { where, params } = buildFilterWhere(agent, filters);
  let sql = `
    SELECT consultants.*, departments.name AS department_name, agents.name AS assigned_to_name
    FROM consultants
    JOIN departments ON departments.id = consultants.department_id
    LEFT JOIN agents ON agents.id = consultants.assigned_to
    ${where}
    ORDER BY CASE consultants.status WHEN 'Ended' THEN 1 ELSE 0 END, consultants.name`;
  if (pagination) {
    sql += " LIMIT ? OFFSET ?";
    return await db.prepare(sql).all(...params, pagination.limit, pagination.offset || 0);
  }
  return await db.prepare(sql).all(...params);
}

async function count(agent, filters = {}) {
  const { where, params } = buildFilterWhere(agent, filters);
  return (await db.prepare(`SELECT COUNT(*) AS c FROM consultants${where}`).get(...params)).c;
}

// Whole-(visible-)inventory status counts for the Consultants page's summary
// stat tiles - independent of the status/search filters (same convention as
// assets.countsByStatus/the ticket dashboard's own stat row), but NOT
// independent of department visibility - an agent's stat tiles only ever
// describe consultants they could actually open.
async function countsByStatus(agent) {
  const visibility = departments.consultantVisibilitySql(agent);
  const rows = await db.prepare(`SELECT status, COUNT(*) AS count FROM consultants WHERE 1 = 1${visibility.sql} GROUP BY status`).all(...visibility.params);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

// The one choke point for department (and confidential-flag) visibility on
// a single consultant - detail page, update, confidential toggle all go
// through this. Returns null both when the row doesn't exist AND when it
// exists but the agent can't see it - the caller renders the same 404
// either way (see getConsultantOr404 in src/routes/dashboard.js), never a
// distinguishable "forbidden" that would leak that a given id is real.
async function get(id, agent) {
  const consultant = await db
    .prepare(
      `SELECT consultants.*, departments.name AS department_name, agents.name AS assigned_to_name
       FROM consultants
       JOIN departments ON departments.id = consultants.department_id
       LEFT JOIN agents ON agents.id = consultants.assigned_to
       WHERE consultants.id = ?`
    )
    .get(id);
  if (!consultant) return null;
  if (!(await departments.canSeeConsultant(agent, consultant))) return null;
  return consultant;
}

function normalize(fields) {
  const out = {};
  for (const key of FIELDS) {
    if (key === "assigned_to") continue; // integer FK, handled below
    const raw = (fields[key] || "").toString().trim();
    out[key] = raw ? raw.slice(0, key === "notes" ? 5000 : 200) : null;
  }
  out.assigned_to = fields.assigned_to ? parseInt(fields.assigned_to, 10) : null;
  return out;
}

async function logActivity(consultantId, agentId, body) {
  await db.prepare(`INSERT INTO consultant_activity (consultant_id, agent_id, body) VALUES (?, ?, ?)`).run(consultantId, agentId, body);
}

// Returns { error } on validation failure, or { id } on success. `agentId`
// may be null the same way assets.create's can. `departmentId` is always
// resolved by the caller (the creating agent's own department, or - admin
// only - whichever department they picked; see the route) before this is
// called, never trusted straight off req.body here.
async function create(fields, agentId, departmentId) {
  const values = normalize(fields);
  if (!values.name) return { error: "Name is required." };
  if (!departmentId) return { error: "Choose a valid department." };
  const dept = await departments.get(departmentId);
  if (!dept) return { error: "Choose a valid department." };
  if (values.status && !CONSULTANT_STATUSES.includes(values.status)) return { error: "Choose a valid status." };
  if (values.assigned_to) {
    const assignee = await db.prepare("SELECT id FROM agents WHERE id = ? AND active = 1").get(values.assigned_to);
    if (!assignee) return { error: "Choose a valid agent to assign." };
  }

  const status = values.status || "Active";
  const result = await db
    .prepare(
      `INSERT INTO consultants (name, company, specialty, email, phone, department_id, status, engagement_start, engagement_end, rate, assigned_to, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      values.name,
      values.company,
      values.specialty,
      values.email,
      values.phone,
      departmentId,
      status,
      values.engagement_start,
      values.engagement_end,
      values.rate,
      values.assigned_to,
      values.notes
    );
  await logActivity(result.lastInsertRowid, agentId, "Consultant added.");
  return { id: result.lastInsertRowid };
}

// Diffs the incoming values against what's currently stored and logs one
// readable line per field that actually changed - same convention as
// assets.update. `newDepartmentId` is null unless the acting agent is an
// admin AND actually picked a different department on the form (see the
// route) - never derived from req.body directly here, so a non-admin has no
// way to move a consultant across the strict department boundary via this
// function no matter what they submit.
async function update(id, fields, agentId, newDepartmentId = null) {
  const before = await db.prepare("SELECT * FROM consultants WHERE id = ?").get(id);
  if (!before) return { error: "Consultant not found." };

  const values = normalize(fields);
  if (!values.name) return { error: "Name is required." };
  if (!values.status || !CONSULTANT_STATUSES.includes(values.status)) return { error: "Choose a valid status." };
  if (values.assigned_to) {
    const assignee = await db.prepare("SELECT id FROM agents WHERE id = ? AND active = 1").get(values.assigned_to);
    if (!assignee) return { error: "Choose a valid agent to assign." };
  }

  let departmentId = before.department_id;
  if (newDepartmentId && newDepartmentId !== before.department_id) {
    const dept = await departments.get(newDepartmentId);
    if (!dept) return { error: "Choose a valid department." };
    departmentId = newDepartmentId;
  }

  await db
    .prepare(
      `UPDATE consultants SET
         name = ?, company = ?, specialty = ?, email = ?, phone = ?, department_id = ?,
         status = ?, engagement_start = ?, engagement_end = ?, rate = ?, assigned_to = ?,
         notes = ?, updated_at = now_text()
       WHERE id = ?`
    )
    .run(
      values.name,
      values.company,
      values.specialty,
      values.email,
      values.phone,
      departmentId,
      values.status,
      values.engagement_start,
      values.engagement_end,
      values.rate,
      values.assigned_to,
      values.notes,
      id
    );

  for (const key of FIELDS) {
    if ((before[key] || null) === (values[key] || null)) continue;
    if (key === "assigned_to") {
      const fromAgent = before.assigned_to ? await db.prepare("SELECT name FROM agents WHERE id = ?").get(before.assigned_to) : null;
      const toAgent = values.assigned_to ? await db.prepare("SELECT name FROM agents WHERE id = ?").get(values.assigned_to) : null;
      await logActivity(
        id,
        agentId,
        `Assigned to changed from "${fromAgent ? fromAgent.name : "(unassigned)"}" to "${toAgent ? toAgent.name : "(unassigned)"}".`
      );
      continue;
    }
    const label = FIELD_LABELS[key];
    const from = before[key] || "(empty)";
    const to = values[key] || "(empty)";
    await logActivity(id, agentId, key === "notes" ? "Notes updated." : `${label} changed from "${from}" to "${to}".`);
  }

  if (departmentId !== before.department_id) {
    const fromDept = await departments.get(before.department_id);
    const toDept = await departments.get(departmentId);
    await logActivity(id, agentId, `Department changed from "${fromDept ? fromDept.name : "(unknown)"}" to "${toDept ? toDept.name : "(unknown)"}".`);
  }

  return { id };
}

// Confidential is toggled outside update() above on purpose - a different
// permission gate applies (admin or the assigned agent only - see the
// route), not the "anyone who can see this record can edit it" rule the
// rest of the fields follow. Mirrors tickets.confidential's own logging
// wording (see /tickets/:id/confidential in src/routes/dashboard.js).
async function setConfidential(id, confidential, agentId) {
  await db.prepare("UPDATE consultants SET confidential = ?, updated_at = now_text() WHERE id = ?").run(confidential ? 1 : 0, id);
  await logActivity(
    id,
    agentId,
    confidential ? "Marked confidential - only the assigned agent and admins can see this consultant." : "Removed the confidential flag."
  );
}

async function activityFor(consultantId) {
  return await db
    .prepare(
      `SELECT consultant_activity.*, agents.name AS agent_name
       FROM consultant_activity
       LEFT JOIN agents ON agents.id = consultant_activity.agent_id
       WHERE consultant_id = ?
       ORDER BY created_at ASC`
    )
    .all(consultantId);
}

module.exports = { all, count, countsByStatus, get, create, update, setConfidential, activityFor };
