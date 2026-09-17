// Public knowledge-base articles - agents write and publish them, requesters
// browse/search them without logging in. The single biggest lever this app
// has for cutting ticket volume, and something it had zero of before this.
//
// Ported to the async Postgres adapter (see src/db/index.js). `datetime('now')`
// (inline in update()'s SQL, not just a column DEFAULT) became `now_text()`.
const db = require("./db");

function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents (café -> cafe)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Appends -2, -3, ... if the plain slug's taken - titles collide more than
// you'd think ("How to reset your password" twice, a year apart).
async function uniqueSlug(title, excludeId = null) {
  const base = slugify(title) || "article";
  let candidate = base;
  let n = 2;
  while (true) {
    const existing = await db.prepare("SELECT id FROM kb_articles WHERE slug = ? AND id != ?").get(candidate, excludeId || -1);
    if (!existing) return candidate;
    candidate = `${base}-${n++}`;
  }
}

async function publishedList({ category = "", q = "" } = {}) {
  let sql = "SELECT * FROM kb_articles WHERE published = 1";
  const params = [];
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  if (q.trim()) {
    sql += " AND (title LIKE ? OR body LIKE ?)";
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }
  sql += " ORDER BY title";
  return db.prepare(sql).all(...params);
}

async function allForDashboard() {
  return db
    .prepare(
      `SELECT kb_articles.*, departments.name AS department_display_name
       FROM kb_articles LEFT JOIN departments ON departments.id = kb_articles.department_id
       ORDER BY published DESC, title`
    )
    .all();
}

// The dashboard KB list, scoped to what `agent` can manage: every shared
// article (department_id IS NULL), plus their own department's, plus
// everything for an admin. The public /kb browsing list (publishedList()
// above) stays unscoped on purpose - department-specific public-facing
// content is explicitly out of scope for this feature.
async function forAgent(agent) {
  if (agent && agent.is_admin) return allForDashboard();
  return db
    .prepare(
      `SELECT kb_articles.*, departments.name AS department_display_name
       FROM kb_articles LEFT JOIN departments ON departments.id = kb_articles.department_id
       WHERE kb_articles.department_id IS NULL OR kb_articles.department_id = ?
       ORDER BY published DESC, title`
    )
    .all(agent && agent.department_id);
}

async function getBySlug(slug) {
  return db.prepare("SELECT * FROM kb_articles WHERE slug = ? AND published = 1").get(slug);
}

async function get(id) {
  return db.prepare("SELECT * FROM kb_articles WHERE id = ?").get(id);
}

async function create(fields, agentId) {
  const title = (fields.title || "").trim().slice(0, 200);
  const body = (fields.body || "").trim().slice(0, 20000);
  const category = (fields.category || "").trim().slice(0, 100) || null;
  const departmentId = fields.department_id ? parseInt(fields.department_id, 10) : null;
  if (!title) return { error: "Title is required." };
  if (!body) return { error: "Body is required." };

  const slug = await uniqueSlug(title);
  const result = await db
    .prepare("INSERT INTO kb_articles (title, slug, body, category, agent_id, department_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(title, slug, body, category, agentId, departmentId);
  return { id: result.lastInsertRowid };
}

async function update(id, fields) {
  const title = (fields.title || "").trim().slice(0, 200);
  const body = (fields.body || "").trim().slice(0, 20000);
  const category = (fields.category || "").trim().slice(0, 100) || null;
  const departmentId = fields.department_id ? parseInt(fields.department_id, 10) : null;
  const published = fields.published ? 1 : 0;
  if (!title) return { error: "Title is required." };
  if (!body) return { error: "Body is required." };

  const current = await get(id);
  if (!current) return { error: "That article does not exist." };
  // The slug is part of the article's public URL - keep it stable across
  // edits (retitling shouldn't break a link someone already shared) unless
  // there's never been a title at all, which can't actually happen here.
  await db
    .prepare(
      "UPDATE kb_articles SET title = ?, body = ?, category = ?, department_id = ?, published = ?, updated_at = now_text() WHERE id = ?"
    )
    .run(title, body, category, departmentId, published, id);
  return { id };
}

module.exports = { publishedList, allForDashboard, forAgent, getBySlug, get, create, update, uniqueSlug };
