function requireAgent(req, res, next) {
  if (req.session && req.session.agentId) {
    return next();
  }
  req.session.redirectTo = req.originalUrl;
  return res.redirect("/login");
}

// Gates agent management (creating agents, changing department/admin/active
// status) behind is_admin. Without this, any logged-in agent could grant
// themselves or anyone else admin - a much bigger deal now that is_admin
// bypasses department scoping everywhere. Must run after attachAgent, which
// sets res.locals.currentAgent.
function requireAdmin(req, res, next) {
  if (res.locals.currentAgent && res.locals.currentAgent.is_admin) {
    return next();
  }
  return res.status(403).render("error", {
    title: "Admins only",
    message: "You need admin access to manage agents.",
  });
}

// Makes the logged-in agent (if any) available to every view as `currentAgent`.
// Re-checks `active` on every request (not just at login) - deactivating an
// agent should end their existing session immediately, not just block their
// next login attempt. Includes department_id/is_admin/department_name -
// department scoping (src/departments.js) reads currentAgent directly
// rather than re-querying the agent on every route, so this is the one
// place that has to keep them current. totp_enabled is here too so the
// header/settings views can show current 2FA status without a second query.
function attachAgent(db) {
  return async (req, res, next) => {
    try {
      if (req.session && req.session.agentId) {
        const agent = await db
          .prepare(
            `SELECT agents.id, agents.name, agents.email, agents.department_id, agents.is_admin,
                    agents.totp_enabled, departments.name AS department_name
             FROM agents
             LEFT JOIN departments ON departments.id = agents.department_id
             WHERE agents.id = ? AND agents.active = 1`
          )
          .get(req.session.agentId);
        res.locals.currentAgent = agent || null;
        if (!agent) {
          req.session.agentId = null;
        }
      } else {
        res.locals.currentAgent = null;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAgent, requireAdmin, attachAgent };
