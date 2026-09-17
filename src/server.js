require("dotenv").config();

if (!process.env.SESSION_SECRET) {
  console.error("Missing SESSION_SECRET in the environment. Copy .env.example to .env and set one.");
  process.exit(1);
}

const app = require("./app");
const { checkSlaBreaches, checkFirstResponseBreaches } = require("./sla");
const { checkWarrantyAlerts } = require("./warranty");
const { checkContractReminders } = require("./contractReminders");
const { runDueRecurringTickets } = require("./recurring");
const { sendDueDigests } = require("./digest");
const assetSync = require("./assetSync");
const PORT = process.env.PORT || 3000;
const SLA_CHECK_INTERVAL_MINUTES = parseInt(process.env.SLA_CHECK_INTERVAL_MINUTES, 10) || 15;
const ASSET_SYNC_INTERVAL_HOURS = parseInt(process.env.ASSET_SYNC_INTERVAL_HOURS, 10) || 24;

app.listen(PORT, () => {
  console.log(`Velv Ticketing Platform listening on http://localhost:${PORT}`);
});

// Runs in-process rather than as a separate cron job (like scripts/backup.js)
// since SLA checks need to run every few minutes, not daily - simplest to
// just keep the same long-lived process ticking. Warranty checks, recurring
// tickets, and the daily digest don't need that frequency, but piggybacking
// on the same interval is cheap and avoids extra timers for no real benefit -
// each of those three is internally guarded to actually act at most once
// whenever its own real-world cadence (a date, a day) says to. All run once
// at startup, then on the interval.
//
// Every step below is awaited independently with its own .catch - each of
// these DB checks became async in the Postgres port (see src/db/index.js),
// and one failing (e.g. a transient connection error) must never take down
// the whole periodic run or leave the rest un-awaited.
async function runPeriodicChecks() {
  await checkSlaBreaches().catch((err) => console.error("SLA breach check failed:", err.message));
  await checkFirstResponseBreaches().catch((err) => console.error("First-response breach check failed:", err.message));
  await checkWarrantyAlerts().catch((err) => console.error("Warranty alert check failed:", err.message));
  await checkContractReminders().catch((err) => console.error("Contract reminder check failed:", err.message));
  await runDueRecurringTickets().catch((err) => console.error("Recurring ticket check failed:", err.message));
  await sendDueDigests().catch((err) => console.error("Daily digest check failed:", err.message));
  // A no-op when Microsoft Graph isn't configured, and self-guarded to
  // only actually hit SharePoint once ASSET_SYNC_INTERVAL_HOURS have
  // passed since the last run - unlike the checks above, this one can
  // genuinely fail (a real network call to Graph, not just a local DB
  // query), so it's the one periodic check here that needs an explicit
  // .catch rather than letting a rejection go unhandled.
  const due = await assetSync.isDue(ASSET_SYNC_INTERVAL_HOURS).catch((err) => {
    console.error("Asset sync due-check failed:", err.message);
    return false;
  });
  if (due) {
    await assetSync.runSync().catch((err) => console.error("Asset sync failed:", err.message));
  }
}
runPeriodicChecks();
setInterval(runPeriodicChecks, SLA_CHECK_INTERVAL_MINUTES * 60 * 1000);
