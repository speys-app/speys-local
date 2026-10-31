import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { hookInstalled, installHook, removeHook } from "./install-hook.js";

const dir = mkdtempSync(join(tmpdir(), "speys-hook-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const HOOK = "/app/applets/official/claude/hook.js";
const folder = (name, settings) => {
  const f = join(dir, name);
  mkdirSync(f);
  if (settings !== undefined) writeFileSync(join(f, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return f;
};
const read = (f) => JSON.parse(readFileSync(join(f, "settings.json"), "utf8"));

test("adds its entries next to the user's own settings and hooks, and keeps a backup", () => {
  const f = folder("a", { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "my-script" }] }] } });
  assert.deepEqual(installHook([f], HOOK), []);
  const s = read(f);
  assert.equal(s.model, "x");
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].command, "my-script");
  assert.ok(hookInstalled([f]));
  assert.ok(existsSync(join(f, "settings.json.speys-backup")));
});

test("installing twice changes nothing, and a moved install replaces the old path", () => {
  const f = folder("b", {});
  installHook([f], HOOK);
  installHook([f], HOOK);
  assert.equal(read(f).hooks.Stop.length, 1);
  installHook([f], "/new/applets/official/claude/hook.js");
  assert.equal(read(f).hooks.Stop.length, 1);
  assert.match(read(f).hooks.Stop[0].hooks[0].command, /\/new\//);
});

test("remove takes only its own entries", () => {
  const f = folder("c", { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-script" }] }] } });
  installHook([f], HOOK);
  removeHook([f]);
  assert.deepEqual(read(f).hooks, { Stop: [{ hooks: [{ type: "command", command: "my-script" }] }] });
  assert.equal(hookInstalled([f]), false);
});

test("a broken settings file is left alone, a missing Claude folder is not created", () => {
  const f = folder("d", "{ not json");
  assert.deepEqual(installHook([f], HOOK), [f]);
  assert.equal(readFileSync(join(f, "settings.json"), "utf8"), "{ not json");
  installHook([join(dir, "missing")], HOOK);
  assert.equal(existsSync(join(dir, "missing")), false);
});
