// Finances: your money, business and personal, on this computer. Works with no account and no network.
// Business: the ledger (defter.json), optionally connected to a Speys account: then it syncs both ways with that
// account's Ledger (lib/speys.js, lib/speys-sync.js, "sync" in applet.json). Syncing never runs at start-up, only
// while the page is open.
// Personal: kisisel.json (personal.js, personal-view.js, the page's personal-page.js): expenses, income, investments,
// statements, your accounts. On this computer only for now. Business entries aren't copied there: the personal month
// reads the ledger and shows the ones paid from your own pocket. The plan: speys-local data/product/features/finans.
// Setting: settings.json → "kasa" (file: the ledger file; if empty, dataDir/defter.json).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expand, handleWrite, isoDay, page, readBody, readJson, send, writeJson } from "../../../lib/common.js";
import { NotConnected, sharedConnectionFile, speysConnection } from "../../../lib/speys.js";
import { emptySyncState, runSync } from "../../../lib/speys-sync.js";
import { duplicates, readSpec, resolve } from "../../../lib/sync.js";
import { atHome, deleteEntry, isOperating, net, deletePlan, deleteRule, deleteScenario, emptyLedger, materialize, overview, saveEntry, savePlan, saveRule, saveScenario, saveTaxSettings, setItemDone, setItems, setRuleActive } from "./ledger.js";
import { accountantItems, calendar, estimate, taxSettings } from "./tax.js";
import { deleteAccount, deleteList, deleteSubscription, deleteTransaction, emptyBook, importRows, materializeSubscriptions, saveAccount, saveList, saveSubscription, saveTransaction } from "./personal.js";

// the page's personal side and the Speys wordmark of the top strip, served beside index.html
const PAGE_FILES = {
  "/personal-page.js": "text/javascript; charset=utf-8", "/personal-view.js": "text/javascript; charset=utf-8", "/personal-presets.js": "text/javascript; charset=utf-8",
  "/speys-logo-beyaz.svg": "image/svg+xml", "/speys-logo-koyu.svg": "image/svg+xml",
  // Speys's typeface, Geist (OFL, fonts/OFL.txt), kept here so the page looks the same offline
  "/fonts/geist-latin.woff2": "font/woff2", "/fonts/geist-latin-ext.woff2": "font/woff2",
};

const spec = readSpec(JSON.parse(readFileSync(join(import.meta.dirname, "applet.json"), "utf8")).sync);
const AUTO_EVERY = 2 * 60 * 1000; // the page asks often; Speys is asked at most this often unless a change was made
// Receipts and invoices: the same kinds and size as Speys (backend/kasa/receipts.ts).
const FILE_TYPES = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const MAX_FILE = 10 * 1024 * 1024;
const DUPLICATES = { same: ["direction", "amount"], date: "entryDate", days: 3, text: ["title", "counterparty"] };

export default function create({ dataDir, settings, t, language }) {
  const currency = () => String(settings().currency ?? "").replace(/[<>&"']/g, "").trim().slice(0, 8) || (language() === "tr" ? "TL" : "USD");
  const file = () => expand(settings().file) || join(dataDir, "defter.json");
  const load = () => (existsSync(file()) ? readJson(file()) : emptyLedger());

  // ——— Personal book
  const personalFile = join(dataDir, "kisisel.json");
  const loadPersonal = () => (existsSync(personalFile) ? readJson(personalFile) : emptyBook());
  const writePersonal = (req, res, apply) =>
    handleWrite(req, res, (body) => {
      const book = loadPersonal();
      let out;
      try { out = apply(book, body); } catch (e) { throw new Error(t(e.message)); }
      writeJson(personalFile, book);
      return out ?? true;
    });
  function personalRoute(req, res, path) {
    if (req.method === "GET" && path === "/api/kisisel") {
      const book = loadPersonal();
      // the subscriptions' renewals due by today go to the book first (Speys does it with a daily job)
      if (materializeSubscriptions(book, isoDay())) writeJson(personalFile, book);
      const live = (list) => (list ?? []).filter((x) => !x.deletedAt);
      return send(res, 200, { accounts: live(book.accounts), transactions: live(book.transactions), lists: live(book.lists), subscriptions: live(book.subscriptions) });
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    if (path === "/api/kisisel/islem") return writePersonal(req, res, (b, body) => saveTransaction(b, body) && true);
    if (path === "/api/kisisel/islem/sil") return writePersonal(req, res, (b, body) => deleteTransaction(b, body.id));
    if (path === "/api/kisisel/hesap") return writePersonal(req, res, (b, body) => saveAccount(b, body) && true);
    if (path === "/api/kisisel/hesap/sil") return writePersonal(req, res, (b, body) => deleteAccount(b, body.id));
    if (path === "/api/kisisel/butce") return writePersonal(req, res, (b, body) => saveList(b, body).id);
    if (path === "/api/kisisel/butce/sil") return writePersonal(req, res, (b, body) => deleteList(b, body.id));
    if (path === "/api/kisisel/abonelik") return writePersonal(req, res, (b, body) => saveSubscription(b, body) && true);
    if (path === "/api/kisisel/abonelik/sil") return writePersonal(req, res, (b, body) => deleteSubscription(b, body.id));
    // statement rows ticked on the page: { rows: [{ date, title, amount, category }], accountId }
    if (path === "/api/kisisel/ekstre") {
      return writePersonal(req, res, (b, body) => importRows(b, Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [], { accountId: body.accountId || null }));
    }
    return send(res, 404, { error: "not found" });
  }

  // ——— Speys connection and sync
  const speys = () => speysConnection({ file: sharedConnectionFile(dataDir), api: String(settings().speysApi ?? "").trim() });
  let connection = null, connectionApi = null;
  const conn = () => {
    const api = String(settings().speysApi ?? "").trim();
    if (!connection || api !== connectionApi) { connection = speys(); connectionApi = api; } // keeps the sign-in in progress
    return connection;
  };
  const stateFile = () => join(dataDir, "speys-sync.json");
  const loadState = () => ({ ...emptySyncState(), ...(existsSync(stateFile()) ? readJson(stateFile()) : {}) });
  const saveState = (s) => writeJson(stateFile(), s);
  let running = null, dirty = false;
  const filesDir = () => join(dataDir, "files");
  const filePath = (f) => join(filesDir(), `${f.id}.${FILE_TYPES[f.type] ?? "bin"}`);

  function readRaw(req) {
    return new Promise((done, fail) => {
      const chunks = []; let size = 0;
      req.on("data", (c) => { size += c.length; if (size > MAX_FILE) { fail(new Error("The file is larger than 10 MB")); req.destroy(); } else chunks.push(c); });
      req.on("end", () => done(Buffer.concat(chunks)));
      req.on("error", fail);
    });
  }

  /**
   * Files added here go to Speys when the ledger is synced and the entry is already there. Speys keeps receipts only
   * for businesses on Plus: otherwise the file stays on this computer and says so.
   */
  async function uploadFiles(s) {
    const ledger = load();
    let changed = false;
    for (const e of ledger.entries ?? []) {
      const synced = s.base?.entries?.[e.id];
      if (e.deletedAt || !synced || synced.deletedAt) continue;
      for (const f of e.localFiles ?? []) {
        if (f.key || f.uploadError === "plus" || !existsSync(filePath(f))) continue;
        try {
          const body = readFileSync(filePath(f));
          const { uploadUrl, key } = await conn().call("/local/kasa/receipts/upload-url", {
            businessId: s.business.id, fileName: f.name, contentType: f.type, fileSize: body.length,
          });
          const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": f.type, "Content-Length": String(body.length) }, body });
          if (!put.ok) throw new Error(`upload ${put.status}`);
          const attachments = [...(synced.attachments ?? []), { key, name: f.name, type: f.type, size: body.length }];
          await conn().call("/local/kasa/receipts/attach", { entryId: e.id, attachments });
          f.key = key;
          delete f.uploadError;
          e.attachments = attachments;
          synced.attachments = attachments;
        } catch (err) {
          f.uploadError = err.status === 403 ? "plus" : String(err.message || err);
        }
        changed = true;
      }
    }
    if (changed) { writeJson(file(), ledger); saveState(s); }
  }

  function syncStatus() {
    const s = loadState();
    const ledger = load();
    const open = Object.entries(s.open ?? {}).flatMap(([key, list]) => list.map((c) => ({ key, ...c })));
    return {
      ...conn().status(),
      business: s.business ?? null,
      lastSync: s.lastSync ?? null,
      lastError: s.lastError ?? null,
      running: Boolean(running),
      conflicts: open,
      failed: s.failed ?? [],
      duplicates: duplicates(ledger.entries ?? [], { ...DUPLICATES, dismissed: s.dismissed ?? [] })
        .map(({ a, b, score, key }) => ({ a, b, score, key })),
    };
  }

  /** Runs one sync unless one is running or it ran a moment ago with nothing changed here. */
  async function sync({ force = false } = {}) {
    if (running) return running;
    const s = loadState();
    if (!conn().status().connected || !s.business?.id) return null;
    if (!force && !dirty && s.lastSync && Date.now() - Date.parse(s.lastSync) < AUTO_EVERY) return null;
    dirty = false;
    running = (async () => {
      try {
        const report = await runSync({
          spec, call: conn().call, scope: { businessId: s.business.id }, state: s,
          load: () => { const l = load(); for (const k of Object.keys(spec.collections)) l[k] ??= []; return l; },
          save: (l) => writeJson(file(), l),
        });
        saveState(s);
        await uploadFiles(s);
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

  /** A broken file must not be silently overwritten with an empty ledger: `load` throws, so nothing is written. */
  const write = (req, res, apply) =>
    handleWrite(req, res, (body) => {
      dirty = true;
      const ledger = load();
      try {
        apply(ledger, body, isoDay());
      } catch (e) {
        // ledger.js has no language: its validation messages are English keys, translated here
        throw new Error(t(e.message));
      }
      writeJson(file(), ledger);
      return true;
    });

  function read(query) {
    const ledger = load();
    const today = isoDay();
    if (materialize(ledger, today)) writeJson(file(), ledger);
    const year = Number(query.get("year")) || +today.slice(0, 4);
    // Tax as in Speys (tax.js): an estimate for the year, the next filings and the accountant's fee items.
    const tax = {
      settings: taxSettings(ledger.taxSettings),
      estimate: estimate(ledger, ledger.taxSettings, year, today, { yearEnd: query.get("yearEnd") === "1" }),
      calendar: calendar(ledger, ledger.taxSettings, today),
      accountant: accountantItems(year),
      templatesAdded: (ledger.rules ?? []).filter((r) => !r.deletedAt && r.templateKey).map((r) => r.templateKey),
    };
    return { tax, ...overview(ledger, {
      from: query.get("from") || `${year}-01-01`,
      to: query.get("to") || `${year}-12-31`,
      year,
      scenario: query.get("scenario") || null,
    }, today) };
  }

  return (req, res) => {
    const url = new URL(req.url, "http://local");
    const path = url.pathname;
    if (req.method === "GET" && path === "/") return page(res, import.meta.dirname);
    if (req.method === "GET" && Object.hasOwn(PAGE_FILES, path)) return send(res, 200, readFileSync(join(import.meta.dirname, path.slice(1))), PAGE_FILES[path], path.startsWith("/fonts/") ? "max-age=604800" : "no-store");
    if (path === "/api/kisisel" || path.startsWith("/api/kisisel/")) return personalRoute(req, res, path);
    if (req.method === "GET" && path === "/api/kasa") {
      try {
        return send(res, 200, { ...read(url.searchParams), currency: currency() });
      } catch (e) {
        return send(res, 500, { error: t("Could not read the ledger file ({file}): {message}", { file: file(), message: e.message }) });
      }
    }
    if (path.startsWith("/api/speys")) return speysRoute(req, res, url);
    if (path.startsWith("/api/belge")) return fileRoute(req, res, url);
    if (req.method === "POST" && path === "/api/kayit") return write(req, res, (l, b) => saveEntry(l, b));
    if (req.method === "POST" && path === "/api/kayit/sil") return write(req, res, (l, b) => deleteEntry(l, b.id));
    // A receipt's lines and what's at home (on this computer only; another applet's page may read /api/evde)
    if (req.method === "POST" && path === "/api/kalemler") return write(req, res, (l, b) => setItems(l, b.entry, b.items));
    if (req.method === "POST" && path === "/api/kalem/bitti") return write(req, res, (l, b) => setItemDone(l, b.entry, b.id, b.done !== false));
    if (req.method === "GET" && path === "/api/evde") {
      try { return send(res, 200, { items: atHome(load()) }); } catch (e) { return send(res, 500, { error: e.message }); }
    }
    // The business's entries between two days: the personal month shows the ones paid from your own pocket, and another
    // applet's page may read them. Read only; amounts as written, `net` without VAT.
    if (req.method === "GET" && path === "/api/islemler") {
      const day = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get(k) ?? "") ? url.searchParams.get(k) : null);
      const from = day("from") ?? "0000-01-01", to = day("to") ?? "9999-12-31";
      try {
        const entries = (load().entries ?? []).filter((e) => !e.deletedAt && e.entryDate >= from && e.entryDate <= to)
          .map(({ items, localFiles, attachments, ...e }) => ({ ...e, lines: items?.length ?? 0, files: (localFiles?.length ?? 0) + (attachments?.length ?? 0), net: Math.round(net(e) * 100) / 100, operating: isOperating(e.direction, e.category) }));
        return send(res, 200, { currency: currency(), entries });
      } catch (e) { return send(res, 500, { error: e.message }); }
    }
    if (req.method === "POST" && path === "/api/kural") return write(req, res, (l, b, today) => saveRule(l, b, today));
    if (req.method === "POST" && path === "/api/kural/durum") return write(req, res, (l, b, today) => setRuleActive(l, b.id, !!b.active, today));
    if (req.method === "POST" && path === "/api/kural/sil") return write(req, res, (l, b) => deleteRule(l, b.id));
    if (req.method === "POST" && path === "/api/plan") return write(req, res, (l, b) => savePlan(l, b));
    if (req.method === "POST" && path === "/api/plan/sil") return write(req, res, (l, b) => deletePlan(l, b.id));
    if (req.method === "POST" && path === "/api/senaryo") return write(req, res, (l, b) => saveScenario(l, b));
    if (req.method === "POST" && path === "/api/vergi/ayar") return write(req, res, (l, b) => saveTaxSettings(l, b));
    // The accountant template: the chosen fee items as recurring rules (pending when due), the setup fee as a pending entry.
    // An item already added (same template key) isn't added twice.
    if (req.method === "POST" && path === "/api/musavir") return write(req, res, (l, b, today) => {
      const items = accountantItems(+today.slice(0, 4)).items;
      const start = /^\d{4}-\d{2}-\d{2}$/.test(b.startDate ?? "") ? b.startDate : today;
      for (const pick of b.items ?? []) {
        const item = items.find((x) => x.key === pick.key);
        if (!item) continue;
        const amount = Number(pick.amount) || item.amount;
        if (item.cycle === "once") {
          saveEntry(l, { direction: "out", title: t(item.title), amount, category: item.category, entryDate: start, status: "pending" });
        } else if (!(l.rules ?? []).some((r) => !r.deletedAt && r.templateKey === item.templateKey)) {
          saveRule(l, { ...item, title: t(item.title), amount, startDate: start, isActive: true }, today);
        }
      }
    });
    if (req.method === "POST" && path === "/api/senaryo/sil") return write(req, res, (l, b) => deleteScenario(l, b.id));
    send(res, 404, { error: "not found" });
  };

  /** Receipts on this computer: add (the file is the request body), open, remove. */
  async function fileRoute(req, res, url) {
    const path = url.pathname;
    if (req.method === "GET" && path.startsWith("/api/belge/")) {
      const id = path.slice("/api/belge/".length);
      const f = (load().entries ?? []).flatMap((e) => e.localFiles ?? []).find((x) => x.id === id);
      if (!f || !existsSync(filePath(f))) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": f.type, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`, "Cache-Control": "private, max-age=3600" });
      return res.end(readFileSync(filePath(f)));
    }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    if (req.headers["x-panel"] !== "1") return send(res, 403, { error: "forbidden" });
    try {
      if (path === "/api/belge") {
        const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!FILE_TYPES[type]) return send(res, 400, { error: t("Only PDF and photos (JPEG, PNG, WebP, HEIC) can be added") });
        const body = await readRaw(req);
        if (!body.length) return send(res, 400, { error: t("The file is empty") });
        const ledger = load();
        const entry = (ledger.entries ?? []).find((e) => e.id === url.searchParams.get("entry") && !e.deletedAt);
        if (!entry) return send(res, 404, { error: t("Record not found") });
        const f = { id: randomUUID(), name: String(url.searchParams.get("name") || "file").slice(0, 200), type, size: body.length, addedAt: new Date().toISOString() };
        mkdirSync(filesDir(), { recursive: true });
        writeFileSync(filePath(f), body);
        (entry.localFiles ??= []).push(f);
        writeJson(file(), ledger);
        dirty = true;
        return send(res, 200, { file: f });
      }
      if (path === "/api/belge/sil") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const ledger = load();
        const entry = (ledger.entries ?? []).find((e) => e.id === body.entry);
        const f = entry?.localFiles?.find((x) => x.id === body.id);
        if (!f) return send(res, 404, { error: t("Record not found") });
        entry.localFiles = entry.localFiles.filter((x) => x.id !== f.id);
        if (f.key && entry.attachments?.some((a) => a.key === f.key) && conn().status().connected) {
          const attachments = entry.attachments.filter((a) => a.key !== f.key);
          await conn().call("/local/kasa/receipts/attach", { entryId: entry.id, attachments });
          entry.attachments = attachments;
        }
        rmSync(filePath(f), { force: true });
        writeJson(file(), ledger);
        return send(res, 200, { ok: true });
      }
    } catch (e) {
      return send(res, e instanceof NotConnected ? 401 : 400, { error: t(String(e.message || e)) });
    }
    return send(res, 404, { error: "not found" });
  }

  async function speysRoute(req, res, url) {
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/speys") return send(res, 200, syncStatus());

    // Speys sends the browser back here after the user approves (or refuses); the state ties it to this sign-in.
    if (req.method === "GET" && path === "/api/speys/callback") {
      const q = url.searchParams;
      let message, ok = true;
      try {
        await conn().finish({ code: q.get("code"), state: q.get("state"), error: q.get("error") });
        message = t("Connected to Speys. You can close this tab and go back to Finances.");
      } catch (e) {
        ok = false;
        message = t("Could not connect: {message}", { message: t(e.message) });
      }
      const html = `<!doctype html><meta charset="utf-8"><title>Speys</title><link rel="stylesheet" href="/kit.css">
        <main style="max-width:420px;margin:15vh auto;padding:16px;text-align:center"><p>${message.replace(/[<>&]/g, "")}</p>
        <script>try{window.opener&&window.opener.postMessage({speys:${ok ? "true" : "false"}},location.origin)}catch{}${ok ? "setTimeout(()=>window.close(),1500)" : ""}</script></main>`;
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    if (req.headers["x-panel"] !== "1") return send(res, 403, { error: "forbidden" });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return send(res, 400, { error: "invalid json" }); }
    const fail = (e, code = 400) => send(res, e instanceof NotConnected ? 401 : code, { error: t(String(e.message || e)) });

    try {
      if (path === "/api/speys/connect") {
        const host = req.headers.host || "localhost";
        const back = `http://${/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? host : "localhost"}/a/kasa/api/speys/callback`;
        return send(res, 200, { url: await conn().start(back) });
      }
      if (path === "/api/speys/businesses") return send(res, 200, await conn().call("/local/kasa/businesses", {}));
      if (path === "/api/speys/business") {
        // Another ledger: what was synced with the old one says nothing about the new one.
        const s = { ...emptySyncState(), dismissed: loadState().dismissed ?? [] };
        if (body.id) s.business = { id: String(body.id), name: String(body.name ?? "") };
        saveState(s);
        if (s.business) await sync({ force: true });
        return send(res, 200, syncStatus());
      }
      if (path === "/api/speys/sync") {
        const report = await sync({ force: !!body.force });
        return send(res, 200, { report, ...syncStatus() });
      }
      // A receipt kept in Speys: a short-lived address to open it.
      if (path === "/api/speys/belge") return send(res, 200, await conn().call("/local/kasa/receipts/url", { entryId: body.entryId, key: body.key }));
      if (path === "/api/speys/belge/sil") {
        const ledger = load();
        const entry = (ledger.entries ?? []).find((e) => e.id === body.entryId);
        if (!entry) return send(res, 404, { error: t("Record not found") });
        const attachments = (entry.attachments ?? []).filter((a) => a.key !== body.key);
        await conn().call("/local/kasa/receipts/attach", { entryId: entry.id, attachments });
        entry.attachments = attachments;
        writeJson(file(), ledger);
        return send(res, 200, { ok: true });
      }
      if (path === "/api/speys/disconnect") {
        conn().disconnect();
        return send(res, 200, syncStatus());
      }
      if (path === "/api/speys/resolve") {
        const s = loadState();
        const list = s.open?.[body.key] ?? [];
        const conflict = list.find((c) => c.id === body.id);
        if (!conflict) return send(res, 404, { error: t("Record not found") });
        const record = resolve(conflict, body.picks ?? {});
        const ledger = load();
        ledger[body.key] ??= [];
        const at = ledger[body.key].findIndex((x) => x.id === record.id);
        if (at >= 0) ledger[body.key][at] = { ...ledger[body.key][at], ...record };
        else ledger[body.key].push(record);
        writeJson(file(), ledger);
        s.base[body.key][record.id] = conflict.remote;
        s.open[body.key] = list.filter((c) => c.id !== body.id);
        saveState(s);
        dirty = true;
        await sync({ force: true }).catch(() => {});
        return send(res, 200, syncStatus());
      }
      if (path === "/api/speys/duplicate") {
        const s = loadState();
        if (body.drop) {
          const ledger = load();
          deleteEntry(ledger, body.drop);
          writeJson(file(), ledger);
          dirty = true;
        } else if (body.key) {
          s.dismissed = [...new Set([...(s.dismissed ?? []), String(body.key)])];
          saveState(s);
        }
        return send(res, 200, syncStatus());
      }
    } catch (e) {
      return fail(e, e.status && e.status < 500 ? e.status : 502);
    }
    return send(res, 404, { error: "not found" });
  }
}
