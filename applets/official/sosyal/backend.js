// Social media content calendar: takvim.json at the root + the projects' renders/ folders. Setting: Settings → Social.
import { execFile, execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";

const STEPS = ["veri", "kesit", "render", "paylasildi"];
const PLATFORMS = ["instagram", "tiktok", "youtube"];
const METRICS = ["izlenme", "begeni", "yorum", "kaydetme", "paylasim", "takip"];
const TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".mp4": "video/mp4", ".html": "text/html; charset=utf-8",
};
const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync) || "ffmpeg";

const expand = (p) => (/^~[\\/]/.test(p ?? "") ? join(homedir(), p.slice(2)) : p);
const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowTime = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function send(res, code, body, type = "application/json; charset=utf-8", cache = "no-store") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": cache });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((done, fail) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => done(body));
    req.on("error", fail);
  });
}

/** Answers a Range request with a part, so the video player can seek. */
function sendFile(req, res, file, type) {
  const size = statSync(file).size;
  let start = 0, end = size - 1, code = 200;
  const range = req.headers.range;
  if (range?.startsWith("bytes=")) {
    const [a, b] = range.slice(6).split(",")[0].split("-");
    start = a ? Number(a) : Math.max(0, size - Number(b));
    if (a && b) end = Math.min(Number(b), size - 1);
    code = 206;
  }
  // Storyboards and SVGs come from the content folder: scripts may run, but with no access to the dashboard
  const isolated = /html|svg/.test(type) ? { "Content-Security-Policy": "sandbox allow-scripts" } : {};
  const headers = { ...isolated, "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "Content-Length": end - start + 1 };
  if (code === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, headers);
  createReadStream(file, { start, end }).pipe(res);
}

/** { "24s": {...}, "7g": {...} }: empty fields are dropped. */
function periods(source, t) {
  const clean = {};
  for (const period of ["24s", "7g"]) {
    const fields = {};
    for (const [k, x] of Object.entries(source?.[period] || {})) {
      if (!METRICS.includes(k) || x == null || !String(x).trim()) continue;
      const n = Math.trunc(Number(x));
      if (Number.isNaN(n)) throw new Error(t("not a number: {value}", { value: x }));
      fields[k] = n;
    }
    if (Object.keys(fields).length) clean[period] = fields;
  }
  return clean;
}

export default function create({ dataDir, settings, t }) {
  const root = () => expand(settings().root);
  const configured = () => !!root() && existsSync(join(root(), "takvim.json"));
  const calendar = () => join(root(), "takvim.json");
  const covers = join(dataDir, "kapaklar");
  const version = () => String(statSync(calendar(), { bigint: true }).mtimeNs); // text: nanoseconds do not fit in a JS number

  function latestVideo(project) {
    if (!project) return null;
    const dir = join(root(), project, "renders");
    if (!existsSync(dir)) return null;
    let best = null, bestAt = -1;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".mp4")) continue;
      const at = statSync(join(dir, f)).mtimeMs;
      if (at >= bestAt) { best = join(dir, f); bestAt = at; }
    }
    return best;
  }

  const posix = (p) => relative(root(), p).split(sep).join("/");

  function overview() {
    if (!configured()) return { not_configured: true };
    const d = JSON.parse(readFileSync(calendar(), "utf8"));
    const day = today();
    for (const v of d.videolar) {
      // A video past its day and not shared falls among the undated; the date in the file stays, this is display only
      if (v.tarih && v.tarih < day && !v.adimlar?.paylasildi) {
        v.planlanan_tarih = v.tarih;
        v.tarih = null;
      }
      const video = latestVideo(v.proje);
      v.video = video ? posix(video) : "";
      const board = v.proje ? join(root(), v.proje, "storyboard.html") : null;
      v.storyboard = board && existsSync(board) && statSync(board).isFile() ? posix(board) : "";
    }
    d.surum = version();
    return d;
  }

  /** An image or video under the root; it cannot leave the folder. */
  function mediaFile(path) {
    const base = resolve(root());
    const file = resolve(base, path);
    const type = TYPES[extname(file).toLowerCase()];
    if (!type || !file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
    return { file, type };
  }

  async function cover(id) {
    const v = JSON.parse(readFileSync(calendar(), "utf8")).videolar.find((x) => x.id === id);
    if (!v) return null;
    const video = latestVideo(v.proje);
    if (video) {
      mkdirSync(covers, { recursive: true });
      const second = v.kapak_sn ?? 1;
      const target = join(covers, `${id}-${Math.floor(statSync(video).mtimeMs / 1000)}-${second}.jpg`);
      if (!existsSync(target)) {
        for (const f of readdirSync(covers)) if (f.startsWith(`${id}-`) && f.endsWith(".jpg")) rmSync(join(covers, f));
        await new Promise((done) => {
          execFile(FFMPEG, ["-loglevel", "error", "-y", "-ss", String(second), "-i", video, "-frames:v", "1", "-vf", "scale=360:-1", target], { timeout: 30_000 }, () => done());
        });
      }
      if (existsSync(target)) return { body: readFileSync(target), type: "image/jpeg" };
    }
    if (v.kapak) {
      const m = mediaFile(v.kapak);
      if (m) return { body: readFileSync(m.file), type: m.type };
    }
    return null;
  }

  /** Explorer's exit code says nothing about success; the clipboard path goes through the environment. */
  function videoActionWindows(action, file) {
    if (action === "goster") {
      execFile("explorer.exe", [`/select,"${file}"`], { windowsVerbatimArguments: true }, () => {});
      return;
    }
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -LiteralPath $env:SPEYS_FILE"], { timeout: 10_000, stdio: "ignore", windowsHide: true, env: { ...process.env, SPEYS_FILE: file } });
  }

  /** Copies the latest render to the clipboard as a file, or shows it in Finder or File Explorer. */
  function videoAction({ id, ne: action }) {
    const v = overview().videolar.find((x) => x.id === id);
    if (!v) throw new Error(t("no such video"));
    const m = mediaFile(v.video || "");
    if (!m) throw new Error(t("no such video"));
    if (process.platform === "win32") return videoActionWindows(action, m.file);
    if (process.platform !== "darwin") throw new Error(t("macOS and Windows only"));
    if (action === "goster") {
      execFileSync("open", ["-R", m.file], { timeout: 10_000 });
      return;
    }
    // A file URL on NSPasteboard (like ⌘C in Finder). The path goes through argv, it is not embedded in the script.
    const script = 'ObjC.import("AppKit"); function run(argv) { const pb = $.NSPasteboard.generalPasteboard; pb.clearContents; return pb.writeObjects($.NSArray.arrayWithObject($.NSURL.fileURLWithPath(argv[0]))); }';
    const out = execFileSync("osascript", ["-l", "JavaScript", "-e", script, m.file], { timeout: 10_000, encoding: "utf8" });
    if (out.trim() !== "true") throw new Error(t("could not write to the clipboard"));
  }

  /** An undated or overdue video settles on the day it is shared. */
  function settleShareDay(v) {
    const day = today();
    if (!v.adimlar?.paylasildi && (!v.tarih || v.tarih < day)) v.tarih = day;
  }

  /** Changes one field. False (409) if the file changed in the meantime. */
  function apply(q) {
    if (q.surum && String(q.surum) !== version()) return false;
    const d = JSON.parse(readFileSync(calendar(), "utf8"));
    const { op } = q;
    if (op === "takipci") {
      const h = d.hesaplar.find((x) => x.id === q.hesap);
      if (!h) throw new Error(t("no such account"));
      h.takipci = q.deger == null || q.deger === "" ? null : Math.trunc(Number(q.deger));
    } else if (op === "arka") {
      d.arka_plan[Number(q.sira)].bitti = !!q.deger;
    } else {
      const v = d.videolar.find((x) => x.id === q.id);
      if (!v) throw new Error(t("no such video"));
      if (op === "adim") {
        if (!STEPS.includes(q.adim)) throw new Error(t("no such step"));
        if (q.adim === "paylasildi" && q.deger) settleShareDay(v);
        v.adimlar[q.adim] = !!q.deger;
        if (q.adim === "paylasildi") v.paylasildi_tarih = q.deger ? today() : null;
      } else if (op === "platform") {
        if (!PLATFORMS.includes(q.platform)) throw new Error(t("no such platform"));
        const shared = (v.platformlar ??= {});
        const times = (v.paylasim_saatleri ??= {});
        if (q.deger) {
          settleShareDay(v);
          shared[q.platform] = today();
          times[q.platform] ??= nowTime();
        } else {
          delete shared[q.platform];
          delete times[q.platform];
        }
        if (!Object.keys(times).length) delete v.paylasim_saatleri;
        const days = Object.values(shared);
        v.adimlar.paylasildi = days.length > 0;
        v.paylasildi_tarih = days.length ? days.sort()[0] : null;
      } else if (op === "platform_saat") {
        if (!(q.platform in (v.platformlar || {}))) throw new Error(t("not shared on this platform"));
        const time = String(q.saat || "");
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(t("time must be HH:MM"));
        (v.paylasim_saatleri ??= {})[q.platform] = time;
      } else if (op === "rakamlar") {
        // If platforms are given separately ({"platform": {"instagram": {"24s": …}}}), the 24s / 7g above them are totals.
        const perPlatform = {};
        for (const [p, r] of Object.entries(q.deger.platform || {})) {
          if (!PLATFORMS.includes(p)) continue;
          const c = periods(r, t);
          if (Object.keys(c).length) perPlatform[p] = c;
        }
        let clean;
        if (Object.keys(perPlatform).length) {
          clean = {};
          for (const period of ["24s", "7g"]) {
            const sum = {};
            for (const r of Object.values(perPlatform)) {
              for (const [k, x] of Object.entries(r[period] || {})) sum[k] = (sum[k] || 0) + x;
            }
            if (Object.keys(sum).length) clean[period] = sum;
          }
          clean.platform = perPlatform;
        } else {
          clean = periods(q.deger, t);
        }
        v.rakamlar = clean;
      } else if (op === "tarih") {
        const date = q.deger || null;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(t("invalid date"));
        v.tarih = date;
      } else {
        throw new Error(t("no such operation"));
      }
    }
    const temp = calendar() + ".yeni";
    writeFileSync(temp, JSON.stringify(d, null, 2) + "\n");
    renameSync(temp, calendar());
    return true;
  }

  return async (req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "GET") {
      if (path === "/") return send(res, 200, readFileSync(join(import.meta.dirname, "index.html")), "text/html; charset=utf-8");
      if (path === "/api/sosyal") return send(res, 200, overview());
      if (path.startsWith("/sosyal/kapak/")) {
        const c = await cover(decodeURIComponent(path.slice(14)));
        return c ? send(res, 200, c.body, c.type, "no-cache") : send(res, 404, { error: t("not found") });
      }
      if (path.startsWith("/sosyal/dosya/")) {
        const m = mediaFile(decodeURIComponent(path.slice(14)));
        return m ? sendFile(req, res, m.file, m.type) : send(res, 404, { error: t("not found") });
      }
    }
    if (req.method === "POST" && (path === "/api/sosyal" || path === "/api/sosyal/video")) {
      if (req.headers["x-panel"] !== "1") return send(res, 403, { error: t("not allowed") });
      try {
        const q = JSON.parse((await readBody(req)) || "{}");
        if (path === "/api/sosyal/video") {
          videoAction(q);
          return send(res, 200, { ok: true });
        }
        const ok = apply(q);
        return send(res, ok ? 200 : 409, { ok });
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) });
      }
    }
    send(res, 404, { error: t("not found") });
  };
}
