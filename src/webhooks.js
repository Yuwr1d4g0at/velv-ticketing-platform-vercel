// Outbound event notifications: POST a JSON payload to whatever URLs are
// configured at /dashboard/settings/webhooks, when one of WEBHOOK_EVENTS
// happens. Fire-and-forget, same philosophy as email - a slow or broken
// receiving end must never hold up or fail the request that triggered it.
const crypto = require("crypto");
const db = require("./db");
const { isUrlSafeForWebhook } = require("./urlSafety");

const WEBHOOK_EVENTS = ["ticket.created", "ticket.status_changed", "ticket.assigned"];

function generateSecret() {
  return crypto.randomBytes(24).toString("hex");
}

// HMAC-SHA256 of the raw JSON body, hex-encoded, in an X-Velv-Signature
// header - lets the receiving end verify the payload actually came from
// here (and wasn't tampered with in transit) before acting on it.
function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// departmentId identifies which department the triggering ticket belongs to
// (its category's department) - a webhook with a department_id only fires
// for that department's tickets; one with department_id NULL (the default,
// and every webhook that existed before this feature) still fires
// platform-wide, unchanged. Passing no departmentId (e.g. an event with no
// natural single department) never filters anything out.
async function triggerWebhooks(eventType, payload, departmentId = null) {
  try {
    const webhooks = await db.prepare("SELECT * FROM webhooks WHERE active = 1").all();
    const subscribed = webhooks
      .filter((w) => w.events.split(",").includes(eventType))
      .filter((w) => w.department_id == null || departmentId == null || w.department_id === departmentId);
    if (!subscribed.length) return;

    const body = JSON.stringify({ event: eventType, sent_at: new Date().toISOString(), data: payload });

    for (const webhook of subscribed) {
      // Re-checked here, not just at save time (see src/urlSafety.js) - a
      // hostname that resolved to a public address when the webhook was
      // created could be repointed at an internal one by the time it
      // actually fires. Still fire-and-forget overall - this just gates
      // each individual fetch behind its own safety check, without making
      // the loop itself wait webhook-by-webhook.
      isUrlSafeForWebhook(webhook.url)
        .then((safe) => {
          if (!safe) {
            console.error(`Webhook delivery to ${webhook.url} blocked - resolves to a private/internal address.`);
            return;
          }
          return fetch(webhook.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Velv-Signature": sign(webhook.secret, body) },
            body,
          }).catch((err) => console.error(`Webhook delivery to ${webhook.url} failed:`, err.message));
        })
        .catch((err) => console.error(`Webhook safety check for ${webhook.url} failed:`, err.message));
    }
  } catch (err) {
    console.error("Could not look up subscribed webhooks:", err.message);
  }
}

module.exports = { WEBHOOK_EVENTS, generateSecret, triggerWebhooks };
