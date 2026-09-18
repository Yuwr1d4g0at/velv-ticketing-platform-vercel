// Vercel Cron's entry point (see vercel.json) - Hobby-plan Cron Jobs are
// capped at once/day per job with +-59 min timing precision, which is why
// this is only the guaranteed floor for the periodic checks, not their only
// trigger (see src/periodicChecks.js's triggerOpportunistically, fired from
// real dashboard traffic instead).
const express = require("express");
const Sentry = require("@sentry/node");
const db = require("../db");
const mailer = require("../mailer");
const { runPeriodicChecks } = require("../periodicChecks");
const { runBackup } = require("../../scripts/backup");

const router = express.Router();

// Otherwise a cron failure only ever surfaces in Vercel's function logs,
// which nobody checks day to day. Best-effort: if the failure was itself a
// DB outage, fetching admin emails to alert them will also fail - caught
// separately so that doesn't turn into an unhandled rejection on top of the
// original error, which is what the response already reports.
async function alertAdmins(jobName, err) {
  if (!mailer.enabled) return;
  try {
    const admins = await db.prepare("SELECT email FROM agents WHERE active = 1 AND is_admin = 1").all();
    await Promise.all(admins.map((a) => mailer.sendCronFailureAlert({ to: a.email, jobName, error: err.message })));
  } catch (alertErr) {
    console.error(`Failed to send cron failure alert for "${jobName}":`, alertErr.message);
  }
}

// Vercel automatically attaches `Authorization: Bearer $CRON_SECRET` to its
// own request when a CRON_SECRET env var is set - checked here so this
// endpoint can't be triggered by anyone else who finds the URL (it has real
// side effects: sends emails, mutates *_alerted_at columns, prunes sessions).
router.get("/periodic-checks", async (req, res) => {
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  if (!process.env.CRON_SECRET || req.headers.authorization !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await runPeriodicChecks();
    res.json({ ok: true });
  } catch (err) {
    // The real message goes to the console, Sentry, and the admin alert
    // email (alertAdmins above) - not the HTTP response. Same reasoning as
    // /healthz: an unauthenticated-until-CRON_SECRET endpoint returning raw
    // internal error text has no upside, even though the bar to reach it is
    // already high.
    console.error("Cron periodic-checks run failed:", err.message);
    Sentry.captureException(err);
    await alertAdmins("periodic-checks", err);
    res.status(500).json({ ok: false });
  }
});

// Same CRON_SECRET gate as above - see scripts/backup.js for what this
// actually exports (a JSON snapshot of every table + a Blob file manifest,
// written to Blob itself since a Vercel Function has no persistent disk).
router.get("/backup", async (req, res) => {
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  if (!process.env.CRON_SECRET || req.headers.authorization !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await runBackup();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Cron backup run failed:", err.message);
    Sentry.captureException(err);
    await alertAdmins("backup", err);
    res.status(500).json({ ok: false });
  }
});

module.exports = router;
