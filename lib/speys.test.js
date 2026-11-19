import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NotConnected, speysConnection } from "./speys.js";

const API = "https://speys.test";

/** Speys's OAuth endpoints as backend/assistant/oauth.ts answers them, and one Local endpoint. */
function fakeServer() {
  const s = { codes: new Map(), revoked: false, issued: 0, seen: [] };
  s.fetch = async (url, init) => {
    const u = new URL(url);
    const body = init.headers["Content-Type"].includes("json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    s.seen.push(u.pathname);
    const json = (status, value) => new Response(JSON.stringify(value), { status });
    if (u.pathname === "/oauth/register") return json(201, { client_id: "client-1", redirect_uris: body.redirect_uris });
    if (u.pathname === "/oauth/token" && body.grant_type === "authorization_code") {
      const c = s.codes.get(body.code);
      const ok = c && c.redirect === body.redirect_uri && c.challenge === createHash("sha256").update(body.code_verifier).digest("base64url");
      if (!ok) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: `a${++s.issued}`, refresh_token: "r1", expires_in: 3600 });
    }
    if (u.pathname === "/oauth/token" && body.grant_type === "refresh_token") {
      if (s.revoked) return json(400, { error: "invalid_grant", error_description: "connection revoked" });
      return json(200, { access_token: `a${++s.issued}`, refresh_token: "r1", expires_in: 3600 });
    }
    if (u.pathname.startsWith("/local/")) {
      if (init.headers.Authorization !== `Bearer a${s.issued}`) return json(401, { error: "invalid_token" });
      return json(200, u.pathname === "/local/whoami" ? { userId: "uid-1" } : { ok: true });
    }
    return json(404, {});
  };
  // what the browser does: approve on Speys, come back with a code
  s.approve = (authorizeUrl) => {
    const q = new URL(authorizeUrl).searchParams;
    assert.equal(q.get("resource"), `${API}/local`, "the token is asked for Local only");
    assert.equal(q.get("code_challenge_method"), "S256");
    s.codes.set("code-1", { redirect: q.get("redirect_uri"), challenge: q.get("code_challenge") });
    return { code: "code-1", state: q.get("state") };
  };
  return s;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "speys-conn-"));
  const server = fakeServer();
  let clock = Date.parse("2026-11-09T10:00:00Z");
  const conn = speysConnection({ file: join(dir, "speys.json"), api: API, fetch: server.fetch, now: () => clock });
  return { dir, server, conn, file: join(dir, "speys.json"), advance: (ms) => (clock += ms) };
}

test("connect: sign in on Speys, come back with a code, keep the tokens, know the account", async () => {
  const { dir, server, conn, file } = setup();
  try {
    assert.equal(conn.status().connected, false);
    const url = await conn.start("http://localhost:3400/a/kasa/api/speys/callback");
    const status = await conn.finish(server.approve(url));
    assert.equal(status.connected, true);
    assert.equal(status.userId, "uid-1");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).refreshToken, "r1");
  } finally { rmSync(dir, { recursive: true }); }
});

test("a code from another sign-in, or used twice, is refused", async () => {
  const { dir, server, conn } = setup();
  try {
    const url = await conn.start("http://localhost:3400/cb");
    const back = server.approve(url);
    await assert.rejects(conn.finish({ ...back, state: "other" }), /expired/);
    await assert.rejects(conn.finish({ error: "access_denied", state: back.state }), /not given/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("an expiring token is renewed before the call", async () => {
  const { dir, server, conn, advance } = setup();
  try {
    await conn.finish(server.approve(await conn.start("http://localhost:3400/cb")));
    advance(3600 * 1000);
    assert.deepEqual(await conn.call("/local/kasa/sync/pull", {}), { ok: true });
    assert.equal(server.issued, 2);
  } finally { rmSync(dir, { recursive: true }); }
});

test("a connection closed in Speys: not connected any more, the tokens are dropped", async () => {
  const { dir, server, conn, advance } = setup();
  try {
    await conn.finish(server.approve(await conn.start("http://localhost:3400/cb")));
    server.revoked = true;
    advance(3600 * 1000);
    await assert.rejects(conn.call("/local/kasa/sync/pull", {}), NotConnected);
    assert.deepEqual(conn.status(), { connected: false, closed: true });
  } finally { rmSync(dir, { recursive: true }); }
});

test("disconnect forgets the tokens here", async () => {
  const { dir, server, conn } = setup();
  try {
    await conn.finish(server.approve(await conn.start("http://localhost:3400/cb")));
    conn.disconnect();
    assert.equal(conn.status().connected, false);
    await assert.rejects(conn.call("/local/whoami", {}), NotConnected);
  } finally { rmSync(dir, { recursive: true }); }
});
