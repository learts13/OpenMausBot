// Also use on My Cloud, end to end, with two real servers: this computer's, started as the desktop app starts it (its
// private utility-process port emulated over Node's IPC, the owner's capability delivered through it), and the person's
// Cloud home, paired the way the Admin pairs it. The real Electron module sits between them. The 1Password SDK is a fake
// in each server's native-module tree. Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCloudLogins, createLoginHandoffClient } from "../electron/cloud-logins.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
// Obvious fakes only.
const TOKEN = `ops_fake-both-sides-${randomBytes(12).toString("hex")}`;
const ALICE_PASSWORD = `fake-alice-Passw0rd-${randomBytes(6).toString("hex")}`;
const OPS_PASSWORD = `fake-ops-Passw0rd-${randomBytes(6).toString("hex")}`;
const TOTP = "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example";
const SECRETS = [TOKEN, ALICE_PASSWORD, OPS_PASSWORD, "JBSWY3DPEHPK3PXP"];
const secret = randomBytes(32).toString("base64url");
const ownerCapability = randomBytes(32).toString("base64url");
let root = "";
let desktop: ChildProcess;
let cloud: ChildProcess;
let desktopBase = "";
let cloudBase = "";
let owner = "";
let logs = "";
const answers: string[] = [];

const remember = async (response: Response) => { const text = await response.text(); answers.push(text); return text; };
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
const edge = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };

/** This computer's own page, as the desktop's renderer asks its server: loopback with the owner's capability. */
async function local(method: string, path: string, body?: unknown) {
  const response = await fetch(`${desktopBase}${path}`, { method, headers: {
    "x-openmausbot-desktop-owner": ownerCapability, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: parse(await remember(response)) };
}

/** The person's own device on My Cloud, through the edge. */
async function onCloud(method: string, path: string, body?: unknown) {
  const response = await fetch(`${cloudBase}${path}`, { method, headers: { ...edge, authorization: `Bearer ${owner}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: parse(await remember(response)) };
}

/** What the Admin does for pairHome(): a signed one-time code for this Cloud alone. */
async function mintCode(label = "OpenMausBot app (Cloud)") {
  const body = JSON.stringify({ label, ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${cloudBase}/api/cloud/pairing`, { method: "POST", headers: { ...edge, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body });
  return ((await response.json()) as { code: string }).code;
}

function fakeOnePassword(at: string): string {
  const sdk = join(at, "node_modules", "@1password", "sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@1password/sdk", version: "0.5.0", main: "index.js" }));
  writeFileSync(join(sdk, "index.js"), `"use strict";
exports.createClient = async ({ auth }) => {
  if (auth !== ${JSON.stringify(TOKEN)}) throw new Error("error authenticating: invalid service account token");
  return {
    vaults: { list: async () => [{ id: "v1", title: "Shared with OpenMausBot" }] },
    items: {
      list: async () => [{ id: "i1", title: "CRM", category: "Login", websites: [{ url: "https://vault.example.test/login" }] }],
      getAll: async (vaultId, ids) => ({ individualResponses: ids.map((id) => ({ content: { id, fields: [
        { id: "username", title: "username", fieldType: "Text", value: "vault-user" },
        { id: "password", title: "password", fieldType: "Concealed", value: "fake-vault-Passw0rd" }] } })) }),
    },
  };
};
`);
  return at;
}

async function start(name: string, env: NodeJS.ProcessEnv, port: number, extra: string[] = [], ipc = false): Promise<ChildProcess> {
  const home = join(root, name);
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "grok"].map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
  } }));
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  const child = spawn(process.execPath, ["--import", offline, ...extra, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_DUCKDB_DIR: fakeOnePassword(join(home, "native")), ...env },
    stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc" as const] : [])],
  });
  child.stdout?.on("data", (chunk) => { logs += chunk; });
  child.stderr?.on("data", (chunk) => { logs += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${name} exited:\n${logs}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return child; } catch {}
    if (Date.now() > deadline) throw new Error(`${name} did not start:\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omb-cloud-logins-"));
  // Electron's utility-process parentPort, over Node's IPC: { data } events in, postMessage out.
  const parentPort = `data:text/javascript,${encodeURIComponent(`
    const listeners = [];
    Object.defineProperty(process, "parentPort", { value: {
      on(event, listener) { if (event === "message") listeners.push(listener); },
      postMessage(message) { process.send?.(message); },
    } });
    process.on("message", (data) => { for (const listener of listeners) listener({ data }); });
    process.channel?.unref();
  `)}`;
  const desktopPort = await freePortBlock([0, 1]);
  desktopBase = `http://127.0.0.1:${desktopPort}`;
  desktop = await start("desktop", { OMB_DESKTOP_PARENT: "1" }, desktopPort, ["--import", parentPort], true);
  desktop.send({ type: "openmausbot:desktop-mutation-token", token: ownerCapability });
  const cloudPort = await freePortBlock([0, 1]);
  cloudBase = `http://127.0.0.1:${cloudPort}`;
  cloud = await start("cloud", { OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
    OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}` }, cloudPort);
  const paired = await fetch(`${cloudBase}/api/auth/pair`, { method: "POST", headers: { ...edge, "content-type": "application/json" }, body: JSON.stringify({ code: await mintCode() }) });
  owner = ((await paired.json()) as { token: string }).token;
  // The owner's capability arrives over the private port, as Electron delivers it after spawn.
  for (let tries = 0; (await local("GET", "/api/bots")).status !== 200 && tries < 50; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
}, hostTimeout(45_000));

afterAll(async () => {
  for (const child of [desktop, cloud]) if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (root) await removeTempDir(root);
});

it("sends a login and the 1Password service account from this computer to My Cloud, never widening who may use them", async () => {
  const pepper = (await local("POST", "/api/bots", { name: "Pepper", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect((await onCloud("POST", "/api/bots", { name: "Quill", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(201);
  const alice = (await local("POST", "/api/logins", { site: "accounts.example.test", username: "alice", password: ALICE_PASSWORD, totp: TOTP, bots: "all" })).body.login;
  const ops = (await local("POST", "/api/logins", { site: "crm.example.test", username: "ops", password: OPS_PASSWORD, bots: [pepper.id] })).body.login;
  expect((await local("POST", "/api/logins/1password", { token: TOKEN })).status).toBe(200);
  expect((await local("PATCH", "/api/logins/1password/vaults/v1", { bots: [pepper.id] })).status).toBe(200);

  const handoff = createLoginHandoffClient();
  const desktopPort = { postMessage: (message: unknown) => { desktop.send(message as object); } };
  desktop.on("message", (message) => handoff.receive(desktopPort, message));
  const pairings: string[] = [];
  const throughEdge = (bearer: boolean) => async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, ...edge, ...(bearer ? { authorization: `Bearer ${owner}` } : {}) } });
    const text = await response.clone().text();
    answers.push(text);
    return response;
  };
  const logins = createCloudLogins({
    handoff: (what) => handoff.request(desktopPort, what),
    home: () => ({ origin: cloudBase, grant: async () => { const code = await mintCode("Logins from this computer"); pairings.push(code); return { origin: cloudBase, code }; } }),
    fetch: throughEdge(false),
    // The window's own Cloud session, which only reads.
    cookieFetch: throughEdge(true),
  });

  expect(await logins.state()).toEqual({ cloud: { reachable: true, logins: [], onePassword: { connected: false, vaults: [] } } });

  expect(await logins.send({ kind: "login", id: alice.id })).toMatchObject({ sent: true, cloud: { reachable: true, logins: [{ site: "example.test", username: "alice" }] } });
  const sentNarrowed = await logins.send({ kind: "login", id: ops.id });
  expect(sentNarrowed).toMatchObject({ sent: true, narrowed: true });
  const onePassword = await logins.send({ kind: "1password" });
  expect(onePassword).toMatchObject({ sent: true, narrowed: true, cloud: { onePassword: { connected: true, vaults: ["v1"] } } });
  expect(pairings).toHaveLength(3);

  const there = (await onCloud("GET", "/api/logins")).body;
  const saved = there.logins.filter((login: { source: string }) => login.source !== "1password");
  // Pepper is not on My Cloud: a login kept to Pepper reaches no bot there until the person picks one.
  expect(saved).toEqual(expect.arrayContaining([
    expect.objectContaining({ site: "example.test", hosts: ["accounts.example.test"], username: "alice", hasTotp: true, bots: "all", source: "settings" }),
    expect.objectContaining({ site: "example.test", hosts: ["crm.example.test"], username: "ops", hasTotp: false, bots: [] }),
  ]));
  expect(there.onePassword).toMatchObject({ connected: true, vaults: [{ id: "v1", bots: [] }] });
  // Each send's pairing signed out again: nothing of it stays a session on My Cloud.
  const sessions = (await onCloud("GET", "/api/auth/sessions")).body.sessions as Array<{ label?: string }>;
  expect(sessions.filter((session) => session.label === "Logins from this computer")).toEqual([]);

  await expect(logins.send({ kind: "login", id: "no-such-login" })).rejects.toThrow("This login is no longer saved on this computer.");
  await expect(logins.send({ kind: "everything" } as never)).rejects.toThrow("Choose a login to send to My Cloud.");
  for (const where of [...answers, logs]) for (const value of SECRETS) expect(where).not.toContain(value);
});
