// The Data safety form: CSV in and out the way Play Console writes it, answers files, differences.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formDiff, formFromValues, helpPageTypes, parseCsv, readExport, schemaDrift, templateRows, valuesFromAnswers, writeCsv } from "./play-form.js";

const ANSWERS = {
  general: { collectsData: true, encryptedInTransit: true, accountCreation: ["PSL_ACM_OAUTH"], accountDeletionUrl: "https://example.com/delete", dataDeletion: "DATA_DELETION_YES" },
  types: {
    PSL_NAME: { collected: true, shared: false, ephemeral: false, required: true, collectedFor: ["PSL_APP_FUNCTIONALITY", "PSL_ACCOUNT_MANAGEMENT"], sharedFor: [] },
    PSL_PHOTOS: { collected: true, shared: false, ephemeral: false, required: false, collectedFor: ["PSL_APP_FUNCTIONALITY"], sharedFor: [] },
  },
};

test("CSV: quoted commas, doubled quotes and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\nd,,e'), [["a", "b, c", 'say "hi"'], ["d", "", "e"]]);
});

test("an answers file becomes Console's CSV and reads back the same", () => {
  const csv = writeCsv(valuesFromAnswers(ANSWERS));
  assert.match(csv, /^Question ID \(machine readable\),Response ID/);
  assert.ok(csv.includes("\r\n") && !csv.endsWith("\n"));
  const back = readExport(csv);
  assert.equal(back.rows.length, templateRows().length);
  const form = formFromValues(back.values);
  assert.deepEqual(Object.keys(form.types), ["PSL_NAME", "PSL_PHOTOS"]);
  assert.deepEqual(form.types.PSL_NAME, ANSWERS.types.PSL_NAME);
  assert.equal(form.general.dataDeletion, "DATA_DELETION_YES");
  assert.equal(writeCsv(back.values, back.rows), csv);
  assert.throws(() => readExport("name,email\nx,y"), /not a Data safety CSV export/);
});

test("differences: wrong answers, a missing type, an extra type; unanswered optional questions are skipped", () => {
  const want = formFromValues(valuesFromAnswers(ANSWERS));
  const have = formFromValues(valuesFromAnswers({
    general: { ...ANSWERS.general, encryptedInTransit: false, dataDeletion: "DATA_DELETION_NO", independentlyValidated: true },
    types: { PSL_NAME: { ...ANSWERS.types.PSL_NAME, ephemeral: true }, PSL_IN_APP_SEARCH_HISTORY: ANSWERS.types.PSL_PHOTOS },
  }));
  const d = formDiff(want, have);
  assert.deepEqual(d.filter((x) => x.area === "general").map((x) => x.id), ["encryptedInTransit", "dataDeletion"]);
  assert.deepEqual(d.find((x) => x.id === "PSL_NAME"), { area: "type", id: "PSL_NAME", field: "ephemeral", want: false, have: true });
  assert.deepEqual(d.filter((x) => x.field === "selected").map((x) => [x.id, x.want]), [["PSL_PHOTOS", true], ["PSL_IN_APP_SEARCH_HISTORY", false]]);
  assert.deepEqual(formDiff(want, want), []);
});

test("Google's help page: the same data types mean no drift, a new one is reported", () => {
  const row = (cat, name) => `<tr><td>${cat}</td><td>${name}</td><td>desc</td></tr>`;
  const names = templateRows().filter((r) => r.q.startsWith("PSL_DATA_TYPES_")).map((r) => r.label.split("/")[1]);
  const page = (list) => `<table><tr><td>Category</td><td>Data type</td><td>Description</td></tr>${list.map((n) => row("C", n.replace(" ", "&nbsp;"))).join("")}</table>`;
  assert.equal(schemaDrift(helpPageTypes(page(names))), null);
  assert.deepEqual(schemaDrift(helpPageTypes(page([...names.filter((n) => n !== "Videos"), "Biometrics"]))), { added: ["Biometrics"], removed: ["Videos"] });
  assert.equal(schemaDrift(helpPageTypes("<html></html>")), null);
});
