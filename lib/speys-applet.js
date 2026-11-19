// The Speys part of an applet's backend, ready made: connection status, connecting (and the page Speys sends the
// browser back to), syncing, disconnecting and answering a conflict. The applet gives its sync spec (applet.json
// "sync") and how to read and write its data file; it mounts `route` under `/api/speys`.
// Finances (kasa) has its own version of this because it also picks a business; an applet without such a choice
// uses this one.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readBody, readJson, send, writeJson } from "./common.js";
import { NotConnected, sharedConnectionFile, speysConnection } from "./speys.js";
import { emptySyncState, runSync } from "./speys-sync.js";
import { resolve } from "./sync.js";

const AUTO_EVERY = 2 * 60 * 1000; // the page asks often; Speys is asked at most this often unless something changed here

/**
 * appletId: the applet's id (its address is /a/<id>/)
 * spec:     readSpec(applet.json "sync")
 * load():   the data file as an object; save(data) writes it
 * scope():  what Speys needs besides the records (none for an applet whose data belongs to the account)
 */
export function speysApplet({ appletId, dataDir, settings, t, spec, load, save, scope = () => ({}) }) {
  let connection = null, connectionApi = null, running = null, dirty = false;
  const conn = () => {
    const api = String(settings().speysApi ?? "").trim();
    if (!connection || api !== connectionApi) {
      connection = speysConnection({ file: sharedConnectionFile(dataDir), api });
      connectionApi = api;
    }
    return connection;
  };
  const stateFile = join(dataDir, "speys-sync.json");
  const loadState = () => ({ ...emptySyncState(), ...(existsSync(stateFile) ? readJson(stateFile) : {}) });
  const saveState = (s) => writeJson(stateFile, s);
  const loadAll = () => {
    const data = load();
    for (const k of Object.keys(spec.collections)) data[k] ??= [];
    return data;
  };

  function status() {
    const s = loadState();
    return {
      ...conn().status(),
      lastSync: s.lastSync ?? null,
      lastError: s.lastError ?? null,
      running: Boolean(running),
      conflicts: Object.entries(s.open ?? {}).flatMap(([key, list]) => list.map((c) => ({ key, ...c }))),
      failed: s.failed ?? [],
    };
  }

  async function sync({ force = false } = {}) {
    if (running) return running;
    const s = loadState();
    if (!conn().status().connected) return null;
    if (!force && !dirty && s.lastSync && Date.now() - Date.parse(s.lastSync) < AUTO_EVERY) return null;
    dirty = false;
    running = (async () => {
      try {
        const report = await runSync({ spec, call: conn().call, scope: scope(), state: s, load: loadAll, save });
        saveState(s);
        return report;
      } catch (e) {
        s.lastError = e instanceof NotConnected ? t(e.message) : String(e.message || e);
        saveState(s);
        throw e;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function route(req, res, url) {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/speys") return send(res, 200, status());
    if (req.method === "GET" && path === "/api/speys/callback") {
      const q = url.searchParams;
      let message, ok = true;
      try {
        await conn().finish({ code: q.get("code"), state: q.get("state"), error: q.get("error") });
        message = t("Connected to Speys. You can close this tab.");
      } catch (e) {
        ok = false;
        message = t("Could not connect: {message}", { message: t(e.message) });
      }
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Speys</title><link rel="stylesheet" href="/kit.css">
        <main style="max-width:420px;margin:15vh auto;padding:16px;text-align:center"><p>${message.replace(/[<>&]/g, "")}</p>
        <script>try{window.opener&&window.opener.postMessage({speys:${ok}},location.origin)}catch{}${ok ? "setTimeout(()=>window.close(),1500)" : ""}</script></main>`,
      "text/html; charset=utf-8");
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    if (req.headers["x-panel"] !== "1") return send(res, 403, { error: "forbidden" });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return send(res, 400, { error: "invalid json" }); }
    try {
      if (path === "/api/speys/connect") {
        const host = req.headers.host || "localhost";
        const back = `http://${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? host : "localhost"}/a/${appletId}/api/speys/callback`;
        return send(res, 200, { url: await conn().start(back) });
      }
      if (path === "/api/speys/sync") {
        const report = await sync({ force: !!body.force });
        return send(res, 200, { report, ...status() });
      }
      if (path === "/api/speys/disconnect") {
        conn().disconnect();
        return send(res, 200, status());
      }
      if (path === "/api/speys/resolve") {
        const s = loadState();
        const list = s.open?.[body.key] ?? [];
        const conflict = list.find((c) => c.id === body.id);
        if (!conflict) return send(res, 404, { error: t("Not found") });
        const record = resolve(conflict, body.picks ?? {});
        const data = loadAll();
        const at = data[body.key].findIndex((x) => x.id === record.id);
        if (at >= 0) data[body.key][at] = { ...data[body.key][at], ...record };
        else data[body.key].push(record);
        save(data);
        s.base[body.key][record.id] = conflict.remote;
        s.open[body.key] = list.filter((c) => c.id !== body.id);
        saveState(s);
        dirty = true;
        await sync({ force: true }).catch(() => {});
        return send(res, 200, status());
      }
    } catch (e) {
      return send(res, e instanceof NotConnected ? 401 : e.status && e.status < 500 ? e.status : 502, { error: t(String(e.message || e)) });
    }
    return send(res, 404, { error: "not found" });
  }

  return { route, status, sync, markDirty: () => { dirty = true; } };
}
