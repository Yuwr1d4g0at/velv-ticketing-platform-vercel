// Ported to the async Postgres adapter (see src/db/index.js) - every
// function touching the database is now async, callers must await them.
// Also: the INSERT/UPDATE below used node:sqlite's named (@name) parameter
// binding via .run({...}) - the Postgres adapter only supports positional
// "?" placeholders (see src/db/index.js's toPgSql), so both were rewritten
// to plain positional parameters in FIELDS order. `datetime('now')` (a
// SQLite function, inline in application SQL, not just a column DEFAULT)
// became `now_text()`, a real Postgres function created by scripts/
// migrate.js for exactly this - see its own comment.
const db = require("./db");
const { ASSET_CATEGORIES, ASSET_STATUSES } = require("./constants");

const FIELDS = [
  "name",
  "asset_tag",
  "category",
  "status",
  "assigned_to_name",
  "location",
  "serial_number",
  "vendor",
  "purchase_date",
  "warranty_expires",
  "notes",
];

// For readable audit-trail lines - "Status changed..." rather than
// "status changed...".
const FIELD_LABELS = {
  name: "Name",
  asset_tag: "Asset tag",
  category: "Category",
  status: "Status",
  assigned_to_name: "Assigned to",
  location: "Location",
  serial_number: "Serial number",
  vendor: "Vendor",
  purchase_date: "Purchase date",
  warranty_expires: "Warranty expiry",
  notes: "Notes",
};

// Not retired/lost - the set worth offering on the public request form and
// as the default assignment target. Retired/Lost assets still exist (never
// deleted) and are still reachable/editable from the dashboard, just not
// pushed on requesters picking from a dropdown.
async function assignable() {
  return db
    .prepare(
      `SELECT id, name, asset_tag FROM assets
       WHERE status NOT IN ('Retired', 'Lost')
       ORDER BY name`
    )
    .all();
}

// Shared between all()/count() below so the two can never quietly filter
// differently from each other.
function buildFilterWhere({ status = "", category = "", q = "" } = {}) {
  let where = " WHERE 1 = 1";
  const params = [];
  if (ASSET_STATUSES.includes(status)) {
    where += " AND status = ?";
    params.push(status);
  }
  if (ASSET_CATEGORIES.includes(category)) {
    where += " AND category = ?";
    params.push(category);
  }
  if (q.trim()) {
    where += " AND (name LIKE ? OR asset_tag LIKE ? OR assigned_to_name LIKE ? OR serial_number LIKE ?)";
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like);
  }
  return { where, params };
}

// `pagination` is optional ({limit, offset}) - omitted entirely for CSV
// export, which always needs every matching row regardless of what page
// the dashboard list happens to be showing.
async function all(filters = {}, pagination = null) {
  const { where, params } = buildFilterWhere(filters);
  let sql = `SELECT * FROM assets${where} ORDER BY CASE status WHEN 'Retired' THEN 1 WHEN 'Lost' THEN 1 ELSE 0 END, name`;
  if (pagination) {
    sql += " LIMIT ? OFFSET ?";
    return db.prepare(sql).all(...params, pagination.limit, pagination.offset || 0);
  }
  return db.prepare(sql).all(...params);
}

async function count(filters = {}) {
  const { where, params } = buildFilterWhere(filters);
  return (await db.prepare(`SELECT COUNT(*) AS c FROM assets${where}`).get(...params)).c;
}

// Whole-inventory status counts for the Assets page's summary stat tiles -
// deliberately independent of the current filters (the same convention the
// ticket dashboard's own stat row uses), so switching a filter doesn't
// make the tiles themselves look like they're describing something else.
async function countsByStatus() {
  const rows = await db.prepare("SELECT status, COUNT(*) AS count FROM assets GROUP BY status").all();
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

async function get(id) {
  return db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
}

function normalize(fields) {
  const out = {};
  for (const key of FIELDS) {
    const raw = (fields[key] || "").toString().trim();
    out[key] = raw ? raw.slice(0, key === "notes" ? 5000 : 200) : null;
  }
  return out;
}

async function logActivity(assetId, agentId, body) {
  await db.prepare(`INSERT INTO asset_activity (asset_id, agent_id, body) VALUES (?, ?, ?)`).run(assetId, agentId, body);
}

// Returns { error } on validation failure, or { id } on success. agentId may
// be null (e.g. the seed script has no logged-in agent) - asset_activity's
// agent_id is nullable for exactly that reason.
async function create(fields, agentId = null) {
  const values = normalize(fields);
  if (!values.name) return { error: "Name is required." };
  if (!ASSET_CATEGORIES.includes(values.category)) return { error: "Choose a valid category." };
  if (values.status && !ASSET_STATUSES.includes(values.status)) return { error: "Choose a valid status." };
  if (values.asset_tag) {
    const existing = await db.prepare("SELECT id FROM assets WHERE asset_tag = ?").get(values.asset_tag);
    if (existing) return { error: `Asset tag "${values.asset_tag}" is already in use.` };
  }

  const status = values.status || "In Use";
  const result = await db
    .prepare(
      `INSERT INTO assets (name, asset_tag, category, status, assigned_to_name, location, serial_number, vendor, purchase_date, warranty_expires, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      values.name,
      values.asset_tag,
      values.category,
      status,
      values.assigned_to_name,
      values.location,
      values.serial_number,
      values.vendor,
      values.purchase_date,
      values.warranty_expires,
      values.notes
    );
  await logActivity(result.lastInsertRowid, agentId, "Asset created.");
  return { id: result.lastInsertRowid };
}

// Diffs the incoming values against what's currently stored and logs one
// readable line per field that actually changed - a save that changes
// nothing logs nothing, and a save that changes three fields logs three
// distinct lines rather than one opaque "asset updated".
async function update(id, fields, agentId = null) {
  const before = await get(id);
  const values = normalize(fields);
  if (!values.name) return { error: "Name is required." };
  if (!ASSET_CATEGORIES.includes(values.category)) return { error: "Choose a valid category." };
  if (!ASSET_STATUSES.includes(values.status)) return { error: "Choose a valid status." };
  if (values.asset_tag) {
    const existing = await db.prepare("SELECT id FROM assets WHERE asset_tag = ? AND id != ?").get(values.asset_tag, id);
    if (existing) return { error: `Asset tag "${values.asset_tag}" is already in use.` };
  }

  // A changed warranty date (renewed, or a data-entry fix) should be able to
  // alert again - same idea as a reopened ticket clearing sla_alerted_at.
  const warrantyChanged = before && (before.warranty_expires || null) !== (values.warranty_expires || null);

  await db
    .prepare(
      `UPDATE assets SET
         name = ?, asset_tag = ?, category = ?, status = ?,
         assigned_to_name = ?, location = ?, serial_number = ?,
         vendor = ?, purchase_date = ?, warranty_expires = ?,
         notes = ?, updated_at = now_text()${warrantyChanged ? ", warranty_alerted_at = NULL" : ""}
       WHERE id = ?`
    )
    .run(
      values.name,
      values.asset_tag,
      values.category,
      values.status,
      values.assigned_to_name,
      values.location,
      values.serial_number,
      values.vendor,
      values.purchase_date,
      values.warranty_expires,
      values.notes,
      id
    );

  if (before) {
    for (const key of FIELDS) {
      if ((before[key] || null) === (values[key] || null)) continue;
      const label = FIELD_LABELS[key];
      const from = before[key] || "(empty)";
      const to = values[key] || "(empty)";
      await logActivity(id, agentId, key === "notes" ? "Notes updated." : `${label} changed from "${from}" to "${to}".`);
    }
  }
  return { id };
}

async function ticketsForAsset(assetId) {
  return db
    .prepare(
      `SELECT tickets.id, tickets.subject, tickets.status, tickets.priority, tickets.created_at
       FROM tickets WHERE asset_id = ? ORDER BY created_at DESC`
    )
    .all(assetId);
}

async function activityForAsset(assetId) {
  return db
    .prepare(
      `SELECT asset_activity.*, agents.name AS agent_name
       FROM asset_activity
       LEFT JOIN agents ON agents.id = asset_activity.agent_id
       WHERE asset_id = ?
       ORDER BY created_at ASC`
    )
    .all(assetId);
}

module.exports = { assignable, all, count, countsByStatus, get, create, update, ticketsForAsset, activityForAsset };
