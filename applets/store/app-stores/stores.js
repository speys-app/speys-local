// Reads an app's public store pages: Google Play (details and data safety) and the App Store (iTunes lookup and the
// privacy label), plus the version in the app's own project folder. No sign-in, nothing is written to the stores.
// Play is read in English: its data safety page has no stable ids, so the section names and the encryption line are
// matched as text. The App Store page carries its privacy label as JSON with ids, so any language works there.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (compatible; speys-local)";
const TIMEOUT = 20_000;

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en" }, signal: AbortSignal.timeout(TIMEOUT) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·" };
export const decode = (s) => String(s ?? "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const text = (html) => decode(String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();

// ---- Google Play ----

/** Play's image address without its size ("=w526-h296"), so the page asks for the size it needs. */
const playImage = (src) => decode(src).split("=")[0];

/** Version, last update, description and the listing's look (title, developer, icon, screenshots). Null when Play moved them. */
export function parsePlayDetails(html) {
  const version = html.match(/"141":\[\[\["([^"]+)"\]\]/)?.[1] ?? null;
  const seconds = html.match(/"146":\[\["[^"]*",\[(\d+),/)?.[1];
  const description = html.match(/data-g-id="description"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  const icon = html.match(/<img[^>]*itemprop="image"[^>]*>/)?.[0].match(/src="([^"]+)"/)?.[1];
  const screenshots = [];
  for (const [img] of html.matchAll(/<img[^>]*alt="Screenshot image"[^>]*>/g)) {
    const src = img.match(/src="([^"]+)"/)?.[1];
    if (src && !screenshots.includes(playImage(src))) screenshots.push(playImage(src));
  }
  return {
    version,
    updated: seconds ? new Date(Number(seconds) * 1000).toISOString() : null,
    description: description ? text(description) : null,
    title: text(html.match(/itemprop="name"[^>]*>([\s\S]*?)<\//)?.[1]) || null,
    developer: text(html.match(/href="\/store\/apps\/dev(?:eloper)?\?id=[^"]*"[^>]*>([\s\S]*?)<\/a>/)?.[1]) || null,
    icon: icon ? playImage(icon) : null,
    screenshots,
  };
}

const SECTIONS = { "data shared": "shared", "data collected": "collected", "security practices": "security" };

/**
 * The data safety page, read in English. Each data type is {category, type, optional, purposes}; security is a list of
 * {title, detail}. `encrypted` is true, false, or null when the page doesn't say.
 */
export function parsePlayDataSafety(html) {
  const out = { shared: [], collected: [], security: [], encrypted: null, read: false };
  let section = null, category = null;
  const tags = /<(h2|h3|h4)\b[^>]*>([\s\S]*?)<\/\1>(?:\s*<div[^>]*>([^<]*)<\/div>)?/g;
  for (const [, tag, inner, after] of html.matchAll(tags)) {
    const title = text(inner);
    if (tag === "h2") {
      section = SECTIONS[title.toLowerCase()] ?? null;
      if (section) out.read = true;
      category = null;
    } else if (tag === "h3" && section === "security") {
      out.security.push({ title, detail: text(after) });
      if (/encrypted in transit/i.test(title)) out.encrypted = true;
      else if (/(isn.t|not) encrypted/i.test(title)) out.encrypted = false;
    } else if (tag === "h3" && section) {
      category = title;
    } else if (tag === "h4" && (section === "shared" || section === "collected") && category) {
      const [type, ...flags] = title.split("·").map((s) => s.trim());
      out[section].push({ category, type, optional: flags.some((f) => /optional/i.test(f)), purposes: text(after).split(/,\s*/).filter(Boolean) });
    }
  }
  return out;
}

export async function readPlay(id, country) {
  const q = `id=${encodeURIComponent(id)}&hl=en&gl=${encodeURIComponent(country.toUpperCase())}`;
  const [details, safety] = await Promise.all([
    get(`https://play.google.com/store/apps/details?${q}`),
    get(`https://play.google.com/store/apps/datasafety?${q}`),
  ]);
  if (details === null) return { id, found: false };
  return { id, found: true, url: `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}`, ...parsePlayDetails(details), dataSafety: safety ? parsePlayDataSafety(safety) : null };
}

// ---- App Store ----

/** The privacy label from the page's serialized data: [{id, title, purposes: [{id, title, categories}]}]. */
export function parseAppPrivacy(html) {
  const json = html.match(/<script type="application\/json" id="serialized-server-data">([\s\S]*?)<\/script>/)?.[1];
  if (!json) return null;
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const found = new Map();
  const category = (c) => ({ id: c.identifier, title: c.title, dataTypes: c.dataTypes || [] });
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (o.$kind === "PrivacyType" && o.identifier && !found.has(o.identifier)) {
      const purposes = (o.purposes || []).map((p) => ({ id: p.identifier, title: p.title, categories: (p.categories || []).map(category) }));
      // "Data Not Linked to You" and "Data Used to Track You" can list categories without purposes
      if (!purposes.length && o.categories?.length) purposes.push({ id: null, title: null, categories: o.categories.map(category) });
      found.set(o.identifier, { id: o.identifier, title: o.title, purposes });
      return;
    }
    Object.values(o).forEach(walk);
  })(data);
  return [...found.values()];
}

export async function readAppStore(id, country) {
  const key = /^\d+$/.test(id) ? "id" : "bundleId";
  const body = await get(`https://itunes.apple.com/lookup?${key}=${encodeURIComponent(id)}&country=${encodeURIComponent(country)}`);
  const a = body && JSON.parse(body).results?.[0];
  if (!a) return { id, found: false };
  const page = await get(`https://apps.apple.com/${encodeURIComponent(country)}/app/id${a.trackId}`);
  return {
    id, found: true, url: a.trackViewUrl?.split("?")[0] ?? null,
    version: a.version ?? null, updated: a.currentVersionReleaseDate ?? null, releaseNotes: a.releaseNotes ?? null,
    description: a.description ?? null, title: a.trackName ?? null, developer: a.artistName ?? null, icon: a.artworkUrl512 ?? null,
    screenshots: a.screenshotUrls || [], ipadScreenshots: a.ipadScreenshotUrls || [],
    rating: a.userRatingCount ? { average: a.averageUserRating, count: a.userRatingCount } : null,
    privacy: page ? parseAppPrivacy(page) : null,
  };
}

// ---- The project ----

const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const subfolders = (dir) => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith(".") && n !== "node_modules" && statSync(join(dir, n)).isDirectory()).map((n) => join(dir, n));
  } catch {
    return [];
  }
};

/** Android, iOS, Flutter and Expo versions in the folder or one level below it (a repo with the app in frontend/). */
export function readProject(folder) {
  for (const dir of [folder, ...subfolders(folder)]) {
    const found = {};
    const gradle = readText(join(dir, "android", "app", "build.gradle")) ?? readText(join(dir, "android", "app", "build.gradle.kts"));
    if (gradle) {
      found.android = { version: gradle.match(/versionName\s*=?\s*["']([^"']+)["']/)?.[1] ?? null, build: gradle.match(/versionCode\s*=?\s*(\d+)/)?.[1] ?? null };
    }
    const ios = join(dir, "ios");
    for (const sub of [ios, ...subfolders(ios)]) {
      const project = existsSync(sub) ? readdirSync(sub).find((n) => n.endsWith(".xcodeproj")) : null;
      const pbx = project && readText(join(sub, project, "project.pbxproj"));
      if (pbx) {
        found.ios = { version: pbx.match(/MARKETING_VERSION = ([^;]+);/)?.[1].replace(/"/g, "") ?? null, build: pbx.match(/CURRENT_PROJECT_VERSION = ([^;]+);/)?.[1].replace(/"/g, "") ?? null };
        break;
      }
    }
    const pubspec = readText(join(dir, "pubspec.yaml"))?.match(/^version:\s*([^\s+]+)(?:\+(\d+))?/m);
    if (pubspec) found.android ??= found.ios ??= { version: pubspec[1], build: pubspec[2] ?? null };
    const expo = readText(join(dir, "app.json"));
    if (expo && !found.android && !found.ios) {
      try {
        const e = JSON.parse(expo).expo;
        if (e?.version) {
          found.android = { version: e.version, build: e.android?.versionCode != null ? String(e.android.versionCode) : null };
          found.ios = { version: e.version, build: e.ios?.buildNumber ?? null };
        }
      } catch {
        // not an Expo app.json
      }
    }
    if (found.android || found.ios) return found;
  }
  return null;
}

// ---- Checks ----

/** -1, 0 or 1; numeric parts compare as numbers ("0.19.9" < "0.19.18"). */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/), pb = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0", y = pb[i] ?? "0";
    const d = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Everything about one app, read now. A store that fails to load records its error instead of failing the check. */
export async function checkApp(app, country) {
  const safe = (p) => p.catch((e) => ({ error: String(e.message || e) }));
  const [play, appStore] = await Promise.all([
    app.android ? safe(readPlay(app.android, country)) : null,
    app.ios ? safe(readAppStore(app.ios, country)) : null,
  ]);
  let project = null;
  if (app.project) {
    try {
      project = readProject(app.project);
    } catch (e) {
      project = { error: String(e.message || e) };
    }
  }
  return { name: app.name, play, appStore, project };
}

const playKey = (d) => `${d.category} → ${d.type}${d.optional ? " (optional)" : ""}: ${d.purposes.join(", ")}`;
const appKeys = (privacy) => (privacy || []).flatMap((p) => p.purposes.flatMap((u) => u.categories.map((c) => `${p.title} · ${u.title ?? "—"} · ${c.title}: ${c.dataTypes.join(", ")}`)));
const setDiff = (before, after) => {
  const b = new Set(before), a = new Set(after);
  return { added: [...a].filter((x) => !b.has(x)), removed: [...b].filter((x) => !a.has(x)) };
};

/** What changed on the stores between two checks of the same app: [{store, field, before, after} | {store, field, added, removed}]. */
export function changes(before, after) {
  if (!before || !after) return [];
  const out = [];
  const field = (store, name, x, y) => {
    if (x != null && y != null && x !== y) out.push({ store, field: name, before: x, after: y });
  };
  const list = (store, name, x, y) => {
    const d = setDiff(x, y);
    if (d.added.length || d.removed.length) out.push({ store, field: name, ...d });
  };
  // the look of a listing: the icon and title as before → after, screenshots as both lists (older checks kept only a count)
  const look = (store, x, y) => {
    field(store, "title", x.title, y.title);
    field(store, "icon", x.icon, y.icon);
    const a = Array.isArray(x.screenshots) ? x.screenshots : null, b = Array.isArray(y.screenshots) ? y.screenshots : null;
    if (a && b && a.join() !== b.join()) out.push({ store, field: "screenshots", before: a, after: b });
    else if (!a || !b) field(store, "screenshots", a?.length ?? x.screenshots, b?.length ?? y.screenshots);
  };
  const p0 = before.play, p1 = after.play;
  if (p0?.found && p1?.found) {
    field("play", "version", p0.version, p1.version);
    look("play", p0, p1);
    field("play", "description", p0.description, p1.description);
    if (p0.dataSafety?.read && p1.dataSafety?.read) {
      list("play", "collected", p0.dataSafety.collected.map(playKey), p1.dataSafety.collected.map(playKey));
      list("play", "shared", p0.dataSafety.shared.map(playKey), p1.dataSafety.shared.map(playKey));
      list("play", "security", p0.dataSafety.security.map((s) => s.title), p1.dataSafety.security.map((s) => s.title));
    }
  }
  const a0 = before.appStore, a1 = after.appStore;
  if (a0?.found && a1?.found) {
    field("appStore", "version", a0.version, a1.version);
    look("appStore", a0, a1);
    field("appStore", "description", a0.description, a1.description);
    if (a0.privacy && a1.privacy) list("appStore", "privacy", appKeys(a0.privacy), appKeys(a1.privacy));
  }
  return out;
}

/** Things to act on, worst first: [{level: "bad" | "warn" | "info", code, values}]. The page words them. */
export function findings(app) {
  const out = [];
  const { play, appStore, project } = app;
  for (const [store, s] of [["play", play], ["appStore", appStore]]) {
    if (s?.error) out.push({ level: "warn", code: "unreadable", values: { store } });
    else if (s && !s.found) out.push({ level: "warn", code: "not-found", values: { store, id: s.id } });
  }
  if (play?.found) {
    if (play.dataSafety?.encrypted === false) out.push({ level: "bad", code: "not-encrypted", values: {} });
    if (!play.dataSafety?.read) out.push({ level: "warn", code: "no-data-safety", values: {} });
    else if (!play.dataSafety.collected.length && !play.dataSafety.shared.length) out.push({ level: "warn", code: "nothing-declared", values: { store: "play" } });
    if (!play.version) out.push({ level: "info", code: "play-version-hidden", values: {} });
  }
  if (appStore?.found) {
    if (!appStore.privacy) out.push({ level: "warn", code: "no-privacy-label", values: {} });
    else if (!appStore.privacy.length) out.push({ level: "warn", code: "nothing-declared", values: { store: "appStore" } });
  }
  if (project && !project.error) {
    for (const [store, s, local] of [["play", play, project.android], ["appStore", appStore, project.ios]]) {
      if (s?.found && s.version && local?.version && compareVersions(local.version, s.version) > 0) {
        out.push({ level: "info", code: "ahead", values: { store, local: local.version, live: s.version } });
      }
    }
  } else if (project?.error) out.push({ level: "warn", code: "project-unreadable", values: {} });
  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
