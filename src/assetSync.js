// Live sync of the asset inventory from the SharePoint "Hardware Inventory"
// list, replacing the one-time manual CSV export/import (see
// scripts/import-assets.js, which this reuses the same field mapping and
// idempotent "HW-<source ID>" asset-tag matching from) with an ongoing
// automatic pull via Microsoft Graph.
//
// SharePoint is treated as the source of truth for the fields it actually
// supplies (category, status, assigned owner, vendor, serial number,
// purchase date, and the SharePoint-sourced lines of notes) - every sync
// run overwrites those specific fields on an already-imported asset
// (matched by asset_tag) with whatever SharePoint says now. `location` and
// `warranty_expires` are deliberately never touched by a sync run - there's
// no SharePoint column for either, and always merging in the asset's own
// current value for those two (rather than defaulting to null) keeps a
// manually-entered value from getting silently wiped out. Anything else an
// agent edits directly on a synced field (status, assigned_to_name, etc.)
// WILL be overwritten the next time this runs - a deliberate one-way sync,
// not a two-way merge, and worth knowing before relying on a manual
// override sticking.
//
// Not build-tested against the live SharePoint list yet - the field
// mapping (category/status keys, column display names) is carried over
// from the original CSV import, which was verified against a real export,
// but Graph's own field/date representations haven't been checked against
// a real response yet. Expect to adjust after the first real run.
const db = require("./db");
const msGraph = require("./msGraph");
const assets = require("./assets");

const SITE_HOSTNAME = "onrisingti.sharepoint.com";
const SITE_PATH = "/sites/management.operations";
const LIST_DISPLAY_NAME = "Hardware Inventory";

const SOURCE_CATEGORY_MAP = {
  "computador portátil": "Laptop",
  monitor: "Monitor",
  smartphone: "Phone",
  switch: "Network Equipment",
  teclado: "Peripheral",
  rato: "Peripheral",
  headphones: "Peripheral",
  "adaptador usb": "Peripheral",
};

const SOURCE_STATUS_MAP = {
  available: "Available",
  reserved: "Reserved",
  "in use": "In Use",
  "in repair": "Under Repair",
  retired: "Retired",
};

function orNull(raw) {
  const v = (raw == null ? "" : String(raw)).trim();
  if (!v || /^n\/?a-?$/i.test(v)) return null;
  return v;
}

// SharePoint list items' `fields` are keyed by each column's internal
// name, which often isn't the same string as what a person sees as the
// column header (spaces/punctuation get encoded, e.g. "Asset Type" often
// becomes "Asset_x0020_Type") - resolved once per sync run via the list's
// own /columns endpoint rather than hardcoding a guess at the encoding.
async function resolveFieldMap(siteId, listId) {
  const res = await msGraph.graphFetch(`/sites/${siteId}/lists/${listId}/columns`);
  if (!res.ok) throw new Error(`Could not read list columns: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const map = {};
  for (const col of data.value) {
    if (col.name) map[col.displayName] = col.name;
  }
  return map;
}

async function runSync() {
  if (!msGraph.isEnabled()) return { skipped: "Microsoft Graph is not configured." };

  const runId = (await db.prepare("INSERT INTO asset_sync_runs (started_at) VALUES (now_text())").run()).lastInsertRowid;

  try {
    const siteId = await msGraph.resolveSiteId(SITE_HOSTNAME, SITE_PATH);
    const listId = await msGraph.resolveListId(siteId, LIST_DISPLAY_NAME);
    const fieldMap = await resolveFieldMap(siteId, listId);
    const items = await msGraph.fetchListItems(siteId, listId);

    const stats = { total: items.length, created: 0, updated: 0, failed: [] };

    for (const item of items) {
      const col = (displayName) => {
        const internalName = fieldMap[displayName];
        return internalName != null ? item.fields[internalName] : undefined;
      };

      const sourceId = String(col("ID") ?? "").trim();
      if (!sourceId) continue;
      const assetTag = `HW-${sourceId}`;

      const brand = orNull(col("Brand"));
      const model = orNull(col("Model"));
      const name = [brand, model].filter(Boolean).join(" ") || `Asset ${sourceId}`;

      const sourceCategory = String(col("Asset Type") || "").trim();
      const category = SOURCE_CATEGORY_MAP[sourceCategory.toLowerCase()] || "Other";

      const sourceStatus = String(col("Status") || "").trim();
      const status = SOURCE_STATUS_MAP[sourceStatus.toLowerCase()] || "In Use";

      const noteParts = [];
      const assignedDate = orNull(col("Assigned Date"));
      if (assignedDate) noteParts.push(`Assigned: ${assignedDate}`);
      const previousOwner = orNull(col("Previous Owner"));
      if (previousOwner) noteParts.push(`Previous owner: ${previousOwner}`);
      const purchasePrice = orNull(col("Purchase Price"));
      if (purchasePrice) noteParts.push(`Purchase price: ${purchasePrice}`);
      const orderVot = orNull(col("Order #VOT"));
      if (orderVot) noteParts.push(`Order: ${orderVot}`);
      const riskLevel = orNull(col("Risk Level"));
      if (riskLevel) noteParts.push(`Risk level: ${riskLevel}`);
      noteParts.push(`Synced from SharePoint Hardware Inventory, source ID ${sourceId}.`);

      // Graph returns a SharePoint Date column as a full ISO datetime
      // already (unlike the CSV export's dd/mm/yyyy strings) - the first
      // 10 characters are the plain date part this app's own date fields
      // expect.
      const purchaseDateRaw = col("Purchase Date");
      const purchaseDate = purchaseDateRaw ? String(purchaseDateRaw).slice(0, 10) : null;

      const sourcedFields = {
        name,
        asset_tag: assetTag,
        category,
        status,
        assigned_to_name: orNull(col("Current Owner")),
        serial_number: orNull(col("Serial Number")),
        vendor: brand,
        purchase_date: purchaseDate,
        notes: noteParts.join("\n"),
      };

      const existing = await db.prepare("SELECT * FROM assets WHERE asset_tag = ?").get(assetTag);
      let result;
      if (existing) {
        // location/warranty_expires have no SharePoint source - carried
        // over from the asset's own current value so this update can't
        // silently null them out.
        result = await assets.update(
          existing.id,
          { ...sourcedFields, location: existing.location, warranty_expires: existing.warranty_expires },
          null
        );
      } else {
        result = await assets.create(sourcedFields, null);
      }

      if (result.error) {
        stats.failed.push({ assetTag, error: result.error });
      } else if (existing) {
        stats.updated++;
      } else {
        stats.created++;
      }
    }

    await db
      .prepare(`UPDATE asset_sync_runs SET finished_at = now_text(), created_count = ?, updated_count = ?, failed_count = ? WHERE id = ?`)
      .run(stats.created, stats.updated, stats.failed.length, runId);

    return stats;
  } catch (err) {
    await db.prepare(`UPDATE asset_sync_runs SET finished_at = now_text(), error = ? WHERE id = ?`).run(err.message, runId);
    throw err;
  }
}

// Called from the periodic checker in server.js - only actually syncs once
// more than intervalHours have passed since the last run STARTED (whether
// it succeeded or not, so a broken sync doesn't retry every few minutes
// forever and hammer Graph while something's wrong upstream).
async function isDue(intervalHours) {
  const last = await db.prepare("SELECT started_at FROM asset_sync_runs ORDER BY id DESC LIMIT 1").get();
  if (!last) return true;
  const ageMs = Date.now() - new Date(`${last.started_at.replace(" ", "T")}Z`).getTime();
  return ageMs > intervalHours * 60 * 60 * 1000;
}

async function recentRuns(limit = 20) {
  return db.prepare("SELECT * FROM asset_sync_runs ORDER BY id DESC LIMIT ?").all(limit);
}

module.exports = { runSync, isDue, recentRuns };
