import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteMeal, deleteRecipe, emptyPlan, saveMeal, saveRecipe, shoppingList, weekStart, weekView } from "./model.js";

const soup = (p) => saveRecipe(p, {
  title: "Mercimek çorbası", category: "Çorba",
  ingredients: [{ name: "Mercimek", amount: "1", unit: "su bardağı" }, { name: "Tuz", amount: "bir tutam" }, { name: "  " }],
  instructions: ["Yıka", { text: "Kaynat" }, ""],
});

test("a recipe keeps named ingredients and numbers its steps", () => {
  const p = emptyPlan();
  const r = soup(p);
  assert.deepEqual(r.ingredients, [{ name: "Mercimek", amount: "1", unit: "su bardağı" }, { name: "Tuz", amount: "bir tutam" }]);
  assert.deepEqual(r.instructions, [{ step: 1, text: "Yıka" }, { step: 2, text: "Kaynat" }]);
  assert.throws(() => saveRecipe(p, { title: " " }), /Title/);
});

test("editing changes only what is sent: a photo from Speys stays", () => {
  const p = emptyPlan();
  const r = soup(p);
  r.imageUrl = "https://example.com/soup.jpg";
  saveRecipe(p, { id: r.id, title: "Ezogelin" });
  assert.equal(p.recipes[0].imageUrl, "https://example.com/soup.jpg");
  assert.equal(p.recipes[0].ingredients.length, 2);
});

test("a meal from a recipe takes its title; a meal can also be just a name", () => {
  const p = emptyPlan();
  const r = soup(p);
  const m = saveMeal(p, { day: "2026-11-10", mealType: "dinner", recipeId: r.id });
  assert.equal(m.title, "Mercimek çorbası");
  const other = saveMeal(p, { day: "2026-11-10", mealType: "lunch", title: "Dışarıda" });
  assert.equal(other.recipeId, null);
  assert.equal(other.sortOrder, 1);
  assert.throws(() => saveMeal(p, { day: "2026-02-30", title: "x" }), /date/);
  assert.throws(() => saveMeal(p, { day: "2026-11-10", recipeId: "nope" }), /Recipe/);
  assert.throws(() => saveMeal(p, { day: "2026-11-10" }), /Title/);
  // moving a meal to another day keeps the rest
  saveMeal(p, { id: m.id, day: "2026-11-11" });
  assert.equal(p.meals[0].recipeId, r.id);
});

test("deleting a recipe keeps its planned meals, without the link (as in Speys)", () => {
  const p = emptyPlan();
  const r = soup(p);
  const m = saveMeal(p, { day: "2026-11-10", recipeId: r.id });
  deleteRecipe(p, r.id);
  assert.ok(p.recipes[0].deletedAt);
  assert.equal(p.meals[0].recipeId, null);
  assert.equal(p.meals[0].title, "Mercimek çorbası");
  deleteMeal(p, m.id);
  assert.ok(p.meals[0].deletedAt);
});

test("the week runs from Monday; the shopping list adds up the same ingredient in the same unit", () => {
  assert.equal(weekStart("2026-11-09"), "2026-11-09"); // a Monday
  assert.equal(weekStart("2026-11-15"), "2026-11-09"); // its Sunday
  const p = emptyPlan();
  const r = soup(p);
  saveMeal(p, { day: "2026-11-10", recipeId: r.id });
  saveMeal(p, { day: "2026-11-12", recipeId: r.id });
  saveMeal(p, { day: "2026-11-20", recipeId: r.id }); // next week
  const list = shoppingList(p, "2026-11-09", "2026-11-15");
  assert.deepEqual(list.find((l) => l.name === "Mercimek"), { name: "Mercimek", unit: "su bardağı", amount: 2, other: [], meals: ["Mercimek çorbası"] });
  assert.deepEqual(list.find((l) => l.name === "Tuz").other, ["bir tutam", "bir tutam"]);
  const w = weekView(p, "2026-11-09", "2026-11-09");
  assert.equal(w.days.length, 7);
  assert.equal(w.meals.length, 2);
});
