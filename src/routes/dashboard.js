const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAgent, requireAdmin } = require("../middleware/auth");
const { verifyCsrf } = require("../middleware/csrf");
const { PRIORITIES, STATUSES, ASSET_CATEGORIES, ASSET_STATUSES, PAGE_SIZE } = require("../constants");
const departments = require("../departments");
const {
  isAgingTicket,
  annotateAging,
  currentThresholds,
  currentFirstResponseThresholds,
  businessHoursElapsed,
  BUSINESS_HOURS_PER_DAY,
  FALLBACK_DAYS,
} = require("../aging");
const { sendStatusChangeEmail, sendResolvedEmail, sendReplyEmail, sendTicketCreatedEmail, sendMentionEmail } = require("../mailer");
const { findMentionedAgents } = require("../mentions");
const { toCsv } = require("../csv");
const { addTagToTicket, removeTagFromTicket, tagsForTicket, allTags } = require("../tags");
const canned = require("../canned-responses");
const assets = require("../assets");
const { exportRequesterData, eraseRequesterData } = require("../privacy");
const { WEBHOOK_EVENTS, generateSecret, triggerWebhooks } = require("../webhooks");
const { WARRANTY_ALERT_DAYS } = require("../warranty");
const kb = require("../kb");
const recurring = require("../recurring");
const automation = require("../automation");
const checklists = require("../checklists");
const notifications = require("../notifications");
const customFields = require("../custom-fields");
const timeEntries = require("../time-entries");
const holidays = require("../holidays");
const directory = require("../directory");
const assetSync = require("../assetSync");
const msGraph = require("../msGraph");
const totp = require("../totp");
const {
  SAFE_PREVIEW_TYPES,
  handleUpload,
  saveAttachments,
  deleteUploadedFiles,
  attachmentsForTicket,
  getAttachment,
  streamAttachment,
  formatSize,
  LIMITS_HINT,
} = require("../attachments");

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.use(requireAgent);

// Makes the notification bell's contents available to the header partial on
// every dashboard page, not just a dedicated notifications route.
router.use(async (req, res, next) => {
  try {
    res.locals.notifUnreadCount = await notifications.unreadCount(req.session.agentId);
    res.locals.notifRecent = await notifications.recentFor(req.session.agentId);
    next();
  } catch (err) {
    next(err);
  }
});

// Called by public/js/notifications-bell.js the moment the bell dropdown is
// opened - marks everything read at once rather than needing a per-item
// click, since the dropdown already shows the most recent ones regardless
// of read state (see notifications.recentFor).
router.post("/notifications/mark-all-read", verifyCsrf, async (req, res, next) => {
  try {
    await notifications.markAllRead(req.session.agentId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Every route that operates on one ticket by id goes through this - the
// single choke point for department (and confidential-flag) visibility on
// the detail page, print view, merge/link, attachments, privacy export/
// erasure, asset link, watch/unwatch, tags, time entries, notes, and
// status/priority/assign. A ticket outside the requesting agent's
// department (and not visible via is_admin) 404s exactly like a ticket that
// doesn't exist at all - never a distinguishable "forbidden", which would
// leak that a given ticket id is real.
//
// departments.canSeeTicket is now async (Postgres port) - awaited here
// explicitly rather than left to chance, since `!somePromise` is always
// false and would otherwise silently defeat this whole access-control gate.
async function getTicketOr404(req, res, id) {
  const ticket = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
  if (!ticket || !(await departments.canSeeTicket(res.locals.currentAgent, ticket))) {
    res.status(404).render("error", { title: "Not found", message: "That ticket does not exist." });
    return null;
  }
  return ticket;
}

// The categories a given agent is allowed to work with - every one of them
// for an admin, only their own department's for anyone else. Backs the
// category dropdown (and validation) on agent-initiated ticket creation:
// an agent files tickets for their own department, same as everything else
// they can see and act on.
async function categoryNamesForAgent(agent) {
  if (agent && agent.is_admin) return departments.categoryNames();
  return (await departments.categoriesAll())
    .filter((c) => c.department_id === (agent && agent.department_id))
    .map((c) => c.name);
}

// Active agents eligible to be assigned a ticket filed under `categoryName`
// - that category's own department's agents, plus every admin (who can be
// assigned anything). Backs both the assignment <select> shown in the UI
// and, indirectly, the applyAssignment() eligibility check below (which
// re-derives this server-side rather than trusting the submitted id came
// from this same list).
async function eligibleAgentsForCategory(categoryName) {
  const deptId = await departments.departmentIdForCategory(categoryName);
  return db
    .prepare("SELECT id, name FROM agents WHERE active = 1 AND (is_admin = 1 OR department_id = ?) ORDER BY name")
    .all(deptId);
}

// Ticket templates whose category the agent is actually allowed to file a
// ticket under - same categoryNamesForAgent() restriction as the new-ticket
// form's own category select.
async function templatesForAgent(agent) {
  const names = await categoryNamesForAgent(agent);
  if (!names.length) return [];
  const placeholders = names.map(() => "?").join(", ");
  return db.prepare(`SELECT id, name FROM ticket_templates WHERE category IN (${placeholders}) ORDER BY name`).all(...names);
}

// A flat, cross-category suggestion list for the subcategory field's
// datalist - same helper as in public.js, duplicated rather than shared
// since it's a one-line query (matches how EMAIL_RE is handled the same way
// across both route files).
async function subcategorySuggestions() {
  return (
    await db
      .prepare("SELECT DISTINCT subcategory FROM tickets WHERE subcategory IS NOT NULL AND subcategory != '' ORDER BY subcategory LIMIT 100")
      .all()
  ).map((r) => r.subcategory);
}

// Other still-open tickets whose subject shares words with this one - shown
// as a "Possible duplicates" card on the ticket detail page, with a
// one-click way into the existing merge flow. Deliberately scoped to
// Open/In Progress tickets only (merging into something already Resolved/
// Closed isn't the useful case this is for) and excludes anything already
// merged away.
// Shared by the dashboard home stat tiles and /reports, so the two can
// never quietly show different numbers for the same thing.
//
// julianday(a) - julianday(b) (SQLite) has no Postgres equivalent function -
// rewritten as EXTRACT(EPOCH FROM (a::timestamp - b::timestamp)) / 86400,
// the number of days between two timestamps, matching julianday's own unit.
async function ticketTimingStats(agent) {
  const vis = departments.ticketVisibilitySql(agent);

  // Average time from creation to Resolved, for tickets currently sitting in
  // Resolved or Closed - derived from ticket_activity rather than a stored
  // column, since "when did this last become Resolved" is exactly what the
  // most recent matching status_change row already records. A ticket
  // resolved, reopened, and left open again drops out (no current-Resolved
  // timestamp to measure to), which is the right call for "how long does it
  // take us to actually finish something."
  const resolutionTime = await db
    .prepare(
      `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at.happened::timestamp - tickets.created_at::timestamp)) / 86400) AS avg_days, COUNT(*) AS count
       FROM tickets
       JOIN (
         SELECT ticket_id, MAX(created_at) AS happened
         FROM ticket_activity
         WHERE type = 'status_change' AND body LIKE '%to "Resolved".'
         GROUP BY ticket_id
       ) resolved_at ON resolved_at.ticket_id = tickets.id
       WHERE tickets.status IN ('Resolved', 'Closed')${vis.sql}`
    )
    .get(...vis.params);

  // Time to first response: the first agent-authored activity of any kind
  // (a note, a reply, a status/priority change, a reassignment) on a
  // ticket - not just its first public reply. The auto-assignment-on-
  // creation row has agent_id NULL, so it's already excluded without a
  // special case. Unlike resolution time, this isn't restricted to
  // currently-Resolved/Closed tickets - a ticket that's still open can
  // still have a measured first response.
  const firstResponseTime = await db
    .prepare(
      `SELECT AVG(EXTRACT(EPOCH FROM (first_response.happened::timestamp - tickets.created_at::timestamp)) / 86400) AS avg_days, COUNT(*) AS count
       FROM tickets
       JOIN (
         SELECT ticket_id, MIN(created_at) AS happened
         FROM ticket_activity
         WHERE agent_id IS NOT NULL
         GROUP BY ticket_id
       ) first_response ON first_response.ticket_id = tickets.id
       WHERE 1 = 1${vis.sql}`
    )
    .get(...vis.params);

  return { resolutionTime, firstResponseTime };
}

// Duplicate detection used to run against SQLite FTS5 (tickets_fts,
// bm25() ranking) - Postgres full-text search (tsvector/ts_rank) is Phase 4
// work, not bundled into this async-adapter pass. For now this falls back
// to a plain LIKE-per-token OR scan, still ranked by number of matching
// tokens (a cruder proxy for relevance than bm25, but keeps the feature
// working rather than removing it until Phase 4 lands).
async function findPossibleDuplicates(agent, ticket) {
  const tokens = (ticket.subject.match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 3);
  if (!tokens.length) return [];
  const vis = departments.ticketVisibilitySql(agent);
  const likeClauses = tokens.map(() => "tickets.subject ILIKE ?").join(" OR ");
  const likeParams = tokens.map((t) => `%${t}%`);
  const rankExpr = tokens.map(() => "(CASE WHEN tickets.subject ILIKE ? THEN 1 ELSE 0 END)").join(" + ");
  return db
    .prepare(
      `SELECT tickets.id, tickets.subject, tickets.status, tickets.created_at
       FROM tickets
       WHERE (${likeClauses}) AND tickets.id != ? AND tickets.merged_into_id IS NULL
         AND tickets.status IN ('Open', 'In Progress')${vis.sql}
       ORDER BY (${rankExpr}) DESC
       LIMIT 3`
    )
    .all(...likeParams, ticket.id, ...vis.params, ...likeParams);
}

// Shared by the ticket list, its pagination count, and the CSV export, so the
// three can never quietly drift apart on what "matching these filters" means.
// Always includes the acting agent's department (+ confidential-flag)
// visibility restriction (departments.ticketVisibilitySql) - there is no
// filter combination, including an empty one, that bypasses it.
//
// Free-text search (`q`) used SQLite FTS5 (buildFtsQuery/tickets_fts) -
// Postgres full-text search is Phase 4 work, not bundled into this
// async-adapter pass. Falls back to a plain (I)LIKE-both-sides search
// against subject/description in the meantime, still fine for this app's
// scale.
async function buildTicketFilter(query, agent) {
  const { status = "", priority = "", category = "", assigned = "", tag = "", q = "" } = query;
  const vis = departments.ticketVisibilitySql(agent);
  let where = " WHERE 1 = 1" + vis.sql;
  const params = [...vis.params];

  if (STATUSES.includes(status)) {
    where += " AND tickets.status = ?";
    params.push(status);
  }
  if (PRIORITIES.includes(priority)) {
    where += " AND tickets.priority = ?";
    params.push(priority);
  }
  if (await departments.isValidCategoryName(category)) {
    where += " AND tickets.category = ?";
    params.push(category);
  }
  if (assigned === "unassigned") {
    where += " AND tickets.assigned_to IS NULL";
  } else if (assigned === "me") {
    where += " AND tickets.assigned_to = ?";
    params.push(agent.id);
  }
  if (tag.trim()) {
    where += ` AND EXISTS (
      SELECT 1 FROM ticket_tags JOIN tags ON tags.id = ticket_tags.tag_id
      WHERE ticket_tags.ticket_id = tickets.id AND LOWER(tags.name) = LOWER(?)
    )`;
    params.push(tag.trim());
  }
  if (q.trim()) {
    const like = `%${q.trim()}%`;
    where += " AND (tickets.subject ILIKE ? OR tickets.description ILIKE ? OR tickets.requester_name ILIKE ? OR tickets.requester_email ILIKE ?)";
    params.push(like, like, like, like);
  }

  return { where, params, filters: { status, priority, category, assigned, tag, q } };
}

// Active agents to offer in an assignment <select> that isn't already tied
// to one specific ticket/category (the bulk-action bar on the ticket list,
// which can have a mixed selection) - the acting agent's own department
// plus every admin for a regular agent, every active agent for an admin
// (who could be looking at a cross-department list). Per-ticket eligibility
// (departments.isEligibleAssignee) is still enforced when the action is
// actually applied, so this is about what's sensible to show, not the only
// enforcement.
async function agentsForBulkAssign(agent) {
  if (agent && agent.is_admin) return db.prepare("SELECT id, name FROM agents WHERE active = 1 ORDER BY name").all();
  return db
    .prepare("SELECT id, name FROM agents WHERE active = 1 AND (is_admin = 1 OR department_id = ?) ORDER BY name")
    .all(agent && agent.department_id);
}

router.get("/", async (req, res, next) => {
  try {
    const agent = res.locals.currentAgent;
    const { where, params, filters } = await buildTicketFilter(req.query, agent);

    const totalCount = Number((await db.prepare(`SELECT COUNT(*) AS count FROM tickets${where}`).get(...params)).count);
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), totalPages);
    const offset = (page - 1) * PAGE_SIZE;

    const sql = `
      SELECT tickets.*, agents.name AS assigned_name
      FROM tickets
      LEFT JOIN agents ON agents.id = tickets.assigned_to
      ${where}
      ORDER BY
        CASE tickets.status WHEN 'Open' THEN 0 WHEN 'In Progress' THEN 1 WHEN 'Waiting on Customer' THEN 2 WHEN 'Resolved' THEN 3 ELSE 4 END,
        CASE tickets.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,
        tickets.created_at DESC
      LIMIT ? OFFSET ?
    `;
    // is_aging can no longer be a SQL predicate (business-hours math isn't
    // expressible in plain SQL - see src/aging.js) - annotated on the
    // already-paginated page of rows instead, not the whole table.
    const tickets = await annotateAging(await db.prepare(sql).all(...params, PAGE_SIZE, offset));

    // Both stat tiles below are scoped the same way as the ticket list itself
    // (departments.ticketVisibilitySql) - an agent's own dashboard should never
    // hint at another department's volume or satisfaction numbers.
    const vis = departments.ticketVisibilitySql(agent);
    const countRows = await db.prepare(`SELECT status, COUNT(*) AS count FROM tickets WHERE 1 = 1${vis.sql} GROUP BY status`).all(...vis.params);
    const counts = countRows.reduce((acc, row) => ({ ...acc, [row.status]: Number(row.count) }), {});

    const satisfactionRow = await db
      .prepare(
        `SELECT AVG(ticket_ratings.rating) AS avg_rating, COUNT(*) AS count
         FROM ticket_ratings JOIN tickets ON tickets.id = ticket_ratings.ticket_id
         WHERE 1 = 1${vis.sql}`
      )
      .get(...vis.params);
    const satisfaction = {
      avg_rating: satisfactionRow.avg_rating == null ? null : Number(satisfactionRow.avg_rating),
      count: Number(satisfactionRow.count),
    };

    const { resolutionTime, firstResponseTime } = await ticketTimingStats(agent);

    const exportQuery = new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString();

    const rawReportRange = resolveReportRange(req.query);
    const reportUnit = reportBucketUnit(rawReportRange.from, rawReportRange.to);
    const reportRange = { ...rawReportRange, unit: reportUnit, label: reportRangeLabel(rawReportRange) };

    res.render("dashboard/home", {
      title: "Dashboard",
      wide: true,
      tickets,
      counts,
      satisfaction,
      resolutionTime,
      firstResponseTime,
      statuses: STATUSES,
      priorities: PRIORITIES,
      categories: await categoryNamesForAgent(agent),
      allTags: await allTags(),
      agents: await agentsForBulkAssign(agent),
      filters,
      page,
      totalPages,
      totalCount,
      exportQuery,
      savedViews: await db.prepare("SELECT * FROM saved_views WHERE agent_id = ? ORDER BY created_at DESC").all(req.session.agentId),
      reportRange,
      ...(await buildReportsData(rawReportRange, reportUnit, agent)),
    });
  } catch (err) {
    next(err);
  }
});

// A saved view is just the current filter combo (not the page number - that
// wouldn't make sense to replay) under a name, scoped to whoever saved it.
router.post("/views", verifyCsrf, async (req, res, next) => {
  try {
    const name = (req.body.name || "").trim().slice(0, 100);
    const queryString = (req.body.query_string || "").slice(0, 1000);
    if (name) {
      await db.prepare("INSERT INTO saved_views (agent_id, name, query_string) VALUES (?, ?, ?)").run(req.session.agentId, name, queryString);
    }
    res.redirect(queryString ? `/dashboard?${queryString}` : "/dashboard");
  } catch (err) {
    next(err);
  }
});

// Scoped to the requesting agent - unlike tickets/assets, a saved view is a
// personal convenience, not a shared team resource, so one agent shouldn't
// be able to delete another's.
router.post("/views/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await db.prepare("DELETE FROM saved_views WHERE id = ? AND agent_id = ?").run(req.params.id, req.session.agentId);
    res.redirect("/dashboard");
  } catch (err) {
    next(err);
  }
});

router.get("/export.csv", async (req, res, next) => {
  try {
    const { where, params } = await buildTicketFilter(req.query, res.locals.currentAgent);

    const tickets = await db
      .prepare(
        `SELECT tickets.*, agents.name AS assigned_name
         FROM tickets
         LEFT JOIN agents ON agents.id = tickets.assigned_to
         ${where}
         ORDER BY tickets.created_at DESC`
      )
      .all(...params);

    const csv = toCsv(tickets, [
      { key: "id", header: "ID" },
      { key: "subject", header: "Subject" },
      { key: "requester_name", header: "Requester name" },
      { key: "requester_email", header: "Requester email" },
      { key: "category", header: "Category" },
      { key: "subcategory", header: "Subcategory" },
      { key: "priority", header: "Priority" },
      { key: "status", header: "Status" },
      { key: "assigned_name", header: "Assigned to" },
      { key: "created_at", header: "Created" },
      { key: "updated_at", header: "Updated" },
    ]);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tickets-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// Agent-initiated creation - for a phone call or a walk-in, where the
// requester isn't the one filling out the public form. Defined before
// /tickets/:id so Express doesn't match "new" as an :id first. Unlike the
// public form, priority can be set immediately and the agent can assign it
// (or leave it unassigned) rather than always going through round-robin.
router.get("/tickets/new", async (req, res, next) => {
  try {
    // ?template=<id> pre-fills category/subject/description from a saved
    // template (see /dashboard/templates) - a real navigation with a query
    // param, not a client-side field-sync script, since it's three fields at
    // once and a GET link is simpler and more robust than keeping three
    // separate inputs in sync via JS.
    let values = {};
    // Checklist items on this template that spawn their own ticket elsewhere
    // (see src/checklists.js) - shown as an upfront "this will also create..."
    // hint, and carried through as values.template_id so the POST below knows
    // which template's checklist to apply once the ticket is actually created.
    let spawnPreview = [];
    if (req.query.template) {
      const template = await db.prepare("SELECT * FROM ticket_templates WHERE id = ?").get(req.query.template);
      if (template) {
        values = { category: template.category, subject: template.subject, description: template.description, template_id: template.id };
        spawnPreview = (await checklists.itemsForTemplate(template.id)).filter((i) => i.spawn_category);
      }
    }
    const agent = res.locals.currentAgent;
    res.render("dashboard/new-ticket", {
      title: "New ticket",
      categories: await categoryNamesForAgent(agent),
      priorities: PRIORITIES,
      assets: await assets.assignable(),
      agents: await agentsForBulkAssign(agent),
      templates: await templatesForAgent(agent),
      customFieldsByCategory: await customFields.byCategory(),
      subcategorySuggestions: await subcategorySuggestions(),
      errors: [],
      values,
      spawnPreview,
      uploadHint: LIMITS_HINT,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/new", handleUpload("attachments"), verifyCsrf, async (req, res, next) => {
  try {
    const agent = res.locals.currentAgent;
    const {
      requester_name = "",
      requester_email = "",
      category = "",
      subcategory = "",
      subject = "",
      description = "",
      priority = "Medium",
      asset_id = "",
      assigned_to = "",
      template_id = "",
    } = req.body;

    const values = { requester_name, requester_email, category, subcategory, subject, description, priority, asset_id, assigned_to };
    const errors = [];
    const rerender = async () => {
      deleteUploadedFiles(req.files);
      return res.status(400).render("dashboard/new-ticket", {
        title: "New ticket",
        categories: await categoryNamesForAgent(agent),
        priorities: PRIORITIES,
        assets: await assets.assignable(),
        agents: await agentsForBulkAssign(agent),
        templates: await templatesForAgent(agent),
        customFieldsByCategory: await customFields.byCategory(),
        subcategorySuggestions: await subcategorySuggestions(),
        errors,
        values,
        spawnPreview: [],
        uploadHint: LIMITS_HINT,
      });
    };

    if (!requester_name.trim()) errors.push("The requester's name is required.");
    if (!requester_email.trim() || !EMAIL_RE.test(requester_email.trim())) errors.push("A valid requester email is required.");
    // An agent can only file a ticket under their own department's categories
    // (an admin can use any) - same "only your own department" rule as
    // everything else this agent can see/act on.
    if (!(await categoryNamesForAgent(agent)).includes(category)) errors.push("Please choose a valid category.");
    if (!PRIORITIES.includes(priority)) errors.push("Please choose a valid priority.");
    if (!subject.trim()) errors.push("A subject is required.");
    if (!description.trim()) errors.push("A description is required.");
    const assetId = asset_id ? parseInt(asset_id, 10) : null;
    if (assetId && !(await assets.get(assetId))) errors.push("Please choose a valid asset.");
    const assignedTo = assigned_to ? parseInt(assigned_to, 10) : null;
    if (assignedTo) {
      const assignee = await db.prepare("SELECT id, department_id, is_admin FROM agents WHERE id = ? AND active = 1").get(assignedTo);
      if (!assignee || !(await departments.isEligibleAssignee(assignee, category))) {
        errors.push("Please choose a valid, active agent in this ticket's department.");
      }
    }
    if (req.uploadError) errors.push(req.uploadError);
    if (errors.length) return await rerender();

    const result = await db
      .prepare(
        `INSERT INTO tickets (subject, description, category, subcategory, priority, requester_name, requester_email, assigned_to, asset_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        subject.trim(),
        description.trim(),
        category,
        subcategory.trim().slice(0, 100) || null,
        priority,
        requester_name.trim(),
        requester_email.trim().toLowerCase(),
        assignedTo,
        assetId
      );

    const creatingAgent = await db.prepare("SELECT name FROM agents WHERE id = ?").get(req.session.agentId);
    await db
      .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`)
      .run(result.lastInsertRowid, req.session.agentId, `Created by ${creatingAgent.name} on behalf of ${requester_name.trim()}.`);
    await customFields.saveSubmittedCustomFields(result.lastInsertRowid, category, req.body);
    if (assignedTo) {
      const label = (await db.prepare("SELECT name FROM agents WHERE id = ?").get(assignedTo)).name;
      await db
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'assignment', ?)`)
        .run(result.lastInsertRowid, req.session.agentId, `Assigned to ${label}.`);
    }
    if (req.files && req.files.length) {
      await saveAttachments({ ticketId: result.lastInsertRowid, files: req.files, uploadedBy: "agent", agentId: req.session.agentId });
    }

    // Onboarding-checklist spawns (see src/checklists.js) - only when this
    // ticket was actually created FROM that exact template, for that
    // template's own category (not just any request that happens to carry a
    // template_id field): template_id round-trips through the new-ticket
    // form as a hidden input set only by the ?template= prefill, and
    // category was already validated above against categoryNamesForAgent(),
    // so tying the spawn to "template.category === the category just used"
    // means this can't be used to wire up spawns the agent didn't actually
    // ask for by picking that template.
    const templateId = template_id ? parseInt(template_id, 10) : null;
    if (templateId) {
      const template = await db.prepare("SELECT * FROM ticket_templates WHERE id = ?").get(templateId);
      if (template && template.category === category) {
        await checklists.applyTemplateSpawns({
          templateId,
          originTicket: {
            id: result.lastInsertRowid,
            subject: subject.trim(),
            requester_name: requester_name.trim(),
            requester_email: requester_email.trim().toLowerCase(),
          },
          agentId: req.session.agentId,
        });
      }
    }

    sendTicketCreatedEmail({
      to: requester_email.trim().toLowerCase(),
      ticketId: result.lastInsertRowid,
      subject: subject.trim(),
    }).catch((err) => console.error("Could not send ticket-created email:", err.message));
    await triggerWebhooks(
      "ticket.created",
      {
        ticket_id: result.lastInsertRowid,
        subject: subject.trim(),
        category,
        requester_email: requester_email.trim().toLowerCase(),
      },
      await departments.departmentIdForCategory(category)
    );

    res.redirect(`/dashboard/tickets/${result.lastInsertRowid}`);
  } catch (err) {
    next(err);
  }
});

router.get("/tickets/:id", async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    // A merged-away ticket has nothing left to show on its own page - all of
    // its activity/attachments/tags moved to the target when it was merged
    // (see /tickets/:id/merge below). Land the agent on the actually-active
    // ticket instead of a dead end, with a one-time banner naming where they
    // came from.
    if (ticket.merged_into_id) {
      return res.redirect(`/dashboard/tickets/${ticket.merged_into_id}?merged_from=${ticket.id}`);
    }

    // LEFT JOIN, not JOIN: a 'requester_reply' row has no agent_id at all (the
    // requester isn't an agent), and an INNER JOIN would silently drop those
    // rows from the feed entirely instead of just showing no agent name.
    const activity = await db
      .prepare(
        `SELECT ticket_activity.*, agents.name AS agent_name
         FROM ticket_activity
         LEFT JOIN agents ON agents.id = ticket_activity.agent_id
         WHERE ticket_id = ?
         ORDER BY created_at ASC`
      )
      .all(ticket.id);

    // Agents eligible for this ticket's department (see
    // departments.isEligibleAssignee), plus whoever it's currently assigned to
    // even if they've since been deactivated or moved departments - otherwise
    // the dropdown would silently reassign the ticket the moment anyone loads
    // this page and re-submits the form without touching the select.
    const agents = await db
      .prepare(
        `SELECT id, name FROM agents
         WHERE (active = 1 AND (is_admin = 1 OR department_id = ?)) OR id = ?
         ORDER BY name`
      )
      .all(await departments.departmentIdForCategory(ticket.category), ticket.assigned_to);
    const attachments = (await attachmentsForTicket(ticket.id)).map((a) => ({
      ...a,
      size_label: formatSize(a.size_bytes),
      is_previewable: SAFE_PREVIEW_TYPES.has(a.mime_type),
    }));
    const rating = await db.prepare("SELECT rating, comment FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id);
    // Skipped once this ticket's own data has been erased - its requester_email
    // is now the same shared redaction placeholder every erased ticket gets,
    // so matching on it would incorrectly group unrelated erased requesters
    // together under "from this requester".
    const otherTickets = ticket.data_erased_at
      ? []
      : await db
          .prepare(
            `SELECT id, subject, status, created_at FROM tickets
             WHERE requester_email = ? AND id != ?
             ORDER BY created_at DESC`
          )
          .all(ticket.requester_email, ticket.id);

    const linkedTickets = await db
      .prepare(
        `SELECT tickets.id, tickets.subject, tickets.status FROM ticket_links
         JOIN tickets ON tickets.id = ticket_links.linked_ticket_id
         WHERE ticket_links.ticket_id = ?
         ORDER BY tickets.created_at DESC`
      )
      .all(ticket.id);

    // Skipped once this ticket's data has been erased (GDPR) - the stored
    // requester_email is the shared redaction placeholder by then, not a
    // real address, and looking it up would defeat the point of erasing it
    // in the first place.
    const requesterProfile = ticket.data_erased_at ? null : await directory.getProfile(ticket.requester_email);

    const departmentIdForTicket = await departments.departmentIdForCategory(ticket.category);

    res.render("dashboard/ticket", {
      title: `Ticket #${ticket.id}`,
      ticket,
      activity,
      agents,
      attachments,
      aging: await isAgingTicket(ticket),
      tags: await tagsForTicket(ticket.id),
      allTags: await allTags(),
      cannedResponses: await canned.forAgent(res.locals.currentAgent),
      departmentName: (await departments.get(departmentIdForTicket))?.name || null,
      // Only actually rendered for an admin (see the "Transfer to another
      // department" card in views/dashboard/ticket.ejs), but cheap enough to
      // just always compute here rather than branch on is_admin twice.
      categoriesByDepartment: await departments.categoriesByDepartment(),
      rating,
      otherTickets,
      linkedTickets,
      asset: ticket.asset_id ? await assets.get(ticket.asset_id) : null,
      assignableAssets: await assets.assignable(),
      statuses: STATUSES,
      priorities: PRIORITIES,
      requiresApproval: await departments.categoryRequiresApproval(ticket.category),
      uploadHint: LIMITS_HINT,
      noteError: null,
      mergedFrom: req.query.merged_from ? parseInt(req.query.merged_from, 10) : null,
      possibleDuplicates: ["Open", "In Progress"].includes(ticket.status) ? await findPossibleDuplicates(res.locals.currentAgent, ticket) : [],
      kbArticles: (await kb.publishedList()).map((a) => ({ ...a, url: `${req.protocol}://${req.get("host")}/kb/${a.slug}` })),
      customFieldValues: await customFields.valuesForTicket(ticket.id),
      timeEntries: await timeEntries.forTicket(ticket.id),
      totalTimeMinutes: await timeEntries.totalMinutesForTicket(ticket.id),
      formatMinutes: timeEntries.formatMinutes,
      todayDate: timeEntries.today(),
      watchers: await db
        .prepare(
          `SELECT agents.id, agents.name FROM ticket_watchers
           JOIN agents ON agents.id = ticket_watchers.agent_id
           WHERE ticket_watchers.ticket_id = ? ORDER BY agents.name`
        )
        .all(ticket.id),
      isWatching: Boolean(
        await db.prepare("SELECT 1 FROM ticket_watchers WHERE ticket_id = ? AND agent_id = ?").get(ticket.id, req.session.agentId)
      ),
      requesterProfile,
    });
  } catch (err) {
    next(err);
  }
});

// A small avatar for any tenant email (agent or requester), backed by
// src/directory.js's cache - not tied to any one ticket/agent id, since
// the same person's photo can show up in more than one place on a page
// (e.g. an agent's own name in the header, a requester's name on a
// ticket). 404s (not a real error page - a broken <img> just shows
// nothing) whenever there's no photo to show, same as attachment previews
// elsewhere quietly no-op instead of erroring.
router.get("/directory/photo", async (req, res, next) => {
  try {
    const email = (req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(404).end();
    const photo = await directory.getPhoto(email);
    if (!photo) return res.status(404).end();
    res.setHeader("Content-Type", photo.contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(photo.buffer);
  } catch (err) {
    next(err);
  }
});

// Moves all activity/attachments/tags onto the target ticket, closes this
// one, and points it at the target via merged_into_id - see the redirect at
// the top of GET /tickets/:id above for what happens when anyone visits a
// merged ticket's own URL afterward. All-or-nothing in one transaction.
// A print-friendly view of one ticket (details + full activity feed) - the
// "PDF export" is just the browser's own Print / Save as PDF on this page,
// rather than a rendering dependency in the app itself.
router.get("/tickets/:id/print", async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const activity = await db
      .prepare(
        `SELECT ticket_activity.*, agents.name AS agent_name
         FROM ticket_activity
         LEFT JOIN agents ON agents.id = ticket_activity.agent_id
         WHERE ticket_id = ?
         ORDER BY created_at ASC`
      )
      .all(ticket.id);

    res.render("dashboard/ticket-print", {
      title: `Ticket #${ticket.id}`,
      ticket,
      activity,
      asset: ticket.asset_id ? await assets.get(ticket.asset_id) : null,
    });
  } catch (err) {
    next(err);
  }
});

// The requester-visible half of a ticket's conversation - same query as
// public.js's own conversationForTicket, kept as a small local copy here
// rather than exported/shared: it's an 8-line query filtered to the two
// requester-facing activity types ('reply' and 'requester_reply'), not
// worth a cross-module dependency between the public and dashboard routers
// for. Used only by the view-as-requester preview below.
async function conversationForTicket(ticketId) {
  return db
    .prepare(
      `SELECT ticket_activity.*, agents.name AS agent_name
       FROM ticket_activity
       LEFT JOIN agents ON agents.id = ticket_activity.agent_id
       WHERE ticket_id = ? AND type IN ('reply', 'requester_reply')
       ORDER BY created_at ASC`
    )
    .all(ticketId);
}

// Admin-only, read-only preview of exactly what this ticket's requester
// currently sees on the public status-check page (views/public/status-
// check.ejs) - for debugging what a requester actually experiences, without
// a real impersonated requester session/login. Renders that same template
// with the same data public.js's own GET /status route would build for this
// ticket, plus `preview: true`, which the template uses to swap the ticket-
// lookup form and reply box for a banner and hide any way to act as the
// requester (see the isPreview branches in that template).
//
// Gated on is_admin, not just any agent: this is a debugging tool, not a
// normal agent workflow, and admin is this app's one deliberate escalation
// path (see the file comment in src/departments.js) - not something to
// extend to every agent just because it's read-only. getTicketOr404 still
// runs first (an admin always passes it, per canSeeTicket, but it's the one
// place a bad/missing :id 404s instead of throwing). Every use is logged as
// ticket activity so it's auditable who previewed what, and when.
router.get("/tickets/:id/view-as-requester", requireAdmin, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    await db
      .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`)
      .run(ticket.id, req.session.agentId, `${res.locals.currentAgent.name} previewed this ticket as the requester.`);

    res.render("public/status-check", {
      title: `Ticket #${ticket.id} - viewing as requester`,
      ticket,
      attachments: (await attachmentsForTicket(ticket.id, { requesterVisibleOnly: true })).map((a) => ({
        ...a,
        size_label: formatSize(a.size_bytes),
        // Never previewable/downloadable from here - see the isPreview branch
        // in status-check.ejs, which lists attachments as plain text in
        // preview mode rather than wiring up the public download/preview
        // routes (those expect a real requester-owned session/request, which
        // this deliberately isn't).
        is_previewable: false,
      })),
      conversation: await conversationForTicket(ticket.id),
      error: null,
      mergedNotice: null,
      requester: { name: ticket.requester_name, email: ticket.requester_email },
      preview: true,
      previewBackUrl: `/dashboard/tickets/${ticket.id}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/merge", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const targetId = parseInt(req.body.target_ticket_id, 10);
    if (!targetId || targetId === ticket.id) {
      return res.status(400).render("error", { title: "Invalid merge", message: "Enter a different, valid ticket number to merge into." });
    }
    if (ticket.merged_into_id) {
      return res.status(400).render("error", { title: "Invalid merge", message: "This ticket has already been merged." });
    }
    // Same visibility rule as fetching any other ticket by id - a target the
    // agent can't otherwise see 404/400s exactly like one that doesn't exist,
    // rather than confirming its existence to someone outside its department.
    const target = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(targetId);
    if (!target || !(await departments.canSeeTicket(res.locals.currentAgent, target))) {
      return res.status(400).render("error", { title: "Invalid merge", message: "That target ticket does not exist." });
    }
    if (target.merged_into_id) {
      return res.status(400).render("error", {
        title: "Invalid merge",
        message: "That target ticket has itself been merged elsewhere - merge into its final destination instead.",
      });
    }
    // Merging moves a ticket's whole activity/attachment/tag history onto the
    // target - across departments that would either strand the result with no
    // clear department owner, or (worse) quietly move one department's
    // conversation into another's. Disallowed outright, even for an admin:
    // use the existing "Link" feature instead for tickets that are genuinely
    // related but shouldn't become one.
    if ((await departments.departmentIdForCategory(ticket.category)) !== (await departments.departmentIdForCategory(target.category))) {
      return res.status(400).render("error", {
        title: "Invalid merge",
        message: "Tickets from different departments can't be merged into each other. Use \"Link\" instead if they're related.",
      });
    }

    // node:sqlite's synchronous db.exec("BEGIN")/COMMIT/ROLLBACK isn't safely
    // atomic against a connection pool (see db/index.js's transaction() doc
    // comment) - this now checks out one client for the whole sequence.
    await db.transaction(async (tx) => {
      await tx.prepare("UPDATE ticket_activity SET ticket_id = ? WHERE ticket_id = ?").run(target.id, ticket.id);
      await tx.prepare("UPDATE attachments SET ticket_id = ? WHERE ticket_id = ?").run(target.id, ticket.id);
      await tx
        .prepare("INSERT INTO ticket_tags (ticket_id, tag_id) SELECT ?, tag_id FROM ticket_tags WHERE ticket_id = ? ON CONFLICT (ticket_id, tag_id) DO NOTHING")
        .run(target.id, ticket.id);
      await tx.prepare("DELETE FROM ticket_tags WHERE ticket_id = ?").run(ticket.id);
      await tx
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`)
        .run(target.id, req.session.agentId, `Merged ticket #${ticket.id} ("${ticket.subject}") into this one.`);
      await tx.prepare("UPDATE tickets SET merged_into_id = ?, status = 'Closed', updated_at = now_text() WHERE id = ?").run(target.id, ticket.id);
      await tx.prepare("UPDATE tickets SET updated_at = now_text() WHERE id = ?").run(target.id);
    });

    res.redirect(`/dashboard/tickets/${target.id}`);
  } catch (err) {
    next(err);
  }
});

// Manually link two genuinely separate tickets that are still connected
// somehow - as opposed to /merge above, which is for actual duplicates.
// Stored symmetrically (see src/db/index.js's ticket_links comment) so
// either ticket's own page shows the link without an OR-across-both-columns
// query.
router.post("/tickets/:id/link", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const otherId = parseInt(req.body.linked_ticket_id, 10);
    if (!otherId || otherId === ticket.id) {
      return res.status(400).render("error", { title: "Invalid link", message: "Enter a different, valid ticket number to link to." });
    }
    const other = await getTicketOr404(req, res, otherId);
    if (!other) return;

    await db.prepare("INSERT INTO ticket_links (ticket_id, linked_ticket_id) VALUES (?, ?) ON CONFLICT (ticket_id, linked_ticket_id) DO NOTHING").run(ticket.id, other.id);
    await db.prepare("INSERT INTO ticket_links (ticket_id, linked_ticket_id) VALUES (?, ?) ON CONFLICT (ticket_id, linked_ticket_id) DO NOTHING").run(other.id, ticket.id);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/link/:linkedId/remove", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const otherId = parseInt(req.params.linkedId, 10);
    await db.prepare("DELETE FROM ticket_links WHERE ticket_id = ? AND linked_ticket_id = ?").run(ticket.id, otherId);
    await db.prepare("DELETE FROM ticket_links WHERE ticket_id = ? AND linked_ticket_id = ?").run(otherId, ticket.id);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Agent-side inline preview for a safe image attachment - never PDF/TXT/CSV,
// see SAFE_PREVIEW_TYPES. Everything else still only ever force-downloads.
router.get("/tickets/:id/attachments/:attachmentId/preview", async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const attachment = await getAttachment(ticket.id, req.params.attachmentId);
    if (!attachment || !SAFE_PREVIEW_TYPES.has(attachment.mime_type)) {
      return res.status(404).render("error", { title: "Not found", message: "No preview is available for that attachment." });
    }
    await streamAttachment(res, attachment, "inline");
  } catch (err) {
    next(err);
  }
});

// GDPR export/erasure, scoped to this ticket's requester email and reachable
// from the ticket detail page's "Requester data" card - there's no requester
// login system in this app, so both are agent-initiated, not self-service.
router.get("/tickets/:id/privacy/export.json", async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const bundle = await exportRequesterData(ticket.requester_email);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="requester-data-${ticket.id}-${Date.now()}.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/privacy/erase", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const result = await eraseRequesterData(ticket.requester_email);
    if (result.error) {
      return res.status(400).render("error", { title: "Erasure failed", message: result.error });
    }
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/asset", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const raw = req.body.asset_id;
    const newAssetId = raw ? parseInt(raw, 10) : null;
    if (newAssetId && !(await assets.get(newAssetId))) {
      return res.status(400).render("error", { title: "Invalid asset", message: "That asset does not exist." });
    }

    await db.prepare("UPDATE tickets SET asset_id = ?, updated_at = now_text() WHERE id = ?").run(newAssetId, ticket.id);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// A watcher gets notified alongside the assignee (see sendAgentNotifiedOfReply
// in public.js's /status/reply) without being the assignee themselves -
// "keep me posted" without reassigning it away from whoever's actually
// working it.
router.post("/tickets/:id/watch", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;
    await db.prepare("INSERT INTO ticket_watchers (ticket_id, agent_id) VALUES (?, ?) ON CONFLICT (ticket_id, agent_id) DO NOTHING").run(ticket.id, req.session.agentId);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/unwatch", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;
    await db.prepare("DELETE FROM ticket_watchers WHERE ticket_id = ? AND agent_id = ?").run(ticket.id, req.session.agentId);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/tags", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    if ((req.body.tag || "").trim()) {
      await addTagToTicket(ticket.id, req.body.tag);
      await db.prepare("UPDATE tickets SET updated_at = now_text() WHERE id = ?").run(ticket.id);
    }
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/tags/:tagId/remove", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    await removeTagFromTicket(ticket.id, req.params.tagId);
    await db.prepare("UPDATE tickets SET updated_at = now_text() WHERE id = ?").run(ticket.id);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Manual time logging (see src/time-entries.js) - a whole-day+ or non-numeric
// minutes value is rejected outright rather than silently clamped, same
// "surprising input gets an error page, not a silent guess" call as the
// /link route's invalid ticket number above.
router.post("/tickets/:id/time", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const result = await timeEntries.create(ticket.id, req.session.agentId, req.body);
    if (result.error) {
      return res.status(400).render("error", { title: "Invalid time entry", message: result.error });
    }
    res.redirect(`/dashboard/tickets/${ticket.id}#time`);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/time/:entryId/delete", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    await timeEntries.remove(ticket.id, req.params.entryId);
    res.redirect(`/dashboard/tickets/${ticket.id}#time`);
  } catch (err) {
    next(err);
  }
});

// The generic approval gate (see src/departments.js's categoryRequiresApproval
// and the requires_approval column on categories): a category flagged this
// way can't be closed directly. Instead of flipping status, this parks the
// ticket in a pending decision - approval_status alongside the existing
// status column, not a replacement for it - until an admin (the approver;
// see the /tickets/:id/approval/* routes below - this app has no manager
// hierarchy to hang approval on, so is_admin is it) approves or rejects.
// Idempotent: resubmitting while already pending is a no-op, so hammering
// the "Closed" option in the status dropdown doesn't spam the activity feed.
async function submitForApproval(ticket, agentId) {
  if (ticket.approval_status === "pending") return;
  await db.prepare("UPDATE tickets SET approval_status = 'pending', approval_note = NULL, updated_at = now_text() WHERE id = ?").run(ticket.id);
  await db
    .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'approval_change', ?)`)
    .run(ticket.id, agentId, "Submitted for approval before closing - this category requires an admin's sign-off.");
}

// Shared by the single-ticket status route and the bulk-status route below,
// so the two can never quietly diverge on what "changing status" means
// (activity logging, the rating-token/email side effects on Resolved, etc).
async function applyStatusChange(ticket, status, agentId) {
  if (!STATUSES.includes(status) || status === ticket.status) return;

  // A category flagged as requiring approval can't be closed directly -
  // this reroutes the attempt into the pending-approval gate above instead
  // of touching status at all. The approve action (below) calls back into
  // this same function with approval_status already 'approved' on the
  // ticket it passes in, so that path falls straight through to the normal
  // close below rather than looping back into another pending request.
  if (status === "Closed" && ticket.approval_status !== "approved" && (await departments.categoryRequiresApproval(ticket.category))) {
    await submitForApproval(ticket, agentId);
    return;
  }

  // Reopening clears any past SLA alert - a ticket that breaches, gets
  // fixed, and later reopens should be able to alert again rather than
  // staying silenced forever because it alerted once in a previous life.
  // It also clears any past approval decision: a ticket that was approved
  // and closed, then reopened, has to earn a fresh approval before it can
  // close again rather than sailing through on last time's sign-off.
  const reopening = ["Open", "In Progress"].includes(status) && ["Resolved", "Closed"].includes(ticket.status);
  const approvalResetSql = reopening && ticket.approval_status ? ", approval_status = NULL, approval_note = NULL" : "";

  // Aging-pause bookkeeping for "Waiting on Customer" (see src/aging.js):
  // entering it stamps waiting_since; leaving it folds the business hours
  // elapsed since then into paused_hours so that stretch is never counted
  // against the team's own aging/SLA clock, however many times a ticket
  // goes in and out of waiting over its lifetime.
  let pauseSql = "";
  const pauseParams = [];
  if (status === "Waiting on Customer") {
    pauseSql = ", waiting_since = now_text()";
  } else if (ticket.status === "Waiting on Customer" && ticket.waiting_since) {
    const waitingSince = new Date(`${ticket.waiting_since.replace(" ", "T")}Z`);
    pauseSql = ", waiting_since = NULL, paused_hours = paused_hours + ?";
    pauseParams.push(await businessHoursElapsed(waitingSince, new Date()));
  }

  await db
    .prepare(
      `UPDATE tickets SET status = ?, updated_at = now_text()${reopening ? ", sla_alerted_at = NULL" : ""}${approvalResetSql}${pauseSql} WHERE id = ?`
    )
    .run(status, ...pauseParams, ticket.id);
  await db
    .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'status_change', ?)`)
    .run(ticket.id, agentId, `Status changed from "${ticket.status}" to "${status}".`);

  if (status === "Resolved") {
    // Generated lazily, once, the first time a ticket actually resolves -
    // most tickets never need one. A bearer token, not tied to a login: see
    // the ticket_ratings comment in src/db/index.js for why that's the
    // right amount of friction here.
    let ratingToken = ticket.rating_token;
    if (!ratingToken) {
      ratingToken = crypto.randomBytes(24).toString("hex");
      await db.prepare("UPDATE tickets SET rating_token = ? WHERE id = ?").run(ratingToken, ticket.id);
    }
    sendResolvedEmail({
      to: ticket.requester_email,
      ticketId: ticket.id,
      subject: ticket.subject,
      oldStatus: ticket.status,
      ratingToken,
    }).catch((err) => console.error("Could not send resolved email:", err.message));
  } else {
    sendStatusChangeEmail({
      to: ticket.requester_email,
      ticketId: ticket.id,
      subject: ticket.subject,
      oldStatus: ticket.status,
      newStatus: status,
    }).catch((err) => console.error("Could not send status-change email:", err.message));
  }

  await triggerWebhooks(
    "ticket.status_changed",
    {
      ticket_id: ticket.id,
      subject: ticket.subject,
      old_status: ticket.status,
      new_status: status,
    },
    await departments.departmentIdForCategory(ticket.category)
  );
}

router.post("/tickets/:id/status", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    if (!STATUSES.includes(req.body.status)) {
      return res.status(400).render("error", { title: "Invalid status", message: "That status is not valid." });
    }
    await applyStatusChange(ticket, req.body.status, req.session.agentId);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Approve/reject a ticket parked in the pending-approval gate (see
// submitForApproval/applyStatusChange above). Both admin-only: this app has
// no manager-hierarchy concept to hang "approver" on, so is_admin - a real,
// visible, opt-in role, same bypass used everywhere else in this feature -
// is who can approve, full stop. Neither route is reachable for a ticket
// that isn't actually pending, so there's no path to approve/reject a
// decision that was never asked for.
router.post("/tickets/:id/approval/approve", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;
    if (!res.locals.currentAgent.is_admin) {
      return res.status(403).render("error", { title: "Admins only", message: "You need admin access to approve or reject a ticket." });
    }
    if (ticket.approval_status !== "pending") {
      return res.status(400).render("error", { title: "Nothing to approve", message: "This ticket isn't waiting on an approval decision." });
    }

    await db.prepare("UPDATE tickets SET approval_status = 'approved', approval_note = NULL WHERE id = ?").run(ticket.id);
    await db
      .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'approval_change', ?)`)
      .run(ticket.id, req.session.agentId, "Approved for closing.");
    // Reuses the normal close path (activity log, resolved/status-change email,
    // webhooks) for the actual status flip - approval_status is already
    // 'approved' on this in-memory copy, so applyStatusChange's own gate check
    // falls through instead of looping back into another pending request.
    await applyStatusChange({ ...ticket, approval_status: "approved" }, "Closed", req.session.agentId);
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/approval/reject", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;
    if (!res.locals.currentAgent.is_admin) {
      return res.status(403).render("error", { title: "Admins only", message: "You need admin access to approve or reject a ticket." });
    }
    if (ticket.approval_status !== "pending") {
      return res.status(400).render("error", { title: "Nothing to reject", message: "This ticket isn't waiting on an approval decision." });
    }

    // The reviewer note is optional and generic (any category can use it, not
    // just Marketing's content-review flow this was built for) - shown back to
    // the assignee on the ticket page so they know what to fix before
    // resubmitting (selecting "Closed" again re-enters the pending gate).
    const note = (req.body.note || "").trim().slice(0, 1000) || null;
    await db
      .prepare("UPDATE tickets SET approval_status = 'rejected', approval_note = ?, updated_at = now_text() WHERE id = ?")
      .run(note, ticket.id);
    await db
      .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'approval_change', ?)`)
      .run(ticket.id, req.session.agentId, note ? `Rejected - not ready to close. Reviewer note: ${note}` : "Rejected - not ready to close.");
    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Priority is set by the helpdesk team, not the requester - the public
// request form has no priority field at all (see src/routes/public.js).
router.post("/tickets/:id/priority", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const { priority } = req.body;
    if (!PRIORITIES.includes(priority)) {
      return res.status(400).render("error", { title: "Invalid priority", message: "That priority is not valid." });
    }

    if (priority !== ticket.priority) {
      await db.prepare("UPDATE tickets SET priority = ?, updated_at = now_text() WHERE id = ?").run(priority, ticket.id);
      await db
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'priority_change', ?)`)
        .run(ticket.id, req.session.agentId, `Priority changed from "${ticket.priority}" to "${priority}".`);
    }

    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// A confidential ticket is hidden from every same-department agent except
// its own assignee (and, as everywhere else, an admin) - see
// departments.canSeeTicket. A layer on top of department scoping, not a
// replacement for it: a ticket outside the agent's department is already
// invisible regardless of this flag. Toggleable by anyone who can currently
// see the ticket (same "no extra permission tier" model the rest of this
// app already uses for e.g. status/priority).
router.post("/tickets/:id/confidential", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const confidential = req.body.confidential ? 1 : 0;
    if (confidential !== ticket.confidential) {
      await db.prepare("UPDATE tickets SET confidential = ?, updated_at = now_text() WHERE id = ?").run(confidential, ticket.id);
      await db
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`)
        .run(
          ticket.id,
          req.session.agentId,
          confidential ? "Marked confidential - only the assigned agent and admins can see this ticket." : "Removed the confidential flag."
        );
    }

    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Moves a misfiled ticket across the strict department boundary by changing
// its category - department is always derived from category
// (departments.departmentIdForCategory), never a stored field on the ticket
// itself, so updating category IS what moves it. This is the only
// sanctioned way to reach across departments in this app (cross-department
// merge is deliberately rejected - see /tickets/:id/merge above), so it's
// kept admin-only rather than opened up to any agent who can currently see
// the ticket. Immediately removes the ticket from the sending department's
// queue and puts it in the target's, per departments.canSeeTicket's strict
// department match - that's the intended effect of a transfer, not a bug.
router.post("/tickets/:id/transfer", requireAdmin, verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const category = (req.body.category || "").trim();
    if (!(await departments.isValidCategoryName(category))) {
      return res.status(400).render("error", { title: "Invalid category", message: "Choose a valid category to transfer into." });
    }
    if (category === ticket.category) {
      // Picked the ticket's own current category - nothing to do.
      return res.redirect(`/dashboard/tickets/${ticket.id}`);
    }

    const fromDept = await departments.get(await departments.departmentIdForCategory(ticket.category));
    const toDept = await departments.get(await departments.departmentIdForCategory(category));
    const actingAgent = await db.prepare("SELECT name FROM agents WHERE id = ?").get(req.session.agentId);

    // The current assignee (if any) may not belong to the target department -
    // same "only agents in that category's department are eligible" rule
    // applied everywhere else an assignment happens (departments.
    // isEligibleAssignee). Rather than leave a stale cross-department
    // assignment in place, unassign it here - otherwise a confidential
    // ticket transferred this way could end up visible to nobody in the
    // receiving department at all (confidential narrows visibility to the
    // assignee, who'd now be outside it - see departments.canSeeTicket).
    let unassigned = false;
    if (ticket.assigned_to) {
      const assignee = await db.prepare("SELECT id, department_id, is_admin FROM agents WHERE id = ?").get(ticket.assigned_to);
      if (!(await departments.isEligibleAssignee(assignee, category))) unassigned = true;
    }

    await db.transaction(async (tx) => {
      await tx
        .prepare(`UPDATE tickets SET category = ?${unassigned ? ", assigned_to = NULL" : ""}, updated_at = now_text() WHERE id = ?`)
        .run(category, ticket.id);
      await tx
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`)
        .run(
          ticket.id,
          req.session.agentId,
          `Transferred from ${fromDept ? fromDept.name : "an unknown department"} to ${toDept ? toDept.name : "an unknown department"} by ${actingAgent.name}.` +
            (unassigned ? " Unassigned, since the previous assignee is not in the new department." : "")
        );
    });

    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Optional reminder/expiry date, generic on any ticket (not restricted to
// any one department at the DB level - see src/db/index.js's twenty-fifth
// migration) but most relevant to Legal's Contract Review / Compliance /
// NDA / Litigation categories. See src/contractReminders.js for the
// periodic check that emails the ticket's department once this date starts
// approaching. Mirrors src/assets.js's warranty_expires update exactly: a
// changed date clears reminder_alerted_at so it can alert again later.
router.post("/tickets/:id/reminder", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const raw = (req.body.reminder_date || "").trim().slice(0, 10);
    if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return res.status(400).render("error", { title: "Invalid date", message: "Enter a valid reminder date." });
    }
    const reminderDate = raw || null;
    const changed = (ticket.reminder_date || null) !== reminderDate;

    await db
      .prepare(
        `UPDATE tickets SET reminder_date = ?, updated_at = now_text()${changed ? ", reminder_alerted_at = NULL" : ""} WHERE id = ?`
      )
      .run(reminderDate, ticket.id);

    if (changed) {
      await db
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`)
        .run(ticket.id, req.session.agentId, reminderDate ? `Reminder date set to ${reminderDate}.` : "Reminder date cleared.");
    }

    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Shared by the single-ticket assign route and the bulk-assign route below.
// Enforces department-of-assignee eligibility (departments.isEligibleAssignee)
// server-side regardless of what the submitted select actually offered -
// "only agents in that department are eligible" is one rule, applied here
// once, not re-implemented (and potentially drifted) per call site.
async function applyAssignment(ticket, newAssigneeId, agentId) {
  if (newAssigneeId === ticket.assigned_to) return true;
  if (newAssigneeId) {
    const assignee = await db
      .prepare("SELECT id, name, department_id, is_admin FROM agents WHERE id = ? AND active = 1")
      .get(newAssigneeId);
    if (!assignee || !(await departments.isEligibleAssignee(assignee, ticket.category))) return false;
  }

  await db.prepare("UPDATE tickets SET assigned_to = ?, updated_at = now_text() WHERE id = ?").run(newAssigneeId, ticket.id);
  const label = newAssigneeId ? (await db.prepare("SELECT name FROM agents WHERE id = ?").get(newAssigneeId)).name : "Unassigned";
  await db
    .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'assignment', ?)`)
    .run(ticket.id, agentId, `Assigned to ${label}.`);
  triggerWebhooks(
    "ticket.assigned",
    { ticket_id: ticket.id, subject: ticket.subject, assigned_to: label },
    await departments.departmentIdForCategory(ticket.category)
  );
  return true;
}

router.post("/tickets/:id/assign", verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const raw = req.body.assigned_to;
    const newAssigneeId = raw ? parseInt(raw, 10) : null;
    const ok = await applyAssignment(ticket, newAssigneeId, req.session.agentId);
    if (!ok) {
      return res.status(400).render("error", {
        title: "Invalid agent",
        message: "That agent does not exist, is not active, or is not in this ticket's department.",
      });
    }

    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Bulk actions: same underlying logic as the single-ticket routes above
// (applyStatusChange / applyAssignment), just looped over a list of ids from
// checkboxes on the dashboard table. redirect_to carries the current
// filters/page back so applying a bulk action doesn't dump you back to an
// unfiltered page 1.
function bulkRedirect(req, res) {
  const back = (req.body.redirect_to || "/dashboard").startsWith("/dashboard") ? req.body.redirect_to : "/dashboard";
  res.redirect(back);
}

function parseTicketIds(body) {
  const raw = Array.isArray(body.ticket_ids) ? body.ticket_ids : body.ticket_ids ? [body.ticket_ids] : [];
  return raw.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n));
}

// Every bulk route below re-fetches each ticket and re-checks
// departments.canSeeTicket before touching it - the checkboxes on the
// dashboard table only ever come from tickets buildTicketFilter already
// scoped to this agent, but a bulk route takes raw ids straight from the
// POST body, so it can't just trust that without a tampered request being
// able to reach an out-of-department ticket via this path even though the
// list itself never showed it.
async function visibleTicketOrNull(agent, id) {
  const ticket = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(id);
  return ticket && (await departments.canSeeTicket(agent, ticket)) ? ticket : null;
}

router.post("/bulk/status", verifyCsrf, async (req, res, next) => {
  try {
    const ids = parseTicketIds(req.body);
    if (ids.length && STATUSES.includes(req.body.status)) {
      for (const id of ids) {
        const ticket = await visibleTicketOrNull(res.locals.currentAgent, id);
        if (ticket) await applyStatusChange(ticket, req.body.status, req.session.agentId);
      }
    }
    bulkRedirect(req, res);
  } catch (err) {
    next(err);
  }
});

router.post("/bulk/assign", verifyCsrf, async (req, res, next) => {
  try {
    const ids = parseTicketIds(req.body);
    const raw = req.body.assigned_to;
    const newAssigneeId = raw ? parseInt(raw, 10) : null;
    if (ids.length) {
      for (const id of ids) {
        const ticket = await visibleTicketOrNull(res.locals.currentAgent, id);
        if (ticket) await applyAssignment(ticket, newAssigneeId, req.session.agentId);
      }
    }
    bulkRedirect(req, res);
  } catch (err) {
    next(err);
  }
});

// Adds (or removes) one tag across every selected ticket in one go, reusing
// the same addTagToTicket/removeTagFromTicket helpers the single-ticket tag
// form already uses - so case-insensitive reuse and the tag catalog stay
// consistent whichever way a tag gets applied.
router.post("/bulk/tag", verifyCsrf, async (req, res, next) => {
  try {
    const ids = parseTicketIds(req.body);
    const name = (req.body.tag_name || "").trim();
    if (ids.length && name) {
      for (const id of ids) {
        if (await visibleTicketOrNull(res.locals.currentAgent, id)) {
          if (req.body.tag_action === "remove") {
            const tag = await db.prepare("SELECT id FROM tags WHERE LOWER(name) = LOWER(?)").get(name);
            if (tag) await removeTagFromTicket(id, tag.id);
          } else {
            await addTagToTicket(id, name);
          }
        }
      }
    }
    bulkRedirect(req, res);
  } catch (err) {
    next(err);
  }
});

router.post("/tickets/:id/note", handleUpload("attachments"), verifyCsrf, async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const body = (req.body.body || "").trim();
    const hasFiles = req.files && req.files.length;

    if (req.uploadError) {
      deleteUploadedFiles(req.files);
      return res.status(400).render("error", { title: "Upload failed", message: req.uploadError });
    }
    if (!body && !hasFiles) {
      return res.status(400).render("error", { title: "Empty note", message: "Add note text, an attachment, or both." });
    }
    if (body.length > 5000) {
      deleteUploadedFiles(req.files);
      return res.status(400).render("error", { title: "Note too long", message: "Notes must be under 5000 characters." });
    }

    const isPublicReply = req.body.visibility === "reply";

    if (body) {
      await db
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, ?, ?)`)
        .run(ticket.id, req.session.agentId, isPublicReply ? "reply" : "note", body);

      if (isPublicReply) {
        sendReplyEmail({ to: ticket.requester_email, ticketId: ticket.id, subject: ticket.subject, message: body }).catch((err) =>
          console.error("Could not send reply email:", err.message)
        );
      }

      const author = await db.prepare("SELECT name FROM agents WHERE id = ?").get(req.session.agentId);
      for (const mentioned of await findMentionedAgents(body, req.session.agentId)) {
        sendMentionEmail({
          to: mentioned.email,
          ticketId: ticket.id,
          subject: ticket.subject,
          mentionedBy: author ? author.name : "Someone",
          message: body,
        }).catch((err) => console.error("Could not send mention email:", err.message));
        await notifications.create(
          mentioned.id,
          "mention",
          ticket.id,
          `${author ? author.name : "Someone"} mentioned you on ticket #${ticket.id}.`
        );
      }
    }
    if (hasFiles) {
      await saveAttachments({
        ticketId: ticket.id,
        files: req.files,
        uploadedBy: "agent",
        agentId: req.session.agentId,
        visibleToRequester: isPublicReply,
      });
      const names = req.files.map((f) => f.originalname).join(", ");
      await db
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, ?, 'note', ?)`)
        .run(ticket.id, req.session.agentId, `Added attachment${req.files.length > 1 ? "s" : ""}: ${names}`);
    }
    await db.prepare("UPDATE tickets SET updated_at = now_text() WHERE id = ?").run(ticket.id);

    res.redirect(`/dashboard/tickets/${ticket.id}`);
  } catch (err) {
    next(err);
  }
});

// Gated by the router.use(requireAgent) above - any logged-in agent can pull
// any ticket's attachments, same access level they already have to everything
// else on the ticket.
router.get("/tickets/:id/attachments/:attachmentId/download", async (req, res, next) => {
  try {
    const ticket = await getTicketOr404(req, res, req.params.id);
    if (!ticket) return;

    const attachment = await getAttachment(ticket.id, req.params.attachmentId);
    if (!attachment) {
      return res.status(404).render("error", { title: "Not found", message: "That attachment does not exist." });
    }

    await streamAttachment(res, attachment, "attachment");
  } catch (err) {
    next(err);
  }
});

// Every template alongside its own checklist items (see src/checklists.js)
// - a plain checklist line, or one that spawns its own ticket in another
// (or the same) department's category the moment this template is used.
async function templatesWithChecklists() {
  const templates = await db.prepare("SELECT * FROM ticket_templates ORDER BY name").all();
  return Promise.all(templates.map(async (t) => ({ ...t, checklistItems: await checklists.itemsForTemplate(t.id) })));
}

router.get("/templates", async (req, res, next) => {
  try {
    res.render("dashboard/templates", {
      title: "Ticket templates",
      templates: await templatesWithChecklists(),
      categories: await departments.categoryNames(),
      categoriesByDepartment: await departments.categoriesByDepartment(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/templates", verifyCsrf, async (req, res, next) => {
  try {
    const { name = "", category = "", subject = "", description = "" } = req.body;
    if (!name.trim() || !(await departments.isValidCategoryName(category)) || !subject.trim() || !description.trim()) {
      return res.status(400).render("dashboard/templates", {
        title: "Ticket templates",
        templates: await templatesWithChecklists(),
        categories: await departments.categoryNames(),
        categoriesByDepartment: await departments.categoriesByDepartment(),
        error: "Name, category, subject, and description are all required.",
      });
    }
    await db
      .prepare("INSERT INTO ticket_templates (name, category, subject, description) VALUES (?, ?, ?, ?)")
      .run(name.trim().slice(0, 100), category, subject.trim().slice(0, 200), description.trim().slice(0, 5000));
    res.redirect("/dashboard/templates");
  } catch (err) {
    next(err);
  }
});

router.post("/templates/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await db.prepare("DELETE FROM ticket_templates WHERE id = ?").run(req.params.id);
    res.redirect("/dashboard/templates");
  } catch (err) {
    next(err);
  }
});

// A checklist line on a template - see src/checklists.js. spawn_category is
// optional and deliberately not restricted to a different department than
// the template's own category: an HR template is free to spawn an IT and a
// Marketing ticket (the onboarding use case this is for), but nothing here
// requires it to leave HR either.
router.post("/templates/:id/checklist-items", verifyCsrf, async (req, res, next) => {
  try {
    const template = await db.prepare("SELECT * FROM ticket_templates WHERE id = ?").get(req.params.id);
    if (!template) return res.status(404).render("error", { title: "Not found", message: "That template does not exist." });

    const result = await checklists.addChecklistItem(template.id, {
      label: req.body.label,
      spawnCategory: req.body.spawn_category,
    });
    if (result.error) {
      return res.status(400).render("dashboard/templates", {
        title: "Ticket templates",
        templates: await templatesWithChecklists(),
        categories: await departments.categoryNames(),
        categoriesByDepartment: await departments.categoriesByDepartment(),
        error: result.error,
      });
    }
    res.redirect("/dashboard/templates");
  } catch (err) {
    next(err);
  }
});

router.post("/templates/:id/checklist-items/:itemId/delete", verifyCsrf, async (req, res, next) => {
  try {
    await checklists.removeChecklistItem(req.params.itemId);
    res.redirect("/dashboard/templates");
  } catch (err) {
    next(err);
  }
});

router.get("/recurring", async (req, res, next) => {
  try {
    res.render("dashboard/recurring", {
      title: "Recurring tickets",
      recurring: await recurring.all(),
      categories: await departments.categoryNames(),
      priorities: PRIORITIES,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/recurring", verifyCsrf, async (req, res, next) => {
  try {
    const result = await recurring.create(req.body);
    if (result.error) {
      return res.status(400).render("dashboard/recurring", {
        title: "Recurring tickets",
        recurring: await recurring.all(),
        categories: await departments.categoryNames(),
        priorities: PRIORITIES,
        error: result.error,
      });
    }
    res.redirect("/dashboard/recurring");
  } catch (err) {
    next(err);
  }
});

router.post("/recurring/:id/toggle", verifyCsrf, async (req, res, next) => {
  try {
    const row = await db.prepare("SELECT active FROM recurring_tickets WHERE id = ?").get(req.params.id);
    if (row) await recurring.setActive(req.params.id, !row.active);
    res.redirect("/dashboard/recurring");
  } catch (err) {
    next(err);
  }
});

router.post("/recurring/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await db.prepare("DELETE FROM recurring_tickets WHERE id = ?").run(req.params.id);
    res.redirect("/dashboard/recurring");
  } catch (err) {
    next(err);
  }
});

// The dashboard KB list is scoped per item 7 of the multi-department
// feature: an agent sees every shared article plus their own department's
// (kb.forAgent), an admin sees all (same function, since it already treats
// is_admin as "no restriction"). The public /kb browsing list is untouched -
// department-specific public-facing content is explicitly out of scope.
router.get("/kb", async (req, res, next) => {
  try {
    res.render("dashboard/kb", { title: "Knowledge base", articles: await kb.forAgent(res.locals.currentAgent) });
  } catch (err) {
    next(err);
  }
});

router.get("/kb/new", async (req, res, next) => {
  try {
    res.render("dashboard/kb-edit", {
      title: "New article",
      article: null,
      categories: await departments.categoryNames(),
      departmentsList: await departments.all(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/kb/new", verifyCsrf, async (req, res, next) => {
  try {
    const result = await kb.create(req.body, req.session.agentId);
    if (result.error) {
      return res.status(400).render("dashboard/kb-edit", {
        title: "New article",
        article: req.body,
        categories: await departments.categoryNames(),
        departmentsList: await departments.all(),
        error: result.error,
      });
    }
    res.redirect(`/dashboard/kb/${result.id}/edit`);
  } catch (err) {
    next(err);
  }
});

router.get("/kb/:id/edit", async (req, res, next) => {
  try {
    const article = await kb.get(req.params.id);
    if (!article) return res.status(404).render("error", { title: "Not found", message: "That article does not exist." });
    res.render("dashboard/kb-edit", {
      title: article.title,
      article,
      categories: await departments.categoryNames(),
      departmentsList: await departments.all(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/kb/:id/edit", verifyCsrf, async (req, res, next) => {
  try {
    const article = await kb.get(req.params.id);
    if (!article) return res.status(404).render("error", { title: "Not found", message: "That article does not exist." });
    const result = await kb.update(article.id, req.body);
    if (result.error) {
      return res.status(400).render("dashboard/kb-edit", {
        title: article.title,
        article: { ...article, ...req.body },
        categories: await departments.categoryNames(),
        departmentsList: await departments.all(),
        error: result.error,
      });
    }
    res.redirect(`/dashboard/kb/${article.id}/edit`);
  } catch (err) {
    next(err);
  }
});

// Scoped like kb.forAgent() above: what the acting agent can see and
// manage - every shared response plus their own department's, or every
// response for an admin.
router.get("/canned-responses", async (req, res, next) => {
  try {
    res.render("dashboard/canned-responses", {
      title: "Canned responses",
      responses: await canned.forAgent(res.locals.currentAgent),
      departmentsList: await departments.all(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/canned-responses", verifyCsrf, async (req, res, next) => {
  try {
    const { title = "", body = "" } = req.body;
    const departmentId = req.body.department_id ? parseInt(req.body.department_id, 10) : null;
    if (!title.trim() || !body.trim()) {
      return res.status(400).render("dashboard/canned-responses", {
        title: "Canned responses",
        responses: await canned.forAgent(res.locals.currentAgent),
        departmentsList: await departments.all(),
        error: "Both a title and body are required.",
      });
    }
    await canned.create(title, body, departmentId);
    res.redirect("/dashboard/canned-responses");
  } catch (err) {
    next(err);
  }
});

router.post("/canned-responses/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await canned.remove(req.params.id);
    res.redirect("/dashboard/canned-responses");
  } catch (err) {
    next(err);
  }
});

router.get("/assets", async (req, res, next) => {
  try {
    const { status = "", category = "", q = "" } = req.query;
    const filters = { status, category, q };

    const totalCount = await assets.count(filters);
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), totalPages);
    const offset = (page - 1) * PAGE_SIZE;

    const cutoff = new Date(Date.now() + WARRANTY_ALERT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await assets.all(filters, { limit: PAGE_SIZE, offset });
    const items = rows.map((a) => ({
      ...a,
      warranty_expired: Boolean(a.warranty_expires && a.warranty_expires < today),
      warranty_expiring_soon: Boolean(a.warranty_expires && a.warranty_expires >= today && a.warranty_expires <= cutoff),
    }));
    res.render("dashboard/assets", {
      title: "Assets",
      wide: true,
      items,
      filters,
      categories: ASSET_CATEGORIES,
      statuses: ASSET_STATUSES,
      statusCounts: await assets.countsByStatus(),
      page,
      totalPages,
      totalCount,
      values: {},
      error: null,
      exportQuery: new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/assets", verifyCsrf, async (req, res, next) => {
  try {
    const result = await assets.create(req.body, req.session.agentId);
    if (result.error) {
      const totalCount = await assets.count({});
      return res.status(400).render("dashboard/assets", {
        title: "Assets",
        wide: true,
        items: await assets.all({}, { limit: PAGE_SIZE, offset: 0 }),
        filters: { status: "", category: "", q: "" },
        categories: ASSET_CATEGORIES,
        statuses: ASSET_STATUSES,
        statusCounts: await assets.countsByStatus(),
        page: 1,
        totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
        totalCount,
        values: req.body,
        error: result.error,
        exportQuery: "",
      });
    }
    res.redirect(`/dashboard/assets/${result.id}`);
  } catch (err) {
    next(err);
  }
});

// Mirrors /dashboard/export.csv for tickets. Defined before /assets/:id so
// Express doesn't match "export.csv" as an :id first.
router.get("/assets/export.csv", async (req, res, next) => {
  try {
    const { status = "", category = "", q = "" } = req.query;
    const csv = toCsv(await assets.all({ status, category, q }), [
      { key: "id", header: "ID" },
      { key: "name", header: "Name" },
      { key: "asset_tag", header: "Asset tag" },
      { key: "category", header: "Category" },
      { key: "status", header: "Status" },
      { key: "assigned_to_name", header: "Assigned to" },
      { key: "location", header: "Location" },
      { key: "serial_number", header: "Serial number" },
      { key: "vendor", header: "Vendor" },
      { key: "purchase_date", header: "Purchase date" },
      { key: "warranty_expires", header: "Warranty expiry" },
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="assets-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get("/assets/:id", async (req, res, next) => {
  try {
    const asset = await assets.get(req.params.id);
    if (!asset) {
      return res.status(404).render("error", { title: "Not found", message: "That asset does not exist." });
    }
    res.render("dashboard/asset", {
      title: asset.name,
      asset,
      tickets: await assets.ticketsForAsset(asset.id),
      activity: await assets.activityForAsset(asset.id),
      categories: ASSET_CATEGORIES,
      statuses: ASSET_STATUSES,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/assets/:id", verifyCsrf, async (req, res, next) => {
  try {
    const asset = await assets.get(req.params.id);
    if (!asset) {
      return res.status(404).render("error", { title: "Not found", message: "That asset does not exist." });
    }
    const result = await assets.update(asset.id, req.body, req.session.agentId);
    if (result.error) {
      return res.status(400).render("dashboard/asset", {
        title: asset.name,
        asset: { ...asset, ...req.body },
        tickets: await assets.ticketsForAsset(asset.id),
        activity: await assets.activityForAsset(asset.id),
        categories: ASSET_CATEGORIES,
        statuses: ASSET_STATUSES,
        error: result.error,
      });
    }
    res.redirect(`/dashboard/assets/${asset.id}`);
  } catch (err) {
    next(err);
  }
});

// The CSP here has no 'unsafe-inline' for styles, so a bar's size can't be
// an inline `style="width: X%"` - it has to be one of a fixed set of CSS
// classes (bar-w-0, bar-w-5, ... bar-w-100) defined in style.css. Rounding
// to the nearest 5% is plenty of precision for a simple bar chart.
function barClass(prefix, value, max) {
  const pct = max > 0 ? Math.round((value / max) * 20) * 5 : 0;
  return `${prefix}-${Math.min(100, Math.max(0, pct))}`;
}

// Reports now live inside /dashboard itself (a sidebar next to the ticket
// list), not a separate page - see buildReportsData() below and the
// ...buildReportsData() spread into the "/" route's render call. Kept as a
// redirect, not removed outright, so an old bookmark/link to this URL still
// lands somewhere useful instead of 404ing.
router.get("/reports", (req, res) => res.redirect("/dashboard"));

const REPORT_RANGE_PRESETS = { "7d": 7, "30d": 30, "90d": 90 };
const REPORT_RANGE_LABELS = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days" };

function defaultWindow(days) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const to = today.toISOString().slice(0, 10);
  const from = new Date(today.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

// Reads ?report_range (7d/30d/90d/custom) + ?report_from/?report_to (only
// for custom) off the querystring, always falling back to a valid 30-day
// window - so a missing/garbled param never breaks the page, it just shows
// the same default it always has. Kept entirely separate from the ticket
// list's own filters (buildTicketFilter) - different querystring keys, on
// purpose, so changing one never resets the other.
function resolveReportRange(query) {
  if (query.report_range === "custom") {
    let from = query.report_from;
    let to = query.report_to;
    if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      if (from > to) [from, to] = [to, from];
      return { range: "custom", from, to };
    }
    // "Custom range" was just picked but real dates haven't been typed in
    // and applied yet (the date inputs don't exist in the DOM until this
    // very response renders them) - stay in "custom" mode so the view
    // actually shows those inputs, just use a plain 30-day window under
    // the hood until the agent fills them in and hits Apply for real.
    return { range: "custom", ...defaultWindow(30) };
  }
  const range = REPORT_RANGE_PRESETS[query.report_range] ? query.report_range : "30d";
  return { range, ...defaultWindow(REPORT_RANGE_PRESETS[range]) };
}

function reportRangeLabel(reportRange) {
  if (reportRange.range === "custom") return `${reportRange.from} to ${reportRange.to}`;
  return REPORT_RANGE_LABELS[reportRange.range] || REPORT_RANGE_LABELS["30d"];
}

// Whole calendar days between from/to (both YYYY-MM-DD, inclusive) - pure
// UTC string/number math throughout, deliberately not local-timezone Date
// mutation, to match how created_at is stored (datetime('now'), UTC) and
// how date(created_at) already groups it in SQL.
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

// Daily bars stay readable up to about a month of data; past that, this
// switches every date-bucketed chart (volume, CSAT trend, SLA compliance)
// to one bar per month instead, so a 90-day or custom multi-month range
// doesn't render 90+ razor-thin bars.
function reportBucketUnit(from, to) {
  return daysBetween(from, to) <= 31 ? "day" : "month";
}

function eachDayBucket(from, to) {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const n = daysBetween(from, to);
  return Array.from({ length: n }, (_, i) => new Date(fromMs + i * 86400000).toISOString().slice(0, 10));
}

function eachMonthBucket(from, to) {
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [endY, endM] = to.slice(0, 7).split("-").map(Number);
  const out = [];
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

// Everything the Reports section on /dashboard needs, gathered in one place
// so the "/" route's render call can just spread it in. `reportRange` is
// {range, from, to} from resolveReportRange() above; `unit` ("day" or
// "month") from reportBucketUnit() - passed in rather than recomputed here
// since the "/" route needs `unit` too, for the range-picker form itself.
async function buildReportsData(reportRange, unit, agent) {
  const { from, to } = reportRange;
  const rangeParams = [from, to];
  // SQLite's `date(x, '+1 day')` has no direct Postgres equivalent - cast to
  // ::date, add an interval, then cast back to ::text so the comparison
  // against created_at (stored as TEXT, see src/db/index.js's design notes)
  // still works as a plain string comparison, same as it did in SQLite.
  const rangeWhere = "created_at >= ? AND created_at < (?::date + INTERVAL '1 day')::text";
  const bucketExpr = unit === "day" ? "created_at::date::text" : "to_char(created_at::timestamp, 'YYYY-MM')";
  const bucketKeys = unit === "day" ? eachDayBucket(from, to) : eachMonthBucket(from, to);
  // Every query below is additionally scoped by this - a non-admin's
  // reports only ever reflect their own department's tickets, same as the
  // ticket list itself (departments.ticketVisibilitySql). It's empty for an
  // admin, so nothing here narrows for them.
  const vis = departments.ticketVisibilitySql(agent);

  // Ticket volume per bucket across the selected range, zero-filled so a
  // quiet bucket shows as an actual zero-height bar, not a gap that's easy
  // to misread as missing data.
  const volumeRows = await db
    .prepare(`SELECT ${bucketExpr} AS bucket, COUNT(*) AS count FROM tickets WHERE ${rangeWhere}${vis.sql} GROUP BY bucket`)
    .all(...rangeParams, ...vis.params);
  const volumeByBucket = Object.fromEntries(volumeRows.map((r) => [r.bucket, Number(r.count)]));
  const volume = bucketKeys.map((bucket) => ({ day: bucket, count: volumeByBucket[bucket] || 0 }));

  const byCategoryRaw = await db
    .prepare(`SELECT category AS label, COUNT(*) AS count FROM tickets WHERE ${rangeWhere}${vis.sql} GROUP BY category ORDER BY count DESC`)
    .all(...rangeParams, ...vis.params);
  const byCategory = byCategoryRaw.map((r) => ({ ...r, count: Number(r.count) }));
  const byStatusRaw = await db
    .prepare(`SELECT status AS label, COUNT(*) AS count FROM tickets WHERE ${rangeWhere}${vis.sql} GROUP BY status ORDER BY count DESC`)
    .all(...rangeParams, ...vis.params);
  const byStatus = byStatusRaw.map((r) => ({ ...r, count: Number(r.count) }));

  // Cross-department volume - meaningful for an admin (who can compare
  // departments against each other); for a non-admin it's scoped like
  // everything else here, so it just shows their own single department.
  // Derives the department from category via the categories table rather
  // than a stored column on tickets, same as every other department lookup
  // in this app.
  const byDepartmentRaw = await db
    .prepare(
      `SELECT COALESCE(departments.name, 'Unknown') AS label, COUNT(*) AS count
       FROM tickets
       LEFT JOIN categories ON categories.name = tickets.category
       LEFT JOIN departments ON departments.id = categories.department_id
       WHERE tickets.created_at >= ? AND tickets.created_at < (?::date + INTERVAL '1 day')::text${vis.sql}
       GROUP BY departments.id, departments.name
       ORDER BY count DESC`
    )
    .all(...rangeParams, ...vis.params);
  const byDepartment = byDepartmentRaw.map((r) => ({ ...r, count: Number(r.count) }));

  // Current workload deliberately ignores the selected report range - it's
  // a live "who has what open right now" snapshot, not a historical count,
  // so picking "Last 7 days" shouldn't hide someone's older backlog.
  const byAgentRaw = await db
    .prepare(
      `SELECT COALESCE(agents.name, 'Unassigned') AS label, COUNT(*) AS count
       FROM tickets
       LEFT JOIN agents ON agents.id = tickets.assigned_to
       WHERE tickets.status IN ('Open', 'In Progress')${vis.sql}
       GROUP BY tickets.assigned_to, agents.name
       ORDER BY count DESC`
    )
    .all(...vis.params);
  const byAgent = byAgentRaw.map((r) => ({ ...r, count: Number(r.count) }));

  // Department capacity: open (Open/In Progress) ticket count vs active,
  // non-admin agent count, per department, right now - same "live snapshot,
  // ignores the selected report range" treatment as Current workload above.
  // A non-admin only ever gets their OWN department's row here (the WHERE
  // below), which is fine under strict department-only visibility: it's
  // just a count of that agent's own department's tickets/agents, nothing
  // about another department is exposed. An admin gets every active
  // department, for the cross-department comparison. Deliberately its own
  // WHERE rather than reusing ticketVisibilitySql() (which filters a
  // `tickets` query row-by-row) - this rolls up per department instead, so
  // it filters on departments.id directly.
  const departmentCapacityWhere =
    agent && agent.is_admin ? " WHERE departments.active = 1" : " WHERE departments.active = 1 AND departments.id = ?";
  const departmentCapacityParams = agent && agent.is_admin ? [] : [agent && agent.department_id];
  const departmentCapacityRaw = await db
    .prepare(
      `SELECT departments.name AS label,
              (SELECT COUNT(*) FROM tickets
               JOIN categories ON categories.name = tickets.category
               WHERE categories.department_id = departments.id AND tickets.status IN ('Open', 'In Progress')) AS open_count,
              (SELECT COUNT(*) FROM agents
               WHERE agents.department_id = departments.id AND agents.active = 1 AND agents.is_admin = 0) AS agent_count
       FROM departments
       ${departmentCapacityWhere}
       ORDER BY departments.name`
    )
    .all(...departmentCapacityParams);
  const departmentCapacityCounted = departmentCapacityRaw.map((r) => ({
    label: r.label,
    open_count: Number(r.open_count),
    agent_count: Number(r.agent_count),
  }));
  const capacityOpenMax = Math.max(1, ...departmentCapacityCounted.map((r) => r.open_count));
  const departmentCapacity = departmentCapacityCounted.map((r) => ({
    label: r.label,
    openCount: r.open_count,
    agentCount: r.agent_count,
    barClass: barClass("bar-w", r.open_count, capacityOpenMax),
  }));

  const volumeMax = Math.max(1, ...volume.map((v) => v.count));
  const withBarClass = (rows, prefix) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows.map((r) => ({ ...r, barClass: barClass(prefix, r.count, max) }));
  };

  // CSAT trend, bucketed the same way as volume above - only buckets with
  // at least one rating, rather than zero-filled: a 1-5 rating scale has no
  // sensible "0" to zero-fill with, since that would look identical to a
  // genuinely bad average rather than "nobody rated anything that bucket".
  const csatBucketExpr =
    unit === "day" ? "ticket_ratings.created_at::date::text" : "to_char(ticket_ratings.created_at::timestamp, 'YYYY-MM')";
  const csatTrendRaw = await db
    .prepare(
      `SELECT ${csatBucketExpr} AS month, AVG(ticket_ratings.rating) AS avg_rating, COUNT(*) AS count
       FROM ticket_ratings
       JOIN tickets ON tickets.id = ticket_ratings.ticket_id
       WHERE ticket_ratings.created_at >= ? AND ticket_ratings.created_at < (?::date + INTERVAL '1 day')::text${vis.sql}
       GROUP BY month ORDER BY month`
    )
    .all(...rangeParams, ...vis.params);
  const csatTrend = csatTrendRaw.map((r) => ({
    ...r,
    avg_rating: Number(r.avg_rating),
    count: Number(r.count),
    barClass: barClass("bar-h", Number(r.avg_rating), 5),
  }));

  // Per-agent breakdown, scoped to tickets actually RESOLVED within the
  // selected range (not created within it) - "how did each agent do during
  // this window" is what picking a date range is normally asking. avg_csat
  // is a known, pre-existing simplification kept as-is: it averages every
  // rating this agent's tickets have ever received, not only ratings on
  // tickets that resolved inside this particular range.
  // Rows themselves are restricted to the acting agent's own department
  // (peer comparison) unless they're an admin, who sees every agent. The
  // tickets counted per agent are restricted the same way, but in the JOIN
  // condition rather than the WHERE clause - moving it into WHERE would
  // turn this LEFT JOIN into an effective INNER JOIN and drop an agent with
  // zero matching tickets from the table entirely, instead of showing them
  // with all-zero stats.
  const agentDeptWhere = agent && agent.is_admin ? "" : " AND agents.department_id = ?";
  const agentDeptParams = agent && agent.is_admin ? [] : [agent && agent.department_id];
  const agentPerformanceRaw = await db
    .prepare(
      `SELECT agents.name,
              COUNT(DISTINCT resolved.ticket_id) AS resolved_count,
              AVG(EXTRACT(EPOCH FROM (resolved.happened::timestamp - tickets.created_at::timestamp)) / 86400) AS avg_resolution_days,
              AVG(ticket_ratings.rating) AS avg_csat
       FROM agents
       LEFT JOIN tickets ON tickets.assigned_to = agents.id${vis.sql}
       LEFT JOIN (
         SELECT ticket_id, MAX(created_at) AS happened
         FROM ticket_activity
         WHERE type = 'status_change' AND body LIKE '%to "Resolved".' AND created_at >= ? AND created_at < (?::date + INTERVAL '1 day')::text
         GROUP BY ticket_id
       ) resolved ON resolved.ticket_id = tickets.id
       LEFT JOIN ticket_ratings ON ticket_ratings.ticket_id = tickets.id
       WHERE agents.active = 1${agentDeptWhere}
       GROUP BY agents.id, agents.name
       ORDER BY resolved_count DESC`
    )
    .all(...vis.params, ...rangeParams, ...agentDeptParams);
  const agentPerformance = agentPerformanceRaw.map((r) => ({
    ...r,
    resolved_count: Number(r.resolved_count),
    avg_resolution_days: r.avg_resolution_days == null ? null : Number(r.avg_resolution_days),
    avg_csat: r.avg_csat == null ? null : Number(r.avg_csat),
  }));

  // Reopen rate: of tickets resolved within the range, how many were later
  // reopened (either an agent manually moving it back, or the auto-reopen-
  // on-requester-reply in public.js - both leave a status_change activity
  // row reading "from Resolved/Closed to ...") - a rough proxy for "are we
  // actually fixing things".
  const everResolvedRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT ticket_activity.ticket_id) AS c
       FROM ticket_activity JOIN tickets ON tickets.id = ticket_activity.ticket_id
       WHERE ticket_activity.type = 'status_change' AND ticket_activity.body LIKE '%to "Resolved".'
         AND ticket_activity.created_at >= ? AND ticket_activity.created_at < (?::date + INTERVAL '1 day')::text${vis.sql}`
    )
    .get(...rangeParams, ...vis.params);
  const everResolvedCount = Number(everResolvedRow.c);
  const reopenedRow = await db
    .prepare(
      `SELECT COUNT(DISTINCT ticket_activity.ticket_id) AS c
       FROM ticket_activity JOIN tickets ON tickets.id = ticket_activity.ticket_id
       WHERE ticket_activity.type = 'status_change'
         AND (ticket_activity.body LIKE '%from "Resolved" to%' OR ticket_activity.body LIKE '%from "Closed" to%')
         AND ticket_activity.created_at >= ? AND ticket_activity.created_at < (?::date + INTERVAL '1 day')::text${vis.sql}`
    )
    .get(...rangeParams, ...vis.params);
  const reopenedCount = Number(reopenedRow.c);
  const reopenRate = everResolvedCount ? (reopenedCount / everResolvedCount) * 100 : null;

  // SLA compliance trend: of tickets resolved within the range, bucketed
  // the same way as volume/CSAT above, what fraction met their priority's
  // resolution threshold (src/aging.js's business-hours math, minus any
  // Waiting-on-Customer pauses)? Two known simplifications, both fine for
  // an internal trend chart rather than an audit record: thresholds are
  // always the CURRENT ones (not whatever was configured back when a given
  // ticket actually resolved), and paused_hours reflects each ticket's
  // present-day cumulative value (exact for a ticket resolved once, an
  // approximation for one that later reopened, paused again, and
  // re-resolved before the range's own end date).
  const slaBucketExpr = unit === "day" ? "resolved.happened::date::text" : "to_char(resolved.happened::timestamp, 'YYYY-MM')";
  const resolvedForSla = await db
    .prepare(
      `SELECT tickets.priority, tickets.created_at, tickets.paused_hours, resolved.happened AS resolved_at,
              ${slaBucketExpr} AS bucket
       FROM tickets
       JOIN (
         SELECT ticket_id, MAX(created_at) AS happened
         FROM ticket_activity
         WHERE type = 'status_change' AND body LIKE '%to "Resolved".'
         GROUP BY ticket_id
       ) resolved ON resolved.ticket_id = tickets.id
       WHERE resolved.happened >= ? AND resolved.happened < (?::date + INTERVAL '1 day')::text${vis.sql}`
    )
    .all(...rangeParams, ...vis.params);

  const slaThresholds = await currentThresholds();
  const slaBuckets = {};
  for (const t of resolvedForSla) {
    const created = new Date(`${t.created_at.replace(" ", "T")}Z`);
    const resolvedAt = new Date(`${t.resolved_at.replace(" ", "T")}Z`);
    const hours = Math.max(0, (await businessHoursElapsed(created, resolvedAt)) - (t.paused_hours || 0));
    const thresholdDays = slaThresholds[t.priority] ?? FALLBACK_DAYS;
    const met = hours <= thresholdDays * BUSINESS_HOURS_PER_DAY;
    if (!slaBuckets[t.bucket]) slaBuckets[t.bucket] = { met: 0, total: 0 };
    slaBuckets[t.bucket].total += 1;
    if (met) slaBuckets[t.bucket].met += 1;
  }
  const slaCompliance = Object.keys(slaBuckets)
    .sort()
    .map((bucket) => {
      const { met, total } = slaBuckets[bucket];
      const pct = (met / total) * 100;
      return { month: bucket, pct, met, total, barClass: barClass("bar-h", pct, 100) };
    });

  // Time tracked (see src/time-entries.js) within the same selected range,
  // matched against logged_on (when the work happened) rather than the
  // ticket's own created_at - a ticket opened months ago but worked on
  // during this window should still show up here.
  const timeByAgent = await timeEntries.summaryByAgent(from, to, vis);
  const timeByTicket = await timeEntries.summaryByTicket(from, to, vis);
  const totalTimeMinutes = await timeEntries.totalMinutesInRange(from, to, vis);

  return {
    volume: volume.map((v) => ({ ...v, barClass: barClass("bar-h", v.count, volumeMax) })),
    byCategory: withBarClass(byCategory, "bar-w"),
    byStatus: withBarClass(byStatus, "bar-w"),
    byAgent: withBarClass(byAgent, "bar-w"),
    byDepartment: withBarClass(byDepartment, "bar-w"),
    departmentCapacity,
    csatTrend,
    slaCompliance,
    agentPerformance,
    everResolvedCount,
    reopenedCount,
    reopenRate,
    timeByAgent,
    timeByTicket,
    totalTimeMinutes,
    formatMinutes: timeEntries.formatMinutes,
  };
}

router.get("/settings", async (req, res, next) => {
  try {
    res.render("dashboard/settings", {
      title: "Settings",
      thresholds: await currentThresholds(),
      frThresholds: await currentFirstResponseThresholds(),
      priorities: PRIORITIES,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings", verifyCsrf, async (req, res, next) => {
  try {
    const errors = [];
    const parsed = {};
    for (const priority of PRIORITIES) {
      const days = parseInt(req.body[`days_${priority}`], 10);
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        errors.push(`${priority} must be a whole number of days between 1 and 365.`);
        continue;
      }
      parsed[priority] = days;
    }

    const parsedFr = {};
    for (const priority of PRIORITIES) {
      const hours = parseInt(req.body[`fr_hours_${priority}`], 10);
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        errors.push(`${priority}'s first-response target must be a whole number of hours between 1 and 720.`);
        continue;
      }
      parsedFr[priority] = hours;
    }

    if (errors.length) {
      return res.status(400).render("dashboard/settings", {
        title: "Settings",
        thresholds: await currentThresholds(),
        frThresholds: await currentFirstResponseThresholds(),
        priorities: PRIORITIES,
        error: errors.join(" "),
      });
    }

    const update = db.prepare("UPDATE sla_thresholds SET days = ? WHERE priority = ?");
    for (const [priority, days] of Object.entries(parsed)) await update.run(days, priority);
    const updateFr = db.prepare("UPDATE first_response_thresholds SET hours = ? WHERE priority = ?");
    for (const [priority, hours] of Object.entries(parsedFr)) await updateFr.run(hours, priority);
    res.redirect("/dashboard/settings");
  } catch (err) {
    next(err);
  }
});

// Optional TOTP two-factor login (see src/totp.js) - an agent's own account
// setting, open to any agent (same as the rest of /settings, unlike
// /agents below, which is is_admin-only). Setup is two steps: generate a
// secret and show it (text + otpauth:// URI for manual entry - no QR-code
// dependency, see the account-security feature notes), then require one
// real code from it before anything is written to agents.totp_secret/
// totp_enabled. The secret lives only in the session until that
// verification succeeds - a secret nobody's confirmed they can generate
// codes for would just lock the agent out the moment it went live.
async function renderSecurityPage(req, res, { status = 200, error = null, notice = null } = {}) {
  const agent = await db.prepare("SELECT totp_enabled FROM agents WHERE id = ?").get(req.session.agentId);
  const pendingSecret = req.session.totpSetupSecret || null;
  res.status(status).render("dashboard/security", {
    title: "Two-factor authentication",
    totpEnabled: Boolean(agent && agent.totp_enabled),
    pendingSecret,
    otpauthUri: pendingSecret ? totp.buildOtpauthUri(pendingSecret, { label: res.locals.currentAgent.email }) : null,
    error,
    notice,
  });
}

router.get("/settings/security", async (req, res, next) => {
  try {
    await renderSecurityPage(req, res);
  } catch (err) {
    next(err);
  }
});

router.post("/settings/security/2fa/setup", verifyCsrf, async (req, res, next) => {
  try {
    // Already on - nothing to (re-)set up until it's turned off first, which
    // would otherwise let a stray double-submit generate (and show) a fresh
    // secret while the old one is still the one actually protecting login.
    if (res.locals.currentAgent.totp_enabled) return res.redirect("/dashboard/settings/security");
    req.session.totpSetupSecret = totp.generateSecret();
    res.redirect("/dashboard/settings/security");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/security/2fa/cancel", verifyCsrf, (req, res) => {
  delete req.session.totpSetupSecret;
  res.redirect("/dashboard/settings/security");
});

router.post("/settings/security/2fa/verify", verifyCsrf, async (req, res, next) => {
  try {
    const pendingSecret = req.session.totpSetupSecret;
    if (!pendingSecret) return res.redirect("/dashboard/settings/security");

    if (!totp.verifyToken(pendingSecret, req.body.code || "")) {
      return renderSecurityPage(req, res, { status: 400, error: "That code didn't match. Check your device's clock and try again." });
    }

    await db.prepare("UPDATE agents SET totp_secret = ?, totp_enabled = 1 WHERE id = ?").run(pendingSecret, req.session.agentId);
    delete req.session.totpSetupSecret;
    await renderSecurityPage(req, res, { notice: "Two-factor authentication is now on for your account." });
  } catch (err) {
    next(err);
  }
});

// Disabling requires the agent's current password, not just an active
// session - a live session alone being enough to turn off the second
// factor protecting it would defeat most of the point of having one.
router.post("/settings/security/2fa/disable", verifyCsrf, async (req, res, next) => {
  try {
    const agent = await db.prepare("SELECT id, password_hash FROM agents WHERE id = ?").get(req.session.agentId);
    if (!bcrypt.compareSync(req.body.password || "", agent.password_hash)) {
      return renderSecurityPage(req, res, { status: 400, error: "Incorrect password." });
    }
    await db.prepare("UPDATE agents SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?").run(agent.id);
    await renderSecurityPage(req, res, { notice: "Two-factor authentication has been turned off." });
  } catch (err) {
    next(err);
  }
});

// Departments + their categories (see src/departments.js) - the
// configurable structure everything else in this feature (agent scoping,
// auto-assignment, KB/canned-responses/automation/webhooks scoping,
// reports) is ultimately built on top of. Neither is hard-deleted (retire
// via `active`, same pattern as agents/assets/holidays) - a category or
// department already referenced by real tickets/agents can't be yanked out
// from under them.
router.get("/settings/departments", async (req, res, next) => {
  try {
    res.render("dashboard/departments", {
      title: "Departments & categories",
      departmentsList: await departments.allIncludingInactive(),
      categoriesList: await departments.allCategoriesIncludingInactive(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings/departments", verifyCsrf, async (req, res, next) => {
  try {
    const result = await departments.create(req.body.name);
    if (result.error) {
      return res.status(400).render("dashboard/departments", {
        title: "Departments & categories",
        departmentsList: await departments.allIncludingInactive(),
        categoriesList: await departments.allCategoriesIncludingInactive(),
        error: result.error,
      });
    }
    res.redirect("/dashboard/settings/departments");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/departments/:id/toggle", verifyCsrf, async (req, res, next) => {
  try {
    const row = await departments.get(req.params.id);
    if (row) await departments.setActive(row.id, !row.active);
    res.redirect("/dashboard/settings/departments");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/departments/categories", verifyCsrf, async (req, res, next) => {
  try {
    const departmentId = parseInt(req.body.department_id, 10);
    const result = await departments.createCategory(req.body.name, departmentId);
    if (result.error) {
      return res.status(400).render("dashboard/departments", {
        title: "Departments & categories",
        departmentsList: await departments.allIncludingInactive(),
        categoriesList: await departments.allCategoriesIncludingInactive(),
        error: result.error,
      });
    }
    res.redirect("/dashboard/settings/departments");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/departments/categories/:id/toggle", verifyCsrf, async (req, res, next) => {
  try {
    const row = await db.prepare("SELECT active FROM categories WHERE id = ?").get(req.params.id);
    if (row) await departments.setCategoryActive(req.params.id, !row.active);
    res.redirect("/dashboard/settings/departments");
  } catch (err) {
    next(err);
  }
});

// Toggles the approval gate (src/departments.js's categoryRequiresApproval)
// for one category - open to any agent, same as every other toggle on this
// page (only Agents/is_admin management itself is admin-gated, see
// requireAdmin above). Flipping it on doesn't touch any ticket already in
// flight under that category; flipping it off leaves a ticket already
// pending exactly where it is, awaiting an admin's approve/reject.
router.post("/settings/departments/categories/:id/approval-toggle", verifyCsrf, async (req, res, next) => {
  try {
    const row = await db.prepare("SELECT requires_approval FROM categories WHERE id = ?").get(req.params.id);
    if (row) await departments.setCategoryRequiresApproval(req.params.id, !row.requires_approval);
    res.redirect("/dashboard/settings/departments");
  } catch (err) {
    next(err);
  }
});

router.get("/settings/custom-fields", async (req, res, next) => {
  try {
    res.render("dashboard/custom-fields", {
      title: "Custom fields",
      definitions: await customFields.allDefinitions(),
      categories: await departments.categoryNames(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings/custom-fields", verifyCsrf, async (req, res, next) => {
  try {
    const { category, field_name } = req.body;
    if (!(await departments.isValidCategoryName(category))) {
      return res.status(400).render("dashboard/custom-fields", {
        title: "Custom fields",
        definitions: await customFields.allDefinitions(),
        categories: await departments.categoryNames(),
        error: "Choose a valid category.",
      });
    }
    const result = await customFields.create(category, field_name);
    if (result.error) {
      return res.status(400).render("dashboard/custom-fields", {
        title: "Custom fields",
        definitions: await customFields.allDefinitions(),
        categories: await departments.categoryNames(),
        error: result.error,
      });
    }
    res.redirect("/dashboard/settings/custom-fields");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/custom-fields/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await customFields.remove(req.params.id);
    res.redirect("/dashboard/settings/custom-fields");
  } catch (err) {
    next(err);
  }
});

router.get("/settings/automation", async (req, res, next) => {
  try {
    res.render("dashboard/automation", {
      title: "Automation rules",
      rules: await automation.all(),
      categories: await departments.categoryNames(),
      priorities: PRIORITIES,
      agents: await db.prepare("SELECT id, name FROM agents WHERE active = 1 ORDER BY name").all(),
      departmentsList: await departments.all(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings/automation", verifyCsrf, async (req, res, next) => {
  try {
    const result = await automation.create(req.body);
    if (result.error) {
      return res.status(400).render("dashboard/automation", {
        title: "Automation rules",
        rules: await automation.all(),
        categories: await departments.categoryNames(),
        priorities: PRIORITIES,
        agents: await db.prepare("SELECT id, name FROM agents WHERE active = 1 ORDER BY name").all(),
        departmentsList: await departments.all(),
        error: result.error,
      });
    }
    res.redirect("/dashboard/settings/automation");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/automation/:id/toggle", verifyCsrf, async (req, res, next) => {
  try {
    const row = await db.prepare("SELECT active FROM automation_rules WHERE id = ?").get(req.params.id);
    if (row) await automation.setActive(req.params.id, !row.active);
    res.redirect("/dashboard/settings/automation");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/automation/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await automation.remove(req.params.id);
    res.redirect("/dashboard/settings/automation");
  } catch (err) {
    next(err);
  }
});

async function webhooksForDashboard() {
  return db
    .prepare(
      `SELECT webhooks.*, departments.name AS department_name
       FROM webhooks LEFT JOIN departments ON departments.id = webhooks.department_id
       ORDER BY webhooks.created_at DESC`
    )
    .all();
}

router.get("/settings/webhooks", async (req, res, next) => {
  try {
    res.render("dashboard/webhooks", {
      title: "Webhooks",
      webhooks: await webhooksForDashboard(),
      events: WEBHOOK_EVENTS,
      departmentsList: await departments.all(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings/webhooks", verifyCsrf, async (req, res, next) => {
  try {
    const url = (req.body.url || "").trim();
    const events = Array.isArray(req.body.events) ? req.body.events : req.body.events ? [req.body.events] : [];
    const validEvents = events.filter((e) => WEBHOOK_EVENTS.includes(e));
    const departmentId = req.body.department_id ? parseInt(req.body.department_id, 10) : null;

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      parsedUrl = null;
    }

    if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol) || !validEvents.length) {
      return res.status(400).render("dashboard/webhooks", {
        title: "Webhooks",
        webhooks: await webhooksForDashboard(),
        events: WEBHOOK_EVENTS,
        departmentsList: await departments.all(),
        error: "Enter a valid http(s) URL and choose at least one event.",
      });
    }

    await db
      .prepare("INSERT INTO webhooks (url, events, secret, department_id) VALUES (?, ?, ?, ?)")
      .run(url, validEvents.join(","), generateSecret(), departmentId);
    res.redirect("/dashboard/settings/webhooks");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/webhooks/:id/toggle", verifyCsrf, async (req, res, next) => {
  try {
    await db.prepare("UPDATE webhooks SET active = 1 - active WHERE id = ?").run(req.params.id);
    res.redirect("/dashboard/settings/webhooks");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/webhooks/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await db.prepare("DELETE FROM webhooks WHERE id = ?").run(req.params.id);
    res.redirect("/dashboard/settings/webhooks");
  } catch (err) {
    next(err);
  }
});

router.get("/settings/login-log", async (req, res, next) => {
  try {
    const entries = await db
      .prepare(
        `SELECT login_log.*, agents.name AS agent_name
         FROM login_log
         LEFT JOIN agents ON agents.id = login_log.agent_id
         ORDER BY login_log.created_at DESC
         LIMIT 200`
      )
      .all();
    // Admin actions on another agent's account (today: 2FA resets - see
    // POST /agents/:id/reset-2fa below) shown alongside login attempts on
    // this same page, rather than a separate one - both are "security events
    // involving an agent account" audit trails, and this app already treats
    // this page as the place to look for that.
    const agentActivity = await db
      .prepare(
        `SELECT agent_activity.*, target.name AS target_name, actor.name AS actor_name
         FROM agent_activity
         LEFT JOIN agents target ON target.id = agent_activity.target_agent_id
         LEFT JOIN agents actor ON actor.id = agent_activity.actor_agent_id
         ORDER BY agent_activity.created_at DESC
         LIMIT 200`
      )
      .all();
    res.render("dashboard/login-log", { title: "Login activity", entries, agentActivity });
  } catch (err) {
    next(err);
  }
});

router.get("/settings/holidays", async (req, res, next) => {
  try {
    res.render("dashboard/holidays", {
      title: "Company holidays",
      holidays: await holidays.listHolidays(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings/holidays", verifyCsrf, async (req, res, next) => {
  try {
    const date = (req.body.date || "").trim();
    const name = (req.body.name || "").trim().slice(0, 200);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);

    if (!validDate || !name) {
      return res.status(400).render("dashboard/holidays", {
        title: "Company holidays",
        holidays: await holidays.listHolidays(),
        error: "Enter a valid date and a name for the holiday.",
      });
    }

    await holidays.addHoliday(date, name);
    res.redirect("/dashboard/settings/holidays");
  } catch (err) {
    next(err);
  }
});

router.post("/settings/holidays/:id/delete", verifyCsrf, async (req, res, next) => {
  try {
    await holidays.deleteHoliday(req.params.id);
    res.redirect("/dashboard/settings/holidays");
  } catch (err) {
    next(err);
  }
});

router.get("/settings/asset-sync", async (req, res, next) => {
  try {
    res.render("dashboard/asset-sync", {
      title: "Asset inventory sync",
      enabled: msGraph.isEnabled(),
      runs: await assetSync.recentRuns(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// Manual "sync now" - runs inline (a few hundred list items, well within a
// normal request timeout) rather than kicking off a background job the
// page would need to poll for.
router.post("/settings/asset-sync", verifyCsrf, async (req, res) => {
  try {
    await assetSync.runSync();
  } catch (err) {
    return res.render("dashboard/asset-sync", {
      title: "Asset inventory sync",
      enabled: msGraph.isEnabled(),
      runs: await assetSync.recentRuns(),
      error: err.message,
    });
  }
  res.redirect("/dashboard/settings/asset-sync");
});

// department_name/is_admin are shown (and, below, editable) right on this
// page per item 5 of the multi-department feature: admin is meant to be a
// real, visible role, never a quiet default anyone ends up with.
async function agentsForList() {
  return db
    .prepare(
      `SELECT agents.id, agents.name, agents.email, agents.active, agents.created_at,
              agents.department_id, agents.is_admin, agents.totp_enabled, departments.name AS department_name,
              (SELECT COUNT(*) FROM tickets WHERE assigned_to = agents.id AND status IN ('Open', 'In Progress')) AS open_count
       FROM agents
       LEFT JOIN departments ON departments.id = agents.department_id
       ORDER BY agents.active DESC, agents.name`
    )
    .all();
}

// Agent management (list/create/department/admin/active) is admin-only -
// is_admin is a real, deliberate role (see src/departments.js), not
// something any logged-in agent should be able to grant themselves or
// others via a stray POST.
router.use("/agents", requireAdmin);

router.get("/agents", async (req, res, next) => {
  try {
    const agents = await agentsForList();
    // Directory enrichment (department/job title/phone, see src/directory.js)
    // - looked up in parallel, one per agent, rather than one at a time.
    const profiles = await Promise.all(agents.map((a) => directory.getProfile(a.email)));
    agents.forEach((a, i) => (a.profile = profiles[i]));
    res.render("dashboard/agents", { title: "Agents", agents, departmentsList: await departments.all(), error: null });
  } catch (err) {
    next(err);
  }
});

router.post("/agents", verifyCsrf, async (req, res, next) => {
  try {
    const { name = "", email = "", password = "" } = req.body;
    const normalizedEmail = email.trim().toLowerCase();
    const departmentId = req.body.department_id ? parseInt(req.body.department_id, 10) : null;
    const isAdmin = req.body.is_admin ? 1 : 0;

    const rerender = async (error) =>
      res.status(400).render("dashboard/agents", {
        title: "Agents",
        agents: await agentsForList(),
        departmentsList: await departments.all(),
        error,
      });

    if (!name.trim() || !normalizedEmail || !password) {
      return await rerender("Name, email, and password are all required.");
    }
    if (!EMAIL_RE.test(normalizedEmail)) {
      return await rerender("Enter a valid email address.");
    }
    if (password.length < 8) {
      return await rerender("Password must be at least 8 characters.");
    }
    if (!departmentId || !(await departments.get(departmentId))) {
      return await rerender("Choose a valid department.");
    }
    const existing = await db.prepare("SELECT id FROM agents WHERE email = ?").get(normalizedEmail);
    if (existing) {
      return await rerender("An agent with that email already exists.");
    }

    const passwordHash = bcrypt.hashSync(password, 12);
    await db
      .prepare("INSERT INTO agents (name, email, password_hash, department_id, is_admin) VALUES (?, ?, ?, ?, ?)")
      .run(name.trim(), normalizedEmail, passwordHash, departmentId, isAdmin);

    res.redirect("/dashboard/agents");
  } catch (err) {
    next(err);
  }
});

// Autosubmitting department/admin controls on the Agents table row (see
// views/dashboard/agents.ejs's [data-autosubmit] + field.form.requestSubmit()
// pattern) - saves on change without a separate "Save" click, same UX as an
// inline picker anywhere else in this app.
router.post("/agents/:id/department", verifyCsrf, async (req, res, next) => {
  try {
    const departmentId = req.body.department_id ? parseInt(req.body.department_id, 10) : null;
    if (departmentId && (await departments.get(departmentId))) {
      await db.prepare("UPDATE agents SET department_id = ? WHERE id = ?").run(departmentId, req.params.id);
    }
    res.redirect("/dashboard/agents");
  } catch (err) {
    next(err);
  }
});

router.post("/agents/:id/admin", verifyCsrf, async (req, res, next) => {
  try {
    await db.prepare("UPDATE agents SET is_admin = ? WHERE id = ?").run(req.body.is_admin ? 1 : 0, req.params.id);
    res.redirect("/dashboard/agents");
  } catch (err) {
    next(err);
  }
});

// Deactivated, never deleted (see the comment on the agents table in
// src/db/index.js) - this revokes login and eligibility for new assignments
// and auto-assignment, but keeps their name on everything they've already
// done. Guards against locking the dashboard out entirely: can't deactivate
// yourself, and can't deactivate the last remaining active agent.
router.post("/agents/:id/deactivate", verifyCsrf, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.agentId) {
      return res.status(400).render("dashboard/agents", {
        title: "Agents",
        agents: await agentsForList(),
        departmentsList: await departments.all(),
        error: "You can't deactivate your own account.",
      });
    }

    const activeCountRow = await db.prepare("SELECT COUNT(*) AS c FROM agents WHERE active = 1").get();
    const activeCount = Number(activeCountRow.c);
    const target = await db.prepare("SELECT active FROM agents WHERE id = ?").get(id);
    if (target && target.active && activeCount <= 1) {
      return res.status(400).render("dashboard/agents", {
        title: "Agents",
        agents: await agentsForList(),
        departmentsList: await departments.all(),
        error: "Can't deactivate the last active agent - nobody would be able to log in.",
      });
    }

    await db.prepare("UPDATE agents SET active = 0 WHERE id = ?").run(id);
    res.redirect("/dashboard/agents");
  } catch (err) {
    next(err);
  }
});

router.post("/agents/:id/activate", verifyCsrf, async (req, res, next) => {
  try {
    await db.prepare("UPDATE agents SET active = 1 WHERE id = ?").run(req.params.id);
    res.redirect("/dashboard/agents");
  } catch (err) {
    next(err);
  }
});

// The lost-device case: an agent with 2FA on who can no longer generate
// codes has no self-service way back in (that's the whole point of the
// second factor), so an admin can clear it for them here - same
// "admin is the one deliberate escalation path" reasoning as everywhere
// else is_admin bypasses a normal rule (see src/departments.js). Logged to
// agent_activity (shown on /dashboard/settings/login-log) so it's clear
// after the fact who reset whose 2FA and when - the same audit reasoning as
// ticket_activity/asset_activity, just for agent accounts instead of
// tickets/assets.
router.post("/agents/:id/reset-2fa", verifyCsrf, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const target = await db.prepare("SELECT id, name, totp_enabled FROM agents WHERE id = ?").get(id);
    if (!target) return res.redirect("/dashboard/agents");

    if (target.totp_enabled) {
      await db.prepare("UPDATE agents SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?").run(id);
      await db
        .prepare(`INSERT INTO agent_activity (target_agent_id, actor_agent_id, body) VALUES (?, ?, ?)`)
        .run(id, req.session.agentId, `${res.locals.currentAgent.name} reset two-factor authentication for ${target.name}.`);
    }

    res.redirect("/dashboard/agents");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
