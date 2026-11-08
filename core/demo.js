// The demo workspace: made-up data for trying the dashboard and taking screenshots. It is rebuilt every time it is
// opened, with dates around today. Nothing here reads the real Claude folders or any real data.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LEGACY } from "./store.js";

const DAY = 86400;
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const write = (file, text) => writeFileSync(file, text);
const writeJson = (file, value) => write(file, JSON.stringify(value, null, 1) + "\n");
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const SESSIONS = [
  ["shop-api", "Add Stripe webhooks", "add stripe webhooks for failed payments", "Webhook handler is in place. Writing the retry test now.", 20, "UserPromptSubmit"],
  ["blog", "Run the database migration", "migrate the posts table to add a slug column", "Ready to run the migration on production. Waiting for your approval.", 60, "Notification"],
  ["landing-page", "Fix the mobile header", "the header overlaps the hero on small screens", "Fixed: the header now collapses below 720px. Checked on an iPhone viewport.", 240, "Stop"],
  ["mobile-app", "Offline task sync", "make tasks work offline and sync when back online", "Tasks now queue locally and sync on reconnect. 14 tests pass.", 1500, "Stop"],
];
// What the demo sessions did, for the panel beside the office: [tool, input, result]. Paths are inside the project
// unless they start with "../". The call marked `running` has no result yet: the session is busy with it.
const patch = (start, lines) => ({ structuredPatch: [{ oldStart: start, oldLines: lines.filter((l) => !l.startsWith("+")).length, newStart: start, newLines: lines.filter((l) => !l.startsWith("-")).length, lines }] });
const STEPS = {
  "shop-api": [
    ["Read", { file_path: "src/payments/stripe.js" }],
    ["Grep", { pattern: "invoice.payment_failed", path: "src" }],
    ["WebFetch", { url: "https://docs.stripe.com/webhooks/handling-payment-events", prompt: "Which events mean a payment failed?" }],
    ["WebSearch", { query: "stripe webhook signature verification express raw body" }],
    ["Read", { file_path: "src/server.js" }],
    ["Write", { file_path: "src/payments/webhooks.js", content: "x\n".repeat(64) }, { type: "create" }],
    ["Edit", { file_path: "src/server.js", old_string: "a", new_string: "b" }, patch(12, [" import express from \"express\";", "-app.use(express.json());", "+import { webhooks } from \"./payments/webhooks.js\";", "+", "+// Stripe signs the raw body: the webhook route reads it before the JSON parser does", "+app.post(\"/webhooks/stripe\", express.raw({ type: \"application/json\" }), webhooks);", "+app.use(express.json());", " app.use(\"/api\", api);"])],
    ["Read", { file_path: "../mobile-app/src/api/payments.ts" }],
    ["Bash", { command: "npm test -- payments", description: "Run the payment tests" }, { output: "> shop-api@2.4.0 test\n> node --test test/payments\n\n✔ charges a saved card (41ms)\n✔ refunds a partial amount (12ms)\n✖ marks an invoice unpaid when the payment fails\n  Expected status 200, got 400: No signatures found matching the expected signature\n\nℹ tests 3\nℹ pass 2\nℹ fail 1" }],
    ["Edit", { file_path: "src/payments/webhooks.js", old_string: "a", new_string: "b" }, patch(28, ["   switch (event.type) {", "-    case \"invoice.payment_failed\":", "-      await markUnpaid(event.data.object);", "-      break;", "+    case \"invoice.payment_failed\": {", "+      const invoice = event.data.object;", "+      await markUnpaid(invoice);", "+      // try again in 1, 3 and 7 days before the account is paused", "+      await scheduleRetry(invoice.id, [1, 3, 7]);", "+      break;", "+    }", "   }"])],
    ["Write", { file_path: "test/webhooks.test.js", content: "x\n".repeat(41) }, { type: "create" }],
    ["Bash", { command: "npm test -- webhooks", description: "Run the webhook tests" }, "running"],
  ],
  blog: [
    ["Read", { file_path: "db/schema.sql" }],
    ["Write", { file_path: "db/migrations/0012_add_slug.sql", content: "x\n".repeat(12) }, { type: "create" }],
    ["Edit", { file_path: "src/posts.js", old_string: "a", new_string: "b" }, patch(40, ["-export const postUrl = (post) => `/posts/${post.id}`;", "+export const postUrl = (post) => `/posts/${post.slug ?? post.id}`;"])],
    ["Bash", { command: "npm run migrate -- --dry-run", description: "Check the migration" }, { output: "Would apply 1 migration:\n  0012_add_slug.sql  ALTER TABLE posts ADD COLUMN slug text UNIQUE\nNothing was changed (dry run)." }],
    ["Bash", { command: "psql \"$PRODUCTION_DATABASE_URL\" -f db/migrations/0012_add_slug.sql", description: "Run the migration on production" }, "running"],
  ],
  "landing-page": [
    ["Read", { file_path: "src/components/Header.css" }],
    ["WebSearch", { query: "css header collapse menu below 720px" }],
    ["Edit", { file_path: "src/components/Header.css", old_string: "a", new_string: "b" }, patch(31, ["-.header { position: fixed; height: 96px; }", "+.header { position: sticky; top: 0; min-height: 64px; }", "+@media (max-width: 720px) {", "+  .header nav { display: none; }", "+  .header .menu-button { display: flex; }", "+}"])],
    ["Edit", { file_path: "src/components/Header.jsx", old_string: "a", new_string: "b" }, patch(18, ["   <nav>{links}</nav>", "+  <button className=\"menu-button\" onClick={toggle} aria-label=\"Menu\">", "+    <MenuIcon />", "+  </button>"])],
    ["Bash", { command: "npx playwright test header --project=iphone", description: "Check the header on a phone" }, { output: "Running 4 tests using 2 workers\n  ✓ header collapses below 720px (1.2s)\n  ✓ menu button opens the nav (0.9s)\n  ✓ hero is not covered (0.7s)\n  ✓ header stays on top while scrolling (1.1s)\n\n  4 passed (3.4s)" }],
    ["Bash", { command: "git commit -am \"Collapse the header below 720px\"", description: "Commit the fix" }],
    ["Bash", { command: "git push origin main", description: "Push" }, { output: "To github.com:example/landing-page.git\n   4e1a9c2..b7d03f1  main -> main" }],
  ],
};

const SENTENCES = [
  "please check the database migration and fix the error in the deploy script",
  "can you update the readme with the install instructions and the screenshots",
  "the function should return the user profile and handle the missing account case",
  "add a test for the payment webhook and make sure the retry logic works",
  "refactor the component so the header and the footer share the same layout",
  "look at the failing build and tell me which dependency broke the release",
  "write a short summary of what changed in this branch before we merge",
  "make the dashboard faster and remove the query that runs on every request",
];
const TYPOS = { please: "plase", check: "chekc", database: "databse", the: "teh", update: "udpate", function: "funciton", should: "shoudl", return: "retrun", component: "componet", which: "whcih", write: "wirte", summary: "sumary", before: "befroe", remove: "remvoe", request: "reqeust" };
const PRACTICE_MISTAKES = [[["chekc", "check"]], [["teh", "the"], ["databse", "database"]], [["funciton", "function"]], [["udpate", "update"]], [["retrun", "return"], ["teh", "the"]], [["shoudl", "should"]], [["wirte", "write"]], [["plase", "please"]]];

function seedClaude(dir) {
  const now = Date.now() / 1000, claude = join(dir, "demo-claude"), events = [];
  SESSIONS.forEach(([project, title, ask, reply, age, event], i) => {
    const folder = join(dir, "projects", project);
    mkdirSync(folder, { recursive: true });
    const logs = join(claude, "projects", `demo-${project}`);
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(folder, ".git"), { recursive: true }); // where the project ends, for what counts as outside it
    const id = `demo-${i}`, stamp = new Date((now - age) * 1000).toISOString(), file = join(logs, `${id}.jsonl`);
    const steps = STEPS[project] ?? [], done = [], running = [];
    steps.forEach(([name, input, result], n) => {
      const at = new Date((now - age - (steps.length - n) * 35) * 1000).toISOString(), call = `${id}-${n}`;
      if (input.file_path) input = { ...input, file_path: resolve(folder, input.file_path) };
      const base = { sessionId: id, cwd: folder, timestamp: at };
      const use = { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: call, name, input }] } };
      if (result === "running") return running.push(use);
      done.push(use, { ...base, type: "user", toolUseResult: result ?? {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: result?.output ?? "ok", is_error: false }] } });
    });
    write(file, jsonl([
      // the request comes before the work it started
      { type: "user", sessionId: id, cwd: folder, timestamp: new Date((now - age - (steps.length + 1) * 35) * 1000).toISOString(), message: { role: "user", content: ask } },
      ...done,
      { type: "assistant", sessionId: id, cwd: folder, timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: reply }] } },
      ...running,
      { type: "ai-title", sessionId: id, aiTitle: title },
      { type: "last-prompt", sessionId: id, lastPrompt: ask },
    ]));
    utimesSync(file, now - age, now - age);
    events.push({ zaman: now - age, olay: event, oturum: id, ...(event === "Notification" ? { onay: true, mesaj: "Claude needs your permission to use Bash" } : {}) });
  });
  mkdirSync(join(dir, "apps", "claude"), { recursive: true });
  write(join(dir, "apps", "claude", "olaylar.jsonl"), jsonl(events));

  // Four weeks of messages with fewer typos over time, for Typo Check. A fixed pattern keeps the numbers stable.
  const logs = join(claude, "projects", "demo-typing");
  mkdirSync(logs, { recursive: true });
  const rows = [];
  let tick = 0;
  for (let day = 28; day >= 1; day--) {
    for (let n = 0; n < 14; n++) {
      const words = SENTENCES[n % SENTENCES.length].split(" ").map((w) => (TYPOS[w] && ++tick % Math.round(30 - day * 0.6) === 0 ? TYPOS[w] : w));
      rows.push({ type: "user", sessionId: `t${day}`, cwd: join(dir, "projects"), timestamp: new Date((now - day * DAY + n * 600) * 1000).toISOString(), message: { role: "user", content: words.join(" ") } });
    }
  }
  const file = join(logs, "typing.jsonl");
  write(file, jsonl(rows));
  utimesSync(file, now - 3 * DAY, now - 3 * DAY);
  mkdirSync(join(dir, "apps", "yazim"), { recursive: true });
  const accuracy = [86, 88, 87, 90, 92, 91, 94, 96];
  write(join(dir, "apps", "yazim", "alistirmalar.jsonl"), jsonl(accuracy.map((a, i) => {
    const d = new Date((now - (accuracy.length - i) * 2 * DAY) * 1000);
    return { zaman: `${iso(d)} 18:${pad(10 + i)}`, kelime: 30, dogru: Math.round((30 * a) / 100), kdk: +(42 + i * 1.7).toFixed(1), ritim: +(38 - i * 2.1).toFixed(1), hatalar: PRACTICE_MISTAKES[i] };
  })));
  return claude;
}

function seedTasks(dir) {
  const shop = join(dir, "projects", "shop-api", "tasks"), site = join(dir, "projects", "landing-page", "tasks");
  mkdirSync(shop, { recursive: true });
  mkdirSync(site, { recursive: true });
  write(join(shop, "backlog.md"), `# Backlog

## This week

- [ ] Add Stripe webhooks #bugün
  Failed payments should retry twice, then email the customer.
  - [x] Webhook handler
  - [ ] Retry test
- [ ] Review the pricing page copy #bugün
- [x] Move images to the CDN #bugün #bitti-${dayOffset(0)}
- [ ] Write the launch post #bu-hafta
- [x] Rotate the API keys #bitti-${dayOffset(-2)}

## Later

- [ ] Dark mode for the invoice page
- [ ] Export orders as CSV
- [ ] Invite teammates by link
`);
  write(join(shop, "bugs.md"), "# Bugs\n\n- [ ] Checkout button stays disabled after a failed card\n- [ ] Search ignores accents\n");
  write(join(site, "launch.md"), "# Launch\n\n- [ ] Fix the mobile header #bugün\n- [ ] Record the demo video\n- [ ] Submit to Product Hunt\n");
  return [
    { id: "shop", name: "Shop API", folder: shop, pattern: "*.md", finishDate: true },
    { id: "site", name: "Landing page", folder: site, pattern: "*.md", finishDate: true },
  ];
}

function seedCrm(dir) {
  const business_id = "demo-business", pipeline_id = "demo-sales", now = new Date().toISOString();
  const stages = [["new", "New", "open", "#64748B"], ["contacted", "Contacted", "open", "#0EA5E9"], ["proposal", "Proposal sent", "open", "#8B5CF6"], ["won", "Won", "won", "#10B981"], ["lost", "Lost", "lost", "#EF4444"]];
  const deals = [
    ["Northwind Traders", "contacted", "Send the revised quote", -2, "Dana Reyes"],
    ["Lumen Dental", "proposal", "Call about the proposal", 0, "Sam Okafor"],
    ["Acme Coffee", "contacted", "Book a demo", 0, "Priya Nair"],
    ["Oak & Iron", "proposal", "Check if the contract is signed", 3, "Lee Park"],
    ["Blue Bottle Studio", "new", "First call", 6, "Mia Chen"],
    ["Harbor Yoga", "new", null, null, null],
    ["Fable Books", "won", null, null, "Noor Haddad"],
  ];
  mkdirSync(join(dir, "apps", "crm"), { recursive: true });
  writeJson(join(dir, "apps", "crm", "veri.json"), {
    isletmeler: [{ id: business_id, name: "My Studio" }], ayarlar: [],
    hatlar: [{ id: pipeline_id, business_id, name: "Sales", position: 0 }],
    asamalar: stages.map(([key, label, kind, color], position) => ({ pipeline_id, key, label, kind, color, position })),
    kayitlar: deals.map(([title, stage, next_action, inDays, contact_name], i) => ({
      id: `demo-deal-${i}`, business_id, pipeline_id, title, stage, next_action, contact_name,
      next_action_at: inDays === null ? null : dayOffset(inDays), products: [], created_at: now, yerel: true,
    })),
    gorusmeler: [], gunluk: [],
  });
}

async function seedLedger(dir, root) {
  const { emptyLedger, saveEntry } = await import(pathToFileURL(join(root, "applets", "store", "kasa", "ledger.js")).href);
  const ledger = emptyLedger(), today = new Date();
  const inMonth = (day) => iso(new Date(today.getFullYear(), today.getMonth(), Math.min(day, today.getDate())));
  for (const [direction, title, amount, category, day] of [
    ["in", "Client invoice: Northwind", 48000, "hizmet", 3], ["in", "Client invoice: Fable Books", 22500, "hizmet", 12], ["in", "Template sales", 6400, "satis", 18],
    ["out", "Coworking desk", 6500, "kira", 1], ["out", "Figma", 1450, "yazilim", 2], ["out", "Hosting", 980, "yazilim", 5], ["out", "Laptop repair", 3200, "ekipman", 9], ["out", "Newsletter ads", 4200, "pazarlama", 15],
  ]) saveEntry(ledger, { direction, title, amount, category, entryDate: inMonth(day), status: "paid" });
  mkdirSync(join(dir, "apps", "kasa"), { recursive: true });
  writeJson(join(dir, "apps", "kasa", "defter.json"), ledger);
}

function seedSocial(dir) {
  const root = join(dir, "social");
  mkdirSync(root, { recursive: true });
  const steps = (render, paylasildi) => ({ veri: true, kesit: render, render, paylasildi });
  writeJson(join(root, "takvim.json"), {
    hesaplar: [
      { id: "studio", ad: "My Studio", kullanici: "@mystudio", avatar: "", renk: "#fb7a01", takipci: 4210, gunler: [1, 3, 5] },
      { id: "founder", ad: "Founder", kullanici: "@founder", avatar: "", renk: "#7c4ddb", takipci: 1280, gunler: [2, 4] },
    ],
    videolar: [
      { id: "demo-1", hesap: "studio", tarih: dayOffset(0), baslik: "Three things we learned shipping in public", dizi: "Build log", kapak: "", adimlar: steps(true, false), aciklama: "What we'd do again, and what we wouldn't." },
      { id: "demo-2", hesap: "founder", tarih: dayOffset(0), baslik: "How I plan my week with Claude", dizi: "Workflow", kapak: "", adimlar: steps(true, true), aciklama: "My Sunday routine, start to finish." },
      { id: "demo-3", hesap: "studio", tarih: dayOffset(2), baslik: "Our landing page, before and after", dizi: "Build log", kapak: "", adimlar: steps(false, false), aciklama: "" },
      { id: "demo-4", hesap: "founder", tarih: dayOffset(-3), baslik: "The tool I built in one afternoon", dizi: "Workflow", kapak: "", adimlar: steps(true, true), aciklama: "", rakamlar: {} },
    ],
    kuyruk: [], arka_plan: [],
  });
  return root;
}

function seedHabits(dir) {
  mkdirSync(join(dir, "apps", "today"), { recursive: true });
  writeJson(join(dir, "apps", "today", "habits.json"), {
    habits: [{ id: "morning-walk", name: "Morning walk" }, { id: "inbox-zero", name: "Clear the inbox" }, { id: "read", name: "Read for 20 minutes" }],
    log: { [dayOffset(0)]: ["morning-walk"] },
  });
}

// A made-up app's store look, drawn here so the screenshot of Store Check isn't empty: an icon and phone screens.
const svgData = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
function demoIcon(from, to) {
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`
    + `<rect width="128" height="128" fill="url(#g)"/><rect x="30" y="34" width="68" height="62" rx="10" fill="#fff"/><rect x="30" y="34" width="68" height="16" rx="8" fill="#fff" opacity=".7"/>`
    + `<g fill="${to}"><rect x="40" y="58" width="12" height="10" rx="3"/><rect x="58" y="58" width="12" height="10" rx="3"/><rect x="76" y="58" width="12" height="10" rx="3" opacity=".4"/><rect x="40" y="74" width="12" height="10" rx="3" opacity=".4"/><rect x="58" y="74" width="12" height="10" rx="3"/></g></svg>`);
}
function demoScreen(title, color, rows) {
  const items = rows.map(([label, done], i) => `<rect x="24" y="${190 + i * 84}" width="342" height="68" rx="16" fill="#fff"/><circle cx="58" cy="${224 + i * 84}" r="12" fill="${done ? color : "none"}" stroke="${color}" stroke-width="3"/>`
    + `<text x="84" y="${230 + i * 84}" font-family="Helvetica, Arial" font-size="20" fill="#1c1c1e">${label}</text>`).join("");
  return svgData(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 844"><rect width="390" height="844" fill="#f2f2f7"/><rect width="390" height="150" fill="${color}"/>`
    + `<text x="24" y="118" font-family="Helvetica, Arial" font-size="34" font-weight="700" fill="#fff">${title}</text>${items}</svg>`);
}
const DEMO_SCREENS = [
  ["This week", "#f97316", [["Plan the launch", true], ["Call the printer", true], ["Write the newsletter", false], ["Gym", false]]],
  ["Today", "#7c4ddb", [["Morning walk", true], ["Review pull requests", false], ["Lunch with Ana", false]]],
  ["Habits", "#1f9d55", [["Read 20 minutes", true], ["No sugar", true], ["Sleep by 11", false], ["Journal", true], ["Stretch", false]]],
  ["Goals", "#2f6fe0", [["Ship version 3", false], ["Run a 10K", false], ["Save for a trip", true]]],
  ["Shared lists", "#d93a2b", [["Groceries", false], ["Trip packing", true], ["Gift ideas", false]]],
].map(([title, color, rows]) => demoScreen(title, color, rows));

function seedAppStores(dir) {
  const at = (days) => new Date(Date.now() - days * DAY * 1000).toISOString();
  const row = (category, type, purposes, optional = false) => ({ category, type, optional, purposes });
  const collected = [
    row("Personal info", "Name", ["App functionality", "Account management"]),
    row("Personal info", "Email address", ["App functionality", "Account management"]),
    row("App activity", "App interactions", ["Analytics"]),
    row("Photos and videos", "Photos", ["App functionality"], true),
  ];
  const security = (encrypted) => [
    encrypted ? { title: "Data is encrypted in transit", detail: "" } : { title: "Data isn’t encrypted", detail: "Your data isn’t transferred over a secure connection" },
    { title: "You can request that data be deleted", detail: "" },
  ];
  const label = (extra) => [{ id: "DATA_LINKED_TO_YOU", title: "Data Linked to You", purposes: [{ id: "APP_FUNCTIONALITY", title: "App Functionality", categories: [
    { id: "CONTACT_INFO", title: "Contact Info", dataTypes: ["Email Address", "Name"] },
    { id: "USER_CONTENT", title: "User Content", dataTypes: ["Photos or Videos", ...extra] },
    { id: "IDENTIFIERS", title: "Identifiers", dataTypes: ["User ID"] },
  ] }] }];
  const run = (days, play, ios, rows, encrypted, extra, shots) => ({
    at: at(days), country: "us",
    apps: [{
      key: "com.example.pocketplanner", name: "Pocket Planner",
      play: { id: "com.example.pocketplanner", found: true, url: "https://play.google.com/store/apps/details?id=com.example.pocketplanner", version: play, updated: at(days + 2), description: "Plan your week in one place.",
        title: "Pocket Planner: week & habits", developer: "Pocket Labs", icon: demoIcon("#fb923c", "#f97316"), screenshots: DEMO_SCREENS.slice(0, shots),
        dataSafety: { shared: [], collected: rows, security: security(encrypted), encrypted, read: true } },
      appStore: { id: "com.example.pocketplanner", found: true, url: "https://apps.apple.com/us/app/id1000000000", version: ios, updated: at(days + 1), releaseNotes: "", description: "Plan your week in one place.",
        title: "Pocket Planner", developer: "Pocket Labs", icon: demoIcon(days > 2 ? "#a78bfa" : "#fb923c", days > 2 ? "#7c4ddb" : "#f97316"),
        screenshots: DEMO_SCREENS.slice(0, shots), ipadScreenshots: [], rating: { average: 4.7, count: 128 }, privacy: label(extra) },
      project: { android: { version: "2.5.0", build: "52" }, ios: { version: "2.5.0", build: "52" } },
    }],
  });
  mkdirSync(join(dir, "apps", "app-stores"), { recursive: true });
  writeJson(join(dir, "apps", "app-stores", "checks.json"), { runs: [
    run(1, "2.4.0", "2.4.1", collected, false, ["Other User Content"], 5),
    run(8, "2.3.2", "2.4.0", collected.slice(0, 3), false, [], 4),
  ] });
}

/** Writes the whole demo into a workspace folder: the applets it has data for are installed, and `disabled` hides this computer's own. */
export async function seedDemo(dir, { disabled = [], language } = {}) {
  const root = resolve(import.meta.dirname, "..");
  mkdirSync(dir, { recursive: true });
  const claude = seedClaude(dir);
  const projects = seedTasks(dir);
  seedCrm(dir);
  await seedLedger(dir, root);
  const social = seedSocial(dir);
  seedHabits(dir);
  seedAppStores(dir);
  writeJson(join(dir, "settings.json"), {
    _dashboard: { installed: [...LEGACY, "app-stores"], disabled, autoUpdateCheck: false, ...(language ? { language } : {}) },
    tasks: { projects },
    claude: { folders: [{ path: claude, label: "Claude" }], projectsRoot: join(dir, "projects") },
    yazim: { claudeFolders: [claude] },
    sosyal: { root: social },
    seo: { sites: [{ id: "studio", name: "My Studio", domain: "example.com", file: join(dir, "apps", "seo", "studio.json") }] },
    "app-stores": { apps: [{ name: "Pocket Planner", android: "com.example.pocketplanner", ios: "com.example.pocketplanner" }] },
  });
}
