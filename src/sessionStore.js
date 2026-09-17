// Shared connect-pg-simple session store instance - its own module (not
// inlined in src/app.js) so src/periodicChecks.js can also reach it (to call
// pruneSessions() - see that file) without a circular require back into
// app.js.
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const db = require("./db");

module.exports = new PgSession({ pool: db.pool, createTableIfMissing: true, pruneSessionInterval: false });
