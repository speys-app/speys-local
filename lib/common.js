// Small helpers shared by backends.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const expand = (p) => (/^~[\\/]/.test(p ?? "") ? join(homedir(), p.slice(2)) : p);

const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hhmm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const isoMinute = (d = new Date()) => `${isoDay(d)}T${hhmm(d)}`;
export const isoSecond = (d = new Date()) => `${isoMinute(d)}:${pad(d.getSeconds())}`;
export const daysAgo = (n, from = new Date()) => isoDay(new Date(from.getFullYear(), from.getMonth(), from.getDate() - n));

export function send(res, code, body, type = "application/json; charset=utf-8", cache = "no-store") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": cache });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function readBody(req) {
  return new Promise((done, fail) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => done(body));
    req.on("error", fail);
  });
}

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
/** A string: nanoseconds do not fit a JS number. A write is refused if the file changed in the meantime. */
export const version = (file) => String(statSync(file, { bigint: true }).mtimeNs);

export function writeJson(file, data, indent = 2) {
  const temp = `${file}.new`;
  writeFileSync(temp, JSON.stringify(data, null, indent) + "\n");
  renameSync(temp, file);
}

export function page(res, dir) {
  send(res, 200, readFileSync(join(dir, "index.html")), "text/html; charset=utf-8");
}

/** The common POST wrapper: header check, JSON, 200 / 409 / 400. */
export async function handleWrite(req, res, apply) {
  if (req.headers["x-panel"] !== "1") return send(res, 403, { error: "forbidden" });
  try {
    const ok = await apply(JSON.parse((await readBody(req)) || "{}"));
    return send(res, ok ? 200 : 409, { ok });
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
}
