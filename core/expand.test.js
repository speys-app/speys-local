import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expand } from "../lib/common.js";

test("~ expands with either slash, other paths stay as they are", () => {
  assert.equal(expand("~/a"), join(homedir(), "a"));
  assert.equal(expand("~\\a"), join(homedir(), "a"));
  assert.equal(expand("C:\\a"), "C:\\a");
  assert.equal(expand("~a"), "~a");
  assert.equal(expand(undefined), undefined);
});
