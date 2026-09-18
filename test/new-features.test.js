const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client, adminClient, db;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);
  adminClient = makeClient(app.baseUrl);
  db = app.db;

  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Feature Agent", "feature-agent@example.com", bcrypt.hashSync("correct-password", 4));
  await db
    .prepare("INSERT INTO agents (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)")
    .run("Feature Admin", "feature-admin@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "feature-agent@example.com", password: "correct-password", _csrf: csrf });

  const adminLoginPage = await adminClient.get("/login");
  const adminCsrf = extractCsrf(await adminLoginPage.text());
  await adminClient.postForm("/login", { email: "feature-admin@example.com", password: "correct-password", _csrf: adminCsrf });
});

after(() => app.close());

async function submitTicket(fields) {
  const res = await client.postForm("/", {
    requester_name: "Feature Requester",
    requester_email: "feature-requester@example.com",
    category: "Hardware",
    subject: "Default subject",
    description: "Default description",
    ...fields,
  });
  assert.equal(res.status, 302);
  return res.headers.get("location").match(/confirmation\/(\d+)/)[1];
}

test("GET /healthz reports ok without requiring login", async () => {
  const res = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("asset CSV export includes a header row and the asset's data", async () => {
  const page = await client.get("/dashboard/assets");
  const csrf = extractCsrf(await page.text());
  await client.postForm("/dashboard/assets", { name: "CSV Export Laptop", category: "Laptop", asset_tag: "CSV-1", _csrf: csrf });

  const res = await client.get("/dashboard/assets/export.csv");
  assert.equal(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /^ID,Name,Asset tag/);
  assert.match(csv, /CSV Export Laptop/);
  assert.match(csv, /CSV-1/);
});

test("editing an asset logs one activity line per changed field, not a generic blob", async () => {
  const page = await client.get("/dashboard/assets");
  const csrf = extractCsrf(await page.text());
  const createRes = await client.postForm("/dashboard/assets", { name: "History Laptop", category: "Laptop", _csrf: csrf });
  const assetId = createRes.headers.get("location").match(/assets\/(\d+)/)[1];

  const detailPage = await client.get(`/dashboard/assets/${assetId}`);
  const editCsrf = extractCsrf(await detailPage.text());
  await client.postForm(`/dashboard/assets/${assetId}`, {
    name: "History Laptop",
    category: "Laptop",
    status: "Under Repair",
    location: "Lisbon Office",
    _csrf: editCsrf,
  });

  const html = await (await client.get(`/dashboard/assets/${assetId}`)).text();
  assert.match(html, /Asset created\./);
  assert.match(html, /Status changed from &#34;In Use&#34; to &#34;Under Repair&#34;/);
  assert.match(html, /Location changed from &#34;\(empty\)&#34; to &#34;Lisbon Office&#34;/);
});

test("merging a ticket moves its activity/attachments/tags and redirects future visits", async () => {
  const sourceId = await submitTicket({ subject: "Duplicate report" });
  const targetId = await submitTicket({ subject: "Original report" });

  const sourcePage = await client.get(`/dashboard/tickets/${sourceId}`);
  const csrf = extractCsrf(await sourcePage.text());
  const noteCsrf = csrf;
  await client.postForm(`/dashboard/tickets/${sourceId}/tags`, { tag: "printer", _csrf: noteCsrf });

  const mergeRes = await client.postForm(`/dashboard/tickets/${sourceId}/merge`, {
    target_ticket_id: targetId,
    _csrf: csrf,
  });
  assert.equal(mergeRes.status, 302);
  assert.match(mergeRes.headers.get("location"), new RegExp(`tickets/${targetId}$`));

  const targetHtml = await (await client.get(`/dashboard/tickets/${targetId}`)).text();
  assert.match(targetHtml, new RegExp(`Merged ticket #${sourceId}`));
  assert.match(targetHtml, /printer/); // tag moved over

  const revisit = await client.get(`/dashboard/tickets/${sourceId}`);
  assert.equal(revisit.status, 302);
  assert.match(revisit.headers.get("location"), new RegExp(`tickets/${targetId}\\?merged_from=${sourceId}`));

  const revisitFollowed = await (await client.get(revisit.headers.get("location"))).text();
  assert.match(revisitFollowed, /was merged into this one/);
});

test("a requester checking status (or replying) on a merged-away ticket is transparently redirected to the surviving ticket", async () => {
  const sourceId = await submitTicket({ subject: "Wifi is down again", requester_email: "merge-requester@example.com" });
  const targetId = await submitTicket({ subject: "Wifi is down", requester_email: "merge-requester@example.com" });

  const sourcePage = await client.get(`/dashboard/tickets/${sourceId}`);
  const csrf = extractCsrf(await sourcePage.text());
  await client.postForm(`/dashboard/tickets/${sourceId}/merge`, { target_ticket_id: targetId, _csrf: csrf });

  const statusHtml = await (
    await client.postForm("/status", { ticket_id: sourceId, requester_email: "merge-requester@example.com" })
  ).text();
  assert.match(statusHtml, new RegExp(`Ticket #${sourceId} was merged into this one`));
  assert.match(statusHtml, new RegExp(`Ticket #${targetId}`));

  // Replying against the old (merged-away) ticket number lands the message
  // on the surviving ticket, not on the closed, activity-less one.
  const replyRes = await client.postForm("/status/reply", {
    ticket_id: sourceId,
    requester_email: "merge-requester@example.com",
    message: "Still an issue, following up.",
  });
  assert.equal(replyRes.status, 200);
  const replyHtml = await replyRes.text();
  assert.match(replyHtml, /Still an issue, following up/);

  const targetHtml = await (await client.get(`/dashboard/tickets/${targetId}`)).text();
  assert.match(targetHtml, /Still an issue, following up/);
});

test("saved views: an agent can save, list, and delete their own view; can't delete another agent's", async () => {
  await db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Other Agent", "other-agent@example.com", bcrypt.hashSync("correct-password", 4));
  const otherClient = makeClient(app.baseUrl);
  const otherLoginPage = await otherClient.get("/login");
  const otherCsrf = extractCsrf(await otherLoginPage.text());
  await otherClient.postForm("/login", { email: "other-agent@example.com", password: "correct-password", _csrf: otherCsrf });

  const home = await client.get("/dashboard?status=Open");
  const csrf = extractCsrf(await home.text());
  const saveRes = await client.postForm("/dashboard/views", { name: "My Open Queue", query_string: "status=Open", _csrf: csrf });
  assert.equal(saveRes.status, 302);

  const homeWithView = await (await client.get("/dashboard")).text();
  assert.match(homeWithView, /My Open Queue/);
  const viewId = homeWithView.match(/views\/(\d+)\/delete/)[1];

  // The other agent doesn't see it, and can't delete it.
  const otherHome = await (await otherClient.get("/dashboard")).text();
  assert.doesNotMatch(otherHome, /My Open Queue/);
  await otherClient.postForm(`/dashboard/views/${viewId}/delete`, { _csrf: otherCsrf });
  const stillThere = await (await client.get("/dashboard")).text();
  assert.match(stillThere, /My Open Queue/);

  const deleteRes = await client.postForm(`/dashboard/views/${viewId}/delete`, { _csrf: csrf });
  assert.equal(deleteRes.status, 302);
  const gone = await (await client.get("/dashboard")).text();
  assert.doesNotMatch(gone, /My Open Queue/);
});

test("SLA breach check emails once per breach and clears on reopen", async () => {
  const { checkSlaBreaches } = require("../src/sla");
  const ticketId = await submitTicket({ subject: "Aging urgent ticket" });

  const agentRow = await db.prepare("SELECT id FROM agents WHERE email = ?").get("feature-agent@example.com");
  await db
    .prepare(
      "UPDATE tickets SET priority = 'Urgent', assigned_to = ?, created_at = to_char((now() AT TIME ZONE 'UTC') - INTERVAL '3 days', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?"
    )
    .run(agentRow.id, ticketId);

  const firstRun = await checkSlaBreaches();
  assert.ok(firstRun >= 1);
  let ticket = await db.prepare("SELECT sla_alerted_at FROM tickets WHERE id = ?").get(ticketId);
  assert.ok(ticket.sla_alerted_at);

  // Doesn't alert again on a second pass for the same still-open breach.
  await db.prepare("UPDATE tickets SET sla_alerted_at = 'sentinel' WHERE id = ?").run(ticketId);
  await checkSlaBreaches();
  ticket = await db.prepare("SELECT sla_alerted_at FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.sla_alerted_at, "sentinel");

  // Reopening (via the dashboard status route) clears it so a future breach
  // can alert again.
  await db.prepare("UPDATE tickets SET status = 'Resolved' WHERE id = ?").run(ticketId);
  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await ticketPage.text());
  await client.postForm(`/dashboard/tickets/${ticketId}/status`, { status: "Open", _csrf: csrf });
  ticket = await db.prepare("SELECT sla_alerted_at FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.sla_alerted_at, null);
});

test("dashboard full-text search finds a ticket by a word only in its description", async () => {
  await submitTicket({ subject: "Weird noise", description: "The espresso machine in the kitchen is leaking badly." });

  const res = await client.get("/dashboard?q=espresso");
  const html = await res.text();
  assert.match(html, /Weird noise/);

  // Prefix matching: a partial word still finds it.
  const prefixRes = await client.get("/dashboard?q=espre");
  assert.match(await prefixRes.text(), /Weird noise/);
});

test("image attachments get an inline preview; non-image types refuse one", async () => {
  const formData = new FormData();
  formData.append("requester_name", "Preview Tester");
  formData.append("requester_email", "preview-tester@example.com");
  formData.append("category", "Hardware");
  formData.append("subject", "Broken screen photo");
  formData.append("description", "See attached.");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  formData.append("attachments", new Blob([pngBytes], { type: "image/png" }), "screen.png");
  formData.append("attachments", new Blob(["plain text"], { type: "text/plain" }), "notes.txt");

  const submitRes = await fetch(`${app.baseUrl}/`, { method: "POST", body: formData, redirect: "manual" });
  const ticketId = submitRes.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const statusRes = await client.postForm("/status", { ticket_id: ticketId, requester_email: "preview-tester@example.com" });
  const statusHtml = await statusRes.text();
  assert.match(statusHtml, /attachments\/\d+\/preview\?ticket_id/); // at least one inline preview rendered

  const pngId = (await db.prepare("SELECT id FROM attachments WHERE ticket_id = ? AND original_name = ?").get(ticketId, "screen.png")).id;
  const txtId = (await db.prepare("SELECT id FROM attachments WHERE ticket_id = ? AND original_name = ?").get(ticketId, "notes.txt")).id;

  const previewRes = await client.get(
    `/status/attachments/${pngId}/preview?ticket_id=${ticketId}&requester_email=preview-tester%40example.com`
  );
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers.get("content-type"), "image/png");
  // Content-Disposition now also carries the original filename (see
  // src/attachments.js's streamAttachment, added with the Vercel Blob
  // migration) - "inline" is still the key part under test here.
  assert.match(previewRes.headers.get("content-disposition"), /^inline/);

  const txtPreviewRes = await client.get(
    `/status/attachments/${txtId}/preview?ticket_id=${ticketId}&requester_email=preview-tester%40example.com`
  );
  assert.equal(txtPreviewRes.status, 404);
});

test("GDPR export bundles a requester's tickets; erasure redacts identity, free text, and deletes attachments", async () => {
  const formData = new FormData();
  formData.append("requester_name", "Privacy Person");
  formData.append("requester_email", "privacy-person@example.com");
  formData.append("category", "Other");
  formData.append("subject", "Personal request");
  formData.append("description", "Some personal details here.");
  formData.append("attachments", new Blob(["personal doc"], { type: "text/plain" }), "personal.txt");
  const submitRes = await fetch(`${app.baseUrl}/`, { method: "POST", body: formData, redirect: "manual" });
  const ticketId = submitRes.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await ticketPage.text());
  await client.postForm(`/dashboard/tickets/${ticketId}/note`, { body: "Called the requester about this.", _csrf: csrf });

  // Admin-only (see src/routes/dashboard.js) - export/erase reach every
  // department a requester has a ticket in, not just this one, so this uses
  // adminClient rather than the regular Feature Agent client used above.
  const adminTicketPage = await adminClient.get(`/dashboard/tickets/${ticketId}`);
  const adminCsrf = extractCsrf(await adminTicketPage.text());

  const exportRes = await adminClient.get(`/dashboard/tickets/${ticketId}/privacy/export.json`);
  assert.equal(exportRes.status, 200);
  const bundle = await exportRes.json();
  assert.equal(bundle.requester_email, "privacy-person@example.com");
  assert.equal(bundle.tickets[0].ticket.subject, "Personal request");

  // Attachments live in Vercel Blob (private access - see src/attachments.js),
  // not local disk - existence is checked with blob.head(), which throws
  // BlobNotFoundError once the blob is actually gone.
  const { head: headBlob } = require("@vercel/blob");
  const attachmentRow = await db.prepare("SELECT stored_name FROM attachments WHERE ticket_id = ?").get(ticketId);
  const beforeHead = await headBlob(attachmentRow.stored_name);
  assert.ok(beforeHead);

  const eraseRes = await adminClient.postForm(`/dashboard/tickets/${ticketId}/privacy/erase`, { _csrf: adminCsrf });
  assert.equal(eraseRes.status, 302);

  const erased = await db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(erased.requester_name, "[erased]");
  assert.notEqual(erased.requester_email, "privacy-person@example.com");
  assert.match(erased.description, /erased/);
  assert.ok(erased.data_erased_at);

  const activity = await db.prepare("SELECT body FROM ticket_activity WHERE ticket_id = ? AND type = 'note'").all(ticketId);
  assert.ok(activity.every((a) => /erased/.test(a.body)));

  await assert.rejects(() => headBlob(attachmentRow.stored_name), /BlobNotFoundError|does not exist/);
  const remainingAttachments = await db.prepare("SELECT COUNT(*) c FROM attachments WHERE ticket_id = ?").get(ticketId);
  assert.equal(remainingAttachments.c, 0);
});

test("GDPR export/erase is admin-only, since it reaches every ticket a requester ever filed, not just this one", async () => {
  const ticketId = await submitTicket({ requester_email: "non-admin-privacy-check@example.com" });

  const exportRes = await client.get(`/dashboard/tickets/${ticketId}/privacy/export.json`);
  assert.equal(exportRes.status, 403);

  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await ticketPage.text());
  const eraseRes = await client.postForm(`/dashboard/tickets/${ticketId}/privacy/erase`, { _csrf: csrf });
  assert.equal(eraseRes.status, 403);

  // Nothing actually happened - the ticket is untouched.
  const ticket = await db.prepare("SELECT requester_email, data_erased_at FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.requester_email, "non-admin-privacy-check@example.com");
  assert.equal(ticket.data_erased_at, null);

  // The ticket page itself shouldn't even offer the Export/Erase buttons to
  // a non-admin.
  assert.doesNotMatch(await ticketPage.text(), /privacy\/export\.json|privacy\/erase/);
});

test("Portuguese language toggle translates the public request form", async () => {
  const enPage = await client.get("/");
  assert.match(await enPage.text(), /Submit a request/);

  const ptClient = makeClient(app.baseUrl);
  const langRes = await ptClient.get("/lang/pt", { redirect: "manual" });
  assert.equal(langRes.status, 302);

  const ptPage = await ptClient.get("/");
  const ptHtml = await ptPage.text();
  assert.match(ptHtml, /Enviar um pedido/);
  assert.doesNotMatch(ptHtml, /Submit a request/);
});
