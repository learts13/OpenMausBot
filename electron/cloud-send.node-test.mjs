import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { BOT_PARTS, differenceSignature, itemKey, parseSendSummary, pendingRows, planSend } from "./cloud-send-parts.mjs";
import { botPatch, createCloudSend, parseSendState, sendNotice } from "./cloud-send.mjs";
import { installCloudSend, loginsView, openOwnerSession } from "./cloud-send-main.mjs";

const LOCAL = "http://127.0.0.1:4100";
const CLOUD = "https://omb-u-1.fly.dev";
const summary = (items) => ({ v: 1, appVersion: "0.1.117", items });
const bot = (id, parts, extra = {}) => ({ key: itemKey.bot(id), kind: "bot", label: id, id, parts, ...extra });

test("a part goes when it changed here and not there; My Cloud's own change is kept; what was removed there stays removed", () => {
  const here = summary([
    bot("ember", { soul: "s2", title: "t2", name: "n1" }),
    bot("juno", { soul: "j1" }),
    { key: itemKey.login("example.test", "alice"), kind: "login", label: "example.test", id: "l1", parts: { saved: "a1" } },
    { key: itemKey.setting("profile"), kind: "setting", label: "profile", parts: { name: "amit", about: "-" } },
  ]);
  const there = summary([
    bot("ember", { soul: "s1", title: "t9", name: "n1" }),
    { key: itemKey.setting("profile"), kind: "setting", label: "profile", parts: { name: "-", about: "-" } },
    bot("miso", { soul: "m1" }),
  ]);
  const sent = { [itemKey.bot("ember")]: { soul: ["s1", "s1"], title: ["t1", "t1"] }, [itemKey.login("example.test", "alice")]: { saved: ["a1", "c1"] } };
  const plan = planSend({ local: here, cloud: there, sent });
  const by = Object.fromEntries(plan.rows.map((row) => [row.key, row]));
  assert.deepEqual([by["bot:ember"].state, by["bot:ember"].parts, by["bot:ember"].differs], ["to-update", ["soul"], ["title"]]);
  assert.equal(by["bot:juno"].state, "only-here");
  assert.equal(by[itemKey.login("example.test", "alice")].state, "removed");
  assert.deepEqual(plan.removed, [itemKey.login("example.test", "alice")]);
  // My Cloud has no value: this computer's fills it; an equal part is remembered as in step.
  assert.deepEqual(by["setting:profile"].parts, ["name"]);
  assert.deepEqual(plan.baseline["bot:ember"], { name: ["n1", "n1"] });
  assert.deepEqual(plan.cloudOnly.map((row) => row.key), ["bot:miso"]);
  // The person chooses this computer's: the differing part goes too.
  assert.deepEqual(planSend({ local: here, cloud: there, sent, force: ["bot:ember"] }).rows.find((row) => row.key === "bot:ember").parts, ["soul", "title"]);
  // A login both sides have, never sent from here: in step from now on (its secret can't be compared).
  const logins = planSend({ local: summary([{ key: "login:a.test|amit", kind: "login", label: "a.test", parts: { saved: "1" } }]),
    cloud: summary([{ key: "login:a.test|amit", kind: "login", label: "a.test", parts: { saved: "9" } }]) });
  assert.deepEqual([logins.rows[0].state, logins.baseline["login:a.test|amit"]], ["on-both", { saved: ["1", "9"] }]);
  // Unchanged here, changed there: nothing goes.
  const quiet = planSend({ local: summary([bot("ember", { soul: "s1" })]), cloud: summary([bot("ember", { soul: "s5" })]), sent: { "bot:ember": { soul: ["s1", "s1"] } } });
  assert.equal(quiet.rows[0].state, "on-both");
});

test("a bot's skills go with the bot, follow its switch, and a removed bot's skills read as removed", () => {
  const skill = { key: itemKey.skill("ember", "notes"), kind: "skill", label: "notes", id: "notes", bot: "ember", parts: { text: "x", on: "on" } };
  const here = summary([bot("ember", { soul: "s" }), skill]);
  const plan = planSend({ local: here, cloud: summary([]) });
  assert.deepEqual(plan.rows.map((row) => row.state), ["only-here", "only-here"]);
  assert.deepEqual(pendingRows(plan).map((row) => row.key), ["bot:ember"]);
  assert.deepEqual(planSend({ local: here, cloud: summary([]), off: { "bot:ember": "you" } }).rows.map((row) => row.state), ["off", "off"]);
  assert.deepEqual(planSend({ local: here, cloud: summary([]), off: { "bot:ember": "removed" } }).rows.map((row) => row.state), ["removed", "removed"]);
  assert.equal(differenceSignature(plan), "bot:ember#only-here#");
});

test("a server's answer is kept only in the shape main relies on", () => {
  const parsed = parseSendSummary({ v: 1, appVersion: "0.1.117", items: [
    { key: "bot:ember", kind: "bot", label: "Ember", id: "ember", parts: { soul: "abc", "../x": "y", look: 5 } },
    { key: "evil", kind: "bot", parts: {} },
    { key: "bot:x", kind: "spaceship", parts: {} },
  ] });
  assert.deepEqual(parsed.items, [{ key: "bot:ember", kind: "bot", label: "Ember", id: "ember", parts: { soul: "abc" } }]);
  assert.equal(parseSendSummary({ v: 2, items: [] }), null);
  assert.equal(parseSendSummary(null), null);
});

test("a bot's fields reach My Cloud without Custom approval and without naming bots My Cloud lacks", () => {
  const ember = { id: "ember", soul: "Be brief.", approvalMode: "custom", alwaysAllow: ["Bash(ls)"], peers: ["juno", "kit"], modelSelection: { instanceId: "claude", model: "m", extra: 1 }, cwd: "/Users/amit/work" };
  const body = botPatch(ember, ["soul", "access", "team", "model"], new Set(["juno"]));
  assert.deepEqual(body, { soul: "Be brief.", alwaysAllow: ["Bash(ls)"], peers: ["juno"], modelSelection: { instanceId: "claude", model: "m" }, requireAvailableModel: true });
  assert.ok(!Object.values(BOT_PARTS).flat().includes("cwd"), "a working folder is this computer's");
  assert.deepEqual(parseSendState({ auto: false, clouds: { "javascript:alert(1)": {}, [CLOUD]: { off: { a: "you", b: "nonsense" } } } }).clouds,
    { [CLOUD]: { sent: {}, off: { a: "you" }, dismissed: "", last: null } });
  assert.equal(parseSendState(null).auto, true, "Keep My Cloud up to date is on unless the person turned it off");
});

function fakeSides({ cloudItems = [], localItems = [], refuse = {} } = {}) {
  const calls = [];
  const reply = (status, body) => ({ status, ok: status < 400, body });
  const session = {
    call: async (method, route) => {
      calls.push(`${method} ${route}`);
      if (route === "/api/cloud-send") return reply(200, summary(cloudItems));
      if (refuse[route]) return reply(refuse[route].status, { error: refuse[route].error });
      return reply(200, {});
    },
    upload: async (route) => { calls.push(`UPLOAD ${route}`); return reply(201, { path: "/data/attachments/abc.png" }); },
    close: async () => { calls.push("logout"); },
  };
  const localJson = (value) => new Response(JSON.stringify(value), { status: 200 });
  return {
    calls,
    deps: {
      local: async (route) => {
        if (route === "/api/cloud-send") return localJson(summary(localItems));
        if (route === "/api/bots?messages=0") return localJson({ bots: [{ id: "ember", threadId: "t-ember", name: "Ember", soul: "Be brief." }] });
        if (route === "/api/bots/ember/skills") return localJson({ skills: [] });
        if (route === "/api/bots/ember/memory") return localJson({ topics: [] });
        if (route.startsWith("/api/bots/ember/memory/file")) return localJson({ exists: false, text: "" });
        if (route === "/api/config") return localJson({ profile: { name: "Amit" } });
        return new Response("{}", { status: 404 });
      },
      cloud: { origin: () => CLOUD, asleep: () => false, read: async () => localJson(summary(cloudItems)), open: async () => session },
      handoff: async () => ({}),
      store: { read: () => null, write() {} },
      setTimer: () => 0, clearTimer() {},
    },
  };
}

test("a send adds a bot with its own id over one session, says what My Cloud refused, and always signs out", async () => {
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" })], refuse: { "/api/bots": { status: 409, error: "this workspace is limited to 50 bots" } } });
  const send = createCloudSend(sides.deps);
  const outcome = await send.send();
  assert.deepEqual(outcome.result.failed, [{ key: "bot:ember", kind: "bot", label: "ember", error: "this workspace is limited to 50 bots" }]);
  assert.deepEqual(sides.calls, ["GET /api/cloud-send", "POST /api/bots", "GET /api/cloud-send", "logout"]);
  assert.equal(send.snapshot().last.result.failed.length, 1);

  const asleep = fakeSides({ localItems: [bot("ember", { soul: "s" })] });
  asleep.deps.cloud.asleep = () => true;
  assert.equal((await createCloudSend(asleep.deps).compare()).cloud, "asleep");
  assert.deepEqual(asleep.calls, [], "a sleeping Cloud is never asked");

  const outdated = fakeSides({ localItems: [bot("ember", { soul: "s" })] });
  outdated.deps.cloud.read = async () => new Response("", { status: 404 });
  assert.equal((await createCloudSend(outdated.deps).compare()).cloud, "outdated");
});

test("My Cloud's page is told names of bots and counts, with an opaque signature; Logins reads My Cloud's logins from the same comparison", async () => {
  const sides = fakeSides({
    localItems: [bot("ember", { soul: "s" }), { key: itemKey.login("bank.example", "amit"), kind: "login", label: "bank.example", id: "l1", parts: { saved: "1" } }],
    cloudItems: [{ key: itemKey.login("crm.example", "ops"), kind: "login", label: "crm.example", detail: "ops", parts: { saved: "2" } }, { key: "1password", kind: "1password", label: "1Password", parts: { token: "x" } }],
  });
  const snapshot = await createCloudSend(sides.deps).compare();
  const notice = sendNotice(snapshot);
  assert.deepEqual({ ...notice, signature: notice.signature.length }, { ready: true, bots: ["ember"], updatedBots: [], skills: 0, logins: 1, onePassword: false, settings: 0, signature: 32, dismissed: false, running: false, last: null });
  assert.ok(!JSON.stringify(notice).includes("bank.example"));
  assert.deepEqual(loginsView(snapshot), { cloud: { reachable: true, logins: [{ site: "crm.example", username: "ops" }], onePassword: { connected: true, vaults: [] } } });
  assert.deepEqual(loginsView({ ...snapshot, cloud: "unreachable" }), { cloud: { reachable: false } });
  assert.deepEqual(loginsView({ ...snapshot, cloud: "none" }), { cloud: null });
});

test("an owner session is made only at the person's own Cloud, and nothing is sent to an origin a grant names instead", async () => {
  const fetched = [];
  const fetchImpl = async (url, init) => { fetched.push([url, init?.headers?.authorization ?? null]); return new Response(JSON.stringify({ token: "omb_sess_fake" }), { status: 200 }); };
  await assert.rejects(openOwnerSession({ origin: CLOUD, grant: async () => ({ origin: "https://attacker.example", code: "C" }) }, fetchImpl), /not ready/);
  assert.deepEqual(fetched, []);
  const session = await openOwnerSession({ origin: CLOUD, grant: async () => ({ origin: CLOUD, code: "C" }) }, fetchImpl);
  await session.call("GET", "/api/cloud-send");
  await session.close();
  assert.deepEqual(fetched.map(([url, auth]) => [url.replace(CLOUD, ""), auth]), [["/api/auth/pair", null], ["/api/cloud-send", "Bearer omb_sess_fake"], ["/api/auth/logout", "Bearer omb_sess_fake"]]);
});

test("this computer's Settings asks for everything; My Cloud's page only for its notice, Bring them over and Not now", async () => {
  const handlers = new Map();
  installCloudSend({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: (channel, handler) => (event, ...args) => { if (event.page !== "local") throw new Error(`${channel} is only available in this app's window`); return handler(event, ...args); },
    cloudPage: (event) => event.page ?? null,
    server: () => null, local: async () => new Response("{}", { status: 503 }), home: () => null,
    cookieFetch: async () => new Response("", { status: 401 }), reconnect: async () => false, power: { asleep: () => false },
    file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => LOCAL, openSettings() {},
  });
  const cloudPage = { page: "cloud" }, elsewhere = { page: null };
  for (const channel of ["cloud-send:state", "cloud-send:refresh", "cloud-send:send", "cloud-send:auto", "cloud-send:item", "cloud-logins:state", "cloud-logins:send"]) {
    assert.throws(() => handlers.get(channel)(cloudPage), /only available/, channel);
  }
  for (const channel of ["cloud-send:notice", "cloud-send:page-send", "cloud-send:dismiss"]) assert.throws(() => handlers.get(channel)(elsewhere), /only available/, channel);
  assert.deepEqual(await handlers.get("cloud-send:notice")(cloudPage), { ready: false, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null });
  assert.deepEqual(await handlers.get("cloud-logins:state")({ page: "local" }), { cloud: null });
  await assert.rejects(handlers.get("cloud-logins:send")({ page: "local" }, { kind: "1password" }), /no My Cloud yet/);
});

function preload({ remote = false, activation = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin: remote ? CLOUD : LOCAL }, navigator: { userActivation: { isActive: activation } },
    TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: () => false, invoke: (...args) => { invoked.push(args); return Promise.resolve({}); } } }),
  });
  return { bridge, invoked };
}

test("the bridge: Settings → MausBot Cloud only on this computer's page; My Cloud's page sends only from the person's click", async () => {
  const local = preload();
  await local.bridge.cloudSend.send({ keys: ["bot:ember"], force: [7], origin: "https://evil.example" });
  await local.bridge.cloudSend.setItem("bot:ember", "yes");
  assert.deepEqual(JSON.parse(JSON.stringify(local.invoked)), [["cloud-send:send", { keys: ["bot:ember"], force: ["7"] }], ["cloud-send:item", "bot:ember", false]]);
  const page = preload({ remote: true });
  assert.equal(page.bridge.cloudSend, undefined);
  assert.equal(page.bridge.cloudLogins, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(page.bridge.cloudSendPage))), ["notice", "send", "dismiss", "onNotice"]);
  await assert.rejects(page.bridge.cloudSendPage.send(), /Bring them over/);
  assert.deepEqual(page.invoked.filter(([channel]) => channel.startsWith("cloud-send")), []);
  const clicked = preload({ remote: true, activation: true });
  await clicked.bridge.cloudSendPage.send();
  assert.deepEqual(JSON.parse(JSON.stringify(clicked.invoked.filter(([channel]) => channel.startsWith("cloud-send")))), [["cloud-send:page-send"]]);
});

test("Keep My Cloud up to date: sends what waits, asks My Cloud only when something here changed, never while it sleeps or when switched off", async () => {
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" })] });
  let fire = null;
  let now = 1_000;
  let asleep = false;
  const reads = [];
  sides.deps.cloud.asleep = () => asleep;
  const read = sides.deps.cloud.read;
  sides.deps.cloud.read = async (route) => { reads.push(route); return read(route); };
  const send = createCloudSend({ ...sides.deps, now: () => now, setTimer: (callback) => { fire = callback; return 1; }, clearTimer() {} });
  const tick = async () => { const run = fire; fire = null; run(); for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve)); };
  send.start();
  await tick();
  assert.deepEqual(reads, ["/api/cloud-send"]);
  assert.ok(sides.calls.includes("POST /api/bots"), "what waited went by itself");
  assert.equal(send.snapshot().last.reason, "auto");
  const calls = sides.calls.length;
  reads.length = 0;
  await tick();
  assert.deepEqual(reads, [], "nothing changed here, so My Cloud is not asked");
  now += 31 * 60_000;
  asleep = true;
  await tick();
  assert.deepEqual(reads, [], "a sleeping Cloud is never woken");
  asleep = false;
  send.setAuto(false);
  await tick();
  assert.deepEqual(reads, []);
  assert.equal(sides.calls.length, calls);
  assert.equal(send.snapshot().auto, false);
});

test("Also use on My Cloud says plainly when My Cloud is too old to receive a login, instead of losing the login", async () => {
  const handlers = new Map();
  installCloudSend({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: (_channel, handler) => handler, cloudPage: () => "local",
    server: () => null, local: async () => new Response(JSON.stringify(summary([{ key: "1password", kind: "1password", label: "1Password", parts: { token: "t" } }])), { status: 200 }),
    home: () => ({ origin: CLOUD, grant: async () => ({ origin: CLOUD, code: "C" }) }),
    cookieFetch: async () => new Response("", { status: 404 }), reconnect: async () => false, power: { asleep: () => false },
    file: () => "/nonexistent/cloud-send.json", window: () => null, localOrigin: () => LOCAL, openSettings() {}, keepUpToDate: false,
  });
  assert.deepEqual(await handlers.get("cloud-logins:state")({}), { cloud: { reachable: false } });
  await assert.rejects(handlers.get("cloud-logins:send")({}, { kind: "1password" }), /My Cloud needs an update/);
});

test("replacing a skill whose text changed here puts My Cloud's copy back when the new one is refused", async () => {
  const skill = { key: itemKey.skill("ember", "notes"), kind: "skill", label: "notes", id: "notes", bot: "ember", parts: { text: "new", on: "on" } };
  const calls = [];
  const reply = (status, body) => ({ status, ok: status < 400, body });
  let installs = 0;
  const session = {
    call: async (method, route, body) => {
      calls.push(`${method} ${route}${body?.text ? ` ${body.text}` : ""}`);
      if (route === "/api/cloud-send") return reply(200, summary([bot("ember", { soul: "s" }), { ...skill, parts: { text: "old", on: "on" } }]));
      if (method === "GET" && route === "/api/bots/ember/skills") return reply(200, { skills: [{ name: "notes", description: "Notes", source: "cloud", enabled: true }] });
      if (method === "GET" && route === "/api/bots/ember/skills/notes") return reply(200, { text: "OLD" });
      if (method === "POST" && route.endsWith("/skill-template")) return ++installs === 1 ? reply(422, { error: "SKILL.md is invalid" }) : reply(201, {});
      return reply(200, {});
    },
    upload: async () => reply(201, {}), close: async () => {},
  };
  const localJson = (value) => new Response(JSON.stringify(value), { status: 200 });
  const send = createCloudSend({
    local: async (route) => route === "/api/cloud-send" ? localJson(summary([bot("ember", { soul: "s" }), skill]))
      : route === "/api/bots/ember/skills" ? localJson({ skills: [{ name: "notes", description: "Notes", source: "here", enabled: true }] })
        : localJson({ text: "NEW" }),
    cloud: { origin: () => CLOUD, asleep: () => false, read: async () => localJson(summary([])), open: async () => session },
    handoff: async () => ({}), store: { read: () => ({ clouds: { [CLOUD]: { sent: { [skill.key]: { text: ["old", "old"], on: ["on", "on"] } } } } }), write() {} },
    setTimer: () => 0, clearTimer() {},
  });
  const outcome = await send.send();
  assert.equal(outcome.result.failed[0]?.error, "My Cloud said: SKILL.md is invalid");
  assert.deepEqual(calls.filter((call) => /skill/.test(call)), [
    "GET /api/bots/ember/skills", "GET /api/bots/ember/skills/notes", "DELETE /api/bots/ember/skills/notes",
    "POST /api/bots/ember/skill-template NEW", "POST /api/bots/ember/skill-template OLD",
  ]);
});

test("a send asked while another runs waits for it, then runs as it was asked", async () => {
  const sides = fakeSides({ localItems: [bot("ember", { soul: "s" }), { key: itemKey.onePassword(), kind: "1password", label: "1Password", parts: { token: "t" } }] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const open = sides.deps.cloud.open;
  let opened = 0;
  sides.deps.cloud.open = async () => { if (opened++ === 0) await gate; return open(); };
  const send = createCloudSend(sides.deps);
  const first = send.send({ keys: ["bot:ember"] });
  const second = send.send({ keys: ["1password"], force: ["1password"] });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(opened, 2);
  assert.deepEqual([a.result.bots, b.result.bots], [["Ember"], []]);
  assert.deepEqual(b.result.failed.map((entry) => entry.key), ["1password"], "the second send carried its own keys");
});
