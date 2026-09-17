// File attachments for tickets: upload handling, storage, and lookup helpers.
//
// Security notes (this is the one part of the app that touches the filesystem
// with user-supplied content, so it gets extra care):
//   - On-disk filenames are always server-generated random hex + an extension
//     from ALLOWED_TYPES below - never derived from the uploaded filename. That
//     rules out path traversal and disguising an executable with a safe-looking
//     name; the user's original filename is kept only as a DB column for display.
//   - Only a fixed allowlist of mime types can be uploaded (images, PDF, plain
//     text, CSV). Notably no .svg or .html - both can carry a <script>, and
//     serving one back would be a stored-XSS hole.
//   - Downloads always come back as `Content-Disposition: attachment`, so even
//     a mislabeled file gets saved to disk rather than rendered/executed by the
//     browser. That means no inline image thumbnails, which is a fair trade for
//     one less thing that has to be airtight.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const db = require("./db");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "tickets.sqlite");
const ATTACHMENTS_DIR = path.join(path.dirname(DB_PATH), "attachments");
// On Vercel, the deployed bundle (where this path resolves to by default)
// is a read-only filesystem - only /tmp is writable, and even that is
// ephemeral per-instance, not shared across invocations. This mkdirSync is
// a load-time side effect (require("./attachments") runs it immediately),
// so throwing here would crash EVERY route in the app, not just uploads -
// caught and logged instead of left to take down the whole process.
// Attachments genuinely don't work yet in that environment either way
// (local disk storage was never going to survive a serverless redeploy) -
// migrating this to Vercel Blob is tracked separately, not silently
// worked around here by writing to /tmp.
try {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
} catch (err) {
  console.error(`Could not create attachments directory at ${ATTACHMENTS_DIR}: ${err.message}`);
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 3; // per upload action (a new ticket, or one note)

const ALLOWED_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
};

// The narrow subset of ALLOWED_TYPES safe to render inline (Content-
// Disposition: inline) for a thumbnail preview, rather than force-downloaded.
// Deliberately excludes PDF/TXT/CSV - this list exists specifically so a
// preview route can refuse anything else, never inferred from the upload's
// own claimed mime_type at serve time.
const SAFE_PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ATTACHMENTS_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype] || "";
    cb(null, `${crypto.randomBytes(24).toString("hex")}${ext}`);
  },
});

const multerUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      return cb(new Error("UNSUPPORTED_FILE_TYPE"));
    }
    cb(null, true);
  },
});

const LIMITS_HINT = `Optional, up to ${MAX_FILES} files, ${MAX_FILE_BYTES / (1024 * 1024)} MB each. Images, PDF, TXT, or CSV.`;

// Wraps multer so a bad upload (wrong type, too big, too many files) turns into
// a friendly `req.uploadError` string instead of a thrown error - the caller
// re-renders the same form with it, same as any other validation error. Also
// cleans up any files multer already wrote to disk before it hit the error,
// so a rejected request never leaves orphaned files behind.
function handleUpload(fieldName) {
  const middleware = multerUpload.array(fieldName, MAX_FILES);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();

      for (const file of req.files || []) {
        fs.unlink(file.path, () => {});
      }

      if (err.code === "LIMIT_FILE_SIZE") {
        req.uploadError = `Each file must be under ${MAX_FILE_BYTES / (1024 * 1024)} MB.`;
      } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        req.uploadError = `You can attach up to ${MAX_FILES} files.`;
      } else if (err.message === "UNSUPPORTED_FILE_TYPE") {
        req.uploadError = "Unsupported file type. Allowed: images, PDF, TXT, or CSV.";
      } else {
        req.uploadError = "Could not upload the attached file(s). Please try again.";
      }
      next();
    });
  };
}

// visibleToRequester: a requester's own upload is always visible to them
// (default true); an agent's upload defaults to internal-only unless it's
// attached to a note explicitly marked "visible to requester" - otherwise an
// agent could attach something meant to stay internal to an otherwise-
// internal note and have it leak via /status anyway.
// Ported to the async Postgres adapter (see src/db/index.js) - this is the
// one DB call site in this file. The multer diskStorage setup above is
// UNCHANGED for now (still local disk, still reads DB_PATH which no longer
// exists in .env.example - falls back to its own hardcoded default, fine
// for local dev/testing) - swapping this for Vercel Blob is Phase 3's job,
// deliberately not bundled into this async-adapter pass.
async function saveAttachments({ ticketId, files, uploadedBy, agentId = null, visibleToRequester = true }) {
  if (!files || !files.length) return [];
  const insert = db.prepare(
    `INSERT INTO attachments (ticket_id, stored_name, original_name, mime_type, size_bytes, uploaded_by, agent_id, visible_to_requester)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return Promise.all(
    files.map(async (file) => {
      const result = await insert.run(
        ticketId,
        file.filename,
        file.originalname.slice(0, 200),
        file.mimetype,
        file.size,
        uploadedBy,
        agentId,
        visibleToRequester ? 1 : 0
      );
      return result.lastInsertRowid;
    })
  );
}

function deleteUploadedFiles(files) {
  for (const file of files || []) {
    fs.unlink(file.path, () => {});
  }
}

// requesterVisibleOnly: true for anything rendered on a public (/status)
// page - false (the default) for the dashboard, where agents see everything
// regardless of the visibility flag.
async function attachmentsForTicket(ticketId, { requesterVisibleOnly = false } = {}) {
  return db
    .prepare(
      `SELECT attachments.*, agents.name AS agent_name
       FROM attachments
       LEFT JOIN agents ON agents.id = attachments.agent_id
       WHERE ticket_id = ? ${requesterVisibleOnly ? "AND visible_to_requester = 1" : ""}
       ORDER BY created_at ASC`
    )
    .all(ticketId);
}

// For the agent-side download route: no visibility filter, agents can pull
// any attachment on a ticket regardless of the flag.
async function getAttachment(ticketId, attachmentId) {
  return db.prepare("SELECT * FROM attachments WHERE id = ? AND ticket_id = ?").get(attachmentId, ticketId);
}

// For the public (/status) download route: the visibility filter is
// enforced here too, not just on the listing - otherwise a requester who
// guesses/enumerates an attachment id could fetch an internal-only file
// directly even though it's never listed for them.
async function getPublicAttachment(ticketId, attachmentId) {
  return db.prepare("SELECT * FROM attachments WHERE id = ? AND ticket_id = ? AND visible_to_requester = 1").get(attachmentId, ticketId);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  ATTACHMENTS_DIR,
  MAX_FILE_BYTES,
  MAX_FILES,
  LIMITS_HINT,
  SAFE_PREVIEW_TYPES,
  handleUpload,
  saveAttachments,
  deleteUploadedFiles,
  attachmentsForTicket,
  getAttachment,
  getPublicAttachment,
  formatSize,
};
