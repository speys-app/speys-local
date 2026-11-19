import assert from "node:assert/strict";
import { test } from "node:test";
import { emptySyncState, runSync } from "./speys-sync.js";
import { readSpec, resolve } from "./sync.js";

// A stand-in for Speys's sync endpoints with the same rules (backend/kasa/migrations/functions.up.sql → sync_pull,
// sync_push): a version number per change, deletions kept apart, "stale" when the sender's version is old, fields not
// sent stay, the copy's own fields (last_generated) aren't stored.
function fakeSpeys() {
  let seq = 0;
  const rows = { entries: new Map(), recurring: new Map() };
  const deletions = [];
  const calls = [];
  return {
    rows,
    calls,
    edit(kind, id, fields) {
      Object.assign(rows[kind].get(id), fields, { version: ++seq });
    },
    async call(path, body) {
      calls.push(path);
      const op = path.split("/").pop();
      if (op === "pull") {
        const changes = [];
        for (const kind of ["entries", "recurring"]) {
          for (const r of rows[kind].values()) if (r.version > body.since) changes.push({ kind, record: structuredClone(r) });
        }
        for (const d of deletions) if (d.version > body.since) changes.push({ kind: d.kind, record: { id: d.id, deletedAt: d.at, version: d.version } });
        changes.sort((a, b) => a.record.version - b.record.version);
        return { version: changes.at(-1)?.record.version ?? body.since, more: false, changes };
      }
      const accepted = [], rejected = [];
      for (const rec of body.records) {
        const table = rows[body.kind];
        const cur = table.get(rec.id);
        const gone = deletions.findLast((d) => d.kind === body.kind && d.id === rec.id);
        if (cur && rec.version !== cur.version) { rejected.push({ id: rec.id, reason: "stale", current: structuredClone(cur) }); continue; }
        if (!cur && (rec.version != null || gone) && !rec.deletedAt) {
          rejected.push({ id: rec.id, reason: "stale", current: gone ? { id: rec.id, deletedAt: gone.at, version: gone.version } : null });
          continue;
        }
        if (rec.deletedAt) {
          if (cur) { table.delete(rec.id); deletions.push({ kind: body.kind, id: rec.id, at: rec.deletedAt, version: ++seq }); }
          accepted.push({ id: rec.id, deletedAt: rec.deletedAt, version: seq });
          continue;
        }
        if (!String(rec.title ?? cur?.title ?? "").trim()) { rejected.push({ id: rec.id, reason: "title required" }); continue; }
        const { version, updatedAt, lastGenerated, createdAt, ...fields } = rec;
        const stored = { ...(cur ?? { createdAt: "server" }), ...fields, version: ++seq, updatedAt: `v${seq}` };
        table.set(rec.id, stored);
        accepted.push(structuredClone(stored));
      }
      return { accepted, rejected };
    },
  };
}

const spec = readSpec({
  file: "defter.json",
  collections: { rules: { remote: "kasa.recurring", own: ["lastGenerated"] }, entries: "kasa.entries" },
});

/** A computer: its ledger file and its sync state. */
function computer(speys) {
  const self = {
    data: { entries: [], rules: [] },
    state: emptySyncState(),
    sync: () => runSync({
      spec, call: speys.call, scope: { businessId: "b1" }, state: self.state,
      load: () => structuredClone(self.data), save: (d) => { self.data = d; },
    }),
    entry: (id) => self.data.entries.find((e) => e.id === id),
  };
  return self;
}

const entry = (id, fields = {}) => ({ id, direction: "out", title: "Hosting", amount: 100, entryDate: "2026-11-01", updatedAt: "2026-11-01T00:00:00Z", ...fields });

test("what one computer writes reaches the other through Speys", async () => {
  const speys = fakeSpeys(), a = computer(speys), b = computer(speys);
  a.data.entries.push(entry("e1"));
  const first = await a.sync();
  assert.equal(first.pushed, 1);
  await b.sync();
  assert.equal(b.entry("e1").amount, 100);
  assert.equal(b.entry("e1").version, undefined, "Speys's version stays out of the file");
});

test("a second sync with nothing new sends nothing", async () => {
  const speys = fakeSpeys(), a = computer(speys);
  a.data.entries.push(entry("e1"));
  await a.sync();
  const again = await a.sync();
  assert.equal(again.pushed, 0);
});

test("different fields changed on two computers both survive", async () => {
  const speys = fakeSpeys(), a = computer(speys), b = computer(speys);
  a.data.entries.push(entry("e1"));
  await a.sync();
  await b.sync();
  a.entry("e1").amount = 150;
  b.entry("e1").vatRate = 20;
  await a.sync();
  await b.sync(); // b's base is old: Speys says stale, b merges and sends again
  await a.sync();
  for (const c of [a, b]) {
    assert.equal(c.entry("e1").amount, 150);
    assert.equal(c.entry("e1").vatRate, 20);
  }
  assert.equal(speys.rows.entries.get("e1").vatRate, 20);
});

test("Speys's change to a field the computer doesn't touch arrives, the computer's change goes", async () => {
  const speys = fakeSpeys(), a = computer(speys);
  a.data.entries.push(entry("e1"));
  await a.sync();
  speys.edit("entries", "e1", { invoiceNo: "A-1" }); // the accountant, in Speys
  a.entry("e1").title = "Hosting (yearly)";
  await a.sync();
  assert.equal(a.entry("e1").invoiceNo, "A-1");
  assert.equal(speys.rows.entries.get("e1").title, "Hosting (yearly)");
  assert.equal(speys.rows.entries.get("e1").invoiceNo, "A-1");
});

test("the same field changed differently is a conflict until answered, then both sides agree", async () => {
  const speys = fakeSpeys(), a = computer(speys);
  a.data.entries.push(entry("e1"));
  await a.sync();
  speys.edit("entries", "e1", { amount: 130 });
  a.entry("e1").amount = 120;
  const res = await a.sync();
  assert.equal(res.conflicts, 1);
  assert.equal(speys.rows.entries.get("e1").amount, 130, "nothing is overwritten while it's asked");
  assert.equal(a.entry("e1").amount, 120);
  assert.equal((await a.sync()).conflicts, 1, "still asked on the next sync");

  // the user picks Speys's amount
  const [conflict] = a.state.open.entries;
  const chosen = resolve(conflict, { amount: "remote" });
  a.data.entries = a.data.entries.map((e) => (e.id === "e1" ? chosen : e));
  a.state.base.entries.e1 = conflict.remote;
  a.state.open.entries = [];
  const after = await a.sync();
  assert.equal(after.conflicts, 0);
  assert.equal(a.entry("e1").amount, 130);
  assert.equal(speys.rows.entries.get("e1").amount, 130);
});

test("a deletion on one computer removes the record on the other", async () => {
  const speys = fakeSpeys(), a = computer(speys), b = computer(speys);
  a.data.entries.push(entry("e1"));
  await a.sync();
  await b.sync();
  a.entry("e1").deletedAt = "2026-11-09T10:00:00Z";
  await a.sync();
  assert.equal(speys.rows.entries.has("e1"), false);
  await b.sync();
  assert.ok(b.entry("e1").deletedAt);
});

test("a record removed from the file by a copied applet that deletes for real is deleted on Speys too", async () => {
  const speys = fakeSpeys(), a = computer(speys);
  a.data.entries.push(entry("e1"), entry("e2"));
  await a.sync();
  a.data.entries = a.data.entries.filter((e) => e.id !== "e1");
  await a.sync();
  assert.equal(speys.rows.entries.has("e1"), false);
  assert.equal(a.entry("e1"), undefined, "not written back into the file");
});

test("a rule's own progress stays on each computer and doesn't bounce back and forth", async () => {
  const speys = fakeSpeys(), a = computer(speys), b = computer(speys);
  a.data.rules.push({ id: "r1", direction: "out", title: "Rent", amount: 10, cycle: "monthly", dayOfMonth: 1, lastGenerated: "2026-11-09" });
  await a.sync();
  await b.sync();
  assert.equal(b.data.rules[0].lastGenerated, undefined);
  b.data.rules[0].lastGenerated = "2026-11-08";
  assert.equal((await b.sync()).pushed, 0);
  assert.equal((await a.sync()).pushed, 0);
  assert.equal(a.data.rules[0].lastGenerated, "2026-11-09");
  // rules go before entries: an entry made from a rule never reaches Speys before its rule
  const order = speys.calls.filter((p) => p.endsWith("push"));
  assert.ok(order.length >= 1);
});

test("a record Speys refuses is listed with the reason; the others go", async () => {
  const speys = fakeSpeys(), a = computer(speys);
  a.data.entries.push(entry("bad", { title: "" }), entry("good"));
  const res = await a.sync();
  assert.deepEqual(res.failed.map((f) => [f.id, f.reason]), [["bad", "title required"]]);
  assert.ok(speys.rows.entries.has("good"));
  assert.equal(a.state.failed.length, 1);
});

test("losing the sync state is safe: syncing from zero changes nothing", async () => {
  const speys = fakeSpeys(), a = computer(speys);
  a.data.entries.push(entry("e1", { vatRate: 20 }));
  await a.sync();
  a.state = emptySyncState();
  const res = await a.sync();
  assert.equal(res.conflicts, 0);
  assert.equal(a.data.entries.length, 1);
  assert.equal(speys.rows.entries.get("e1").vatRate, 20);
});
