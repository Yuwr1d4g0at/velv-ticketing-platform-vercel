// Caches Microsoft Graph directory lookups (src/msGraph.js) in the
// directory_cache table so a ticket/agent page never makes a live Graph
// call on every view - only once a cached row is missing or older than
// CACHE_TTL_HOURS. Every function here is deliberately fail-soft: a Graph
// outage, missing permissions, or SSO not being configured at all all just
// mean "show no enrichment, fall back to whatever's cached" - never a
// broken page.
//
// Ported to the async Postgres adapter (see src/db/index.js). Inline
// `datetime('now')` calls became `now_text()`. photo_blob is BYTEA in
// Postgres (was BLOB in SQLite) - the driver already hands back a Buffer
// for it and accepts a Buffer as a bound parameter natively, so no change
// needed there beyond async/await.
const db = require("./db");
const msGraph = require("./msGraph");

const CACHE_TTL_HOURS = 24;

function isStale(fetchedAt) {
  const ageMs = Date.now() - new Date(`${fetchedAt.replace(" ", "T")}Z`).getTime();
  return ageMs > CACHE_TTL_HOURS * 60 * 60 * 1000;
}

function profileFromRow(row) {
  if (!row || !row.found) return null;
  return { displayName: row.display_name, department: row.department, jobTitle: row.job_title, phone: row.phone };
}

// Returns {displayName, department, jobTitle, phone}, or null if the
// person isn't found in the directory (or Graph isn't configured/reachable
// and nothing useful is cached yet).
async function getProfile(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const cached = await db.prepare("SELECT * FROM directory_cache WHERE email = ?").get(normalized);

  if (cached && !isStale(cached.fetched_at)) return profileFromRow(cached);
  if (!msGraph.isEnabled()) return profileFromRow(cached);

  let profile;
  try {
    profile = await msGraph.fetchUserProfile(normalized);
  } catch (err) {
    console.error("Graph directory lookup failed:", err.message);
    return profileFromRow(cached); // stale-but-real beats nothing
  }

  await db
    .prepare(
      `INSERT INTO directory_cache (email, display_name, department, job_title, phone, found, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, now_text())
       ON CONFLICT(email) DO UPDATE SET
         display_name = excluded.display_name, department = excluded.department,
         job_title = excluded.job_title, phone = excluded.phone,
         found = excluded.found, fetched_at = excluded.fetched_at`
    )
    .run(
      normalized,
      profile ? profile.displayName : null,
      profile ? profile.department : null,
      profile ? profile.jobTitle : null,
      profile ? profile.phone : null,
      profile ? 1 : 0
    );

  return profile;
}

// Photo bytes, cached the same way - {buffer, contentType} or null (no
// photo set, not found, or unavailable). Served via a small dashboard
// route rather than embedded inline, same pattern as attachment previews.
async function getPhoto(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const cached = await db.prepare("SELECT photo_blob, photo_content_type, fetched_at FROM directory_cache WHERE email = ?").get(normalized);
  const cachedPhoto = cached && cached.photo_blob ? { buffer: Buffer.from(cached.photo_blob), contentType: cached.photo_content_type } : null;

  if (cached && cachedPhoto && !isStale(cached.fetched_at)) return cachedPhoto;
  if (!msGraph.isEnabled()) return cachedPhoto;

  let photo;
  try {
    photo = await msGraph.fetchUserPhoto(normalized);
  } catch (err) {
    console.error("Graph photo lookup failed:", err.message);
    return cachedPhoto;
  }

  await db
    .prepare(
      `INSERT INTO directory_cache (email, photo_blob, photo_content_type, fetched_at)
       VALUES (?, ?, ?, now_text())
       ON CONFLICT(email) DO UPDATE SET
         photo_blob = excluded.photo_blob, photo_content_type = excluded.photo_content_type, fetched_at = excluded.fetched_at`
    )
    .run(normalized, photo ? photo.buffer : null, photo ? photo.contentType : null);

  return photo;
}

module.exports = { getProfile, getPhoto };
