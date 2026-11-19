import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import create from "./backend.js";

/** The applet's backend on a real HTTP server, with its data in a temporary folder. */
async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "kasa-"));
  const handler = create({ dataDir, settings: () => ({}), saveSettings() {}, t: (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v?.[k] ?? ""), language: () => "en" });
  const server = createServer((req, res) => handler(req, res));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", "x-panel": "1", ...headers },
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  return { base, post, stop: () => { server.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test("a receipt is kept on this computer, opened and removed", async () => {
  const k = await start();
  try {
    assert.equal((await k.post("/api/kayit", { direction: "out", title: "Laptop", amount: 100, entryDate: "2026-11-05" })).status, 200);
    const { entries } = await (await fetch(`${k.base}/api/kasa?from=2026-11-01&to=2026-11-30&year=2026`)).json();
    const id = entries[0].id;

    const pdf = new TextEncoder().encode("%PDF-1.4 test");
    const added = await k.post(`/api/belge?entry=${id}&name=fatura.pdf`, pdf, { "Content-Type": "application/pdf" });
    assert.equal(added.status, 200);
    const { file } = await added.json();
    assert.equal(file.name, "fatura.pdf");

    const opened = await fetch(`${k.base}/api/belge/${file.id}`);
    assert.equal(opened.headers.get("content-type"), "application/pdf");
    assert.equal(await opened.text(), "%PDF-1.4 test");

    assert.equal((await k.post(`/api/belge?entry=${id}&name=x.exe`, pdf, { "Content-Type": "application/x-msdownload" })).status, 400);
    assert.equal((await fetch(`${k.base}/api/belge?entry=${id}&name=a.pdf`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf })).status, 403, "only the page may write");

    assert.equal((await k.post("/api/belge/sil", { entry: id, id: file.id })).status, 200);
    assert.equal((await fetch(`${k.base}/api/belge/${file.id}`)).status, 404);
  } finally { k.stop(); }
});

test("without a Speys connection the ledger works and says it isn't connected", async () => {
  const k = await start();
  try {
    const status = await (await fetch(`${k.base}/api/speys`)).json();
    assert.equal(status.connected, false);
    assert.deepEqual([status.conflicts, status.failed, status.duplicates], [[], [], []]);
    const synced = await (await k.post("/api/speys/sync", {})).json();
    assert.equal(synced.report, null, "nothing is sent anywhere");
  } finally { k.stop(); }
});

test("scenarios through the API: the plan follows the chosen one", async () => {
  const k = await start();
  try {
    await k.post("/api/senaryo", { name: "Bad" });
    await k.post("/api/senaryo", { name: "Good" });
    let d = await (await fetch(`${k.base}/api/kasa?from=2026-12-01&to=2026-12-31&year=2026`)).json();
    const [bad, good] = d.scenarios;
    assert.equal(d.scenario.id, bad.id);
    await k.post("/api/plan", { direction: "in", title: "Client", amount: 900, category: "hizmet", cycle: "monthly", startMonth: "2099-01", scenarioId: good.id });
    d = await (await fetch(`${k.base}/api/kasa?from=2099-01-01&to=2099-01-31&year=2099&scenario=${good.id}`)).json();
    assert.equal(d.scenario.id, good.id);
    assert.equal(d.expected.income, 900);
    d = await (await fetch(`${k.base}/api/kasa?from=2099-01-01&to=2099-01-31&year=2099&scenario=${bad.id}`)).json();
    assert.equal(d.expected.income, 0);
  } finally { k.stop(); }
});

test("tax: no estimate until the settings are made, then one; the accountant template isn't added twice", async () => {
  const k = await start();
  try {
    const read = async () => (await fetch(`${k.base}/api/kasa?from=2026-11-01&to=2026-11-30&year=2026`)).json();
    let d = await read();
    assert.equal(d.tax.estimate.configured, false);
    assert.deepEqual(d.tax.calendar, []);

    assert.equal((await k.post("/api/vergi/ayar", { activity: "professional", bagkur: "discounted", youngEntrepreneur: true })).status, 200);
    d = await read();
    assert.equal(d.tax.estimate.configured, true);
    assert.deepEqual(d.tax.settings, { configured: true, youngEntrepreneur: true, bagkur: "discounted", activity: "professional" });

    const picks = d.tax.accountant.items.filter((i) => i.selected).map((i) => ({ key: i.key, amount: i.amount }));
    await k.post("/api/musavir", { items: picks, startDate: "2026-12-01" });
    await k.post("/api/musavir", { items: picks, startDate: "2026-12-01" });
    d = await read();
    assert.equal(d.rules.length, picks.length);
    assert.ok(d.rules.every((r) => r.templateKey?.startsWith("musavir:") && r.startDate === "2026-12-01" && r.autoPaid === false && r.category === "muhasebe"));
    assert.equal(d.tax.templatesAdded.length, picks.length);
  } finally { k.stop(); }
});
