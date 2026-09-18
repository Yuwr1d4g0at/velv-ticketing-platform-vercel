// One-off, run-once-by-hand seeding for the manual multi-department
// walkthrough - NOT part of the app's normal boot path. Adds a realistic
// HR agent + admin agent alongside the existing IT agents, and a handful of
// real-shaped tickets across IT and HR categories, so the walkthrough in
// the PR description isn't testing against synthetic/empty data.
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../src/db");

const passwordHash = bcrypt.hashSync("demo-password-123", 10);

async function upsertAgent(name, email, departmentId, isAdmin = 0) {
  const existing = await db.prepare("SELECT id FROM agents WHERE email = ?").get(email);
  if (existing) {
    await db.prepare("UPDATE agents SET department_id = ?, is_admin = ? WHERE id = ?").run(departmentId, isAdmin, existing.id);
    return existing.id;
  }
  const result = await db
    .prepare("INSERT INTO agents (name, email, password_hash, department_id, is_admin) VALUES (?, ?, ?, ?, ?)")
    .run(name, email, passwordHash, departmentId, isAdmin);
  return result.lastInsertRowid;
}

async function insertTicket({ subject, description, category, requesterName, requesterEmail, assignedTo, confidential = 0 }) {
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

async function main() {
  const itDept = (await db.prepare("SELECT id FROM departments WHERE name = 'IT'").get()).id;
  const hrDept = (await db.prepare("SELECT id FROM departments WHERE name = 'HR'").get()).id;

  // rodrigo (existing) stays IT. Teo Test (existing) becomes the admin, since
  // there's already a real login for it. Ana Ferreira is a brand-new HR agent.
  const rodrigoId = await upsertAgent("rodrigo", "rodrigo.dias@velv.pt", itDept, 0);
  const teoId = await upsertAgent("Teo Test", "teotesting@test.pt", itDept, 1);
  const anaId = await upsertAgent("Ana Ferreira", "ana.ferreira@velv.pt", hrDept, 0);

  const itTicket1 = await insertTicket({
    subject: "Laptop won't boot past the Dell logo",
    description: "Tried a hard reset and holding the power button for 30s, still stuck on the Dell splash screen. Need this fixed before tomorrow's client call.",
    category: "Hardware",
    requesterName: "Marta Silva",
    requesterEmail: "marta.silva@velv.pt",
    assignedTo: rodrigoId,
  });
  const itTicket2 = await insertTicket({
    subject: "VPN keeps dropping every 10 minutes",
    description: "Working from home this week and the VPN client disconnects roughly every 10 minutes, forcing a re-login each time.",
    category: "Network",
    requesterName: "Bruno Costa",
    requesterEmail: "bruno.costa@velv.pt",
    assignedTo: teoId,
  });
  const itTicket3 = await insertTicket({
    subject: "Need admin rights to install a design tool",
    description: "Design team wants to trial Affinity Designer for a client mockup and I don't have local admin rights on my machine.",
    category: "Account & Access",
    requesterName: "Marta Silva",
    requesterEmail: "marta.silva@velv.pt",
    assignedTo: rodrigoId,
    confidential: 1, // used to test the confidential flag in the walkthrough
  });

  const hrTicket1 = await insertTicket({
    subject: "Onboarding checklist for new hire starting Monday",
    description: "We have a new backend engineer starting this coming Monday - need the standard onboarding checklist run (equipment, accounts, welcome pack).",
    category: "Onboarding",
    requesterName: "Joana Pereira",
    requesterEmail: "joana.pereira@velv.pt",
    assignedTo: anaId,
  });
  const hrTicket2 = await insertTicket({
    subject: "Question about health insurance dependents",
    description: "Just got married and want to add my spouse to the company health plan - what's the process and deadline?",
    category: "Benefits",
    requesterName: "Bruno Costa",
    requesterEmail: "bruno.costa@velv.pt",
    assignedTo: anaId,
  });
  const hrTicket3 = await insertTicket({
    subject: "Mediation request between two team members",
    description: "There's an ongoing conflict between two engineers on my team that's affecting sprint delivery - would like HR's help mediating a conversation.",
    category: "Employee Relations",
    requesterName: "Team Lead",
    requesterEmail: "team.lead@velv.pt",
    assignedTo: anaId,
    confidential: 1,
  });

  console.log("Seeded multi-department demo data:");
  console.log(`  Agents: rodrigo (IT, id ${rodrigoId}), Teo Test (IT, ADMIN, id ${teoId}), Ana Ferreira (HR, id ${anaId})`);
  console.log(`  IT tickets: #${itTicket1}, #${itTicket2}, #${itTicket3} (confidential)`);
  console.log(`  HR tickets: #${hrTicket1}, #${hrTicket2}, #${hrTicket3} (confidential)`);
  console.log("\nLog in as rodrigo.dias@velv.pt / demo-password-123, teotesting@test.pt / demo-password-123, or ana.ferreira@velv.pt / demo-password-123");
}

main()
  .then(() => db.pool.end())
  .catch((err) => {
    console.error("Seed failed:", err.message);
    process.exit(1);
  });
