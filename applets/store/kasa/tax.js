// Sole proprietorship tax estimate and filing calendar: a port of Speys's Ledger (`apps/kasa/vergi/hesap.ts`,
// `oranlar.ts`, `takvim.ts`) and of the server's monthly tax data (`kasa.tax_months`). Pure: no file, no network,
// the same input always gives the same output. Amounts in TRY, rates in percent (20 = 20%).
//
// Flow, as in Speys:
//   profit  = income without VAT - expense without VAT (capital, owner's withdrawals and tax payments are outside;
//             Bağ-Kur is an expense). With Bağ-Kur on but no `sgk` entry at all, the monthly premium x months counts.
//   base    = profit - young entrepreneur exemption (at most the yearly amount)
//   tax     = income tax brackets, slice by slice
//   payable = tax - withholding the customers kept (credited). Provisional taxes are the part of this paid during
//             the year, not added on top.
// Provisional tax: cumulative profit to the period's end x 15%, minus withholding so far and earlier periods' tax.
//
// Dates are calendar days ("YYYY-MM-DD"); `today` may also be a Date (its local day is used, as Speys does).
import { cash, isOperating, net, vat } from "./ledger.js";

// —— Rates: the single source, per year (Speys `oranlar.ts`, 24 Oct 2026) ——
// "to verify" marks a value not confirmed from the official text: given by the user or the accountant.
// A new year: add its record (copy the previous one). A missing year falls back to the nearest earlier known year
// and says `estimated: true`.

export const TAX_YEARS = {
  2026: {
    year: 2026,
    incomeTax: {
      // `upTo` is the bracket's upper limit (inclusive), null on the last one. Non-wage income tariff.
      brackets: [
        { upTo: 190_000, rate: 15 },
        { upTo: 400_000, rate: 20 },
        { upTo: 1_000_000, rate: 27 },
        { upTo: 5_300_000, rate: 35 },
        { upTo: null, rate: 40 },
      ],
      source: "GVK md. 103, 332 Seri No GVK Genel Tebliği (ücret dışı tarife)",
    },
    youngEntrepreneur: {
      // Yearly profit exemption, for `years` tax years.
      exemption: 400_000,
      years: 3,
      // Removed by Law 7566: no premium support in 2026.
      bagkurSupport: false,
      source: "GVK mükerrer md. 20; prim desteği: 7566 sayılı Kanun",
    },
    bagkur: {
      // 4/b monthly premium at the lower limit. 0 while employed (4/a): setting "none".
      monthly: { discounted: 10_156.73, full: 11_808.23 },
      ceiling: { discounted: 91_410.53, full: 106_274.03 },
      // Paid on the last day of each month (the previous month's premium): to verify.
      source: "SGK 2026 4/b prim tutarları (5 puan indirim zamanında ödeyene)",
    },
    vat: {
      rates: [1, 10, 20],
      // Filed and paid on this day of the month after the period.
      filingDay: 28,
      source: "KDV Kanunu md. 28, 41; beyan dönemi izleyen ayın 28'i",
    },
    withholding: {
      // What a customer keeps from self-employment income; none on commercial income.
      professional: 20,
      source: "GVK md. 94/2-b",
    },
    provisionalTax: {
      rate: 15,
      // Last months of the periods (Jan–Mar, Apr–Jun, Jul–Sep).
      periodEndMonths: [3, 6, 9],
      // Filed and paid this many months after the period's end, on `filingDay`.
      filingMonthOffset: 2,
      filingDay: 17,
      // 2026 deadlines: 18 May (17 May is a Sunday), 17 Aug, 17 Nov. The accountant wrote 4 periods; the fourth
      // was abolished; whether he charges 4 times is another matter: to verify.
      source: "GVK mükerrer md. 120; kümülatif, 3 dönem",
    },
    withholdingReturn: {
      // Quarterly withholding (and premium service) return: last months of the periods.
      periodEndMonths: [3, 6, 9, 12],
      filingDay: 26,
      source: "GVK md. 98; üç aylık beyan, dönemi izleyen ayın 26'sı",
    },
    annualReturn: {
      // Filed in March for last year's profit, paid in two installments: [month, day].
      month: 3,
      lastDay: 31,
      installments: [
        [3, 31],
        [7, 31],
      ],
      source: "GVK md. 92, 117: Mart'ta beyan, Mart ve Temmuz'da iki taksit",
    },
    // Stamp duty per return.
    stampDuty: {
      vat: 791.0,
      withholding: 791.0,
      withholdingPremium: 939.7,
      annualIncome: 1_189.5,
      // The provisional tax return's stamp duty: to verify.
      provisional: 791.0,
      source: "71 Seri No DVK Genel Tebliği (2026)",
    },
    accountant: {
      // The date of the quote. Whether the amounts include VAT is unknown (null): to verify. The VAT return (791)
      // and withholding return (940) amounts equal the stamp duty: they may be the duty, not a fee: to verify.
      date: "2026-10-24",
      vatIncluded: null,
      // `once`: a single entry (setup), the others recurring rules. `month`: the month for yearly, the first month
      // for quarterly (1 → Jan, Apr, Jul, Oct). `day`: the quote has no day; chosen near the return's deadline.
      items: [
        { key: "kurulus", amount: 2_250, cycle: "once", day: 1 },
        { key: "muhasebe", amount: 3_600, cycle: "monthly", day: 1 },
        { key: "kdvBeyani", amount: 791, cycle: "monthly", day: 28 },
        { key: "muhtasar", amount: 940, cycle: "quarterly", month: 1, day: 26 },
        { key: "geciciVergi", amount: 1_085, cycle: "quarterly", month: 2, day: 17 },
        { key: "yillikBeyan", amount: 2_000, cycle: "yearly", month: 3, day: 31 },
      ],
      // The quote's yearly total (setup excluded), to check the items against.
      yearlyTotal: 62_792,
      source: "Kullanıcının mali müşavirinin teklifi, 24 Ekim 2026",
    },
  },
};

/** The year's rates. A year not in the table uses the nearest earlier known year (else the first) and `estimated`. */
export function taxYear(year) {
  if (TAX_YEARS[year]) return { rates: TAX_YEARS[year], year, usedYear: year, estimated: false };
  const known = Object.keys(TAX_YEARS).map(Number).sort((a, b) => a - b);
  const before = known.filter((y) => y < year);
  const used = before.length > 0 ? before[before.length - 1] : known[0];
  return { rates: TAX_YEARS[used], year, usedYear: used, estimated: true };
}

// English titles of the accountant items (Speys `Musavir.items.<key>`); the page translates them with t().
const ACCOUNTANT_TITLES = {
  kurulus: "Accountant: setup",
  muhasebe: "Accountant: monthly bookkeeping",
  kdvBeyani: "Accountant: VAT return",
  muhtasar: "Accountant: withholding return",
  geciciVergi: "Accountant: provisional tax",
  yillikBeyan: "Accountant: annual income tax return",
};

/** The months a quarterly rule falls on, from its first month (2 → [2, 5, 8, 11]). */
export const quarterMonths = (first) => [0, 3, 6, 9].map((k) => ((first - 1 + k) % 12) + 1).sort((a, b) => a - b);

/**
 * The accountant's fee items for a template screen, shaped for `saveRule` (recurring) or `saveEntry` (`once`).
 * As in Speys: category `muhasebe`, rules not auto-paid (they fall due as pending), `templateKey` `musavir:<key>`
 * to tell an item already added; `selected` is Speys's default tick (every recurring item, not the setup).
 */
export function accountantItems(year = new Date().getFullYear()) {
  const { rates, usedYear, estimated } = taxYear(year);
  const a = rates.accountant;
  return {
    date: a.date,
    vatIncluded: a.vatIncluded,
    yearlyTotal: a.yearlyTotal,
    usedYear,
    estimated,
    items: a.items.map((k) => ({
      key: k.key,
      templateKey: `musavir:${k.key}`,
      title: ACCOUNTANT_TITLES[k.key],
      direction: "out",
      category: "muhasebe",
      amount: k.amount,
      cycle: k.cycle,
      dayOfMonth: k.day,
      monthOfYear: k.cycle === "monthly" || k.cycle === "once" ? null : (k.month ?? 1),
      autoPaid: false,
      selected: k.cycle !== "once",
    })),
  };
}

// —— Settings ——

/**
 * Local settings `{ youngEntrepreneur, bagkur, activity }`, filled the way Speys's `kasa.get_settings` does: a
 * missing value takes the default (false, "none", "commercial") and `configured` is false when none was set.
 * Speys shows no estimate and no calendar until the business has set them.
 */
export function taxSettings(s) {
  const has = (k) => s != null && typeof s === "object" && s[k] != null;
  return {
    configured: has("youngEntrepreneur") || has("bagkur") || has("activity"),
    youngEntrepreneur: has("youngEntrepreneur") ? s.youngEntrepreneur === true : false,
    bagkur: ["none", "discounted", "full"].includes(s?.bagkur) ? s.bagkur : "none",
    activity: s?.activity === "professional" ? "professional" : "commercial",
  };
}

// —— Monthly data (`kasa.tax_months`) ——

/**
 * The server's monthly tax rows, over the ledger's entries: one row per year, month and status. Deleted entries are
 * skipped; `fromYear` / `toYear` limit the range (both optional). Amounts without VAT, as in Speys.
 */
export function taxMonths(entries, { fromYear = -Infinity, toYear = Infinity } = {}) {
  const rows = new Map();
  for (const e of entries ?? []) {
    if (e.deletedAt) continue;
    const year = +e.entryDate.slice(0, 4), month = +e.entryDate.slice(5, 7);
    if (year < fromYear || year > toYear) continue;
    const status = e.status === "pending" ? "pending" : "paid";
    const k = `${year}-${month}-${status}`;
    if (!rows.has(k)) {
      rows.set(k, { year, month, status, incomeNet: 0, expenseNet: 0, sgkNet: 0, withholding: 0, vatCollected: 0, vatPaid: 0, capitalIn: 0, ownerDraw: 0 });
    }
    const r = rows.get(k);
    const operating = isOperating(e.direction, e.category);
    if (e.direction === "in") {
      if (operating) { r.incomeNet += net(e); r.vatCollected += vat(e); }
      // As in SQL: every incoming entry's withholding, operating or not.
      r.withholding += Number(e.withholding) || 0;
      if (e.category === "sermaye") r.capitalIn += cash(e);
    } else {
      if (operating) { r.expenseNet += net(e); r.vatPaid += vat(e); }
      if (e.category === "sgk") r.sgkNet += net(e);
      if (e.category === "ortak_cekis") r.ownerDraw += cash(e);
    }
  }
  return [...rows.values()].sort((a, b) => a.year - b.year || a.month - b.month || a.status.localeCompare(b.status));
}

const EMPTY = Object.freeze({ income: 0, expense: 0, sgk: 0, withholding: 0, vatCollected: 0, vatPaid: 0 });
const monthKey = (year, month) => `${year}-${month}`;

/**
 * Sums the rows month by month. Commercial income counts an invoice issued but not collected (accrual; VAT is born
 * with the invoice), professional income only what was collected (to verify in Speys). Withholding only from paid
 * entries in both cases: it can't be credited before it is kept.
 */
export function monthTotals(rows, activity) {
  const out = new Map();
  for (const s of rows) {
    const counts = s.status === "paid" || activity === "commercial";
    const k = monthKey(s.year, s.month);
    const t = { ...(out.get(k) ?? EMPTY) };
    if (counts) {
      t.income += s.incomeNet;
      t.expense += s.expenseNet;
      t.sgk += s.sgkNet;
      t.vatCollected += s.vatCollected;
      t.vatPaid += s.vatPaid;
    }
    if (s.status === "paid") t.withholding += s.withholding;
    out.set(k, t);
  }
  return out;
}

export const monthTotal = (months, year, month) => months.get(monthKey(year, month)) ?? EMPTY;

/**
 * The month's VAT to pay: collected - paid - carried over from earlier months, carrying from January of `startYear`
 * (older carry-over is unknown, as in Speys where the data starts last year).
 */
export function vatStatus(months, year, month, startYear) {
  let carry = 0, diff = 0;
  for (let i = startYear * 12; i <= year * 12 + month - 1; i++) {
    const t = monthTotal(months, Math.floor(i / 12), (i % 12) + 1);
    diff = t.vatCollected - t.vatPaid - carry;
    carry = Math.max(0, -diff);
  }
  return { payable: Math.max(0, diff), carried: carry };
}

/** The base's income tax and the rate of the bracket it reaches (marginal). */
export function incomeTax(base, brackets) {
  let tax = 0, lower = 0, marginalRate = brackets[0]?.rate ?? 0;
  for (const b of brackets) {
    const upper = b.upTo ?? Infinity;
    if (base > lower) {
      tax += ((Math.min(base, upper) - lower) * b.rate) / 100;
      marginalRate = b.rate;
    }
    lower = upper;
  }
  return { tax, marginalRate };
}

export const bagkurMonthly = (setting, rates) =>
  setting === "discounted" ? rates.bagkur.monthly.discounted : setting === "full" ? rates.bagkur.monthly.full : 0;

// —— Dates (calendar days, no time zone) ——

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const isoOf = (d) => iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
const lastDay = (y, m) => utc(y, m + 1, 0).getUTCDate();

/** `today` as { y, m, d }: a "YYYY-MM-DD" string, or a Date's local day. */
function dayOf(today) {
  if (today instanceof Date) return { y: today.getFullYear(), m: today.getMonth() + 1, d: today.getDate() };
  const s = String(today);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error("Invalid date");
  return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) };
}

/**
 * A filing / payment deadline (YYYY-MM-DD). A day past the month's end becomes its last day; a weekend moves to the
 * next working day. Public holidays aren't known (as in Speys). `month` may pass 12 (13 = next year's January).
 */
export function deadline(year, month, day) {
  const first = utc(year, month, 1);
  const y = first.getUTCFullYear(), m = first.getUTCMonth() + 1;
  const d = utc(y, m, Math.min(day, lastDay(y, m)));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return isoOf(d);
}

/** How many months of the year have passed (fractional): a past year 12, a future year 0. */
export function monthsElapsed(year, today) {
  const t = dayOf(today);
  if (year < t.y) return 12;
  if (year > t.y) return 0;
  return t.m - 1 + t.d / lastDay(year, t.m);
}

// —— Estimate (Speys `vergiTahmini`) ——

/**
 * The year's estimate from monthly totals. `yearEnd` projects linearly to the year's end (only in the current year,
 * once at least a month has passed). Field names map Speys's: see the return below.
 */
export function taxEstimate({ year, months, settings, rates, today, yearEnd = false }) {
  const t = dayOf(today);
  const elapsed = monthsElapsed(year, today);
  const projected = yearEnd && year === t.y && elapsed >= 1;
  const factor = projected ? 12 / elapsed : 1;

  const total = (lastMonth) => {
    const s = { income: 0, expense: 0, sgk: 0, withholding: 0 };
    for (let m = 1; m <= lastMonth; m++) {
      const a = monthTotal(months, year, m);
      s.income += a.income;
      s.expense += a.expense;
      s.sgk += a.sgk;
      s.withholding += a.withholding;
    }
    return s;
  };

  const yearly = total(12);
  const premium = bagkurMonthly(settings.bagkur, rates);
  // With no Bağ-Kur entry at all the expected premium counts as expense: the full months passed, 12 when projected.
  const sgkAssumedMonths = premium > 0 && yearly.sgk === 0 ? (projected ? 12 : Math.floor(elapsed)) : 0;
  const sgkAssumed = premium * sgkAssumedMonths;

  const income = yearly.income * factor;
  const expense = yearly.expense * factor + sgkAssumed;
  const withholding = yearly.withholding * factor;
  const profit = income - expense;
  const exemptionCap = settings.youngEntrepreneur ? rates.youngEntrepreneur.exemption : 0;
  const exemption = Math.min(Math.max(profit, 0), exemptionCap);
  const base = Math.max(0, profit - exemption);
  const { tax, marginalRate } = incomeTax(base, rates.incomeTax.brackets);
  const payable = Math.max(0, tax - withholding);
  const monthsLeft = year === t.y ? 12 - (t.m - 1) : year > t.y ? 12 : 0;

  // Provisional tax: with the real data (no year-end factor).
  const pv = rates.provisionalTax;
  const provisional = [];
  let earlier = 0;
  pv.periodEndMonths.forEach((lastMonth, i) => {
    const firstMonth = i === 0 ? 1 : pv.periodEndMonths[i - 1] + 1;
    const started = elapsed > firstMonth - 1;
    const complete = elapsed >= lastMonth;
    // A period not over yet: the months so far.
    const s = total(Math.min(lastMonth, Math.ceil(elapsed)));
    const sgkMonths = premium > 0 && yearly.sgk === 0 ? Math.min(lastMonth, Math.floor(elapsed)) : 0;
    const cumulativeProfit = s.income - s.expense - premium * sgkMonths;
    // The exemption is assumed to apply to provisional tax too: to verify (as in Speys).
    const cumulativeBase = Math.max(0, cumulativeProfit - Math.min(Math.max(cumulativeProfit, 0), exemptionCap));
    const cumulativeTax = (cumulativeBase * pv.rate) / 100;
    const amount = started ? Math.max(0, cumulativeTax - s.withholding - earlier) : 0;
    earlier += amount;
    provisional.push({
      period: i + 1,
      firstMonth,
      lastMonth,
      deadline: deadline(year, lastMonth + pv.filingMonthOffset, pv.filingDay),
      complete,
      started,
      cumulativeProfit,
      cumulativeTax,
      amount,
    });
  });
  const todayIso = iso(t.y, t.m, t.d);
  const nextProvisional = provisional.find((p) => p.started && p.deadline >= todayIso) ?? null;

  return {
    year,
    yearEnd: projected,
    factor,
    monthsElapsed: elapsed,
    income,
    expense, // Bağ-Kur assumption included
    sgkRecorded: yearly.sgk * factor,
    sgkAssumed,
    sgkAssumedMonths,
    profit,
    exemption,
    base,
    tax,
    marginalRate,
    effectiveRate: profit > 0 ? tax / profit : 0,
    withholding,
    payable,
    excessWithholding: Math.max(0, withholding - tax),
    monthlyReserve: payable / 12,
    monthsLeft,
    monthlyReserveLeft: monthsLeft > 0 ? payable / monthsLeft : 0,
    provisional,
    nextProvisional,
  };
}

// —— Filing calendar (Speys `beyanTakvimi`) ——

// Speys sorts same-day items by its Turkish type names; this keeps that order.
const TYPE_ORDER = { bagkur: 0, provisional: 1, vat: 2, withholding: 3, annual: 4, annualInstallment: 5 };

/**
 * The tax deadlines from `today` to `today + days`: VAT, withholding return, provisional tax, annual return and its
 * installment, Bağ-Kur. Amounts where the ledger can compute them, else null (the withholding return's amount isn't
 * in the ledger).
 */
export function filingCalendar({ today, days = 60, months, settings }) {
  const t = dayOf(today);
  const from = iso(t.y, t.m, t.d);
  const end = utc(t.y, t.m, t.d);
  end.setUTCDate(end.getUTCDate() + days);
  const to = isoOf(end);
  const out = [];
  const add = (k) => {
    if (k.date < from || k.date > to) return;
    // The period is still running if its last day is today or later.
    const periodEnd = k.periodMonth === null ? `${k.periodYear}-12-31` : iso(k.periodYear, k.periodMonth, lastDay(k.periodYear, k.periodMonth));
    out.push({ ...k, ongoing: k.type !== "bagkur" && periodEnd >= from });
  };

  // Year by year estimate (for provisional tax and the annual installments); no year-end factor.
  const estimates = new Map();
  const estimateOf = (year) => {
    if (!estimates.has(year)) estimates.set(year, taxEstimate({ year, months, settings, rates: taxYear(year).rates, today: from, yearEnd: false }));
    return estimates.get(year);
  };

  // Periods from three months back to three ahead.
  for (let i = -3; i <= 3; i++) {
    const p = utc(t.y, t.m + i, 1);
    const year = p.getUTCFullYear(), month = p.getUTCMonth() + 1;
    const o = taxYear(year);
    const r = o.rates;

    // VAT: the month's return, on the 28th of the next month; carry-over since last January.
    {
      const date = deadline(year, month + 1, r.vat.filingDay);
      const v = vatStatus(months, year, month, t.y - 1);
      const r2 = taxYear(+date.slice(0, 4));
      add({ type: "vat", date, periodYear: year, periodMonth: month, order: null, amount: v.payable, carried: v.carried > 0, stampDuty: r2.rates.stampDuty.vat, estimated: r2.estimated });
    }

    // Withholding return (quarterly): the 26th of the month after the period.
    if (r.withholdingReturn.periodEndMonths.includes(month)) {
      const date = deadline(year, month + 1, r.withholdingReturn.filingDay);
      const r2 = taxYear(+date.slice(0, 4));
      add({ type: "withholding", date, periodYear: year, periodMonth: month, order: null, amount: null, carried: false, stampDuty: r2.rates.stampDuty.withholdingPremium, estimated: r2.estimated });
    }

    // Provisional tax: the 17th, two months after the period's end.
    const pIndex = r.provisionalTax.periodEndMonths.indexOf(month);
    if (pIndex >= 0) {
      const date = deadline(year, month + r.provisionalTax.filingMonthOffset, r.provisionalTax.filingDay);
      const period = estimateOf(year).provisional[pIndex];
      add({ type: "provisional", date, periodYear: year, periodMonth: month, order: pIndex + 1, amount: period ? period.amount : null, carried: false, stampDuty: r.stampDuty.provisional, estimated: o.estimated });
    }

    // Annual income tax: last year's return in March, two installments.
    r.annualReturn.installments.forEach(([instMonth, instDay], j) => {
      if (instMonth !== month) return;
      const profitYear = year - 1;
      const e = estimateOf(profitYear);
      const provisionalTotal = e.provisional.reduce((s, g) => s + g.amount, 0);
      const left = Math.max(0, e.payable - provisionalTotal);
      add({
        type: j === 0 ? "annual" : "annualInstallment",
        date: deadline(year, instMonth, instDay),
        periodYear: profitYear,
        periodMonth: null,
        order: j + 1,
        amount: left / r.annualReturn.installments.length,
        carried: false,
        stampDuty: j === 0 ? r.stampDuty.annualIncome : null,
        estimated: o.estimated,
      });
    });

    // Bağ-Kur: the last day of each month (the previous month's premium: to verify).
    const premium = bagkurMonthly(settings.bagkur, r);
    if (premium > 0) {
      add({ type: "bagkur", date: deadline(year, month, 31), periodYear: year, periodMonth: month, order: null, amount: premium, carried: false, stampDuty: null, estimated: o.estimated });
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

// —— The applet's entry points ——

/**
 * The year's estimate straight from the ledger. Not configured (no tax settings yet) → `{ configured: false }` and
 * nothing else computed, as Speys shows the setup prompt instead. `yearEnd` as in `taxEstimate`.
 */
export function estimate(ledger, settings, year, today, { yearEnd = false } = {}) {
  const s = taxSettings(settings);
  const y = taxYear(year);
  if (!s.configured) return { configured: false, settings: s, usedYear: y.usedYear, estimatedRates: y.estimated };
  const months = monthTotals(taxMonths(ledger?.entries), s.activity);
  return {
    configured: true,
    settings: s,
    usedYear: y.usedYear,
    estimatedRates: y.estimated,
    bagkurMonthly: bagkurMonthly(s.bagkur, y.rates),
    // As in Speys: the year-end projection can be offered only this year, once a month has passed.
    canProject: year === dayOf(today).y && monthsElapsed(year, today) >= 1,
    ...taxEstimate({ year, months, settings: s, rates: y.rates, today, yearEnd }),
  };
}

/** The next `days` days' tax deadlines from the ledger; [] when not configured (Speys draws no calendar then). */
export function calendar(ledger, settings, today, { days = 60 } = {}) {
  const s = taxSettings(settings);
  if (!s.configured) return [];
  return filingCalendar({ today, days, months: monthTotals(taxMonths(ledger?.entries), s.activity), settings: s });
}
