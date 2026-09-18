// Minimal CSV serialization - no dependency needed for something this small.
//
// CSV injection (aka formula injection): a cell that starts with =, +, -,
// @, or a tab is executed as a formula the moment the file is opened in
// Excel/Sheets, not just displayed as text - and every export using this
// helper serializes free-text fields an agent or requester controls
// (ticket subjects, consultant/asset names and notes, ...) straight into
// cells. Neutralized by prefixing a leading apostrophe, the standard
// mitigation (OWASP) - spreadsheet apps render a leading ' as "this cell is
// text" and strip it from the display, so legitimate content is unaffected.
const FORMULA_PREFIX_RE = /^[=+\-@\t]/;

function escapeCell(value) {
  let str = value === null || value === undefined ? "" : String(value);
  if (FORMULA_PREFIX_RE.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// rows: array of objects. columns: [{ key, header }] in output order.
function toCsv(rows, columns) {
  const lines = [columns.map((c) => escapeCell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c.key])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = { toCsv };
