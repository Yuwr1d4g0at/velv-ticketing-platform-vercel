// Feature 1: Legal contract-expiry reminders (src/contractReminders.js),
// mirroring src/warranty.js's already-shipped pattern: an idempotent alert
// that fires once and can fire again if the underlying date changes - see
// that test's shape in test/second-batch.test.js.
//
// Feature 2: the HR onboarding checklist that spawns cross-department
// tickets (src/checklists.js). The critical thing to prove here isn't just
// "tickets get created" - it's that spawned tickets are strict, ordinary,
// department-scoped tickets like any other: an IT ticket spawned by an HR
// template is visible to IT agents and invisible to HR agents (beyond the
// existing Link feature's own id/subject/status leak - see below), exactly
// the same as if it had been filed directly into IT. This is the same
// visibility boundary test/multi-department.test.js exists to guard, so
// this file leans on the same "assert what's visible AND what's not"
// shape rather than only checking the happy path.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, db, hrClient, itClient, marketingClient, legalClient;

async function loginAs(c, email) {
  const loginPage = await c.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await c.postForm("/login", { email, password: "correct-password", _csrf: csrf });
}

before(async () => {
  app = await startTestApp();
  db = app.db;
  const passwordHash = bcrypt.hashSync("correct-password", 4);

  // IT=1, HR=2, Legal=3, Marketing=4 - seeded in that fixed order by
  // src/db/index.js on a fresh database (see DEFAULT_DEPARTMENTS there),
  // same assumption test/multi-department.test.js already relies on.
  const insertAgent = db.prepare("INSERT INTO agents (name, email, password_hash, department_id) VALUES (?, ?, ?, ?)");
  await insertAgent.run("IT Agent", "it-agent@domain-automation.example.com", passwordHash, 1);
  await insertAgent.run("HR Agent", "hr-agent@domain-automation.example.com", passwordHash, 2);
  await insertAgent.run("Legal Agent", "legal-agent@domain-automation.example.com", passwordHash, 3);
  await insertAgent.run("Marketing Agent", "marketing-agent@domain-automation.example.com", passwordHash, 4);

  hrClient = makeClient(app.baseUrl);
  itClient = makeClient(app.baseUrl);
  legalClient = makeClient(app.baseUrl);
  marketingClient = makeClient(app.baseUrl);
  await loginAs(hrClient, "hr-agent@domain-automation.example.com");
  await loginAs(itClient, "it-agent@domain-automation.example.com");
  await loginAs(legalClient, "legal-agent@domain-automation.example.com");
  await loginAs(marketingClient, "marketing-agent@domain-automation.example.com");
});

after(() => app.close());

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test("contract reminder check emails a ticket's own department once, and a date change lets it alert again", async () => {
  const { checkContractReminders } = require("../src/contractReminders");

  // File a Legal ticket as the Legal agent, then set a soon-approaching
  // reminder date via the new /tickets/:id/reminder property row.
  const newTicketPage = await legalClient.get("/dashboard/tickets/new");
  const newCsrf = extractCsrf(await newTicketPage.text());
  const createRes = await legalClient.postForm("/dashboard/tickets/new", {
    requester_name: "Vendor Co",
    requester_email: "vendor@example.com",
    category: "Contract Review",
    subject: "Vendor contract renewal",
    description: "Annual vendor contract up for renewal.",
    priority: "Medium",
    _csrf: newCsrf,
  });
  assert.equal(createRes.status, 302);
  const ticketId = createRes.headers.get("location").match(/tickets\/(\d+)/)[1];

  const detailPage = await legalClient.get(`/dashboard/tickets/${ticketId}`);
  const detailCsrf = extractCsrf(await detailPage.text());
  await legalClient.postForm(`/dashboard/tickets/${ticketId}/reminder`, {
    reminder_date: isoDaysFromNow(5),
    _csrf: detailCsrf,
  });

  const firstRun = await checkContractReminders();
  assert.ok(firstRun >= 1);
  let ticket = await db.prepare("SELECT reminder_alerted_at FROM tickets WHERE id = ?").get(ticketId);
  assert.ok(ticket.reminder_alerted_at);

  const secondRun = await checkContractReminders();
  assert.equal(secondRun, 0); // already alerted, not re-sent

  // Renewing the reminder date clears the alert flag so it can fire again -
  // the same idea, and the same route shape, as assets.js's warranty_expires
  // update clearing warranty_alerted_at.
  const detailPage2 = await legalClient.get(`/dashboard/tickets/${ticketId}`);
  const editCsrf = extractCsrf(await detailPage2.text());
  await legalClient.postForm(`/dashboard/tickets/${ticketId}/reminder`, {
    reminder_date: isoDaysFromNow(400),
    _csrf: editCsrf,
  });
  ticket = await db.prepare("SELECT reminder_alerted_at FROM tickets WHERE id = ?").get(ticketId);
  assert.equal(ticket.reminder_alerted_at, null);
});

test("contract reminder field is generic - not restricted to Legal categories at the DB/route level", async () => {
  const ticketPage = await itClient.get("/dashboard/tickets/new");
  const csrf = extractCsrf(await ticketPage.text());
  const createRes = await itClient.postForm("/dashboard/tickets/new", {
    requester_name: "Some Requester",
    requester_email: "req@example.com",
    category: "Hardware",
    subject: "IT ticket with a reminder date",
    description: "Not a contract, but the field is generic.",
    priority: "Medium",
    _csrf: csrf,
  });
  const ticketId = createRes.headers.get("location").match(/tickets\/(\d+)/)[1];
  const detailPage = await itClient.get(`/dashboard/tickets/${ticketId}`);
  const detailCsrf = extractCsrf(await detailPage.text());
  const res = await itClient.postForm(`/dashboard/tickets/${ticketId}/reminder`, {
    reminder_date: isoDaysFromNow(10),
    _csrf: detailCsrf,
  });
  assert.equal(res.status, 302);
  const ticket = await db.prepare("SELECT reminder_date FROM tickets WHERE id = ?").get(ticketId);
  assert.ok(ticket.reminder_date);
});

test("HR onboarding template spawns correctly-departmented IT and Marketing tickets, linked back to the HR ticket", async () => {
  // HR defines the "New Hire Onboarding" template with two spawn-flagged
  // checklist items (IT + Marketing) and one plain line.
  const templatesPage = await hrClient.get("/dashboard/templates");
  const templatesCsrf = extractCsrf(await templatesPage.text());
  await hrClient.postForm("/dashboard/templates", {
    name: "New Hire Onboarding",
    category: "Onboarding",
    subject: "New hire onboarding for {name}",
    description: "Full onboarding checklist for the new hire.",
    _csrf: templatesCsrf,
  });
  const template = await db.prepare("SELECT id FROM ticket_templates WHERE name = 'New Hire Onboarding'").get();

  async function addItem(label, spawnCategory) {
    const page = await hrClient.get("/dashboard/templates");
    const csrf = extractCsrf(await page.text());
    const res = await hrClient.postForm(`/dashboard/templates/${template.id}/checklist-items`, {
      label,
      spawn_category: spawnCategory || "",
      _csrf: csrf,
    });
    assert.equal(res.status, 302);
  }
  await addItem("Send welcome packet to {name}", ""); // plain checklist line
  await addItem("Configure PC for {name}", "Hardware"); // spawns an IT ticket
  await addItem("Create profile picture for {name}", "Brand Assets"); // spawns a Marketing ticket

  const items = await db.prepare("SELECT * FROM template_checklist_items WHERE template_id = ?").all(template.id);
  assert.equal(items.length, 3);
  assert.equal(items.filter((i) => i.spawn_category).length, 2);

  // HR uses the template via the normal ?template= flow, exactly like any
  // other template, then submits with the new hire's name as the requester.
  const prefilled = await (await hrClient.get(`/dashboard/tickets/new?template=${template.id}`)).text();
  assert.match(prefilled, /Configure PC for \[name\]|Configure PC for/); // spawn preview hint rendered
  const newCsrf = extractCsrf(prefilled);
  const createRes = await hrClient.postForm("/dashboard/tickets/new", {
    requester_name: "Jane Newhire",
    requester_email: "jane.newhire@example.com",
    category: "Onboarding",
    subject: "New hire onboarding for Jane Newhire",
    description: "Full onboarding checklist for the new hire.",
    priority: "Medium",
    template_id: String(template.id),
    _csrf: newCsrf,
  });
  assert.equal(createRes.status, 302);
  const hrTicketId = createRes.headers.get("location").match(/tickets\/(\d+)/)[1];

  // Exactly two tickets were spawned (the plain checklist line spawns
  // nothing), each a real, ordinary ticket in its own department's category.
  const itTicket = await db.prepare("SELECT * FROM tickets WHERE subject = 'Configure PC for Jane Newhire'").get();
  const marketingTicket = await db.prepare("SELECT * FROM tickets WHERE subject = 'Create profile picture for Jane Newhire'").get();
  assert.ok(itTicket, "IT ticket should have been spawned with the substituted name");
  assert.ok(marketingTicket, "Marketing ticket should have been spawned with the substituted name");
  assert.equal(itTicket.category, "Hardware");
  assert.equal(marketingTicket.category, "Brand Assets");
  assert.equal(itTicket.requester_email, "jane.newhire@example.com");
  const welcomeCount = await db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE subject LIKE 'Send welcome packet%'").get();
  assert.equal(welcomeCount.c, 0);

  // Visibility: this is the core assertion. The spawned IT ticket is
  // visible to the IT agent exactly like any other IT ticket...
  const itList = await (await itClient.get("/dashboard")).text();
  assert.match(itList, new RegExp(`tickets/${itTicket.id}"`));
  const itDetail = await itClient.get(`/dashboard/tickets/${itTicket.id}`);
  assert.equal(itDetail.status, 200);

  // ...and the spawned Marketing ticket is visible to the Marketing agent...
  const marketingDetail = await marketingClient.get(`/dashboard/tickets/${marketingTicket.id}`);
  assert.equal(marketingDetail.status, 200);

  // ...but NOT to HR, beyond the existing Link feature's own id/subject/
  // status surface on the origin ticket's page (see below) - opening the
  // spawned ticket directly still 404s for HR, same strict department-only
  // visibility as every other cross-department ticket.
  const hrOpensIt = await hrClient.get(`/dashboard/tickets/${itTicket.id}`);
  assert.equal(hrOpensIt.status, 404);
  const hrOpensMarketing = await hrClient.get(`/dashboard/tickets/${marketingTicket.id}`);
  assert.equal(hrOpensMarketing.status, 404);

  // And the reverse: IT/Marketing agents can't see each other's spawned
  // ticket, or the HR origin ticket, either - spawning didn't create any
  // shared-visibility record.
  assert.equal((await itClient.get(`/dashboard/tickets/${marketingTicket.id}`)).status, 404);
  assert.equal((await itClient.get(`/dashboard/tickets/${hrTicketId}`)).status, 404);
  assert.equal((await marketingClient.get(`/dashboard/tickets/${hrTicketId}`)).status, 404);

  // The spawned tickets are linked back to the origin using the app's
  // existing cross-department Link feature (ticket_links), stored
  // symmetrically like every other link.
  const links = await db.prepare("SELECT ticket_id, linked_ticket_id FROM ticket_links WHERE ticket_id = ?").all(hrTicketId);
  const linkedIds = links.map((l) => l.linked_ticket_id).sort((a, b) => a - b);
  assert.deepEqual(linkedIds.sort((a, b) => a - b), [itTicket.id, marketingTicket.id].sort((a, b) => a - b));

  // NOTE / pre-existing behavior flagged, not fixed here: the HR agent's
  // own ticket page DOES show the linked tickets' subject/status (Link's
  // own linkedTickets query has no department filter - see
  // src/checklists.js's header comment). That's Link's existing, already-
  // shipped display behavior, unchanged by this feature; asserted here so
  // a future change to Link's own visibility is a deliberate decision, not
  // an accidental regression of this assertion.
  const hrTicketDetail = await (await hrClient.get(`/dashboard/tickets/${hrTicketId}`)).text();
  assert.match(hrTicketDetail, /Configure PC for Jane Newhire/);
  assert.match(hrTicketDetail, /Create profile picture for Jane Newhire/);
});

test("template spawns are only applied when the submitted category matches the template's own category", async () => {
  // A crafted/stale template_id whose own category doesn't match the
  // category actually being filed under must not spawn anything - see the
  // "template.category === category" guard in the /tickets/new POST route.
  const template = await db.prepare("SELECT id FROM ticket_templates WHERE name = 'New Hire Onboarding'").get();
  const before = (await db.prepare("SELECT COUNT(*) AS c FROM tickets").get()).c;

  const page = await itClient.get("/dashboard/tickets/new");
  const csrf = extractCsrf(await page.text());
  const res = await itClient.postForm("/dashboard/tickets/new", {
    requester_name: "Mismatch Test",
    requester_email: "mismatch@example.com",
    category: "Hardware", // IT's own category, NOT the HR template's "Onboarding"
    subject: "Unrelated IT ticket",
    description: "Should not trigger the HR onboarding checklist.",
    priority: "Medium",
    template_id: String(template.id),
    _csrf: csrf,
  });
  assert.equal(res.status, 302);

  // Exactly one new ticket (the primary one just filed) - no spawns.
  const after = (await db.prepare("SELECT COUNT(*) AS c FROM tickets").get()).c;
  assert.equal(after, before + 1);
});
