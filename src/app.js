// The Express app itself, with no side effect of actually listening on a
// port - src/server.js does that. Split out so tests can require this
// directly and drive it with an in-process HTTP server on an ephemeral port,
// without going through the real startup script.
const path = require("path");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");

const { attachAgent } = require("./middleware/auth");
const { csrfToken } = require("./middleware/csrf");
const { attachLang } = require("./middleware/lang");
const { LANGUAGES } = require("./i18n");
const { renderRichText } = require("./richtext");
const publicRoutes = require("./routes/public");
const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const cronRoutes = require("./routes/cron");
const db = require("./db"); // { prepare, exec, pool } - see src/db/index.js's header comment
const sessionStore = require("./sessionStore");

if (!process.env.SESSION_SECRET) {
  // The friendly, exit(1)-with-a-message version of this check lives in
  // server.js, which is what a human actually runs. Anything requiring this
  // module directly (tests included) is expected to have set it already.
  throw new Error("Missing SESSION_SECRET in the environment.");
}

const app = express();
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.set("trust proxy", 1); // needed for correct secure-cookie behavior behind a reverse proxy

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
      },
    },
  })
);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(
  session({
    // connect-pg-simple against the same Neon pool db/index.js already
    // holds - replaces the old custom SqliteSessionStore. createTableIfMissing
    // creates+indexes its own "session" table the first time it's needed,
    // rather than hand-duplicating that table's shape into scripts/migrate.js.
    // pruneSessionInterval is off deliberately: a setInterval has no home in
    // a serverless function that doesn't stay alive between requests -
    // expired-session cleanup happens in src/periodicChecks.js instead (see
    // that file's pruneExpiredSessions, which uses this exact store instance).
    store: sessionStore,
    name: "velv.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

// Unauthenticated on purpose - a host or uptime monitor polling this has no
// way to log in. Checks real DB connectivity, not just "the process is up".
// One of the few routes touched directly in Phase 0 (not deferred to Phase
// 1/2's full async port) - it's the one health-check needed to confirm the
// Postgres connection actually works at all.
app.get("/healthz", async (req, res) => {
  try {
    await db.prepare("SELECT 1").get();
    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "error", message: err.message });
  }
});

// Unauthenticated (its own CRON_SECRET bearer-token check lives inside the
// route itself, not session-based) and mounted before the session/CSRF
// middleware below for the same reason /healthz is - Vercel Cron's request
// carries no session cookie.
app.use("/api/cron", cronRoutes);

app.use(attachAgent(db));
app.use(csrfToken);
app.use(attachLang);
// Available in every view as renderRichText(text) - used with <%- %> (raw
// output) specifically for ticket descriptions and note/reply bodies, the
// only two places rich text applies. See src/richtext.js for why that's
// safe: it escapes first, so <%- %> here is never rendering un-sanitized
// user input directly.
app.use((req, res, next) => {
  res.locals.renderRichText = renderRichText;
  next();
});

// Sets the language cookie and bounces back where the visitor came from - a
// plain link-based toggle (see the header partial), not JS-driven, since
// unlike the Lights theme toggle this changes server-rendered text, not
// just CSS.
app.get("/lang/:code", (req, res) => {
  const code = LANGUAGES.includes(req.params.code) ? req.params.code : "en";
  res.cookie("velv_lang", code, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: "lax", secure: COOKIE_SECURE });
  const back = req.get("Referer");
  res.redirect(back && back.startsWith(`${req.protocol}://${req.get("host")}`) ? back : "/");
});

app.use("/dashboard", dashboardRoutes);
app.use("/", authRoutes);
app.use("/", publicRoutes);

app.use((req, res) => {
  res.status(404).render("error", { title: "Not found", message: "That page does not exist." });
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).render("error", { title: "Something went wrong", message: "An unexpected error occurred. Please try again." });
});

module.exports = app;
