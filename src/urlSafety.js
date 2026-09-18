// SSRF prevention for agent-configured webhook URLs (see
// src/routes/dashboard.js's /settings/webhooks routes and src/webhooks.js's
// triggerWebhooks). A webhook URL is fetched by this server itself on every
// matching ticket event, so an unrestricted URL is a way for any agent who
// can create one to make this server issue requests to internal services,
// localhost, or a cloud metadata endpoint (169.254.169.254) - not just to
// wherever the webhook is supposed to go.
//
// Checked twice: once when a webhook URL is saved, and again immediately
// before every actual send - DNS can change between the two (a hostname
// that resolved to a public address at save time could be repointed at an
// internal one later), so only the send-time check is the real guarantee.
const dns = require("dns").promises;

// Loopback split out from the rest of the private ranges so the test suite
// can carve out an exception for it specifically (see NODE_ENV check below)
// without weakening the check against everything else, even under test.
const LOOPBACK_V4_RANGE = ["127.0.0.0", 8];
const OTHER_PRIVATE_V4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["169.254.0.0", 16], // link-local, includes the 169.254.169.254 cloud metadata endpoint
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function ipv4ToLong(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return parts.reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function matchesRange(ip, [base, bits]) {
  const target = ipv4ToLong(ip);
  if (target == null) return true; // unparseable - refuse rather than allow
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (target & mask) === (ipv4ToLong(base) & mask);
}

function isLoopbackV4(ip) {
  return matchesRange(ip, LOOPBACK_V4_RANGE);
}

function isOtherPrivateV4(ip) {
  return OTHER_PRIVATE_V4_RANGES.some((range) => matchesRange(ip, range));
}

function isLoopbackV6(ip) {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("::ffff:127.");
}

function isOtherPrivateV6(ip) {
  const lower = ip.toLowerCase();
  return (
    lower === "::" || // unspecified
    lower.startsWith("fe80:") || // link-local, includes IPv6 cloud metadata
    lower.startsWith("fc") ||
    lower.startsWith("fd") // unique local (fc00::/7)
  );
}

// Rejects on any failure to resolve or classify an address, rather than
// letting an unexpected shape through - a webhook that can't be validated
// safe doesn't get saved or fired.
async function isUrlSafeForWebhook(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (parsed.hostname.toLowerCase() === "localhost") return false;

  // URL's own .hostname keeps the [brackets] around an IPv6 literal
  // (new URL("http://[::1]/").hostname === "[::1]") - dns.lookup() doesn't
  // accept that form and fails every bracketed IPv6 URL outright (an
  // ENOTFOUND, caught below as "unsafe"), which would make any legitimate
  // public IPv6 webhook URL unusable, not just the private ones this is
  // actually meant to block. Stripped here before the lookup.
  const lookupHost =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") ? parsed.hostname.slice(1, -1) : parsed.hostname;

  let addresses;
  try {
    addresses = await dns.lookup(lookupHost, { all: true, verbatim: true });
  } catch {
    return false;
  }
  if (!addresses.length) return false;

  // Loopback is allowed ONLY under the test suite (NODE_ENV=test, set by
  // test/helpers.js) - the only way test/second-batch.test.js can verify
  // real webhook delivery end-to-end is by pointing one at a real HTTP
  // server it spins up on 127.0.0.1 itself. Every other private range stays
  // blocked even in tests; this is the one narrow, explicit exception, not
  // a general test-mode bypass of the whole check.
  const allowLoopback = process.env.NODE_ENV === "test";

  return addresses.every(({ address, family }) => {
    if (family === 4) return (allowLoopback && isLoopbackV4(address)) || !(isLoopbackV4(address) || isOtherPrivateV4(address));
    if (family === 6) return (allowLoopback && isLoopbackV6(address)) || !(isLoopbackV6(address) || isOtherPrivateV6(address));
    return false;
  });
}

module.exports = { isUrlSafeForWebhook };
