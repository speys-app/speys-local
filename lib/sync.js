// Two-way sync of an applet's data, without knowing the applet's code.
//
// An applet declares what to sync in applet.json ("sync"); this module only sees records. So an applet copied to
// applets/custom/ and changed keeps syncing as long as its records keep a few rules:
//   - `id` is the same on both sides; `updatedAt` changes on edit; a deleted record keeps `deletedAt` (or leaves the file).
//   - A field missing from a record means "I don't know this field", not "delete it": the last synced value is kept.
//     To clear a field, write null.
// Merging is three-way and per field against the last synced copy (the base), like git: a field changed on one side
// wins, the same field changed differently on both sides is a conflict and is asked, never silently dropped.
// No network and no files here: the caller loads the records, sends `push` and stores `base`.
import { createHash } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";

export const SYNC_VERSION = 1;

/** Fields that describe the copy, not the record: never compared, never a conflict. */
const META = new Set(["updatedAt", "version", "createdAt"]);

/** JSON with sorted keys, so two equal objects give the same text. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const same = (a, b) => canonical(a) === canonical(b);

const content = (record) => Object.fromEntries(Object.entries(record ?? {}).filter(([k]) => !META.has(k)));
const pick = (record, keys) => Object.fromEntries(Object.entries(record ?? {}).filter(([k]) => keys.has(k)));
const omit = (record, keys) => record && Object.fromEntries(Object.entries(record).filter(([k]) => !keys.has(k)));
const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * The same id on both sides for a record both can create on their own (a repeat of a rule on a date).
 * The first 16 bytes of sha256("speys-sync" + "\x1f" + parts joined by "\x1f"), shaped as a UUID (version 8:
 * custom). Speys computes the same in SQL (`kasa.stable_id`); Postgres text can't hold \0, hence \x1f.
 */
export function stableId(...parts) {
  const h = createHash("sha256").update(["speys-sync", ...parts].map(String).join("\x1f")).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** applet.json "sync", checked and in its long form. Null when the applet doesn't sync. */
export function readSpec(sync) {
  if (sync == null) return null;
  if (typeof sync !== "object") throw new Error("sync must be an object");
  const version = sync.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error("sync.version must be a positive integer");
  if (version > SYNC_VERSION) throw new Error(`sync.version ${version} is newer than this Speys Local supports`);
  const file = sync.file;
  if (typeof file !== "string" || !file || isAbsolute(file) || normalize(file).split(sep).includes("..")) {
    throw new Error("sync.file must be a path inside the applet's data folder");
  }
  const collections = {};
  for (const [key, value] of Object.entries(sync.collections ?? {})) {
    const c = typeof value === "string" ? { remote: value } : value;
    if (!c || typeof c.remote !== "string" || !c.remote) throw new Error(`sync.collections.${key} needs a remote name`);
    const map = { ...(c.map ?? {}) };
    for (const [from, to] of Object.entries(map)) {
      if (typeof to !== "string" || !to || from === "id" || to === "id") throw new Error(`sync.collections.${key}.map: invalid field ${from}`);
    }
    const own = c.own ?? [];
    if (!Array.isArray(own) || own.some((f) => typeof f !== "string" || f === "id")) throw new Error(`sync.collections.${key}.own must list field names`);
    collections[key] = { remote: c.remote, map, own, tombstones: c.tombstones !== false };
  }
  if (!Object.keys(collections).length) throw new Error("sync.collections is empty");
  return { version, file, collections };
}

/** Local field names → Speys names. Fields not in the map keep their name. */
export function toRemote(record, map = {}) {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [map[k] ?? k, v]));
}

/** Speys field names → local names. */
export function toLocal(record, map = {}) {
  const back = Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [back[k] ?? k, v]));
}

/**
 * One record, three copies. `base` may be {} (both sides created it with the same id).
 * Returns the merged record and the fields that changed differently on both sides.
 */
export function merge3(base, local, remote) {
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)].filter((k) => !META.has(k)));
  const merged = {};
  const conflicts = [];
  for (const k of keys) {
    const b = base[k];
    const l = k in local ? local[k] : b; // missing locally: the applet doesn't know the field
    const r = remote[k];
    let v;
    if (same(l, r)) v = l;
    else if (same(l, b)) v = r;
    else if (same(r, b)) v = l;
    else {
      conflicts.push({ field: k, base: b ?? null, local: l ?? null, remote: r ?? null });
      v = l;
    }
    if (v !== undefined) merged[k] = v;
  }
  // Deleted on one side, edited on the other: asked, so an edit isn't lost under a deletion.
  if (!base.deletedAt && !conflicts.some((c) => c.field === "deletedAt")) {
    const edited = (side) => Object.keys(content({ ...base, ...side })).some((k) => k !== "deletedAt" && k in side && !same(side[k], base[k]));
    const ld = Boolean(local.deletedAt), rd = Boolean(remote.deletedAt);
    if ((ld && !rd && edited(remote)) || (rd && !ld && edited(local))) {
      conflicts.push({ field: "deletedAt", base: null, local: local.deletedAt ?? null, remote: remote.deletedAt ?? null });
    }
  }
  const updatedAt = later(local.updatedAt, remote.updatedAt);
  if (updatedAt) merged.updatedAt = updatedAt;
  return { merged, conflicts };
}

/**
 * One collection.
 *   local:  the records now in the file (local names already turned into Speys names)
 *   base:   { id: record } as last synced
 *   remote: the records Speys changed since the last sync (deleted ones with deletedAt)
 *   own:    fields that belong to this copy only (e.g. how far repeats were written): kept in the file, never sent,
 *           never taken from Speys
 *   open:   conflicts from earlier runs the user hasn't answered; they stay open (and keep their record out of `push`)
 *           until the file and Speys agree, so an unanswered conflict never overwrites either side
 * Returns the records to write to the file, the ones to send, the open conflicts, and the new base.
 * A sent record carries the `version` of the Speys copy it was merged with; Speys refuses it if its copy moved on.
 * A sent record's base changes only when Speys accepts it (`accept`), so a failed send is retried next time.
 */
export function plan({ local = [], base = {}, remote = [], open = [], own = [], now = new Date(), tombstones = true }) {
  const stamp = now.toISOString();
  const mine = new Set(own);
  const inFile = new Map(local.filter((r) => r?.id).map((r) => [r.id, r]));
  const fromSpeys = new Map(remote.filter((r) => r?.id).map((r) => [r.id, omit(r, mine)]));
  // The file keeps its own fields and its createdAt; Speys's version number stays out of it.
  const toFile = (record, before) => {
    const kept = { ...pick(before, mine), ...(before?.createdAt ? { createdAt: before.createdAt } : {}) };
    const { version, ...rest } = record;
    return { ...rest, ...kept };
  };
  const waiting = new Map(open.filter((c) => c?.id).map((c) => [c.id, c]));
  const order = [...inFile.keys(), ...Object.keys(base), ...fromSpeys.keys(), ...waiting.keys()];
  const out = { local: [], base: { ...base }, push: [], conflicts: [] };
  const seen = new Set();

  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const asked = waiting.get(id);
    const b = asked ? asked.base ?? undefined : base[id];
    const r = fromSpeys.get(id) ?? asked?.remote ?? base[id];
    const before = inFile.get(id);
    let l = omit(before, mine);
    if (!l && b) l = b.deletedAt ? b : { ...b, deletedAt: stamp, updatedAt: stamp }; // left the file: deleted
    if (!l && asked) l = asked.local;

    let record;
    if (!r) {
      record = l; // created here
      out.push.push(l);
    } else if (!l) {
      record = r; // created on Speys
      out.base[id] = r;
    } else {
      const { merged, conflicts } = merge3(b ?? {}, l, r);
      if (conflicts.length) {
        out.conflicts.push({ id, fields: conflicts, local: l, remote: r, base: b ?? null });
        record = l; // the file stays as the user left it until they choose
      } else {
        record = merged;
        if (same(content(merged), content(r))) out.base[id] = r;
        else out.push.push(r.version == null ? merged : { ...merged, version: r.version });
      }
    }
    // A deleted record isn't written back to a file it already left, nor to an applet that doesn't keep deletions.
    if (!(record.deletedAt && (!tombstones || !inFile.has(id)))) out.local.push(toFile(record, before));
  }
  return out;
}

/** Speys accepted these records (as it stored them, with its version): they become the base. */
export function accept(base, accepted) {
  const next = { ...base };
  for (const r of accepted) if (r?.id) next[r.id] = r;
  return next;
}

/**
 * The user's answer to a conflict: { field: "local" | "remote" }; a field not chosen keeps the local value.
 * Changes that weren't in conflict are kept from both sides. Returns the record to write to the file;
 * the caller drops the conflict from `open` and sets `base[id] = conflict.remote`, so the next `plan` sends it.
 */
export function resolve(conflict, picks = {}, now = new Date()) {
  const { merged } = merge3(conflict.base ?? {}, conflict.local, conflict.remote);
  for (const { field, local, remote } of conflict.fields) {
    const value = picks[field] === "remote" ? remote : local;
    if (value !== null) merged[field] = value;
    else if (field === "deletedAt") delete merged.deletedAt;
    else merged[field] = null;
  }
  merged.updatedAt = now.toISOString();
  return merged;
}

const words = (text) => new Set(String(text ?? "").toLocaleLowerCase("tr").normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

function likeness(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

const dayNumber = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / 86400000;

/**
 * Records that look like the same thing entered twice (once here, once on Speys; or twice by hand).
 * Never merges: returns pairs for the user to confirm.
 *   same:  fields that must be equal (e.g. ["direction", "amount"])
 *   date:  the date field; pairs at most `days` apart
 *   text:  fields compared by words; the best one must reach `min` (0..1). Two empty texts don't count as alike.
 *   dismissed: "idA|idB" pairs the user said aren't copies
 */
export function duplicates(records, { same: equal = [], date, days = 3, text = [], min = 0.5, dismissed = [] } = {}) {
  const skip = new Set(dismissed);
  const alive = records.filter((r) => r?.id && !r.deletedAt && (!date || r[date]));
  if (date) alive.sort((a, b) => (a[date] < b[date] ? -1 : a[date] > b[date] ? 1 : 0));
  const pairs = [];
  for (let i = 0; i < alive.length; i += 1) {
    const a = alive[i];
    for (let j = i + 1; j < alive.length; j += 1) {
      const b = alive[j];
      if (date && dayNumber(b[date]) - dayNumber(a[date]) > days) break;
      if (!equal.every((k) => same(a[k], b[k]))) continue;
      const score = text.length ? Math.max(...text.map((k) => likeness(a[k], b[k]))) : 1;
      if (score < min) continue;
      const key = [a.id, b.id].sort().join("|");
      if (!skip.has(key)) pairs.push({ a, b, score: Math.round(score * 100) / 100, key });
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}
