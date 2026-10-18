import assert from "node:assert/strict";
import test from "node:test";

import { botsOnCloud, cloudLoginsView, createCloudLogins, createLoginHandoffClient, handoffWhat } from "./cloud-logins.mjs";

const TOKEN = "ops_fake-node-test-token";

test("a page names only 1Password or one saved login by id: never a destination, a field or a value", () => {
  assert.deepEqual(handoffWhat({ kind: "1password", origin: "https://evil.example" }), { kind: "1password" });
  assert.deepEqual(handoffWhat({ kind: "login", id: "abc-123", password: "x" }), { kind: "login", id: "abc-123" });
  for (const bad of [null, "1password", { kind: "login" }, { kind: "login", id: "../x" }, { kind: "all" }, [{ kind: "1password" }]]) assert.equal(handoffWhat(bad), null);
});

test("the private ask takes its answer only from the process it asked, and gives up in words", async () => {
  const sent = [];
  const proc = { postMessage: (message) => sent.push(message) };
  const other = { postMessage() {} };
  const client = createLoginHandoffClient({ timeoutMs: 50, randomId: () => "request-0001" });
  const asked = client.request(proc, { kind: "1password" });
  assert.deepEqual(sent, [{ type: "openmausbot:login-handoff", requestId: "request-0001", what: { kind: "1password" } }]);
  assert.equal(client.receive(other, { type: "openmausbot:login-handoff-result", requestId: "request-0001", ok: true, onePassword: { token: "ops_impostor", grants: {} } }), true);
  assert.equal(client.receive(proc, { type: "something-else" }), false);
  client.receive(proc, { type: "openmausbot:login-handoff-result", requestId: "request-0001", ok: true, onePassword: { token: TOKEN, grants: {} } });
  assert.equal((await asked).onePassword.token, TOKEN);

  const refused = createLoginHandoffClient({ timeoutMs: 50, randomId: () => "request-0002" });
  const gone = refused.request(proc, { kind: "login", id: "x" });
  refused.receive(proc, { type: "openmausbot:login-handoff-result", requestId: "request-0002", ok: false, error: "This login is no longer saved on this computer." });
  await assert.rejects(gone, /no longer saved on this computer/);
  await assert.rejects(createLoginHandoffClient({ timeoutMs: 20 }).request(proc, { kind: "1password" }), /did not answer/);
  await assert.rejects(createLoginHandoffClient().request(null, { kind: "1password" }), /not running/);
});

test("a login kept to some bots keeps only those My Cloud has, and every bot stays every bot", () => {
  const cloud = new Set(["quill", "pepper"]);
  assert.equal(botsOnCloud("all", cloud), "all");
  assert.deepEqual(botsOnCloud(["pepper", "ember"], cloud), ["pepper"]);
  assert.deepEqual(botsOnCloud(["ember"], cloud), []);
  assert.deepEqual(botsOnCloud(undefined, cloud), []);
});

test("what My Cloud has is read without a secret, and 1Password's rows are not counted as saved logins", () => {
  assert.deepEqual(cloudLoginsView({ logins: [
    { site: "example.com", username: "alice", source: "settings", password: "never-here" },
    { site: "example.com", username: "vault-user", source: "1password" },
  ], onePassword: { connected: true, vaults: [{ id: "v1", title: "Shared", bots: "all" }] } }), {
    logins: [{ site: "example.com", username: "alice" }], onePassword: { connected: true, vaults: ["v1"] } });
  assert.equal(cloudLoginsView({ error: "nope" }), null);
});

function fakeCloud({ refuse = null } = {}) {
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    calls.push({ route, method: init.method ?? "GET", authorization: init.headers?.authorization, credentials: init.credentials, body: init.body ? JSON.parse(init.body) : undefined });
    if (route === "/api/auth/pair") return reply(200, { token: "omb_sess_fake" });
    if (route === "/api/bots") return reply(200, { bots: [{ id: "quill" }] });
    if (refuse && route === refuse.route) return reply(refuse.status, { error: refuse.error });
    if (route === "/api/logins" && (init.method ?? "GET") === "GET") return reply(200, { logins: [], onePassword: { connected: false } });
    return reply(200, { ok: true });
  };
  return { calls, fetch };
}

test("a send pairs with the person's own Cloud only, says what My Cloud refused, and always signs out", async () => {
  const cloud = fakeCloud({ refuse: { route: "/api/logins/1password", status: 400, error: "1Password could not start on this server, so your token was not checked." } });
  const logins = createCloudLogins({
    handoff: async () => ({ onePassword: { token: TOKEN, grants: { v1: ["pepper"] } } }),
    home: () => ({ origin: "https://omb-u-1.fly.dev", grant: async () => ({ origin: "https://omb-u-1.fly.dev", code: "OMB-CODE" }) }),
    fetch: cloud.fetch, cookieFetch: cloud.fetch,
  });
  await assert.rejects(logins.send({ kind: "1password" }), { message: "My Cloud said: 1Password could not start on this server, so your token was not checked." });
  assert.deepEqual(cloud.calls.map((call) => `${call.method} ${call.route}`), ["POST /api/auth/pair", "GET /api/bots", "POST /api/logins/1password", "POST /api/auth/logout"]);
  assert.ok(cloud.calls.slice(1).every((call) => call.authorization === "Bearer omb_sess_fake" && call.credentials === "omit"));

  const elsewhere = createCloudLogins({
    handoff: async () => ({ onePassword: { token: TOKEN, grants: {} } }),
    home: () => ({ origin: "https://omb-u-1.fly.dev", grant: async () => ({ origin: "https://attacker.example", code: "OMB-CODE" }) }),
    fetch: cloud.fetch, cookieFetch: cloud.fetch,
  });
  const before = cloud.calls.length;
  await assert.rejects(elsewhere.send({ kind: "1password" }), /My Cloud is not ready/);
  assert.equal(cloud.calls.length, before, "nothing is sent to an origin the grant names instead");

  const signedOut = fakeCloud({ refuse: { route: "/api/logins", status: 403, error: "forbidden" } });
  const login = createCloudLogins({
    handoff: async () => ({ login: { site: "accounts.example.com", exactHost: false, username: "alice", password: "fake-pass", totp: null, bots: "all" } }),
    home: () => ({ origin: "https://omb-u-1.fly.dev", grant: async () => ({ origin: "https://omb-u-1.fly.dev", code: "OMB-CODE" }) }),
    fetch: signedOut.fetch, cookieFetch: async () => new Response("", { status: 401 }),
  });
  await assert.rejects(login.send({ kind: "login", id: "l1" }), /did not let this app change its logins/);
  assert.deepEqual(await login.state(), { cloud: { reachable: false } });
  assert.deepEqual(await createCloudLogins({ handoff: async () => ({}), home: () => null, fetch: signedOut.fetch, cookieFetch: signedOut.fetch }).state(), { cloud: null });
});
