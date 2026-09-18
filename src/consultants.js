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

// Same pattern src/routes/public.js and src/routes/dashboard.js already use
// for a requester's email - deliberately permissive (this app has no need
// to be the strict arbiter of what's a "real" email), just enough to catch
// obvious garbage a direct POST bypassing the form's own type="email" could
// otherwise store silently.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// No existing phone pattern anywhere else in this app to match - kept
// intentionally loose (digits, spaces, and the punctuation a real phone
// number legitimately uses) rather than inventing a strict international
// format this app has no actual need to enforce.
const PHONE_RE = /^[0-9+\-() .]+$/;

// Shared by create() and update() so the two can't quietly drift on what
// counts as valid. Returns an error string, or null if everything's fine.
function validateFormat(values) {
  if (values.email && !EMAIL_RE.test(values.email)) return "Enter a valid email address.";
  if (values.phone && !PHONE_RE.test(values.phone)) return "Enter a valid phone number.";
  if (values.engagement_start && values.engagement_end && values.engagement_start > values.engagement_end) {
    return "Engagement start date must be on or before the engagement end date.";
  }
  return null;
}

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
  const formatError = validateFormat(values);
  if (formatError) return { error: formatError };
  if (values.assigned_to) {
    const assignee = await db.prepare("SELECT id, is_admin, department_id FROM agents WHERE id = ? AND active = 1").get(values.assigned_to);
    if (!assignee || !departments.isEligibleConsultantAssignee(assignee, departmentId)) {
      return { error: "Choose a valid agent to assign - they must be active and in this consultant's own department." };
    }
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

  // Optimistic-locking check: the edit form embeds the consultant's
  // updated_at as of when the page was loaded (expected_updated_at, see
  // views/dashboard/consultant.ejs); `before` above is always read fresh,
  // so a mismatch means a second agent's edit landed in between - reject
  // rather than silently overwrite it last-write-wins. A request with no
  // expected_updated_at (an older client, a direct API-style POST) is
  // never treated as stale.
  if (fields.expected_updated_at && fields.expected_updated_at !== before.updated_at) {
    return { error: "Someone else updated this consultant since you loaded the page. Reload and try again." };
  }

  const values = normalize(fields);
  if (!values.name) return { error: "Name is required." };
  if (!values.status || !CONSULTANT_STATUSES.includes(values.status)) return { error: "Choose a valid status." };
  const formatError = validateFormat(values);
  if (formatError) return { error: formatError };

  // Resolved before the assignee check below, since eligibility depends on
  // the FINAL department - an admin moving a consultant to a new
  // department in the same request needs the assignee checked against
  // where it's going, not where it currently is.
  let departmentId = before.department_id;
  if (newDepartmentId && newDepartmentId !== before.department_id) {
    const dept = await departments.get(newDepartmentId);
    if (!dept) return { error: "Choose a valid department." };
    departmentId = newDepartmentId;
  }

  if (values.assigned_to) {
    const assignee = await db.prepare("SELECT id, is_admin, department_id FROM agents WHERE id = ? AND active = 1").get(values.assigned_to);
    if (!assignee || !departments.isEligibleConsultantAssignee(assignee, departmentId)) {
      return { error: "Choose a valid agent to assign - they must be active and in this consultant's own department." };
    }
  }

  // Same idea as assets.js's warrantyChanged: a changed engagement_end date
  // means any past "ending soon" alert (src/consultantReminders.js) was
  // about the old date and no longer applies - clear it so a genuinely new
  // date gets its own alert instead of staying silently suppressed by the
  // old one.
  const engagementEndChanged = (before.engagement_end || null) !== (values.engagement_end || null);

  await db
    .prepare(
      `UPDATE consultants SET
         name = ?, company = ?, specialty = ?, email = ?, phone = ?, department_id = ?,
         status = ?, engagement_start = ?, engagement_end = ?, rate = ?, assigned_to = ?,
         notes = ?, updated_at = now_text()${engagementEndChanged ? ", engagement_end_alerted_at = NULL" : ""}
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
