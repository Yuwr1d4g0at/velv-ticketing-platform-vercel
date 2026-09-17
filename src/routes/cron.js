// Vercel Cron's entry point (see vercel.json) - Hobby-plan Cron Jobs are
// capped at once/day per job with +-59 min timing precision, which is why
// this is only the guaranteed floor for the periodic checks, not their only
// trigger (see src/periodicChecks.js's triggerOpportunistically, fired from
// real dashboard traffic instead).
const express = require("express");
const { runPeriodicChecks } = require("../periodicChecks");

const router = express.Router();

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
    console.error("Cron periodic-checks run failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
