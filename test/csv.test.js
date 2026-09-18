// src/csv.js - RFC4180 quoting plus the CSV/formula injection mitigation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toCsv } = require("../src/csv");

function firstDataCell(csv) {
  return csv.split("\r\n")[1];
}

test("a normal cell passes through unchanged", () => {
  const csv = toCsv([{ name: "Acme Corp" }], [{ key: "name", header: "Name" }]);
  assert.equal(firstDataCell(csv), "Acme Corp");
});

test("a cell starting with = is neutralized with a leading apostrophe", () => {
  const csv = toCsv([{ name: "=cmd|'/c calc'!A1" }], [{ key: "name", header: "Name" }]);
  assert.equal(firstDataCell(csv), "'=cmd|'/c calc'!A1");
});

test("cells starting with +, -, @, or a tab are all neutralized", () => {
  const rows = [{ n: "+1+1" }, { n: "-2+3" }, { n: "@SUM(A1)" }, { n: "\tsneaky" }];
  const csv = toCsv(rows, [{ key: "n", header: "N" }]);
  const lines = csv.split("\r\n").slice(1, 5);
  assert.equal(lines[0], "'+1+1");
  assert.equal(lines[1], "'-2+3");
  assert.equal(lines[2], "'@SUM(A1)");
  assert.equal(lines[3], "'\tsneaky");
});

test("a minus sign that isn't a formula prefix (e.g. a negative-looking but plain string) is still neutralized - erring safe, not parsing intent", () => {
  const csv = toCsv([{ n: "-just some notes" }], [{ key: "n", header: "N" }]);
  assert.equal(firstDataCell(csv), "'-just some notes");
});

test("the leading apostrophe still gets proper RFC4180 quoting when the cell also has a comma or quote", () => {
  const csv = toCsv([{ n: '=A1,"hello"' }], [{ key: "n", header: "N" }]);
  assert.equal(firstDataCell(csv), `"'=A1,""hello"""`);
});

test("null/undefined cells stay empty, not '=' or similar", () => {
  const csv = toCsv([{ n: null }, { n: undefined }], [{ key: "n", header: "N" }]);
  const lines = csv.split("\r\n").slice(1, 3);
  assert.equal(lines[0], "");
  assert.equal(lines[1], "");
});
