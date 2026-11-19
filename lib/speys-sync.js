// One sync of an applet's data with Speys: pull what changed there, merge it into the file (lib/sync.js), send what
// changed here. Generic: what to sync comes from applet.json "sync", the network from lib/speys.js.
//
// Speys's endpoints for a collection whose remote is "<service>.<kind>": POST /local/<service>/sync/pull and /push.
// The state (last version seen, the last synced copy of each record, open conflicts) is kept by the caller in a data
// file; losing it is safe: the next sync starts from zero and merging the same records again changes nothing.
import { accept, plan, toLocal, toRemote } from "./sync.js";

/** Speys numbers changes in order, but two writes can finish out of order: ask from a little before the cursor. */
const OVERLAP = 50;
const PUSH_CHUNK = 500;
const ROUNDS = 3;

export const emptySyncState = () => ({ cursor: 0, base: {}, open: {}, failed: [], dismissed: [] });

/**
 * spec:  readSpec(applet.json "sync")
 * call:  (path, body) => Promise<json>, from lib/speys.js
 * scope: what Speys needs to know besides the records, e.g. { businessId }
 * state: from emptySyncState(); changed in place
 * load(): the data file as an object; save(data) writes it. Called back to back, with no waiting in between, so an
 *         edit made by the page while Speys answers isn't lost.
 */
export async function runSync({ spec, call, scope = {}, state, load, save, now = () => new Date() }) {
  const keys = Object.keys(spec.collections);
  const service = (key) => spec.collections[key].remote.split(".")[0];
  const kind = (key) => spec.collections[key].remote.split(".").slice(1).join(".");
  for (const key of keys) {
    state.base[key] ??= {};
    state.open[key] ??= [];
  }
  const report = { pulled: 0, pushed: 0, failed: [] };
  let fresh = Object.fromEntries(keys.map((k) => [k, []])); // Speys's current copy, handed back with a "stale" refusal

  for (let round = 0; round < ROUNDS; round += 1) {
    // 1. What changed on Speys
    const remote = Object.fromEntries(keys.map((k) => [k, [...fresh[k]]]));
    fresh = Object.fromEntries(keys.map((k) => [k, []]));
    let cursor = state.cursor;
    for (const svc of new Set(keys.map(service))) {
      let since = Math.max(0, state.cursor - OVERLAP);
      for (let page = 0; page < 200; page += 1) {
        const res = await call(`/local/${svc}/sync/pull`, { ...scope, since, limit: 1000 });
        for (const change of res.changes ?? []) {
          const key = keys.find((k) => service(k) === svc && kind(k) === change.kind);
          if (key) remote[key].push(toLocal(change.record, spec.collections[key].map));
        }
        report.pulled += res.changes?.length ?? 0;
        cursor = Math.max(cursor, Number(res.version) || 0);
        if (!res.more) break;
        since = Number(res.version) || since;
      }
    }

    // 2. Merge into the file
    const data = load();
    const outgoing = {};
    for (const key of keys) {
      const c = spec.collections[key];
      const out = plan({
        local: Array.isArray(data[key]) ? data[key] : [], base: state.base[key], remote: remote[key],
        open: state.open[key], own: c.own, tombstones: c.tombstones, now: now(),
      });
      data[key] = out.local;
      state.base[key] = out.base;
      state.open[key] = out.conflicts;
      outgoing[key] = out.push;
    }
    save(data);
    state.cursor = cursor;

    // 3. What changed here, in the declared order (a rule before the entries made from it)
    let stale = 0;
    const failed = [];
    for (const key of keys) {
      const map = spec.collections[key].map;
      for (let i = 0; i < outgoing[key].length; i += PUSH_CHUNK) {
        const records = outgoing[key].slice(i, i + PUSH_CHUNK).map((r) => toRemote(r, map));
        const res = await call(`/local/${service(key)}/sync/push`, { ...scope, kind: kind(key), records });
        state.base[key] = accept(state.base[key], (res.accepted ?? []).map((r) => toLocal(r, map)));
        report.pushed += res.accepted?.length ?? 0;
        for (const r of res.rejected ?? []) {
          if (r.reason === "stale") {
            stale += 1;
            if (r.current) fresh[key].push(toLocal(r.current, map));
          } else {
            const record = outgoing[key].find((x) => x.id === r.id);
            failed.push({ key, id: r.id, reason: r.reason, title: record?.title ?? null });
          }
        }
      }
    }
    report.failed = failed;
    if (!stale) break;
  }

  state.failed = report.failed;
  state.lastSync = now().toISOString();
  state.lastError = null;
  return { ...report, conflicts: keys.reduce((n, k) => n + state.open[k].length, 0) };
}
