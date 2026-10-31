// Opening with an empty home folder: with no custom applets, settings or data, every applet must open without an error.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 3491;
const BASE = `http://localhost:${PORT}`;
const API = {
  today: "/api/habits",
  claude: "/api/oturumlar",
  crm: "/api/crm",
  kasa: "/api/kasa",
  seo: "/api/seo",
  sosyal: "/api/sosyal",
  tasks: "/api/gorevler",
  yazim: "/api/yazim",
};
const home = mkdtempSync(join(tmpdir(), "speys-local-"));
let server;

before(async () => {
  server = spawn(process.execPath, [join(ROOT, "start.js"), "--port", String(PORT), "--no-open"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, SPEYS_LOCAL_HOME: join(home, ".speys-local"), CLAUDE_CONFIG_DIR: "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/applets`);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error("the server did not start");
});

after(() => {
  server.kill();
  rmSync(home, { recursive: true, force: true });
});

const ids = readdirSync(join(ROOT, "applets", "official"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

for (const id of ids) {
  test(`${id}: page opens`, async () => {
    const r = await fetch(`${BASE}/a/${id}/`);
    assert.equal(r.status, 200);
  });
}

for (const [id, path] of Object.entries(API)) {
  test(`${id}: endpoint works without settings`, async () => {
    const r = await fetch(`${BASE}/a/${id}${path}`);
    assert.equal(r.status, 200);
    await r.json();
  });
}

test("CRM starts with an empty book", async () => {
  const d = await (await fetch(`${BASE}/a/crm/api/crm`)).json();
  assert.equal(d.hatlar.length, 1);
  assert.equal(d.asamalar.length, 5);
  assert.deepEqual(d.kayitlar, []);
});

test("the demo workspace has its own data and leaves main alone", async () => {
  const post = (body) => fetch(`${BASE}/api/workspaces`, { method: "POST", headers: { "X-Panel": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ id: "demo" })).status, 200);
  const crm = await (await fetch(`${BASE}/a/crm/api/crm`)).json();
  assert.ok(crm.kayitlar.length > 3);
  const tasks = await (await fetch(`${BASE}/a/tasks/api/gorevler`)).json();
  assert.equal(tasks.projeler.length, 2);
  const sessions = await (await fetch(`${BASE}/a/claude/api/oturumlar`)).json();
  assert.equal(sessions.length, 4);
  const ledger = await (await fetch(`${BASE}/a/kasa/api/kasa`)).json();
  assert.ok(ledger.entries.length > 3);
  assert.equal((await fetch(`${BASE}/a/today/`)).status, 200);
  assert.equal((await post({ id: "main" })).status, 200);
  assert.deepEqual((await (await fetch(`${BASE}/a/crm/api/crm`)).json()).kayitlar, []);
  assert.equal((await post({ id: "../x" })).status, 400);
  assert.equal((await post({ create: "Client Work" })).status, 200);
  assert.ok((await (await fetch(`${BASE}/api/workspaces`)).json()).list.includes("client-work"));
  assert.equal((await post({ id: "main" })).status, 200);
});

test("no personal paths in the code", () => {
  const paths = ["core/server.js", "applets/official/claude/backend.js", "applets/official/yazim/analyze.js", "applets/official/seo/backend.js", "applets/official/today/backend.js"];
  for (const p of paths) {
    const text = readFileSync(join(ROOT, p), "utf8");
    assert.doesNotMatch(text, /\/Users\/|\.claude-2|Speys Ltd/, p);
  }
});
