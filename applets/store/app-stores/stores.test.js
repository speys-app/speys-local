// The store page readers, on small made-up pages shaped like the real ones. No network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changes, compareVersions, findings, parseAppPrivacy, parsePlayDataSafety, parsePlayDetails, readProject } from "./stores.js";

const SAFETY = `<h1>Data safety</h1>
<h2 class="a">Data shared</h2><div class="b">Data that may be shared with other companies or organizations</div>
<h3 class="c">Photos and videos</h3><div class="d">Photos</div>
<h4 class="e"><span>Photos</span></h4><div class="f">App functionality</div>
<h2 class="a">Data collected</h2><div class="b">Data this app may collect</div>
<h3 class="c">Personal info</h3><div class="d">Name, Email address</div>
<h4 class="e"><span>Name</span></h4><div class="f">App functionality, Account management</div>
<h4 class="e"><span>Email address</span> &middot; Optional</h4><div class="f">Account management</div>
<h2 class="a">Security practices</h2>
<div><h3 class="c">Data isn&#8217;t encrypted</h3><div class="d">Your data isn&#8217;t transferred over a secure connection</div></div>
<div><h3 class="c">You can request that data be deleted</h3><div class="d">The developer provides a way</div></div>`;

test("Play's data safety page: shared, collected, optional, purposes and the encryption line", () => {
  const d = parsePlayDataSafety(SAFETY);
  assert.equal(d.read, true);
  assert.deepEqual(d.shared, [{ category: "Photos and videos", type: "Photos", optional: false, purposes: ["App functionality"] }]);
  assert.deepEqual(d.collected.map((x) => [x.type, x.optional, x.purposes.length]), [["Name", false, 2], ["Email address", true, 1]]);
  assert.equal(d.encrypted, false);
  assert.equal(d.security.length, 2);
  assert.equal(parsePlayDataSafety(SAFETY.replace("Data isn&#8217;t encrypted", "Data is encrypted in transit")).encrypted, true);
  assert.deepEqual(parsePlayDataSafety("<html>sign in</html>"), { shared: [], collected: [], security: [], encrypted: null, read: false });
});

test("Play's details page: version, update time, description and the listing's look; null when they moved", () => {
  const img = (alt, src, extra = "") => `<img src="${src}" srcset="${src} 2x" ${extra} alt="${alt}">`;
  const html = `x"141":[[["1.4.2"]],[[[36]]]],"146":[["Nov 5, 2026",[1793900382,706000000]]]x<div data-g-id="description" inert>Plan &amp; share.<br>Second line</div>`
    + img("Icon image", "https://play-lh.googleusercontent.com/icon=w240-h480", 'itemprop="image"')
    + `<h1><span itemprop="name">Pocket &amp; Co</span></h1><a href="/store/apps/developer?id=Pocket"><span>Pocket Labs</span></a>`
    + img("Screenshot image", "https://play-lh.googleusercontent.com/a=w526-h296") + img("Screenshot image", "https://play-lh.googleusercontent.com/b=w526-h296")
    + img("Screenshot image", "https://play-lh.googleusercontent.com/a=w1052-h592") + img("Icon image", "https://play-lh.googleusercontent.com/other=s48");
  assert.deepEqual(parsePlayDetails(html), {
    version: "1.4.2", updated: "2026-11-05T17:39:42.000Z", description: "Plan & share.\nSecond line", title: "Pocket & Co", developer: "Pocket Labs",
    icon: "https://play-lh.googleusercontent.com/icon", screenshots: ["https://play-lh.googleusercontent.com/a", "https://play-lh.googleusercontent.com/b"],
  });
  assert.deepEqual(parsePlayDetails("<html></html>"), { version: null, updated: null, description: null, title: null, developer: null, icon: null, screenshots: [] });
});

test("listing changes: a new icon and new screenshots carry both sides", () => {
  const base = { found: true, version: "1", title: "A", icon: "i1", screenshots: ["s1", "s2"] };
  const out = changes({ play: base, appStore: null }, { play: { ...base, icon: "i2", screenshots: ["s1", "s3"] }, appStore: null });
  assert.deepEqual(out, [{ store: "play", field: "icon", before: "i1", after: "i2" }, { store: "play", field: "screenshots", before: ["s1", "s2"], after: ["s1", "s3"] }]);
});

test("App Store privacy label from the page's JSON, once per type", () => {
  const type = { $kind: "PrivacyType", identifier: "DATA_LINKED_TO_YOU", title: "Data Linked to You",
    purposes: [{ identifier: "APP_FUNCTIONALITY", title: "App Functionality", categories: [{ identifier: "CONTACT_INFO", title: "Contact Info", dataTypes: ["Email Address", "Name"] }] }] };
  const notLinked = { $kind: "PrivacyType", identifier: "DATA_NOT_LINKED_TO_YOU", title: "Data Not Linked to You", categories: [{ identifier: "DIAGNOSTICS", title: "Diagnostics", dataTypes: ["Crash Data"] }] };
  const html = `<script type="application/json" id="serialized-server-data">${JSON.stringify({ a: [type, { b: type }, notLinked] })}</script>`;
  const label = parseAppPrivacy(html);
  assert.deepEqual(label.map((x) => x.id), ["DATA_LINKED_TO_YOU", "DATA_NOT_LINKED_TO_YOU"]);
  assert.deepEqual(label[0].purposes[0].categories[0].dataTypes, ["Email Address", "Name"]);
  assert.equal(label[1].purposes[0].categories[0].title, "Diagnostics");
  assert.equal(parseAppPrivacy("<html></html>"), null);
});

test("the project's version: Capacitor in a subfolder, Flutter, Expo", () => {
  const dir = mkdtempSync(join(tmpdir(), "app-stores-"));
  try {
    mkdirSync(join(dir, "frontend", "android", "app"), { recursive: true });
    writeFileSync(join(dir, "frontend", "android", "app", "build.gradle"), 'versionCode 370\n        versionName "0.19.23"');
    mkdirSync(join(dir, "frontend", "ios", "App", "App.xcodeproj"), { recursive: true });
    writeFileSync(join(dir, "frontend", "ios", "App", "App.xcodeproj", "project.pbxproj"), "CURRENT_PROJECT_VERSION = 370;\nMARKETING_VERSION = 0.19.23;");
    assert.deepEqual(readProject(dir), { android: { version: "0.19.23", build: "370" }, ios: { version: "0.19.23", build: "370" } });

    const flutter = join(dir, "flutter");
    mkdirSync(flutter);
    writeFileSync(join(flutter, "pubspec.yaml"), "name: x\nversion: 2.1.0+44\n");
    assert.deepEqual(readProject(flutter), { android: { version: "2.1.0", build: "44" }, ios: { version: "2.1.0", build: "44" } });

    const expo = join(dir, "expo");
    mkdirSync(expo);
    writeFileSync(join(expo, "app.json"), JSON.stringify({ expo: { version: "3.0.1", android: { versionCode: 9 }, ios: { buildNumber: "12" } } }));
    assert.deepEqual(readProject(expo), { android: { version: "3.0.1", build: "9" }, ios: { version: "3.0.1", build: "12" } });

    assert.equal(readProject(join(dir, "nothing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("versions compare by number", () => {
  assert.equal(compareVersions("0.19.18", "0.19.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
});

const app = (over = {}) => ({
  play: { found: true, version: "1.0.0", description: "A", dataSafety: parsePlayDataSafety(SAFETY), ...over.play },
  appStore: { found: true, version: "1.0.0", description: "A", screenshots: 5, privacy: [], ...over.appStore },
  project: { android: { version: "1.1.0" }, ios: { version: "1.0.0" } },
});

test("changes between two checks: fields and added or removed data types", () => {
  const encrypted = parsePlayDataSafety(SAFETY.replace("Data isn&#8217;t encrypted", "Data is encrypted in transit").replace(/<h2 class="a">Data shared[\s\S]*?(?=<h2 class="a">Data collected)/, ""));
  const out = changes(app(), app({ play: { version: "1.1.0", dataSafety: encrypted }, appStore: { screenshots: 6 } }));
  assert.deepEqual(out.find((c) => c.field === "version"), { store: "play", field: "version", before: "1.0.0", after: "1.1.0" });
  assert.deepEqual(out.find((c) => c.field === "shared").removed, ["Photos and videos → Photos: App functionality"]);
  assert.deepEqual(out.find((c) => c.field === "security"), { store: "play", field: "security", added: ["Data is encrypted in transit"], removed: ["Data isn’t encrypted"] });
  assert.ok(out.some((c) => c.store === "appStore" && c.field === "screenshots"));
  assert.deepEqual(changes(app(), app()), []);
  assert.deepEqual(changes(null, app()), []);
});

test("findings: not encrypted first, a project ahead of a store, a missing app", () => {
  const out = findings(app());
  assert.equal(out[0].code, "not-encrypted");
  assert.deepEqual(out.find((f) => f.code === "ahead").values, { store: "play", local: "1.1.0", live: "1.0.0" });
  assert.ok(out.some((f) => f.code === "nothing-declared" && f.values.store === "appStore"));
  assert.deepEqual(findings({ play: { id: "com.x", found: false }, appStore: { error: "timeout" }, project: null }).map((f) => f.code), ["not-found", "unreadable"]);
});
