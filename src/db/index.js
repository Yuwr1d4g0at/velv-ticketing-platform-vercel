// Postgres (Neon, via the Vercel Marketplace) replacement for the old
// node:sqlite-backed src/db/index.js. Schema creation/seeding is NOT a
// side effect of requiring this module anymore - see scripts/migrate.js's
// header comment for why (serverless cold starts, not one long-lived
// process). This module is just the connection + a thin adapter.
//
// @neondatabase/serverless's Pool is API-compatible with node-postgres's
// pg.Pool but uses HTTP/WebSockets under the hood instead of a raw TCP
// connection - the right choice from a Vercel Function, which spins up and
// tears down per invocation far more often than a real persistent server
// ever would (a plain pg.Pool fights connection-limit exhaustion in that
// environment). connect-pg-simple (src/app.js's session store) is handed
// this exact same pool.
const { Pool } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "Missing DATABASE_URL in the environment. Run `vercel install neon` (or set it by hand for local dev) - see README's Vercel/Neon setup section."
  );
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// SQLite (and node:sqlite) use positional "?" placeholders; Postgres wants
// "$1, $2, ...". Naive but sufficient for this codebase's SQL - none of it
// embeds a literal "?" character inside a string/LIKE-pattern literal
// (checked during the Phase 1/2 port, not assumed).
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Mirrors node:sqlite's DatabaseSync: db.prepare(sql) returns an object
// with get/all/run, called with positional args - db.prepare(sql).get(x, y).
// The one real difference callers must adapt to (see the plan's "Key design
// decisions" #1): get/all/run are now async, because there is no
// synchronous Postgres driver in Node the way node:sqlite is synchronous
// (in-process, not network I/O). Every call site becomes
// `await db.prepare(sql).get(...)`, and its enclosing function needs to be
// `async` - that mechanical conversion is Phase 1/2's job, not this file's.
function prepare(sql) {
  const pgSql = toPgSql(sql);
  const isInsert = /^\s*insert/i.test(sql.trim());
  const alreadyHasReturning = /returning/i.test(sql);

  return {
    async get(...params) {
      const { rows } = await pool.query(pgSql, params);
      return rows[0];
    },
    async all(...params) {
      const { rows } = await pool.query(pgSql, params);
      return rows;
    },
    // node:sqlite's .run() returns { changes, lastInsertRowid }. Postgres
    // has no built-in "id of the row I just inserted" - RETURNING id is the
    // standard equivalent, appended automatically for a plain INSERT that
    // doesn't already have its own RETURNING clause.
    async run(...params) {
      const needsReturning = isInsert && !alreadyHasReturning;
      const finalSql = needsReturning ? `${pgSql} RETURNING id` : pgSql;
      const result = await pool.query(finalSql, params);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined,
      };
    },
  };
}

// Escape hatch for the rare call site that used node:sqlite's db.exec(sql)
// directly (multi-statement DDL, PRAGMAs) rather than prepare(sql).run() -
// ported case by case in Phase 1/2, not assumed away here.
async function exec(sql) {
  await pool.query(sql);
}

module.exports = { prepare, exec, pool };
