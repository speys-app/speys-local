// Address Bar: what Chrome fills in as you type, and changing it. Reads Chrome's per-profile "Shortcuts" file and the
// typed addresses in "History"; changes wait in pending.json until Chrome closes, then are applied with a backup first.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expand, readBody, send, writeJson } from "../../../lib/common.js";
import { apply, backups, cleanOp, defaultFolder, historyFile, isLocked, profiles, readHistory, readRows, shortcutsFile } from "./chrome.js";

const WATCH_MS = 3000;
const RESTART_WAIT_MS = 30_000;
const MAX_OPS = 5000;

const run = (cmd, args) => new Promise((done) => execFile(cmd, args, { timeout: 15_000 }, (error) => done(!error)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export default function create({ dataDir, settings, t }) {
  const configured = () => expand(settings().folder?.trim() || "");
  const folder = () => configured() || defaultFolder();
  const pendingFile = join(dataDir, "pending.json");
  const backupDir = (profile) => join(dataDir, "backups", profile.replace(/[^\w-]/g, "_"));
  const files = (profile, f = folder()) => ({ shortcuts: shortcutsFile(f, profile), history: historyFile(f, profile) });
  let timer = null, lastError = "";
  const applied = {};

  /** { folder, profiles: { <dir>: [ops] } }; queued for another folder (the setting changed) means nothing queued. */
  function pending() {
    try {
      const p = JSON.parse(readFileSync(pendingFile, "utf8"));
      return p.folder === folder() ? p : { folder: folder(), profiles: {} };
    } catch {
      return { folder: folder(), profiles: {} };
    }
  }

  function save(p) {
    mkdirSync(dataDir, { recursive: true });
    writeJson(pendingFile, p);
  }

  function tryApply() {
    const p = pending();
    let changed = false;
    for (const [profile, ops] of Object.entries(p.profiles)) {
      const paths = files(profile, p.folder);
      try {
        if (!existsSync(paths.shortcuts) || apply(paths, ops, backupDir(profile))) {
          delete p.profiles[profile];
          applied[profile] = { at: Date.now(), count: ops.length };
          changed = true;
          lastError = "";
        }
      } catch (e) {
        lastError = String(e.message || e);
      }
    }
    if (changed) save(p);
    if (!Object.keys(p.profiles).length && timer) { clearInterval(timer); timer = null; }
  }

  function watch() {
    if (timer || !Object.keys(pending().profiles).length) return;
    timer = setInterval(tryApply, WATCH_MS);
    timer.unref?.();
  }
  watch();

  const known = (profile) => profiles(folder()).some((p) => p.dir === profile);
  const lockedSafe = (file) => { try { return isLocked(file); } catch { return false; } };
  /** macOS, the standard Chrome folder: quit it, apply, open it again with its tabs. */
  const canRestart = () => process.platform === "darwin" && !configured();

  function overview() {
    const f = folder(), queued = pending().profiles;
    const list = profiles(f).map((p) => ({ ...p, pending: queued[p.dir]?.length || 0 }));
    return { folder: f, found: existsSync(f), profiles: list, canRestart: canRestart() };
  }

  function profileData(profile) {
    const paths = files(profile);
    return {
      profile, rows: readRows(paths.shortcuts), history: readHistory(paths.history), open: lockedSafe(paths.shortcuts),
      pending: pending().profiles[profile] || [],
      backups: backups(backupDir(profile)), applied: applied[profile] || null, error: lastError && t(lastError), canRestart: canRestart(),
    };
  }

  async function restart() {
    if (!(await run("osascript", ["-e", 'quit app "Google Chrome"']))) throw new Error("Chrome didn't quit.");
    const held = Object.keys(pending().profiles).flatMap((p) => Object.values(files(p))).filter((f) => existsSync(f));
    const until = Date.now() + RESTART_WAIT_MS;
    while (Date.now() < until && held.some(lockedSafe)) await sleep(500);
    tryApply();
    await run("open", ["-a", "Google Chrome", "--args", "--restore-last-session"]);
  }

  async function post(req, res, handle) {
    if (req.headers["x-panel"] !== "1") return send(res, 403, { error: "forbidden" });
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!known(body.profile)) return send(res, 400, { error: "profile" });
      await handle(body);
      return send(res, 200, profileData(body.profile));
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  return async (req, res) => {
    const url = new URL(req.url, "http://local");
    const path = url.pathname;
    if (req.method === "GET" && (path === "/" || path === "/rank.js")) {
      const [name, type] = path === "/" ? ["index.html", "text/html"] : ["rank.js", "text/javascript"];
      return send(res, 200, readFileSync(join(import.meta.dirname, name)), `${type}; charset=utf-8`);
    }
    if (req.method === "GET" && path === "/api/profiles") return send(res, 200, overview());
    if (req.method === "GET" && path === "/api/rows") {
      const profile = url.searchParams.get("profile") || "";
      if (!known(profile)) return send(res, 400, { error: "profile" });
      try {
        return send(res, 200, profileData(profile));
      } catch (e) {
        return send(res, 500, { error: String(e.message || e) });
      }
    }
    if (req.method === "POST" && path === "/api/pending") {
      return post(req, res, ({ profile, ops }) => {
        const names = backups(backupDir(profile)).map((b) => b.name);
        const clean = (Array.isArray(ops) ? ops : []).slice(0, MAX_OPS).map((o) => cleanOp(o, names)).filter(Boolean);
        // A restore replaces the whole file, so it travels alone.
        const restore = clean.find((o) => o.op === "restore");
        const p = pending();
        if (restore) p.profiles[profile] = [restore];
        else if (clean.length) p.profiles[profile] = clean;
        else delete p.profiles[profile];
        save(p);
        tryApply();
        watch();
      });
    }
    if (req.method === "POST" && path === "/api/restart") {
      return post(req, res, async () => {
        if (!canRestart()) throw new Error(t("Restarting is only available for Chrome on macOS."));
        await restart();
      });
    }
    send(res, 404, { error: "not found" });
  };
}
