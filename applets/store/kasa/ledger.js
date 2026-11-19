// The ledger itself: pure operations, backend.js writes the file. The sums follow the same rules as Speys's Ledger.
//
// So that sync can be attached later:
// every record has a permanent `id` and an `updatedAt`, a deleted record stays with `deletedAt`. No line numbers.
// Validation messages are English and double as translation keys: backend.js translates them.
import { randomUUID } from "node:crypto";
import { stableId } from "../../../lib/sync.js";

export const emptyLedger = () => ({ version: 1, entries: [], rules: [], plans: [], scenarios: [] });

// Not part of profit, as in Speys (`kasa.is_operating`): capital put in, an owner's withdrawal, a tax payment.
export const isOperating = (direction, category) =>
  !((direction === "in" && category === "sermaye") || (direction === "out" && (category === "ortak_cekis" || category === "vergi_odeme")));

// What an amount means, as in Speys (`kasa.entry_net` / `entry_vat` / `entry_cash`): `amount` is the document's amount;
// with `vatIncluded` (the default, and every older record) VAT is inside it, otherwise it is the amount before VAT.
// Withholding is inside the gross amount: what reaches the till is lower. Profit is counted without VAT.
const vatOf = (x) => Number(x.vatRate) || 0;
export const net = (x) => (vatOf(x) <= 0 || x.vatIncluded === false ? x.amount : (x.amount * 100) / (100 + vatOf(x)));
export const vat = (x) => (vatOf(x) <= 0 ? 0 : x.vatIncluded === false ? (x.amount * vatOf(x)) / 100 : (x.amount * vatOf(x)) / (100 + vatOf(x)));
export const cash = (x) => (x.vatIncluded === false && vatOf(x) > 0 ? x.amount + (x.amount * vatOf(x)) / 100 : x.amount) - (Number(x.withholding) || 0);
const round2 = (n) => Math.round(n * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const stamp = (now) => now.toISOString();
const alive = (x) => !x.deletedAt;

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function validDate(value) {
  if (!DATE.test(value ?? "") || addDays(value, 0) !== value) throw new Error("Invalid date");
  return value;
}

function validCore(input) {
  const title = String(input.title ?? "").trim();
  const amount = Number(input.amount);
  if (!title) throw new Error("Title is required");
  if (!(amount > 0) || !Number.isFinite(amount)) throw new Error("Amount must be greater than zero");
  if (input.direction !== "in" && input.direction !== "out") throw new Error("Invalid direction");
  return {
    direction: input.direction,
    title: title.slice(0, 200),
    amount: Math.round(amount * 100) / 100,
    category: String(input.category || "other"),
    counterparty: String(input.counterparty ?? "").trim() || null,
  };
}

const CURRENCIES = new Set(["TRY", "USD", "EUR", "GBP"]);

/**
 * The fields Speys keeps beside the amount. Only the ones sent are changed: an older page or a copied applet that
 * doesn't know a field doesn't clear it. Null (or an empty string) clears.
 */
function details(input, { withholding = true } = {}) {
  const out = {};
  const has = (k) => Object.hasOwn(input, k);
  const number = (k, ok) => {
    if (!has(k)) return;
    const raw = input[k];
    if (raw === null || raw === "") return (out[k] = null);
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) throw new Error("Invalid number");
    out[k] = round2(n);
  };
  number("vatRate", (n) => n >= 0 && n <= 100);
  if (has("vatIncluded")) out.vatIncluded = input.vatIncluded !== false;
  if (withholding) number("withholding", (n) => n >= 0);
  number("originalAmount", (n) => n > 0);
  number("fxRate", (n) => n > 0);
  if (has("currency")) {
    const c = String(input.currency ?? "").trim().toUpperCase();
    if (c && !CURRENCIES.has(c)) throw new Error("Invalid currency");
    out.currency = c || null;
  }
  for (const k of ["invoiceNo", "paidBy"]) if (has(k)) out[k] = String(input[k] ?? "").trim().slice(0, 100) || null;
  return out;
}

function upsert(list, id, fields, now) {
  const found = id ? list.find((x) => x.id === id && alive(x)) : null;
  if (id && !found) throw new Error("Record not found");
  if (found) return Object.assign(found, fields, { updatedAt: stamp(now) });
  const created = { id: randomUUID(), ...fields, createdAt: stamp(now), updatedAt: stamp(now) };
  list.push(created);
  return created;
}

function remove(list, id, now) {
  const found = list.find((x) => x.id === id && alive(x));
  if (!found) throw new Error("Record not found");
  found.deletedAt = stamp(now);
  found.updatedAt = stamp(now);
}

export function saveEntry(ledger, input, now = new Date()) {
  const existing = input.id ? ledger.entries.find((x) => x.id === input.id && alive(x)) : null;
  return upsert(ledger.entries, input.id, {
    ...validCore(input),
    entryDate: validDate(input.entryDate),
    status: input.status === "pending" ? "pending" : "paid",
    note: String(input.note ?? "").trim() || null,
    ...details(input),
    ...(Object.hasOwn(input, "items") ? { items: itemsOf(input.items, existing?.items) } : {}),
  }, now);
}

// —— A receipt's lines: what was bought, line by line. On this computer only ("own" in applet.json: never sent to
// Speys, whose Ledger has no lines). `kind` is "food" or "household" (cleaning, personal care…); anything else is
// "other". Writing the list again keeps each line's id and `doneAt`, matched by id or else by name: what's at home
// is what was bought and not marked finished.
export const ITEM_KINDS = ["food", "household", "other"];

function itemNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid number");
  return round2(n);
}

function itemsOf(list, before = []) {
  if (!Array.isArray(list)) throw new Error("Invalid items");
  const old = [...(before ?? [])];
  const take = (id, name) => {
    const i = old.findIndex((o) => (id ? o.id === id : o.name === name));
    return i < 0 ? null : old.splice(i, 1)[0];
  };
  return list.slice(0, 300).map((raw) => {
    const name = String(raw?.name ?? "").trim().slice(0, 120);
    if (!name) throw new Error("Item name is required");
    const prev = take(raw?.id, name);
    return {
      id: prev?.id ?? randomUUID(),
      name,
      qty: itemNumber(raw?.qty),
      unit: String(raw?.unit ?? "").trim().slice(0, 20) || null,
      price: itemNumber(raw?.price),
      vatRate: itemNumber(raw?.vatRate),
      kind: ITEM_KINDS.includes(raw?.kind) ? raw.kind : "other",
      doneAt: Object.hasOwn(raw ?? {}, "doneAt") ? raw.doneAt || null : prev?.doneAt ?? null,
    };
  });
}

/** Writes only a receipt's lines (the rest of the record stays). */
export function setItems(ledger, entryId, items, now = new Date()) {
  const entry = ledger.entries.find((x) => x.id === entryId && alive(x));
  if (!entry) throw new Error("Record not found");
  entry.items = itemsOf(items, entry.items);
  entry.updatedAt = stamp(now);
  return entry;
}

/** Marks a line as finished (gone from home), or back at home. */
export function setItemDone(ledger, entryId, itemId, done, now = new Date()) {
  const entry = ledger.entries.find((x) => x.id === entryId && alive(x));
  const item = entry?.items?.find((x) => x.id === itemId);
  if (!item) throw new Error("Record not found");
  item.doneAt = done ? stamp(now) : null;
  entry.updatedAt = stamp(now);
  return item;
}

/** What's at home: the lines of receipts not marked finished, newest purchase first; bought twice shows twice. */
export function atHome(ledger) {
  return ledger.entries
    .filter((e) => alive(e) && e.direction === "out" && e.items?.length)
    .sort(newestFirst)
    .flatMap((e) => e.items.filter((i) => !i.doneAt).map((i) => ({ ...i, entryId: e.id, boughtOn: e.entryDate, from: e.counterparty ?? e.title })));
}

export const deleteEntry = (ledger, id, now = new Date()) => remove(ledger.entries, id, now);

export function saveRule(ledger, input, today, now = new Date()) {
  const cycle = input.cycle;
  if (!["monthly", "quarterly", "yearly"].includes(cycle)) throw new Error("Invalid cycle");
  const dayOfMonth = Number(input.dayOfMonth);
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw new Error("Day must be between 1 and 31");
  const monthOfYear = cycle === "monthly" ? null : Number(input.monthOfYear);
  if (cycle !== "monthly" && !(Number.isInteger(monthOfYear) && monthOfYear >= 1 && monthOfYear <= 12)) throw new Error("Invalid month");
  const existing = input.id ? ledger.rules.find((r) => r.id === input.id && alive(r)) : null;
  return upsert(ledger.rules, input.id, {
    ...validCore(input),
    cycle,
    dayOfMonth,
    monthOfYear,
    autoPaid: input.autoPaid !== false,
    isActive: input.isActive !== false,
    // A new rule may start later (the accountant template starts next month); an existing one keeps its start.
    startDate: existing?.startDate ?? (DATE.test(input.startDate ?? "") ? validDate(input.startDate) : today),
    lastGenerated: existing?.lastGenerated ?? null,
    ...(Object.hasOwn(input, "templateKey") ? { templateKey: input.templateKey || null } : {}),
    ...details(input, { withholding: false }),
  }, now);
}

/** When a paused rule is resumed, the months it was paused are not written to the ledger retroactively. */
export function setRuleActive(ledger, id, active, today, now = new Date()) {
  const rule = ledger.rules.find((r) => r.id === id && alive(r));
  if (!rule) throw new Error("Rule not found");
  if (active && !rule.isActive) rule.lastGenerated = today;
  rule.isActive = active;
  rule.updatedAt = stamp(now);
}

export const deleteRule = (ledger, id, now = new Date()) => remove(ledger.rules, id, now);

/** The tax settings (as in Speys's `kasa.settings`): what kind of income, Bağ-Kur, the young entrepreneur exemption. */
export function saveTaxSettings(ledger, input) {
  ledger.taxSettings = {
    youngEntrepreneur: input.youngEntrepreneur === true,
    bagkur: ["none", "discounted", "full"].includes(input.bagkur) ? input.bagkur : "none",
    activity: input.activity === "professional" ? "professional" : "commercial",
  };
  return ledger.taxSettings;
}

/** The rule's dates within [from, to]; in a short month the day moves to the last day. */
function occurrences(rule, from, to) {
  const out = [];
  let year = +from.slice(0, 4), month = +from.slice(5, 7);
  while (`${year}-${String(month).padStart(2, "0")}-01` <= to) {
    const due = rule.cycle === "monthly"
      || (rule.cycle === "yearly" && month === rule.monthOfYear)
      || (rule.cycle === "quarterly" && (month - rule.monthOfYear + 12) % 3 === 0);
    if (due) {
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const date = `${year}-${String(month).padStart(2, "0")}-${String(Math.min(rule.dayOfMonth, last)).padStart(2, "0")}`;
      if (date >= from && date <= to) out.push(date);
    }
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

/** Writes the repeats that have come due to the ledger; a deleted record does not come back. True if anything changed. */
export function materialize(ledger, today, now = new Date()) {
  let changed = false;
  for (const rule of ledger.rules) {
    if (!alive(rule) || !rule.isActive) continue;
    const from = rule.lastGenerated ? addDays(rule.lastGenerated, 1) : rule.startDate;
    if (from > today) continue;
    for (const date of occurrences(rule, from, today)) {
      if (ledger.entries.some((e) => e.recurringId === rule.id && e.entryDate === date)) continue;
      ledger.entries.push({
        // the same id Speys gives this repeat, so syncing doesn't make it twice
        id: stableId(rule.id, date), direction: rule.direction, title: rule.title, amount: rule.amount, category: rule.category,
        counterparty: rule.counterparty, entryDate: date, status: rule.autoPaid ? "paid" : "pending", note: null,
        recurringId: rule.id, createdAt: stamp(now), updatedAt: stamp(now),
        ...Object.fromEntries(["vatRate", "vatIncluded", "currency", "originalAmount", "paidBy"].filter((k) => rule[k] != null).map((k) => [k, rule[k]])),
      });
    }
    rule.lastGenerated = today;
    changed = true;
  }
  return changed;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A plan item: not written to the ledger, counted only in expected expenses and income. Month is `YYYY-MM`. */
export function savePlan(ledger, input, now = new Date()) {
  if (!["once", "monthly", "quarterly", "yearly"].includes(input.cycle)) throw new Error("Invalid cycle");
  if (!MONTH.test(input.startMonth ?? "")) throw new Error("Invalid start month");
  const endMonth = input.endMonth || null;
  if (endMonth && (!MONTH.test(endMonth) || endMonth < input.startMonth)) throw new Error("Invalid end month");
  ledger.plans ??= [];
  const extra = {};
  const has = (k) => Object.hasOwn(input, k);
  const rate = (k, ok) => {
    if (!has(k)) return;
    if (input[k] === null || input[k] === "") return (extra[k] = null);
    const n = Number(input[k]);
    if (!Number.isFinite(n) || !ok(n)) throw new Error("Invalid number");
    extra[k] = round2(n);
  };
  rate("vatRate", (n) => n >= 0 && n <= 100);
  if (has("vatIncluded")) extra.vatIncluded = input.vatIncluded !== false;
  rate("withholdingRate", (n) => n >= 0 && n < 100); // a rate, not an amount: the amount grows each year
  rate("annualIncreasePct", (n) => n > -100);
  if (has("scenarioId")) {
    const id = input.scenarioId || null;
    if (id && !(ledger.scenarios ?? []).some((x) => x.id === id && alive(x))) throw new Error("Scenario not found");
    extra.scenarioId = id;
  }
  // As in Speys: a one-time item has no end and no yearly increase.
  if (input.cycle === "once") Object.assign(extra, { annualIncreasePct: null });
  return upsert(ledger.plans, input.id, {
    ...validCore(input),
    cycle: input.cycle,
    startMonth: input.startMonth,
    endMonth: input.cycle === "once" ? null : endMonth,
    note: String(input.note ?? "").trim() || null,
    ...extra,
  }, now);
}

export const deletePlan = (ledger, id, now = new Date()) => remove(ledger.plans ?? [], id, now);

/**
 * Scenarios, as in Speys (bad / expected / good): a plan item without a scenario counts in all of them, one with a
 * scenario only in that one. At most one is the default; the plan opens with it. `openingBalance` starts the running total.
 */
export function saveScenario(ledger, input, now = new Date()) {
  ledger.scenarios ??= [];
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (!name) throw new Error("Name is required");
  const opening = input.openingBalance === null || input.openingBalance === "" || input.openingBalance === undefined ? null : Number(input.openingBalance);
  if (opening !== null && !Number.isFinite(opening)) throw new Error("Invalid number");
  const isDefault = input.isDefault === true || !ledger.scenarios.some(alive); // the first one is the default
  if (isDefault) {
    for (const x of ledger.scenarios) if (alive(x) && x.isDefault && x.id !== input.id) Object.assign(x, { isDefault: false, updatedAt: stamp(now) });
  }
  const sort = input.id ? undefined : Math.max(-1, ...ledger.scenarios.filter(alive).map((x) => x.sort ?? 0)) + 1;
  return upsert(ledger.scenarios, input.id, {
    name, note: String(input.note ?? "").trim() || null, openingBalance: opening === null ? null : round2(opening), isDefault,
    ...(sort === undefined ? {} : { sort }),
  }, now);
}

/** A scenario goes with the plan items that are only in it (as in Speys); items in every scenario stay. */
export function deleteScenario(ledger, id, now = new Date()) {
  remove(ledger.scenarios ?? [], id, now);
  for (const p of ledger.plans ?? []) if (alive(p) && p.scenarioId === id) remove(ledger.plans, p.id, now);
}

/** The scenario the plan shows: the asked one, else the default, else none (then only items without a scenario). */
export function activeScenario(ledger, wanted) {
  const list = (ledger.scenarios ?? []).filter(alive);
  return list.find((x) => x.id === wanted) ?? list.find((x) => x.isDefault) ?? list[0] ?? null;
}

const inScenario = (plan, scenarioId) => !plan.scenarioId || plan.scenarioId === scenarioId;

/** The amount a plan item expects in a month: from its start year on it grows by `annualIncreasePct` each January. */
export function planAmount(plan, ym) {
  const years = +ym.slice(0, 4) - +plan.startMonth.slice(0, 4);
  const pct = Number(plan.annualIncreasePct) || 0;
  return pct && years > 0 ? round2(plan.amount * (1 + pct / 100) ** years) : plan.amount;
}

function planDue(plan, ym) {
  if (ym < plan.startMonth || (plan.endMonth && ym > plan.endMonth)) return false;
  const gap = (+ym.slice(5, 7) - +plan.startMonth.slice(5, 7) + 12) % 12;
  if (plan.cycle === "once") return ym === plan.startMonth;
  if (plan.cycle === "quarterly") return gap % 3 === 0;
  if (plan.cycle === "yearly") return gap === 0;
  return true;
}

/**
 * What a month expects: the rules' dates still to come + plan items. A past month expects nothing.
 * A plan item written to the ledger under the same title counts as done that month, not twice.
 */
export function monthExpected(ledger, ym, today, scenarioId = activeScenario(ledger)?.id ?? null) {
  const empty = { items: [], expense: 0, income: 0 };
  const current = today.slice(0, 7);
  if (ym < current) return empty;
  const [year, month] = ym.split("-").map(Number);
  const last = `${ym}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  const from = ym === current ? addDays(today, 1) : `${ym}-01`;
  const recorded = new Set(ledger.entries.filter((e) => alive(e) && e.entryDate.startsWith(ym)).map((e) => e.title.toLocaleLowerCase("tr")));
  const pick = (x, source, date) => ({ id: x.id, source, title: x.title, amount: x.amount, net: net(x), direction: x.direction, category: x.category, date });
  const items = [
    ...ledger.rules.filter((r) => alive(r) && r.isActive).flatMap((r) =>
      occurrences(r, r.startDate > from ? r.startDate : from, last).map((date) => pick(r, "kural", date))),
    ...(ledger.plans ?? []).filter((p) => alive(p) && inScenario(p, scenarioId) && planDue(p, ym) && !recorded.has(p.title.toLocaleLowerCase("tr")))
      .map((p) => pick({ ...p, amount: planAmount(p, ym) }, "plan", null)),
  ];
  const total = (direction) => items.filter((i) => i.direction === direction && isOperating(i.direction, i.category)).reduce((t, i) => t + i.net, 0);
  return { items, expense: total("out"), income: total("in") };
}

/**
 * 12 months (four quarters) from the start of this quarter, the data of the financial table and the chart. `lines` is per category.
 * Actual: paid entries. Expected: unpaid entries + the rules' future dates + plan. Non-operating categories stay out.
 */
export function forecast(ledger, today, scenarioId = activeScenario(ledger)?.id ?? null) {
  const year = +today.slice(0, 4), quarterMonth = Math.floor((+today.slice(5, 7) - 1) / 3) * 3;
  const counted = ledger.entries.filter((e) => alive(e) && isOperating(e.direction, e.category));
  return Array.from({ length: 12 }, (_, i) => {
    const y = year + Math.floor((quarterMonth + i) / 12), m = (quarterMonth + i) % 12 + 1;
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const lines = new Map();
    const add = ({ direction, category }, field, amount) => {
      const key = `${direction}|${category}`;
      if (!lines.has(key)) lines.set(key, { direction, category, actual: 0, expected: 0 });
      lines.get(key)[field] += amount;
    };
    for (const e of counted) if (e.entryDate.startsWith(ym)) add(e, e.status === "paid" ? "actual" : "expected", net(e));
    for (const item of monthExpected(ledger, ym, today, scenarioId).items) if (isOperating(item.direction, item.category)) add(item, "expected", item.net);
    const list = [...lines.values()];
    const total = (direction, field) => list.filter((l) => l.direction === direction).reduce((t, l) => t + l[field], 0);
    return {
      ym,
      lines: list,
      expense: total("out", "actual"),
      income: total("in", "actual"),
      expectedExpense: total("out", "expected"),
      expectedIncome: total("in", "expected"),
    };
  });
}

const withNet = (e) => ({ ...e, net: round2(net(e)), operating: isOperating(e.direction, e.category) });
const newestFirst = (a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt);

export function overview(ledger, { from, to, year, scenario: wanted }, today) {
  const scenario = activeScenario(ledger, wanted);
  const entries = ledger.entries.filter(alive);
  const counted = (e) => e.status === "paid" && isOperating(e.direction, e.category);
  const sum = (list, direction, of = net) => list.filter((e) => e.direction === direction).reduce((t, e) => t + of(e), 0);
  const period = entries.filter((e) => e.entryDate >= from && e.entryDate <= to);
  const paid = period.filter((e) => e.status === "paid");
  const income = round2(sum(period.filter(counted), "in"));
  const expense = round2(sum(period.filter(counted), "out"));
  const byCategory = (direction, category) => round2(sum(paid.filter((e) => e.category === category), direction, cash));
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const prefix = `${year}-${String(i + 1).padStart(2, "0")}`;
    const list = entries.filter((e) => e.entryDate.startsWith(prefix) && counted(e));
    return { month: i + 1, income: round2(sum(list, "in")), expense: round2(sum(list, "out")) };
  });
  const rules = ledger.rules.filter(alive);
  const upcomingFrom = addDays(today, 1), upcomingTo = addDays(today, 30);
  const upcoming = rules.filter((r) => r.isActive)
    .flatMap((r) => occurrences(r, upcomingFrom, upcomingTo).map((dueDate) => ({ ruleId: r.id, dueDate, title: r.title, amount: r.amount, direction: r.direction })))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    // The same figures as Speys's summary (`kasa.get_summary`): profit without VAT; VAT, withholding and the money that
    // actually moved apart, so accrual and cash don't mix.
    summary: {
      income, expense, profit: round2(income - expense),
      vatCollected: round2(sum(paid, "in", vat)), vatPaid: round2(sum(paid, "out", vat)),
      withholding: round2(paid.filter((e) => e.direction === "in").reduce((t, e) => t + (Number(e.withholding) || 0), 0)),
      capitalIn: byCategory("in", "sermaye"), ownerDraw: byCategory("out", "ortak_cekis"), taxPayments: byCategory("out", "vergi_odeme"),
      cashIn: round2(sum(paid, "in", cash)), cashOut: round2(sum(paid, "out", cash)),
    },
    // `net` is for the page only (the amount without VAT); it isn't written to the ledger.
    entries: period.sort(newestFirst).map(withNet),
    pending: entries.filter((e) => e.status === "pending").sort(newestFirst).map(withNet),
    monthly,
    rules,
    upcoming,
    plans: (ledger.plans ?? []).filter(alive).sort((a, b) => a.startMonth.localeCompare(b.startMonth) || b.amount - a.amount),
    scenarios: (ledger.scenarios ?? []).filter(alive).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    scenario,
    forecast: forecast(ledger, today, scenario?.id ?? null),
    expected: monthExpected(ledger, from.slice(0, 7), today, scenario?.id ?? null),
  };
}
