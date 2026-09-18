// One-off, run-once-by-hand script (like seed-departments-demo.js) - NOT
// part of the app's normal boot path.
//
// The placeholder departments picked when multi-department support first
// shipped (IT/HR/Facilities/Finance) weren't the real ones - the actual
// departments going on this platform are IT (existing), HR (existing),
// Legal, and Marketing. This:
//   1. Deactivates Facilities/Finance and their categories (soft-disabled,
//      never deleted - same pattern as the rest of this app - confirmed
//      zero real tickets use either before doing this).
//   2. Creates Legal and Marketing with a starter set of categories.
//   3. Makes sure the real account (rodrigo.dias@velv.pt) is_admin=1 - the
//      admin-gating fix added after this feature shipped would otherwise
//      have quietly locked the platform's actual owner out of the Agents
//      page, since that account had never had an admin flag before.
//   4. Adds one non-admin walkthrough login per department plus an
//      admin.walkthrough@velv.pt that sees every department, plus a couple
//      of real-shaped demo tickets each, so the walkthrough accounts have
//      something to actually look at.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../src/db");
const departments = require("../src/departments");

const passwordHash = bcrypt.hashSync("demo-password-123", 10);

async function upsertWalkthroughAgent(name, email, departmentId, isAdmin = 0) {
  const existing = await db.prepare("SELECT id FROM agents WHERE email = ?").get(email);
  if (existing) {
    await db.prepare("UPDATE agents SET department_id = ?, is_admin = ?, active = 1 WHERE id = ?").run(departmentId, isAdmin, existing.id);
    return existing.id;
  }
  const result = await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id, is_admin) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, passwordHash, departmentId, isAdmin);
  return result.lastInsertRowid;
}

async function insertTicketIfMissing({ subject, description, category, requesterName, requesterEmail, assignedTo, confidential = 0 }) {
  const existing = await db.prepare("SELECT id FROM tickets WHERE subject = ?").get(subject);
  if (existing) return existing.id;
  const result = await db
    .prepare(
      `INSERT INTO tickets (subject, description, category, requester_name, requester_email, assigned_to, confidential)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(subject, description, category, requesterName, requesterEmail, assignedTo, confidential);
  await db.prepare(`INSERT INTO ticket_activity (ticket_id, agent_id, type, body) VALUES (?, NULL, 'note', ?)`).run(
    result.lastInsertRowid,
    "Seeded for the multi-department manual walkthrough."
  );
  return result.lastInsertRowid;
}

async function ensureDepartment(name, categoryNames) {
  let dept = await db.prepare("SELECT id FROM departments WHERE name = ?").get(name);
  let deptId;
  if (dept) {
    await departments.setActive(dept.id, true); // in case this script runs twice
    deptId = dept.id;
  } else {
    const result = await departments.create(name);
    if (result.error) throw new Error(`Creating department "${name}": ${result.error}`);
    deptId = result.id;
  }
  for (const catName of categoryNames) {
    const existingCat = await db.prepare("SELECT id FROM categories WHERE name = ?").get(catName);
    if (existingCat) {
      await departments.setCategoryActive(existingCat.id, true);
    } else {
      const result = await departments.createCategory(catName, deptId);
      if (result.error) throw new Error(`Creating category "${catName}": ${result.error}`);
    }
  }
  return deptId;
}

async function main() {
  // --- 1. Retire the placeholder departments -------------------------------

  const facilities = await db.prepare("SELECT id FROM departments WHERE name = 'Facilities'").get();
  const finance = await db.prepare("SELECT id FROM departments WHERE name = 'Finance'").get();

  for (const deptId of [facilities?.id, finance?.id]) {
    if (!deptId) continue;
    const stray = (
      await db.prepare("SELECT COUNT(*) AS c FROM tickets WHERE category IN (SELECT name FROM categories WHERE department_id = ?)").get(deptId)
    ).c;
    if (stray > 0) {
      throw new Error(`Refusing to retire department ${deptId} - it still has ${stray} real ticket(s).`);
    }
    for (const cat of await db.prepare("SELECT id FROM categories WHERE department_id = ?").all(deptId)) {
      await departments.setCategoryActive(cat.id, false);
    }
    await departments.setActive(deptId, false);
  }

  // --- 2. Add the real departments ------------------------------------------

  const legalId = await ensureDepartment("Legal", ["Contract Review", "Compliance", "NDA / Confidentiality", "Litigation & Disputes"]);
  const marketingId = await ensureDepartment("Marketing", ["Campaign Request", "Content & Design", "Brand Assets", "Event Support"]);
  const itId = (await db.prepare("SELECT id FROM departments WHERE name = 'IT'").get()).id;
  const hrId = (await db.prepare("SELECT id FROM departments WHERE name = 'HR'").get()).id;

  // --- 3. Don't lock the real owner account out of their own Agents page ---

  await db.prepare("UPDATE agents SET is_admin = 1 WHERE email = 'rodrigo.dias@velv.pt'").run();

  // --- 4. Walkthrough logins, one per department, plus an admin, plus a
  //        couple of tickets each -------------------------------------------

  const itWalkthroughId = await upsertWalkthroughAgent("IT Walkthrough Agent", "it.walkthrough@velv.pt", itId);
  const hrWalkthroughId = await upsertWalkthroughAgent("HR Walkthrough Agent", "hr.walkthrough@velv.pt", hrId);
  const legalWalkthroughId = await upsertWalkthroughAgent("Legal Walkthrough Agent", "legal.walkthrough@velv.pt", legalId);
  const marketingWalkthroughId = await upsertWalkthroughAgent("Marketing Walkthrough Agent", "marketing.walkthrough@velv.pt", marketingId);
  await upsertWalkthroughAgent("Admin Walkthrough Agent", "admin.walkthrough@velv.pt", itId, 1);

  const itTicket1 = await insertTicketIfMissing({
    subject: "Printer on the 3rd floor won't accept print jobs",
    description: "Every print job from the 3rd floor printer sits in the queue and never prints - other floors' printers are fine.",
    category: "Hardware",
    requesterName: "Marta Silva",
    requesterEmail: "marta.silva@velv.pt",
    assignedTo: itWalkthroughId,
  });
  const itTicket2 = await insertTicketIfMissing({
    subject: "New hire needs a laptop provisioned before Monday",
    description: "A new hire starts Monday and needs a laptop imaged and ready - can IT have one set up by Friday?",
    category: "Account & Access",
    requesterName: "Joana Pereira",
    requesterEmail: "joana.pereira@velv.pt",
    assignedTo: itWalkthroughId,
  });

  const legalTicket1 = await insertTicketIfMissing({
    subject: "NDA needed before vendor kickoff call",
    description: "We're meeting a new vendor Thursday to discuss integration details - need a mutual NDA drafted/reviewed before then.",
    category: "NDA / Confidentiality",
    requesterName: "Bruno Costa",
    requesterEmail: "bruno.costa@velv.pt",
    assignedTo: legalWalkthroughId,
  });
  const legalTicket2 = await insertTicketIfMissing({
    subject: "Dispute over a supplier's late-delivery clause",
    description: "A supplier missed a contracted delivery date and is disputing the penalty clause - need Legal's read before we respond.",
    category: "Litigation & Disputes",
    requesterName: "Marta Silva",
    requesterEmail: "marta.silva@velv.pt",
    assignedTo: legalWalkthroughId,
    confidential: 1, // used to test the confidential flag for this department too
  });

  const marketingTicket1 = await insertTicketIfMissing({
    subject: "Need approved brand logo files for a partner deck",
    description: "A partner is putting together a co-branded slide deck and asked for our current logo files (light + dark, svg/png).",
    category: "Brand Assets",
    requesterName: "Joana Pereira",
    requesterEmail: "joana.pereira@velv.pt",
    assignedTo: marketingWalkthroughId,
  });
  const marketingTicket2 = await insertTicketIfMissing({
    subject: "Request: landing page for the Q4 webinar",
    description: "Running a Q4 webinar and need a landing page with a signup form - can Marketing put one together this week?",
    category: "Campaign Request",
    requesterName: "Team Lead",
    requesterEmail: "team.lead@velv.pt",
    assignedTo: marketingWalkthroughId,
  });

  console.log("Departments now:", await db.prepare("SELECT name, active FROM departments ORDER BY name").all());
  console.log("\nWalkthrough logins (all password: demo-password-123):");
  console.log("  it.walkthrough@velv.pt        - IT, non-admin");
  console.log("  hr.walkthrough@velv.pt        - HR, non-admin");
  console.log("  legal.walkthrough@velv.pt     - Legal, non-admin");
  console.log("  marketing.walkthrough@velv.pt - Marketing, non-admin");
  console.log("  admin.walkthrough@velv.pt     - admin, sees every department");
  console.log(`\nIT tickets: #${itTicket1}, #${itTicket2}`);
  console.log(`Legal tickets: #${legalTicket1}, #${legalTicket2} (confidential)`);
  console.log(`Marketing tickets: #${marketingTicket1}, #${marketingTicket2}`);
  console.log("\nrodrigo.dias@velv.pt is now is_admin=1 (was 0 - would have been locked out of the Agents page otherwise).");
}

main()
  .then(() => db.pool.end())
  .catch((err) => {
    console.error("Reshape failed:", err.message);
    process.exit(1);
  });
