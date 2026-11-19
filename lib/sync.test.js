import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { accept, duplicates, merge3, plan, readSpec, resolve, stableId, toLocal, toRemote } from "./sync.js";

const now = new Date("2026-11-09T10:00:00Z");
const entry = (id, fields = {}) => ({ id, direction: "out", title: "Hosting", amount: 100, entryDate: "2026-11-01", updatedAt: "2026-11-01T00:00:00Z", ...fields });

test("stableId is a UUID, the same for the same parts and different for others", () => {
  const a = stableId("rule-1", "2026-11-01");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, stableId("rule-1", "2026-11-01"));
  assert.notEqual(a, stableId("rule-1", "2026-12-01"));
  assert.notEqual(stableId("a", "bc"), stableId("ab", "c"));
});

test("readSpec takes the short form, rejects paths outside the data folder and newer versions", () => {
  const spec = readSpec({ file: "defter.json", collections: { entries: "kasa.entries", rules: { remote: "kasa.recurring", map: { kdv: "vatRate" }, tombstones: false } } });
  assert.deepEqual(spec.collections.entries, { remote: "kasa.entries", map: {}, own: [], tombstones: true });
  assert.deepEqual(spec.collections.rules, { remote: "kasa.recurring", map: { kdv: "vatRate" }, own: [], tombstones: false });
  assert.equal(readSpec(undefined), null);
  assert.throws(() => readSpec({ file: "../x.json", collections: { a: "b" } }));
  assert.throws(() => readSpec({ file: "/etc/x.json", collections: { a: "b" } }));
  assert.throws(() => readSpec({ file: "x.json", collections: {} }));
  assert.throws(() => readSpec({ version: 99, file: "x.json", collections: { a: "b" } }));
  assert.throws(() => readSpec({ file: "x.json", collections: { a: { remote: "b", map: { id: "uuid" } } } }));
});

test("a renamed field goes to Speys under Speys's name and comes back under the applet's", () => {
  const map = { kdv: "vatRate" };
  const remote = toRemote({ id: "1", kdv: 20, proje: "Site" }, map);
  assert.deepEqual(remote, { id: "1", vatRate: 20, proje: "Site" });
  assert.deepEqual(toLocal(remote, map), { id: "1", kdv: 20, proje: "Site" });
});

test("merge3: a field changed on one side wins; both sides' changes are kept", () => {
  const base = entry("1");
  const { merged, conflicts } = merge3(base, { ...base, amount: 120 }, { ...base, vatRate: 20 });
  assert.deepEqual(conflicts, []);
  assert.equal(merged.amount, 120);
  assert.equal(merged.vatRate, 20);
});

test("merge3: the same field changed differently on both sides is a conflict, not a silent pick", () => {
  const base = entry("1");
  const { conflicts } = merge3(base, { ...base, amount: 120 }, { ...base, amount: 130 });
  assert.deepEqual(conflicts, [{ field: "amount", base: 100, local: 120, remote: 130 }]);
});

test("merge3: the same change on both sides is not a conflict", () => {
  const base = entry("1");
  assert.deepEqual(merge3(base, { ...base, amount: 120 }, { ...base, amount: 120 }).conflicts, []);
});

test("merge3: a field the applet doesn't know isn't deleted by it", () => {
  const base = entry("1", { vatRate: 20, withholding: 5 });
  // a customised applet that rewrites records with only the fields it knows
  const local = { id: "1", direction: "out", title: "Hosting renewal", amount: 100, entryDate: "2026-11-01" };
  const { merged, conflicts } = merge3(base, local, base);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.vatRate, 20);
  assert.equal(merged.withholding, 5);
  assert.equal(merged.title, "Hosting renewal");
});

test("merge3: null clears a field", () => {
  const base = entry("1", { note: "old" });
  assert.equal(merge3(base, { ...base, note: null }, base).merged.note, null);
});

test("merge3: deleted on one side and edited on the other is asked", () => {
  const base = entry("1");
  const { conflicts } = merge3(base, { ...base, deletedAt: "2026-11-05T00:00:00Z" }, { ...base, amount: 130 });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, "deletedAt");
  // deleted here and untouched there: just deleted
  assert.deepEqual(merge3(base, { ...base, deletedAt: "2026-11-05T00:00:00Z" }, base).conflicts, []);
});

test("plan: new here is sent, new on Speys is written, unchanged is left alone", () => {
  const b = entry("b");
  const out = plan({ local: [entry("a"), b], base: { b }, remote: [entry("c")], now });
  assert.deepEqual(out.push.map((r) => r.id), ["a"]);
  assert.deepEqual(out.local.map((r) => r.id), ["a", "b", "c"]);
  assert.ok(out.base.c);
  assert.equal(out.base.a, undefined, "a's base waits for Speys to accept it");
});

test("plan: a sent record carries the version of the Speys copy it was merged with", () => {
  const b = entry("1", { version: 7 });
  const out = plan({ local: [{ ...b, amount: 150 }], base: { "1": b }, now });
  assert.equal(out.push[0].amount, 150);
  assert.equal(out.push[0].version, 7);
});

test("plan: a record that left the file is sent as deleted and isn't written back", () => {
  const b = entry("1");
  const out = plan({ local: [], base: { "1": b }, now });
  assert.equal(out.push[0].deletedAt, now.toISOString());
  assert.deepEqual(out.local, []);
});

test("plan: a deletion from Speys stays in the file as a mark, or leaves it when the applet keeps no marks", () => {
  const b = entry("1");
  const gone = { ...b, deletedAt: "2026-11-08T00:00:00Z", version: 2 };
  assert.equal(plan({ local: [b], base: { "1": b }, remote: [gone], now }).local[0].deletedAt, gone.deletedAt);
  assert.deepEqual(plan({ local: [b], base: { "1": b }, remote: [gone], now, tombstones: false }).local, []);
});

test("plan: both sides edited different fields: merged, written and sent", () => {
  const b = entry("1", { version: 3 });
  const out = plan({ local: [{ ...b, title: "Server" }], base: { "1": b }, remote: [{ ...b, vatRate: 20, version: 4 }], now });
  assert.equal(out.local[0].title, "Server");
  assert.equal(out.local[0].vatRate, 20);
  assert.equal(out.push[0].version, 4);
});

test("plan: a conflict keeps the file as it is and isn't sent until answered", () => {
  const b = entry("1", { version: 1 });
  const remote = { ...b, amount: 130, version: 2 };
  const first = plan({ local: [{ ...b, amount: 120 }], base: { "1": b }, remote: [remote], now });
  assert.equal(first.conflicts.length, 1);
  assert.deepEqual(first.push, []);
  assert.equal(first.local[0].amount, 120);

  // next run: nothing new from Speys; the unanswered conflict must not be sent as the local value
  const second = plan({ local: first.local, base: first.base, remote: [], open: first.conflicts, now });
  assert.deepEqual(second.push, []);
  assert.equal(second.conflicts.length, 1);
});

test("plan: a conflict closes by itself when the user makes the file match Speys", () => {
  const b = entry("1", { version: 1 });
  const remote = { ...b, amount: 130, version: 2 };
  const first = plan({ local: [{ ...b, amount: 120 }], base: { "1": b }, remote: [remote], now });
  const second = plan({ local: [{ ...b, amount: 130 }], base: first.base, open: first.conflicts, now });
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(second.push, []);
  assert.equal(second.base["1"].version, 2);
});

test("resolve: the chosen side per field, other changes from both sides kept, then sent", () => {
  const b = entry("1", { version: 1 });
  const local = { ...b, amount: 120, title: "Server" };
  const remote = { ...b, amount: 130, vatRate: 20, version: 2 };
  const [conflict] = plan({ local: [local], base: { "1": b }, remote: [remote], now }).conflicts;
  const record = resolve(conflict, { amount: "remote" }, now);
  assert.equal(record.amount, 130);
  assert.equal(record.title, "Server");
  assert.equal(record.vatRate, 20);

  const next = plan({ local: [record], base: { "1": conflict.remote }, now });
  assert.deepEqual(next.conflicts, []);
  assert.equal(next.push.length, 1);
  assert.equal(next.push[0].version, 2);
});

test("resolve: keeping a record Speys deleted brings it back", () => {
  const b = entry("1");
  const [conflict] = plan({ local: [{ ...b, amount: 120 }], base: { "1": b }, remote: [{ ...b, deletedAt: "2026-11-08T00:00:00Z" }], now }).conflicts;
  assert.equal(resolve(conflict, { deletedAt: "local" }, now).deletedAt, undefined);
  assert.ok(resolve(conflict, { deletedAt: "remote" }, now).deletedAt);
});

test("plan: the same repeat created on both sides with stableId is one record", () => {
  const id = stableId("rule-1", "2026-11-01");
  const out = plan({ local: [entry(id, { recurringId: "rule-1" })], remote: [entry(id, { recurringId: "rule-1", version: 1 })], now });
  assert.equal(out.local.length, 1);
  assert.deepEqual(out.push, []);
  assert.deepEqual(out.conflicts, []);
});

test("accept: what Speys stored becomes the base, and the next run sends nothing", () => {
  const out = plan({ local: [entry("a")], now });
  const base = accept(out.base, [{ ...out.push[0], version: 1 }]);
  assert.deepEqual(plan({ local: out.local, base, now }).push, []);
});

test("duplicates: same amount and direction, close dates, alike titles", () => {
  const records = [
    entry("1", { title: "Vercel Pro", entryDate: "2026-11-01" }),
    entry("2", { title: "vercel pro subscription", entryDate: "2026-11-03" }),
    entry("3", { title: "Vercel Pro", entryDate: "2026-11-20" }), // too far
    entry("4", { title: "Vercel Pro", amount: 90, entryDate: "2026-11-01" }), // other amount
    entry("5", { title: "Vercel Pro", entryDate: "2026-11-02", deletedAt: "x" }), // deleted
  ];
  const opts = { same: ["direction", "amount"], date: "entryDate", text: ["title", "counterparty"] };
  const pairs = duplicates(records, opts);
  assert.deepEqual(pairs.map((p) => p.key), ["1|2"]);
  assert.deepEqual(duplicates(records, { ...opts, dismissed: ["1|2"] }), []);
});

test("duplicates: two empty titles don't make a pair", () => {
  const records = [entry("1", { title: "" }), entry("2", { title: "" })];
  assert.deepEqual(duplicates(records, { same: ["amount"], date: "entryDate", text: ["title"] }), []);
});

test("stableId matches the value Speys computes in SQL", () => {
  // SELECT kasa.stable_id(ARRAY['rule-1', '2026-11-01']); the same bytes: sha256 of "speys-sync\x1frule-1\x1f2026-11-01"
  const h = createHash("sha256").update("speys-sync\x1frule-1\x1f2026-11-01").digest("hex");
  const id = stableId("rule-1", "2026-11-01").replaceAll("-", "");
  assert.equal(id.slice(0, 12), h.slice(0, 12));
  assert.equal(id[12], "8");
  assert.equal(id.slice(13, 16), h.slice(13, 16));
  assert.equal(id.slice(18), h.slice(18, 32));
});

test("plan: a copy's own fields stay in the file, aren't sent and don't conflict", () => {
  const b = { id: "r", title: "Rent", amount: 10, version: 1 };
  const local = { ...b, lastGenerated: "2026-11-09" };
  delete local.version;
  const out = plan({ local: [local], base: { r: b }, remote: [{ ...b, lastGenerated: "2026-11-08", version: 2 }], own: ["lastGenerated"], now });
  assert.deepEqual(out.push, []);
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.local[0].lastGenerated, "2026-11-09");
});

test("plan: createdAt differing on the two sides isn't a conflict, and the file keeps its own", () => {
  const id = stableId("rule-1", "2026-11-01");
  const out = plan({
    local: [entry(id, { createdAt: "2026-11-01T08:00:00Z" })],
    remote: [entry(id, { createdAt: "2026-11-01T09:30:00Z", version: 5 })],
    now,
  });
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.local[0].createdAt, "2026-11-01T08:00:00Z");
  assert.equal(out.local[0].version, undefined, "Speys's version number doesn't go into the file");
});
