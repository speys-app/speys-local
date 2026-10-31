// The catalog stays valid, and an install takes only what passes the checks. Downloads are faked here: no network, no git.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { entryProblem, installApplet, installedApplets, readCatalog, removeApplet } from "./store.js";

const ROOT = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "speys-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const entry = (extra = {}) => ({ id: "notes", name: "Notes", description: "Notes.", author: "someone", version: "1.0.0", repo: "https://github.com/someone/notes", commit: "a".repeat(40), ...extra });
const files = (manifest = { name: "Notes" }) => async (_, to) => {
  writeFileSync(join(to, "applet.json"), JSON.stringify(manifest));
  writeFileSync(join(to, "index.html"), "<p>notes</p>");
};

test("every catalog entry is valid, unique and clear of official ids", () => {
  const official = readdirSync(join(ROOT, "applets", "official"));
  const list = readCatalog(ROOT);
  for (const e of list) {
    assert.equal(entryProblem(e), null, e.id);
    assert.ok(!official.includes(e.id), e.id);
  }
  assert.equal(new Set(list.map((e) => e.id)).size, list.length);
});

test("an entry must pin a full commit and a GitHub repo", () => {
  assert.equal(entryProblem(entry()), null);
  assert.match(entryProblem(entry({ commit: "main" })), /commit/);
  assert.match(entryProblem(entry({ repo: "https://evil.example/x/y" })), /repo/);
  assert.match(entryProblem(entry({ repo: "--upload-pack=x" })), /repo/);
  assert.match(entryProblem(entry({ id: "../x" })), /id/);
});

test("install records the version; update replaces it; remove deletes it", async () => {
  const store = join(dir, "ok");
  await installApplet(entry(), store, { fetchRepo: files() });
  assert.deepEqual(installedApplets(store).notes, { commit: "a".repeat(40), version: "1.0.0" });
  await installApplet(entry({ version: "1.1.0", commit: "b".repeat(40) }), store, { fetchRepo: files() });
  assert.equal(installedApplets(store).notes.version, "1.1.0");
  assert.deepEqual(readdirSync(store), ["notes"]);
  removeApplet("notes", store);
  assert.deepEqual(installedApplets(store), {});
});

for (const [name, fetchRepo, pattern] of [
  ["a symlink", async (_, to) => { await files()(_, to); symlinkSync("/etc/passwd", join(to, "x")); }, /symlink/],
  ["no applet.json", async (_, to) => { mkdirSync(join(to, "src")); }, /applet\.json/],
  ["a backend outside the applet", files({ name: "x", backend: "../../../evil.js" }), /outside/],
  ["an outside url", files({ name: "x", url: "https://evil.example" }), /url/],
  ["another applet's settings", files({ name: "x", settings: [{ key: "k", section: "crm" }] }), /section/],
]) {
  test(`refuses ${name} and keeps the installed version`, async () => {
    const store = join(dir, name.replaceAll(" ", "-"));
    await installApplet(entry(), store, { fetchRepo: files() });
    await assert.rejects(installApplet(entry({ version: "2.0.0" }), store, { fetchRepo }), pattern);
    assert.equal(installedApplets(store).notes.version, "1.0.0");
    assert.equal(readFileSync(join(store, "notes", "index.html"), "utf8"), "<p>notes</p>");
    assert.deepEqual(readdirSync(store), ["notes"]);
  });
}

test("an official id cannot be taken", async () => {
  const store = join(dir, "reserved");
  await assert.rejects(installApplet(entry({ id: "tasks" }), store, { fetchRepo: files(), reserved: ["tasks"] }), /built-in/);
  assert.equal(existsSync(join(store, "tasks")), false);
});
