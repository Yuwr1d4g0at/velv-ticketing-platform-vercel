const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp, makeClient, extractCsrf } = require("./helpers");

let app, client;

before(async () => {
  app = await startTestApp();
  client = makeClient(app.baseUrl);

  await app.db
    .prepare("INSERT INTO agents (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Asset Agent", "asset-agent@example.com", bcrypt.hashSync("correct-password", 4));

  const loginPage = await client.get("/login");
  const csrf = extractCsrf(await loginPage.text());
  await client.postForm("/login", { email: "asset-agent@example.com", password: "correct-password", _csrf: csrf });
});

after(() => app.close());

async function addAsset(fields) {
  const page = await client.get("/dashboard/assets");
  const csrf = extractCsrf(await page.text());
  const res = await client.postForm("/dashboard/assets", { category: "Laptop", ...fields, _csrf: csrf });
  assert.equal(res.status, 302);
  return res.headers.get("location").match(/assets\/(\d+)/)[1];
}

test("creating an asset validates required fields and rejects a duplicate tag", async () => {
  const page = await client.get("/dashboard/assets");
  const csrf = extractCsrf(await page.text());

  const missingName = await client.postForm("/dashboard/assets", { name: "", category: "Laptop", _csrf: csrf });
  assert.equal(missingName.status, 400);

  const assetId = await addAsset({ name: "MacBook Pro 14", asset_tag: "VLV-DUPTEST" });
  assert.ok(assetId);

  const dupPage = await client.get("/dashboard/assets");
  const dupCsrf = extractCsrf(await dupPage.text());
  const dup = await client.postForm("/dashboard/assets", {
    name: "Another laptop",
    category: "Laptop",
    asset_tag: "VLV-DUPTEST",
    _csrf: dupCsrf,
  });
  assert.equal(dup.status, 400);
  assert.match(await dup.text(), /already in use/);
});

test("editing an asset persists changes and status badge updates", async () => {
  const assetId = await addAsset({ name: "Dell Monitor", category: "Monitor", assigned_to_name: "Ana" });

  const detailPage = await client.get(`/dashboard/assets/${assetId}`);
  const csrf = extractCsrf(await detailPage.text());
  const editRes = await client.postForm(`/dashboard/assets/${assetId}`, {
    name: "Dell Monitor",
    category: "Monitor",
    status: "Under Repair",
    assigned_to_name: "Ana",
    _csrf: csrf,
  });
  assert.equal(editRes.status, 302);

  const updated = await client.get(`/dashboard/assets/${assetId}`);
  const html = await updated.text();
  assert.match(html, /badge-asset-status-under-repair/);
  assert.match(html, /Under Repair/);
});

test("requester can pick an asset on the public form, and it shows on the ticket", async () => {
  const assetId = await addAsset({ name: "iPhone 15", category: "Phone", asset_tag: "VLV-PHONE-1" });

  const formPage = await client.get("/");
  const formHtml = await formPage.text();
  assert.match(formHtml, /VLV-PHONE-1/);

  const submitRes = await client.postForm("/", {
    requester_name: "Asset Requester",
    requester_email: "asset-requester@example.com",
    category: "Hardware",
    subject: "Phone screen cracked",
    description: "d",
    asset_id: assetId,
  });
  assert.equal(submitRes.status, 302);
  const ticketId = submitRes.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const ticketHtml = await ticketPage.text();
  assert.match(ticketHtml, /iPhone 15/);

  // And the asset's own page lists this ticket back.
  const assetPage = await client.get(`/dashboard/assets/${assetId}`);
  const assetHtml = await assetPage.text();
  assert.match(assetHtml, /Phone screen cracked/);
});

test("submitting a bogus asset id is rejected, not silently linked", async () => {
  const res = await client.postForm("/", {
    requester_name: "Bad Asset Requester",
    requester_email: "bad-asset@example.com",
    category: "Hardware",
    subject: "Should not link",
    description: "d",
    asset_id: "999999",
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /valid asset/);
});

test("an agent can link/change/unlink an asset directly on the ticket", async () => {
  const assetId = await addAsset({ name: "Standing Desk", category: "Other", location: "Porto Office" });

  const noAssetSubmit = await client.postForm("/", {
    requester_name: "Link Test",
    requester_email: "link-test@example.com",
    category: "Hardware",
    subject: "Desk motor is noisy",
    description: "d",
  });
  const ticketId = noAssetSubmit.headers.get("location").match(/confirmation\/(\d+)/)[1];

  const ticketPage = await client.get(`/dashboard/tickets/${ticketId}`);
  const csrf = extractCsrf(await ticketPage.text());
  const linkRes = await client.postForm(`/dashboard/tickets/${ticketId}/asset`, { asset_id: assetId, _csrf: csrf });
  assert.equal(linkRes.status, 302);

  const linked = await client.get(`/dashboard/tickets/${ticketId}`);
  assert.match(await linked.text(), /Standing Desk/);

  const unlinkRes = await client.postForm(`/dashboard/tickets/${ticketId}/asset`, { asset_id: "", _csrf: csrf });
  assert.equal(unlinkRes.status, 302);
  const unlinked = await client.get(`/dashboard/tickets/${ticketId}`);
  assert.match(await unlinked.text(), /No asset linked/);
});

test("a retired asset is not offered on the public form but stays reachable in the dashboard", async () => {
  const assetId = await addAsset({ name: "Old Server", category: "Server" });
  const detailPage = await client.get(`/dashboard/assets/${assetId}`);
  const csrf = extractCsrf(await detailPage.text());
  await client.postForm(`/dashboard/assets/${assetId}`, { name: "Old Server", category: "Server", status: "Retired", _csrf: csrf });

  const formHtml = await (await client.get("/")).text();
  assert.doesNotMatch(formHtml, /Old Server/);

  const stillReachable = await client.get(`/dashboard/assets/${assetId}`);
  assert.equal(stillReachable.status, 200);
  assert.match(await stillReachable.text(), /Retired/);
});

test("the Assets page paginates past one page and shows accurate status stat tiles", async () => {
  // Enough new assets, all sharing one distinguishable name prefix, to push
  // the total well past one page (PAGE_SIZE = 25) regardless of how many
  // other tests in this file already created assets before this one runs.
  for (let i = 0; i < 30; i++) {
    await addAsset({ name: `[Pagination Test] Item ${i}`, category: "Peripheral", status: "Available" });
  }

  const page1Html = await (await client.get("/dashboard/assets")).text();
  assert.match(page1Html, /Page 1 of \d+/);

  const page2Html = await (await client.get("/dashboard/assets?page=2")).text();
  assert.match(page2Html, /Page 2 of \d+/);

  // The two pages shouldn't show an identical set of rows.
  const page1Items = page1Html.match(/\[Pagination Test\] Item \d+/g) || [];
  const page2Items = page2Html.match(/\[Pagination Test\] Item \d+/g) || [];
  assert.notDeepEqual(page1Items, page2Items);

  // A status with zero real assets anywhere in this test run shows an
  // actual "0" tile, not a missing one.
  assert.match(page1Html, /<span class="stat-count">0<\/span>\s*<span class="stat-label">Lost<\/span>/);
});
