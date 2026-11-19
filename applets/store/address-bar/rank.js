// What Chrome's address bar would suggest from its learned shortcuts, and what queued changes do to that.
// No Node imports: the page loads this file too (./rank.js), so the preview and the backend agree.

/** Chrome's scoring constants (components/omnibox/browser/shortcuts_provider.cc). */
const MAX_RELEVANCE = 1199;
const HALF_LIFE_MS = 7 * 86400_000;
const MAX_DECAY_DIVISOR = 5;
const USES_PER_DIVISOR_STEP = 5;
/** History: the first address the history provider completes outranks every shortcut (Chrome gives it about 1410);
    its other matches fall below a fresh shortcut. */
const HISTORY_FIRST = 1410;
const HISTORY_OTHER = 1000;
/** An address never typed still qualifies when visited this often lately (HistoryURLProvider's low-quality limits). */
const RECENT_VISITS = 4;
const RECENT_MS = 3 * 86400_000;
/** Hits a "put" gives: from 21 on, Chrome's decay is already at its slowest. */
export const PUT_HITS = 25;

const lower = (s) => String(s ?? "").toLocaleLowerCase();

/** The address without scheme and "www.", the way the address bar shows it. */
export const bare = (url) => String(url ?? "").replace(/^[a-z][\w+.-]*:\/\//i, "").replace(/^www\./i, "");

export const isSearch = (row) => !!row.keyword;

/** Chrome's estimate: how much of the learned text is typed, faded by time since last use; many uses fade slower. */
export function score(input, row, now = Date.now()) {
  const typed = Math.min(1, input.length / Math.max(1, row.text.length));
  const divisor = Math.min(MAX_DECAY_DIVISOR, (row.hits + USES_PER_DIVISOR_STEP - 1) / USES_PER_DIVISOR_STEP);
  const passed = Math.max(0, now - row.last);
  return Math.round(MAX_RELEVANCE * Math.sqrt(typed) / Math.exp((Math.LN2 * passed) / (HALF_LIFE_MS * divisor)));
}

/** Suggestions for what is typed, best first, one per address: learned shortcuts whose text starts with it, and
    addresses from history that start with it. `inline` marks the first one when Chrome completes it in place.
    `history` holds the history rows (readHistory) and may be left out. */
export function suggest(rows, input, now = Date.now(), history = []) {
  const typed = lower(input.trim());
  if (!typed) return [];
  const best = new Map();
  for (const row of rows) {
    if (!lower(row.text).startsWith(typed)) continue;
    const s = score(typed, row, now);
    const seen = best.get(row.url);
    if (!seen) best.set(row.url, { url: row.url, row, score: s, rows: [row], history: null });
    else {
      seen.rows.push(row);
      if (s > seen.score) Object.assign(seen, { row, score: s });
    }
  }
  historyMatches(history, typed, now).forEach((h, i) => {
    const s = i === 0 ? HISTORY_FIRST : HISTORY_OTHER - i;
    let seen = best.get(h.url);
    if (!seen) best.set(h.url, (seen = { url: h.url, row: historyRow(h), score: s, rows: [], history: h }));
    seen.history = h;
    if (i === 0) seen.fromHistory = true;
    if (s > seen.score) seen.score = s;
  });
  const list = [...best.values()].sort((a, b) => b.score - a.score || b.row.hits - a.row.hits);
  if (list[0]) list[0].inline = !!list[0].fromHistory || lower(bare(list[0].row.fill)).startsWith(typed) || lower(list[0].row.fill).startsWith(typed);
  return list;
}

const matchesAddress = (url, typed) => lower(bare(url)).startsWith(typed) || lower(url).startsWith(typed);
export const rootOf = (url) => { try { return `${new URL(url).origin}/`; } catch { return url; } };

/** History addresses Chrome would complete for what is typed, before the root rule: typed ones first, most typed first. */
export function historyCandidates(history, input, now = Date.now()) {
  const typed = lower(input.trim());
  if (!typed) return [];
  return history
    .filter((h) => (h.typed > 0 || (h.visits >= RECENT_VISITS && h.last > now - RECENT_MS)) && matchesAddress(h.url, typed))
    .sort((a, b) => (b.typed > 0) - (a.typed > 0) || b.typed - a.typed || b.last - a.last);
}

/** historyCandidates in Chrome's order: when the best one's site root is a candidate too, the shorter root goes first. */
export function historyMatches(history, input, now = Date.now()) {
  const list = historyCandidates(history, input, now);
  if (!list.length) return list;
  const root = rootOf(list[0].url);
  const at = list.findIndex((h) => h.url === root);
  if (at > 0) list.unshift(...list.splice(at, 1));
  return list;
}

const historyRow = (h) => ({ id: "", text: "", fill: h.url, url: h.url, contents: bare(h.url), description: h.title || "", type: 1, keyword: "", hits: 0, last: h.last });

/** History rows with the queued "typed" changes. */
export function applyHistory(history, ops) {
  const typed = new Map(ops.filter((o) => o.op === "typed").map((o) => [o.url, o.count]));
  return typed.size ? history.map((h) => (typed.has(h.url) ? { ...h, typed: typed.get(h.url) } : h)) : history;
}

/** Rows as they will be once the queued changes are applied. A restore can't be previewed, so it leaves rows as they are. */
export function applyOps(rows, ops, now = Date.now()) {
  let out = rows.slice();
  ops.forEach((op, i) => {
    if (op.op === "delete") out = out.filter((r) => r.id !== op.id);
    if (op.op === "put") {
      const at = out.findIndex((r) => r.url === op.url && lower(r.text) === lower(op.text));
      if (at >= 0) out[at] = { ...out[at], hits: Math.max(out[at].hits, PUT_HITS), last: now };
      else out.push(newRow(op, `new-${i}`, now));
    }
  });
  return out;
}

/** The changes that make `url` the first suggestion for `text`, given the rows and history with `pending` applied.
    Shortcuts: two rows for exactly this text both score the maximum and one picked minutes ago hardly fades, so the
    other addresses lose their row for this text (they keep the rows learned from other texts).
    History outranks shortcuts: the address gets typed once more than any other match, and the site root, which
    Chrome would put before it, stops counting as typed. An address history doesn't know can't be raised there, so the
    typed matches stop counting as typed instead. */
export function putFirst(rows, history, pending, text, url, title = "", now = Date.now()) {
  const typed = lower(text.trim());
  const removing = new Set(pending.filter((o) => o.op === "delete").map((o) => o.id));
  const rivals = rows.filter((r) => r.url !== url && lower(r.text) === typed && !removing.has(r.id));
  const ops = [{ op: "put", text: text.trim(), url, title }, ...rivals.map((r) => ({ op: "delete", id: r.id }))];
  const candidates = historyCandidates(history, typed, now);
  const target = history.find((h) => h.url === url);
  if (target) {
    const top = Math.max(0, ...candidates.filter((h) => h.url !== url).map((h) => h.typed));
    if (target.typed <= top) ops.push({ op: "typed", url, count: top + 1 });
    const root = candidates.find((h) => h.url === rootOf(url));
    if (root && root.url !== url && root.typed > 0) ops.push({ op: "typed", url: root.url, count: 0 });
  } else {
    for (const h of candidates) if (h.typed > 0) ops.push({ op: "typed", url: h.url, count: 0 });
  }
  return ops;
}

/** The changes that take a suggestion away: its shortcut rows, and its history address stops counting as typed. */
export function removeSuggestion(group) {
  const ops = group.rows.filter((r) => !r.id.startsWith("new-")).map((r) => ({ op: "delete", id: r.id }));
  if (group.history?.typed > 0) ops.push({ op: "typed", url: group.url, count: 0 });
  return ops;
}

/** The row a "put" adds: a typed address, as if it was picked PUT_HITS times just now. */
export function newRow(op, id, now = Date.now()) {
  return { id, text: op.text, fill: op.url, url: op.url, contents: bare(op.url), description: op.title || "", type: 1, keyword: "", hits: PUT_HITS, last: now };
}
