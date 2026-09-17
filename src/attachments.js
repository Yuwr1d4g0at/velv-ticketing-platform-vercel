// File attachments for tickets: upload handling, storage, and lookup helpers.
//
// Security notes (this is the one part of the app that touches user-supplied
// binary content, so it gets extra care):
//   - Blob pathnames (stored in `stored_name`, unchanged column name from the
//     local-disk era - see below) are always server-generated random hex + an
//     extension from ALLOWED_TYPES - never derived from the uploaded filename.
//     That rules out path traversal and disguising an executable with a
//     safe-looking name; the user's original filename is kept only as a DB
//     column for display.
//   - Only a fixed allowlist of mime types can be uploaded (images, PDF, plain
//     text, CSV). Notably no .svg or .html - both can carry a <script>, and
//     serving one back would be a stored-XSS hole.
//   - Downloads always come back as `Content-Disposition: attachment`, so even
//     a mislabeled file gets saved to disk rather than rendered/executed by the
//     browser. That means no inline image thumbnails, which is a fair trade for
//     one less thing that has to be airtight.
//
// Storage: Vercel Blob (private access), not local disk - Phase 3 of the
// Railway->Vercel migration. Local disk never survives a serverless
// redeploy/cold start, and the deployed bundle's filesystem is read-only
// anyway (see the git history for the crash this caused before this file was
// ported). `stored_name` keeps its old column name/meaning of "the opaque
// name this file is stored under" - it's now a Blob pathname instead of a
// local filename, so every existing DB row and every download/preview call
// site only needed a storage-layer swap, not a schema change: blob.get()
// resolves a blob by pathname alone (using BLOB_READ_WRITE_TOKEN to find the
// right store), the same way fs used to resolve a filename against
// ATTACHMENTS_DIR.
const crypto = require("crypto");
const { Readable } = require("stream");
const multer = require("multer");
const { put, get: blobGet, del: blobDel } = require("@vercel/blob");
const db = require("./db");

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

// memoryStorage, not diskStorage - files live only as an in-memory Buffer
// (file.buffer) between multer parsing the upload and saveAttachments()
// below uploading that buffer to Blob. Fine at this app's MAX_FILE_BYTES/
// MAX_FILES scale (30 MB worst case per request), well within a serverless
// function's memory budget.
const storage = multer.memoryStorage();

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
// re-renders the same form with it, same as any other validation error. With
// memoryStorage there's nothing on disk to clean up on a rejected upload (no
// deleteUploadedFiles() call needed here anymore - see that function's note
// below).
function handleUpload(fieldName) {
  const middleware = multerUpload.array(fieldName, MAX_FILES);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) return next();

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
async function saveAttachments({ ticketId, files, uploadedBy, agentId = null, visibleToRequester = true }) {
  if (!files || !files.length) return [];
  const insert = db.prepare(
    `INSERT INTO attachments (ticket_id, stored_name, original_name, mime_type, size_bytes, uploaded_by, agent_id, visible_to_requester)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return Promise.all(
    files.map(async (file) => {
      const ext = ALLOWED_TYPES[file.mimetype] || "";
      const pathname = `${crypto.randomBytes(24).toString("hex")}${ext}`;
      await put(pathname, file.buffer, { access: "private", contentType: file.mimetype, addRandomSuffix: false });
      const result = await insert.run(
        ticketId,
        pathname,
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

// With memoryStorage, multer never writes anything to disk in the first
// place - a rejected upload just means the in-memory buffers get garbage
// collected once the request ends, nothing to explicitly delete. Kept as a
// no-op (rather than removed) so every existing call site (form validation
// failures in dashboard.js/public.js that call this after req.uploadError or
// a body/length check fails) doesn't need its own conditional.
function deleteUploadedFiles() {}

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

// Streams an attachment's bytes from Blob storage through this server (never
// redirects the browser straight to the Blob URL) - the private-access Blob
// store requires the server's own BLOB_READ_WRITE_TOKEN to read it anyway,
// but doing this server-side also means every existing access-control check
// (agent session, ticket ownership, visible_to_requester, SAFE_PREVIEW_TYPES)
// still gates the actual bytes, exactly as it did when this read from local
// disk. `disposition` is "attachment" (force-download) or "inline" (preview).
async function streamAttachment(res, attachment, disposition) {
  const result = await blobGet(attachment.stored_name, { access: "private" });
  if (!result || !result.stream) {
    return res.status(404).render("error", { title: "Not found", message: "That attachment's file could not be found." });
  }
  res.setHeader("Content-Type", attachment.mime_type);
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${attachment.original_name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`
  );
  Readable.fromWeb(result.stream).pipe(res);
}

async function deleteAttachmentBlob(storedName) {
  await blobDel(storedName, { access: "private" }).catch((err) => console.error(`Could not delete blob ${storedName}:`, err.message));
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
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
  streamAttachment,
  deleteAttachmentBlob,
  formatSize,
};
