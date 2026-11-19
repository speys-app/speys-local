import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { apply, backups, cleanOp, createHistory, createShortcuts, defaultFolder, historyFile, isLocked, profiles, readHistory, readRows, shortcutsFile } from "./chrome.js";
import { PUT_HITS, applyHistory, applyOps, bare, historyMatches, putFirst, removeSuggestion, score, suggest } from "./rank.js";

const NOW = Date.UTC(2026, 10, 19, 12);
const DAY = 86400_000;
const row = (id, text, url, hits, daysAgo, extra = {}) => ({ id, text, fill: url, url, contents: bare(url), description: "", type: 1, keyword: "", hits, last: NOW - daysAgo * DAY, ...extra });

test("bare drops the scheme and www", () => {
  assert.equal(bare("https://www.example.com/a"), "example.com/a");
  assert.equal(bare("chrome://settings"), "settings");
});

test("score: typing all of the text beats part of it, and old picks fade", () => {
  const r = row("a", "vercel", "https://vercel.com/", 30, 0);
  assert.equal(score("vercel", r, NOW), 1199);
  assert.ok(score("ver", r, NOW) < score("vercel", r, NOW));
  assert.ok(score("ver", { ...r, last: NOW - 60 * DAY }, NOW) < score("ver", r, NOW));
  // Few picks fade faster than many.
  assert.ok(score("ver", { ...r, hits: 1, last: NOW - 7 * DAY }, NOW) < score("ver", { ...r, last: NOW - 7 * DAY }, NOW));
});

test("suggest keeps one row per address, best first, and knows what completes in place", () => {
  const rows = [
    row("a", "vercel", "https://vercel.com/team/~/deployments", 162, 1),
    row("b", "ver", "https://vercel.com/team/~/deployments", 3, 30),
    row("c", "verimor", "https://www.google.com/search?q=verimor", 1, 40, { keyword: "google.com", contents: "verimor" }),
    row("d", "docs", "https://docs.example.com/", 9, 1),
  ];
  const list = suggest(rows, "Ver", NOW);
  assert.deepEqual(list.map((s) => s.url), ["https://vercel.com/team/~/deployments", "https://www.google.com/search?q=verimor"]);
  assert.equal(list[0].rows.length, 2);
  assert.equal(list[0].inline, true);
  assert.deepEqual(suggest(rows, "  ", NOW), []);
  // An address that doesn't start with what's typed is first but not completed in place.
  const other = suggest([row("e", "v", "https://supabase.com/", 50, 0)], "v", NOW);
  assert.equal(other[0].inline, false);
});

test("applyOps: delete, put on a new text, put on an existing one", () => {
  const rows = [row("a", "ver", "https://vercel.com/", 2, 10), row("b", "verimor", "https://verimor.com/", 1, 10)];
  const out = applyOps(rows, [{ op: "delete", id: "b" }, { op: "put", text: "VER", url: "https://vercel.com/" }, { op: "put", text: "s", url: "https://supabase.com/" }], NOW);
  assert.deepEqual(out.map((r) => r.id), ["a", "new-2"]);
  assert.equal(out[0].hits, PUT_HITS);
  assert.equal(out[0].last, NOW);
  assert.equal(out[1].text, "s");
  assert.equal(suggest(out, "s", NOW)[0].url, "https://supabase.com/");
});

test("putFirst beats an address picked minutes ago by taking its row for that text", () => {
  const deploy = "https://vercel.com/team/~/deployments", other = "https://vercel.com/speys/~/deployments";
  const rows = [row("a", "vercel", deploy, 163, 0.02), row("b", "vercel.com/team/~/deployments", deploy, 1, 3), row("c", "vercel", other, 25, 0)];
  // Only "put" ties: same top score, more picks win.
  assert.equal(suggest(applyOps(rows, [{ op: "put", text: "vercel", url: other }], NOW), "vercel", NOW)[0].url, deploy);
  const ops = putFirst(rows, [], [], "Vercel ", other);
  assert.deepEqual(ops, [{ op: "put", text: "Vercel", url: other, title: "" }, { op: "delete", id: "a" }]);
  const after = applyOps(rows, ops, NOW);
  assert.equal(suggest(after, "vercel", NOW)[0].url, other);
  // The old address keeps what it learned from other texts.
  assert.equal(suggest(after, "vercel.com/team", NOW)[0].url, deploy);
  assert.deepEqual(putFirst(rows, [], [{ op: "delete", id: "a" }], "vercel", other).length, 1);
});

test("cleanOp checks every change from the page", () => {
  assert.deepEqual(cleanOp({ op: "delete", id: "X1" }), { op: "delete", id: "X1" });
  assert.deepEqual(cleanOp({ op: "put", text: " v ", url: "https://vercel.com" }), { op: "put", text: "v", url: "https://vercel.com/", title: "" });
  assert.equal(cleanOp({ op: "put", text: "v", url: "javascript:alert(1)" }), null);
  assert.equal(cleanOp({ op: "put", text: "", url: "https://a.com" }), null);
  assert.equal(cleanOp({ op: "restore", backup: "../x.sqlite" }, ["../x.sqlite"]), null);
  assert.equal(cleanOp({ op: "restore", backup: "2026-11-19.sqlite" }, []), null);
  assert.deepEqual(cleanOp({ op: "restore", backup: "2026-11-19.sqlite" }, ["2026-11-19.sqlite"]), { op: "restore", backup: "2026-11-19.sqlite" });
  assert.equal(cleanOp({ op: "drop" }), null);
});

test("defaultFolder per platform", () => {
  assert.equal(defaultFolder("darwin", "/Users/a"), join("/Users/a", "Library", "Application Support", "Google", "Chrome"));
  assert.equal(defaultFolder("win32", "C:\\Users\\a", { LOCALAPPDATA: "L" }), join("L", "Google", "Chrome", "User Data"));
  assert.equal(defaultFolder("linux", "/home/a"), join("/home/a", ".config", "google-chrome"));
});

test("profiles, reading, locking, writing with a backup, restoring", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "address-bar-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const dir of ["Default", "Profile 2", "Profile 3"]) mkdirSync(join(folder, dir));
  writeFileSync(join(folder, "Local State"), JSON.stringify({ profile: { last_used: "Profile 2", info_cache: {
    Default: { name: "Your Chrome", is_using_default_name: true, gaia_name: "Ada Lovelace", user_name: "ada@example.com" },
    "Profile 2": { name: "Work", is_using_default_name: false },
    "Profile 3": { name: "No shortcuts yet" },
  } } }));
  const file = shortcutsFile(folder, "Default"), files = { shortcuts: file, history: historyFile(folder, "Default") };
  createShortcuts(file, [row("A", "ver", "https://vercel.com/", 4, 2), { ...row("B", "verimor", "https://www.google.com/search?q=verimor", 1, 50), keyword: "google.com" }]);
  createShortcuts(shortcutsFile(folder, "Profile 2"), []);

  assert.deepEqual(profiles(folder), [
    { dir: "Default", name: "Ada Lovelace", account: "ada@example.com", lastUsed: false },
    { dir: "Profile 2", name: "Work", account: "", lastUsed: true },
  ]);

  const rows = readRows(file);
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.id === "A");
  assert.equal(a.text, "ver");
  assert.equal(a.hits, 4);
  assert.ok(Math.abs(a.last - (NOW - 2 * DAY)) < 2);
  assert.equal(rows.find((r) => r.id === "B").keyword, "google.com");

  // Chrome holds the file in exclusive mode: still readable, not writable.
  const chrome = new DatabaseSync(file);
  chrome.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  assert.equal(isLocked(file), true);
  assert.equal(readRows(file).length, 2);
  const backupDir = join(folder, "backups");
  assert.equal(apply(files, [{ op: "delete", id: "B" }], backupDir, NOW), false);
  assert.deepEqual(backups(backupDir), []);
  chrome.close();
  assert.equal(isLocked(file), false);

  assert.equal(apply(files, [{ op: "delete", id: "B" }, { op: "put", text: "ver", url: "https://vercel.com/" }, { op: "put", text: "s", url: "https://supabase.com/", title: "Supabase" }], backupDir, NOW), true);
  const after = readRows(file);
  assert.deepEqual(after.map((r) => r.text).sort(), ["s", "ver"]);
  assert.equal(after.find((r) => r.text === "ver").hits, PUT_HITS);
  assert.ok(Math.abs(after.find((r) => r.text === "ver").last - NOW) < 2);
  const added = after.find((r) => r.text === "s");
  assert.deepEqual([added.contents, added.description, added.hits], ["supabase.com/", "Supabase", PUT_HITS]);
  assert.equal(suggest(after, "s", NOW)[0].url, "https://supabase.com/");

  const [backup] = backups(backupDir).map((b) => b.name);
  assert.match(backup, /^2026-11-\d{2}-\d{2}-\d{2}-\d{2}\.sqlite$/);
  // In the same second: the backup taken before restoring must not overwrite the one being restored.
  assert.equal(apply(files, [{ op: "restore", backup }], backupDir, NOW), true);
  assert.deepEqual(readRows(file).map((r) => r.id).sort(), ["A", "B"]);
  const names = backups(backupDir).map((b) => b.name);
  assert.deepEqual(names, [backup.replace(".sqlite", "-2.sqlite"), backup]);
  // The "-2" copy is the state before the restore: the changed rows.
  assert.equal(apply(files, [{ op: "restore", backup: names[0] }], backupDir, NOW), true);
  assert.deepEqual(readRows(file).map((r) => r.text).sort(), ["s", "ver"]);
});

const hist = (url, typed, visits, daysAgo, title = "") => ({ url, title, typed, visits, last: NOW - daysAgo * DAY });

test("history: typed addresses complete first, and a typed site root goes before its pages", () => {
  const team = "https://vercel.com/team/~/deployments", other = "https://vercel.com/speys/~/deployments", root = "https://vercel.com/";
  const shortcuts = [row("a", "vercel", other, 25, 0)];
  const history = [hist(team, 76, 125, 0), hist(root, 0, 2, 0), hist(other, 0, 28, 0), hist("https://vercel.app/", 0, 1, 40)];
  // The most typed address wins over the freshest shortcut, and completes in place.
  let list = suggest(shortcuts, "vercel", NOW, history);
  assert.deepEqual([list[0].url, list[0].inline, list[1].url], [team, true, other]);
  // Never typed, but visited often in the last 3 days: still a candidate, after the typed ones.
  assert.deepEqual(historyMatches(history, "vercel", NOW).map((h) => h.url), [team, other]);
  // Typing the root once is enough to put it first.
  const typedRoot = applyHistory(history, [{ op: "typed", url: root, count: 1 }]);
  assert.deepEqual(historyMatches(typedRoot, "vercel", NOW).map((h) => h.url), [root, team, other]);
  assert.equal(suggest(shortcuts, "VERCEL", NOW, typedRoot)[0].url, root);

  // Put first: typed once more than the most typed, and the root stops counting as typed.
  const ops = putFirst(shortcuts, typedRoot, [], "vercel", other, "", NOW);
  assert.deepEqual(ops.filter((o) => o.op === "typed"), [{ op: "typed", url: other, count: 77 }, { op: "typed", url: root, count: 0 }]);
  list = suggest(applyOps(shortcuts, ops, NOW), "vercel", NOW, applyHistory(typedRoot, ops));
  assert.deepEqual([list[0].url, list[0].inline], [other, true]);
  // An address history doesn't know: the typed matches stop counting instead.
  const fresh = putFirst(shortcuts, typedRoot, [], "vercel", "https://new.example/", "", NOW).filter((o) => o.op === "typed");
  assert.deepEqual(fresh, [{ op: "typed", url: team, count: 0 }, { op: "typed", url: root, count: 0 }]);

  // Remove takes the shortcut rows and the typing.
  const group = suggest(shortcuts, "vercel", NOW, history).find((g) => g.url === team);
  assert.deepEqual(removeSuggestion(group), [{ op: "typed", url: team, count: 0 }]);
});

test("history file: reads only what the address bar uses, writes only the typed count", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "address-bar-history-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, "Default"));
  const files = { shortcuts: shortcutsFile(folder, "Default"), history: historyFile(folder, "Default") };
  createShortcuts(files.shortcuts, []);
  const now = Date.now();
  createHistory(files.history, [
    { url: "https://vercel.com/", title: "Vercel", typed: 1, visits: 2, last: now - DAY },
    { url: "https://vercel.com/speys", title: "Speys", typed: 0, visits: 28, last: now - DAY },
    { url: "https://old.example/", typed: 0, visits: 50, last: now - 30 * DAY },
    { url: "https://once.example/", typed: 0, visits: 1, last: now },
  ]);
  assert.deepEqual(readHistory(files.history, now).map((h) => [h.url, h.typed, h.visits]).sort(), [["https://vercel.com/", 1, 2], ["https://vercel.com/speys", 0, 28]]);
  assert.deepEqual(readHistory(join(folder, "missing", "History")), []);

  const backupDir = join(folder, "backups");
  // Only history changes: only history is copied.
  assert.equal(apply(files, [{ op: "typed", url: "https://vercel.com/speys", count: 5 }, { op: "typed", url: "https://vercel.com/", count: 0 }], backupDir, now), true);
  // The root is no longer typed and rarely visited, so the address bar no longer uses it.
  assert.deepEqual(readHistory(files.history, now).map((h) => [h.url, h.typed, h.visits, h.title]), [["https://vercel.com/speys", 5, 28, "Speys"]]);
  // Its visits and title stay: only the typed count changed.
  const db = new DatabaseSync(files.history, { readOnly: true });
  assert.deepEqual({ ...db.prepare("SELECT typed_count, visit_count, title FROM urls WHERE url = ?").get("https://vercel.com/") }, { typed_count: 0, visit_count: 2, title: "Vercel" });
  assert.equal(db.prepare("SELECT count(*) AS n FROM urls").get().n, 4);
  db.close();
  const [first] = backups(backupDir);
  assert.deepEqual([first.shortcuts, first.history], [false, true]);

  // Locked history: nothing is written, nothing copied.
  const chrome = new DatabaseSync(files.history);
  chrome.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  assert.equal(apply(files, [{ op: "typed", url: "https://vercel.com/", count: 3 }], backupDir, now), false);
  chrome.close();
  assert.equal(backups(backupDir).length, 1);

  // Both files under one name; restoring it puts both back.
  assert.equal(apply(files, [{ op: "put", text: "v", url: "https://vercel.com/speys" }, { op: "typed", url: "https://vercel.com/", count: 9 }], backupDir, now), true);
  const [both] = backups(backupDir);
  assert.deepEqual([both.shortcuts, both.history], [true, true]);
  assert.equal(apply(files, [{ op: "restore", backup: both.name }], backupDir, now), true);
  assert.deepEqual(readRows(files.shortcuts), []);
  assert.deepEqual(readHistory(files.history, now).map((h) => [h.url, h.typed]), [["https://vercel.com/speys", 5]]);

  assert.deepEqual(cleanOp({ op: "typed", url: "https://vercel.com/a b", count: 0 }), { op: "typed", url: "https://vercel.com/a b", count: 0 });
  assert.equal(cleanOp({ op: "typed", url: "https://vercel.com/", count: -1 }), null);
  assert.equal(cleanOp({ op: "typed", url: "https://vercel.com/", count: 1.5 }), null);
});
