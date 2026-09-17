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
const { Pool, types } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error(
    "Missing DATABASE_URL in the environment. Run `vercel install neon` (or set it by hand for local dev) - see README's Vercel/Neon setup section."
  );
}

// node-postgres (which this driver's wire protocol handling is based on)
// returns BIGINT (OID 20 - what COUNT(*) produces) and NUMERIC (OID 1700 -
// what AVG()/SUM() on a numeric column produce) as strings by default, to
// avoid silently losing precision on values bigger than a JS number can
// hold exactly. node:sqlite never had this distinction - COUNT/AVG always
// came back as plain JS numbers - so every one of this app's call sites
// (dashboard stat tiles, report bar charts, EJS templates doing arithmetic
// or truthiness checks on a count) was written assuming that. Parsing both
// both types back to plain numbers here, once, restores that behavior everywhere
// instead of hunting down every COUNT()/AVG() call site individually; this
// app's counts/averages never approach Number.MAX_SAFE_INTEGER, so the
// precision tradeoff the string default exists for doesn't apply here.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// SQLite (and node:sqlite) use positional "?" placeholders; Postgres wants
// "$1, $2, ...". Naive but sufficient for this codebase's SQL - none of it
// embeds a literal "?" character inside a string/LIKE-pattern literal
// (checked during the Phase 1/2 port, not assumed).
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Shared by prepare() (below, against the whole pool - a different
// underlying connection per call is fine for a standalone statement) and
// transaction() (against one checked-out client - see its own comment).
// `queryable` is anything with the same query(sql, params) shape: the Pool
// itself, or a single connected Client.
// Composite-primary-key join/lookup tables that have no "id" column at all
// (see scripts/migrate.js) - an INSERT into one of these can never support
// `RETURNING id`, so run() below must not append it the way it does for
// every other table. Callers on these tables never read
// result.lastInsertRowid anyway (there's no single-column id to report).
const TABLES_WITHOUT_ID = new Set([
  "ticket_tags",
  "ticket_ratings",
  "sla_thresholds",
  "ticket_watchers",
  "ticket_custom_values",
  "ticket_links",
  "first_response_thresholds",
  "directory_cache",
]);

function insertTargetTable(sql) {
  const match = /^\s*insert\s+into\s+"?([a-zA-Z0-9_]+)"?/i.exec(sql);
  return match ? match[1].toLowerCase() : null;
}

function buildStatement(queryable, sql) {
  const pgSql = toPgSql(sql);
  const insertTable = insertTargetTable(sql);
  const isInsert = insertTable !== null;
  const alreadyHasReturning = /returning/i.test(sql);

  return {
    async get(...params) {
      const { rows } = await queryable.query(pgSql, params);
      return rows[0];
    },
    async all(...params) {
      const { rows } = await queryable.query(pgSql, params);
      return rows;
    },
    // node:sqlite's .run() returns { changes, lastInsertRowid }. Postgres
    // has no built-in "id of the row I just inserted" - RETURNING id is the
    // standard equivalent, appended automatically for a plain INSERT that
    // doesn't already have its own RETURNING clause and targets a table
    // that actually has an "id" column (see TABLES_WITHOUT_ID above).
    async run(...params) {
      const needsReturning = isInsert && !alreadyHasReturning && !TABLES_WITHOUT_ID.has(insertTable);
      const finalSql = needsReturning ? `${pgSql} RETURNING id` : pgSql;
      const result = await queryable.query(finalSql, params);
      return {
        changes: result.rowCount,
        lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined,
      };
    },
  };
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
  return buildStatement(pool, sql);
}

// Escape hatch for the rare call site that used node:sqlite's db.exec(sql)
// directly (multi-statement DDL, PRAGMAs) rather than prepare(sql).run() -
// ported case by case in Phase 1/2, not assumed away here.
async function exec(sql) {
  await pool.query(sql);
}

// For call sites that used node:sqlite's synchronous db.exec("BEGIN") / ...
// / db.exec("COMMIT") to make several statements atomic. That pattern
// relied on there being exactly one connection to the database, which was
// true for node:sqlite (in-process) but is NOT true against a Pool - a
// Pool can (and does, under any real concurrency) hand out a DIFFERENT
// underlying connection to each separate prepare(sql).run() call, which
// would make a bare "BEGIN"/"COMMIT" pair across several pool.query() calls
// silently non-atomic (each statement its own implicit transaction on
// whichever connection it happened to land on) - a real correctness bug,
// not just a style difference, caught while porting src/privacy.js and
// the ticket-merge/bulk-action routes in src/routes/dashboard.js.
//
// transaction(fn) checks out ONE client for the whole callback and hands
// fn a db-shaped object (same prepare(sql).get/all/run shape as the module
// export) backed by that single client, so every statement inside fn
// really does share one connection/transaction. Commits on a normal
// return, rolls back and rethrows on any error, and always releases the
// client back to the pool.
async function transaction(fn) {
  const client = await pool.connect();
  const txDb = { prepare: (sql) => buildStatement(client, sql) };
  try {
    await client.query("BEGIN");
    const result = await fn(txDb);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { prepare, exec, transaction, pool };
