// Google Play's Data safety form as data, and its CSV: Play Console exports the form as a CSV ("Export to CSV") and
// imports the same format. Every row is one answer: question id, response id, value. The ids are Google's and stable;
// the labels below are the English names from Google's help page (support.google.com/googleplay/android-developer/answer/10787469).
// If Google adds or renames a data type, update CATEGORIES (the weekly check warns when the help page no longer matches).

export const PURPOSES = [
  ["PSL_APP_FUNCTIONALITY", "App functionality"],
  ["PSL_ANALYTICS", "Analytics"],
  ["PSL_DEVELOPER_COMMUNICATIONS", "Developer communications"],
  ["PSL_FRAUD_PREVENTION_SECURITY", "Fraud prevention, security, and compliance"],
  ["PSL_ADVERTISING", "Advertising or marketing"],
  ["PSL_PERSONALIZATION", "Personalization"],
  ["PSL_ACCOUNT_MANAGEMENT", "Account management"],
];

export const CATEGORIES = [
  ["PSL_DATA_TYPES_PERSONAL", "Personal info", [
    ["PSL_NAME", "Name"], ["PSL_EMAIL", "Email address"], ["PSL_USER_ACCOUNT", "User IDs"], ["PSL_ADDRESS", "Address"],
    ["PSL_PHONE", "Phone number"], ["PSL_RACE_ETHNICITY", "Race and ethnicity"], ["PSL_POLITICAL_RELIGIOUS", "Political or religious beliefs"],
    ["PSL_SEXUAL_ORIENTATION_GENDER_IDENTITY", "Sexual orientation"], ["PSL_OTHER_PERSONAL", "Other info"]]],
  ["PSL_DATA_TYPES_FINANCIAL", "Financial info", [
    ["PSL_CREDIT_DEBIT_BANK_ACCOUNT_NUMBER", "User payment info"], ["PSL_PURCHASE_HISTORY", "Purchase history"],
    ["PSL_CREDIT_SCORE", "Credit score"], ["PSL_OTHER", "Other financial info"]]],
  ["PSL_DATA_TYPES_LOCATION", "Location", [["PSL_APPROX_LOCATION", "Approximate location"], ["PSL_PRECISE_LOCATION", "Precise location"]]],
  ["PSL_DATA_TYPES_SEARCH_AND_BROWSING", "Web browsing", [["PSL_WEB_BROWSING_HISTORY", "Web browsing history"]]],
  ["PSL_DATA_TYPES_EMAIL_AND_TEXT", "Messages", [["PSL_EMAILS", "Emails"], ["PSL_SMS_CALL_LOG", "SMS or MMS"], ["PSL_OTHER_MESSAGES", "Other in-app messages"]]],
  ["PSL_DATA_TYPES_PHOTOS_AND_VIDEOS", "Photos and videos", [["PSL_PHOTOS", "Photos"], ["PSL_VIDEOS", "Videos"]]],
  ["PSL_DATA_TYPES_AUDIO", "Audio files", [["PSL_AUDIO", "Voice or sound recordings"], ["PSL_MUSIC", "Music files"], ["PSL_OTHER_AUDIO", "Other audio files"]]],
  ["PSL_DATA_TYPES_HEALTH_AND_FITNESS", "Health and fitness", [["PSL_HEALTH", "Health info"], ["PSL_FITNESS", "Fitness info"]]],
  ["PSL_DATA_TYPES_CONTACTS", "Contacts", [["PSL_CONTACTS", "Contacts"]]],
  ["PSL_DATA_TYPES_CALENDAR", "Calendar", [["PSL_CALENDAR", "Calendar events"]]],
  ["PSL_DATA_TYPES_APP_PERFORMANCE", "App info and performance", [
    ["PSL_CRASH_LOGS", "Crash logs"], ["PSL_PERFORMANCE_DIAGNOSTICS", "Diagnostics"], ["PSL_OTHER_PERFORMANCE", "Other app performance data"]]],
  ["PSL_DATA_TYPES_FILES_AND_DOCS", "Files and docs", [["PSL_FILES_AND_DOCS", "Files and docs"]]],
  ["PSL_DATA_TYPES_APP_ACTIVITY", "App activity", [
    ["PSL_USER_INTERACTION", "App interactions"], ["PSL_IN_APP_SEARCH_HISTORY", "In-app search history"], ["PSL_APPS_ON_DEVICE", "Installed apps"],
    ["PSL_USER_GENERATED_CONTENT", "Other user-generated content"], ["PSL_OTHER_APP_ACTIVITY", "Other actions"]]],
  ["PSL_DATA_TYPES_IDENTIFIERS", "Device or other IDs", [["PSL_DEVICE_ID", "Device or other IDs"]]],
].map(([id, name, types]) => ({ id, name, types: types.map(([tid, tname]) => ({ id: tid, name: tname })) }));

const ACCOUNT_METHODS = [
  ["PSL_ACM_USER_ID_PASSWORD", "Username and password"], ["PSL_ACM_USER_ID_OTHER_AUTH", "Username and other authentication"],
  ["PSL_ACM_USER_ID_PASSWORD_OTHER_AUTH", "Username, password and other authentication"], ["PSL_ACM_OAUTH", "OAuth"],
  ["PSL_ACM_OTHER", "Other"], ["PSL_ACM_NONE", "My app does not allow users to create an account"],
];
const DELETION = [["DATA_DELETION_YES", "Yes"], ["DATA_DELETION_NO", "No"], ["DATA_DELETION_NO_AUTO_DELETED", "No, but user data is automatically deleted within 90 days"]];
const OUTSIDE = [["PSL_LOGIN_WITH_OUTSIDE_APP_ID", "Identity set up outside the app"], ["PSL_LOGIN_THROUGH_EMPLOYMENT_OR_ENTERPRISE_ACCOUNT", "Employment or enterprise accounts"], ["PSL_OUTSIDE_APP_ACCOUNT_TYPE_OTHER", "Other"]];

/** The questions before the data types, in the form's order: {id, kind: bool | text | single | multi, label, options?, key}. `key` names it in the answers file. */
export const GENERAL = [
  { id: "PSL_DATA_COLLECTION_COLLECTS_PERSONAL_DATA", kind: "bool", req: "REQUIRED", key: "collectsData", label: "Does your app collect or share any of the required user data types?" },
  { id: "PSL_DATA_COLLECTION_ENCRYPTED_IN_TRANSIT", kind: "bool", key: "encryptedInTransit", label: "Is all of the user data collected by your app encrypted in transit?" },
  { id: "PSL_SUPPORTED_ACCOUNT_CREATION_METHODS", kind: "multi", key: "accountCreation", label: "Which of the following methods of account creation does your app support?", options: ACCOUNT_METHODS },
  { id: "PSL_ACM_SPECIFY", kind: "text", key: "accountCreationOther", label: "Describe the account creation method your app supports" },
  { id: "PSL_ACCOUNT_DELETION_URL", kind: "text", key: "accountDeletionUrl", label: "Add a link that users can use to request that their account and associated data is deleted" },
  { id: "PSL_SUPPORT_DATA_DELETION_BY_USER", kind: "single", key: "dataDeletion", label: "Do you provide a way for users to request that some or all of their data is deleted, without requiring them to delete their account?", options: DELETION },
  { id: "PSL_DATA_DELETION_URL", kind: "text", key: "dataDeletionUrl", label: "Data deletion URL" },
  { id: "PSL_DATA_COLLECTION_COMPLIES_FAMILY_POLICY", kind: "bool", req: "OPTIONAL", key: "familiesPolicy", label: "Do you want to show your commitment to the Families Policy in your Data safety section?" },
  { id: "PSL_INDEPENDENTLY_VALIDATED", kind: "bool", req: "OPTIONAL", key: "independentlyValidated", label: "Has your app successfully completed an independent security review (MASA)?" },
  { id: "PSL_UPI_BADGE_OPT_IN", kind: "bool", req: "OPTIONAL", key: "upiBadge", label: "Do you want to show the UPI badge on your store listing?" },
  { id: "PSL_HAS_OUTSIDE_APP_ACCOUNTS", kind: "bool", req: "OPTIONAL", key: "outsideAccounts", label: "Can users log in to your app with accounts created outside of the app?" },
  { id: "PSL_OUTSIDE_APP_ACCOUNT_TYPES", kind: "multi", key: "outsideAccountTypes", label: "How are these accounts created?", options: OUTSIDE },
  { id: "PSL_OUTSIDE_APP_ACCOUNT_TYPE_SPECIFY", kind: "text", key: "outsideAccountOther", label: "Describe how these accounts are created" },
];

const U = (type, q) => `PSL_DATA_USAGE_RESPONSES:${type}:${q}`;
const Q = { sharing: "PSL_DATA_USAGE_COLLECTION_AND_SHARING", ephemeral: "PSL_DATA_USAGE_EPHEMERAL", control: "DATA_USAGE_USER_CONTROL", collectedFor: "DATA_USAGE_COLLECTION_PURPOSE", sharedFor: "DATA_USAGE_SHARING_PURPOSE" };
const REQ = { bool: "MAYBE_REQUIRED", text: "MAYBE_REQUIRED", single: "SINGLE_CHOICE", multi: "MULTIPLE_CHOICE" };

/** Every row of the form, in Console's export order: {q, r, req, label}. */
export function templateRows() {
  const rows = [];
  for (const g of GENERAL) {
    if (g.options) for (const [r, label] of g.options) rows.push({ q: g.id, r, req: REQ[g.kind], label: `${g.label}/${label}` });
    else rows.push({ q: g.id, r: "", req: g.req || REQ[g.kind], label: g.label });
  }
  for (const c of CATEGORIES) for (const tp of c.types) rows.push({ q: c.id, r: tp.id, req: "MULTIPLE_CHOICE", label: `${c.name}/${tp.name}` });
  for (const c of CATEGORIES) {
    for (const tp of c.types) {
      const head = `Data usage and handling (${tp.name})`;
      rows.push({ q: U(tp.id, Q.sharing), r: "PSL_DATA_USAGE_ONLY_COLLECTED", req: "MULTIPLE_CHOICE", label: `${head}/Is this data collected, shared, or both?/Collected` });
      rows.push({ q: U(tp.id, Q.sharing), r: "PSL_DATA_USAGE_ONLY_SHARED", req: "MULTIPLE_CHOICE", label: `${head}/Is this data collected, shared, or both?/Shared` });
      rows.push({ q: U(tp.id, Q.ephemeral), r: "", req: "MAYBE_REQUIRED", label: `${head}/Is this data processed ephemerally?` });
      rows.push({ q: U(tp.id, Q.control), r: "PSL_DATA_USAGE_USER_CONTROL_OPTIONAL", req: "SINGLE_CHOICE", label: `${head}/Is this data required for your app, or can users choose whether it's collected?/Users can choose whether this data is collected` });
      rows.push({ q: U(tp.id, Q.control), r: "PSL_DATA_USAGE_USER_CONTROL_REQUIRED", req: "SINGLE_CHOICE", label: `${head}/Is this data required for your app, or can users choose whether it's collected?/Data collection is required (users can't turn off this data collection)` });
      for (const [field, verb] of [["collectedFor", "collected"], ["sharedFor", "shared"]]) {
        for (const [p, pname] of PURPOSES) rows.push({ q: U(tp.id, Q[field]), r: p, req: "MULTIPLE_CHOICE", label: `${head}/Why is this user data ${verb}? Select all that apply./${pname}` });
      }
    }
  }
  return rows;
}

// ---- CSV ----

const HEADER = ["Question ID (machine readable)", "Response ID (machine readable)", "Response value", "Answer requirement", "Human-friendly question label"];

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ""));
}

const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** An exported CSV as {rows: [{q, r, value, req, label}], values: Map}. Throws if it isn't the Data safety export. */
export function readExport(text) {
  const [head, ...body] = parseCsv(text);
  if (!head || head[0] !== HEADER[0] || head[1] !== HEADER[1]) throw new Error("not a Data safety CSV export");
  const rows = body.map(([q = "", r = "", value = "", req = "", label = ""]) => ({ q, r, value, req, label }));
  return { rows, values: new Map(rows.map((x) => [`${x.q}\t${x.r}`, x.value])) };
}

/** The CSV to import: the rows of `template` (the last export, so the labels are Console's own) with the answers' values. */
export function writeCsv(values, template = templateRows()) {
  const lines = [HEADER, ...template.map((x) => [x.q, x.r, values.get(`${x.q}\t${x.r}`) ?? "", x.req, x.label])];
  // Console's own export: CRLF between rows, none after the last
  return lines.map((l) => l.map(csvCell).join(",")).join("\r\n");
}

// ---- Answers ----

const bool = (v) => (v === true ? "true" : v === false ? "false" : "");

/**
 * The answers file kept in the app's repo, as CSV values. Shape:
 * { general: {collectsData, encryptedInTransit, accountCreation: [ids], accountDeletionUrl, dataDeletion: id, ...},
 *   types: { PSL_NAME: {collected, shared, ephemeral, required, collectedFor: [ids], sharedFor: [ids], why}, ... } }
 */
export function valuesFromAnswers(a) {
  const values = new Map();
  const set = (q, r, v) => values.set(`${q}\t${r}`, v);
  for (const g of GENERAL) {
    const v = a.general?.[g.key];
    if (g.kind === "multi") for (const [r] of g.options) set(g.id, r, (v || []).includes(r) ? "true" : "");
    else if (g.kind === "single") for (const [r] of g.options) set(g.id, r, v === r ? "true" : "");
    else if (g.kind === "bool") set(g.id, "", bool(v));
    else set(g.id, "", v ? String(v) : "");
  }
  for (const c of CATEGORIES) {
    for (const tp of c.types) {
      const d = a.types?.[tp.id];
      set(c.id, tp.id, d ? "true" : "");
      set(U(tp.id, Q.sharing), "PSL_DATA_USAGE_ONLY_COLLECTED", d?.collected ? "true" : "");
      set(U(tp.id, Q.sharing), "PSL_DATA_USAGE_ONLY_SHARED", d?.shared ? "true" : "");
      set(U(tp.id, Q.ephemeral), "", d ? bool(d.ephemeral) : "");
      set(U(tp.id, Q.control), "PSL_DATA_USAGE_USER_CONTROL_OPTIONAL", d && d.required === false ? "true" : "");
      set(U(tp.id, Q.control), "PSL_DATA_USAGE_USER_CONTROL_REQUIRED", d?.required === true ? "true" : "");
      for (const field of ["collectedFor", "sharedFor"]) for (const [p] of PURPOSES) set(U(tp.id, Q[field]), p, (d?.[field] || []).includes(p) ? "true" : "");
    }
  }
  return values;
}

/** CSV values back into the form's shape, for showing either side the same way: {general: {key: value}, types: {id: {...}}}. */
export function formFromValues(values) {
  const get = (q, r = "") => values.get(`${q}\t${r}`) ?? "";
  const yes = (q, r) => get(q, r) === "true";
  const general = {};
  for (const g of GENERAL) {
    if (g.kind === "multi") general[g.key] = g.options.filter(([r]) => yes(g.id, r)).map(([r]) => r);
    else if (g.kind === "single") general[g.key] = g.options.find(([r]) => yes(g.id, r))?.[0] ?? "";
    else if (g.kind === "bool") general[g.key] = get(g.id) === "true" ? true : get(g.id) === "false" ? false : null;
    else general[g.key] = get(g.id);
  }
  const types = {};
  for (const c of CATEGORIES) {
    for (const tp of c.types) {
      if (!yes(c.id, tp.id)) continue;
      const eph = get(U(tp.id, Q.ephemeral));
      types[tp.id] = {
        collected: yes(U(tp.id, Q.sharing), "PSL_DATA_USAGE_ONLY_COLLECTED"),
        shared: yes(U(tp.id, Q.sharing), "PSL_DATA_USAGE_ONLY_SHARED"),
        ephemeral: eph === "true" ? true : eph === "false" ? false : null,
        required: yes(U(tp.id, Q.control), "PSL_DATA_USAGE_USER_CONTROL_REQUIRED") ? true : yes(U(tp.id, Q.control), "PSL_DATA_USAGE_USER_CONTROL_OPTIONAL") ? false : null,
        collectedFor: PURPOSES.filter(([p]) => yes(U(tp.id, Q.collectedFor), p)).map(([p]) => p),
        sharedFor: PURPOSES.filter(([p]) => yes(U(tp.id, Q.sharedFor), p)).map(([p]) => p),
      };
    }
  }
  return { general, types };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TYPE_FIELDS = ["collected", "shared", "ephemeral", "required", "collectedFor", "sharedFor"];

/** Where Console differs from the answers: [{area: "general" | "type", id, field?, want, have}]. */
export function formDiff(want, have) {
  const out = [];
  for (const g of GENERAL) {
    const w = want.general[g.key], h = have.general[g.key];
    // an empty answer in the file means "leave it": only answered questions are compared
    if (w === null || w === "" || (Array.isArray(w) && !w.length && !(h || []).length)) continue;
    if (!same(w, h)) out.push({ area: "general", id: g.key, want: w, have: h });
  }
  for (const c of CATEGORIES) {
    for (const tp of c.types) {
      const w = want.types[tp.id], h = have.types[tp.id];
      if (!w && !h) continue;
      if (!w || !h) { out.push({ area: "type", id: tp.id, field: "selected", want: !!w, have: !!h }); continue; }
      for (const f of TYPE_FIELDS) if (!same(w[f] ?? null, h[f] ?? null)) out.push({ area: "type", id: tp.id, field: f, want: w[f], have: h[f] });
    }
  }
  return out;
}

/** Data type names from Google's help page table, to notice when the form changes. */
export function helpPageTypes(html) {
  const table = html.match(/<table[\s\S]*?<\/table>/)?.[0] || "";
  const names = [];
  for (const row of table.match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim());
    const name = cells.length >= 3 ? cells[1] : cells[0];
    if (cells.length >= 2 && name !== "Data type") names.push(name);
  }
  return names;
}

/** {added, removed} between the help page and CATEGORIES, or null when they match (or the page couldn't be read). */
export function schemaDrift(names) {
  if (names.length < 10) return null;
  const known = CATEGORIES.flatMap((c) => c.types.map((x) => x.name));
  const added = names.filter((n) => !known.includes(n)), removed = known.filter((n) => !names.includes(n));
  return added.length || removed.length ? { added, removed } : null;
}
