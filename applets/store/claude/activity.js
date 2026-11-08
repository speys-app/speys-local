// What a session did: the files it read and changed, the sites it opened, what it ran outside its project.
// Read from Claude Code's own transcript, so it needs no hook and also covers sessions from before Speys Local.
// Transcripts run to many MB: each file is read once, then only the lines added since the last look.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const CHUNK = 4 << 20;
const MAX_ITEMS = 400;
const LOG = 4000; // entries kept per transcript: messages and tool calls, in order
const SHOWN = 300; // entries sent at a time; the page asks for more
const MESSAGE_CHARS = 4000;
const KEEP_FILES = 40;
const LIVE_S = 120;

/** The repository the session works in: the nearest folder above its start folder with a `.git`, else the start folder. */
export function repoRoot(cwd) {
  if (!cwd) return "";
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return resolve(cwd);
  }
}

const isInside = (path, root) => !!root && (path === root || path.startsWith(root + sep));
const expandHome = (p) => p.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
const firstLine = (s) => String(s ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
/** A command without the `cd <folder> &&` and `NAME=value;` it starts with: they say nothing about what it does. */
export function shortCommand(command) {
  const lead = /^\s*(?:cd\s+|\w+=)(?:"[^"]*"|'[^']*'|[^\s;&"'])*\s*(?:&&|;|\n)\s*/;
  let text = String(command ?? "");
  while (lead.test(text)) text = text.replace(lead, "");
  return firstLine(text) || firstLine(command);
}
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? "");
  }
};

const MCP_WRITE = /(^|_)(add|create|update|delete|remove|set|save|mark|write|send|post|publish|insert|upsert|edit|move|archive|submit|batch|apply|deploy|run)(_|$)/i;

/** One tool call in a few words: what the bubble over the desk and the list of steps show. */
export function describe(name, input = {}) {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  switch (name) {
    case "Read": return { tur: "read", ad: basename(path), yol: path };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { tur: "edit", ad: basename(path), yol: path };
    case "Write": return { tur: "write", ad: basename(path), yol: path };
    case "Bash": return { tur: "bash", ad: shortCommand(input.command), aciklama: String(input.description ?? "") };
    case "Grep": return { tur: "grep", ad: String(input.pattern ?? ""), yol: String(input.path ?? "") };
    case "Glob": return { tur: "glob", ad: String(input.pattern ?? ""), yol: String(input.path ?? "") };
    case "WebFetch": return { tur: "fetch", ad: hostOf(input.url), url: String(input.url ?? "") };
    case "WebSearch": return { tur: "search", ad: String(input.query ?? "") };
    case "Agent": case "Task": return { tur: "agent", ad: String(input.description ?? input.subagent_type ?? "") };
    case "AskUserQuestion": return { tur: "ask", ad: firstLine(input.questions?.[0]?.question) };
    case "TodoWrite": return { tur: "todo", ad: "" };
  }
  if (name.startsWith("mcp__")) {
    const [, server = "", tool = ""] = name.split("__");
    if (typeof input.url === "string" && /^https?:/.test(input.url)) return { tur: "browser", ad: hostOf(input.url), url: input.url, arac: tool };
    // the editor's own server (diagnostics, open files) stays on this computer
    const editor = /^(ide|claude-vscode|claude-jetbrains)$/.test(server);
    return { tur: "mcp", ad: `${server.replace(/^claude_ai_/, "").replaceAll("_", " ")}: ${tool}`, yazma: MCP_WRITE.test(tool), ...(editor ? { editor } : {}) };
  }
  return { tur: "tool", ad: name };
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(:|\/|$)/;
const FETCHES = /^(curl|wget|http|https|xh|open|lynx|w3m|links)\b/;
/**
 * The web addresses a command opens, except this computer's own: those given to curl, wget, open and the like. An
 * address in a script's text or a test isn't a visit.
 */
export function urlsIn(command) {
  return segments(command).filter((s) => FETCHES.test(s))
    .flatMap((s) => [...s.matchAll(/https?:\/\/[^\s'"`)<>]+/g)].map((m) => m[0].replace(/[.,;]+$/, "")))
    .filter((u) => !LOCAL_URL.test(u) && /^https?:\/\/[^/]*\./.test(u));
}

/** The command itself: the body of a heredoc is a script or a file's text, and its words aren't commands. */
export const withoutHeredocs = (command) => String(command ?? "").replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "");

// A path starts at a folder every system has at its root, at the home folder, or at a drive letter. Code in a command
// (`/**`, `/api/x`) doesn't.
const REAL_PATH = /^(\/(Users|home|private|tmp|var|etc|opt|usr|Volumes|mnt|srv|root|Library|System|Applications)\/|[A-Za-z]:[\\/])/;
/**
 * The words of a simple command as the shell reads them: quotes join and fall away (`~/a/"b c"/d` is one word), and
 * an unquoted `>` or `>>` is a word of its own.
 */
export function words(text) {
  const out = [];
  let word = "", quote = "", started = false;
  const end = () => {
    if (started) out.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) end();
    else if (ch === ">") {
      end();
      out.push(text[i + 1] === ">" ? (i++, ">>") : ">");
    } else {
      word += ch;
      started = true;
    }
  }
  end();
  return out;
}
/** Claude's own scratch files: temporary folders, not the user's files. */
const SCRATCH = /^(\/(tmp|private\/tmp|private\/var\/folders|var\/folders|dev)(\/|$))|[\\/]scratchpad([\\/]|$)/;
export const isScratch = (path) => SCRATCH.test(String(path));

const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
/**
 * The simple commands in a command line, split at unquoted `;`, `&&`, `||`, `|` and line ends, each without what only
 * runs it (`sudo`, `npx`, `VAR=x`, `git -C dir`). A word in quotes or in a heredoc is an argument, never a command.
 */
export function segments(command) {
  const text = withoutHeredocs(command), out = [];
  let current = "", quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (";|&\n".includes(ch)) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out
    .map((s) => s.trim().replace(/^[({]\s*/, "")
      .replace(/^(?:\w+=("[^"]*"|'[^']*'|\S*)\s+|(?:sudo|time|env|npx|bunx|exec|command|nohup|then|do|else)\s+)+/, "")
      .replace(/^git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+/, "git "))
    .filter(Boolean);
}

const DEPLOY = /^(git push|vercel|netlify (deploy|sites)|wrangler (deploy|publish|pages)|fly(ctl)? (deploy|launch)|eas (build|submit|update)|firebase deploy|(npm|bun|yarn|pnpm) publish|docker push|encore (deploy|secret set)|gh (pr|release|issue|repo) (create|merge|close|edit|comment|delete)|railway up|heroku)\b/;
const DATABASE = /^(psql|pg_dump|pg_restore|mysql|mongosh|redis-cli|sqlite3|supabase|prisma (migrate|db)|drizzle-kit (push|migrate)|wrangler d1|(npm|bun|yarn|pnpm) (run )?[\w:-]*migrat)/;
const GIT = /^git (commit|reset|checkout|switch|stash( (push|pop|drop|apply|save|clear)|$)|merge|rebase|cherry-pick|revert|clean|restore|branch -[dDmM]|tag\b)/;
const NETWORK = /^(ssh|scp|sftp|ftp|telnet|git (fetch|pull|clone)|gh api)\b/;
const WRITES = /^(rm|mv|cp|mkdir|touch|tee|ln|chmod|chown|rsync|unzip|tar|install|dd|sed (-\w+ )*-i)\b/;

/**
 * What a command reaches outside the project, or null when it stays inside. A heuristic: a script it runs can touch
 * more than its text says, so the page lists every command too.
 */
export function classify(command, root) {
  const parts = segments(command);
  const bare = parts.map((s) => s.replace(QUOTED, '""'));
  if (bare.some((s) => DEPLOY.test(s))) return "deploy";
  if (bare.some((s) => DATABASE.test(s)) || /(^|\s)\w*DATABASE_URL=/.test(withoutHeredocs(command))) return "db";
  if (bare.some((s) => GIT.test(s))) return "git";
  if (bare.some((s) => NETWORK.test(s)) || urlsIn(command).length) return "network";
  const outside = (word) => {
    const p = expandHome(word);
    return REAL_PATH.test(p) && !isScratch(p) && !isInside(resolve(p), root);
  };
  const writesOutside = parts.some((s, i) => {
    const w = words(s);
    return (WRITES.test(bare[i]) && w.some(outside)) || w.some((x, j) => (x === ">" || x === ">>") && outside(w[j + 1] ?? ""));
  });
  return writesOutside ? "outside" : null;
}

const display = (path, root) => {
  if (!path || !isAbsolute(path)) return path || "";
  const p = resolve(path);
  if (isInside(p, root)) return relative(root, p).split(sep).join("/") || basename(p);
  const home = homedir();
  return p === home || p.startsWith(home + sep) ? "~" + p.slice(home.length).split(sep).join("/") : p;
};

function patchCounts(result, input) {
  const hunks = result?.structuredPatch;
  if (Array.isArray(hunks) && hunks.length) {
    let added = 0, removed = 0;
    for (const h of hunks) for (const l of h.lines ?? []) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
    return { added, removed };
  }
  if (result?.type === "create" || (input.content != null && !result?.structuredPatch)) return { added: String(input.content ?? "").split("\n").length, removed: 0 };
  const lines = (s) => (s ? String(s).split("\n").length : 0);
  const edits = Array.isArray(input.edits) ? input.edits : [input];
  return edits.reduce((n, e) => ({ added: n.added + lines(e.new_string), removed: n.removed + lines(e.old_string) }), { added: 0, removed: 0 });
}

function emptyState() {
  return { offset: 0, size: 0, cwd: "", pending: new Map(), read: new Map(), changed: new Map(), web: new Map(), outside: [], log: [], commands: 0, agents: 0, tools: 0 };
}

const capped = (list, item) => {
  list.push(item);
  if (list.length > MAX_ITEMS) list.shift();
};

/** Each line of a transcript, as it is understood. `root` decides what counts as outside. */
function take(state, line, root, isAgent) {
  if (line.startsWith('{"type":"api-request-blob"')) return; // a copy of what was sent, the same calls again
  if (!state.cwd && line.includes('"cwd"')) {
    try {
      state.cwd = JSON.parse(line).cwd ?? "";
    } catch {
      // broken line
    }
  }
  const use = line.includes('"tool_use"'), result = line.includes('"tool_result"');
  const text = !isAgent && (line.includes('"type":"text"') || (line.includes('"type":"user"') && line.includes('"content":"')));
  if (!use && !result && !text) return;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const parts = Array.isArray(entry.message?.content) ? entry.message.content : [];
  const at = Date.parse(entry.timestamp) / 1000 || 0;
  if (text && !entry.isSidechain && !entry.isMeta) {
    const said = messageText(entry);
    if (said) addLog(state, { tur: "mesaj", kim: entry.type === "user" ? "sen" : "claude", metin: said, zaman: at });
  }
  if (entry.type === "assistant") {
    for (const p of parts) {
      if (p?.type !== "tool_use") continue;
      const step = { id: p.id, zaman: at, ...describe(p.name ?? "", p.input ?? {}), hata: null, ...(isAgent ? { ajan: true } : {}) };
      if (step.tur === "bash") step.komut = String(p.input?.command ?? "");
      state.tools++;
      state.pending.set(p.id, { name: p.name, input: p.input ?? {}, step });
      addLog(state, step);
    }
    return;
  }
  if (entry.type !== "user") return;
  for (const p of parts) {
    if (p?.type !== "tool_result") continue;
    const call = state.pending.get(p.tool_use_id);
    if (!call) continue;
    state.pending.delete(p.tool_use_id);
    const failed = p.is_error === true;
    call.step.hata = failed;
    record(state, call, entry.toolUseResult, failed, root, at);
  }
}

const addLog = (state, item) => {
  state.log.push(item);
  if (state.log.length > LOG) state.log.shift();
};

/**
 * What a person said or Claude wrote, as text: not the notes Claude Code adds around a request (`<system-reminder>`,
 * a slash command's output), and not a tool's result.
 */
export function messageText(entry) {
  const content = entry.message?.content;
  const pieces = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text ?? "") : [];
  const images = Array.isArray(content) ? content.filter((p) => p?.type === "image").length : 0;
  let text = pieces.join("\n")
    .replace(/<(system-reminder|ide_selection|ide_opened_file|local-command-stdout|local-command-caveat)[\s\S]*?<\/\1>/g, "")
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, "$1")
    .trim();
  if (/^<command-(name|message)>/.test(text)) text = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1] ?? "";
  if (/^\[Request interrupted/.test(text) || /^Caveat:/.test(text)) return "";
  if (images) text = `${text}${text ? "\n" : ""}${"🖼 ".repeat(Math.min(images, 5)).trim()}`;
  return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text;
}

function record(state, { name, input, step }, result, failed, root, at) {
  const { tur } = step;
  if (tur === "read" && !failed && step.yol) {
    const r = state.read.get(step.yol) ?? { yol: step.yol, kez: 0 };
    r.kez++;
    r.zaman = at;
    state.read.set(step.yol, r);
  } else if ((tur === "grep" || tur === "glob") && !failed && step.yol) {
    step.yol = resolve(state.cwd || root, step.yol); // a search path can be relative to where the session started
    if (isInside(step.yol, root) || isScratch(step.yol)) return;
    const key = step.yol + "/";
    const r = state.read.get(key) ?? { yol: step.yol, kez: 0, arama: true };
    r.kez++;
    r.zaman = at;
    state.read.set(key, r);
  } else if ((tur === "edit" || tur === "write") && !failed && step.yol) {
    const { added, removed } = patchCounts(result, input);
    Object.assign(step, { eklenen: added, silinen: removed, ...(result?.type === "create" ? { yeni: true } : {}) });
    const c = state.changed.get(step.yol) ?? { yol: step.yol, kez: 0, eklenen: 0, silinen: 0 };
    c.kez++;
    c.eklenen += added;
    c.silinen += removed;
    c.zaman = at;
    if (result?.type === "create" && c.kez === 1) c.yeni = true;
    state.changed.set(step.yol, c); // a file outside the project is marked in the list of changed files
  } else if (tur === "fetch" || tur === "search" || tur === "browser") {
    const key = `${tur} ${step.url ?? step.ad}`;
    const w = state.web.get(key) ?? { tur, ad: step.url ?? step.ad, kez: 0 };
    w.kez++;
    w.zaman = at;
    if (failed) w.hata = true;
    state.web.set(key, w);
  } else if (tur === "bash") {
    state.commands++;
    const command = String(input.command ?? "");
    const kind = classify(command, root);
    if (kind) step.dis = kind;
    const urls = urlsIn(command);
    for (const url of urls) {
      const key = `curl ${url}`;
      const w = state.web.get(key) ?? { tur: "curl", ad: url, kez: 0 };
      w.kez++;
      w.zaman = at;
      state.web.set(key, w);
    }
    if (kind && !(kind === "network" && urls.length)) capped(state.outside, { id: step.id, tur: kind, ad: shortCommand(command), ...(step.aciklama ? { aciklama: step.aciklama } : {}), zaman: at, hata: failed });
  } else if (tur === "mcp" && !step.editor) {
    capped(state.outside, { id: step.id, tur: step.yazma ? "mcp-write" : "mcp", ad: step.ad, zaman: at, hata: failed });
  } else if (tur === "agent") {
    state.agents++;
  } else if (name === "Artifact" || /publish/i.test(name)) {
    capped(state.outside, { id: step.id, tur: "publish", ad: String(input.url ?? input.file_path ?? name), zaman: at, hata: failed });
  }
}

/**
 * Calls `onLine` with each whole line of `file` from byte `from` on, and returns where the unread part starts: a
 * half-written last line waits for the next call. With `needle`, only the lines that contain it are decoded.
 */
function eachLine(file, from, onLine, needle) {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  const find = needle ? Buffer.from(needle) : null;
  let pos = from, carry = Buffer.alloc(0);
  try {
    while (pos < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = readSync(fd, buffer, 0, buffer.length, pos);
      if (!n) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, n)]) : buffer.subarray(0, n);
      let start = 0, nl;
      while (true) {
        if (find) {
          const hit = data.indexOf(find, start);
          if (hit === -1) {
            start = Math.max(start, data.lastIndexOf(10) + 1);
            break;
          }
          start = data.lastIndexOf(10, hit) + 1 || start;
        }
        if ((nl = data.indexOf(10, start)) === -1) break;
        if (onLine(data.toString("utf8", start, nl).replace(/\r$/, "")) === false) return pos;
        start = nl + 1;
      }
      carry = data.subarray(start);
    }
  } finally {
    closeSync(fd);
  }
  return pos - carry.length;
}

/** The first bytes of a file: a transcript only grows, so different ones mean it was written anew. */
function headOf(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(256);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, 256, 0));
  } finally {
    closeSync(fd);
  }
}

/** Reads what was added to `file` since the last call. */
function catchUp(state, file, root, isAgent) {
  const size = statSync(file).size;
  if (size === state.size) return;
  const head = headOf(file);
  if (size < state.offset || (state.head && head !== state.head)) Object.assign(state, emptyState(), { root }); // rewritten: start again
  state.head = head;
  state.offset = eachLine(file, state.offset, (line) => take(state, line, root, isAgent));
  state.size = size;
}

const cache = new Map();
function stateOf(file, root, isAgent) {
  let state = cache.get(file);
  if (!state || state.root !== root) state = Object.assign(emptyState(), { root });
  cache.delete(file);
  cache.set(file, state); // the most recent at the end
  while (cache.size > KEEP_FILES) cache.delete(cache.keys().next().value);
  catchUp(state, file, root, isAgent);
  return state;
}

/** The first folder named in the transcript, read from its start only. */
function startFolder(file) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(statSync(file).size, 200_000));
    readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        return JSON.parse(line).cwd ?? "";
      } catch {
        // truncated line
      }
    }
  } finally {
    closeSync(fd);
  }
  return "";
}

/** The transcript of session `id` in any of the Claude folders, or "". */
export function findTranscript(folders, id) {
  if (!/^[\w-]+$/.test(String(id))) return "";
  for (const { path: root } of folders) {
    const base = join(root, "projects");
    if (!existsSync(base)) continue;
    for (const project of readdirSync(base, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const file = join(base, project.name, `${id}.jsonl`);
      if (existsSync(file)) return file;
    }
  }
  return "";
}

/** The transcripts of a session's subagents, next to its own. */
function agentFiles(file) {
  const folder = join(dirname(file), basename(file, ".jsonl"), "subagents");
  return existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith(".jsonl")).map((n) => join(folder, n)) : [];
}

/** Everything the session at `file` did, its subagents included. */
export function activity(file, limit = SHOWN) {
  const cwd = startFolder(file);
  const root = repoRoot(cwd);
  const states = [stateOf(file, root, false), ...agentFiles(file).map((f) => stateOf(f, root, true))];

  const merge = (key, combine) => {
    const out = new Map();
    for (const s of states) for (const [k, v] of s[key]) out.set(k, out.has(k) ? combine(out.get(k), v) : { ...v });
    return [...out.values()].sort((a, b) => b.zaman - a.zaman).slice(0, MAX_ITEMS);
  };
  const sum = (a, b) => ({ ...a, kez: a.kez + b.kez, zaman: Math.max(a.zaman, b.zaman) });
  // where a file is: in the project, Claude's scratch folder, or elsewhere on the computer
  const where = (f) => ({ ...f, yol: display(f.yol, root), ...(isInside(resolve(f.yol), root) ? {} : isScratch(f.yol) ? { gecici: true } : { disarida: true }) });
  const changed = merge("changed", (a, b) => ({ ...sum(a, b), eklenen: a.eklenen + b.eklenen, silinen: a.silinen + b.silinen, yeni: a.yeni || b.yeni })).map(where);
  const read = merge("read", sum).map(where);
  // the session's own entries and its subagents' calls, in time order; a sort keeps the order of equal times
  const log = states.flatMap((s) => s.log).sort((a, b) => a.zaman - b.zaman);
  const shown = log.slice(-Math.max(1, limit)).map((e) => {
    if (!e.yol) return e;
    const abs = isAbsolute(e.yol) ? resolve(e.yol) : resolve(cwd || root, e.yol);
    return { ...e, yol: display(abs, root), ...(isInside(abs, root) ? {} : isScratch(abs) ? { gecici: true } : { disarida: true }) };
  });
  const live = Date.now() / 1000 - statSync(file).mtimeMs / 1000 < LIVE_S;
  const pending = states[0].pending.size ? [...states[0].pending.values()].at(-1).step : null;
  return {
    klasor: display(root, ""),
    canli: live,
    simdi: live && pending ? { ...pending, yol: pending.yol ? display(pending.yol, root) : undefined } : null,
    degisen: changed,
    okunan: read,
    web: merge("web", (a, b) => ({ ...sum(a, b), hata: a.hata || b.hata })),
    disarida: states.flatMap((s) => s.outside).sort((a, b) => b.zaman - a.zaman).slice(0, MAX_ITEMS),
    kayit: shown,
    kayitToplam: log.length,
    sayilar: { komut: states.reduce((n, s) => n + s.commands, 0), ajan: states[0].agents, arac: states.reduce((n, s) => n + s.tools, 0) },
  };
}

/** The call a session is busy with, from the end of its transcript: unanswered tool calls are still running. */
export function currentStep(tail) {
  const answered = new Set();
  for (let i = tail.length - 1; i >= 0; i--) {
    const s = tail[i];
    const parts = Array.isArray(s.message?.content) ? s.message.content : [];
    if (s.type === "user") for (const p of parts) if (p?.type === "tool_result") answered.add(p.tool_use_id);
    if (s.type !== "assistant" || s.isSidechain) continue;
    const uses = parts.filter((p) => p?.type === "tool_use");
    if (!uses.length) return null; // it is writing its answer
    const open = uses.filter((p) => !answered.has(p.id));
    if (!open.length) return null; // it has the results and is thinking
    const { tur, ad, aciklama } = describe(open.at(-1).name ?? "", open.at(-1).input ?? {});
    return { tur, ad: String(ad).slice(0, 80), ...(aciklama ? { aciklama: aciklama.slice(0, 80) } : {}) };
  }
  return null;
}

const MAX_TEXT = 20_000;
const MAX_PATCH_LINES = 600;
const cut = (text, max = MAX_TEXT) => (text.length > max ? { metin: text.slice(0, max), kesildi: text.length - max } : { metin: text });
/** Long strings in a tool's input, shortened: a written file can be megabytes. */
const shorten = (value) => {
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n… (+${value.length - MAX_TEXT})` : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  return value;
};
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGES = 6;
/** The pictures in a result, as they were sent to Claude: the transcript keeps them, so they show after the file is gone. */
const imagesOf = (content) => (Array.isArray(content) ? content : [])
  .filter((p) => p?.type === "image" && p.source?.type === "base64" && IMAGE_TYPES.test(p.source.media_type ?? "") && typeof p.source.data === "string")
  .slice(0, MAX_IMAGES)
  .map((p) => `data:${p.source.media_type};base64,${p.source.data}`);
const resultText = (content) =>
  typeof content === "string" ? content
    : Array.isArray(content) ? content.map((p) => (p?.type === "text" ? p.text : p?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n") : "";

/**
 * One tool call in full, for the window that opens on a step: what was asked and what came back. Found by its id in
 * the session's transcript or a subagent's; only the lines that name the id are decoded.
 */
export function stepDetail(file, id) {
  if (!/^[\w-]+$/.test(String(id ?? ""))) return null;
  for (const f of [file, ...agentFiles(file)]) {
    let use = null, result = null;
    eachLine(f, 0, (line) => {
      if (line.startsWith('{"type":"api-request-blob"')) return;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      for (const p of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (entry.type === "assistant" && p?.type === "tool_use" && p.id === id) use = { name: p.name ?? "", input: p.input ?? {}, at: Date.parse(entry.timestamp) / 1000 || 0 };
        if (entry.type === "user" && p?.type === "tool_result" && p.tool_use_id === id) result = { error: p.is_error === true, text: resultText(p.content), images: imagesOf(p.content), extra: entry.toolUseResult };
      }
      if (use && result) return false;
    }, `"${id}"`);
    if (!use) continue;
    const patch = result?.extra?.structuredPatch;
    const cwd = startFolder(file);
    return {
      kok: repoRoot(cwd),
      dosya: display(f, ""),
      ev: homedir(),
      ...(use.name === "Bash" ? { parcalar: commandParts(use.input.command).slice(0, 60) } : {}),
      arac: use.name,
      ...describe(use.name, use.input),
      zaman: use.at,
      ajan: f !== file,
      girdi: shorten(use.input),
      durum: !result ? "running" : result.error ? "error" : "ok",
      sonuc: result ? cut(result.text) : null,
      ...(result?.images.length ? { gorseller: result.images } : {}),
      ...(Array.isArray(patch) && patch.length ? { yama: patch.flatMap((h) => [...(h.oldStart != null ? [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`] : []), ...(h.lines ?? [])]).slice(0, MAX_PATCH_LINES) } : {}),
    };
  }
  return null;
}

/**
 * A command line in the pieces a person reads it in: each simple command with its program, a `NAME=value` it keeps,
 * where it writes with `>`, and the script a heredoc feeds it. Nothing is dropped, so the pieces add up to the command.
 */
export function commandParts(command) {
  const scripts = [];
  const text = String(command ?? "").replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2\s*(?=\n|$)/g, (_, q, tag, rest, body) => {
    scripts.push(body);
    return `<<${tag}#${scripts.length - 1}${rest}`;
  });
  const parts = [];
  let current = "", quote = "", joiner = "";
  const push = (next) => {
    if (current.trim()) parts.push({ raw: current.trim(), joiner });
    current = "";
    joiner = next;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], two = text.slice(i, i + 2);
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (two === "&&" || two === "||") {
      push(two);
      i++;
    } else if (ch === "|") push("|");
    else if (ch === ";" || ch === "\n") push(";");
    else if (ch === "&" && text[i - 1] !== ">" && text[i + 1] !== ">") push("&");
    else current += ch;
  }
  push("");
  return parts.map(({ raw, joiner }) => {
    const script = raw.match(/<<\w+#(\d+)/);
    const shown = script ? raw.replace(/#\d+/, "") : raw;
    const assign = shown.match(/^(\w+)=("[^"]*"|'[^']*'|\S*)$/);
    const w = words(shown.replace(/<<-?\s*\w+/, ""));
    let i = 0;
    while (i < w.length && (/^\w+=/.test(w[i]) || /^(sudo|time|env|nohup|exec|command|then|do|else|until|while|if|!)$/.test(w[i]))) i++;
    const program = (w[i] ?? "").replace(/^.*\//, "");
    // `2>&1` sends errors along with the output: not a file
    const target = w.findIndex((x, j) => (x === ">" || x === ">>") && w[j + 1] && !w[j + 1].startsWith("&"));
    return {
      metin: shown,
      ...(joiner ? { sonra: joiner } : {}),
      ...(assign ? { atama: { ad: assign[1], deger: assign[2].replace(/^["']|["']$/g, "") } } : { program, argumanlar: w.slice(i + 1).filter((x) => x !== ">" && x !== ">>") }),
      ...(target !== -1 && w[target + 1] ? { yazar: w[target + 1] } : {}),
      ...(script ? { betik: scripts[+script[1]] } : {}),
    };
  });
}
