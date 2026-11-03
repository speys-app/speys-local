// Regression tests for issue #9: a truncated JSONL line must not break the applet,
// and a half-written sonuc.json must not throw.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonLines, readJsonFile } from "./backend.js";

test("parseJsonLines keeps valid rows and skips a truncated last line", () => {
  const text = '{"a":1}\n{"a":2}\n{"a":3,"b":';
  assert.deepEqual(parseJsonLines(text), [{ a: 1 }, { a: 2 }]);
});

test("parseJsonLines ignores blank lines and respects the limit", () => {
  const text = [1, 2, 3, 4].map((n) => JSON.stringify({ n })).join("\n") + "\n\n";
  assert.deepEqual(parseJsonLines(text, 2), [{ n: 3 }, { n: 4 }]);
  assert.deepEqual(parseJsonLines(""), []);
  assert.deepEqual(parseJsonLines(undefined), []);
});

test("readJsonFile returns {} for a missing or half-written file", () => {
  const dir = mkdtempSync(join(tmpdir(), "yazim-"));
  const bad = join(dir, "sonuc.json");
  writeFileSync(bad, '{"uretildi":"2026-11');
  assert.deepEqual(readJsonFile(bad), {});
  assert.deepEqual(readJsonFile(join(dir, "missing.json")), {});
  writeFileSync(bad, '{"uretildi":"2026-11-01 02:00"}');
  assert.deepEqual(readJsonFile(bad), { uretildi: "2026-11-01 02:00" });
});
