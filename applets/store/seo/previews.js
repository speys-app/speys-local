// Link previews: what WhatsApp, LinkedIn, X and Facebook show when a page of the site is shared. Every page in the
// site's sitemaps is read the way a link preview bot reads it (Open Graph and Twitter tags), and every image it points
// to is fetched once: does it open, is it an image, how big is it. Loaded by backend.js on first use, so the SEO
// applet's start stays light.

const UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const PAGE_LIMIT = 1500;
// A big sitemap is checked by an evenly spread sample: its pages come from the same few templates (Khipu: 1,490 records).
const PER_SITEMAP = 250;
// Checking a local dev server: a template needs only a few pages, and a dev server compiles each route on first visit.
const PER_SITEMAP_LOCAL = 30;
const PAGE_BYTES = 2_000_000;

// Thresholds. Below MIN the apps show a small square thumbnail instead of the wide card; outside the ratio they crop.
export const LIMITS = { minWidth: 600, minHeight: 315, ratioLow: 1.5, ratioHigh: 2.2, heavyBytes: 1_000_000, sharedBy: 5 };

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescapeHtml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });

/** Attributes of one tag, whatever their order and quotes. */
function attributes(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = unescapeHtml(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** The tags a link preview reads. The first one of each wins, as in the apps. */
export function readTags(html, pageUrl) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property || a.name || "").toLowerCase();
    if (key && a.content != null && !(key in meta)) meta[key] = a.content.trim();
  }
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const absolute = (u) => {
    if (!u) return null;
    try {
      return new URL(u, pageUrl).href;
    } catch {
      return null;
    }
  };
  const number = (v) => (v && /^\d+$/.test(v) ? Number(v) : null);
  return {
    title: title ? unescapeHtml(title[1].trim()) : null,
    description: meta.description || null,
    ogTitle: meta["og:title"] || null,
    ogDescription: meta["og:description"] || null,
    ogImage: absolute(meta["og:image"] || meta["og:image:url"] || meta["og:image:secure_url"]),
    ogImageWidth: number(meta["og:image:width"]),
    ogImageHeight: number(meta["og:image:height"]),
    ogUrl: meta["og:url"] || null,
    twitterCard: meta["twitter:card"] || null,
    twitterImage: absolute(meta["twitter:image"] || meta["twitter:image:src"]),
  };
}

/** Width and height from the file's own header: PNG, JPEG, GIF, WebP. Null when it can't tell. */
export function imageSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const be16 = (i) => (b[i] << 8) | b[i + 1];
  const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le16 = (i) => b[i] | (b[i + 1] << 8);
  const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG") return { width: be32(16), height: be32(20) };
  if (b.length >= 10 && ascii(0, 3) === "GIF") return { width: le16(6), height: le16(8) };
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (kind === "VP8L") {
      const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { width: le24(24) + 1, height: le24(27) + 1 };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      // Start of frame (SOF0–SOF15, except DHT, JPG and DAC) carries the size
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: be16(i + 7), height: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

/** What is wrong with a page's preview: codes, the page translates them. Severity: error, warning, info. */
export function problemsOf(page, image, sharedBy) {
  const out = [];
  if (page.status !== 200) out.push({ code: "page", level: "error" });
  if (!page.tags) return out;
  const tags = page.tags;
  if (!tags.ogImage) out.push({ code: "no-image", level: "error" });
  else if (image) {
    if (image.status !== 200 || !String(image.type || "").startsWith("image/")) out.push({ code: "image-broken", level: "error" });
    else {
      const w = image.width ?? tags.ogImageWidth, h = image.height ?? tags.ogImageHeight;
      if (w && h && (w < LIMITS.minWidth || h < LIMITS.minHeight)) out.push({ code: "image-small", level: "warning" });
      else if (w && h && (w / h < LIMITS.ratioLow || w / h > LIMITS.ratioHigh)) out.push({ code: "image-ratio", level: "warning" });
      if (image.bytes > LIMITS.heavyBytes) out.push({ code: "image-heavy", level: "warning" });
    }
  }
  if (!tags.ogTitle) out.push({ code: "no-title", level: "warning" });
  if (!tags.ogDescription && !tags.description) out.push({ code: "no-description", level: "warning" });
  if (!tags.twitterCard) out.push({ code: "no-twitter", level: "info" });
  if (tags.ogImage && sharedBy >= LIMITS.sharedBy) out.push({ code: "shared-image", level: "info" });
  return out;
}

async function get(url, timeout = 15_000) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
}

/** Reads a body up to a limit, so a huge file can't fill the memory. */
async function readLimited(r, limit) {
  if (!r.body) return new Uint8Array();
  const chunks = [];
  let size = 0;
  for await (const chunk of r.body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= limit) break;
  }
  const out = new Uint8Array(Math.min(size, limit));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.length, out.length - at));
    out.set(part, at);
    at += part.length;
    if (at >= out.length) break;
  }
  return out;
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => unescapeHtml(m[1]));

/** A live address on the local dev server: speys.app/x → http://localhost:5000/x, cardgames.speys.app/x →
    http://cardgames.localhost:5000/x. Addresses of other sites stay as they are. */
export function toLocal(url, domain, local) {
  if (!local) return url;
  try {
    const u = new URL(url), base = new URL(local);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== domain && !host.endsWith(`.${domain}`)) return url;
    const sub = host === domain ? "" : host.slice(0, -domain.length - 1);
    return `${base.protocol}//${sub ? `${sub}.` : ""}${base.hostname}${base.port ? `:${base.port}` : ""}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Every n-th item, so a sample covers the whole list and not only its start. */
export function spread(list, count) {
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, i) => list[Math.floor((i * list.length) / count)]);
}

/** The page addresses in the site's sitemaps: those robots.txt lists (or /sitemap.xml) plus `extra`; indexes are
    followed, and a sitemap with more than PER_SITEMAP pages gives a spread sample of them. */
export async function sitemapPages(domain, extra = [], perSitemap = PER_SITEMAP) {
  const maps = [];
  try {
    const r = await get(`https://${domain}/robots.txt`, 10_000);
    if (r.ok) for (const m of (await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) maps.push(m[1]);
  } catch {
    // no robots.txt: the default sitemap below
  }
  if (!maps.length) maps.push(`https://${domain}/sitemap.xml`);
  const queue = [...new Set([...maps, ...extra])].map((url) => ({ url, depth: 0 }));
  const seen = new Set(), pages = new Set(), read = [];
  while (queue.length && pages.size < PAGE_LIMIT) {
    const { url, depth } = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const r = await get(url, 15_000);
      if (!r.ok) {
        read.push({ url, status: r.status, pages: 0 });
        continue;
      }
      const xml = await r.text();
      const found = locs(xml);
      if (/<sitemapindex\b/i.test(xml)) {
        if (depth < 2) queue.push(...found.map((u) => ({ url: u, depth: depth + 1 })));
        read.push({ url, status: r.status, pages: 0, index: true });
      } else {
        const sample = spread(found, perSitemap);
        for (const u of sample) if (pages.size < PAGE_LIMIT) pages.add(u);
        read.push({ url, status: r.status, pages: found.length, checked: sample.length });
      }
    } catch (e) {
      read.push({ url, status: 0, pages: 0, error: String(e.message || e).slice(0, 120) });
    }
  }
  return { pages: [...pages], sitemaps: read };
}

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await work(items[i], i);
    }
  }));
}

async function readOne(url, fetchUrl = url, timeout = 15_000) {
  try {
    const r = await get(fetchUrl, timeout);
    const type = r.headers.get("content-type") || "";
    const html = type.includes("html") ? new TextDecoder().decode(await readLimited(r, PAGE_BYTES)) : "";
    // tags are read against the live address, so a relative image resolves to the live site and maps like the page
    return { url, status: r.status, finalUrl: r.url, tags: html ? readTags(html, url) : null };
  } catch (e) {
    return { url, status: 0, error: String(e.message || e).slice(0, 120), tags: null };
  }
}

async function imageOne(url, timeout = 15_000) {
  try {
    const r = await get(url, timeout);
    const bytes = await readLimited(r, 15_000_000);
    const size = r.ok ? imageSize(bytes) : null;
    return { status: r.status, type: (r.headers.get("content-type") || "").split(";")[0].trim(), bytes: bytes.length, width: size?.width ?? null, height: size?.height ?? null };
  } catch (e) {
    return { status: 0, type: null, bytes: 0, width: null, height: null, error: String(e.message || e).slice(0, 120) };
  }
}

/** The whole check. `progress(done, total)` is called as pages come in. With `local` (a dev server address) the
    pages and their images are read from it instead: the same live addresses, mapped with toLocal. */
export async function scan({ domain, extra, local = null, progress = () => {} }) {
  const { pages: urls, sitemaps } = await sitemapPages(domain, extra, local ? PER_SITEMAP_LOCAL : PER_SITEMAP);
  const pages = new Array(urls.length);
  const timeout = local ? 90_000 : 15_000;
  let done = 0;
  progress(0, urls.length);
  await pool(urls, local ? 2 : 6, async (url, i) => {
    pages[i] = await readOne(url, toLocal(url, domain, local), timeout);
    progress(++done, urls.length);
  });
  const imageUrls = [...new Set(pages.map((p) => p.tags?.ogImage).filter(Boolean))];
  const images = {};
  await pool(imageUrls, local ? 2 : 4, async (url) => {
    images[url] = await imageOne(toLocal(url, domain, local), timeout);
  });
  const uses = new Map();
  for (const p of pages) if (p.tags?.ogImage) uses.set(p.tags.ogImage, (uses.get(p.tags.ogImage) || 0) + 1);
  for (const p of pages) {
    const img = p.tags?.ogImage;
    p.problems = problemsOf(p, img ? images[img] : null, img ? uses.get(img) - 1 : 0);
    p.sharedWith = img ? uses.get(img) - 1 : 0;
  }
  return { at: new Date().toISOString(), domain, local, sitemaps, pages, images };
}
