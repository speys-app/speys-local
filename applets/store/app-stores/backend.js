// App Stores: what Google Play and the App Store show about your apps, checked once a week or with the button.
// The check runs when the page asks for it (never at startup); its results go to checks.json, newest first, so each
// check is compared with the one before. Network: only the public store pages and Apple's lookup service.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { expand, handleWrite, page, readJson, send, writeJson } from "../../../lib/common.js";
import { CATEGORIES, GENERAL, PURPOSES, formDiff, formFromValues, helpPageTypes, readExport, schemaDrift, valuesFromAnswers, writeCsv } from "./play-form.js";
import { changes, checkApp, findings } from "./stores.js";

const HELP_PAGE = "https://support.google.com/googleplay/android-developer/answer/10787469?hl=en";

const WEEK_MS = 7 * 86400_000;
const KEEP = 12;

export default function create({ dataDir, settings, t }) {
  const file = join(dataDir, "checks.json");
  let running = null, lastError = null;

  const apps = () => (Array.isArray(settings().apps) ? settings().apps : [])
    .filter((a) => a && (a.android || a.ios))
    .map((a) => {
      const project = expand(a.project || "");
      const form = expand(a.playForm || "");
      return { name: String(a.name || a.android || a.ios), android: a.android ? String(a.android).trim() : "", ios: a.ios ? String(a.ios).trim() : "", project,
        playForm: form && !isAbsolute(form) && project ? resolve(project, form) : form };
    });
  const country = () => String(settings().country || "us").trim().toLowerCase();
  const keyOf = (a) => a.android || a.ios || a.name;
  const runs = () => {
    try {
      return existsSync(file) ? readJson(file).runs || [] : [];
    } catch {
      return [];
    }
  };

  function check() {
    running ??= (async () => {
      try {
        const list = apps();
        const [results, formDrift] = await Promise.all([Promise.all(list.map((a) => checkApp(a, country()))), list.some((a) => a.playForm) ? helpDrift() : null]);
        const run = { at: new Date().toISOString(), country: country(), formDrift, apps: results.map((r, i) => ({ key: keyOf(list[i]), ...r })) };
        writeJson(file, { runs: [run, ...runs()].slice(0, KEEP) });
        lastError = null;
      } catch (e) {
        lastError = String(e.message || e);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /** Whether Google's help page still lists the data types this applet knows; null when it does or couldn't be read. */
  async function helpDrift() {
    try {
      const r = await fetch(HELP_PAGE, { headers: { "User-Agent": "Mozilla/5.0 (compatible; speys-local)" }, signal: AbortSignal.timeout(20_000) });
      return r.ok ? schemaDrift(helpPageTypes(await r.text())) : null;
    } catch {
      return null;
    }
  }

  // ---- The Data safety form: the answers file in the app's repo against Console's last CSV export ----
  const exportFile = (a) => join(dataDir, "play-export", `${keyOf(a).replace(/[^\w.-]/g, "_")}.csv`);
  function answersOf(a) {
    if (!a.playForm) return { error: "none" };
    try {
      return { answers: JSON.parse(readFileSync(a.playForm, "utf8")) };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }
  function exportOf(a) {
    const file = exportFile(a);
    if (!existsSync(file)) return null;
    try {
      return { ...readExport(readFileSync(file, "utf8")), at: statSync(file).mtime.toISOString() };
    } catch {
      return null;
    }
  }
  function playForm(a) {
    const { answers, error } = answersOf(a);
    const exp = exportOf(a);
    const have = exp ? formFromValues(exp.values) : null;
    const want = answers ? formFromValues(valuesFromAnswers(answers)) : null;
    return {
      name: a.name, file: a.playForm || null, error: error === "none" ? null : error ?? null,
      want, why: answers ? { ...(answers.why || {}), ...Object.fromEntries(Object.entries(answers.types || {}).map(([k, v]) => [k, v.why || ""])) } : {},
      have, exportedAt: exp?.at ?? null, diff: want && have ? formDiff(want, have) : [],
      schema: { general: GENERAL, categories: CATEGORIES, purposes: PURPOSES },
    };
  }

  function overview() {
    const list = apps();
    if (!list.length) return { not_configured: true };
    const [latest, ...older] = runs();
    if (!running && (!latest || Date.now() - Date.parse(latest.at) > WEEK_MS)) check();
    return {
      checkedAt: latest?.at ?? null, running: !!running, error: lastError, formDrift: latest?.formDrift ?? null,
      apps: list.map((a) => {
        const now = latest?.apps.find((x) => x.key === keyOf(a));
        // the last check before this one that had this app, from the same storefront
        const before = older.find((r) => r.country === latest.country && r.apps.some((x) => x.key === keyOf(a)));
        return {
          name: a.name, android: a.android, ios: a.ios, result: now ?? null,
          findings: now ? findings(now) : [],
          changes: now && before ? changes(before.apps.find((x) => x.key === keyOf(a)), now) : [],
          comparedWith: before?.at ?? null,
          form: a.playForm ? (() => { const f = playForm(a); return { error: f.error, diff: f.diff.length, exportedAt: f.exportedAt }; })() : null,
        };
      }),
    };
  }

  return async (req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/") return page(res, import.meta.dirname);
    if (req.method === "GET" && path === "/api/stores") return send(res, 200, overview());
    const query = new URL(req.url, "http://x").searchParams;
    const appAt = (i) => apps()[Number(i)] ?? null;
    if (req.method === "GET" && path === "/api/play") {
      const a = appAt(query.get("app"));
      return a ? send(res, 200, playForm(a)) : send(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && path === "/api/play.csv") {
      const a = appAt(query.get("app"));
      const { answers } = a ? answersOf(a) : {};
      if (!answers) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="data_safety_import.csv"', "Cache-Control": "no-store" });
      return res.end(writeCsv(valuesFromAnswers(answers), exportOf(a)?.rows));
    }
    if (req.method === "POST" && path === "/api/play-export") {
      return handleWrite(req, res, (q) => {
        const a = appAt(q.app);
        if (!a) throw new Error(t("No such app."));
        readExport(String(q.csv || "")); // refuses anything that isn't Console's export
        mkdirSync(join(dataDir, "play-export"), { recursive: true });
        writeFileSync(exportFile(a), String(q.csv));
        return true;
      });
    }
    if (req.method === "POST" && path === "/api/check") {
      return handleWrite(req, res, async () => {
        if (!apps().length) throw new Error(t("Add your apps in Settings first."));
        await check();
        if (lastError) throw new Error(lastError);
        return true;
      });
    }
    send(res, 404, { error: "not found" });
  };
}
