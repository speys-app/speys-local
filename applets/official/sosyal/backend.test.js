import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import create from "./backend.js";

const dataDir = mkdtempSync(join(tmpdir(), "speys-social-"));
const server = createServer(create({ dataDir, settings: () => ({}), t: (s) => s }));
let base;
before(() => new Promise((done) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; done(); })));
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const read = () => fetch(`${base}/api/sosyal`).then((r) => r.json());
const write = (body) => fetch(`${base}/api/sosyal`, { method: "POST", headers: { "X-Panel": "1" }, body: JSON.stringify(body) });
const onDisk = () => JSON.parse(readFileSync(join(dataDir, "takvim.json"), "utf8"));

test("opens with nothing set up, and a change writes the calendar", async () => {
  assert.deepEqual((await read()).hesaplar, []);
  assert.equal((await write({ op: "hesap_ekle", ad: "Me", kullanici: "@me" })).status, 200);
  assert.equal(onDisk().hesaplar[0].ad, "Me");
});

test("a tweet keeps its text, day and time, and has a short title", async () => {
  const hesap = (await read()).hesaplar[0].id;
  const metin = `First line that goes on for quite a long time, longer than a title should be\nSecond line`;
  assert.equal((await write({ op: "tweet_ekle", hesap, metin, tarih: "2030-01-02", saat: "18:30", not: "attach card" })).status, 200);
  const tweet = (await read()).videolar[0];
  assert.deepEqual([tweet.tur, tweet.metin, tweet.tarih, tweet.saat, tweet.not], ["tweet", metin, "2030-01-02", "18:30", "attach card"]);
  assert.ok(tweet.baslik.length <= 60 && !tweet.baslik.includes("\n"));
  assert.equal((await write({ op: "tweet_duzenle", id: tweet.id, metin: "New", tarih: "", saat: "", not: "" })).status, 200);
  assert.deepEqual((({ metin: m, baslik, tarih, saat }) => [m, baslik, tarih, saat])(onDisk().videolar[0]), ["New", "New", null, ""]);
});

test("sharing on X marks a tweet shared, and bad input is refused", async () => {
  const hesap = (await read()).hesaplar[0].id;
  const id = (await read()).videolar[0].id;
  assert.equal((await write({ op: "platform", id, platform: "x", deger: true })).status, 200);
  const tweet = onDisk().videolar[0];
  assert.ok(tweet.adimlar.paylasildi && tweet.platformlar.x);
  for (const body of [{ op: "tweet_ekle", hesap, metin: "  " }, { op: "tweet_ekle", hesap: "nobody", metin: "x" }, { op: "tweet_ekle", hesap, metin: "x", saat: "25:00" }, { op: "tweet_ekle", hesap, metin: "x", tarih: "soon" }]) {
    assert.equal((await write(body)).status, 400, JSON.stringify(body));
  }
});
