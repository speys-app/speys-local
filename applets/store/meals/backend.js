// Meal Planner: the week's meals and the recipes, on this computer (plan.json in this applet's folder).
// Optionally kept in step with the household's Meal Planner in a Speys account (lib/speys-applet.js, "sync" in
// applet.json); never syncs at start-up, only while the page is open.
// Dish pictures as in Speys (dishes.js): fetched from Speys the first time one is shown, then kept in this applet's
// data folder, so they show offline after that.
// What's at home comes from Finances (the receipts' lines, /a/kasa/api/evde): the page reads it, not this backend.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { handleWrite, isoDay, page, readJson, send, writeJson } from "../../../lib/common.js";
import { speysApplet } from "../../../lib/speys-applet.js";
import { readSpec } from "../../../lib/sync.js";
import { IMAGE_BASE, SLUGS, dishEmoji, dishSlug } from "./dishes.js";
import { ATLAS_BASE, PATHS, ingredientPath } from "./ingredients.js";
import { deleteMeal, deleteRecipe, emptyPlan, saveMeal, saveRecipe, weekStart, weekView } from "./model.js";

const spec = readSpec(JSON.parse(readFileSync(join(import.meta.dirname, "applet.json"), "utf8")).sync);

export default function create({ dataDir, settings, t }) {
  const file = join(dataDir, spec.file);
  const load = () => (existsSync(file) ? readJson(file) : emptyPlan());
  const save = (plan) => writeJson(file, plan);
  const speys = speysApplet({ appletId: "meals", dataDir, settings, t, spec, load, save });

  // —— pictures: the recipe's own (an address), else the catalog's (served from here), else an emoji
  const pictureOf = (title, imageUrl) => {
    if (/^https:\/\//.test(imageUrl ?? "")) return { image: imageUrl };
    const slug = dishSlug(title);
    return slug ? { image: `./api/picture/${slug}.webp` } : { emoji: dishEmoji(title) };
  };
  const withPictures = (view) => {
    const recipes = new Map(view.recipes.map((r) => [r.id, r]));
    for (const r of view.recipes) {
      Object.assign(r, pictureOf(r.title, r.imageUrl));
      // copies: the recipe's own ingredients stay as they are in the file
      r.ingredients = (r.ingredients ?? []).map((i) => { const at = ingredientPath(i.name); return at ? { ...i, image: `./api/ingredient/${at}.webp` } : i; });
    }
    for (const m of view.meals) {
      const r = recipes.get(m.recipeId);
      Object.assign(m, r ? { image: r.image, emoji: r.emoji } : pictureOf(m.title));
    }
    return view;
  };
  // A picture kept in this applet's data folder, fetched once from where it lives (one fetch at a time per picture).
  const fetching = new Map();
  async function cached(res, file, from) {
    if (!existsSync(file)) {
      if (!fetching.has(file)) {
        fetching.set(file, (async () => {
          const r = await fetch(from, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) throw new Error(String(r.status));
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        })().finally(() => fetching.delete(file)));
      }
      try { await fetching.get(file); } catch { return send(res, 404, { error: "not found" }); }
    }
    send(res, 200, readFileSync(file), "image/webp", "max-age=604800");
  }
  const picture = (res, slug) => (SLUGS.has(slug) ? cached(res, join(dataDir, "pictures", `${slug}.webp`), `${IMAGE_BASE}/${slug}.webp`) : send(res, 404, { error: "not found" }));
  const ingredient = (res, at) => (PATHS.has(at) ? cached(res, join(dataDir, "ingredients", `${at}.webp`), `${ATLAS_BASE}/${at}.webp`) : send(res, 404, { error: "not found" }));

  // —— preparing recipes together: one order for several recipes, filling one's waits with the other's work. Claude
  // writes it (it reads the recipes from /api/plan); this applet only keeps and shows it. On this computer only, not
  // synced: an order for tonight's two dishes. Keyed by the recipes' ids, sorted.
  const togetherFile = join(dataDir, "together.json");
  const loadTogether = () => (existsSync(togetherFile) ? readJson(togetherFile) : {});
  const togetherKey = (ids) => [...ids].map(String).sort().join("+");
  function saveTogether(body) {
    const plan = load();
    const known = new Set((plan.recipes ?? []).filter((x) => !x.deletedAt).map((x) => x.id));
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
    if (ids.length < 2) throw new Error("At least two recipes");
    if (ids.some((id) => !known.has(id))) throw new Error("Recipe not found");
    const steps = (Array.isArray(body.steps) ? body.steps : []).slice(0, 80).map((x) => ({
      recipeId: ids.includes(String(x?.recipeId)) ? String(x.recipeId) : null,
      text: String(x?.text ?? "").trim().slice(0, 1000),
      ...(x?.wait ? { wait: String(x.wait).trim().slice(0, 300) } : {}),
    })).filter((x) => x.text);
    if (!steps.length) throw new Error("No steps");
    const all = loadTogether();
    all[togetherKey(ids)] = { ids, steps, minutes: Number(body.minutes) || null, madeAt: new Date().toISOString() };
    writeJson(togetherFile, all);
    return true;
  }

  // —— things to buy written by hand (a product that ran out at home), beside what the planned recipes need. On this
  // computer only, not synced.
  const buyFile = join(dataDir, "buy.json");
  const loadBuy = () => (existsSync(buyFile) ? readJson(buyFile) : []);
  function addBuy(body) {
    const name = String(body.name ?? "").trim().slice(0, 120);
    if (!name) throw new Error("Title is required");
    const list = loadBuy();
    if (!list.some((x) => x.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))) list.push({ id: randomUUID(), name, addedAt: new Date().toISOString() });
    writeJson(buyFile, list);
    return true;
  }

  const write = (req, res, apply) =>
    handleWrite(req, res, (body) => {
      const plan = load();
      plan.recipes ??= [];
      plan.meals ??= [];
      try {
        apply(plan, body);
      } catch (e) {
        throw new Error(t(e.message));
      }
      save(plan);
      speys.markDirty();
      return true;
    });

  return async (req, res) => {
    const url = new URL(req.url, "http://local");
    const path = url.pathname;
    if (req.method === "GET" && path === "/") return page(res, import.meta.dirname);
    if (path.startsWith("/api/speys")) return speys.route(req, res, url);
    if (req.method === "GET" && path === "/api/plan") {
      const today = isoDay();
      const wanted = url.searchParams.get("week");
      const monday = weekStart(/^\d{4}-\d{2}-\d{2}$/.test(wanted ?? "") ? wanted : today);
      const plan = load();
      plan.recipes ??= [];
      plan.meals ??= [];
      return send(res, 200, withPictures(weekView(plan, monday, today)));
    }
    const pic = path.match(/^\/api\/picture\/([a-z0-9-]+)\.webp$/);
    if (req.method === "GET" && pic) return picture(res, pic[1]);
    const ing = path.match(/^\/api\/ingredient\/([a-z0-9-]+\/[a-z0-9-]+)\.webp$/);
    if (req.method === "GET" && ing) return ingredient(res, ing[1]);
    if (req.method === "GET" && path === "/api/together") return send(res, 200, Object.values(loadTogether()));
    if (req.method === "POST" && path === "/api/together") {
      return handleWrite(req, res, (b) => { try { return saveTogether(b); } catch (e) { throw new Error(t(e.message)); } });
    }
    if (req.method === "POST" && path === "/api/together/sil") {
      return handleWrite(req, res, (b) => { const all = loadTogether(); delete all[togetherKey(b.ids ?? [])]; writeJson(togetherFile, all); return true; });
    }
    if (req.method === "GET" && path === "/api/alinacak") return send(res, 200, loadBuy());
    if (req.method === "POST" && path === "/api/alinacak") {
      return handleWrite(req, res, (b) => { try { return addBuy(b); } catch (e) { throw new Error(t(e.message)); } });
    }
    if (req.method === "POST" && path === "/api/alinacak/sil") {
      return handleWrite(req, res, (b) => { writeJson(buyFile, loadBuy().filter((x) => x.id !== b.id)); return true; });
    }
    if (req.method === "POST" && path === "/api/tarif") return write(req, res, (p, b) => saveRecipe(p, b));
    if (req.method === "POST" && path === "/api/tarif/sil") return write(req, res, (p, b) => deleteRecipe(p, b.id));
    if (req.method === "POST" && path === "/api/ogun") return write(req, res, (p, b) => saveMeal(p, b));
    if (req.method === "POST" && path === "/api/ogun/sil") return write(req, res, (p, b) => deleteMeal(p, b.id));
    send(res, 404, { error: "not found" });
  };
}
