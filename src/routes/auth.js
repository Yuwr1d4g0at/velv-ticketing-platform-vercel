const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { verifyCsrf } = require("../middleware/csrf");
const msSso = require("../msSso");
const totp = require("../totp");

const router = express.Router();

// A fixed, valid bcrypt hash for a password nobody knows - compared against
// whenever the submitted email doesn't match an active agent, so this route
// takes about the same time either way. Without this, skipping bcrypt
// entirely for "no such user" (near-instant) vs. actually running it for
// "wrong password" (~100ms) lets an attacker enumerate valid agent emails
// purely from response timing, even though both cases show the same error.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("not-a-real-password", 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Please wait a few minutes and try again.",
});

// A 6-digit TOTP code is a much smaller guess space than a password - its
// own tight limiter, rather than sharing loginLimiter's budget (which a
// normal password attempt already spent on the way to this second step).
const twoFactorLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many codes tried. Please wait a few minutes and try again.",
});

router.get("/login", (req, res) => {
  if (req.session.agentId) return res.redirect("/dashboard");
  res.render("auth/login", { title: "Log in", error: null, ssoEnabled: msSso.isEnabled() });
});

// Records every attempt, success or failure - not just what the rate
// limiter blocked in the moment - so a compromised account or a slow
// brute-force run is visible after the fact from /dashboard/settings/login-log.
async function logLoginAttempt(req, { email, agentId = null, success }) {
  await db
    .prepare(`INSERT INTO login_log (email, agent_id, success, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .run(email, agentId, success ? 1 : 0, req.ip, (req.get("user-agent") || "").slice(0, 300));
}

router.post("/login", loginLimiter, verifyCsrf, async (req, res, next) => {
  try {
    const { email = "", password = "" } = req.body;
    const normalizedEmail = email.trim().toLowerCase();
    const agent = await db
      .prepare("SELECT id, name, email, password_hash, totp_enabled FROM agents WHERE email = ? AND active = 1")
      .get(normalizedEmail);

    const genericError = "Incorrect email or password.";
    const passwordMatches = bcrypt.compareSync(password, agent ? agent.password_hash : DUMMY_PASSWORD_HASH);

    if (!agent || !passwordMatches) {
      await logLoginAttempt(req, { email: normalizedEmail, success: false });
      return res.status(401).render("auth/login", { title: "Log in", error: genericError, ssoEnabled: msSso.isEnabled() });
    }

    // 2FA enabled: the password alone isn't a completed login attempt yet -
    // hold off on both logLoginAttempt (it would otherwise show "success" in
    // the login log for someone who has the password but not the device) and
    // req.session.agentId (this session stays unauthenticated) until the code
    // on the next screen checks out too. See POST /login/2fa below, which is
    // the only place either of those actually happens for this agent now.
    if (agent.totp_enabled) {
      req.session.pendingAgentId = agent.id;
      return res.redirect("/login/2fa");
    }

    await logLoginAttempt(req, { email: normalizedEmail, agentId: agent.id, success: true });

    req.session.regenerate((err) => {
      if (err) return res.status(500).render("error", { title: "Error", message: "Could not log in. Please try again." });
      req.session.agentId = agent.id;
      const redirectTo = req.session.redirectTo || "/dashboard";
      delete req.session.redirectTo;
      res.redirect(redirectTo);
    });
  } catch (err) {
    next(err);
  }
});

// The second step of login for an agent with 2FA enabled - reached only via
// a fresh req.session.pendingAgentId set by POST /login above (never a
// direct is-2FA-required check on an arbitrary email, which would let
// someone probe which addresses have 2FA on). Session isn't regenerated
// here yet - that still only happens once, below, the moment the code
// checks out - so a fixed/pre-existing session id never itself becomes an
// authenticated one; it just carries the "waiting on a code" marker.
router.get("/login/2fa", (req, res) => {
  if (!req.session.pendingAgentId) return res.redirect("/login");
  res.render("auth/login-2fa", { title: "Enter your 2FA code", error: null });
});

router.post("/login/2fa", twoFactorLimiter, verifyCsrf, async (req, res, next) => {
  try {
    const pendingId = req.session.pendingAgentId;
    if (!pendingId) return res.redirect("/login");

    const agent = await db
      .prepare("SELECT id, name, email, totp_secret FROM agents WHERE id = ? AND active = 1 AND totp_enabled = 1")
      .get(pendingId);
    if (!agent) {
      // 2FA was disabled (or the account deactivated) between the password
      // step and this one - nothing to verify a code against, so start over.
      delete req.session.pendingAgentId;
      return res.redirect("/login");
    }

    const code = req.body.code || "";
    if (!totp.verifyToken(agent.totp_secret, code)) {
      await logLoginAttempt(req, { email: agent.email, agentId: agent.id, success: false });
      return res.status(401).render("auth/login-2fa", { title: "Enter your 2FA code", error: "Incorrect code. Please try again." });
    }

    await logLoginAttempt(req, { email: agent.email, agentId: agent.id, success: true });
    delete req.session.pendingAgentId;

    req.session.regenerate((err) => {
      if (err) return res.status(500).render("error", { title: "Error", message: "Could not log in. Please try again." });
      req.session.agentId = agent.id;
      const redirectTo = req.session.redirectTo || "/dashboard";
      delete req.session.redirectTo;
      res.redirect(redirectTo);
    });
  } catch (err) {
    next(err);
  }
});

// "Sign in with Microsoft" (see src/msSso.js) - a second door in alongside
// the password form above, off entirely (404) unless MS_TENANT_ID/
// MS_CLIENT_ID/MS_CLIENT_SECRET are configured. Not rate-limited the same
// way POST /login is - Microsoft's own sign-in page is what actually
// prompts for a credential, and handles brute-force protection on that side.
router.get("/auth/microsoft", async (req, res, next) => {
  if (!msSso.isEnabled()) return res.status(404).render("error", { title: "Not found", message: "Not found." });
  try {
    res.redirect(await msSso.buildAuthUrl(req, "agent"));
  } catch (err) {
    next(err);
  }
});

router.get("/auth/microsoft/callback", async (req, res, next) => {
  if (!msSso.isEnabled()) return res.status(404).render("error", { title: "Not found", message: "Not found." });

  let account;
  try {
    account = await msSso.handleCallback(req, "agent");
  } catch (err) {
    // A stray retry, an expired state, or the agent clicking back/refresh
    // on this page - not worth a 500, just send them back to try again.
    await logLoginAttempt(req, { email: "(microsoft sso)", success: false });
    return res
      .status(401)
      .render("auth/login", { title: "Log in", error: "Could not sign in with Microsoft. Please try again.", ssoEnabled: true });
  }

  try {
    // Explicit allow-list, not auto-provisioning: authenticating with
    // Microsoft only ever logs someone in if their email already matches an
    // existing, active agent - it never creates one. Same account-creation
    // path (the Agents page, or `npm run seed`) as password-based agents.
    const agent = await db.prepare("SELECT id, name, email FROM agents WHERE email = ? AND active = 1").get(account.email);

    if (!agent) {
      await logLoginAttempt(req, { email: account.email, success: false });
      return res.status(401).render("auth/login", {
        title: "Log in",
        error: `Signed in as ${account.email} with Microsoft, but that isn't set up as an agent here yet. Ask an existing agent to add you from the Agents page first.`,
        ssoEnabled: true,
      });
    }

    await logLoginAttempt(req, { email: account.email, agentId: agent.id, success: true });

    req.session.regenerate((err) => {
      if (err) return res.status(500).render("error", { title: "Error", message: "Could not log in. Please try again." });
      req.session.agentId = agent.id;
      const redirectTo = req.session.redirectTo || "/dashboard";
      delete req.session.redirectTo;
      res.redirect(redirectTo);
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", verifyCsrf, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

module.exports = router;
