// Lightweight @mentions: no autocomplete UI, just a plain-text convention -
// @firstnamelastname (an agent's full name, lowercased, spaces removed).
// Regex-parsing a real name directly out of free text (spaces, punctuation,
// accents) is fragile, so this derives one simple, unambiguous tag per
// active agent instead, shown as a hint under the note textarea.
const db = require("./db");

function mentionTag(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Every @word in the body, matched (exact tag match, not prefix) against
// every active agent's derived tag - excluding the author themselves,
// there's no point emailing someone their own note.
async function findMentionedAgents(body, authorAgentId) {
  const tokens = new Set((body.match(/@([a-z0-9]+)/gi) || []).map((m) => m.slice(1).toLowerCase()));
  if (!tokens.size) return [];
  const agents = await db.prepare("SELECT id, name, email FROM agents WHERE active = 1 AND id != ?").all(authorAgentId || -1);
  return agents.filter((agent) => tokens.has(mentionTag(agent.name)));
}

module.exports = { mentionTag, findMentionedAgents };
