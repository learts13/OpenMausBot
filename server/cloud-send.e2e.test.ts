// Send to My Cloud, end to end: two real servers (this computer's and a Cloud home) with main's own wiring between them
// (scripts/testing/cloud-send-fixture.ts). Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { itemKey } from "../electron/cloud-send-parts.mjs";
import type { CloudSendNotice, CloudSendOutcome, CloudSendSnapshot } from "../electron/cloud-send.mjs";
import { createCloudMove } from "../electron/cloud-move.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

// Obvious fakes only.
const TOKEN = `ops_fake-send-${randomBytes(12).toString("hex")}`;
const PASSWORD = `fake-send-Passw0rd-${randomBytes(6).toString("hex")}`;
const SECRETS = [TOKEN, PASSWORD, "JBSWY3DPEHPK3PXP"];
const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SKILL = "---\nname: weekly-summary\ndescription: Summarise the week in five lines.\n---\n\nWrite five lines: wins, misses, next week.\n";
let fx: CloudSendFixture;

beforeAll(async () => { fx = await launchCloudSendFixture({ onePasswordToken: TOKEN }); }, hostTimeout(60_000));
afterAll(async () => { await fx?.close(); });

const row = (snapshot: { rows: Array<{ key: string; state: string }> }, key: string) => snapshot.rows.find((entry) => entry.key === key);

it("sends this computer's bot, its skill, picture and notes, a login, 1Password and About me to My Cloud, and keeps My Cloud's own", async () => {
  const { local, onCloud, cloudBase, edge, owner, labels } = fx;
  const ember = (await local("POST", "/api/bots", { name: "Ember", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect((await local("PATCH", `/api/bots/${ember.id}`, { soul: "You are Ember. Keep answers short.", approvalMode: "full", notifications: false, replyStyle: "conversational" })).status).toBe(200);
  expect((await local("PATCH", `/api/bots/${ember.id}`, { avatarUrl: await fx.picture(DOT) })).status).toBe(200);
  expect((await local("POST", `/api/bots/${ember.id}/skill-template`, { name: "weekly-summary", description: "Summarise the week in five lines.", warnings: [], source: "test", text: SKILL, enabled: true })).status).toBe(201);
  expect((await local("PUT", `/api/bots/${ember.id}/memory/file`, { path: "memory/clients.md", text: "Acme pays on the 5th.\n" })).status).toBe(200);
  const alice = (await local("POST", "/api/logins", { site: "accounts.example.test", username: "alice", password: PASSWORD, totp: "JBSWY3DPEHPK3PXP", bots: [ember.id] })).body.login;
  expect((await local("POST", "/api/logins/1password", { token: TOKEN })).status).toBe(200);
  expect((await local("PATCH", "/api/logins/1password/vaults/v1", { bots: [ember.id] })).status).toBe(200);
  expect((await local("PATCH", "/api/config", { profile: { name: "Amit", aboutMe: "Solo developer in Tel Aviv." } })).status).toBe(200);
  const miso = (await onCloud("POST", "/api/bots", { name: "Miso", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await onCloud("PATCH", `/api/bots/${miso.id}`, { soul: "You are Miso, the Chief of Staff." });

  const call = <T>(channel: string, ...args: unknown[]) => fx.call<T>(channel, "local", ...args);
  const refresh = () => call<CloudSendSnapshot>("cloud-send:refresh");
  const send = (input?: { keys?: string[]; force?: string[] }) => call<CloudSendOutcome>("cloud-send:send", input);
  const before = await refresh();
  expect(before.cloud).toBe("ready");
  expect(row(before, itemKey.bot(ember.id))?.state).toBe("only-here");
  expect(row(before, itemKey.skill(ember.id, "weekly-summary"))?.state).toBe("only-here");
  expect(row(before, itemKey.login("example.test", "alice"))?.state).toBe("only-here");
  expect(row(before, itemKey.onePassword())?.state).toBe("only-here");
  expect(row(before, itemKey.setting("profile"))).toMatchObject({ state: "to-update", parts: ["name", "about"] });
  expect(before.cloudOnly.map((entry) => entry.label)).toContain("Miso");
  // What My Cloud's own page is told: names of bots and counts, never a login's site.
  const notice = await fx.call<CloudSendNotice>("cloud-send:notice", "cloud");
  expect(notice).toMatchObject({ ready: true, bots: ["Ember"], skills: 0, logins: 1, onePassword: true, settings: 1, dismissed: false });
  expect(JSON.stringify(notice)).not.toContain("example.test");

  // Pepper stays only here: its switch is off.
  const pepper = (await local("POST", "/api/bots", { name: "Pepper", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await local("PATCH", `/api/bots/${pepper.id}`, { soul: "You are Pepper." });
  const ops = (await local("POST", "/api/logins", { site: "crm.example.test", username: "ops", password: PASSWORD, bots: [pepper.id] })).body.login;
  await call("cloud-send:item", itemKey.bot(pepper.id), false);
  await call("cloud-send:item", itemKey.login("example.test", "ops"), false);

  const outcome = await send();
  expect(outcome.result).toMatchObject({ bots: ["Ember"], skills: 1, logins: 1, onePassword: true, settings: ["profile"], failed: [] });

  const there = (await onCloud("GET", "/api/bots?messages=0")).body.bots as Array<Record<string, unknown>>;
  const copy = there.find((bot) => bot.id === ember.id)!;
  expect(copy).toMatchObject({ name: "Ember", threadId: ember.threadId, soul: "You are Ember. Keep answers short.", approvalMode: "full", notifications: false, replyStyle: "conversational" });
  expect(copy.modelSelection).toMatchObject({ instanceId: "claude", model: "claude-sonnet-5" });
  expect(typeof copy.avatarUrl).toBe("string");
  expect(Buffer.from(await (await fetch(`${cloudBase}${copy.avatarUrl}`, { headers: { ...edge, authorization: `Bearer ${owner}` } })).arrayBuffer())).toEqual(DOT);
  expect(there.find((bot) => bot.id === miso.id)?.name).toBe("Miso");
  expect(there.some((bot) => bot.id === pepper.id)).toBe(false);
  const skills = (await onCloud("GET", `/api/bots/${ember.id}/skills`)).body.skills as Array<{ name: string; enabled: boolean }>;
  expect(skills).toEqual([expect.objectContaining({ name: "weekly-summary", enabled: true })]);
  expect((await onCloud("GET", `/api/bots/${ember.id}/memory/file?path=memory/clients.md`)).body.text).toBe("Acme pays on the 5th.\n");
  const logins = (await onCloud("GET", "/api/logins")).body;
  // Ember is on My Cloud with the same id, so a login kept to Ember stays kept to Ember there.
  expect(logins.logins.filter((login: { source: string }) => login.source !== "1password")).toEqual([
    expect.objectContaining({ site: "example.test", username: "alice", hasTotp: true, bots: [ember.id] }),
  ]);
  expect(logins.onePassword).toMatchObject({ connected: true, vaults: [{ id: "v1", bots: [ember.id] }] });
  expect((await onCloud("GET", "/api/config")).body.profile).toMatchObject({ name: "Amit", aboutMe: "Solo developer in Tel Aviv." });

  const after = await refresh();
  expect(after.pending).toBe(0);
  expect(row(after, itemKey.bot(ember.id))?.state).toBe("on-both");
  expect(row(after, itemKey.bot(pepper.id))?.state).toBe("off");
  // Each send's own session signed out again.
  const sessions = (await onCloud("GET", "/api/auth/sessions")).body.sessions as Array<{ label?: string }>;
  expect(sessions.filter((session) => labels.includes(session.label ?? ""))).toEqual([]);

  // Settings → Logins' "Also use on My Cloud" is the same send for one login: Pepper is not on My Cloud, so the login
  // reaches no bot there, and the page says it narrowed.
  expect((await call<{ cloud: { logins: Array<{ site: string; username: string }> } }>("cloud-logins:state")).cloud.logins).toEqual([{ site: "example.test", username: "alice" }]);
  expect(await call("cloud-logins:send", { kind: "login", id: ops.id })).toMatchObject({ sent: true, narrowed: true });
  expect((await onCloud("GET", "/api/logins")).body.logins.find((login: { username: string }) => login.username === "ops")).toMatchObject({ bots: [] });

  // A change here goes; a change made on My Cloud is never overwritten unless the person chooses this computer's.
  await local("PATCH", `/api/bots/${ember.id}`, { soul: "You are Ember. Answer in one line." });
  await local("PATCH", `/api/bots/${ember.id}`, { title: "Research" });
  await onCloud("PATCH", `/api/bots/${ember.id}`, { title: "Ops" });
  const changed = await refresh();
  expect(row(changed, itemKey.bot(ember.id))).toMatchObject({ state: "to-update", parts: ["soul"], differs: ["title"] });
  expect((await send()).result).toMatchObject({ updatedBots: ["Ember"], failed: [] });
  expect((await onCloud("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === ember.id)).toMatchObject({ soul: "You are Ember. Answer in one line.", title: "Ops" });
  await send({ force: [itemKey.bot(ember.id)] });
  expect((await onCloud("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === ember.id)).toMatchObject({ title: "Research" });

  // Removed on My Cloud stays removed, until the person turns its switch back on.
  const sent = (await onCloud("GET", "/api/logins")).body.logins.find((login: { username: string }) => login.username === "alice");
  expect((await onCloud("DELETE", `/api/logins/${sent.id}`)).status).toBe(200);
  expect(row(await refresh(), itemKey.login("example.test", "alice"))?.state).toBe("removed");
  expect((await send()).result.logins).toBe(0);
  expect((await onCloud("GET", "/api/logins")).body.logins.some((login: { username: string }) => login.username === "alice")).toBe(false);
  expect(row(await call<CloudSendSnapshot>("cloud-send:item", itemKey.login("example.test", "alice"), true), itemKey.login("example.test", "alice"))?.state).toBe("only-here");
  expect((await send()).result.logins).toBe(1);

  // A password changed here goes on the next send.
  await local("PATCH", `/api/logins/${alice.id}`, { password: `${PASSWORD}-2` });
  expect(row(await refresh(), itemKey.login("example.test", "alice"))?.state).toBe("to-update");
  expect((await send()).result.logins).toBe(1);
  SECRETS.push(`${PASSWORD}-2`);

  for (const where of [...fx.answers, fx.logs()]) for (const value of SECRETS) expect(where).not.toContain(value);
}, hostTimeout(120_000));

it("a bot sent to My Cloud keeps its conversation's id, so Bring newer chats adds its chats there", async () => {
  const { local, onCloud } = fx;
  // Kai has nothing but its chats: My Cloud must still count it as there once it arrives without them.
  const kai = (await local("POST", "/api/bots", { name: "Kai", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect((await local("POST", `/api/bots/${kai.id}/messages`, { text: "The Acme deadline is Friday.", threadId: kai.threadId })).status).toBe(202);
  const answered = async () => ((await local("GET", `/api/threads/${kai.threadId}/messages?limit=50`)).body?.messages ?? [])
    .some((message: { role: string; kind: string }) => message.role === "bot" && message.kind === "text");
  const idle = async () => (await local("GET", "/api/bots")).body.bots.every((bot: { activity?: string; busy?: boolean }) => bot.activity !== "working" && !bot.busy);
  for (let tries = 0; !(await answered() && await idle()) && tries < 300; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await fx.call<CloudSendOutcome>("cloud-send:send", "local", { keys: [itemKey.bot(kai.id)] })).result.bots).toEqual(["Kai"]);
  expect((await onCloud("GET", `/api/threads/${kai.threadId}/messages?limit=50`)).body?.messages ?? []).toEqual([]);
  expect(row(await fx.call<CloudSendSnapshot>("cloud-send:refresh", "local"), itemKey.bot(kai.id))?.state).toBe("on-both");

  const move = createCloudMove({
    localRequest: (route, init) => fetch(`${fx.desktopBase}${route}`, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": fx.ownerCapability } }),
    fetchImpl: ((url: string, init: RequestInit = {}) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...fx.edge } })) as typeof fetch,
    tempRoot: join(fx.root, "move-temp"), availableBytes: async () => Number.MAX_SAFE_INTEGER, pollMs: 150, retryDelaysMs: [100, 300],
  });
  // A bot's turn can still be wrapping up after its reply; a backup refuses "busy" until it has.
  let brought = await move.bring({ id: "cloud", name: "My Cloud", origin: fx.cloudBase, kind: "cloud", grant: () => fx.grant("Copy from desktop") });
  for (let tries = 0; brought.error?.code === "busy" && tries < 40; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    brought = await move.bring({ id: "cloud", name: "My Cloud", origin: fx.cloudBase, kind: "cloud", grant: () => fx.grant("Copy from desktop") });
  }
  expect(brought.phase, JSON.stringify(brought)).toBe("done");
  const there = (await onCloud("GET", `/api/threads/${kai.threadId}/messages?limit=50`)).body.messages as Array<{ role: string; text?: string }>;
  expect(there.some((message) => message.role === "user" && message.text?.startsWith("The Acme deadline is Friday."))).toBe(true);
}, hostTimeout(120_000));
