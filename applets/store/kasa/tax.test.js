import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TAX_YEARS, accountantItems, bagkurMonthly, calendar, deadline, estimate, incomeTax, monthTotal, monthTotals,
  monthsElapsed, quarterMonths, taxMonths, taxSettings, taxYear, vatStatus,
} from "./tax.js";

// The expected values are what Speys's `vergi/hesap.ts` and `vergi/takvim.ts` return for the same input.
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ""} ${actual} ≠ ${expected}`);
const R = TAX_YEARS[2026];

test("income tax goes bracket by bracket", () => {
  assert.deepEqual(incomeTax(0, R.incomeTax.brackets), { tax: 0, marginalRate: 15 });
  const t = incomeTax(500_000, R.incomeTax.brackets);
  near(t.tax, 28_500 + 42_000 + 27_000);
  assert.equal(t.marginalRate, 27);
  near(incomeTax(6_300_000, R.incomeTax.brackets).tax, 28_500 + 42_000 + 162_000 + 1_505_000 + 400_000);
});

test("a deadline on a weekend moves to the next working day, a short month to its last day", () => {
  assert.equal(deadline(2026, 5, 17), "2026-05-18", "17 May 2026 is a Sunday");
  assert.equal(deadline(2026, 13, 28), "2027-01-28", "month 13 is next January");
  assert.equal(deadline(2026, 2, 31), "2026-03-02", "28 Feb 2026 is a Saturday");
  assert.equal(deadline(2026, 11, 17), "2026-11-17");
});

test("months elapsed are fractional this year, 12 for a past year, 0 for a future one", () => {
  near(monthsElapsed(2026, "2026-11-09"), 10.3);
  assert.equal(monthsElapsed(2025, "2026-11-09"), 12);
  assert.equal(monthsElapsed(2027, "2026-11-09"), 0);
  near(monthsElapsed(2026, new Date(2026, 10, 9)), 10.3, "a Date is read as its local day");
});

test("a year not in the table uses the nearest known year and says so", () => {
  assert.deepEqual({ ...taxYear(2026), rates: null }, { rates: null, year: 2026, usedYear: 2026, estimated: false });
  assert.equal(taxYear(2027).usedYear, 2026);
  assert.equal(taxYear(2027).estimated, true);
  assert.equal(taxYear(2020).usedYear, 2026, "no earlier year: the first known");
  assert.equal(bagkurMonthly("discounted", R), 10_156.73);
  assert.equal(bagkurMonthly("full", R), 11_808.23);
  assert.equal(bagkurMonthly("none", R), 0);
});

test("missing settings are not configured: no estimate, no calendar", () => {
  assert.deepEqual(taxSettings(undefined), { configured: false, youngEntrepreneur: false, bagkur: "none", activity: "commercial" });
  assert.deepEqual(taxSettings({ bagkur: "full" }), { configured: true, youngEntrepreneur: false, bagkur: "full", activity: "commercial" });
  const ledger = { entries: [{ direction: "in", category: "hizmet", amount: 100, entryDate: "2026-01-01", status: "paid" }] };
  const e = estimate(ledger, {}, 2026, "2026-11-09");
  assert.equal(e.configured, false);
  assert.equal(e.payable, undefined);
  assert.deepEqual(calendar(ledger, null, "2026-11-09"), []);
});

test("monthly rows follow kasa.tax_months: without VAT, non-operating apart, deleted skipped", () => {
  const rows = taxMonths([
    { direction: "in", category: "hizmet", amount: 120, vatRate: 20, entryDate: "2026-03-01", status: "paid", withholding: 10 },
    { direction: "in", category: "sermaye", amount: 500, entryDate: "2026-03-02", status: "paid", withholding: 5 },
    { direction: "out", category: "yazilim", amount: 100, vatRate: 20, vatIncluded: false, entryDate: "2026-03-03", status: "paid" },
    { direction: "out", category: "sgk", amount: 50, entryDate: "2026-03-04", status: "paid" },
    { direction: "out", category: "ortak_cekis", amount: 300, entryDate: "2026-03-05", status: "paid" },
    { direction: "out", category: "vergi_odeme", amount: 70, entryDate: "2026-03-06", status: "paid" },
    { direction: "out", category: "yazilim", amount: 999, entryDate: "2026-03-07", status: "paid", deletedAt: "2026-03-08T00:00:00Z" },
    { direction: "in", category: "hizmet", amount: 40, entryDate: "2026-03-09", status: "pending" },
    { direction: "in", category: "hizmet", amount: 1, entryDate: "2024-01-01", status: "paid" },
  ], { fromYear: 2025 });
  assert.deepEqual(rows, [
    { year: 2026, month: 3, status: "paid", incomeNet: 100, expenseNet: 150, sgkNet: 50, withholding: 15, vatCollected: 20, vatPaid: 20, capitalIn: 495, ownerDraw: 300 },
    { year: 2026, month: 3, status: "pending", incomeNet: 40, expenseNet: 0, sgkNet: 0, withholding: 0, vatCollected: 0, vatPaid: 0, capitalIn: 0, ownerDraw: 0 },
  ]);
  // Commercial counts the unpaid invoice (accrual), professional only what was collected; withholding only when paid.
  assert.equal(monthTotal(monthTotals(rows, "commercial"), 2026, 3).income, 140);
  assert.equal(monthTotal(monthTotals(rows, "professional"), 2026, 3).income, 100);
  assert.equal(monthTotal(monthTotals(rows, "professional"), 2026, 4).income, 0);
});

test("VAT paid in excess carries to the next months", () => {
  const months = monthTotals([
    { year: 2026, month: 1, status: "paid", incomeNet: 0, expenseNet: 0, sgkNet: 0, withholding: 0, vatCollected: 100, vatPaid: 300 },
    { year: 2026, month: 2, status: "paid", incomeNet: 0, expenseNet: 0, sgkNet: 0, withholding: 0, vatCollected: 150, vatPaid: 0 },
    { year: 2026, month: 3, status: "paid", incomeNet: 0, expenseNet: 0, sgkNet: 0, withholding: 0, vatCollected: 400, vatPaid: 100 },
  ], "commercial");
  assert.deepEqual(vatStatus(months, 2026, 1, 2025), { payable: 0, carried: 200 });
  assert.deepEqual(vatStatus(months, 2026, 2, 2025), { payable: 0, carried: 50 });
  assert.deepEqual(vatStatus(months, 2026, 3, 2025), { payable: 250, carried: 0 });
  assert.deepEqual(vatStatus(months, 2026, 3, 2026), { payable: 250, carried: 0 });
});

// A commercial business, young entrepreneur, discounted Bağ-Kur with no `sgk` entry, on 9 Nov 2026.
const pad = (n) => String(n).padStart(2, "0");
const commercial = {
  entries: [
    ...Array.from({ length: 10 }, (_, i) => [
      { direction: "in", category: "hizmet", amount: 120_000, vatRate: 20, entryDate: `2026-${pad(i + 1)}-15`, status: "paid" },
      { direction: "out", category: "yazilim", amount: 12_000, vatRate: 20, vatIncluded: false, entryDate: `2026-${pad(i + 1)}-15`, status: "paid" },
    ]).flat(),
    { direction: "in", category: "hizmet", amount: 50_000, entryDate: "2026-11-05", status: "pending" },
    { direction: "in", category: "sermaye", amount: 500_000, entryDate: "2026-01-02", status: "paid" },
    { direction: "out", category: "ortak_cekis", amount: 100_000, entryDate: "2026-06-02", status: "paid" },
  ],
};
const commercialSettings = { youngEntrepreneur: true, bagkur: "discounted", activity: "commercial" };

test("the estimate: exemption, assumed Bağ-Kur, brackets, provisional periods", () => {
  const e = estimate(commercial, commercialSettings, 2026, "2026-11-09");
  assert.equal(e.configured, true);
  assert.equal(e.usedYear, 2026);
  assert.equal(e.canProject, true);
  assert.equal(e.yearEnd, false);
  near(e.income, 1_050_000, "the pending invoice counts in commercial");
  assert.equal(e.sgkAssumedMonths, 10);
  near(e.sgkAssumed, 101_567.3);
  near(e.expense, 221_567.3);
  near(e.profit, 828_432.7);
  assert.equal(e.exemption, 400_000);
  near(e.base, 428_432.7);
  near(e.tax, 78_176.829);
  assert.equal(e.marginalRate, 27);
  near(e.effectiveRate, 0.09436714533359196);
  near(e.payable, 78_176.829);
  assert.equal(e.monthsLeft, 2);
  near(e.monthlyReserve, 6_514.73575);
  near(e.monthlyReserveLeft, 39_088.4145);
  assert.deepEqual(e.provisional.map((p) => p.deadline), ["2026-05-18", "2026-08-17", "2026-11-17"]);
  [[0, 233_529.81], [10_058.943, 467_059.62], [35_029.4715, 700_589.43]].forEach(([amount, profit], i) => {
    near(e.provisional[i].amount, amount, `period ${i + 1}`);
    near(e.provisional[i].cumulativeProfit, profit, `period ${i + 1}`);
  });
  assert.equal(e.nextProvisional.period, 3);
  assert.equal(e.nextProvisional.complete, true);
});

test("the year-end projection scales the year, assumes 12 Bağ-Kur months, leaves provisional tax real", () => {
  const e = estimate(commercial, commercialSettings, 2026, "2026-11-09", { yearEnd: true });
  assert.equal(e.yearEnd, true);
  near(e.factor, 12 / 10.3);
  near(e.income, 1_223_300.9708737864);
  assert.equal(e.sgkAssumedMonths, 12);
  near(e.sgkAssumed, 121_880.76);
  near(e.tax, 114_135.88412038833);
  near(e.provisional[2].amount, 35_029.4715);
  // Not this year: no projection.
  assert.equal(estimate(commercial, commercialSettings, 2025, "2026-11-09", { yearEnd: true }).yearEnd, false);
});

test("the calendar: provisional tax, Bağ-Kur and VAT in the next 60 days", () => {
  const items = calendar(commercial, commercialSettings, "2026-11-09");
  assert.deepEqual(items.map((k) => [k.type, k.date, k.periodMonth, k.order, k.carried, k.ongoing, k.stampDuty]), [
    ["provisional", "2026-11-17", 9, 3, false, false, 791],
    ["bagkur", "2026-11-30", 11, null, false, false, null],
    ["vat", "2026-11-30", 10, null, false, false, 791],
    ["vat", "2026-12-28", 11, null, false, true, 791],
    ["bagkur", "2026-12-31", 12, null, false, false, null],
  ]);
  near(items[0].amount, 35_029.4715);
  assert.equal(items[1].amount, 10_156.73);
  near(items[2].amount, 17_600);
  assert.equal(items[3].amount, 0);
});

test("professional income: withholding is credited, the annual return's rest falls in two installments", () => {
  const ledger = {
    entries: [
      { direction: "in", category: "hizmet", amount: 600_000, withholding: 120_000, entryDate: "2025-02-10", status: "paid" },
      { direction: "in", category: "hizmet", amount: 300_000, entryDate: "2025-12-20", status: "pending" },
    ],
  };
  const settings = { youngEntrepreneur: false, bagkur: "none", activity: "professional" };
  const e = estimate(ledger, settings, 2025, "2026-03-10");
  assert.equal(e.estimatedRates, true, "2025 uses the 2026 table");
  near(e.income, 600_000, "the uncollected invoice doesn't count");
  near(e.tax, 124_500);
  near(e.withholding, 120_000);
  near(e.payable, 4_500);
  assert.deepEqual(e.provisional.map((p) => p.amount), [0, 0, 0]);
  assert.equal(e.monthsLeft, 0);

  const items = calendar(ledger, settings, "2026-03-10");
  assert.deepEqual(items.map((k) => [k.type, k.date, k.amount, k.periodYear, k.stampDuty, k.estimated, k.ongoing]), [
    ["vat", "2026-03-30", 0, 2026, 791, false, false],
    ["annual", "2026-03-31", 2_250, 2025, 1_189.5, false, false],
    ["withholding", "2026-04-27", null, 2026, 939.7, false, true],
    ["vat", "2026-04-28", 0, 2026, 791, false, true],
  ]);

  const over = estimate({ entries: [{ ...ledger.entries[0], withholding: 150_000 }] }, settings, 2025, "2026-03-10");
  assert.equal(over.payable, 0);
  near(over.excessWithholding, 25_500);
});

test("the accountant's items are ready to become rules", () => {
  const a = accountantItems(2026);
  assert.equal(a.items.length, 6);
  assert.equal(a.yearlyTotal, 62_792);
  const byKey = Object.fromEntries(a.items.map((k) => [k.key, k]));
  assert.deepEqual(byKey.muhtasar, {
    key: "muhtasar", templateKey: "musavir:muhtasar", title: "Accountant: withholding return", direction: "out", category: "muhasebe",
    amount: 940, cycle: "quarterly", dayOfMonth: 26, monthOfYear: 1, autoPaid: false, selected: true,
  });
  assert.equal(byKey.kurulus.selected, false);
  assert.equal(byKey.muhasebe.monthOfYear, null);
  // The quote's yearly total matches the recurring items.
  const yearly = a.items.reduce((s, k) => s + (k.cycle === "monthly" ? 12 : k.cycle === "quarterly" ? 4 : k.cycle === "yearly" ? 1 : 0) * k.amount, 0);
  assert.equal(yearly, a.yearlyTotal);
  assert.deepEqual(quarterMonths(2), [2, 5, 8, 11]);
  assert.deepEqual(quarterMonths(12), [3, 6, 9, 12]);
});
