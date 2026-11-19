// The personal side's pure parts, used by the page (personal-page.js imports ./personal-view.js) and by the backend
// and tests: categories, the statement parser, the month and investment views. No Node or browser API here.
//
// One table of transactions (the plan: speys-local data/product/features/finans): every row says whose book it is in
// (`ledger`), whose pocket it came from (`accountId`, or `paidBy` for someone without an account here) and what it is
// (`kind`). The business book is this applet's ledger (defter.json, synced with Speys's Ledger); its entries stay
// there and are read, not copied: the personal month shows the ones paid from your own pocket beside your own rows.

// The eight categories of Speys's expense book (frontend apps/budget/lib/kategoriler.ts), same ids.
export const CATEGORIES = [
  { id: "market", emoji: "🛒", label: "Groceries" },
  { id: "food", emoji: "🍽️", label: "Food" },
  { id: "cafe", emoji: "☕", label: "Cafe" },
  { id: "transport", emoji: "🚕", label: "Transport" },
  { id: "bill", emoji: "💡", label: "Bills" },
  { id: "health", emoji: "💊", label: "Health" },
  { id: "fun", emoji: "🎬", label: "Fun" },
  { id: "other", emoji: "💸", label: "Other" },
];
// Speys's income types (backend/budget/ledger.ts).
export const INCOME_CATEGORIES = [
  { id: "salary", emoji: "💼", label: "Salary" },
  { id: "scholarship", emoji: "🎓", label: "Scholarship" },
  { id: "returns", emoji: "📈", label: "Returns" },
  { id: "family", emoji: "👪", label: "Family" },
  { id: "other", emoji: "💰", label: "Other" },
];
export const KINDS = ["expense", "income", "transfer", "investment"];
export const ASSET_TYPES = ["fund", "stock", "gold", "foreign_currency", "sukuk", "deposit", "other"];

// —— category guess, from Speys (kategoriler.ts): merchant names are data
const GUESS = [
  ["food", /yemeksepeti|trendyol yemek|migrosone yemek|getir ?yemek|restoran|restaurant|burger|pizza|doner|lokanta|kebap|borek|pilav|durum|kofte|tantuni|pide|tavuk|otomat|otobite/i],
  ["market", /migros|mjet|a101|bim|sok market|sok-|carrefour|file market|macro|market|getir|hepsiexpress|tekel|kuruyemis/i],
  ["cafe", /starbucks|kahve|coffee|cafe|kafe|espresso|simit|kantin|bufe|1773/i],
  ["transport", /shell|opet|bp |petrol|akaryak|uber|taksi|bitaksi|marti|istanbulkart|belbim|tcdd|obilet|thy|pegasus|otopark/i],
  ["bill", /turkcell|vodafone|turk telekom|superonline|igdas|enerjisa|ck enerji|iski|netflix|spotify|youtube|apple\.com|google|chatgpt|openai|capcut|fatura/i],
  ["health", /eczane|hastane|klinik|medical|medikal|optik|pharmacy|dental/i],
  ["fun", /sinema|cinema|biletix|steam|playstation|konser|tiyatro|\bbar\b|\bpub\b|bira/i],
];
// Bank text writes capitals without dots ("ISTANBUL") and /i doesn't match İ/ı: compare Turkish-free plain text.
export const fold = (s) => String(s ?? "").replace(/[İIı]/g, "i").toLowerCase()
  .replace(/[şğüöç]/g, (c) => ({ ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c" })[c] ?? c);
export const guessCategory = (title) => GUESS.find(([, re]) => re.test(fold(title)))?.[0] ?? "other";

// —— statement lines, from Speys (ekstre.ts): "03.10.2026  MIGROS KADIKÖY  245,90 TL"
const MONTHS = ["oca", "şub", "mar", "nis", "may", "haz", "tem", "ağu", "eyl", "eki", "kas", "ara"];
// on folded text, a word that starts so ("KART ÖDEMESİ"): \b doesn't see Turkish letters as word letters
const CREDIT = /(^|[^a-z0-9])(iade|odeme|payment|refund|tahsilat)/;
const pad = (n) => String(n).padStart(2, "0");

/** "245,90" "1.250,00" "1,250.00" "1250" → a number. */
export function parseAmountText(raw) {
  let s = String(raw ?? "").replace(/[^\d.,]/g, "");
  if (!s) return null;
  const comma = s.lastIndexOf(","), dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (comma >= 0) s = /,\d{1,2}$/.test(s) ? s.replace(/,(?=\d{3}\b)/g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (dot >= 0 && /\.\d{3}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(line, today) {
  const numeric = line.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\s+/);
  if (numeric) {
    const day = Number(numeric[1]), month = Number(numeric[2]);
    let year = numeric[3] ? Number(numeric[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    if (!numeric[3] && month > today.getMonth() + 1) year -= 1; // no year and a later month: last year's statement
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return { date: `${year}-${pad(month)}-${pad(day)}`, rest: line.slice(numeric[0].length) };
  }
  const named = line.match(/^(\d{1,2})\s+([a-zçğıöşü]{3})[a-zçğıöşü]*\.?(?:\s+(\d{4}))?\s+/i);
  if (named) {
    const month = MONTHS.indexOf(named[2].toLocaleLowerCase("tr-TR")) + 1;
    if (month === 0) return null;
    let year = named[3] ? Number(named[3]) : today.getFullYear();
    if (!named[3] && month > today.getMonth() + 1) year -= 1;
    return { date: `${year}-${pad(month)}-${pad(Number(named[1]))}`, rest: line.slice(named[0].length) };
  }
  return null;
}

/**
 * Pasted statement lines → rows { key, title, amount, date, category, include, credit }. Payments and refunds (minus,
 * "iade", "ödeme") are listed but not ticked.
 */
export function parseStatement(text, today = new Date()) {
  const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const rows = [];
  String(text ?? "").split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/^\s*(?:[-*•·]|\d+[.)](?=\s))\s*/, "").replace(/\t+/g, "  ").trim();
    if (!line) return;
    const dated = parseDate(line, today);
    const rest = dated ? dated.rest : line;
    const money = rest.match(/([-+]?)\s*(\d[\d.,]*)\s*(?:TL|TRY|₺)?\s*([-+]?)\s*$/i);
    if (!money) return;
    const amount = parseAmountText(money[2]);
    if (!amount || amount <= 0) return;
    const title = rest.slice(0, money.index).replace(/\s{2,}/g, " ").replace(/[\s:;|-]+$/, "").trim();
    if (!title) return;
    const credit = money[1] === "-" || money[3] === "-" || money[1] === "+" || CREDIT.test(fold(title));
    rows.push({ key: String(index), title, amount: Math.round(amount * 100) / 100, date: dated?.date ?? todayKey, category: guessCategory(title), include: !credit, credit });
  });
  return rows;
}

/** The same purchase written twice: same day, same amount, same title without punctuation and Turkish letters. */
export const dupKey = (date, amount, title) => `${date}|${Number(amount).toFixed(2)}|${fold(title).replace(/[^a-z0-9]+/g, " ").trim()}`;

const round2 = (n) => Math.round(n * 100) / 100;
const alive = (x) => !x.deletedAt;

/**
 * A business entry from Finances counts in your personal budget when it came from your own pocket: nobody else is
 * written as the payer ("Aile" paid the groceries: not yours). Pending ones aren't money that moved yet.
 */
export const fromMyPocket = (e) => e.status !== "pending" && !String(e.paidBy ?? "").trim();

/**
 * One month of your money: your own rows and the business entries from your pocket, newest first, with totals.
 * `spent` is what left your pocket (personal + business paid by you), `income` what came in (business income
 * collected counts: a sole proprietor's income is the owner's), `invested` net money put into investments.
 */
export function monthView(transactions, businessEntries, month, lists = []) {
  const inMonth = (d) => String(d ?? "").startsWith(month);
  const personal = (x) => !x.ledger || x.ledger === "personal";
  const own = transactions.filter((x) => alive(x) && inMonth(x.date) && personal(x)).map((x) => ({ ...x, business: false }));
  // a budget's expense counts with your share in it, as Speys's Ledger shows the shared rows
  const budgets = new Map(lists.filter(alive).map((l) => [l.id, l]));
  for (const x of transactions.filter((x) => alive(x) && inMonth(x.date) && budgets.has(x.ledger))) {
    const list = budgets.get(x.ledger), me = list.members.find((m) => m.me);
    const mine = me ? sharesOf(list, x)[me.id] ?? 0 : 0;
    if (mine > 0) own.push({ ...x, kind: "expense", amount: mine, business: false, shared: { name: list.name, emoji: list.emoji, full: Number(x.amount), listId: list.id } });
  }
  const biz = (businessEntries ?? []).filter((e) => inMonth(e.entryDate) && fromMyPocket(e) && e.category !== "sermaye")
    .map((e) => ({ id: e.id, business: true, date: e.entryDate, title: e.title, amount: e.amount, kind: e.direction === "in" ? "income" : "expense", category: e.category, counterparty: e.counterparty, note: e.note, currency: e.currency, originalAmount: e.originalAmount }));
  const rows = [...own, ...biz].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const sum = (list) => round2(list.reduce((t, x) => t + Number(x.amount || 0), 0));
  const expenses = rows.filter((x) => x.kind === "expense"), incomes = rows.filter((x) => x.kind === "income");
  const inv = own.filter((x) => x.kind === "investment");
  const byCategory = new Map();
  for (const x of expenses) {
    const key = x.business ? "business" : x.category || "other";
    byCategory.set(key, round2((byCategory.get(key) ?? 0) + Number(x.amount)));
  }
  return {
    month,
    rows,
    spent: sum(expenses),
    businessSpent: sum(expenses.filter((x) => x.business)),
    income: sum(incomes),
    businessIncome: sum(incomes.filter((x) => x.business)),
    invested: round2(sum(inv.filter((x) => x.side !== "sell")) - sum(inv.filter((x) => x.side === "sell"))),
    byCategory: [...byCategory].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
  };
}

/** Months that have anything, newest first (for the month picker). */
export function monthsWithData(transactions, businessEntries) {
  const set = new Set();
  for (const x of transactions) if (alive(x) && x.date) set.add(x.date.slice(0, 7));
  for (const e of businessEntries ?? []) if (e.entryDate) set.add(e.entryDate.slice(0, 7));
  return [...set].sort().reverse();
}

/**
 * What you hold, per asset: units bought minus sold, money put in (buys) and taken out (sells) in TL, the last
 * price paid per unit. No market prices here: the value is what was paid.
 */
export function holdings(transactions) {
  const by = new Map();
  for (const x of transactions.filter((x) => alive(x) && x.kind === "investment" && x.asset)) {
    const h = by.get(x.asset) ?? { asset: x.asset, assetType: x.assetType ?? "other", units: 0, putIn: 0, takenOut: 0, first: x.date, last: x.date, count: 0, lastUnitPrice: null };
    const sell = x.side === "sell";
    h.units = round2(h.units + (sell ? -1 : 1) * Number(x.units || 0));
    if (sell) h.takenOut = round2(h.takenOut + Number(x.amount)); else h.putIn = round2(h.putIn + Number(x.amount));
    if (x.date < h.first) h.first = x.date;
    if (x.date >= h.last) { h.last = x.date; if (Number(x.units) > 0) h.lastUnitPrice = round2(Number(x.amount) / Number(x.units)); }
    h.count++;
    by.set(x.asset, h);
  }
  // more sold than bought: some buys (or free shares) aren't in the book
  return [...by.values()].map((h) => ({ ...h, net: round2(h.putIn - h.takenOut), open: h.units > 0.0001, missingBuys: h.units < -0.0001 }))
    .sort((a, b) => Number(b.open) - Number(a.open) || b.net - a.net);
}

// —— subscriptions: the renewal day, as Speys's (frontend subcenter/lib/yenileme.ts, backend budget/subscription-dates.ts)
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** The renewal day in month `m` (1-12) of a subscription started on `startDay`: the 31st is the month's last day. */
export const renewalDay = (startDay, y, m) => Math.min(startDay, lastDay(y, m));

/** The next renewal on or after `today` ("YYYY-MM-DD"); a subscription not started yet renews on its start day. */
export function nextRenewal(start, cycle, today) {
  if (start >= today) return start;
  const [sy, sm, sd] = start.split("-").map(Number);
  let [y, m] = today.split("-").map(Number);
  if (cycle === "yearly") {
    let at = ymd(y, sm, renewalDay(sd, y, sm));
    if (at < today) at = ymd(y + 1, sm, renewalDay(sd, y + 1, sm));
    return at;
  }
  let at = ymd(y, m, renewalDay(sd, y, m));
  if (at < today) { m += 1; if (m > 12) { m = 1; y += 1; } at = ymd(y, m, renewalDay(sd, y, m)); }
  return at;
}

/** Every renewal from `from` to `to` (both "YYYY-MM-DD"), oldest first. */
export function renewalsBetween(start, cycle, from, to) {
  const out = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  for (let y = sy, m = sm, guard = 0; guard < 600; guard++) {
    const at = ymd(y, m, renewalDay(sd, y, m));
    if (at > to) break;
    if (at >= from && at >= start) out.push(at);
    if (cycle === "yearly") y += 1; else { m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  return out;
}

export const TRIALS = { "1_week": [0, 0, 7], "1_month": [0, 1, 0], "3_months": [0, 3, 0], "6_months": [0, 6, 0], "1_year": [1, 0, 0] };
/** When a free trial ends ("YYYY-MM-DD"), or null without a trial. */
export function trialEnd(start, trial) {
  const add = TRIALS[trial];
  if (!add) return null;
  const [y, m, d] = start.split("-").map(Number);
  const t = new Date(Date.UTC(y + add[0], m - 1 + add[1], d + add[2]));
  return t.toISOString().slice(0, 10);
}
/** Whole days from one day to another. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** A subscription's price a month (a yearly one divided by twelve). */
export const monthlyPrice = (s) => (s.cycle === "yearly" ? s.price / 12 : s.price);

// —— shared budgets (Speys's projects, Tricount-style): who paid, each one's share, who pays whom
/**
 * Each member's paid, share and balance (paid − share; + is owed) from a budget's expenses. An expense's shares are
 * `{ memberId: amount }`; without them it is split equally among all members.
 */
export function balances(list, expenses) {
  const by = new Map(list.members.map((m) => [m.id, { ...m, paid: 0, share: 0 }]));
  for (const x of expenses.filter(alive)) {
    if (by.has(x.payerId)) by.get(x.payerId).paid += Number(x.amount);
    for (const [id, amount] of Object.entries(sharesOf(list, x))) if (by.has(id)) by.get(id).share += amount;
  }
  return [...by.values()].map((m) => ({ ...m, paid: round2(m.paid), share: round2(m.share), net: round2(m.paid - m.share) }));
}
/** An expense's shares; equal among the chosen members (or all) when not written. Cents go to the first ones. */
export function sharesOf(list, x) {
  if (x.shares && Object.keys(x.shares).length) return x.shares;
  const ids = (x.splitAmong?.length ? x.splitAmong : list.members.map((m) => m.id));
  const cents = Math.round(Number(x.amount) * 100), each = Math.floor(cents / ids.length);
  return Object.fromEntries(ids.map((id, i) => [id, (each + (i < cents - each * ids.length ? 1 : 0)) / 100]));
}
/** The fewest transfers that settle everyone: the largest debtor pays the largest creditor, again and again. */
export function settlements(bals) {
  const debt = bals.filter((b) => b.net < -0.005).map((b) => ({ ...b, left: -b.net })).sort((a, b) => b.left - a.left);
  const cred = bals.filter((b) => b.net > 0.005).map((b) => ({ ...b, left: b.net })).sort((a, b) => b.left - a.left);
  const out = [];
  for (let i = 0, j = 0; i < debt.length && j < cred.length;) {
    const amount = round2(Math.min(debt[i].left, cred[j].left));
    if (amount > 0) out.push({ from: debt[i], to: cred[j], amount });
    debt[i].left = round2(debt[i].left - amount); cred[j].left = round2(cred[j].left - amount);
    if (debt[i].left <= 0.005) i++;
    if (cred[j].left <= 0.005) j++;
  }
  return out;
}

/**
 * Everything in one table: your own rows, your budgets' expenses, the business ledger's entries. Each row says where it
 * is (`scope`: personal / budget name / business), what it is, who paid and the amount; newest first.
 */
export function allTransactions(book, businessEntries) {
  const lists = new Map((book.lists ?? []).filter(alive).map((l) => [l.id, l]));
  const own = (book.transactions ?? []).filter((x) => alive(x) && (!x.ledger || x.ledger === "personal" || lists.has(x.ledger))).map((x) => {
    const list = lists.get(x.ledger);
    const payer = list?.members.find((m) => m.id === x.payerId);
    return { id: x.id, date: x.date, title: x.title, kind: x.kind ?? "expense", side: x.side ?? null, category: x.kind === "investment" ? x.assetType : x.category, amount: Number(x.amount),
      scope: list ? "budget" : x.kind === "investment" ? "investment" : "personal", scopeName: list ? `${list.emoji ?? ""} ${list.name}`.trim() : null,
      paidBy: payer ? payer.name : x.paidBy ?? null, source: x.source ?? "manual", accountId: x.accountId ?? null };
  });
  const biz = (businessEntries ?? []).map((e) => ({ id: e.id, date: e.entryDate, title: e.title, kind: e.direction === "in" ? "income" : "expense", side: null, category: e.category, amount: Number(e.amount),
    scope: "business", scopeName: null, paidBy: e.paidBy ?? null, source: "business", status: e.status, vatRate: e.vatRate ?? null, counterparty: e.counterparty ?? null }));
  return [...own, ...biz].sort((a, b) => b.date.localeCompare(a.date));
}
