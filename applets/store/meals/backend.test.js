import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import create from "./backend.js";

test("plan a week: a recipe, a meal from it, the ingredients; nothing goes anywhere without Speys", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "meals-"));
  const handler = create({ dataDir, settings: () => ({}), t: (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => v?.[k] ?? "") });
  const server = createServer((req, res) => handler(req, res));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "x-panel": "1" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/api/tarif", { title: "Menemen", ingredients: [{ name: "Yumurta", amount: "2", unit: "adet" }], instructions: ["Kır", "Pişir"] })).status, 200);
    let week = await (await fetch(`${base}/api/plan?week=2026-11-11`)).json();
    assert.equal(week.monday, "2026-11-09");
    const recipe = week.recipes[0];
    assert.equal((await post("/api/ogun", { day: "2026-11-10", mealType: "breakfast", recipeId: recipe.id })).status, 200);
    assert.equal((await post("/api/ogun", { day: "2026-11-11", mealType: "breakfast", recipeId: recipe.id })).status, 200);
    week = await (await fetch(`${base}/api/plan?week=2026-11-09`)).json();
    assert.deepEqual(week.meals.map((m) => [m.day, m.title]), [["2026-11-10", "Menemen"], ["2026-11-11", "Menemen"]]);
    assert.equal(week.shopping[0].amount, 4);
    assert.equal((await post("/api/ogun", { day: "2026-11-10", recipeId: "nope" })).status, 400);
    assert.equal((await fetch(`${base}/api/tarif`, { method: "POST", body: "{}" })).status, 403, "only the page may write");

    const status = await (await fetch(`${base}/api/speys`)).json();
    assert.equal(status.connected, false);
    assert.equal((await (await post("/api/speys/sync", {})).json()).report, null);
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
