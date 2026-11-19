// Finances' personal side on the page, in Speys's design: the Ledger (frontend app/apps/budget/page.tsx: kind switch,
// month, summary with the category bar, day cards, the add sheet), Birikim's holdings (app/apps/birikim/page.tsx:
// the total card, assets grouped by type) and the statement page (app/apps/budget/menu/ekstre). Colours and sizes
// are Speys's (globals.css --app-*, ACCENT #6366F1). index.html calls mount() into its personal tab; this module keeps
// its own state and listens only inside that box (data-pk). Uses kit.js's globals (t, esc, LOCALE, notify, getJson).
import { CATEGORIES, INCOME_CATEGORIES, allTransactions, balances, daysBetween, holdings, monthView, monthlyPrice, nextRenewal, parseStatement, settlements, sharesOf, trialEnd } from "./personal-view.js";
import { PRESETS } from "./personal-presets.js";

const ACCENT = "#6366F1";
const KIND_COLOR = { expense: "#EF4444", income: "#10B981", investment: "#6366F1", transfer: "#94A3B8" };
const CATEGORY_COLOR = { market: "#10B981", food: "#F97316", cafe: "#B45309", transport: "#0EA5E9", bill: "#0D9488", health: "#EF4444", fun: "#8B5CF6", other: "#94A3B8", business: ACCENT };
const INCOME_COLOR = { salary: "#10B981", scholarship: "#0EA5E9", returns: "#8B5CF6", family: "#F97316", other: "#94A3B8" };
const ASSET_PICKER = [["sukuk", "📜"], ["fund", "🧺"], ["stock", "📊"], ["gold", "🪙"], ["foreign_currency", "💱"], ["other", "📦"]];
const ASSET_COLOR = { sukuk: "#0D9488", fund: "#6366F1", stock: "#F97316", gold: "#EAB308", foreign_currency: "#0EA5E9", other: "#94A3B8" };
const ASSET_NAME = { sukuk: t("Lease certificate"), fund: t("Fund"), stock: t("Stock"), gold: t("Gold"), foreign_currency: t("Foreign currency"), deposit: t("Deposit"), other: t("Other") };
const ACCOUNT_KIND = { card: t("Card"), bank: t("Bank account"), cash: t("Cash"), wallet: t("Wallet"), investment: t("Investment account") };
const assetKey = (k) => (ASSET_PICKER.some(([id]) => id === k) ? k : "other");
const assetEmoji = (k) => ASSET_PICKER.find(([id]) => id === assetKey(k))[1];
const cat = (id) => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES.at(-1);
const inc = (id) => INCOME_CATEGORIES.find((c) => c.id === id) ?? INCOME_CATEGORIES.at(-1);
const money = (n) => new Intl.NumberFormat(LOCALE, { style: "currency", currency: "TRY", maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(+n || 0);
const todayIso = () => new Date().toLocaleDateString("sv-SE");
const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(LOCALE, { day: "numeric", month: "long", weekday: "long" });
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(LOCALE, { month: "long", year: "numeric" });
const shiftMonth = (m, by) => { const d = new Date(`${m}-01T00:00:00`); d.setMonth(d.getMonth() + by); return d.toLocaleDateString("sv-SE").slice(0, 7); };

let box = null, tab = "harcamalar", month = todayIso().slice(0, 7);
let book = null, business = null, error = "";
let company = null;        // the business ledger's month as the page has it (/api/kasa): summary, tax, upcoming, pending
let categoryName = (k) => k; // the business categories' names, from the page
let listId = null;         // the shared budget open (#kasa/butce/<id>)
let budgetTab = "expenses"; // inside a budget: expenses / balances
let filter = { scope: "all", q: "", shown: 150 }; // the all-transactions table
let kind = "all";          // the Ledger's switch: all / expense / income / investment
let sheet = null;          // the add / edit sheet: { kind, record, side, category, assetType }
let statement = { text: "", accountId: "" };

export async function mount(el, opts) {
  const changed = el !== box;
  if (opts.month && !box) month = opts.month; // after that the personal side keeps its own month
  box = el; tab = opts.tab; company = opts.company ?? null;
  if (opts.categoryName) categoryName = opts.categoryName;
  listId = tab === "butce" ? decodeURIComponent(location.hash.slice(1)).split("/")[2] || null : null;
  if (changed) { style(); listen(el); }
  if (!book) await load(); else draw();
}

async function load() {
  try { book = await getJson("./api/kisisel"); error = ""; } catch (e) { error = e.message; }
  try { business = (await getJson("./api/islemler")).entries; } catch { business = []; }
  draw();
}

async function post(path, body) {
  const r = await fetch(`./api/kisisel/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-panel": "1" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || t("Could not save ({status})", { status: r.status }));
  return d.ok;
}

const seg = (items, active, act) => `<div class="pk-seg">${items.map(([id, label]) => `<button type="button" data-pk="${act}" data-v="${id}" aria-pressed="${id === active}" class="${id === active ? "on" : ""}">${esc(label)}</button>`).join("")}</div>`;

// —— the Ledger
function rowKind(x) { return x.kind ?? "expense"; }
function groupOf(x) {
  const k = rowKind(x);
  if (k === "income") return x.category in INCOME_COLOR ? x.category : "other";
  if (k === "investment") return assetKey(x.assetType);
  return x.business ? "business" : cat(x.category).id;
}
function groupColor(k, g) { return k === "income" ? INCOME_COLOR[g] : k === "investment" ? ASSET_COLOR[g] : CATEGORY_COLOR[g]; }
function groupLabel(k, g) { return k === "income" ? t(inc(g).label) : k === "investment" ? ASSET_NAME[g] : g === "business" ? t("Business") : t(cat(g).label); }
function rowEmoji(x) {
  const k = rowKind(x);
  return k === "income" ? inc(x.category).emoji : k === "investment" ? assetEmoji(x.assetType) : k === "transfer" ? "⇄" : x.business ? "💼" : cat(x.category).emoji;
}

function ledgerScreen() {
  const v = monthView(book.transactions, business, month, book.lists ?? []);
  const active = kind;
  const rows = v.rows.filter((x) => active === "all" || rowKind(x) === active);
  // the bar: expenses by category in "all" and "expense", income by type, investments by asset type
  const barKind = active === "all" ? "expense" : active;
  const groups = new Map();
  for (const x of rows.filter((x) => rowKind(x) === barKind && !(barKind === "investment" && x.side === "sell"))) groups.set(groupOf(x), (groups.get(groupOf(x)) ?? 0) + Number(x.amount));
  const byGroup = [...groups].sort((a, b) => b[1] - a[1]);
  const groupSum = byGroup.reduce((a, [, n]) => a + n, 0);
  const shown = active === "expense" ? v.spent : active === "income" ? v.income : active === "investment" ? v.invested : 0;
  const days = [];
  for (const x of rows) { if (days.at(-1)?.key !== x.date) days.push({ key: x.date, rows: [] }); days.at(-1).rows.push(x); }
  const dayTotal = (list) => active === "all"
    ? list.reduce((a, r) => { const k = rowKind(r); if (k === "transfer") return a; const plus = k === "income" || (k === "investment" && r.side === "sell"); return a + (plus ? r.amount : -r.amount); }, 0)
    : list.reduce((a, r) => a + Number(r.amount), 0);
  const empty = { all: [t("Nothing this month."), t("Add with +.")], expense: [t("No expenses this month"), t("Add a purchase with +.")], income: [t("No income this month"), t("Add a salary, a scholarship or investment returns with +.")], investment: [t("No investments this month"), t("Add a buy or a sell with +.")] }[active];
  return `<div class="pk-col pk-defter"><div class="pk-sol">
    <div class="pk-ust">
      ${seg([["all", t("Activity")], ["expense", t("Spending")], ["income", t("Income")], ["investment", t("Investment")]], active, "kind")}
      <button type="button" class="pk-ikon" data-pk="add" aria-label="${esc(t("Add"))}">＋</button>
    </div>
    <div class="pk-ay"><button type="button" data-pk="month" data-v="-1" aria-label="${esc(t("Previous month"))}">‹</button><span>${esc(monthLabel(month))}</span><button type="button" data-pk="month" data-v="1" aria-label="${esc(t("Next month"))}">›</button></div>
    <div class="pk-kart pk-ozet">
      ${active === "all" ? `<div class="pk-akis">
          ${[["in", t("In"), v.income, KIND_COLOR.income], ["out", t("Spent"), v.spent, KIND_COLOR.expense], ["invested", t("Invested"), v.invested, KIND_COLOR.investment]].map(([, label, n, color]) => `<div><div class="pk-etiket" style="color:${color}">${esc(label)}</div><div class="pk-akis-n">${money(n)}</div></div>`).join("")}
          <div class="pk-kalan">${esc(t("Left"))} <b>${money(v.income - v.spent - v.invested)}</b>${v.businessSpent ? ` · ${esc(t("{amount} of the spending is business", { amount: money(v.businessSpent) }))}` : ""}</div>
        </div>` : `<div class="pk-buyuk">${money(shown)}</div>`}
      ${groupSum > 0 ? `<div class="pk-cubuk">${byGroup.map(([g, n]) => `<span style="width:${(n / groupSum) * 100}%;background:${groupColor(barKind, g)}"></span>`).join("")}</div>
        <div class="pk-anahtar">${byGroup.map(([g, n]) => `<div><i style="background:${groupColor(barKind, g)}"></i>${esc(groupLabel(barKind, g))} <b>${money(n)}</b></div>`).join("")}</div>` : ""}
    </div>
    </div><div class="pk-sag">
    ${days.length ? days.map((d) => { const n = dayTotal(d.rows); return `<div class="pk-gun">
      <div class="pk-gun-bas"><span>${esc(dayLabel(d.key))}</span><span>${active === "all" && n > 0 ? "+" : ""}${money(n)}</span></div>
      <div class="pk-kart pk-liste">${d.rows.map((x) => rowHtml(x)).join("")}</div></div>`; }).join("")
      : `<div class="pk-bos"><b>${esc(empty[0])}</b><span>${esc(empty[1])}</span></div>`}
  </div></div>`;
}

function rowHtml(x) {
  const k = rowKind(x);
  const sub = x.shared ? `<b style="color:${ACCENT}">${esc(x.shared.emoji ?? "")} ${esc(x.shared.name)}</b> · ${esc(t("total"))} ${money(x.shared.full)}`
    : x.source === "subscription" ? `<b style="color:#0D9488">${esc(t("Subscription"))}</b>${x.originalAmount && x.currency && x.currency !== "TRY" ? ` · ${esc(x.originalAmount)} ${esc(x.currency)}` : ""}`
    : x.business ? `<b style="color:#64748B">${esc(t("Company"))}</b>${x.counterparty ? ` · ${esc(x.counterparty)}` : ""}${x.originalAmount && x.currency && x.currency !== "TRY" ? ` · ${esc(x.originalAmount)} ${esc(x.currency)}` : ""}`
    : k === "transfer" ? `<b>${esc(t("Transfer"))}</b>`
    : k === "investment" ? `<b ${x.side === "sell" ? 'class="pk-yesil"' : ""}>${esc(x.side === "sell" ? t("Sell") : t("Buy"))}</b> · ${esc(new Intl.NumberFormat(LOCALE).format(x.units ?? 0))} · ${esc(ASSET_NAME[assetKey(x.assetType)])}`
    : esc(k === "income" ? t(inc(x.category).label) : t(cat(x.category).label));
  const plus = k === "income" || (k === "investment" && x.side === "sell");
  const edge = x.shared ? ACCENT : x.source === "subscription" ? "#0D9488" : x.business ? "#64748B" : "transparent";
  const open = x.business ? `data-pk="open-business"` : x.shared ? `data-pk="open-list" data-id="${esc(x.shared.listId)}"` : `data-pk="edit" data-id="${esc(x.id)}"`;
  return `<div class="pk-satir ${k === "transfer" ? "soluk" : ""}" ${open}>
    <i class="pk-kenar" style="background:${edge}"></i>
    <span class="pk-emoji">${rowEmoji(x)}</span>
    <span class="pk-ad"><span>${esc(x.title)}</span><small>${sub}</small></span>
    <span class="pk-tutar ${plus ? "pk-yesil" : ""} ${k === "transfer" ? "pk-soluk" : ""}">${plus ? "+" : ""}${money(x.amount)}${x.paidBy ? `<small>${esc(t("paid by {name}", { name: x.paidBy }))}</small>` : ""}</span>
  </div>`;
}

// —— the add / edit sheet (Speys's Drawer)
function sheetHtml() {
  const s = sheet, x = s.record ?? {};
  const field = (label, input) => `<label class="pk-alan"><span>${esc(label)}</span>${input}</label>`;
  const accountSelect = `<label class="pk-secim"><span>${esc(t("Account"))}</span><select name="accountId"><option value="">${esc(t("not set"))}</option>${book.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === (x.accountId ?? book.accounts[0]?.id) ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>`;
  const date = `<label class="pk-secim"><span>${esc(t("Date"))}</span><input type="date" name="date" required value="${esc(x.date ?? (todayIso().startsWith(month) ? todayIso() : `${month}-01`))}"></label>`;
  let body = "";
  if (s.kind === "expense") {
    body = field(t("What did you buy?"), `<input name="title" required value="${esc(x.title ?? "")}" placeholder="${esc(t("Groceries"))}" autofocus>`)
      + field(t("Amount"), `<input name="amount" class="pk-n" inputmode="decimal" required value="${x.amount ?? ""}" placeholder="0">`)
      + `<div class="pk-alt-baslik">${esc(t("Category"))}</div><div class="pk-emojiler">${CATEGORIES.map((c) => `<button type="button" data-pk="pick" data-f="category" data-v="${c.id}" class="${c.id === s.category ? "on" : ""}" title="${esc(t(c.label))}">${c.emoji}</button>`).join("")}</div>`
      + `<div class="pk-iki">${date}${accountSelect}</div>`
      + `<label class="pk-secim"><span>${esc(t("Paid by someone else"))}</span><input name="paidBy" value="${esc(x.paidBy ?? "")}" placeholder="${esc(t("me"))}"></label>`;
  } else if (s.kind === "income") {
    body = field(t("What was the income?"), `<input name="title" value="${esc(x.title ?? "")}" placeholder="${esc(t(inc(s.category).label))}" autofocus>`)
      + field(t("Amount"), `<input name="amount" class="pk-n" inputmode="decimal" required value="${x.amount ?? ""}" placeholder="0">`)
      + `<div class="pk-cipler">${INCOME_CATEGORIES.map((c) => `<button type="button" data-pk="pick" data-f="category" data-v="${c.id}" class="${c.id === s.category ? "on" : ""}"><span>${c.emoji}</span>${esc(t(c.label))}</button>`).join("")}</div>`
      + `<div class="pk-iki">${date}${accountSelect}</div>`;
  } else {
    const assets = [...new Set(book.transactions.filter((y) => y.kind === "investment").map((y) => y.asset))].sort();
    body = seg([["buy", t("Buy")], ["sell", t("Sell")]], s.side, "side")
      + `<label class="pk-secim"><span>${esc(t("Asset"))}</span><input name="asset" list="pk-varliklar" required value="${esc(x.asset ?? "")}" placeholder="${esc(t("Asset name (KPA, TUPRS, TRD…)"))}" style="text-transform:uppercase"><datalist id="pk-varliklar">${assets.map((a) => `<option value="${esc(a)}">`).join("")}</datalist></label>`
      + `<div class="pk-cipler">${ASSET_PICKER.map(([id, e]) => `<button type="button" data-pk="pick" data-f="assetType" data-v="${id}" class="${id === s.assetType ? "on" : ""}"><span>${e}</span>${esc(ASSET_NAME[id])}</button>`).join("")}</div>`
      + `<div class="pk-iki">${field(t("Units / nominal"), `<input name="units" class="pk-n2" inputmode="decimal" value="${x.units ?? ""}" placeholder="0">`)}${field(t("TL amount"), `<input name="amount" class="pk-n2" inputmode="decimal" required value="${x.amount ?? ""}" placeholder="0">`)}</div>`
      + `<div class="pk-iki">${date}${accountSelect}</div>`;
  }
  const title = x.id ? t("Edit") : s.kind === "expense" ? t("Add") : s.kind === "income" ? t("Add income") : t("Add investment");
  return `<div class="pk-perde" data-pk="close-sheet"></div>
    <form class="pk-cekmece" data-pk-form="tx"><div class="pk-tutamac"></div>
      <div class="pk-cekmece-bas"><b>${esc(title)}</b><button type="button" class="pk-ikon" data-pk="close-sheet" aria-label="${esc(t("Close"))}">✕</button></div>
      ${x.id ? "" : seg([["expense", t("Spending")], ["income", t("Income")], ["investment", t("Investment")]], s.kind, "sheet-kind")}
      ${body}
      <label class="pk-secim"><span>${esc(t("Note"))}</span><input name="note" value="${esc(x.note ?? "")}"></label>
      <button class="pk-kaydet">${esc(t("Save"))}</button>
      ${x.id ? `<button type="button" class="pk-sil" data-pk="delete" data-id="${esc(x.id)}">${esc(t("Delete"))}</button>` : `<a class="pk-sil pk-ikincil" href="#kasa/ekstre" data-pk="close-sheet-go">${esc(t("Or paste a bank statement"))}</a>`}
    </form>`;
}


// —— shared budgets (Speys's Bütçe tab: app/apps/budget/paylasimli, project): a trip, the house, an event
const PINK = "#EC4899";
const LIST_EMOJIS = ["🏖️", "🏠", "🎟️", "🚗", "🍔", "🛒", "🛍️", "🍿", "⛺", "💵", "🏔️", "✈️", "🚢", "🎉", "💼", "🎓", "🏥", "🚲", "🎸", "⚽"];
const LIST_KIND = { trip: t("Trip"), home: t("Home expenses"), event: t("Event"), other: t("Other") };
const listsOf = () => (book.lists ?? []);
const listExpenses = (id) => book.transactions.filter((x) => x.ledger === id);
const rangeLabel = (a, b) => [a, b].filter(Boolean).map((d) => new Date(`${d}T00:00:00`).toLocaleDateString(LOCALE, { day: "numeric", month: "short" })).join(" – ");
function budgetsScreen() {
  const lists = [...listsOf()].sort((a, b) => (b.startDate || b.createdAt).localeCompare(a.startDate || a.createdAt));
  return `<div class="pk-col">
    ${lists.length ? `<div class="pk-butceler">${lists.map((l) => {
      const me = l.members.find((m) => m.me), mine = balances(l, listExpenses(l.id)).find((m) => m.id === me?.id)?.share ?? 0;
      return `<a class="pk-kart pk-butce" href="#kasa/butce/${esc(l.id)}"><span class="pk-butce-emoji">${esc(l.emoji)}</span>
        <span class="pk-ad"><span>${esc(l.name)}</span><small>👥 ${l.members.length} ${esc(t("participants"))}${rangeLabel(l.startDate, l.endDate) ? ` · ${esc(rangeLabel(l.startDate, l.endDate))}` : ""}</small></span>
        ${mine > 0 ? `<b class="pk-tutar">${money(mine)}</b>` : ""}<span class="pk-ok">›</span></a>`;
    }).join("")}</div>` : `<div class="pk-kart pk-bos-buyuk"><span>🏖️</span><b>${esc(t("You haven't made a budget yet"))}</b><small>${esc(t("A trip, the house, an event: who paid what, and who pays whom at the end."))}</small></div>`}
    <div class="pk-fab"><button type="button" data-pk="list-new" style="background:${PINK}" aria-label="${esc(t("New budget"))}">＋</button><span>${esc(t("New budget"))}</span></div>
  </div>`;
}
function budgetScreen() {
  const l = listsOf().find((x) => x.id === listId);
  if (!l) return `<div class="pk-col"><div class="pk-bos"><b>${esc(t("Budget not found"))}</b></div></div>`;
  const xs = listExpenses(l.id).sort((a, b) => b.date.localeCompare(a.date));
  const bal = balances(l, xs), me = bal.find((m) => m.me) ?? bal[0];
  const days = [];
  for (const x of xs) { if (days.at(-1)?.key !== x.date) days.push({ key: x.date, rows: [] }); days.at(-1).rows.push(x); }
  const name = (id) => l.members.find((m) => m.id === id)?.name ?? "?";
  const body = budgetTab === "balances"
    ? `<div class="pk-kart pk-varlik"><span class="pk-varlik-ikon">💸</span><span class="pk-ad"><small style="text-transform:uppercase;font-weight:700;letter-spacing:.06em">${esc(t("Net status"))}</small>
        <span style="color:${Math.abs(me.net) < 0.01 ? "var(--a-muted)" : me.net > 0 ? "#10B981" : "#EF4444"};font-weight:800">${Math.abs(me.net) < 0.01 ? esc(t("You're settled up")) : me.net > 0 ? `${esc(t("You are owed"))}: ${money(me.net)}` : `${esc(t("Your debt"))}: ${money(-me.net)}`}</span></span></div>
      ${settlements(bal).length ? `<div class="pk-gun-bas"><span>${esc(t("Suggested transfers"))}</span></div>${settlements(bal).map((s) => `<div class="pk-kart pk-transfer"><b>${esc(s.from.name)}</b><span style="color:${PINK}">→</span><b>${esc(s.to.name)}</b><span class="pk-tutar" style="color:${PINK};margin-left:auto">${money(s.amount)}</span></div>`).join("")}` : ""}
      <div class="pk-gun-bas"><span>${esc(t("Balances"))}</span></div>
      ${bal.map((m) => `<div class="pk-kart pk-varlik"><span class="pk-uye">${esc(m.name.slice(0, 2).toUpperCase())}</span><span class="pk-ad"><span>${esc(m.name)}${m.me ? ` <small>(${esc(t("me"))})</small>` : ""}</span><small>${esc(t("paid {a} · share {b}", { a: money(m.paid), b: money(m.share) }))}</small></span><span class="pk-tutar ${m.net > 0.005 ? "pk-yesil" : ""}" ${m.net < -0.005 ? 'style="color:#EF4444"' : ""}>${m.net > 0.005 ? "+" : ""}${money(m.net)}</span></div>`).join("")}`
    : days.length ? days.map((d) => `<div class="pk-gun"><div class="pk-gun-bas"><span>${esc(dayLabel(d.key))}</span></div>${d.rows.map((x) => `<div class="pk-kart pk-varlik pk-tik-satir" data-pk="list-expense-edit" data-id="${esc(x.id)}"><span class="pk-varlik-ikon">${cat(x.category).emoji}</span>
        <span class="pk-ad"><span>${esc(x.title)}</span><small>${esc(t("Total"))}: ${money(x.amount)}, ${x.payerId === me.id ? esc(t("you paid")) : esc(t("{name} paid", { name: name(x.payerId) }))}</small></span><b class="pk-tutar">${money(sharesOf(l, x)[me.id] ?? 0)}</b></div>`).join("")}</div>`).join("")
    : `<div class="pk-bos"><b>${esc(t("No expenses yet"))}</b><span>${esc(t("Add the first one with +."))}</span></div>`;
  return `<div class="pk-col pk-defter pk-butce-ic"><div class="pk-sol">
    <div class="pk-ust"><a class="pk-ikon" href="#kasa/butce" aria-label="${esc(t("Back"))}" style="color:${PINK}">‹</a><span class="pk-baslik">${esc(t("Budgets"))}</span>
      <button type="button" class="pk-ikon" data-pk="list-edit" aria-label="${esc(t("Edit"))}">✎</button></div>
    <div class="pk-butce-bas"><span>${esc(l.emoji)}</span><b>${esc(l.name)}</b><small>${esc(LIST_KIND[l.kind] ?? "")}${rangeLabel(l.startDate, l.endDate) ? ` · ${esc(rangeLabel(l.startDate, l.endDate))}` : ""}</small></div>
    ${l.members.length > 1 ? `<div class="pk-seg pk-seg-tam">${[["expenses", t("Expenses")], ["balances", t("Balances")]].map(([id, label]) => `<button type="button" data-pk="budget-tab" data-v="${id}" class="${budgetTab === id ? "on" : ""}">${esc(label)}</button>`).join("")}</div>` : ""}
    <div class="pk-kart pk-iki-ozet"><div><small>${esc(t("I paid"))}</small><b>${money(me.paid)}</b></div><i></i><div><small>${esc(t("My share"))}</small><b>${money(me.share)}</b></div></div>
    </div><div class="pk-sag">${body}</div>
    <div class="pk-fab"><button type="button" data-pk="list-expense-new" style="background:${PINK}" aria-label="${esc(t("Add expense"))}">＋</button><span>${esc(t("Add expense"))}</span></div>
  </div>`;
}
function listSheet() {
  const l = sheet.list ?? {}, members = sheet.members;
  return `<div class="pk-perde" data-pk="close-sheet"></div>
    <form class="pk-cekmece" data-pk-form="list"><div class="pk-tutamac"></div>
      <div class="pk-cekmece-bas"><b><span style="color:${PINK}">${esc(sheet.emoji)}</span> ${esc(l.id ? t("Edit budget") : t("New budget"))}</b><button type="button" class="pk-ikon" data-pk="close-sheet" aria-label="${esc(t("Close"))}">✕</button></div>
      <div class="pk-alt-baslik">${esc(t("Choose an icon"))}</div>
      <div class="pk-emojiler">${LIST_EMOJIS.map((e) => `<button type="button" data-pk="pick" data-f="emoji" data-v="${e}" class="${e === sheet.emoji ? "on" : ""}">${e}</button>`).join("")}</div>
      <label class="pk-secim"><span>${esc(t("Title"))}</span><input name="name" required value="${esc(l.name ?? "")}" placeholder="${esc(t("For example: city trip, New Year"))}" autofocus></label>
      <div class="pk-iki"><label class="pk-secim"><span>${esc(t("Group type"))}</span><select name="kind">${Object.entries(LIST_KIND).map(([k, v]) => `<option value="${k}" ${k === (l.kind ?? "trip") ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label><span></span></div>
      <div class="pk-iki"><label class="pk-secim"><span>${esc(t("Start (optional)"))}</span><input type="date" name="startDate" value="${esc(l.startDate ?? "")}"></label><label class="pk-secim"><span>${esc(t("End (optional)"))}</span><input type="date" name="endDate" value="${esc(l.endDate ?? "")}"></label></div>
      <div class="pk-alt-baslik">${esc(t("Participants"))}</div>
      <div class="pk-kart pk-uyeler">${members.map((m, i) => `<div><span class="pk-uye">${esc(m.name.slice(0, 2).toUpperCase())}</span><span>${esc(m.name)}${m.me ? ` (${esc(t("me"))})` : ""}</span>${m.me ? "" : `<button type="button" class="pk-kucuk" data-pk="member-remove" data-v="${i}">✕</button>`}</div>`).join("")}
        <div class="pk-uye-ekle"><input data-pk-guest placeholder="${esc(t("Guest name…"))}"><button type="button" class="pk-kucuk" data-pk="member-add">${esc(t("Add"))}</button></div></div>
      <button class="pk-kaydet" style="background:${PINK}">${esc(l.id ? t("Save") : t("Create budget"))}</button>
      ${l.id ? `<button type="button" class="pk-sil" data-pk="list-delete">${esc(t("Delete budget"))}</button>` : ""}
    </form>`;
}
function listExpenseSheet() {
  const l = listsOf().find((x) => x.id === listId), x = sheet.record ?? {};
  const me = l.members.find((m) => m.me);
  const among = new Set(sheet.among ?? x.splitAmong ?? l.members.map((m) => m.id));
  return `<div class="pk-perde" data-pk="close-sheet"></div>
    <form class="pk-cekmece" data-pk-form="list-expense"><div class="pk-tutamac"></div>
      <div class="pk-cekmece-bas"><b>${esc(x.id ? t("Edit") : t("Add expense"))}</b><button type="button" class="pk-ikon" data-pk="close-sheet" aria-label="${esc(t("Close"))}">✕</button></div>
      <label class="pk-alan"><span>${esc(t("What was it?"))}</span><input name="title" required value="${esc(x.title ?? "")}" autofocus></label>
      <label class="pk-alan"><span>${esc(t("Amount"))}</span><input name="amount" class="pk-n" inputmode="decimal" required value="${x.amount ?? ""}" placeholder="0"></label>
      <div class="pk-emojiler">${CATEGORIES.map((c) => `<button type="button" data-pk="pick" data-f="category" data-v="${c.id}" class="${c.id === sheet.category ? "on" : ""}" title="${esc(t(c.label))}">${c.emoji}</button>`).join("")}</div>
      <div class="pk-iki"><label class="pk-secim"><span>${esc(t("Who paid"))}</span><select name="payerId">${l.members.map((m) => `<option value="${esc(m.id)}" ${m.id === (x.payerId ?? me?.id) ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
        <label class="pk-secim"><span>${esc(t("Date"))}</span><input type="date" name="date" required value="${esc(x.date ?? todayIso())}"></label></div>
      <div class="pk-alt-baslik">${esc(t("Split equally among"))}</div>
      <div class="pk-cipler">${l.members.map((m) => `<button type="button" data-pk="among" data-v="${esc(m.id)}" class="${among.has(m.id) ? "on" : ""}">${esc(m.name)}</button>`).join("")}</div>
      <button class="pk-kaydet" style="background:${PINK}">${esc(t("Save"))}</button>
      ${x.id ? `<button type="button" class="pk-sil" data-pk="delete" data-id="${esc(x.id)}">${esc(t("Delete"))}</button>` : ""}
    </form>`;
}

// —— subscriptions (Speys's Subcenter): free trials and active ones; a renewal writes to the Ledger by itself
const BLUE = "#339AF0";
const PRESET_CAT = { Entertainment: t("Entertainment"), Music: t("Music"), AI: t("AI"), Software: t("Software"), Productivity: t("Productivity"), Other: t("Other") };
const TRIAL_NAME = { "1_week": t("1 week"), "1_month": t("1 month"), "3_months": t("3 months"), "6_months": t("6 months"), "1_year": t("1 year") };
function subCard(s) {
  const today = todayIso(), end = trialEnd(s.startDate, s.trial), inTrial = end && end > today;
  const next = nextRenewal(s.startDate, s.cycle, today), left = daysBetween(today, inTrial ? end : next);
  const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(LOCALE, { day: "numeric", month: "long" });
  const price = s.currency === "TRY" ? money(s.price) : new Intl.NumberFormat(LOCALE, { style: "currency", currency: s.currency }).format(s.price);
  return `<div class="pk-kart pk-abone">
    <div class="pk-abone-ust"><span class="pk-varlik-ikon" ${s.color ? `style="color:${s.color}"` : ""}>${esc(s.icon ?? "💳")}</span>
      <span class="pk-ad"><span>${esc(s.name)}${s.plan ? ` <small>(${esc(s.plan)})</small>` : ""}</span><small class="pk-abone-kat">${esc(PRESET_CAT[s.category] ?? s.category)}</small></span>
      <span class="pk-tutar">${price}<small>/${esc(s.cycle === "yearly" ? t("yearly") : t("monthly"))}</small></span></div>
    <div class="pk-abone-alt"><span>📅 ${inTrial ? `${esc(t("Trial ends:"))} ${esc(day(end))} <i class="pk-rozet sari">${esc(t("{n} days left", { n: left }))}</i>` : `${esc(t("Renewal:"))} ${esc(day(next))} <i class="pk-rozet">${esc(t("{n} days left", { n: left }))}</i>`}</span>
      <span><button type="button" class="pk-kucuk" data-pk="sub-edit" data-id="${esc(s.id)}" aria-label="${esc(t("Edit"))}">✎</button><button type="button" class="pk-kucuk" data-pk="sub-delete" data-id="${esc(s.id)}" aria-label="${esc(t("Delete"))}">🗑</button></span></div>
  </div>`;
}
function subsScreen() {
  const subs = (book.subscriptions ?? []), today = todayIso();
  const trials = subs.filter((s) => { const e = trialEnd(s.startDate, s.trial); return e && e > today; });
  const active = subs.filter((s) => !trials.includes(s));
  const monthly = active.filter((s) => s.currency === "TRY").reduce((a, s) => a + monthlyPrice(s), 0);
  return `<div class="pk-col pk-abonelikler">
    <div class="pk-ust"><span class="pk-baslik">${esc(t("Subscriptions"))}</span><button type="button" class="pk-ikon" data-pk="sub-new" style="color:${BLUE}" aria-label="${esc(t("Add subscription"))}">＋</button></div>
    ${subs.length ? `<div class="pk-kart pk-iki-ozet"><div><small>${esc(t("A month"))}</small><b>${money(monthly)}</b></div><i></i><div><small>${esc(t("A year"))}</small><b>${money(monthly * 12)}</b></div></div>
      ${trials.length ? `<div class="pk-gun-bas"><span>${esc(t("Free trials"))} (${trials.length})</span></div><div class="pk-kartlar">${trials.map(subCard).join("")}</div>` : ""}
      ${active.length ? `<div class="pk-gun-bas"><span>${esc(t("Active subscriptions"))} (${active.length})</span></div><div class="pk-kartlar">${active.map(subCard).join("")}</div>` : ""}
      <p class="pk-ipucu">${esc(t("On its renewal day a subscription is written to your Ledger by itself."))}</p>`
    : `<div class="pk-kart pk-bos-buyuk"><span class="pk-ornek">${PRESETS.filter((p, i, a) => a.findIndex((q) => q.name === p.name) === i).slice(0, 6).map((p) => `<i style="color:${p.color}">${p.icon}</i>`).join("")}</span><b>${esc(t("No subscriptions yet"))}</b><small>${esc(t("Add Netflix, Spotify, ChatGPT…: you see when each renews, and it goes to your Ledger by itself."))}</small></div>`}
  </div>`;
}
function subSheet() {
  const x = sheet.record ?? {};
  const cats = [...new Set(PRESETS.map((p) => p.category))];
  return `<div class="pk-perde" data-pk="close-sheet"></div>
    <form class="pk-cekmece" data-pk-form="sub"><div class="pk-tutamac"></div>
      <div class="pk-cekmece-bas"><b>${esc(x.id ? t("Edit subscription") : t("Add subscription"))}</b><button type="button" class="pk-ikon" data-pk="close-sheet" aria-label="${esc(t("Close"))}">✕</button></div>
      ${x.id ? "" : cats.map((c) => `<div class="pk-alt-baslik">${esc(PRESET_CAT[c] ?? c)}</div><div class="pk-cipler">${PRESETS.map((p, i) => [p, i]).filter(([p]) => p.category === c).map(([p, i]) => `<button type="button" data-pk="preset" data-v="${i}"><span>${p.icon}</span>${esc(p.name)} <small>${esc(p.plan)}</small></button>`).join("")}</div>`).join("")}
      <div class="pk-iki"><label class="pk-secim"><span>${esc(t("Name"))}</span><input name="name" required value="${esc(x.name ?? "")}"></label><label class="pk-secim"><span>${esc(t("Plan"))}</span><input name="plan" value="${esc(x.plan ?? "")}"></label></div>
      <div class="pk-iki"><label class="pk-alan"><span>${esc(t("Price"))}</span><input name="price" class="pk-n2" inputmode="decimal" required value="${x.price ?? ""}" placeholder="0"></label>
        <label class="pk-secim"><span>${esc(t("Currency"))}</span><select name="currency">${["TRY", "USD", "EUR", "GBP"].map((c) => `<option ${c === (x.currency ?? "TRY") ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
      <div class="pk-iki"><label class="pk-secim"><span>${esc(t("Every"))}</span><select name="cycle"><option value="monthly">${esc(t("month"))}</option><option value="yearly" ${x.cycle === "yearly" ? "selected" : ""}>${esc(t("year"))}</option></select></label>
        <label class="pk-secim"><span>${esc(t("Started on"))}</span><input type="date" name="startDate" required value="${esc(x.startDate ?? todayIso())}"></label></div>
      <label class="pk-secim"><span>${esc(t("Free trial"))}</span><select name="trial"><option value="">${esc(t("none"))}</option>${Object.entries(TRIAL_NAME).map(([k, v]) => `<option value="${k}" ${k === x.trial ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
      <input type="hidden" name="icon" value="${esc(x.icon ?? "")}"><input type="hidden" name="color" value="${esc(x.color ?? "")}"><input type="hidden" name="category" value="${esc(x.category ?? "Other")}">
      <button class="pk-kaydet" style="background:${BLUE}">${esc(t("Save"))}</button>
    </form>`;
}

// —— everything in one table (one database, one table: the plan in data/product/features/finans)
const SCOPE = { personal: t("Personal"), business: t("Company"), budget: t("Budget"), investment: t("Investment") };
function allScreen() {
  const rows = allTransactions(book, business);
  const q = fold(filter.q);
  const shown = rows.filter((r) => (filter.scope === "all" || r.scope === filter.scope) && (!q || fold(`${r.title} ${r.scopeName ?? ""} ${r.paidBy ?? ""} ${r.counterparty ?? ""}`).includes(q)));
  const label = (r) => r.scope === "business" ? categoryName(r.category) : r.kind === "investment" ? ASSET_NAME[assetKey(r.category)] : r.kind === "income" ? t(inc(r.category).label) : t(cat(r.category).label);
  const sign = (r) => (r.kind === "income" || (r.kind === "investment" && r.side === "sell") ? "+" : r.kind === "transfer" ? "" : "−");
  return `<div class="pk-col pk-genis">
    <div class="pk-ust pk-tablo-ust">${seg([["all", t("All")], ["personal", t("Personal")], ["business", t("Company")], ["budget", t("Budget")], ["investment", t("Investment")]], filter.scope, "scope")}
      <input class="pk-ara" data-pk-q value="${esc(filter.q)}" placeholder="${esc(t("Search"))}"></div>
    <div class="pk-gun-bas"><span>${esc(t("{n} transactions", { n: shown.length }))}</span></div>
    <div class="pk-kart pk-tablo-kap"><table class="pk-tablo">
      <thead><tr><th>${esc(t("Date"))}</th><th>${esc(t("Title"))}</th><th>${esc(t("Where"))}</th><th class="gz">${esc(t("Category"))}</th><th class="gz">${esc(t("Paid by"))}</th><th class="say">${esc(t("Amount"))}</th></tr></thead>
      <tbody>${shown.slice(0, filter.shown).map((r) => `<tr><td class="tarih">${esc(new Date(`${r.date}T00:00:00`).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "2-digit" }))}</td>
        <td><span class="baslik">${esc(r.title)}</span>${r.status === "pending" ? ` <i class="pk-rozet">${esc(t("unpaid"))}</i>` : ""}</td>
        <td><i class="pk-kapsam ${r.scope}">${esc(r.scopeName ?? SCOPE[r.scope])}</i></td><td class="gz">${esc(label(r))}</td><td class="gz">${esc(r.paidBy ?? "")}</td>
        <td class="say ${sign(r) === "+" ? "pk-yesil" : ""}">${sign(r)}${money(r.amount)}</td></tr>`).join("")}</tbody></table></div>
    ${shown.length > filter.shown ? `<button type="button" class="pk-daha" data-pk="more">${esc(t("Show {n} more", { n: Math.min(300, shown.length - filter.shown) }))}</button>` : ""}
  </div>`;
}
const fold = (v) => String(v ?? "").toLocaleLowerCase("tr");

// —— investments, as Birikim shows them (the value is what was paid: no market prices here)
function investScreen() {
  const hs = holdings(book.transactions).filter((h) => h.open || h.missingBuys);
  const total = hs.filter((h) => h.open).reduce((a, h) => a + h.net, 0);
  const groups = ASSET_PICKER.map(([id]) => [id, hs.filter((h) => assetKey(h.assetType) === id)]).filter(([, l]) => l.length);
  const closed = holdings(book.transactions).filter((h) => !h.open && !h.missingBuys);
  return `<div class="pk-col pk-genis">
    <div class="pk-ust"><span class="pk-baslik">${esc(t("Assets"))}</span><button type="button" class="pk-ikon" data-pk="add-investment" aria-label="${esc(t("Add investment"))}">＋</button></div>
    <div class="pk-toplam"><div class="pk-etiket">${esc(t("Total savings"))}</div><div class="pk-toplam-n">${money(total)}</div><p>${esc(t("What was paid for what you hold; there are no market prices here."))}</p></div>
    ${groups.map(([id, list]) => `<div class="pk-grup"><div class="pk-grup-bas"><span>${esc(ASSET_NAME[id])} · ${list.length}</span><b>${money(list.filter((h) => h.open).reduce((a, h) => a + h.net, 0))}</b></div>
      ${list.map((h) => `<div class="pk-kart pk-varlik"><span class="pk-varlik-ikon">${assetEmoji(h.assetType)}</span><span class="pk-ad"><span>${esc(h.asset)}</span><small>${esc(ASSET_NAME[assetKey(h.assetType)])}${h.lastUnitPrice ? ` · ${esc(t("last {price}", { price: money(h.lastUnitPrice) }))}` : ""}</small></span>
        <span class="pk-tutar">${h.missingBuys ? `<span title="${esc(t("More sold than bought: some buys (or free shares) aren't in the book."))}">${esc(t("buys missing"))}</span>` : money(h.net)}<small>${h.missingBuys ? "" : esc(new Intl.NumberFormat(LOCALE).format(h.units))}</small></span></div>`).join("")}</div>`).join("") || `<div class="pk-bos"><b>${esc(t("No investments yet."))}</b></div>`}
    ${closed.length ? `<div class="pk-grup"><div class="pk-grup-bas"><span>${esc(t("Sold out"))} · ${closed.length}</span></div>${closed.map((h) => `<div class="pk-kart pk-varlik soluk"><span class="pk-varlik-ikon">${assetEmoji(h.assetType)}</span><span class="pk-ad"><span>${esc(h.asset)}</span><small>${esc(t("put in {a}, taken out {b}", { a: money(h.putIn), b: money(h.takenOut) }))}</small></span><span class="pk-tutar ${h.net < 0 ? "pk-yesil" : ""}">${h.net < 0 ? "+" : "−"}${money(Math.abs(h.net))}</span></div>`).join("")}</div>` : ""}
  </div>`;
}

// —— the statement page: the preview follows what's pasted
function statementScreen() {
  const rows = statement.rows ?? [];
  const picked = rows.filter((r) => r.include);
  return `<div class="pk-col">
    <div class="pk-ust"><span class="pk-baslik">${esc(t("Paste a statement"))}</span></div>
    <label class="pk-blok"><span class="pk-alt-baslik">${esc(t("Statement or receipt lines"))}</span><textarea data-pk-text rows="6" placeholder="03.10.2026  MIGROS  245,90 TL&#10;02.10.2026  SHELL  1.250,00 TL">${esc(statement.text)}</textarea></label>
    <label class="pk-satir-secim"><span>${esc(t("Account"))}</span><select data-pk-account><option value="">${esc(t("not set"))}</option>${book.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === statement.accountId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
    <div class="pk-gun-bas" style="margin-top:4px"><span>${esc(t("Preview"))}</span>${rows.length ? `<span>${esc(t("{count} / {total} selected", { count: picked.length, total: rows.length }))}</span>` : ""}</div>
    ${rows.length ? `<ul class="pk-kart pk-ekstre">${rows.map((r, i) => `<li class="${r.include ? "" : "kapali"}"><button type="button" class="pk-tik ${r.include ? "on" : ""}" data-pk="row" data-v="${i}" aria-label="${esc(r.include ? t("Remove") : t("Add"))}">${r.include ? "✓" : ""}</button>
        <span class="pk-e">${cat(r.category).emoji}</span><span class="pk-ad"><span>${esc(r.title)}</span><small>${esc(new Date(`${r.date}T00:00:00`).toLocaleDateString(LOCALE, { day: "numeric", month: "short" }))} · <select data-pk-cat="${i}">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === r.category ? "selected" : ""}>${esc(t(c.label))}</option>`).join("")}</select>${r.credit ? ` · ${esc(t("payment / refund"))}` : ""}</small></span><b>${money(r.amount)}</b></li>`).join("")}</ul>
      <div class="pk-gun-bas"><span>${esc(t("Total of the selected lines"))}</span><b class="pk-toplam-k">${money(picked.reduce((a, r) => a + r.amount, 0))}</b></div>
      <button type="button" class="pk-kaydet" data-pk="statement-save" ${picked.length ? "" : "disabled"}>${esc(t("Add {count} expenses", { count: picked.length }))}</button>`
      : `<p class="pk-kart pk-bilgi">${esc(t("Paste the lines and the date, the description and the amount show here."))}</p>`}
  </div>`;
}

function accountsScreen() {
  return `<div class="pk-col">
    <div class="pk-gun-bas"><span>${esc(t("Your accounts"))}</span></div>
    <p class="pk-ipucu">${esc(t("Where money leaves from: a card, a bank account, cash. A transaction's account says it came from your pocket."))}</p>
    ${book.accounts.length ? `<div class="pk-kart pk-liste">${book.accounts.map((a) => `<div class="pk-satir"><i class="pk-kenar"></i><span class="pk-emoji">${{ card: "💳", bank: "🏦", cash: "💵", wallet: "👛", investment: "📈" }[a.kind] ?? "💳"}</span><span class="pk-ad"><span>${esc(a.name)}</span><small>${esc(ACCOUNT_KIND[a.kind] ?? a.kind)} · ${esc(a.currency)}</small></span><button type="button" class="pk-kucuk" data-pk="account-delete" data-id="${esc(a.id)}">${esc(t("Remove"))}</button></div>`).join("")}</div>` : `<div class="pk-bos"><b>${esc(t("No accounts yet."))}</b></div>`}
    <div class="pk-gun-bas"><span>${esc(t("Add account"))}</span></div>
    <form class="pk-kart pk-form" data-pk-form="account">
      <label class="pk-secim"><span>${esc(t("Name"))}</span><input name="name" required placeholder="${esc(t("Card ••1234"))}"></label>
      <div class="pk-iki"><label class="pk-secim"><span>${esc(t("Type"))}</span><select name="kind">${Object.entries(ACCOUNT_KIND).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></label>
      <label class="pk-secim"><span>${esc(t("Currency"))}</span><select name="currency"><option>TRY</option><option>USD</option><option>EUR</option><option>GBP</option></select></label></div>
      <button class="pk-kaydet">${esc(t("Add account"))}</button>
    </form>
  </div>`;
}

// —— Home: the summary of everything, each card opens its section
function homeScreen() {
  const v = monthView(book.transactions, business, month);
  const hs = holdings(book.transactions).filter((h) => h.open);
  const savings = hs.reduce((a, h) => a + h.net, 0);
  const sum = company?.summary, est = company?.tax?.estimate;
  const upcoming = [...(company?.pending ?? []).filter((e) => e.direction === "out").map((e) => ({ date: e.entryDate, title: e.title, amount: e.amount, unpaid: true })),
    ...(company?.upcoming ?? []).filter((u) => u.direction === "out").map((u) => ({ date: u.dueDate, title: u.title, amount: u.amount }))]
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  return `<div class="pk-col pk-ana">
    <div class="pk-ay pk-tam"><span>${esc(monthLabel(month))}</span></div>
    <a class="pk-kart pk-ozet pk-link" href="#kasa/harcamalar">
      <div class="pk-kart-bas"><span>${esc(t("Expenses"))}</span><span>›</span></div>
      <div class="pk-akis">
        ${[[t("In"), v.income, KIND_COLOR.income], [t("Spent"), v.spent, KIND_COLOR.expense], [t("Invested"), v.invested, KIND_COLOR.investment]].map(([label, n, color]) => `<div><div class="pk-etiket" style="color:${color}">${esc(label)}</div><div class="pk-akis-n">${money(n)}</div></div>`).join("")}
        <div class="pk-kalan">${esc(t("Left"))} <b>${money(v.income - v.spent - v.invested)}</b></div>
      </div>
    </a>
    <a class="pk-kart pk-ozet pk-link" href="#kasa/sirket">
      <div class="pk-kart-bas"><span>${esc(t("Company"))}</span><span>›</span></div>
      ${sum ? `<div class="pk-akis">
        ${[[t("Income"), sum.income, KIND_COLOR.income], [t("Expense"), sum.expense, KIND_COLOR.expense], [t("Profit"), sum.profit, "#94A3B8"]].map(([label, n, color]) => `<div><div class="pk-etiket" style="color:${color}">${esc(label)}</div><div class="pk-akis-n">${money(n)}</div></div>`).join("")}
        <div class="pk-kalan">${esc(t("without VAT"))}${sum.vatPaid || sum.vatCollected ? ` · ${esc(t("VAT to pay"))} <b>${money(sum.vatCollected - sum.vatPaid)}</b>` : ""}</div>
      </div>
      <div class="pk-satir-ince">${est?.configured ? `${esc(t("Income tax this year (estimate)"))} <b>${money(est.payable)}</b> · ${esc(t("set aside {amount} a month", { amount: money(est.monthlyReserveLeft || est.monthlyReserve) }))}` : esc(t("Tax: set up the tax settings in Company → Tax for an estimate."))}</div>` : `<p class="pk-ipucu">${esc(t("Loading…"))}</p>`}
    </a>
    <a class="pk-toplam pk-link" href="#kasa/yatirim">
      <div class="pk-kart-bas"><span class="pk-etiket">${esc(t("Total savings"))}</span><span>›</span></div>
      <div class="pk-toplam-n">${money(savings)}</div>
      <p>${esc(t("{n} assets · what was paid for them", { n: hs.length }))}</p>
    </a>
    ${upcoming.length ? `<div class="pk-gun pk-tam"><div class="pk-gun-bas"><span>${esc(t("Coming up"))}</span></div>
      <div class="pk-kart pk-liste">${upcoming.map((u) => `<a class="pk-satir pk-link" href="#kasa/${u.unpaid ? "duzenli" : "sirket"}"><i class="pk-kenar" style="background:${u.unpaid ? "#0D9488" : "transparent"}"></i><span class="pk-emoji">${u.unpaid ? "🧾" : "↻"}</span>
        <span class="pk-ad"><span>${esc(u.title)}</span><small>${esc(new Date(`${u.date}T00:00:00`).toLocaleDateString(LOCALE, { day: "numeric", month: "long" }))}${u.unpaid ? ` · ${esc(t("unpaid"))}` : ""}</small></span><span class="pk-tutar">${money(u.amount)}</span></a>`).join("")}</div></div>` : ""}
  </div>`;
}

// —— investment history (Birikim's Geçmiş): the buys and sells, by day
function historyScreen() {
  const txs = book.transactions.filter((x) => x.kind === "investment").sort((a, b) => b.date.localeCompare(a.date));
  const days = [];
  for (const x of txs) { if (days.at(-1)?.key !== x.date) days.push({ key: x.date, rows: [] }); days.at(-1).rows.push(x); }
  return `<div class="pk-col">
    <div class="pk-ust"><span class="pk-baslik">${esc(t("History"))}</span><button type="button" class="pk-ikon" data-pk="add-investment" aria-label="${esc(t("Add investment"))}">＋</button></div>
    ${days.map((d) => `<div class="pk-gun"><div class="pk-gun-bas"><span>${esc(dayLabel(d.key))}</span></div><div class="pk-kart pk-liste">${d.rows.map(rowHtml).join("")}</div></div>`).join("") || `<div class="pk-bos"><b>${esc(t("No investments yet."))}</b></div>`}
  </div>`;
}

// —— the bottom bar of a section, as Speys's BudgetTabBar / BirikimTabBar: full width, the active icon in a tinted pill
const BAR_ICONS = {
  home: '<path d="M12 3.2 3 10.4V20a1 1 0 0 0 1 1h5.5v-6h5v6H20a1 1 0 0 0 1-1v-9.6L12 3.2Z"/>',
  islemler: '<path d="M4 4h16v3H4V4Zm0 6.5h16v3H4v-3ZM4 17h16v3H4v-3Z"/>',
  butce: '<path d="M4 3h7v7H4V3Zm9 0h7v7h-7V3ZM4 14h7v7H4v-7Zm9 0h7v7h-7v-7Z"/>',
  abonelik: '<path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 0 0 2.1 10.6l2 .4A8 8 0 0 1 12 4Zm7.9 8.6A8 8 0 0 1 4.6 15H7v-2H1v6h2v-2.3a10 10 0 0 0 18.9-3.3l-2-.4Z"/>',
  harcamalar: '<path d="M5 2.5h14a1 1 0 0 1 1 1V21l-2.7-1.6L14.6 21 12 19.4 9.4 21l-2.7-1.6L4 21V3.5a1 1 0 0 1 1-1Zm3 5.5v1.8h8V8H8Zm0 4v1.8h5.5V12H8Z"/>',
  ekstre: '<path d="M6 2.5h8.6L19 6.9V20.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1Zm8 1.6V8h3.9L14 4.1ZM8 11v1.8h8V11H8Zm0 4v1.8h8V15H8Z"/>',
  hesaplar: '<path d="M3.5 5.5h17a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 17V7a1.5 1.5 0 0 1 1.5-1.5Zm-.1 3v2h17.2v-2H3.4Zm2.1 6v1.6h5V14.5h-5Z"/>',
  yatirim: '<path d="M12 3c5 0 9 1.6 9 3.5S17 10 12 10 3 8.4 3 6.5 7 3 12 3Zm-9 6.3C4.6 10.9 8 12 12 12s7.4-1.1 9-2.7V12c0 1.9-4 3.5-9 3.5S3 13.9 3 12V9.3Zm0 5.5c1.6 1.6 5 2.7 9 2.7s7.4-1.1 9-2.7v2.7c0 1.9-4 3.5-9 3.5s-9-1.6-9-3.5v-2.7Z"/>',
  gecmis: '<path d="M12 3a9 9 0 1 1-8.5 6h2.2A7 7 0 1 0 12 5a7 7 0 0 0-4.9 2H10v2H3.5V2.5h2v3A9 9 0 0 1 12 3Zm-1 4h2v5.1l3.4 2-1 1.7L11 13.2V7Z"/>',
};
// the sections' tabs, as Speys's bars: Ledger (Defter / Bütçe / Abonelik), Birikim (Varlıklar / Geçmiş), and the
// home's Overview with the table of everything
const sectionTabs = () => (["yatirim", "gecmis"].includes(tab)
  ? [["yatirim", t("Assets")], ["gecmis", t("History")]]
  : ["home", "islemler"].includes(tab) ? [["home", t("Summary")], ["islemler", t("Transactions")]]
  : [["harcamalar", t("Ledger")], ["butce", t("Budgets")], ["abonelik", t("Subscriptions")]]);
const sectionName = () => (["yatirim", "gecmis"].includes(tab) ? t("Investments") : ["home", "islemler"].includes(tab) ? t("Overview") : t("Expenses"));
/**
 * On the web the section's tabs sit in a header row beside its name, as Speys's UstSekmeler (frontend
 * app/home/components/KabukBasligi.tsx): icon and name, the chosen one with the accent icon and a bar on the row's
 * bottom edge. Phones get the bottom bar instead (Speys: the bars are md:hidden).
 */
function headerTabs() {
  return `<div class="pk-baslik-serit"><b>${esc(sectionName())}</b><nav>${sectionTabs().map(([id, label]) => `<a href="#kasa/${id}" class="${tab === id ? "on" : ""}" ${tab === id ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${BAR_ICONS[id]}</svg>${esc(label)}</a>`).join("")}</nav></div>`;
}
function bottomBar() {
  const items = sectionTabs();
  return `<nav class="pk-altbar"><div>${items.map(([id, label]) => `<a href="#kasa/${id}" class="${tab === id ? "on" : ""}" ${tab === id ? 'aria-current="page"' : ""}><span><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${BAR_ICONS[id]}</svg></span><b>${esc(label)}</b></a>`).join("")}</div></nav>`;
}

function draw() {
  if (!box) return;
  if (!book) { box.innerHTML = error ? `<div class="pk-col"><p class="pk-bilgi">${esc(error)}</p></div>` : `<div class="pk-col"><div class="pk-donen"></div></div>`; return; }
  box.innerHTML = (error ? `<div class="pk-col"><p class="pk-bilgi">${esc(error)}</p></div>` : "")
    + headerTabs()
    + (tab === "home" ? homeScreen() : tab === "islemler" ? allScreen() : tab === "butce" ? (listId ? budgetScreen() : budgetsScreen()) : tab === "abonelik" ? subsScreen()
      : tab === "yatirim" ? investScreen() : tab === "gecmis" ? historyScreen() : tab === "ekstre" ? statementScreen() : tab === "hesaplar" ? accountsScreen() : ledgerScreen())
    + bottomBar()
    + (sheet ? (sheet.type === "list" ? listSheet() : sheet.type === "list-expense" ? listExpenseSheet() : sheet.type === "sub" ? subSheet() : sheetHtml()) : "");
  box.querySelector("[autofocus]")?.focus();
}

const openSheet = (s) => { sheet = { side: "buy", category: s.kind === "income" ? "salary" : "other", assetType: "fund", ...s }; draw(); };
const ACTIONS = {
  "open-list"(b) { location.hash = `kasa/butce/${b.dataset.id}`; },
  "budget-tab"(b) { budgetTab = b.dataset.v; draw(); },
  "list-new"() { sheet = { type: "list", emoji: "🏖️", members: [{ name: t("Me"), me: true }] }; draw(); },
  "list-edit"() { const l = listsOf().find((x) => x.id === listId); if (l) { sheet = { type: "list", list: l, emoji: l.emoji, members: l.members.map((m) => ({ ...m })) }; draw(); } },
  "member-add"() {
    const input = box.querySelector("[data-pk-guest]"), name = input.value.trim();
    if (!name) return;
    if (sheet.members.some((m) => m.name.toLocaleLowerCase("tr") === name.toLocaleLowerCase("tr"))) return notify(t("This participant is already added"));
    keepTyped(() => { sheet.members.push({ name }); });
    box.querySelector("[data-pk-guest]")?.focus();
  },
  "member-remove"(b) { keepTyped(() => { sheet.members.splice(+b.dataset.v, 1); }); },
  async "list-delete"() {
    if (!confirm(t("Delete this budget and its expenses?"))) return;
    try { await post("butce/sil", { id: sheet.list.id }); sheet = null; location.hash = "kasa/butce"; await load(); } catch (e) { notify(e.message); }
  },
  "list-expense-new"() { sheet = { type: "list-expense", record: null, category: "other" }; draw(); },
  "list-expense-edit"(b) { const x = book.transactions.find((y) => y.id === b.dataset.id); if (x) { sheet = { type: "list-expense", record: x, category: x.category, among: x.splitAmong ?? null }; draw(); } },
  among(b) {
    const l = listsOf().find((x) => x.id === listId);
    const now = new Set(sheet.among ?? sheet.record?.splitAmong ?? l.members.map((m) => m.id));
    now.has(b.dataset.v) ? now.delete(b.dataset.v) : now.add(b.dataset.v);
    if (!now.size) return;
    keepTyped(() => { sheet.among = [...now]; });
  },
  "sub-new"() { sheet = { type: "sub", record: null }; draw(); },
  "sub-edit"(b) { const x = (book.subscriptions ?? []).find((y) => y.id === b.dataset.id); if (x) { sheet = { type: "sub", record: x }; draw(); } },
  async "sub-delete"(b) {
    if (!confirm(t("Delete this subscription for good? What it already wrote to the Ledger stays."))) return;
    try { await post("abonelik/sil", { id: b.dataset.id }); await load(); } catch (e) { notify(e.message); }
  },
  preset(b) {
    const p = PRESETS[+b.dataset.v], f = box.querySelector("[data-pk-form=sub]");
    for (const [k, v] of Object.entries({ name: p.name, plan: p.plan, price: p.price, currency: p.currency, icon: p.icon, color: p.color, category: p.category })) if (f.elements[k]) f.elements[k].value = v;
  },
  scope(b) { filter.scope = b.dataset.v; filter.shown = 150; draw(); },
  more() { filter.shown += 300; draw(); },
  "close-sheet-go"() { sheet = null; },
  kind(b) { kind = b.dataset.v; draw(); },
  month(b) { month = shiftMonth(month, +b.dataset.v); draw(); },
  add() { openSheet({ kind: kind === "income" ? "income" : kind === "investment" ? "investment" : "expense", record: null }); },
  "add-investment"() { openSheet({ kind: "investment", record: null }); },
  edit(b) {
    const x = book.transactions.find((y) => y.id === b.dataset.id);
    if (x && x.kind !== "transfer") openSheet({ kind: x.kind, record: x, side: x.side ?? "buy", category: x.category, assetType: assetKey(x.assetType) });
  },
  "sheet-kind"(b) { openSheet({ kind: b.dataset.v, record: null }); },
  side(b) { keepTyped(() => { sheet.side = b.dataset.v; }); },
  pick(b) { keepTyped(() => { sheet[b.dataset.f] = b.dataset.v; }); },
  "close-sheet"() { sheet = null; draw(); },
  async delete(b) {
    if (!confirm(t("Delete this transaction?"))) return;
    try { await post("islem/sil", { id: b.dataset.id }); sheet = null; await load(); } catch (e) { notify(e.message); }
  },
  "open-business"() { location.hash = "kasa/sirket"; },
  row(b) { const r = statement.rows[+b.dataset.v]; r.include = !r.include; draw(); },
  async "account-delete"(b) {
    if (!confirm(t("Remove this account? Its transactions stay, without an account."))) return;
    try { await post("hesap/sil", { id: b.dataset.id }); await load(); } catch (e) { notify(e.message); }
  },
  async "statement-save"() {
    try {
      const r = await post("ekstre", { rows: statement.rows.filter((x) => x.include).map(({ date, title, amount, category }) => ({ date, title, amount, category })), accountId: statement.accountId || null });
      notify(t("{added} added, {skipped} already in the book", r)); statement = { text: "", accountId: statement.accountId }; await load();
    } catch (e) { notify(e.message); }
  },
};

/** Re-draws the sheet without losing what was typed in it. */
function keepTyped(change) {
  const f = box.querySelector(".pk-cekmece");
  const typed = f ? Object.fromEntries(new FormData(f)) : {};
  change();
  draw();
  const fresh = box.querySelector(".pk-cekmece");
  for (const [k, v] of Object.entries(typed)) if (fresh?.elements[k]) fresh.elements[k].value = v;
}

function listen(el) {
  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-pk]");
    if (b && ACTIONS[b.dataset.pk]) { if (!b.getAttribute("href")) ev.preventDefault(); ACTIONS[b.dataset.pk](b); }
  });
  el.addEventListener("input", (ev) => {
    if (ev.target.matches("[data-pk-q]")) {
      filter.q = ev.target.value; filter.shown = 150;
      const at = ev.target.selectionStart; draw();
      const q = box.querySelector("[data-pk-q]"); q.focus(); q.setSelectionRange(at, at);
      return;
    }
    if (!ev.target.matches("[data-pk-text]")) return;
    const old = new Map((statement.rows ?? []).map((r) => [`${r.date}|${r.title}|${r.amount}`, r]));
    statement.text = ev.target.value;
    // the preview follows the text; a line's tick and category stay while it's still there
    statement.rows = parseStatement(statement.text).map((r) => old.get(`${r.date}|${r.title}|${r.amount}`) ?? r);
    const at = ev.target.selectionStart;
    draw();
    const area = box.querySelector("[data-pk-text]");
    area.focus(); area.setSelectionRange(at, at);
  });
  el.addEventListener("change", (ev) => {
    const x = ev.target;
    if (x.matches("[data-pk-cat]")) statement.rows[+x.dataset.pkCat].category = x.value;
    if (x.matches("[data-pk-account]")) statement.accountId = x.value;
  });
  el.addEventListener("submit", async (ev) => {
    const which = ev.target.dataset.pkForm;
    if (!which) return;
    ev.preventDefault();
    ev.stopPropagation();
    const body = Object.fromEntries(new FormData(ev.target));
    try {
      if (which === "tx") {
        body.kind = sheet.kind;
        body.amount = String(body.amount ?? "").replace(/\./g, "").replace(",", ".");
        if (body.units) body.units = String(body.units).replace(/\./g, "").replace(",", ".");
        if (sheet.kind === "expense" || sheet.kind === "income") body.category = sheet.category;
        if (sheet.kind === "income" && !body.title) body.title = t(inc(sheet.category).label);
        if (sheet.kind === "investment") { body.side = sheet.side; body.assetType = sheet.assetType; body.asset = String(body.asset).toUpperCase(); body.title = body.asset; }
        if (sheet.record?.id) body.id = sheet.record.id;
        await post("islem", body); sheet = null;
      }
      if (which === "account") await post("hesap", body);
      if (which === "list") {
        const id = await post("butce", { ...body, id: sheet.list?.id, emoji: sheet.emoji, members: sheet.members });
        sheet = null;
        if (typeof id === "string") location.hash = `kasa/butce/${id}`;
      }
      if (which === "list-expense") {
        const l = listsOf().find((x) => x.id === listId);
        body.amount = String(body.amount ?? "").replace(/\./g, "").replace(",", ".");
        await post("islem", { ...body, id: sheet.record?.id, ledger: l.id, kind: "expense", category: sheet.category, splitAmong: sheet.among ?? sheet.record?.splitAmong ?? l.members.map((m) => m.id) });
        sheet = null;
      }
      if (which === "sub") {
        body.price = String(body.price ?? "").replace(/\./g, "").replace(",", ".");
        await post("abonelik", { ...body, id: sheet.record?.id });
        sheet = null;
      }
      await load();
    } catch (e) { notify(e.message); }
  });
}

/** Speys's look, scoped to the personal box: its colour tokens (light and dark) and sizes. */
function style() {
  if (document.getElementById("pk-stil")) return;
  const s = document.createElement("style");
  s.id = "pk-stil";
  s.textContent = `
#kisisel{color:var(--a-text)}
#kisisel .pk-col{max-width:1080px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
#kisisel .pk-ust{display:flex;align-items:center;gap:8px}
#kisisel .pk-baslik{flex:1;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--a-muted)}
#kisisel .pk-ust .pk-seg{margin-right:auto;min-width:0;overflow-x:auto;scrollbar-width:none}
#kisisel .pk-ust .pk-ikon{flex-shrink:0}
@media (max-width:440px){#kisisel .pk-seg button{padding:6px 9px;letter-spacing:0}}
#kisisel .pk-seg{display:inline-flex;gap:2px;padding:4px;border-radius:16px;border:1px solid var(--a-border);background:var(--a-track);align-self:flex-start}
#kisisel .pk-seg button{border:0;background:none;padding:6px 12px;border-radius:12px;font:inherit;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.03em;color:var(--a-muted);cursor:pointer}
#kisisel .pk-seg button.on{background:var(--a-active);color:var(--a-text);box-shadow:0 1px 2px rgb(0 0 0/.08)}
#kisisel .pk-ikon{width:32px;height:32px;border-radius:8px;border:1px solid var(--a-border);background:var(--a-surface);color:var(--accent);font-size:15px;font-weight:700;display:grid;place-items:center;cursor:pointer;padding:0}
#kisisel .pk-ay{display:flex;align-items:center;justify-content:center;gap:12px;font-size:14px;font-weight:700;color:var(--a-muted)}
#kisisel .pk-ay span{color:var(--a-text);text-transform:capitalize}
#kisisel .pk-ay button{width:28px;height:28px;border:0;background:none;border-radius:8px;color:var(--a-muted);font-size:16px;font-weight:700;cursor:pointer}
#kisisel .pk-kart{border-radius:16px;border:1px solid var(--a-border);background:var(--a-surface)}
#kisisel .pk-ozet{padding:16px;display:flex;flex-direction:column;gap:14px}
#kisisel .pk-akis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
#kisisel .pk-etiket{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em}
#kisisel .pk-akis-n{font-size:20px;line-height:1.2;font-weight:900;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#kisisel .pk-kalan{grid-column:1/-1;font-size:12px;font-weight:600;color:var(--a-muted)}
#kisisel .pk-kalan b{color:var(--a-text);font-variant-numeric:tabular-nums}
#kisisel .pk-buyuk{font-size:34px;line-height:1;font-weight:900;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
#kisisel .pk-cubuk{display:flex;height:8px;border-radius:99px;overflow:hidden;gap:2px;background:var(--a-muted-bg)}
#kisisel .pk-cubuk span{display:block}
#kisisel .pk-anahtar{display:flex;flex-wrap:wrap;gap:6px 16px}
#kisisel .pk-anahtar div{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--a-muted)}
#kisisel .pk-anahtar i{width:10px;height:10px;border-radius:3px}
#kisisel .pk-anahtar b{color:var(--a-text);font-variant-numeric:tabular-nums}
#kisisel .pk-gun{display:flex;flex-direction:column;gap:6px}
#kisisel .pk-gun-bas{display:flex;align-items:baseline;justify-content:space-between;padding:8px 4px 0}
#kisisel .pk-gun-bas span:first-child{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--a-muted)}
#kisisel .pk-gun-bas span:last-child{font-size:12px;font-weight:700;color:var(--a-muted);font-variant-numeric:tabular-nums}
#kisisel .pk-liste{overflow:hidden}
#kisisel .pk-satir{display:flex;align-items:center;gap:12px;padding:10px 14px 10px 0;cursor:pointer}
#kisisel .pk-satir+.pk-satir{border-top:1px solid color-mix(in srgb,var(--a-border) 70%,transparent)}
#kisisel .pk-satir:hover{background:color-mix(in srgb,var(--a-muted-bg) 50%,transparent)}
#kisisel .pk-satir.soluk{opacity:.6}
#kisisel .pk-kenar{align-self:stretch;width:3px;border-radius:0 3px 3px 0;flex-shrink:0}
#kisisel .pk-emoji,#kisisel .pk-varlik-ikon{width:32px;height:32px;border-radius:12px;display:grid;place-items:center;font-size:15px;flex-shrink:0;background:var(--a-muted-bg)}
#kisisel .pk-ad{flex:1;min-width:0;display:flex;flex-direction:column}
#kisisel .pk-ad>span{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#kisisel .pk-ad small{font-size:11px;color:var(--a-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#kisisel .pk-tutar{text-align:right;flex-shrink:0;font-size:14.5px;font-weight:700;font-variant-numeric:tabular-nums}
#kisisel .pk-tutar small{display:block;font-size:10px;font-weight:700;color:var(--a-muted)}
#kisisel .pk-yesil{color:#059669}
@media (prefers-color-scheme:dark){#kisisel .pk-yesil{color:#34d399}}
#kisisel .pk-soluk{color:var(--a-muted)}
#kisisel .pk-bos{border-radius:16px;border:1px dashed var(--a-border);padding:48px 24px;text-align:center;display:flex;flex-direction:column;gap:6px}
#kisisel .pk-bos b{font-size:14px}
#kisisel .pk-bos span{font-size:12px;color:var(--a-muted)}
#kisisel .pk-toplam{border-radius:16px;border:1px solid var(--a-border);padding:24px;background:linear-gradient(to bottom right,color-mix(in srgb,#6366f1 10%,transparent),var(--a-surface))}
#kisisel .pk-toplam .pk-etiket{color:var(--a-muted);font-weight:600;letter-spacing:.05em}
#kisisel .pk-toplam-n{font-size:30px;font-weight:900;letter-spacing:-.02em;margin:2px 0 4px;font-variant-numeric:tabular-nums}
#kisisel .pk-toplam p{margin:0;font-size:10px;color:var(--a-muted)}
#kisisel .pk-grup{display:flex;flex-direction:column;gap:10px;margin-top:8px}
#kisisel .pk-grup-bas{display:flex;align-items:baseline;justify-content:space-between;padding:0 4px}
#kisisel .pk-grup-bas span{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:var(--a-muted)}
#kisisel .pk-grup-bas b{font-size:12px;font-weight:900;font-variant-numeric:tabular-nums}
#kisisel .pk-varlik{display:flex;align-items:center;gap:12px;padding:16px;box-shadow:0 1px 2px rgb(0 0 0/.04)}
#kisisel .pk-varlik.soluk{opacity:.65}
#kisisel .pk-varlik-ikon{width:40px;height:40px;background:var(--a-track);border:1px solid var(--a-border)}
#kisisel .pk-varlik .pk-ad>span{font-weight:700}
#kisisel .pk-varlik .pk-tutar{font-weight:900}
#kisisel .pk-alt-baslik{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--a-muted);padding:0 4px}
#kisisel .pk-blok{display:flex;flex-direction:column;gap:6px}
#kisisel textarea{width:100%;box-sizing:border-box;resize:vertical;border-radius:16px;border:1px solid var(--a-border);background:var(--a-surface);color:var(--a-text);padding:10px 12px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}
#kisisel textarea:focus{border-color:var(--accent)}
#kisisel .pk-satir-secim{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--a-muted)}
#kisisel .pk-satir-secim select{flex:1;min-width:0;border-radius:12px;border:1px solid var(--a-border);background:var(--a-surface);color:var(--a-text);padding:6px 10px;font:inherit;font-size:12px;font-weight:700}
#kisisel .pk-ekstre{list-style:none;margin:0;padding:0;overflow:hidden}
#kisisel .pk-ekstre li{display:flex;align-items:center;gap:10px;padding:8px 12px}
#kisisel .pk-ekstre li+li{border-top:1px solid var(--a-border)}
#kisisel .pk-ekstre li.kapali{opacity:.5}
#kisisel .pk-ekstre .pk-e{font-size:15px}
#kisisel .pk-ekstre .pk-ad>span{font-weight:700}
#kisisel .pk-ekstre select{border:0;background:none;color:var(--a-muted);font:inherit;font-size:11px;font-weight:700;padding:0;outline:none}
#kisisel .pk-ekstre b{font-size:14px;font-weight:900;font-variant-numeric:tabular-nums;flex-shrink:0}
#kisisel .pk-tik{width:20px;height:20px;border-radius:6px;border:1px solid var(--a-border);background:none;color:#fff;font-size:12px;font-weight:900;display:grid;place-items:center;padding:0;cursor:pointer;flex-shrink:0}
#kisisel .pk-tik.on{background:var(--accent);border-color:var(--accent)}
#kisisel .pk-toplam-k{font-size:18px;font-weight:900;font-variant-numeric:tabular-nums}
#kisisel .pk-bilgi{padding:24px 12px;text-align:center;font-size:12px;font-weight:700;color:var(--a-muted);margin:0}
#kisisel .pk-ipucu{font-size:12px;color:var(--a-muted);margin:0;padding:0 4px}
#kisisel .pk-kucuk{border:0;background:none;color:var(--a-muted);font:inherit;font-size:12px;font-weight:700;cursor:pointer;padding:0 6px}
#kisisel .pk-kaydet{border:0;border-radius:16px;padding:14px;font:inherit;font-size:15px;font-weight:700;color:#fff;background:var(--accent);cursor:pointer;width:100%}
#kisisel .pk-kaydet:disabled{opacity:.5}
#kisisel .pk-sil{border:0;background:none;color:#ef4444;font:inherit;font-size:13px;font-weight:700;cursor:pointer;padding:6px}
#kisisel .pk-perde{position:fixed;inset:0;background:rgb(0 0 0/.4);z-index:50}
#kisisel .pk-cekmece{position:fixed;left:0;right:0;bottom:0;margin:0 auto;max-width:576px;max-height:92vh;overflow-y:auto;z-index:51;background:var(--a-bg);border-top:1px solid var(--a-border);border-radius:24px 24px 0 0;box-shadow:0 -10px 40px rgb(0 0 0/.25);padding:0 20px 32px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box}
#kisisel .pk-tutamac{width:40px;height:4px;border-radius:99px;background:var(--a-border);margin:12px auto 0;flex-shrink:0}
#kisisel .pk-cekmece-bas{display:flex;align-items:center;justify-content:space-between}
#kisisel .pk-cekmece-bas b{font-size:18px;font-weight:900;letter-spacing:-.01em}
#kisisel .pk-cekmece-bas .pk-ikon{color:var(--a-muted);font-size:12px}
#kisisel .pk-alan{border-radius:16px;border:1px solid var(--a-border);background:var(--a-surface);padding:12px 16px;display:flex;flex-direction:column;gap:4px}
#kisisel .pk-alan>span,#kisisel .pk-secim>span{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--a-muted)}
#kisisel .pk-alan input{border:0;background:none;outline:none;color:var(--a-text);font:inherit;font-size:16px;font-weight:600;padding:0;min-width:0}
#kisisel .pk-alan input.pk-n{font-size:26px;font-weight:900;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
#kisisel .pk-alan input.pk-n2{font-size:18px;font-weight:900;font-variant-numeric:tabular-nums}
#kisisel .pk-secim{display:flex;flex-direction:column;gap:4px;min-width:0}
#kisisel .pk-secim>span{padding:0 4px}
#kisisel .pk-secim input,#kisisel .pk-secim select{border-radius:16px;border:1px solid var(--a-border);background:var(--a-surface);color:var(--a-text);padding:12px 16px;font:inherit;font-size:14px;font-weight:700;outline:none;min-width:0;width:100%;box-sizing:border-box}
#kisisel .pk-iki{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#kisisel .pk-emojiler{display:flex;gap:8px;overflow-x:auto}
#kisisel .pk-emojiler button{width:44px;height:44px;flex-shrink:0;border-radius:12px;border:1px solid var(--a-border);background:var(--a-surface);font-size:18px;display:grid;place-items:center;cursor:pointer;padding:0}
#kisisel .pk-emojiler button.on,#kisisel .pk-cipler button.on{border-color:var(--a-text);background:var(--a-muted-bg);color:var(--a-text)}
#kisisel .pk-cipler{display:flex;flex-wrap:wrap;gap:8px}
#kisisel .pk-cipler button{height:40px;padding:0 12px;border-radius:12px;border:1px solid var(--a-border);background:var(--a-surface);color:var(--a-muted);font:inherit;font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px;cursor:pointer}
#kisisel .pk-cipler button span{font-size:16px}
#kisisel .pk-link{display:block;color:inherit;text-decoration:none;cursor:pointer}
#kisisel .pk-ozet.pk-link{display:flex}
#kisisel .pk-link:hover{border-color:color-mix(in srgb,var(--a-muted) 45%,transparent)}
#kisisel .pk-satir.pk-link{display:flex}
#kisisel .pk-kart-bas{display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:var(--a-muted)}
#kisisel .pk-satir-ince{font-size:12px;font-weight:600;color:var(--a-muted);border-top:1px solid var(--a-border);padding-top:10px}
#kisisel .pk-satir-ince b{color:var(--a-text);font-variant-numeric:tabular-nums}
#kisisel .pk-sol,#kisisel .pk-sag{display:flex;flex-direction:column;gap:12px;min-width:0}
/* wide screens: the column grows; the Ledger's summary stays on the left while the days scroll on the right,
   the home cards and the assets sit two by two. Phones keep Speys's single column. */
@media (min-width:1000px){
  #kisisel .pk-col.pk-defter{max-width:1080px;display:grid;grid-template-columns:400px minmax(0,1fr);gap:20px;align-items:start}
  #kisisel .pk-defter .pk-sol{position:sticky;top:12px}
  #kisisel .pk-defter .pk-sag>.pk-gun:first-child .pk-gun-bas{padding-top:0}
  #kisisel .pk-col.pk-ana{max-width:1080px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:stretch}
  #kisisel .pk-ana .pk-tam{grid-column:1/-1}
  #kisisel .pk-col.pk-genis{max-width:1080px}
  #kisisel .pk-genis .pk-grup{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  #kisisel .pk-genis .pk-grup-bas{grid-column:1/-1}
  #kisisel .pk-genis .pk-toplam{max-width:none}
}
#kisisel .pk-form{padding:16px;display:flex;flex-direction:column;gap:10px}
#kisisel .pk-form .pk-secim input,#kisisel .pk-form .pk-secim select{background:var(--a-bg)}
#kisisel .pk-butceler,#kisisel .pk-kartlar{display:grid;gap:12px}
@media (min-width:1000px){#kisisel .pk-kartlar{grid-template-columns:1fr 1fr}#kisisel .pk-abonelikler .pk-iki-ozet{max-width:520px}}
#kisisel .pk-butce-ic .pk-sag{gap:10px}
@media (min-width:1000px){#kisisel .pk-butceler{grid-template-columns:1fr 1fr}}
#kisisel .pk-butce{display:flex;align-items:center;gap:16px;padding:16px;border-radius:26px;color:inherit;text-decoration:none;box-shadow:0 1px 2px rgb(0 0 0/.04)}
#kisisel .pk-butce:hover{background:var(--a-muted-bg)}
#kisisel .pk-butce:hover .pk-ad>span{color:#EC4899}
#kisisel .pk-butce-emoji{width:56px;height:56px;border-radius:16px;background:var(--a-muted-bg);border:1px solid var(--a-border);display:grid;place-items:center;font-size:30px;flex-shrink:0}
#kisisel .pk-butce .pk-ad>span{font-size:16px;font-weight:700}
#kisisel .pk-butce .pk-ad small{font-size:12px}
#kisisel .pk-butce .pk-tutar{font-weight:800;font-size:14px}
#kisisel .pk-ok{color:var(--a-muted);font-size:20px;font-weight:700;padding-right:4px}
#kisisel .pk-bos-buyuk{padding:64px 24px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px;border-radius:24px}
#kisisel .pk-bos-buyuk>span{font-size:36px}
#kisisel .pk-bos-buyuk b{font-size:14px}
#kisisel .pk-bos-buyuk small{font-size:12px;color:var(--a-muted);max-width:320px}
#kisisel .pk-ornek{display:flex;gap:8px;font-size:20px !important}
#kisisel .pk-ornek i{font-style:normal;width:40px;height:40px;border-radius:12px;background:var(--a-muted-bg);border:1px solid var(--a-border);display:grid;place-items:center}
#kisisel .pk-fab{position:fixed;left:0;right:0;bottom:96px;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;z-index:30}
#kisisel .pk-fab button{pointer-events:auto;width:56px;height:56px;border-radius:50%;border:0;color:#fff;font-size:26px;font-weight:700;cursor:pointer;box-shadow:0 10px 25px rgb(236 72 153/.25)}
#kisisel .pk-fab span{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--a-muted)}
@media (min-width:768px){#kisisel .pk-fab{bottom:28px}}
#kisisel .pk-col:has(.pk-fab){padding-bottom:110px}
#kisisel .pk-butce-bas{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;margin:4px 0 6px}
#kisisel .pk-butce-bas>span{width:80px;height:80px;border-radius:50%;background:var(--a-surface);border:1px solid var(--a-border);display:grid;place-items:center;font-size:38px}
#kisisel .pk-butce-bas b{font-size:24px;font-weight:900;letter-spacing:-.02em}
#kisisel .pk-butce-bas small{font-size:12px;color:var(--a-muted)}
#kisisel .pk-seg-tam{display:flex;align-self:stretch}
#kisisel .pk-seg-tam button{flex:1;text-transform:none;font-size:12px;letter-spacing:0}
#kisisel .pk-iki-ozet{display:flex;justify-content:space-around;padding:16px 8px;text-align:center}
#kisisel .pk-iki-ozet>i{width:1px;background:var(--a-border)}
#kisisel .pk-iki-ozet small{display:block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--a-muted);margin-bottom:4px}
#kisisel .pk-iki-ozet b{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
#kisisel .pk-tik-satir{cursor:pointer}
#kisisel .pk-tik-satir:hover{background:var(--a-muted-bg)}
#kisisel .pk-varlik .pk-varlik-ikon{font-size:20px}
#kisisel .pk-transfer{display:flex;align-items:center;gap:12px;padding:16px;font-size:12px}
#kisisel .pk-transfer .pk-tutar{font-size:12px;font-weight:800}
#kisisel .pk-uye{width:28px;height:28px;border-radius:50%;background:var(--a-muted-bg);border:1px solid var(--a-border);display:grid;place-items:center;font-size:10px;font-weight:800;color:var(--a-muted);flex-shrink:0}
#kisisel .pk-varlik .pk-uye{width:40px;height:40px;font-size:12px}
#kisisel .pk-uyeler{overflow:hidden}
#kisisel .pk-uyeler>div{display:flex;align-items:center;gap:8px;padding:10px 12px;font-size:13px;font-weight:700}
#kisisel .pk-uyeler>div+div{border-top:1px solid var(--a-border)}
#kisisel .pk-uyeler>div>span:nth-child(2){flex:1}
#kisisel .pk-uye-ekle{background:var(--a-muted-bg)}
#kisisel .pk-uye-ekle input{flex:1;border:1px solid var(--a-border);background:var(--a-surface);color:var(--a-text);border-radius:10px;padding:8px 10px;font:inherit;font-size:13px;outline:none}
#kisisel .pk-abone{padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 1px 2px rgb(0 0 0/.04)}
#kisisel .pk-abone-ust{display:flex;align-items:center;gap:12px}
#kisisel .pk-abone .pk-varlik-ikon{width:40px;height:40px;font-size:20px;background:var(--a-muted-bg);border:1px solid var(--a-border)}
#kisisel .pk-abone .pk-ad>span{font-weight:900;font-size:14px}
#kisisel .pk-abone .pk-ad>span small{font-size:10px;font-weight:700;color:var(--a-muted)}
#kisisel .pk-abone-kat{font-size:8px !important;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-top:3px}
#kisisel .pk-abone .pk-tutar{font-weight:900;font-size:14px}
#kisisel .pk-abone .pk-tutar small{font-size:8px;text-transform:uppercase;letter-spacing:.08em}
#kisisel .pk-abone-alt{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--a-border);padding-top:12px;font-size:10px;font-weight:500}
#kisisel .pk-rozet{font-style:normal;margin-left:6px;padding:2px 6px;border-radius:6px;font-size:8px;font-weight:900;text-transform:uppercase;background:var(--a-muted-bg);color:var(--a-muted);border:1px solid var(--a-border)}
#kisisel .pk-rozet.sari{background:rgb(245 158 11/.1);color:#f59e0b;border-color:rgb(245 158 11/.2)}
#kisisel .pk-ikincil{display:block;text-align:center;color:var(--a-muted);text-decoration:none;font-weight:600}
#kisisel .pk-ikincil:hover{color:var(--a-text)}
#kisisel .pk-cipler small{font-size:10px;color:var(--a-muted);font-weight:600}
#kisisel .pk-tablo-ust{flex-wrap:wrap}
#kisisel .pk-ara{flex:1;min-width:160px;border-radius:12px;border:1px solid var(--a-border);background:var(--a-surface);color:var(--a-text);padding:8px 12px;font:inherit;font-size:13px;outline:none}
#kisisel .pk-ara:focus{border-color:var(--accent)}
#kisisel .pk-tablo-kap{overflow-x:auto}
#kisisel table.pk-tablo{width:100%;border-collapse:collapse;font-size:13px}
#kisisel .pk-tablo th{position:sticky;top:0;text-align:left;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:var(--a-muted);background:var(--a-track);padding:8px 12px;white-space:nowrap}
#kisisel .pk-tablo td{padding:9px 12px;border-top:1px solid var(--a-border);vertical-align:middle}
#kisisel .pk-tablo tr:hover td{background:color-mix(in srgb,var(--a-muted-bg) 50%,transparent)}
#kisisel .pk-tablo .say{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
#kisisel .pk-tablo .tarih{color:var(--a-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
#kisisel .pk-tablo .baslik{font-weight:600}
#kisisel .pk-tablo .gz{color:var(--a-muted)}
#kisisel .pk-kapsam{font-style:normal;font-size:10px;font-weight:800;padding:2px 8px;border-radius:99px;white-space:nowrap;background:var(--a-muted-bg);color:var(--a-muted)}
#kisisel .pk-kapsam.business{background:rgb(100 116 139/.15);color:#64748B}
#kisisel .pk-kapsam.budget{background:rgb(236 72 153/.12);color:#EC4899}
#kisisel .pk-kapsam.investment{background:rgb(99 102 241/.12);color:#6366F1}
#kisisel .pk-kapsam.personal{background:rgb(16 185 129/.12);color:#059669}
@media (max-width:640px){#kisisel .pk-tablo .gz{display:none}#kisisel .pk-tablo td,#kisisel .pk-tablo th{padding:8px}}
#kisisel .pk-daha{border:1px solid var(--a-border);background:var(--a-surface);color:var(--a-text);border-radius:12px;padding:10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
#kisisel .pk-donen{width:32px;height:32px;margin:96px auto;border-radius:50%;border:2px solid var(--a-border);border-top-color:transparent;animation:pk-don 1s linear infinite}
@keyframes pk-don{to{transform:rotate(360deg)}}`;
  document.head.append(s);
}
