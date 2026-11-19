// Meal Planner's data: recipes and the meals planned on days. The same shape as Speys's Meal Planner, so the two stay in
// step when the account is connected (applet.json "sync"): every record has a permanent `id` and an `updatedAt`, a
// deleted one keeps `deletedAt`. Pure functions; backend.js reads and writes the file.
// Validation messages are English and double as translation keys.
import { randomUUID } from "node:crypto";

export const MEAL_TYPES = ["breakfast", "lunch", "dinner"];
export const emptyPlan = () => ({ version: 1, recipes: [], meals: [] });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const alive = (x) => !x.deletedAt;
const stamp = (now) => now.toISOString();
const text = (v, max = 200) => String(v ?? "").trim().slice(0, max);

function validDate(value) {
  const d = new Date(`${value}T00:00:00Z`);
  if (!DATE.test(value ?? "") || Number.isNaN(d) || d.toISOString().slice(0, 10) !== value) throw new Error("Invalid date");
  return value;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week a day is in. */
export function weekStart(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

function upsert(list, id, fields, now) {
  const found = id ? list.find((x) => x.id === id && alive(x)) : null;
  if (id && !found) throw new Error("Not found");
  if (found) return Object.assign(found, fields, { updatedAt: stamp(now) });
  const created = { id: randomUUID(), ...fields, createdAt: stamp(now), updatedAt: stamp(now) };
  list.push(created);
  return created;
}

const ingredientsOf = (list) => (Array.isArray(list) ? list : [])
  .map((i) => ({ name: text(i?.name, 120), amount: text(i?.amount, 30), unit: text(i?.unit, 30) }))
  .filter((i) => i.name)
  .map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== "")));

const stepsOf = (list) => (Array.isArray(list) ? list : [])
  .map((s) => text(typeof s === "string" ? s : s?.text, 1000))
  .filter(Boolean)
  .map((t, i) => ({ step: i + 1, text: t }));

/**
 * A recipe: title, category (free text, as in Speys: "Çorba", "Ana Yemek"), ingredients { name, amount, unit } and
 * numbered steps. Only the fields sent change: a field Speys has and this page doesn't (a photo) stays.
 */
export function saveRecipe(plan, input, now = new Date()) {
  const title = text(input.title);
  if (!title) throw new Error("Title is required");
  const fields = { title };
  if (Object.hasOwn(input, "category")) fields.category = text(input.category, 60) || null;
  if (Object.hasOwn(input, "ingredients")) fields.ingredients = ingredientsOf(input.ingredients);
  if (Object.hasOwn(input, "instructions")) fields.instructions = stepsOf(input.instructions);
  if (!input.id) {
    fields.ingredients ??= [];
    fields.instructions ??= [];
  }
  return upsert(plan.recipes, input.id, fields, now);
}

/** As in Speys: a planned meal stays when its recipe goes, without the link. */
export function deleteRecipe(plan, id, now = new Date()) {
  const r = plan.recipes.find((x) => x.id === id && alive(x));
  if (!r) throw new Error("Not found");
  Object.assign(r, { deletedAt: stamp(now), updatedAt: stamp(now) });
  for (const m of plan.meals) if (alive(m) && m.recipeId === id) Object.assign(m, { recipeId: null, updatedAt: stamp(now) });
}

/** A meal on a day: from a recipe (its title comes along) or just a name. */
export function saveMeal(plan, input, now = new Date()) {
  const existing = input.id ? plan.meals.find((x) => x.id === input.id && alive(x)) : null;
  const fields = {};
  if (!existing || Object.hasOwn(input, "day")) fields.day = validDate(input.day);
  if (!existing || Object.hasOwn(input, "mealType")) fields.mealType = MEAL_TYPES.includes(input.mealType) ? input.mealType : "dinner";
  if (!existing || Object.hasOwn(input, "recipeId")) {
    const recipeId = input.recipeId || null;
    if (recipeId && !plan.recipes.some((r) => r.id === recipeId && alive(r))) throw new Error("Recipe not found");
    fields.recipeId = recipeId;
  }
  const recipe = plan.recipes.find((r) => r.id === (fields.recipeId ?? existing?.recipeId));
  if (!existing || Object.hasOwn(input, "title") || fields.recipeId) fields.title = text(input.title) || recipe?.title || "";
  if (!(fields.title ?? existing?.title)) throw new Error("Title is required");
  if (!existing) {
    const day = fields.day;
    fields.sortOrder = Math.max(-1, ...plan.meals.filter((m) => alive(m) && m.day === day).map((m) => m.sortOrder ?? 0)) + 1;
  }
  return upsert(plan.meals, input.id, fields, now);
}

export function deleteMeal(plan, id, now = new Date()) {
  const m = plan.meals.find((x) => x.id === id && alive(x));
  if (!m) throw new Error("Not found");
  Object.assign(m, { deletedAt: stamp(now), updatedAt: stamp(now) });
}

/** "1,5" or "1.5" or "2" → a number; "bir tutam" → null (it's listed as it is). */
const amountNumber = (a) => {
  const n = Number(String(a ?? "").replace(",", "."));
  return a !== undefined && a !== "" && Number.isFinite(n) ? n : null;
};

/**
 * What the week's planned recipes need, added up: the same ingredient in the same unit is one line; an amount that
 * isn't a number ("bir tutam") is kept beside it. A meal planned without a recipe needs nothing here.
 */
export function shoppingList(plan, from, to) {
  const recipes = new Map(plan.recipes.filter(alive).map((r) => [r.id, r]));
  const lines = new Map();
  for (const m of plan.meals) {
    if (!alive(m) || m.day < from || m.day > to || !recipes.has(m.recipeId)) continue;
    for (const i of recipes.get(m.recipeId).ingredients ?? []) {
      const key = `${i.name.toLocaleLowerCase("tr")}|${(i.unit ?? "").toLocaleLowerCase("tr")}`;
      const line = lines.get(key) ?? { name: i.name, unit: i.unit ?? "", total: 0, other: [], meals: new Set() };
      const n = amountNumber(i.amount);
      if (n === null) { if (i.amount) line.other.push(i.amount); } else line.total += n;
      line.meals.add(m.title);
      lines.set(key, line);
    }
  }
  return [...lines.values()]
    .map((l) => ({ name: l.name, unit: l.unit, amount: Math.round(l.total * 100) / 100 || null, other: l.other, meals: [...l.meals] }))
    .sort((a, b) => a.name.localeCompare(b.name, "tr"));
}

/** The week from its Monday: each day with its meals by type, the recipes, and what to buy. */
export function weekView(plan, monday, today) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const meals = plan.meals.filter((m) => alive(m) && m.day >= days[0] && m.day <= days[6])
    .sort((a, b) => a.day.localeCompare(b.day) || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  return {
    monday, today, days,
    meals,
    recipes: plan.recipes.filter(alive).sort((a, b) => a.title.localeCompare(b.title, "tr")),
    shopping: shoppingList(plan, days[0], days[6]),
  };
}
