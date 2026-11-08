import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activity, classify, currentStep, findTranscript, segments, shortCommand, stepDetail, words } from "./activity.js";
import { allSessions } from "./sessions.js";

const ROOT = "/Users/someone/repo";

test("a command is sorted by what it reaches, not by the words in its arguments", () => {
  const cases = [
    ["git push origin main", "deploy"],
    ['cd "/Users/someone/repo" && git push', "deploy"],
    ["npx vercel --prod", "deploy"],
    ["gh pr create --fill", "deploy"],
    ["npx supabase db push", "db"],
    ['psql "$DATABASE_URL" -c "select 1"', "db"],
    ["DATABASE_URL=x bun run seed.ts", "db"],
    ["bun run migrate --apply", "db"],
    ["git -C /Users/someone/repo commit -m hi", "git"],
    ["git stash", "git"],
    ["curl https://example.com/api", "network"],
    ["ssh server uptime", "network"],
    ["echo hi > ~/.zshrc", "outside"],
    ["rm -rf /Users/someone/other/build", "outside"],
    ["grep -rn 'supabase' src", null],
    ["for k in posthog '@vercel/analytics'; do grep -r $k src; done", null],
    ["grep 'a\\|git push' notes.md", null],
    ["curl -s http://localhost:3000/health", null],
    ["git status && git diff", null],
    ["git stash list", null],
    ["cat /Users/someone/other/x | head", null],
    ["echo hi > out.txt 2>/dev/null", null],
    ["cp a.txt /tmp/claude/scratchpad/a.txt", null],
    ['mkdir -p /Users/someone/repo/"a b"/y && rm -rf /Users/someone/repo/"build dir"', null],
    ['cd /Users/someone && echo x >> "/Users/someone/other dir/log.txt"', "outside"],
    ["python3 - <<'PY'\nimport os\nos.system('psql')\nopen('/Users/someone/other/x','w')\nPY", null],
  ];
  for (const [command, expected] of cases) assert.equal(classify(command, ROOT), expected, command);
});

test("a command line splits at unquoted separators only", () => {
  assert.deepEqual(segments('cd "a;b" && sudo rm x | tee "c|d"'), ['cd "a;b"', "rm x", 'tee "c|d"']);
  assert.equal(shortCommand('cd "/Users/someone/repo" && npm test\nmore'), "npm test");
  assert.equal(shortCommand('cd ~/a/"b c"/d && npm test'), "npm test");
  assert.deepEqual(words('rm ~/a/"b c"/d 2>/dev/null >>log'), ["rm", "~/a/b c/d", "2", ">", "/dev/null", ">>", "log"]);
});

/** A transcript in Claude Code's own shape: a tool call on one line, its result on another. */
function transcriptWriter(file, cwd, prefix = "t") {
  let n = 0;
  const line = (entry) => appendFileSync(file, JSON.stringify({ cwd, timestamp: new Date().toISOString(), ...entry }) + "\n");
  return {
    prompt: (text) => line({ type: "user", message: { role: "user", content: text } }),
    call(name, input, { result = {}, error = false, open = false } = {}) {
      const id = `${prefix}${++n}`;
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
      if (!open) line({ type: "user", toolUseResult: result, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: error, content: "" }] } });
      return id;
    },
    say: (text) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
  };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "claude-activity-"));
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "src"));
  const logs = join(home, "claude", "projects", "repo");
  mkdirSync(logs, { recursive: true });
  const file = join(logs, "abc-123.jsonl");
  writeFileSync(file, "");
  return { home, repo, logs, file, folders: [{ path: join(home, "claude"), label: "Claude" }] };
}

test("what a session read, changed, opened and ran outside its project", () => {
  const { repo, logs, file, folders } = setup();
  const elsewhere = join(homedir(), "speys-activity-test", "notes.md");
  const w = transcriptWriter(file, join(repo, "src"));
  w.prompt("fix the webhook");
  w.prompt("<system-reminder>ignore</system-reminder>");
  w.call("Read", { file_path: join(repo, "src", "a.js") });
  w.call("Read", { file_path: join(repo, "src", "a.js") });
  w.call("Read", { file_path: elsewhere });
  w.call("Grep", { pattern: "x", path: "." }); // relative to where it started: inside, so not listed
  w.call("Edit", { file_path: join(repo, "src", "a.js"), old_string: "a", new_string: "b" }, { result: { structuredPatch: [{ lines: [" a", "+b", "+c", "-d"] }] } });
  w.call("Edit", { file_path: join(repo, "src", "b.js"), old_string: "a", new_string: "b" }, { error: true });
  w.call("Write", { file_path: join(repo, "src", "new.js"), content: "1\n2\n3" }, { result: { type: "create" } });
  w.call("Write", { file_path: elsewhere, content: "x" }, { result: { type: "update", structuredPatch: [{ lines: ["+x"] }] } });
  w.call("WebFetch", { url: "https://docs.example.com/hooks", prompt: "?" });
  w.call("WebSearch", { query: "claude code hooks" });
  w.call("Bash", { command: "curl -s https://api.example.com/v1" });
  w.call("Bash", { command: "git push origin main" }, { error: true });
  w.call("Bash", { command: "npm test" });
  w.call("mcp__claude_ai_Speys_Mcp__tasks_add_item", { title: "x" });
  w.call("mcp__ide__getDiagnostics", {});
  mkdirSync(join(logs, "abc-123", "subagents"), { recursive: true });
  transcriptWriter(join(logs, "abc-123", "subagents", "agent-1.jsonl"), repo).call("Read", { file_path: join(repo, "README.md") });

  assert.equal(findTranscript(folders, "abc-123"), file);
  assert.equal(findTranscript(folders, "../etc/passwd"), "");
  const a = activity(file);
  const changed = Object.fromEntries(a.degisen.map((c) => [c.yol, c]));
  assert.deepEqual(Object.keys(changed).sort(), ["src/a.js", "src/new.js", "~/speys-activity-test/notes.md"]);
  assert.equal(changed["src/a.js"].eklenen, 2);
  assert.equal(changed["src/a.js"].silinen, 1);
  assert.equal(changed["src/new.js"].yeni, true);
  assert.equal(changed["src/new.js"].eklenen, 3);
  assert.equal(changed["~/speys-activity-test/notes.md"].disarida, true);
  assert.equal(changed["src/a.js"].disarida, undefined);

  const read = Object.fromEntries(a.okunan.map((r) => [r.yol, r]));
  assert.equal(read["src/a.js"].kez, 2);
  assert.equal(read["~/speys-activity-test/notes.md"].disarida, true);
  assert.ok(read["README.md"], "a subagent's reads count too");
  assert.equal(Object.keys(read).length, 3);

  assert.deepEqual(a.web.map((w) => w.tur).sort(), ["curl", "fetch", "search"]);
  assert.deepEqual(a.disarida.map((o) => [o.tur, o.hata]).sort(), [["deploy", true], ["mcp-write", false]]);
  assert.deepEqual(a.sayilar, { komut: 3, ajan: 0, arac: 16 });
  assert.equal(a.kayit.filter((e) => e.tur !== "mesaj").length, 16);
  assert.deepEqual(a.kayit.filter((e) => e.tur === "mesaj").map((e) => [e.kim, e.metin]), [["sen", "fix the webhook"]]);
  const edit = a.kayit.find((e) => e.tur === "edit" && e.yol === "src/a.js");
  assert.deepEqual([edit.eklenen, edit.silinen], [2, 1]);
  assert.equal(a.kayit.find((e) => e.yol === "~/speys-activity-test/notes.md" && e.tur === "write").disarida, true);
  assert.equal(a.kayit.find((e) => e.komut === "git push origin main").dis, "deploy");
});

test("only the lines added since the last look are read, and an open call is what it is doing", () => {
  const { repo, file } = setup();
  const w = transcriptWriter(file, repo);
  w.call("Read", { file_path: join(repo, "a.js") });
  assert.equal(activity(file).okunan.length, 1);
  w.call("Read", { file_path: join(repo, "b.js") });
  w.call("Bash", { command: 'cd "x" && npm test' }, { open: true });
  appendFileSync(file, '{"type":"assistant","message":{"content":[{"type":"tool_use"'); // half written
  const a = activity(file);
  assert.equal(a.okunan.length, 2);
  assert.equal(a.simdi.ad, "npm test");
  assert.equal(a.simdi.hata, null);

  writeFileSync(file, ""); // written anew, longer than before: read from the start, not from where it was
  const again = transcriptWriter(file, repo, "n");
  for (let i = 0; i < 6; i++) again.call("Read", { file_path: join(repo, `new-${i}.js`) });
  assert.deepEqual(activity(file).okunan.map((r) => r.yol).sort(), [0, 1, 2, 3, 4, 5].map((i) => `new-${i}.js`));
});

test("the step over the desk: an unanswered call, else nothing", () => {
  const use = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  assert.deepEqual(currentStep([use("1", "Read", { file_path: "/x/a.js" })]), { tur: "read", ad: "a.js" });
  assert.equal(currentStep([use("1", "Read", { file_path: "/x/a.js" }), result("1")]), null);
  assert.equal(currentStep([use("1", "Read", {}), result("1"), { type: "assistant", message: { content: [{ type: "text", text: "done" }] } }]), null);
  assert.deepEqual(currentStep([use("1", "WebSearch", { query: "q" }), { type: "ai-title" }]), { tur: "search", ad: "q" });
});

test("every session is listed, titled by its first request when it has no title", () => {
  const { repo, file, folders, home } = setup();
  transcriptWriter(file, repo).prompt("<command-name>/clear</command-name>");
  transcriptWriter(file, repo).prompt("make the header sticky");
  writeFileSync(join(home, "claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }));
  const { oturumlar, saklama } = allSessions({ folders, projectsRoot: home, t: (s) => s });
  assert.equal(saklama, 90);
  assert.equal(oturumlar.length, 1);
  assert.equal(oturumlar[0].baslik, "make the header sticky");
  assert.equal(oturumlar[0].proje, "repo");
});

test("a step in full: what was asked, what came back, the change it made", () => {
  const { repo, logs, file } = setup();
  const w = transcriptWriter(file, repo);
  const edit = w.call("Edit", { file_path: join(repo, "a.js"), old_string: "a", new_string: "b" }, { result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }], originalFile: "x".repeat(50_000) } });
  appendFileSync(file, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "zzz", content: "x".repeat(30_000) }] } }) + "\n");
  const big = w.call("Bash", { command: "cat big.log", description: "Show the log" });
  const open = w.call("Bash", { command: "npm test" }, { open: true });
  mkdirSync(join(logs, "abc-123", "subagents"), { recursive: true });
  const inAgent = transcriptWriter(join(logs, "abc-123", "subagents", "agent-1.jsonl"), repo, "a").call("WebSearch", { query: "q" });

  const e = stepDetail(file, edit);
  assert.equal(e.durum, "ok");
  assert.deepEqual(e.yama, ["@@ -1,1 +1,1 @@", "-a", "+b"]);
  assert.equal(JSON.stringify(e).includes("x".repeat(100)), false, "the original file isn't sent");
  assert.equal(stepDetail(file, open).durum, "running");
  assert.equal(stepDetail(file, big).girdi.description, "Show the log");
  assert.equal(stepDetail(file, inAgent).ajan, true);
  assert.equal(stepDetail(file, "nope"), null);

  // a picture Claude read comes back from the transcript, also after its file is gone; only picture types pass
  appendFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: "pic", name: "Read", input: { file_path: "/tmp/x/shot.png" } }] } }) + "\n");
  appendFileSync(file, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "pic", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    { type: "image", source: { type: "base64", media_type: "text/html", data: "PHNjcmlwdD4=" } },
  ] }] } }) + "\n");
  assert.deepEqual(stepDetail(file, "pic").gorseller, ["data:image/png;base64,iVBORw0KGgo="]);
  assert.equal(stepDetail(file, "../x"), null);
});
