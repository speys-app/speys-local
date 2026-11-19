// The personal book: pure operations, backend.js writes the file (kisisel.json in this applet's data folder).
// Every record has a permanent `id` and an `updatedAt`, a deleted one keeps `deletedAt`, so a sync can be attached
// later (the plan: one table in Speys, `finans` schema). Validation messages are English and double as translation keys.
import { randomUUID } from "node:crypto";
import { ASSET_TYPES, KINDS, TRIALS, dupKey, renewalsBetween, trialEnd } from "./personal-view.js";

export const emptyBook = () => ({ version: 1, accounts: [], transactions: [], lists: [], subscriptions: [] });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_KINDS = ["card", "bank", "cash", "wallet", "investment"];
const CURRENCIES = new Set(["TRY", "USD", "EUR", "GBP"]);
const stamp = (now) => now.toISOString();
const alive = (x) => !x.deletedAt;
const round2 = (n) => Math.round(n * 100) / 100;
const text = (v, max = 200) => String(v ?? "").trim().slice(0, max);

function validDate(value) {
  const d = new Date(`${value}T00:00:00Z`);
  if (!DATE.test(value ?? "") || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new Error("Invalid date");
  return value;
}

function positive(v, message = "Amount must be greater than zero") {
  const n = Number(v);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error(message);
  return round2(n);
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
  Object.assign(found, { deletedAt: stamp(now), updatedAt: stamp(now) });
}

/** An account: where money comes from. Yours ("Kuveyt card ••9754", "Cash"). */
export function saveAccount(book, input, now = new Date()) {
  const name = text(input.name, 80);
  if (!name) throw new Error("Name is required");
  const currency = text(input.currency, 3).toUpperCase() || "TRY";
  if (!CURRENCIES.has(currency)) throw new Error("Invalid currency");
  return upsert(book.accounts, input.id, { name, kind: ACCOUNT_KINDS.includes(input.kind) ? input.kind : "card", currency }, now);
}

export const deleteAccount = (book, id, now = new Date()) => remove(book.accounts, id, now);

/**
 * A transaction in your personal book. kind: expense / income / transfer (between your own accounts, counted nowhere)
 * / investment (asset, units, side buy|sell; amount is the TL value). `paidBy` names someone else who paid (then
 * it isn't from your pocket); `accountId` is one of your accounts.
 */
export function saveTransaction(book, input, now = new Date()) {
  const kind = KINDS.includes(input.kind) ? input.kind : "expense";
  const title = text(input.title) || (kind === "investment" ? text(input.asset, 60) : "");
  if (!title) throw new Error("Title is required");
  const accountId = input.accountId || null;
  if (accountId && !book.accounts.some((a) => a.id === accountId && alive(a))) throw new Error("Account not found");
  // a shared budget's expense: its ledger is the budget, with who paid and among whom it is split
  const list = input.ledger && input.ledger !== "personal" ? (book.lists ?? []).find((l) => l.id === input.ledger && alive(l)) : null;
  if (input.ledger && input.ledger !== "personal" && !list) throw new Error("Budget not found");
  const members = new Set(list?.members.map((m) => m.id) ?? []);
  const fields = {
    ledger: list ? list.id : "personal",
    kind,
    date: validDate(input.date),
    title,
    amount: positive(input.amount),
    category: text(input.category, 40) || "other",
    accountId,
    paidBy: text(input.paidBy, 80) || null,
    counterparty: text(input.counterparty, 120) || null,
    note: text(input.note, 1000) || null,
    source: text(input.source, 30) || "manual",
  };
  if (Object.hasOwn(input, "currency")) {
    const c = text(input.currency, 3).toUpperCase();
    if (c && !CURRENCIES.has(c)) throw new Error("Invalid currency");
    fields.currency = c || null;
    fields.originalAmount = input.originalAmount === "" || input.originalAmount == null ? null : positive(input.originalAmount);
  }
  if (list) {
    if (!members.has(input.payerId)) throw new Error("Choose who paid");
    fields.payerId = input.payerId;
    const among = (Array.isArray(input.splitAmong) ? input.splitAmong : []).filter((id) => members.has(id));
    fields.splitAmong = among.length && among.length < members.size ? among : null;
  }
  if (kind === "investment") {
    fields.asset = text(input.asset, 60);
    if (!fields.asset) throw new Error("Asset is required");
    fields.assetType = ASSET_TYPES.includes(input.assetType) ? input.assetType : "other";
    fields.side = input.side === "sell" ? "sell" : "buy";
    fields.units = input.units === "" || input.units == null ? null : positive(input.units, "Invalid number");
  }
  return upsert(book.transactions, input.id, fields, now);
}

export const deleteTransaction = (book, id, now = new Date()) => remove(book.transactions, id, now);

/**
 * Rows from a statement (or an earlier export), each { date, title, amount, category, kind? }, into the book. One
 * already there (same day, amount and title) is skipped, one for one: two identical coffees stay two.
 */
export function importRows(book, rows, { accountId = null, source = "statement" } = {}, now = new Date()) {
  const have = new Map();
  for (const x of book.transactions.filter(alive)) {
    const k = dupKey(x.date, x.amount, x.title);
    have.set(k, (have.get(k) ?? 0) + 1);
  }
  let added = 0, skipped = 0;
  for (const r of rows) {
    const k = dupKey(r.date, r.amount, r.title);
    if ((have.get(k) ?? 0) > 0) { have.set(k, have.get(k) - 1); skipped++; continue; }
    saveTransaction(book, { ...r, kind: r.kind ?? "expense", accountId: r.accountId ?? accountId, source: r.source ?? source }, now);
    added++;
  }
  return { added, skipped };
}

// —— shared budgets (Speys's projects: a trip, the house, an event): members by name, one of them is you
const LIST_KINDS = ["trip", "home", "event", "other"];
export function saveList(book, input, now = new Date()) {
  book.lists ??= [];
  const name = text(input.name, 80);
  if (!name) throw new Error("Title is required");
  const existing = input.id ? book.lists.find((l) => l.id === input.id && alive(l)) : null;
  const names = (Array.isArray(input.members) ? input.members : []).map((m) => (typeof m === "string" ? { name: m } : m)).map((m) => ({ ...m, name: text(m.name, 40) })).filter((m) => m.name);
  if (!names.length) throw new Error("At least one participant");
  // members keep their ids (expenses point at them); the first one marked `me` is you, else the first one
  const members = names.map((m) => ({ id: existing?.members.find((x) => x.id === m.id || x.name === m.name)?.id ?? randomUUID(), name: m.name, me: !!m.me }));
  if (!members.some((m) => m.me)) members[0].me = true;
  const dates = ["startDate", "endDate"].map((k) => (input[k] ? validDate(input[k]) : null));
  if (dates[0] && dates[1] && dates[0] > dates[1]) throw new Error("The start date can't be after the end date");
  return upsert(book.lists, input.id, { name, emoji: text(input.emoji, 8) || "🏖️", kind: LIST_KINDS.includes(input.kind) ? input.kind : "trip", currency: "TRY", startDate: dates[0], endDate: dates[1], members }, now);
}
export function deleteList(book, id, now = new Date()) {
  remove(book.lists ?? [], id, now);
  for (const x of book.transactions) if (x.ledger === id && alive(x)) Object.assign(x, { deletedAt: stamp(now), updatedAt: stamp(now) });
}

// —— subscriptions (Speys's Subcenter): a renewal writes an expense to the personal book, once per period
const CYCLES = ["monthly", "yearly"];
const SUB_KINDS = ["digital", "telecom", "home"];
export function saveSubscription(book, input, now = new Date()) {
  book.subscriptions ??= [];
  const name = text(input.name, 80);
  if (!name) throw new Error("Name is required");
  const currency = text(input.currency, 3).toUpperCase() || "TRY";
  if (!CURRENCIES.has(currency)) throw new Error("Invalid currency");
  return upsert(book.subscriptions, input.id, {
    name, plan: text(input.plan, 60) || null, price: positive(input.price), currency,
    cycle: CYCLES.includes(input.cycle) ? input.cycle : "monthly",
    category: text(input.category, 30) || "Other", kind: SUB_KINDS.includes(input.kind) ? input.kind : "digital",
    startDate: validDate(input.startDate), trial: TRIALS[input.trial] ? input.trial : null,
    icon: text(input.icon, 8) || null, color: /^#[0-9a-f]{6}$/i.test(input.color ?? "") ? input.color : null,
    accountId: input.accountId || null,
  }, now);
}
export const deleteSubscription = (book, id, now = new Date()) => remove(book.subscriptions ?? [], id, now);

/**
 * Writes the renewals due up to `today` as expenses (source "subscription", one per subscription and period), as
 * Speys's daily job does; only from when the subscription was added, and not while its free trial runs. Foreign
 * prices are written as they are (no rate here): the row says the currency. Returns how many were written.
 */
export function materializeSubscriptions(book, today, now = new Date()) {
  let written = 0;
  const have = new Set(book.transactions.filter((x) => alive(x) && x.subscriptionId).map((x) => `${x.subscriptionId}|${x.billingPeriod}`));
  for (const s of (book.subscriptions ?? []).filter(alive)) {
    const added = String(s.createdAt ?? "").slice(0, 10) || today;
    const trialOver = trialEnd(s.startDate, s.trial);
    for (const at of renewalsBetween(s.startDate, s.cycle, added > s.startDate ? added : s.startDate, today)) {
      if (trialOver && at < trialOver) continue;
      const period = at.slice(0, 7);
      if (have.has(`${s.id}|${period}`)) continue;
      const x = saveTransaction(book, { title: s.name, date: at, amount: s.price, category: "bill", accountId: s.accountId, source: "subscription", ...(s.currency !== "TRY" ? { currency: s.currency, originalAmount: s.price } : {}) }, now);
      Object.assign(x, { subscriptionId: s.id, billingPeriod: period });
      have.add(`${s.id}|${period}`);
      written++;
    }
  }
  return written;
}
