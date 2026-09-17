const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const departments = require("../departments");
const { t } = require("../i18n");
const { sendTicketCreatedEmail, sendAgentNotifiedOfReply, sendLowRatingEscalation } = require("../mailer");
const { triggerWebhooks } = require("../webhooks");
const assets = require("../assets");
const kb = require("../kb");
const customFields = require("../custom-fields");
const automation = require("../automation");
const notifications = require("../notifications");
const {
  ATTACHMENTS_DIR,
  SAFE_PREVIEW_TYPES,
  handleUpload,
  saveAttachments,
  deleteUploadedFiles,
  attachmentsForTicket,
  getPublicAttachment,
  formatSize,
  LIMITS_HINT,
} = require("../attachments");
const { verifyCsrf } = require("../middleware/csrf");
const msSso = require("../msSso");

const router = express.Router();

// Whether submitting a ticket requires signing in with Microsoft first
// (see src/msSso.js) - deliberately the SAME flag that turns on agent SSO,
// not a separate one: there's only one Entra app registration either way,
// and requiring requester sign-in when Microsoft isn't even configured
// would leave the public form permanently unusable. When this is false
// (the default, and always true in this app's own test suite, which never
// sets MS_* env vars), the form behaves exactly as it always has -
// freely-typed name/email, no sign-in.
function requesterSsoRequired() {
  return msSso.isEnabled();
}

// Same gate for /status and /kb - redirects to "/" (which shows the
// sign-in landing page, or the request form if already signed in) rather
// than duplicating a second landing page for each section. A no-op when
// SSO isn't configured, same as requesterSsoRequired() above.
function requireRequesterSession(req, res, next) {
  if (requesterSsoRequired() && !req.session.requester) {
    return res.redirect("/");
  }
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Both of these are unauthenticated and now touch either disk (file uploads)
// or a brute-forceable ticket_id + email pair, so both get the same kind of
// per-IP limiter the login form already has.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests submitted from this network. Please wait a few minutes and try again.",
});

const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many status checks from this network. Please wait a few minutes and try again.",
});

// Separate, more generous limiter for inline previews: a single ticket page
// with a few image attachments fires one request per thumbnail just by
// being viewed, which would burn through statusLimiter's budget in one page
// load if it shared the same counter.
const previewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many preview requests from this network. Please wait a few minutes and try again.",
});

// A flat, cross-category suggestion list for the subcategory field's
// datalist (e.g. "Printer" typed once under Hardware shows up as a
// suggestion later too) - convenience only, subcategory itself stays
// freeform text, not a fixed enum like category.
async function subcategorySuggestions() {
  const rows = await db
    .prepare("SELECT DISTINCT subcategory FROM tickets WHERE subcategory IS NOT NULL AND subcategory != '' ORDER BY subcategory LIMIT 100")
    .all();
  return rows.map((r) => r.subcategory);
}

// "Sign in with Microsoft" for requesters (see src/msSso.js) - a separate
// flow from agent login in src/routes/auth.js, sharing the same Entra app
// registration and client but its own callback redirect URI. Any
// successfully authenticated velv.pt account is accepted here - unlike
// agent login, there's no allow-list, since any employee should be able to
// file a ticket.
router.get("/auth/microsoft/requester", async (req, res, next) => {
  if (!msSso.isEnabled()) return res.status(404).render("error", { title: "Not found", message: "Not found." });
  try {
    res.redirect(await msSso.buildAuthUrl(req, "requester"));
  } catch (err) {
    next(err);
  }
});

router.get("/auth/microsoft/requester/callback", async (req, res) => {
  if (!msSso.isEnabled()) return res.status(404).render("error", { title: "Not found", message: "Not found." });
  try {
    const account = await msSso.handleCallback(req, "requester");
    req.session.requester = { email: account.email, name: account.name };
    res.redirect("/");
  } catch (err) {
    res.status(401).render("public/request-landing", { title: t(req.lang, "landing_title"), error: "Could not sign in with Microsoft. Please try again." });
  }
});

// Clears the signed-in requester identity (a shared computer, or someone
// filing a follow-up ticket for a colleague) - back to the landing page (if
// SSO is required) to sign in again as someone else.
router.post("/requester/switch", verifyCsrf, (req, res) => {
  delete req.session.requester;
  res.redirect("/");
});

router.get("/", async (req, res, next) => {
  try {
    if (requesterSsoRequired() && !req.session.requester) {
      return res.render("public/request-landing", { title: t(req.lang, "landing_title"), error: null });
    }
    res.render("public/request-form", {
      title: t(req.lang, "submit_request_title"),
      categories: await departments.categoriesByDepartment(),
      assets: await assets.assignable(),
      customFieldsByCategory: await customFields.byCategory(),
      subcategorySuggestions: await subcategorySuggestions(),
      errors: [],
      values: {},
      uploadHint: LIMITS_HINT,
      requester: req.session.requester || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", submitLimiter, handleUpload("attachments"), async (req, res, next) => {
  try {
  if (requesterSsoRequired() && !req.session.requester) {
    deleteUploadedFiles(req.files);
    return res.redirect("/");
  }

  // Once signed in, the requester's name/email come from their verified
  // Microsoft identity, never from the request body - the form doesn't
  // even render those as editable inputs in that case (see
  // views/public/request-form.ejs), but the server has to enforce this
  // independently regardless of what the client actually sends, since a
  // tampered POST could otherwise still smuggle in a different identity.
  const {
    requester_name: bodyName = "",
    requester_email: bodyEmail = "",
    category = "",
    subcategory = "",
    subject = "",
    description = "",
    asset_id = "",
  } = req.body;
  const requester_name = req.session.requester ? req.session.requester.name : bodyName;
  const requester_email = req.session.requester ? req.session.requester.email : bodyEmail;

  const values = { requester_name, requester_email, category, subcategory, subject, description, asset_id };
  const errors = [];

  if (!requester_name.trim()) errors.push(t(req.lang, "err_name_required"));
  if (!requester_email.trim() || !EMAIL_RE.test(requester_email.trim())) {
    errors.push(t(req.lang, "err_email_invalid"));
  }
  if (!(await departments.isValidCategoryName(category))) errors.push(t(req.lang, "err_category_invalid"));
  if (!subject.trim()) errors.push(t(req.lang, "err_subject_required"));
  if (!description.trim()) errors.push(t(req.lang, "err_description_required"));
  if (subject.length > 200) errors.push(t(req.lang, "err_subject_too_long"));
  if (description.length > 5000) errors.push(t(req.lang, "err_description_too_long"));
  // Asset is optional, but if one was picked it has to be real - not just
  // any parseable integer, since this is the one field on this form a
  // client could otherwise use to link a ticket to an arbitrary asset id.
  const assetId = asset_id ? parseInt(asset_id, 10) : null;
  if (assetId && !(await assets.get(assetId))) errors.push(t(req.lang, "err_asset_invalid"));
  if (req.uploadError) errors.push(req.uploadError);

  if (errors.length) {
    deleteUploadedFiles(req.files);
    return res.status(400).render("public/request-form", {
      title: t(req.lang, "submit_request_title"),
      categories: await departments.categoriesByDepartment(),
      assets: await assets.assignable(),
      customFieldsByCategory: await customFields.byCategory(),
      subcategorySuggestions: await subcategorySuggestions(),
      errors,
      values,
      uploadHint: LIMITS_HINT,
      requester: req.session.requester || null,
    });
  }

  // Priority isn't the requester's call - it's triaged by the helpdesk team
  // (see the Priority card on the dashboard ticket page). Every new ticket
  // starts at the tickets.priority column's default ('Medium') until an
  // agent changes it.
  //
  // Auto-assigned to whichever active agent IN THIS TICKET'S DEPARTMENT
  // currently has the fewest open (Open/In Progress) tickets, rather than
  // left Unassigned - a simple self-balancing rotation rather than a strict
  // round-robin counter (no extra state to keep in sync, and it
  // self-corrects if someone's away). Scoped to the category's own
  // department (not admins, who are overseers rather than frontline
  // assignees for this purpose) so a ticket never auto-lands on someone
  // outside the department it was actually filed under. Falls back to
  // Unassigned if there are no active agents in that department at all,
  // rather than reaching into a different one.
  const ticketDepartmentId = await departments.departmentIdForCategory(category);
  const nextAssignee = await db
    .prepare(
      `SELECT agents.id FROM agents
       LEFT JOIN tickets ON tickets.assigned_to = agents.id AND tickets.status IN ('Open', 'In Progress')
       WHERE agents.active = 1 AND agents.is_admin = 0 AND agents.department_id = ?
       GROUP BY agents.id
       ORDER BY COUNT(tickets.id) ASC, agents.id ASC
       LIMIT 1`
    )
    .get(ticketDepartmentId);

  const result = await db
    .prepare(
      `INSERT INTO tickets (subject, description, category, subcategory, requester_name, requester_email, assigned_to, asset_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      subject.trim(),
      description.trim(),
      category,
      subcategory.trim().slice(0, 100) || null,
      requester_name.trim(),
      requester_email.trim().toLowerCase(),
      nextAssignee ? nextAssignee.id : null,
      assetId
    );

  if (nextAssignee) {
    await db
      .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'assignment', ?)`)
      .run(result.lastInsertRowid, "Auto-assigned on creation.");
  }

  // Runs after auto-assignment above, so a rule's own assignment action (if
  // any) is a deliberate override of the round-robin pick, not a race with it.
  await automation.applyRules(result.lastInsertRowid, { category, subject: subject.trim(), description: description.trim() });

  await customFields.saveSubmittedCustomFields(result.lastInsertRowid, category, req.body);

  await saveAttachments({ ticketId: result.lastInsertRowid, files: req.files, uploadedBy: "requester" });

  // Fire-and-forget: email delivery (or a missing/misconfigured SMTP setup)
  // must never hold up or fail the requester's redirect to their confirmation.
  sendTicketCreatedEmail({
    to: requester_email.trim().toLowerCase(),
    ticketId: result.lastInsertRowid,
    subject: subject.trim(),
  }).catch((err) => console.error("Could not send ticket-created email:", err.message));

  triggerWebhooks(
    "ticket.created",
    {
      ticket_id: result.lastInsertRowid,
      subject: subject.trim(),
      category,
      requester_email: requester_email.trim().toLowerCase(),
    },
    ticketDepartmentId
  );

  res.redirect(`/confirmation/${result.lastInsertRowid}`);
  } catch (err) {
    next(err);
  }
});

router.get("/confirmation/:id", async (req, res, next) => {
  try {
    const ticket = await db.prepare("SELECT id, subject, status, created_at FROM tickets WHERE id = ?").get(req.params.id);
    if (!ticket) return res.redirect("/");
    // Attachment names only, no download links: unlike /status, this page has no
    // ownership check (it's a plain post-submit redirect target), so it must not
    // hand out a way to fetch file contents to anyone who can guess a ticket id.
    const attachments = await attachmentsForTicket(ticket.id, { requesterVisibleOnly: true });
    res.render("public/confirmation", { title: "Request submitted", ticket, attachments });
  } catch (err) {
    next(err);
  }
});

// The requester-visible half of a ticket's conversation: agent replies
// (type 'reply') and the requester's own past replies - never internal
// notes or system events, which is the whole reason 'reply' exists as its
// own type separate from 'note' (see src/db/index.js).
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

router.get("/status", requireRequesterSession, (req, res) => {
  res.render("public/status-check", {
    title: t(req.lang, "check_status_title"),
    ticket: null,
    attachments: [],
    conversation: [],
    error: null,
    mergedNotice: null,
    requester: req.session.requester || null,
  });
});

router.post("/status", statusLimiter, requireRequesterSession, async (req, res, next) => {
  try {
    const { ticket_id = "" } = req.body;
    const id = parseInt(ticket_id, 10);
    // Once signed in, "the email used to submit it" is the verified session
    // identity, not a re-typed field - the view doesn't even render that
    // input in that case (see views/public/status-check.ejs).
    const requesterEmail = req.session.requester ? req.session.requester.email : (req.body.requester_email || "").trim().toLowerCase();

    if (!id || !requesterEmail) {
      return res.render("public/status-check", {
        title: t(req.lang, "check_status_title"),
        ticket: null,
        attachments: [],
        conversation: [],
        error: t(req.lang, "err_status_missing_fields"),
        mergedNotice: null,
        requester: req.session.requester || null,
      });
    }

    const ticket = await db
      .prepare(
        `SELECT id, subject, description, category, priority, status, created_at, updated_at, requester_email, merged_into_id
         FROM tickets WHERE id = ? AND requester_email = ?`
      )
      .get(id, requesterEmail);

    if (!ticket) {
      return res.render("public/status-check", {
        title: t(req.lang, "check_status_title"),
        ticket: null,
        attachments: [],
        conversation: [],
        error: t(req.lang, "err_status_not_found"),
        mergedNotice: null,
        requester: req.session.requester || null,
      });
    }

    // An agent may have since merged this ticket into another one (see
    // /tickets/:id/merge in dashboard.js) - the requester typed a number that
    // still exists and is still theirs, it just isn't where the conversation
    // lives anymore. Transparently show them the surviving ticket instead of
    // a stale, activity-less Closed ticket, same as the dashboard does for an
    // agent who opens the merged-away ticket's own URL.
    if (ticket.merged_into_id) {
      const target = await db
        .prepare(
          `SELECT id, subject, description, category, priority, status, created_at, updated_at, requester_email
           FROM tickets WHERE id = ? AND requester_email = ?`
        )
        .get(ticket.merged_into_id, requesterEmail);

      if (!target) {
        // The merge target belongs to a different requester (an agent merged
        // across two different people's tickets) - nothing to redirect them
        // into, so just tell them where their conversation went.
        return res.render("public/status-check", {
          title: t(req.lang, "check_status_title"),
          ticket: null,
          attachments: [],
          conversation: [],
          error: t(req.lang, "status_merged_elsewhere", ticket.merged_into_id),
          mergedNotice: null,
          requester: req.session.requester || null,
        });
      }

      const targetAttachments = await attachmentsForTicket(target.id, { requesterVisibleOnly: true });
      return res.render("public/status-check", {
        title: t(req.lang, "check_status_title"),
        ticket: target,
        attachments: targetAttachments.map((a) => ({
          ...a,
          size_label: formatSize(a.size_bytes),
          is_previewable: SAFE_PREVIEW_TYPES.has(a.mime_type),
        })),
        conversation: await conversationForTicket(target.id),
        error: null,
        mergedNotice: t(req.lang, "status_merged_notice", ticket.id),
        requester: req.session.requester || null,
      });
    }

    const ticketAttachments = await attachmentsForTicket(ticket.id, { requesterVisibleOnly: true });
    res.render("public/status-check", {
      title: t(req.lang, "check_status_title"),
      ticket,
      attachments: ticketAttachments.map((a) => ({
        ...a,
        size_label: formatSize(a.size_bytes),
        is_previewable: SAFE_PREVIEW_TYPES.has(a.mime_type),
      })),
      conversation: await conversationForTicket(ticket.id),
      error: null,
      mergedNotice: null,
      requester: req.session.requester || null,
    });
  } catch (err) {
    next(err);
  }
});

// Same ownership check as everything else on /status (ticket id + the exact
// requester email on file). If the ticket was Resolved or Closed, a reply
// reopens it - the requester replying at all is a pretty strong signal it
// isn't actually done, same as every major helpdesk tool does.
router.post("/status/reply", statusLimiter, requireRequesterSession, async (req, res, next) => {
  try {
    const { ticket_id = "", message = "" } = req.body;
    const id = parseInt(ticket_id, 10);
    // Once signed in, use the verified session identity rather than trusting
    // whatever the form's hidden requester_email field carried - it's always
    // supposed to already match (the view fills it from the found ticket's
    // own row), but the server enforces this independently regardless of
    // what a tampered request actually sends.
    const email = req.session.requester ? req.session.requester.email : (req.body.requester_email || "").trim().toLowerCase();

    let ticket = await db.prepare("SELECT * FROM tickets WHERE id = ? AND requester_email = ?").get(id, email);
    if (!ticket) {
      return res.status(404).render("error", { title: "Not found", message: "That ticket does not exist." });
    }

    // Same merge redirect as GET/POST /status above - a reply typed against a
    // ticket number that's since been merged away should land on the ticket
    // that's actually still active, not on a Closed ticket no agent is
    // looking at anymore.
    let mergedNotice = null;
    if (ticket.merged_into_id) {
      const target = await db.prepare("SELECT * FROM tickets WHERE id = ? AND requester_email = ?").get(ticket.merged_into_id, email);
      if (!target) {
        return res.status(404).render("error", {
          title: "Ticket merged",
          message: `This ticket was merged into ticket #${ticket.merged_into_id}. Please check its status using that ticket number instead.`,
        });
      }
      mergedNotice = t(req.lang, "status_merged_notice", ticket.id);
      ticket = target;
    }

    const body = message.trim().slice(0, 5000);
    if (!body) {
      const attachments = await attachmentsForTicket(ticket.id, { requesterVisibleOnly: true });
      return res.render("public/status-check", {
        title: t(req.lang, "check_status_title"),
        ticket,
        attachments: attachments.map((a) => ({
          ...a,
          size_label: formatSize(a.size_bytes),
          is_previewable: SAFE_PREVIEW_TYPES.has(a.mime_type),
        })),
        conversation: await conversationForTicket(ticket.id),
        error: t(req.lang, "err_reply_empty"),
        mergedNotice,
        requester: req.session.requester || null,
      });
    }

    await db
      .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'requester_reply', ?)`)
      .run(ticket.id, body);

    if (["Resolved", "Closed"].includes(ticket.status)) {
      // Same approval reset as the agent-driven reopen path in dashboard.js's
      // applyStatusChange: a ticket that was approved and closed, then
      // reopened (here, by the requester replying), needs a fresh approval
      // before it can close again rather than sailing through on last time's.
      await db
        .prepare(
          "UPDATE tickets SET status = 'Open', updated_at = now_text(), sla_alerted_at = NULL, approval_status = NULL, approval_note = NULL WHERE id = ?"
        )
        .run(ticket.id);
      await db
        .prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'status_change', ?)`)
        .run(ticket.id, `Status changed from "${ticket.status}" to "Open" (reopened by requester reply).`);
    } else {
      await db.prepare("UPDATE tickets SET updated_at = now_text() WHERE id = ?").run(ticket.id);
    }

    if (ticket.assigned_to) {
      const agent = await db.prepare("SELECT id, email FROM agents WHERE id = ?").get(ticket.assigned_to);
      sendAgentNotifiedOfReply({
        to: agent && agent.email,
        ticketId: ticket.id,
        subject: ticket.subject,
        message: body,
      }).catch((err) => console.error("Could not send agent-notified-of-reply email:", err.message));
      if (agent) await notifications.create(agent.id, "reply", ticket.id, `The requester replied on ticket #${ticket.id}.`);
    }
    // Watchers get the same nudge as the assignee - "keep me posted" without
    // being the one it's actually assigned to.
    const watchers = await db
      .prepare(
        `SELECT agents.id, agents.email FROM ticket_watchers
         JOIN agents ON agents.id = ticket_watchers.agent_id
         WHERE ticket_watchers.ticket_id = ? AND agents.id != ?`
      )
      .all(ticket.id, ticket.assigned_to || -1);
    for (const watcher of watchers) {
      sendAgentNotifiedOfReply({ to: watcher.email, ticketId: ticket.id, subject: ticket.subject, message: body }).catch((err) =>
        console.error("Could not send watcher-notified-of-reply email:", err.message)
      );
      await notifications.create(watcher.id, "reply", ticket.id, `The requester replied on ticket #${ticket.id} you're watching.`);
    }

    const updated = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id);
    const attachments = await attachmentsForTicket(ticket.id, { requesterVisibleOnly: true });
    res.render("public/status-check", {
      title: t(req.lang, "check_status_title"),
      ticket: updated,
      attachments: attachments.map((a) => ({
        ...a,
        size_label: formatSize(a.size_bytes),
        is_previewable: SAFE_PREVIEW_TYPES.has(a.mime_type),
      })),
      conversation: await conversationForTicket(ticket.id),
      error: null,
      mergedNotice,
      requester: req.session.requester || null,
    });
  } catch (err) {
    next(err);
  }
});

// Downloading a file requires the same proof of ownership as looking the ticket
// up in the first place: the exact requester email on file. Same trust model
// /status already uses, just extended to cover the attachment's bytes too.
router.post("/status/attachments/:attachmentId/download", statusLimiter, requireRequesterSession, async (req, res, next) => {
  try {
    const { ticket_id = "" } = req.body;
    const id = parseInt(ticket_id, 10);
    const requesterEmail = req.session.requester ? req.session.requester.email : (req.body.requester_email || "").trim().toLowerCase();

    const ticket = await db.prepare("SELECT id FROM tickets WHERE id = ? AND requester_email = ?").get(id, requesterEmail);
    if (!ticket) {
      return res.status(404).render("error", { title: "Not found", message: "That attachment does not exist." });
    }

    const attachment = await getPublicAttachment(ticket.id, req.params.attachmentId);
    if (!attachment) {
      return res.status(404).render("error", { title: "Not found", message: "That attachment does not exist." });
    }

    res.download(path.join(ATTACHMENTS_DIR, attachment.stored_name), attachment.original_name);
  } catch (err) {
    next(err);
  }
});

// Same ownership model as the download route above, but GET (an <img> tag
// can't send a POST body) - ticket_id + requester_email travel as query
// params instead. Only ever serves the narrow SAFE_PREVIEW_TYPES subset
// inline; everything else still only ever force-downloads.
router.get("/status/attachments/:attachmentId/preview", previewLimiter, requireRequesterSession, async (req, res, next) => {
  try {
    const id = parseInt(req.query.ticket_id, 10);
    const email = req.session.requester ? req.session.requester.email : (req.query.requester_email || "").trim().toLowerCase();

    const ticket = await db.prepare("SELECT id FROM tickets WHERE id = ? AND requester_email = ?").get(id, email);
    if (!ticket) {
      return res.status(404).render("error", { title: "Not found", message: "That attachment does not exist." });
    }

    const attachment = await getPublicAttachment(ticket.id, req.params.attachmentId);
    if (!attachment || !SAFE_PREVIEW_TYPES.has(attachment.mime_type)) {
      return res.status(404).render("error", { title: "Not found", message: "No preview is available for that attachment." });
    }

    res.setHeader("Content-Type", attachment.mime_type);
    res.setHeader("Content-Disposition", "inline");
    res.sendFile(path.join(ATTACHMENTS_DIR, attachment.stored_name));
  } catch (err) {
    next(err);
  }
});

router.get("/kb", requireRequesterSession, async (req, res, next) => {
  try {
    const { category = "", q = "" } = req.query;
    res.render("public/kb-list", {
      title: "Help center",
      articles: await kb.publishedList({ category, q }),
      filters: { category, q },
      requester: req.session.requester || null,
    });
  } catch (err) {
    next(err);
  }
});

// Live suggestions as a requester types their subject on the request form
// (see public/js/kb-suggest.js) - deflects a ticket that self-service could
// already answer, before it's even submitted. Defined before /kb/:slug so
// Express doesn't match "suggest.json" as a slug first. previewLimiter
// (not statusLimiter) since typing fires one request per keystroke-pause,
// the same "fires repeatedly just from using the page" shape as attachment
// previews, not a handful of deliberate page loads.
router.get("/kb/suggest.json", previewLimiter, async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim().slice(0, 200);
    if (q.length < 3) return res.json([]);
    const results = await kb.publishedList({ q });
    const matches = results.slice(0, 4).map((a) => ({ title: a.title, slug: a.slug }));
    res.json(matches);
  } catch (err) {
    next(err);
  }
});

router.get("/kb/:slug", requireRequesterSession, async (req, res, next) => {
  try {
    const article = await kb.getBySlug(req.params.slug);
    if (!article) {
      return res.status(404).render("error", { title: "Not found", message: "That article doesn't exist or isn't published." });
    }
    res.render("public/kb-article", { title: article.title, article, requester: req.session.requester || null });
  } catch (err) {
    next(err);
  }
});

// Reached via the link in the "ticket resolved" email, not a login - see the
// ticket_ratings comment in src/db/index.js for the trust model this token
// represents (a bearer capability to rate this one ticket, nothing more).
async function getTicketByRatingToken(token) {
  return db.prepare("SELECT id, subject FROM tickets WHERE rating_token = ?").get(token);
}

router.get("/rate/:token", statusLimiter, async (req, res, next) => {
  try {
    const ticket = await getTicketByRatingToken(req.params.token);
    if (!ticket) {
      return res.status(404).render("error", { title: "Not found", message: "That rating link isn't valid." });
    }
    const existing = await db.prepare("SELECT rating FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id);
    res.render("public/rate", {
      title: "Rate your experience",
      ticket,
      token: req.params.token,
      alreadyRated: Boolean(existing),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/rate/:token", statusLimiter, async (req, res, next) => {
  try {
    const ticket = await getTicketByRatingToken(req.params.token);
    if (!ticket) {
      return res.status(404).render("error", { title: "Not found", message: "That rating link isn't valid." });
    }

    const existing = await db.prepare("SELECT rating FROM ticket_ratings WHERE ticket_id = ?").get(ticket.id);
    if (existing) {
      return res.render("public/rate", {
        title: "Rate your experience",
        ticket,
        token: req.params.token,
        alreadyRated: true,
        error: null,
      });
    }

    const rating = parseInt(req.body.rating, 10);
    if (!(rating >= 1 && rating <= 5)) {
      return res.status(400).render("public/rate", {
        title: "Rate your experience",
        ticket,
        token: req.params.token,
        alreadyRated: false,
        error: "Choose a rating from 1 to 5 stars.",
      });
    }

    const comment = (req.body.comment || "").trim().slice(0, 2000);
    await db.prepare("INSERT INTO ticket_ratings (ticket_id, rating, comment) VALUES (?, ?, ?)").run(ticket.id, rating, comment || null);

    // A 1-2 star rating just sitting in the database is easy to miss - flag
    // it to the whole active team the moment it comes in, the same "no
    // single natural recipient" reasoning as the warranty digest.
    if (rating <= 2) {
      const activeAgents = await db.prepare("SELECT id, email FROM agents WHERE active = 1").all();
      for (const agent of activeAgents) {
        sendLowRatingEscalation({ to: agent.email, ticketId: ticket.id, subject: ticket.subject, rating, comment }).catch((err) =>
          console.error("Could not send low-rating escalation email:", err.message)
        );
        await notifications.create(agent.id, "low_rating", ticket.id, `Ticket #${ticket.id} just got a ${rating}-star rating.`);
      }
    }

    res.render("public/rate", { title: "Rate your experience", ticket, alreadyRated: true, error: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
