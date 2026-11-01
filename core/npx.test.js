import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const LAUNCHER = join(import.meta.dirname, "..", "bin", "speys-local.js");
const skip = process.platform === "win32" && "the stand-in git is a shell script";

// A home folder and an empty PATH, so nothing here can touch the real clone or the network
function run(t, { git, prepare } = {}) {
  const home = mkdtempSync(join(tmpdir(), "speys-npx-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  if (git) {
    writeFileSync(join(bin, "git"), `#!/bin/sh\n${git}\n`);
    chmodSync(join(bin, "git"), 0o755);
  }
  prepare?.(join(home, "speys-local"));
  const r = spawnSync(process.execPath, [LAUNCHER, "--port", "3999"], {
    encoding: "utf8",
    env: { HOME: home, USERPROFILE: home, PATH: bin },
  });
  return { ...r, home, folder: join(home, "speys-local") };
}

function fakeApp(folder) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), '{ "name": "speys-local" }');
  writeFileSync(join(folder, "start.js"), 'console.log("started", process.argv.slice(2).join(" "));');
}

test("the first run clones, then starts with the given options", { skip }, (t) => {
  const r = run(t, {
    git: `echo "$@" > "$HOME/git-args"; /bin/mkdir "$3"; echo '{"name":"speys-local"}' > "$3/package.json"; echo 'console.log("started", process.argv.slice(2).join(" "));' > "$3/start.js"`,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(r.home, "git-args"), "utf8").trim(), `clone https://github.com/speys-app/speys-local.git ${r.folder}`);
  assert.match(r.stdout, /started --port 3999/);
});

test("an existing install starts without calling git", { skip }, (t) => {
  const r = run(t, { git: 'touch "$HOME/git-called"; exit 1', prepare: fakeApp });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started --port 3999/);
  assert.equal(existsSync(join(r.home, "git-called")), false);
});

test("someone else's folder is left alone", { skip }, (t) => {
  const r = run(t, {
    prepare: (folder) => {
      mkdirSync(folder);
      writeFileSync(join(folder, "start.js"), 'console.log("started");');
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't Speys Local/);
  assert.doesNotMatch(r.stdout, /started/);
});

test("missing git says what to install", { skip }, (t) => {
  const r = run(t);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs git/);
});

test("a failed clone stops with git's exit code", { skip }, (t) => {
  const r = run(t, { git: "exit 128" });
  assert.equal(r.status, 128);
  assert.equal(existsSync(r.folder), false);
});

test("only the launcher goes into the npm package", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.deepEqual(pkg.files, ["bin"]);
  assert.equal(pkg.bin["speys-local"], "bin/speys-local.js");
});
