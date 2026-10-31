// Store: applets other people wrote. store.json in this repo lists the versions the maintainer approved; every version
// is a review, so an entry pins an exact commit and nothing updates by itself. Installing goes on the network only
// when the user clicks, and runs nothing from the download.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RECORD = ".store.json";
const MAX_FILES = 2000;

/** The problem with a catalog entry, or null. */
export function entryProblem(e) {
  if (!ID.test(e?.id ?? "")) return "id: lowercase letters, digits and dashes";
  for (const field of ["name", "description", "author", "version"]) {
    if (typeof e[field] !== "string" || !e[field].trim()) return `${field}: required`;
  }
  if (!REPO.test(e.repo ?? "")) return "repo: an https://github.com/owner/name address";
  if (!COMMIT.test(e.commit ?? "")) return "commit: the full 40-character hash of the approved version";
  return null;
}

export function readCatalog(root) {
  const { applets = [] } = JSON.parse(readFileSync(join(root, "store.json"), "utf8"));
  return applets;
}

export function installedApplets(storeDir) {
  if (!existsSync(storeDir)) return {};
  const found = {};
  for (const id of readdirSync(storeDir)) {
    try {
      found[id] = JSON.parse(readFileSync(join(storeDir, id, RECORD), "utf8"));
    } catch {
      // not an installed applet
    }
  }
  return found;
}

const run = (args, cwd) => new Promise((done, fail) => {
  execFile("git", args, {
    cwd, timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_LFS_SKIP_SMUDGE: "1" },
  }, (error, stdout, stderr) => (error ? fail(new Error((stderr || error.message).trim().split("\n").at(-1))) : done()));
});

/** Exactly the approved commit, with hooks and symlinks off. */
async function fetchCommit({ repo, commit }, dir) {
  await run(["init", "--quiet", "--template="], dir);
  await run(["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "fetch", "--quiet", "--depth", "1", "--no-tags", repo, commit], dir);
  await run(["-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "checkout", "--quiet", "FETCH_HEAD"], dir);
}

function checkFiles(dir) {
  let count = 0;
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name), info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`symlink not allowed: ${name}`);
      if (++count > MAX_FILES) throw new Error("too many files");
      if (info.isDirectory()) walk(path);
    }
  };
  walk(dir);
}

const insideFolder = (p) => !isAbsolute(p) && !normalize(p).startsWith(`..${sep}`) && normalize(p) !== "..";

function checkManifest(dir) {
  const file = join(dir, "applet.json");
  if (!existsSync(file)) throw new Error("no applet.json at the top of the repository");
  const a = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["backend", "page", "icon"]) {
    if (a[key] !== undefined && (typeof a[key] !== "string" || !insideFolder(a[key]))) throw new Error(`applet.json: ${key} points outside the applet`);
  }
  if (a.url !== undefined) throw new Error("applet.json: url is not allowed in the Store");
  if ((a.settings || []).some((f) => f.section !== undefined)) throw new Error("applet.json: settings cannot reach another applet's section");
}

/** Installs or updates. The old version stays in place until the new one has passed every check. */
export async function installApplet(entry, storeDir, { fetchRepo = fetchCommit, reserved = [] } = {}) {
  const problem = entryProblem(entry);
  if (problem) throw new Error(problem);
  if (reserved.includes(entry.id)) throw new Error(`${entry.id} is the id of a built-in applet`);
  mkdirSync(storeDir, { recursive: true });
  const temp = mkdtempSync(join(storeDir, ".install-"));
  try {
    await fetchRepo(entry, temp);
    rmSync(join(temp, ".git"), { recursive: true, force: true });
    checkFiles(temp);
    checkManifest(temp);
    writeFileSync(join(temp, RECORD), JSON.stringify({ commit: entry.commit, version: entry.version }, null, 2) + "\n");
    const target = join(storeDir, entry.id);
    rmSync(target, { recursive: true, force: true });
    renameSync(temp, target);
  } catch (e) {
    rmSync(temp, { recursive: true, force: true });
    throw e;
  }
}

export function removeApplet(id, storeDir) {
  if (!ID.test(id ?? "")) throw new Error("bad id");
  rmSync(join(storeDir, id), { recursive: true, force: true });
}
