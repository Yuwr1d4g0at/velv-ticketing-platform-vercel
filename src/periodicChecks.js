// All of the app's periodic background work (SLA/first-response breach
// alerts, warranty/contract reminders, recurring tickets, the daily digest,
// the SharePoint asset sync, and expired-session pruning), extracted out of
// src/server.js so it's reachable from two other places that aren't a
// long-lived process's setInterval:
//   - src/routes/cron.js - a daily Vercel Cron hit (see vercel.json), the
//     only cadence Hobby-plan Cron Jobs support.
//   - src/routes/dashboard.js's main route - an "opportunistic" trigger on
//     real traffic (see triggerOpportunistically below), which covers the
//     gap between once-daily cron runs during business hours when agents are
//     actually using the dashboard.
// src/server.js keeps its own setInterval too, for local/traditional-server
// use (`npm start`/`npm run dev`) where a long-lived process still exists.
const db = require("./db");
const sessionStore = require("./sessionStore");
const { checkSlaBreaches, checkFirstResponseBreaches } = require("./sla");
const { checkWarrantyAlerts } = require("./warranty");
const { checkContractReminders } = require("./contractReminders");
const { runDueRecurringTickets } = require("./recurring");
const { sendDueDigests } = require("./digest");
const assetSync = require("./assetSync");

const ASSET_SYNC_INTERVAL_HOURS = parseInt(process.env.ASSET_SYNC_INTERVAL_HOURS, 10) || 24;
// How stale periodic_check_state.last_run_at can get before
// triggerOpportunistically() below fires a fresh run.
const OPPORTUNISTIC_STALE_MINUTES = 15;

// connect-pg-simple's own pruneSessionInterval is off (see src/sessionStore.js) -
// a setInterval has no home in a serverless function that doesn't stay alive
// between requests, so expired-session cleanup happens here instead, on the
// same cadence as everything else in this file.
function pruneExpiredSessions() {
  return new Promise((resolve) => {
    sessionStore.pruneSessions((err) => {
      if (err) console.error("Session prune failed:", err.message);
      resolve();
    });
  });
}

// Every step is awaited independently with its own .catch - one failing
// (a transient connection error, a bad SharePoint response) must never take
// down the whole run or leave the rest un-awaited.
async function runPeriodicChecks() {
  // Claimed immediately, before the actual checks run below, so a burst of
  // concurrent opportunistic triggers landing within the same instant don't
  // all decide the state is stale and all fire this at once - not perfectly
  // race-proof, but every check below is independently idempotent (its own
  // alerted_at/last_run_at guard), so a rare double-fire just means one
  // wasted duplicate pass, never a duplicate email.
  await db.prepare("UPDATE periodic_check_state SET last_run_at = now_text() WHERE id = 1").run();

  await checkSlaBreaches().catch((err) => console.error("SLA breach check failed:", err.message));
  await checkFirstResponseBreaches().catch((err) => console.error("First-response breach check failed:", err.message));
  await checkWarrantyAlerts().catch((err) => console.error("Warranty alert check failed:", err.message));
  await checkContractReminders().catch((err) => console.error("Contract reminder check failed:", err.message));
  await runDueRecurringTickets().catch((err) => console.error("Recurring ticket check failed:", err.message));
  await sendDueDigests().catch((err) => console.error("Daily digest check failed:", err.message));
  await pruneExpiredSessions();
  // A no-op when Microsoft Graph isn't configured, and self-guarded to only
  // actually hit SharePoint once ASSET_SYNC_INTERVAL_HOURS have passed since
  // the last run - unlike the checks above, this one can genuinely fail (a
  // real network call to Graph, not just a local DB query), so it's the one
  // periodic check here that needs an explicit .catch rather than letting a
  // rejection go unhandled.
  const due = await assetSync.isDue(ASSET_SYNC_INTERVAL_HOURS).catch((err) => {
    console.error("Asset sync due-check failed:", err.message);
    return false;
  });
  if (due) {
    await assetSync.runSync().catch((err) => console.error("Asset sync failed:", err.message));
  }
}

// Called from the top of the main dashboard route - fires runPeriodicChecks()
// without blocking the response if it's been more than
// OPPORTUNISTIC_STALE_MINUTES since the last run (whether that was another
// request's opportunistic trigger, the daily Vercel Cron hit, or - locally -
// server.js's own setInterval). During business hours, when agents are
// actually using the dashboard, this reproduces close to the old setInterval's
// ~15-minute cadence for free; the daily cron is just the guaranteed floor for
// nights/weekends when nobody's looking at the app at all.
async function triggerOpportunistically() {
  // Never fire from the test suite: it's unawaited by design (must never
  // block a real dashboard response), which means it can still be mid-run
  // when a later request starts - against test/helpers.js's isolated
  // database, that's a real source of flakiness (competing for the same
  // handful of pool connections, pruning sessions a test is mid-way through
  // using), not just wasted work the way a rare double-fire is in
  // production. See test/helpers.js's NODE_ENV="test".
  if (process.env.NODE_ENV === "test") return;
  try {
    const row = await db.prepare("SELECT last_run_at FROM periodic_check_state WHERE id = 1").get();
    const ageMinutes =
      row && row.last_run_at ? (Date.now() - new Date(`${row.last_run_at.replace(" ", "T")}Z`).getTime()) / 60000 : Infinity;
    if (ageMinutes < OPPORTUNISTIC_STALE_MINUTES) return;
    runPeriodicChecks().catch((err) => console.error("Opportunistic periodic check run failed:", err.message));
  } catch (err) {
    console.error("Could not check periodic-check staleness:", err.message);
  }
}

module.exports = { runPeriodicChecks, triggerOpportunistically };
