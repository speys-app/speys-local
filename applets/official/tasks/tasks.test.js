import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOp, moveBetween, toLf } from "./tasks.js";

const FILE = "# Liste\n\n- [ ] Birinci #bugün\n  not satırı\n  - [ ] alt iş\n- [ ] İkinci\n";

test("no operation when the file has changed", () => {
  assert.equal(applyOp(FILE, { action: "toggle", line: 2, text: "- [ ] Başka", done: true }), null);
});

test("a tick keeps tags and writes then removes the finish date", () => {
  const text = "- [ ] Birinci #bugün";
  const done = applyOp(FILE, { action: "toggle", line: 2, text, done: true }, true).split("\n")[2];
  assert.match(done, /^- \[x\] Birinci #bugün #bitti-\d{4}-\d{2}-\d{2}$/);
  const back = applyOp(FILE.replace(text, done), { action: "toggle", line: 2, text: done, done: false }, true);
  assert.equal(back.split("\n")[2], text);
});

test("deleting also removes the subtasks", () => {
  assert.equal(applyOp(FILE, { action: "delete", line: 2, text: "- [ ] Birinci #bugün" }), "# Liste\n\n- [ ] İkinci\n");
});

test("a new task goes under the title", () => {
  assert.equal(applyOp(FILE, { action: "add", newText: " Yeni  iş " }).split("\n")[2], "- [ ] Yeni iş");
});

test("a task cannot move into its own subtask", () => {
  const op = { action: "move", line: 2, text: "- [ ] Birinci #bugün", targetLine: 4, targetText: "  - [ ] alt iş" };
  assert.equal(applyOp(FILE, op), null);
});

test("moving between lists takes the block with its indentation", () => {
  const moved = moveBetween(FILE, "# Öteki\n", 4, "  - [ ] alt iş");
  assert.equal(moved.target, "# Öteki\n\n- [ ] alt iş");
  assert.ok(!moved.source.includes("alt iş"));
});

test("a CRLF file is read as tasks and keeps its line endings", () => {
  const crlf = FILE.replaceAll("\n", "\r\n");
  const next = applyOp(crlf, { action: "toggle", line: 5, text: "- [ ] İkinci", done: true });
  assert.ok(next.includes("- [x] İkinci\r\n"));
  assert.ok(!/[^\r]\n/.test(next));
  const moved = moveBetween(crlf, "# Hedef\n", 5, "- [ ] İkinci");
  assert.ok(!moved.source.includes("İkinci"));
  assert.equal(moved.target, "# Hedef\n\n- [ ] İkinci");
  assert.equal(toLf("a\r\nb\n"), "a\nb\n");
});
