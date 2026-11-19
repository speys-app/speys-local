// Chrome's profiles and two files in each that decide what the address bar fills in: "Shortcuts" (what you typed and
// which suggestion you then picked) and "History" (how often each address was typed in by hand). Chrome holds both
// locked while it runs, so reading goes through SQLite's immutable mode and writing waits for Chrome to close.
// Every write keeps a copy of the files it changes first.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { PUT_HITS, bare } from "./rank.js";

/** Chrome counts microseconds from 1601; these are its milliseconds before 1970. */
const EPOCH_MS = 11644473600000;
const KEEP_BACKUPS = 20;
/** History is tens of megabytes: fewer copies. */
const KEEP_HISTORY_BACKUPS = 5;
/** What history rows the address bar can use: typed ones, and ones visited often in the last 3 days. */
const RECENT_VISITS = 4;
const RECENT_MS = 3 * 86400_000;
export const BACKUP_RE = /^[\w-]+\.sqlite$/;

export function defaultFolder(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return join(home, ".config", "google-chrome");
}

export const shortcutsFile = (folder, profile) => join(folder, profile, "Shortcuts");
export const historyFile = (folder, profile) => join(folder, profile, "History");

/** Profiles that have a Shortcuts file, named the way Chrome's profile menu names them. */
export function profiles(folder) {
  let cache = {}, lastUsed = "";
  try {
    const state = JSON.parse(readFileSync(join(folder, "Local State"), "utf8"));
    cache = state.profile?.info_cache || {};
    lastUsed = state.profile?.last_used || "";
  } catch {}
  let dirs = Object.keys(cache);
  if (!dirs.length) {
    try { dirs = readdirSync(folder).filter((d) => d === "Default" || /^Profile \d+$/.test(d)); } catch {}
  }
  return dirs.filter((dir) => existsSync(shortcutsFile(folder, dir))).map((dir) => {
    const info = cache[dir] || {};
    const name = info.is_using_default_name && info.gaia_name ? info.gaia_name : info.name || dir;
    return { dir, name, account: info.user_name || "", lastUsed: dir === lastUsed };
  });
}

/** True while Chrome (or anything) holds the file: then it can be read but not changed. */
export function isLocked(file) {
  let db;
  try {
    db = new DatabaseSync(file, { timeout: 0 });
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return false;
  } catch (e) {
    if (/locked|busy/i.test(e.message)) return true;
    throw e;
  } finally {
    db?.close();
  }
}

const COLUMNS = `id, text, fill_into_edit AS fill, url, contents, description, type, keyword, number_of_hits AS hits,
  (last_access_time / 1000 - ${EPOCH_MS}) AS last`;

function readOnly(file, read) {
  const url = pathToFileURL(file);
  url.searchParams.set("immutable", "1");
  const db = new DatabaseSync(url, { readOnly: true });
  try {
    return read(db).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
}

/** Every learned shortcut; works while Chrome is open. */
export const readRows = (file) => readOnly(file, (db) => db.prepare(`SELECT ${COLUMNS} FROM omni_box_shortcuts`).all());

/** The history addresses the address bar can complete: typed in by hand, or visited often lately. Not the rest of history. */
export function readHistory(file, now = Date.now()) {
  if (!existsSync(file)) return [];
  return readOnly(file, (db) => db.prepare(`SELECT url, title, visit_count AS visits, typed_count AS typed,
      (last_visit_time / 1000 - ${EPOCH_MS}) AS last FROM urls
    WHERE hidden = 0 AND (typed_count > 0 OR (visit_count >= ? AND last_visit_time / 1000 - ${EPOCH_MS} > ?))`)
    .all(RECENT_VISITS, Math.round(now - RECENT_MS)));
}

const historyBackups = (dir) => join(dir, "history");
const names = (dir) => { try { return readdirSync(dir).filter((f) => BACKUP_RE.test(f)); } catch { return []; } };
/** Newest first, "-2" after its plain twin from the same second. */
const order = (f) => f.replace(/\.sqlite$/, "").replace(/^(\d{4}(?:-\d{2}){5})$/, "$1-1").replace(/-(\d+)$/, (_, n) => `-${n.padStart(4, "0")}`);
const newestFirst = (list) => list.sort((a, b) => order(b).localeCompare(order(a)));

/** Copies taken before changes, newest first: { name, shortcuts, history } says which files each one holds. */
export function backups(dir) {
  const s = new Set(names(dir)), h = new Set(names(historyBackups(dir)));
  return newestFirst([...new Set([...s, ...h])]).map((name) => ({ name, shortcuts: s.has(name), history: h.has(name) }));
}

const pad = (n) => String(n).padStart(2, "0");
/** Local time, so the name reads as the clock on the wall; a second one in the same second gets "-2". */
function backupName(dirs, d) {
  const base = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("-");
  let name = `${base}.sqlite`;
  for (let i = 2; dirs.some((dir) => existsSync(join(dir, name))); i++) name = `${base}-${i}.sqlite`;
  return name;
}

/** Opening the file lets SQLite finish what a crashed Chrome left in its journal, so the copy is whole. */
function settle(file) {
  const db = new DatabaseSync(file, { timeout: 2000 });
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } finally {
    db.close();
  }
}

function prune(dir, keep) {
  for (const old of newestFirst(names(dir)).slice(keep)) rmSync(join(dir, old), { force: true });
}

/** Applies queued changes when the files are free: false while Chrome holds one. `files` is { shortcuts, history };
    each file a change touches is copied to `backupDir` first (history to its "history" folder), under one name. */
export function apply(files, ops, backupDir, now = Date.now()) {
  const hDir = historyBackups(backupDir);
  const restore = ops.find((o) => o.op === "restore");
  const touch = {
    shortcuts: restore ? existsSync(join(backupDir, restore.backup)) : ops.some((o) => o.op === "delete" || o.op === "put"),
    history: (restore ? existsSync(join(hDir, restore.backup)) : ops.some((o) => o.op === "typed")) && existsSync(files.history),
  };
  const used = ["shortcuts", "history"].filter((k) => touch[k]);
  if (used.some((k) => isLocked(files[k]))) return false;
  used.forEach((k) => settle(files[k]));
  const name = backupName([backupDir, hDir], new Date(now));
  try {
    if (touch.shortcuts) { mkdirSync(backupDir, { recursive: true }); copyFileSync(files.shortcuts, join(backupDir, name)); }
    if (touch.history) { mkdirSync(hDir, { recursive: true }); copyFileSync(files.history, join(hDir, name)); }
    if (restore) {
      if (touch.shortcuts) copyFileSync(join(backupDir, restore.backup), files.shortcuts);
      if (touch.history) copyFileSync(join(hDir, restore.backup), files.history);
    } else {
      if (touch.shortcuts) writeShortcuts(files.shortcuts, ops, now);
      if (touch.history) writeHistory(files.history, ops);
    }
  } finally {
    prune(backupDir, KEEP_BACKUPS);
    prune(hDir, KEEP_HISTORY_BACKUPS);
  }
  return true;
}

function transaction(file, work) {
  const db = new DatabaseSync(file, { timeout: 2000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    work(db);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  } finally {
    db.close();
  }
}

function writeShortcuts(file, ops, now) {
  const at = BigInt(Math.round(now)), epoch = BigInt(EPOCH_MS);
  transaction(file, (db) => {
    const remove = db.prepare("DELETE FROM omni_box_shortcuts WHERE id = ?");
    const sameUrl = db.prepare("SELECT id, text, number_of_hits AS hits FROM omni_box_shortcuts WHERE url = ?");
    const touch = db.prepare("UPDATE omni_box_shortcuts SET number_of_hits = ?, last_access_time = (? + ?) * 1000 WHERE id = ?");
    const insert = db.prepare(`INSERT INTO omni_box_shortcuts (id, text, fill_into_edit, url, document_type, contents,
      contents_class, description, description_class, transition, type, keyword, last_access_time, number_of_hits)
      VALUES (?, ?, ?, ?, 0, ?, '0,1', ?, '0,0', 1, 1, '', (? + ?) * 1000, ?)`);
    for (const op of ops) {
      if (op.op === "delete") remove.run(op.id);
      if (op.op === "put") {
        const same = sameUrl.all(op.url).find((r) => r.text.toLocaleLowerCase() === op.text.toLocaleLowerCase());
        if (same) touch.run(Math.max(same.hits, PUT_HITS), at, epoch, same.id);
        else insert.run(randomUUID().toUpperCase(), op.text, op.url, op.url, bare(op.url), op.title || "", at, epoch, PUT_HITS);
      }
    }
  });
}

/** Only the typed count changes: visits, titles and the rest of history stay as they are. */
function writeHistory(file, ops) {
  transaction(file, (db) => {
    const set = db.prepare("UPDATE urls SET typed_count = ? WHERE url = ?");
    for (const op of ops) if (op.op === "typed") set.run(op.count, op.url);
  });
}

/** A change from the page, checked; null when it isn't one. */
export function cleanOp(op, backupNames = []) {
  if (!op || typeof op !== "object") return null;
  if (op.op === "delete" && typeof op.id === "string" && op.id.length <= 100) return { op: "delete", id: op.id };
  if (op.op === "put") {
    const text = String(op.text ?? "").trim(), title = String(op.title ?? "").trim().slice(0, 300);
    if (!text || text.length > 200) return null;
    let url;
    try { url = new URL(String(op.url ?? "").trim()); } catch { return null; }
    if (!["http:", "https:", "chrome:", "file:"].includes(url.protocol)) return null;
    return { op: "put", text, url: url.href, title };
  }
  // The address exactly as history has it: no reformatting, or it matches nothing.
  if (op.op === "typed" && typeof op.url === "string" && op.url.length <= 8192 && Number.isInteger(op.count) && op.count >= 0 && op.count <= 1e6) {
    return { op: "typed", url: op.url, count: op.count };
  }
  if (op.op === "restore" && BACKUP_RE.test(op.backup) && backupNames.includes(op.backup)) return { op: "restore", backup: op.backup };
  return null;
}

/** Writes a History file with the urls table Chrome reads for the address bar; for tests and the demo workspace. */
export function createHistory(file, rows) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL,
      hidden INTEGER DEFAULT 0 NOT NULL)`);
    const insert = db.prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, ?, ?, (? + ?) * 1000)");
    for (const r of rows) insert.run(r.url, r.title ?? "", r.visits ?? 1, r.typed ?? 0, BigInt(Math.round(r.last)), BigInt(EPOCH_MS));
  } finally {
    db.close();
  }
}

/** Writes a Shortcuts file Chrome would read; for tests and the demo workspace. */
export function createShortcuts(file, rows) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      INSERT OR REPLACE INTO meta VALUES ('version', '2'), ('last_compatible_version', '1');
      CREATE TABLE IF NOT EXISTS omni_box_shortcuts(id VARCHAR PRIMARY KEY, text VARCHAR, fill_into_edit VARCHAR, url VARCHAR,
        document_type INTEGER, contents VARCHAR, contents_class VARCHAR, description VARCHAR, description_class VARCHAR,
        transition INTEGER, type INTEGER, keyword VARCHAR, last_access_time INTEGER, number_of_hits INTEGER);`);
    const insert = db.prepare(`INSERT INTO omni_box_shortcuts VALUES (?, ?, ?, ?, 0, ?, '0,1', ?, '0,0', ?, ?, ?, (? + ?) * 1000, ?)`);
    for (const r of rows) {
      const search = !!r.keyword;
      insert.run(r.id || randomUUID().toUpperCase(), r.text, r.fill ?? r.url, r.url, r.contents ?? (search ? r.text : bare(r.url)),
        r.description ?? "", search ? 5 : 1, search ? 7 : 1, r.keyword ?? "", BigInt(Math.round(r.last)), BigInt(EPOCH_MS), r.hits ?? 1);
    }
  } finally {
    db.close();
  }
}
