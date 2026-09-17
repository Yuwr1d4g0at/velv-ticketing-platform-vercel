// Creates a helpdesk agent account so someone can log in to the dashboard.
// Run with: npm run seed
//
// Interactive:  npm run seed
// Non-interactive (e.g. scripted setup):
//   SEED_NAME="Jane Doe" SEED_EMAIL="jane@example.com" SEED_PASSWORD="at-least-8-chars" npm run seed
//
// Note: this prompts in plain text (the password is visible as you type).
// It's meant to be run locally by an administrator, not over a shared terminal.
require("dotenv").config();
const readline = require("readline");
const bcrypt = require("bcryptjs");
const db = require("./index");

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("Create a helpdesk agent account\n--------------------------------");

  const name = process.env.SEED_NAME || (await ask("Name: "));
  const email = process.env.SEED_EMAIL || (await ask("Email: "));
  const password = process.env.SEED_PASSWORD || (await ask("Password (min 8 characters): "));

  if (!name || !email || !password) {
    console.error("\nName, email, and password are all required.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("\nPassword must be at least 8 characters.");
    process.exit(1);
  }

  const normalizedEmail = email.toLowerCase();
  const existing = await db.prepare("SELECT id FROM agents WHERE email = ?").get(normalizedEmail);
  if (existing) {
    console.error(`\nAn agent with the email ${normalizedEmail} already exists.`);
    process.exit(1);
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  await db.prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)").run(name, normalizedEmail, passwordHash);

  console.log(`\nAgent "${name}" <${normalizedEmail}> created. You can now log in at /login.`);
  process.exit(0);
}

main();
