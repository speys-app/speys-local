// A connection to a Speys account, for applets that sync with it. Optional: without it every applet works on its own.
//
// Sign-in is Speys's OAuth (the same one Claude and ChatGPT use to connect): the browser goes to Speys, the user approves,
// Speys comes back to this computer with a code, and the code becomes a token (PKCE; no secret is kept here).
// The token is only valid for Speys Local's endpoints (`<api>/local/...`), not for anything else in the account, and
// the user can revoke it in Speys → Settings → Connections.
//
// Nothing here runs on its own: no network at start-up, only when an applet asks.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJson } from "./common.js";

export const DEFAULT_API = "https://staging-mini-apps-center-8u7i.encr.app";

/**
 * One connection per workspace, shared by every applet that syncs: connecting in Finances connects Meal Planner too.
 * An applet's data folder is `<workspace>/apps/<id>`; the connection sits at the workspace's root. A connection an
 * applet kept in its own folder (Finances, before 9 November 2026) moves there once.
 */
export function sharedConnectionFile(dataDir) {
  const shared = join(dataDir, "..", "..", "speys.json");
  const own = join(dataDir, "speys.json");
  if (!existsSync(shared) && existsSync(own)) {
    try { renameSync(own, shared); } catch {}
  }
  return shared;
}
const CLIENT_NAME = "Speys Local";
const PENDING_TTL = 15 * 60 * 1000;

export class NotConnected extends Error {
  constructor(message = "Not connected to Speys") {
    super(message);
    this.name = "NotConnected";
  }
}

export class SpeysError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "SpeysError";
    this.status = status;
  }
}

const base64url = (buf) => buf.toString("base64url");

/**
 * file: where the connection is kept (tokens, which account); it is data, never in the repository.
 * api:  Speys's address (a setting; empty means Speys's own).
 * fetch: injected in tests.
 */
export function speysConnection({ file, api = DEFAULT_API, fetch: doFetch = globalThis.fetch, now = () => Date.now() }) {
  const pending = new Map(); // state → { verifier, clientId, redirectUri, at }
  const apiBase = () => String(api || DEFAULT_API).replace(/\/+$/, "");
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  const save = (value) => {
    mkdirSync(dirname(file), { recursive: true });
    writeJson(file, value);
  };

  async function post(path, body, { form = false, token } = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    let res;
    try {
      res = await doFetch(`${apiBase()}${path}`, {
        method: "POST",
        headers,
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new SpeysError(0, `Speys could not be reached: ${e.message}`);
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new SpeysError(res.status, data.error_description || data.error || data.message || `Speys returned ${res.status}`);
    return data;
  }

  /** Step 1: the address to open in the browser. `redirectUri` is this computer's callback. */
  async function start(redirectUri) {
    const client = await post("/oauth/register", { redirect_uris: [redirectUri], client_name: CLIENT_NAME });
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    for (const [k, v] of pending) if (now() - v.at > PENDING_TTL) pending.delete(k);
    pending.set(state, { verifier, clientId: client.client_id, redirectUri, at: now() });
    const url = new URL(`${apiBase()}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
      resource: `${apiBase()}/local`,
    }).toString();
    return url.toString();
  }

  /** Step 2: Speys came back with a code. */
  async function finish({ code, state, error }) {
    const p = pending.get(state);
    pending.delete(state);
    if (error) throw new SpeysError(400, error === "access_denied" ? "Access was not given" : error);
    if (!p || now() - p.at > PENDING_TTL) throw new SpeysError(400, "This sign-in has expired; start again");
    const tokens = await post("/oauth/token", {
      grant_type: "authorization_code", code, code_verifier: p.verifier, client_id: p.clientId, redirect_uri: p.redirectUri,
    }, { form: true });
    const connection = {
      api: apiBase(), clientId: p.clientId, connectedAt: new Date(now()).toISOString(), ...tokenFields(tokens),
    };
    save(connection);
    const me = await call("/local/whoami", {});
    save({ ...read(), userId: me.userId });
    return status();
  }

  const tokenFields = (t) => ({
    accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now() + (Number(t.expires_in) || 3600) * 1000,
  });

  async function refresh(connection) {
    try {
      const tokens = await post("/oauth/token", { grant_type: "refresh_token", refresh_token: connection.refreshToken, client_id: connection.clientId }, { form: true });
      const next = { ...connection, ...tokenFields(tokens) };
      save(next);
      return next;
    } catch (e) {
      // Revoked in Speys or expired: the user connects again. A network failure is not a revocation.
      if (e.status === 400 || e.status === 401) {
        save({ ...connection, accessToken: null, refreshToken: null, revokedAt: new Date(now()).toISOString() });
        throw new NotConnected("The Speys connection was closed; connect again");
      }
      throw e;
    }
  }

  /** A Local endpoint of Speys, with the user's token; renewed when it is about to run out. */
  async function call(path, body) {
    let connection = read();
    if (!connection?.refreshToken) throw new NotConnected();
    if (connection.api && connection.api !== apiBase()) throw new NotConnected("The Speys address changed; connect again");
    if (!connection.accessToken || connection.expiresAt - now() < 60_000) connection = await refresh(connection);
    try {
      return await post(path, body, { token: connection.accessToken });
    } catch (e) {
      if (e.status !== 401) throw e;
      connection = await refresh(connection);
      return post(path, body, { token: connection.accessToken });
    }
  }

  function status() {
    const c = read();
    return c?.refreshToken
      ? { connected: true, api: c.api, userId: c.userId ?? null, connectedAt: c.connectedAt }
      : { connected: false, closed: Boolean(c?.revokedAt) };
  }

  /** Forgets the tokens here; the connection stays listed in Speys until it's removed there. */
  function disconnect() {
    if (existsSync(file)) save({ revokedAt: new Date(now()).toISOString() });
  }

  return { start, finish, call, status, disconnect };
}
