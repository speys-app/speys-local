import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSize, problemsOf, readTags, spread, toLocal } from "./previews.js";

test("readTags reads Open Graph and Twitter tags in any attribute order and resolves the image", () => {
  const html = `<html><head><title>Doca &amp; Co</title>
    <meta content="Cafe in Onikişubat" name="description">
    <meta property="og:title" content="DOCA">
    <meta property='og:image' content='/og/doca.png'>
    <meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta property="og:title" content="second one is ignored">
  </head></html>`;
  const tags = readTags(html, "https://my.speys.app/mekanlar/doca");
  assert.equal(tags.title, "Doca & Co");
  assert.equal(tags.description, "Cafe in Onikişubat");
  assert.equal(tags.ogTitle, "DOCA");
  assert.equal(tags.ogImage, "https://my.speys.app/og/doca.png");
  assert.equal(tags.ogImageWidth, 1200);
  assert.equal(tags.twitterCard, "summary_large_image");
  assert.equal(tags.ogDescription, null);
});

test("imageSize reads PNG, GIF and JPEG headers", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.set([0, 0, 4, 0xb0, 0, 0, 2, 0x76], 16); // 1200 × 630
  assert.deepEqual(imageSize(png), { width: 1200, height: 630 });

  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x58, 0x02, 0x3b, 0x01]); // 600 × 315
  assert.deepEqual(imageSize(gif), { width: 600, height: 315 });

  // SOI, an APP0 segment of length 4, then SOF0 with height 630 and width 1200
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0x76, 0x04, 0xb0, 3, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { width: 1200, height: 630 });

  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
});

test("problemsOf: missing, broken, small and shared images", () => {
  const page = (tags) => ({ status: 200, tags: { ogTitle: "T", ogDescription: "D", twitterCard: "summary_large_image", ...tags } });
  const codes = (list) => list.map((x) => x.code);

  assert.deepEqual(codes(problemsOf(page({ ogImage: null }), null, 0)), ["no-image"]);
  assert.deepEqual(codes(problemsOf(page({ ogImage: "https://a/x.png" }), { status: 404, type: "text/html", bytes: 10 }, 0)), ["image-broken"]);
  assert.deepEqual(codes(problemsOf(page({ ogImage: "https://a/x.png" }), { status: 200, type: "image/png", bytes: 10, width: 300, height: 300 }, 0)), ["image-small"]);
  assert.deepEqual(codes(problemsOf(page({ ogImage: "https://a/x.png" }), { status: 200, type: "image/png", bytes: 10, width: 1200, height: 1200 }, 0)), ["image-ratio"]);
  assert.deepEqual(codes(problemsOf(page({ ogImage: "https://a/x.png" }), { status: 200, type: "image/png", bytes: 10, width: 1200, height: 630 }, 7)), ["shared-image"]);
  assert.deepEqual(codes(problemsOf(page({ ogImage: "https://a/x.png" }), { status: 200, type: "image/png", bytes: 10, width: 1200, height: 630 }, 0)), []);
  assert.deepEqual(codes(problemsOf({ status: 500, tags: null }, null, 0)), ["page"]);
});

test("spread samples the whole list evenly", () => {
  const list = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(spread(list, 5), [0, 2, 4, 6, 8]);
  assert.deepEqual(spread(list, 20), list);
});

test("toLocal maps the site and its subdomains to the dev server, and leaves other sites alone", () => {
  const local = "http://localhost:5000";
  assert.equal(toLocal("https://speys.app/yazi/x?a=1", "speys.app", local), "http://localhost:5000/yazi/x?a=1");
  assert.equal(toLocal("https://www.speys.app/", "speys.app", local), "http://localhost:5000/");
  assert.equal(toLocal("https://cardgames.speys.app/21", "speys.app", local), "http://cardgames.localhost:5000/21");
  assert.equal(toLocal("https://image.tmdb.org/t/p/w500/a.jpg", "speys.app", local), "https://image.tmdb.org/t/p/w500/a.jpg");
  assert.equal(toLocal("https://speys.app/x", "speys.app", null), "https://speys.app/x");
});
