require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in the environment. Copy .env.example to .env and set one.");
  process.exit(1);
}

const app = require("./app");
const { runPeriodicChecks } = require("./periodicChecks");
const PORT = process.env.PORT || 3000;
const SLA_CHECK_INTERVAL_MINUTES = parseInt(process.env.SLA_CHECK_INTERVAL_MINUTES, 10) || 15;

app.listen(PORT, () => {
  console.log(`Velv Ticketing Platform listening on http://localhost:${PORT}`);
});

// Local/traditional-server-mode fallback only (a long-lived process actually
// exists here to hold a setInterval) - on Vercel this same runPeriodicChecks()
// logic instead runs via src/routes/cron.js (a daily Vercel Cron hit, see
// vercel.json) and the opportunistic trigger in dashboard.js's main route (on
// real traffic), since there's no long-lived process there for a setInterval
// to live in. All run once at startup, then on the interval.
runPeriodicChecks().catch((err) => console.error("Initial periodic check run failed:", err.message));
setInterval(() => {
  runPeriodicChecks().catch((err) => console.error("Periodic check run failed:", err.message));
}, SLA_CHECK_INTERVAL_MINUTES * 60 * 1000);
