#!/usr/bin/env node
// `npx speys-local [start.js options]`: clones the repo to ~/speys-local once, then starts it from there.
// The npm package is only this file: code, data and updates live in that clone.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "https://github.com/speys-app/speys-local.git";
const folder = join(homedir(), "speys-local");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isOurs() {
  try {
    return JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).name === "speys-local";
  } catch {
    return false;
  }
}

if (parseInt(process.versions.node, 10) < 24) {
  fail(`Speys Local needs Node 24 or newer, this is ${process.version}: https://nodejs.org`);
}

if (!existsSync(folder)) {
  console.log(`Installing Speys Local in ${folder}`);
  const clone = spawnSync("git", ["clone", REPO, folder], { stdio: "inherit" });
  if (clone.error) fail("Speys Local needs git to install and update: https://git-scm.com");
  if (clone.status !== 0) process.exit(clone.status ?? 1);
} else if (!isOurs()) {
  fail(`${folder} already exists and isn't Speys Local. Move it and run this again.`);
}

const app = spawnSync(process.execPath, ["start.js", ...process.argv.slice(2)], { cwd: folder, stdio: "inherit" });
process.exit(app.status ?? 0);
