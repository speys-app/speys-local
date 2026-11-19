import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteAccount, deleteList, deleteTransaction, emptyBook, importRows, materializeSubscriptions, saveAccount, saveList, saveSubscription, saveTransaction } from "./personal.js";
import { allTransactions, balances, guessCategory, holdings, monthView, nextRenewal, parseAmountText, parseStatement, settlements } from "./personal-view.js";

test("statement lines: date, title, amount; payments listed but not ticked", () => {
  const rows = parseStatement("03.10.2026  MIGROS KADIKÖY  245,90 TL\n5 Eki 2026 ECZANE  1.250,00\nKART ÖDEMESİ 10.10.2026 500\n09.10.2026 IADE STEAM -120,00\nboş satır", new Date(2026, 10, 11));
  assert.deepEqual(rows.map((r) => [r.date, r.title, r.amount, r.category, r.include]), [
    ["2026-10-03", "MIGROS KADIKÖY", 245.9, "market", true],
    ["2026-10-05", "ECZANE", 1250, "health", true],
    ["2026-11-11", "KART ÖDEMESİ 10.10.2026", 500, "other", false],
    ["2026-10-09", "IADE STEAM", 120, "fun", false],
  ]);
  assert.equal(parseAmountText("1,250.00"), 1250);
  assert.equal(parseAmountText("1.250"), 1250);
  assert.equal(guessCategory("İTÜ 1773"), "cafe");
});

test("a transaction needs a title, a date and an amount; an account must exist", () => {
  const b = emptyBook();
  assert.throws(() => saveTransaction(b, { title: " ", date: "2026-11-01", amount: 5 }), /Title/);
  assert.throws(() => saveTransaction(b, { title: "Çay", date: "2026-02-31", amount: 5 }), /date/);
  assert.throws(() => saveTransaction(b, { title: "Çay", date: "2026-11-01", amount: 0 }), /Amount/);
  assert.throws(() => saveTransaction(b, { title: "Çay", date: "2026-11-01", amount: 5, accountId: "yok" }), /Account/);
  assert.throws(() => saveTransaction(b, { kind: "investment", date: "2026-11-01", amount: 5 }), /Title|Asset/);
  const card = saveAccount(b, { name: "Kart ••9754", kind: "card" });
  const x = saveTransaction(b, { title: "Çay", date: "2026-11-01", amount: "36", category: "food", accountId: card.id });
  saveTransaction(b, { id: x.id, title: "Çay ve simit", date: "2026-11-01", amount: 48, category: "food", accountId: card.id });
  assert.equal(b.transactions.length, 1);
  assert.equal(b.transactions[0].amount, 48);
  deleteAccount(b, card.id);
  deleteTransaction(b, x.id);
  assert.ok(b.transactions[0].deletedAt);
});

test("the month: own rows and business entries from your pocket; someone else's payment and pending ones stay out", () => {
  const b = emptyBook();
  saveTransaction(b, { title: "BİM", date: "2026-11-01", amount: 1016, category: "market" });
  saveTransaction(b, { kind: "income", title: "Maaş", date: "2026-11-03", amount: 60000, category: "salary" });
  saveTransaction(b, { kind: "investment", title: "KPA", asset: "KPA", assetType: "fund", date: "2026-11-04", amount: 5000, units: 3000 });
  saveTransaction(b, { kind: "transfer", title: "Kendi hesabım", date: "2026-11-05", amount: 7500 });
  saveTransaction(b, { title: "Ekim", date: "2026-10-30", amount: 99 });
  const business = [
    { id: "c", direction: "out", title: "Claude", amount: 5982.83, category: "yazilim", entryDate: "2026-11-24", status: "paid", paidBy: null },
    { id: "m", direction: "out", title: "Market alışverişi", amount: 4770.77, category: "other", entryDate: "2026-11-11", status: "paid", paidBy: "Aile" },
    { id: "d", direction: "out", title: "Doğalgaz", amount: 1177, category: "fatura", entryDate: "2026-11-02", status: "pending" },
    { id: "s", direction: "in", title: "Studyroute", amount: 15000, category: "hizmet", entryDate: "2026-11-05", status: "paid" },
  ];
  const v = monthView(b.transactions, business, "2026-11");
  assert.equal(v.spent, 1016 + 5982.83);
  assert.equal(v.businessSpent, 5982.83);
  assert.equal(v.income, 60000 + 15000);
  assert.equal(v.businessIncome, 15000);
  assert.equal(v.invested, 5000);
  assert.deepEqual(v.byCategory.map((c) => c.category), ["business", "market"]);
  assert.equal(v.rows[0].title, "Claude", "newest first");
  assert.ok(!v.rows.some((r) => r.title === "Market alışverişi" || r.title === "Doğalgaz" || r.title === "Ekim"));
  assert.equal(monthView(b.transactions, null, "2026-11").spent, 1016, "no Finances: own rows only");
});

test("holdings: units and money in and out per asset", () => {
  const b = emptyBook();
  const inv = (date, side, units, amount) => saveTransaction(b, { kind: "investment", asset: "KPA", assetType: "fund", side, date, units, amount });
  inv("2026-01-02", "buy", 7044, 7498.43);
  inv("2026-10-02", "buy", 3147, 4998.6);
  inv("2026-10-20", "sell", 1000, 1700);
  saveTransaction(b, { kind: "investment", asset: "DMLKT", assetType: "stock", side: "buy", date: "2025-10-15", units: 350, amount: 2117.5 });
  saveTransaction(b, { kind: "investment", asset: "DMLKT", assetType: "stock", side: "sell", date: "2025-12-01", units: 350, amount: 2500 });
  const [kpa, dmlkt] = holdings(b.transactions);
  assert.deepEqual([kpa.asset, kpa.units, kpa.putIn, kpa.takenOut, kpa.net, kpa.open], ["KPA", 9191, 12497.03, 1700, 10797.03, true]);
  assert.equal(kpa.lastUnitPrice, 1.7);
  assert.deepEqual([dmlkt.units, dmlkt.open, dmlkt.missingBuys], [0, false, false], "sold out comes last");
  saveTransaction(b, { kind: "investment", asset: "X", assetType: "stock", side: "sell", date: "2026-01-01", units: 10, amount: 100 });
  assert.equal(holdings(b.transactions).find((h) => h.asset === "X").missingBuys, true, "more sold than bought");
});

test("importing a statement skips what's already there, one for one", () => {
  const b = emptyBook();
  saveTransaction(b, { title: "Orçan Kardeşler Unlu", date: "2026-11-01", amount: 36, category: "food" });
  const rows = [
    { date: "2026-11-01", title: "ORCAN KARDESLER UNLU", amount: 36, category: "food" },
    { date: "2026-11-01", title: "Orçan Kardeşler Unlu", amount: 36, category: "food" },
    { date: "2026-11-02", title: "BİM", amount: 182.5, category: "market" },
  ];
  assert.deepEqual(importRows(b, rows), { added: 2, skipped: 1 });
  assert.deepEqual(importRows(b, rows), { added: 0, skipped: 3 }, "a second import adds nothing");
  assert.equal(b.transactions.filter((x) => x.source === "statement").length, 2);
});

test("a shared budget: who paid, each one's share, the fewest transfers; your share shows in your month", () => {
  const b = emptyBook();
  assert.throws(() => saveList(b, { name: "Kaş", members: [] }), /participant/);
  const list = saveList(b, { name: "Kaş", emoji: "🏖️", members: [{ name: "Selim", me: true }, "Ali", "Ayşe"] });
  const [me, ali, ayse] = list.members;
  assert.throws(() => saveTransaction(b, { ledger: list.id, title: "Otel", date: "2026-11-02", amount: 300 }), /who paid/);
  saveTransaction(b, { ledger: list.id, title: "Otel", date: "2026-11-02", amount: 300, payerId: me.id, category: "other" });
  saveTransaction(b, { ledger: list.id, title: "Akşam yemeği", date: "2026-11-03", amount: 100, payerId: ali.id, category: "food", splitAmong: [me.id, ali.id] });
  const bal = balances(list, b.transactions.filter((x) => x.ledger === list.id));
  assert.deepEqual(bal.map((m) => [m.name, m.paid, m.share, m.net]), [["Selim", 300, 150, 150], ["Ali", 100, 150, -50], ["Ayşe", 0, 100, -100]]);
  assert.deepEqual(settlements(bal).map((s) => [s.from.name, s.to.name, s.amount]), [["Ayşe", "Selim", 100], ["Ali", "Selim", 50]]);
  const v = monthView(b.transactions, [], "2026-11", b.lists);
  assert.equal(v.spent, 150, "your share, not the whole bill");
  assert.equal(v.rows.find((r) => r.title === "Otel").shared.full, 300);
  assert.deepEqual(allTransactions(b, []).map((r) => [r.title, r.scope, r.paidBy]), [["Akşam yemeği", "budget", "Ali"], ["Otel", "budget", "Selim"]]);
  deleteList(b, list.id);
  assert.equal(monthView(b.transactions, [], "2026-11", b.lists).spent, 0);
});

test("subscriptions: renewals go to the book once per period, from when added, not during the trial", () => {
  const b = emptyBook();
  const yt = saveSubscription(b, { name: "YouTube Premium", price: 57.99, cycle: "monthly", startDate: "2026-08-05" }, new Date("2026-09-20T10:00:00Z"));
  saveSubscription(b, { name: "Claude", price: 20, currency: "USD", cycle: "monthly", startDate: "2026-10-31", trial: "1_month" }, new Date("2026-10-31T10:00:00Z"));
  assert.equal(materializeSubscriptions(b, "2026-11-11"), 2, "Oct 5 and Nov 5 of YouTube; Claude is in its trial until Nov 30");
  assert.equal(materializeSubscriptions(b, "2026-11-11"), 0, "a second run writes nothing");
  assert.deepEqual(b.transactions.map((x) => [x.date, x.title, x.source]), [["2026-10-05", "YouTube Premium", "subscription"], ["2026-11-05", "YouTube Premium", "subscription"]]);
  assert.equal(materializeSubscriptions(b, "2026-11-30"), 0, "Claude's month-long trial from Oct 31 runs to Dec 1");
  assert.equal(materializeSubscriptions(b, "2026-12-31"), 2, "YouTube on Dec 5, Claude's first charge on Dec 31");
  assert.equal(b.transactions.find((x) => x.title === "Claude").currency, "USD");
  assert.equal(nextRenewal(yt.startDate, "monthly", "2026-11-11"), "2026-12-05");
});

test("everything in one table: personal, budget, investment and business rows, newest first", () => {
  const b = emptyBook();
  saveTransaction(b, { title: "BİM", date: "2026-11-01", amount: 1016, category: "market" });
  saveTransaction(b, { kind: "investment", asset: "KPA", assetType: "fund", date: "2026-10-02", amount: 5000, units: 3000 });
  const rows = allTransactions(b, [{ id: "c", direction: "out", title: "Claude", amount: 5982.83, category: "yazilim", entryDate: "2026-11-24", status: "paid", vatRate: 20 }]);
  assert.deepEqual(rows.map((r) => [r.date, r.title, r.scope]), [["2026-11-24", "Claude", "business"], ["2026-11-01", "BİM", "personal"], ["2026-10-02", "KPA", "investment"]]);
});
