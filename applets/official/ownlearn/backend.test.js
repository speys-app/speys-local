import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import createBackend from "./backend.js";

test("repo paths beginning with ~/ are expanded to the home directory", async () => {
  const home = join(process.cwd(), `.ownlearn-home-${process.pid}`);
  const repo = join(home, "repo");
  const name = `.ownlearn-home-${process.pid}/repo`;
  const originalHomedir = os.homedir;
  os.homedir = () => home;
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "schema.sql"), "CREATE TABLE users (id INTEGER PRIMARY KEY);");
  let saved;
  const backend = createBackend({
    dataDir: join(repo, "data"), settings: () => ({}), saveSettings: (value) => { saved = value; },
    t: (text) => text, language: () => "en",
  });
  const req = new PassThrough();
  req.url = "/repo";
  req.method = "POST";
  let status;
  let body = "";
  const res = {
    writeHead(code) { status = code; },
    end(value = "") { body += value; },
  };
  try {
    const response = backend(req, res);
    req.end(`repo=${encodeURIComponent(`~/${name.slice(name.indexOf("/") + 1)}`)}`);
    await response;
    assert.equal(status, 303);
    assert.equal(saved.repo, `~/${name.slice(name.indexOf("/") + 1)}`);
    assert.equal(body, "");
  } finally {
    os.homedir = originalHomedir;
    rmSync(home, { recursive: true, force: true });
  }
});

test("changing the repo setting reloads the opened repo", async () => {
  const root = join(process.cwd(), `.ownlearn-settings-${process.pid}`);
  const first = join(root, "first"), second = join(root, "second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(join(first, "schema.sql"), "CREATE TABLE first_users (id INTEGER PRIMARY KEY);");
  writeFileSync(join(second, "schema.sql"), "CREATE TABLE second_users (id INTEGER PRIMARY KEY);");
  let repo = first;
  const backend = createBackend({
    dataDir: join(root, "data"), settings: () => ({ repo }), saveSettings: () => {},
    t: (text) => text, language: () => "en",
  });
  const request = async (url) => {
    const req = new PassThrough();
    req.url = url;
    req.method = "GET";
    req.headers = { host: "localhost" };
    let status, body = "";
    const res = { writeHead(code) { status = code; }, end(value = "") { body += value; } };
    await backend(req, res);
    return { status, body };
  };
  try {
    assert.equal((await request("/api/modules")).status, 200);
    repo = second;
    const changed = await request("/api/modules");
    assert.equal(changed.status, 200);
    assert.match(changed.body, /"files":1/);
    const state = await request("/api/state");
    assert.equal(JSON.parse(state.body).root, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
