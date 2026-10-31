"use strict";
// Shared helpers and drawings for applets; a page loads them with <script src="/kit.js">.
// The server puts window.I18N (language + this applet's messages) in front of this file.
// —— language ——————————————————————————————————————————————————
const I18N = window.I18N || { language: "en", messages: {} };
const LOCALE = I18N.language;
document.documentElement.lang = LOCALE;
/** The English text is the key, with {name} placeholders filled from values; without a translation it is shown as is. */
const t = (text, values) => {
  const s = I18N.messages[text] ?? text;
  return values ? s.replace(/\{(\w+)\}/g, (all, key) => (key in values ? values[key] : all)) : s;
};
// —— helpers ———————————————————————————————————————————————————
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const inlineMd = (s) => esc(s)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
const relativeTime = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const timeAgo = (ts) => {
  const s = Math.round(Date.now() / 1000 - ts);
  return s < 60 ? t("just now") : s < 3600 ? relativeTime.format(-Math.round(s / 60), "minute")
    : s < 86400 ? relativeTime.format(-Math.round(s / 3600), "hour") : relativeTime.format(-Math.round(s / 86400), "day");
};
function notify(text) {
  const d = document.createElement("div");
  d.className = "bildirim"; d.textContent = text;
  document.body.append(d); setTimeout(() => d.remove(), 2200);
}
async function getJson(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** No refresh while the frame is hidden: an applet left open should not fetch data for nothing. */
const isHidden = () => !!window.frameElement?.hidden;
const goTo = (...p) => { location.hash = p.filter(Boolean).join("/"); };

const percent = (a, b) => (b ? a / b : 0).toLocaleString(LOCALE, { style: "percent", minimumFractionDigits: b ? 1 : 0, maximumFractionDigits: 1 });
const formatNumber = (n) => n.toLocaleString(LOCALE);
const formatDecimal = (v, digits = 1) => (+v).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
/** Single-series line chart (SVG): grid and axis values, a value at the last / best / worst point, a tooltip on
    every point. points: [{x, y, tip}]; format: how a value is written; good: "low" | "high". */
function lineChart(points, format, good, W = 720, H = 190) {
  if (points.length < 2) return `<p class="bos">${t("A chart needs at least two records.")}</p>`;
  const left = 44, right = 16, top = 20, bottom = 26;
  const ys = points.map((p) => p.y), min = Math.min(...ys), max = Math.max(...ys), pad = (max - min) * 0.15 || 1;
  const step = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100].find((a) => (max - min + 2 * pad) / a <= 4) || 100;
  const a0 = Math.floor((min - pad) / step) * step, a1 = Math.ceil((max + pad) / step) * step;
  const px = (i) => left + (i * (W - left - right)) / (points.length - 1), py = (v) => top + ((a1 - v) * (H - top - bottom)) / (a1 - a0);
  const grid = [];
  for (let v = a0; v <= a1 + 1e-9; v += step)
    grid.push(`<line x1="${left}" x2="${W - right}" y1="${py(v)}" y2="${py(v)}" class="cg-izgara"/><text x="${left - 6}" y="${py(v) + 4}" text-anchor="end" class="cg-eksen">${esc(format(v))}</text>`);
  const best = ys.indexOf(good === "low" ? min : max), worst = ys.indexOf(good === "low" ? max : min);
  const labelled = new Set([points.length - 1, best, worst]);
  const xLabels = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter((i, j, d) => !j || points[i].x !== points[d[j - 1]].x);
  // a dip's value goes below the line (the line comes down onto it); the ends are aligned inwards
  const dip = (i) => (i === 0 || points[i - 1].y >= points[i].y) && (i === points.length - 1 || points[i + 1].y >= points[i].y);
  return `<svg class="cg" viewBox="0 0 ${W} ${H}" role="img">${grid.join("")}
    <polyline points="${points.map((p, i) => `${px(i)},${py(p.y)}`).join(" ")}" class="cg-cizgi"/>
    ${points.map((p, i) => `<g class="cg-nokta"><circle cx="${px(i)}" cy="${py(p.y)}" r="4"/><circle cx="${px(i)}" cy="${py(p.y)}" r="12" class="cg-hedef"/><title>${esc(p.tip)}</title></g>`).join("")}
    ${[...labelled].map((i) => `<text x="${px(i)}" y="${dip(i) ? py(points[i].y) + 18 : py(points[i].y) - 9}" text-anchor="${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}" class="cg-deger${i === best ? " iyi" : ""}">${esc(format(points[i].y))}</text>`).join("")}
    ${xLabels.map((i) => `<text x="${px(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}" class="cg-eksen">${esc(points[i].x)}</text>`).join("")}
  </svg>`;
}
/** A difference: green in the good direction, red in the bad one. */
function diffHtml(diff, unit, good) {
  if (diff == null || Math.abs(diff) < 0.05) return `<span class="soluk">${t("no change")}</span>`;
  const isGood = good === "low" ? diff < 0 : diff > 0;
  return `<span class="${isGood ? "fark-iyi" : "fark-kotu"}">${diff > 0 ? "+" : "−"}${formatDecimal(Math.abs(diff))}${unit}</span>`;
}
const shortDay = (iso) => new Date(iso.slice(0, 10) + "T00:00").toLocaleDateString(LOCALE, { day: "numeric", month: "short" });

const svg = (d, size = 16, weight = 2) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  check: (size) => svg('<path d="M20 6 9 17l-5-5"/>', size, 3),
  plus: (size = 16) => svg('<path d="M12 5v14M5 12h14"/>', size),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
  trash: (size = 16) => svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>', size),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  arrow: (size = 14) => svg('<path d="M5 12h14M12 5l7 7-7 7"/>', size),
  filter: svg('<path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/>', 14),
  dots: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 15),
  eyeOff: svg('<path d="M17.9 17.9A10 10 0 0 1 12 19c-6.5 0-10-7-10-7a18 18 0 0 1 4.1-5.1M9.9 5.2A9 9 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/>', 15),
  handle: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></svg>',
};
const formatDate = (iso, long) => new Date(iso + "T00:00").toLocaleDateString(LOCALE, long ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "short" });
const checkboxHtml = (on, size) =>
  `<button type="button" class="tik ${size}${on ? " on" : ""}" data-is="isaretle" role="checkbox" aria-checked="${on}">${on ? ICON.check(size === "sm" ? 9 : 12) : ""}</button>`;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const listHtml = (rows, empty = t("No data.")) => rows.length ? `<ul class="liste">${rows.join("")}</ul>` : `<p class="bos">${empty}</p>`;

/** The page of an applet that has not been set up yet. */
const notConfigured = (name) => `<section class="kart" style="max-width:520px;margin:12vh auto"><h2>${esc(t("{name} is not set up", { name }))}</h2>
  <p class="soluk">${esc(t("Tell it where its data is in Settings."))}</p>
  <button type="button" class="yz-dugme" onclick="parent.openApplet?.('settings')">${esc(t("Go to Settings"))}</button></section>`;
