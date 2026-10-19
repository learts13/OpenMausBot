import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_BROWSER_SYSTEM_PROMPT, browserEngineStatus, clearBrowserSessionState, closeBrowserSession, runningBrowserSessionNames } from "../browser-engine.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.ts";
import { TOOL_LIST } from "../browser/tools.ts";
import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { createBrowserHost } from "./browser.ts";

vi.mock("../browser-engine.ts", async (original) => {
  const actual = await original<typeof import("../browser-engine.ts")>();
  return {
    ...actual,
    browserEngineStatus: vi.fn(actual.browserEngineStatus),
    clearBrowserSessionState: vi.fn(async () => true),
    closeBrowserSession: vi.fn(async () => true),
    runningBrowserSessionNames: vi.fn(async () => []),
  };
});
vi.mock("../browser-processes.ts", async (original) => ({
  ...await original<typeof import("../browser-processes.ts")>(),
  orphanedBrowsers: vi.fn(async () => []),
}));

type Host = ReturnType<typeof createBrowserHost>;
const hosts: Host[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.browserRuntime.closeAll())); });

const turn = { threadId: "thread-1", generation: "gen-1" };

function setup(engine: "chrome" | "agent-browser" | undefined, { cloudHome = false }: { cloudHome?: boolean } = {}) {
  const cfg = {
    features: { browser: true },
    ...(engine ? { browserEngine: { engine } } : {}),
    browserProfiles: [
      { id: "work", name: "Work", partitionId: "p-work" },
      { id: "mine", name: "Mine", browser: "chrome", partitionId: "p-mine" },
    ],
  } as unknown as AppConfig;
  const bots = [{ id: "scout", name: "Scout", browser: true }];
  const minted: unknown[] = [];
  const host = createBrowserHost({
    cfg,
    store: () => ({ bots, bot: (id: string) => bots.find((bot) => bot.id === id) }) as unknown as Pick<Store, "bots" | "bot">,
    turnResources: { free: () => true },
    activeInternalGenerationByThread: new Map([[turn.threadId, turn.generation]]),
    mintInternalCapability: (capability) => { minted.push(capability); return "capability-token"; },
    DESKTOP_MANAGED: !cloudHome,
    CLOUD_HOME: cloudHome ? { machineId: "m-1" } : null,
    PORT: 4100,
  });
  hosts.push(host);
  return { cfg, host, minted };
}

describe("the bots' browser host with browserEngine.engine set to chrome", () => {
  it("gives a bot's turn the browser MCP server over its own profile on the new engine", async () => {
    const { host, minted } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    expect(browser?.spec).toEqual({ command: "omb-cdp", args: ["bot:scout"], env: {} });
    expect(browser?.integration).toMatchObject({ command: process.execPath, env: { OMB_HARNESS_URL: "http://127.0.0.1:4100" } });
    expect(minted).toEqual([expect.objectContaining({ botId: "scout", browserSession: browser?.session, kind: "browser", ...turn })]);
    expect(host.usedBrowserSessions.get(browser!.session)).toEqual(browser?.spec);
  });

  it("puts a shared profile's bots on one profile and a temporary browser on its own", async () => {
    const { host } = setup("chrome");
    expect((await host.browserIntegration("scout", "work"))?.spec.args).toEqual(["shared:p-work"]);
    const guest = await host.browserIntegration("scout", "guest");
    expect(guest?.spec.args).toEqual([`temp:${guest?.session}`]);
  });

  it("lists the new browser's tools without starting Chrome", async () => {
    const { host } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    const listed = await host.browserRuntime.agentRpc(browser!.session, browser!.spec as never, "tools/list", {}) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_LIST.map((tool) => tool.name));
  });

  it("keeps a profile on the person's own Chrome on agent-browser: its prompt, and no sites list from either", () => {
    const { host } = setup("chrome");
    expect(host.browserSystemPrompt(undefined)).toBe(CHROME_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt("work")).toBe(CHROME_BROWSER_SYSTEM_PROMPT);
    expect(host.browserSystemPrompt("mine")).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.signedInSitesRefusal("mine")).toContain("your own Chrome");
    expect(host.signedInSitesRefusal("work")).toContain("does not list signed-in sites yet");
  });

  it("says in the status which engine runs the bots' browsers", () => {
    const { cfg, host } = setup("chrome");
    expect(host.engineSummary({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true })).toMatchObject({ engine: "chrome", myChrome: true });
    cfg.browserEngine = { engine: "agent-browser" };
    expect(host.engineSummary({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true })).toEqual({ kind: "unavailable", reason: "agent-browser is not installed", myChrome: true, engine: "agent-browser" });
  });

  it("forgets the new engine's sessions when the engine is switched back", async () => {
    const { cfg, host } = setup("chrome");
    const browser = await host.browserIntegration("scout", undefined, turn);
    cfg.browserEngine = { engine: "agent-browser" };
    host.browserEngineSwitched();
    expect(host.usedBrowserSessions.has(browser!.session)).toBe(false);
    expect(host.browserSystemPrompt(undefined)).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
  });
});

describe("how long an unused browser stays open", () => {
  it("is three minutes on a Cloud home and ten on a desktop, unless config.json sets it", () => {
    const cloud = setup(undefined, { cloudHome: true });
    expect(cloud.host.browserIdleMs()).toBe(3 * 60_000);
    cloud.cfg.browserEngine = { idleTimeoutMinutes: 20 };
    expect(cloud.host.browserIdleMs()).toBe(20 * 60_000);
    expect(setup(undefined).host.browserIdleMs()).toBe(10 * 60_000);
  });
});

describe("the bots' browser host by default", () => {
  it("keeps agent-browser's prompt and status", () => {
    const { host } = setup(undefined);
    expect(host.browserSystemPrompt(undefined)).toBe(BUILT_IN_BROWSER_SYSTEM_PROMPT);
    expect(host.signedInSitesRefusal("work")).toBeNull();
    expect(host.engineSummary({ kind: "engine", version: "0.37.0", myChrome: true })).toEqual({ kind: "engine", version: "0.37.0", myChrome: true, engine: "agent-browser" });
  });
});

describe("a deleted bot's browser", () => {
  const PATH_ENGINE = "/usr/local/bin/agent-browser";
  const MANAGED_ENGINE = "/data/.openmausbot/tools/agent-browser";
  const folders: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  /** agent-browser on PATH, as the Cloud image installs it; with `managed`, also the one OpenMausBot installed. */
  function engines({ managed = false }: { managed?: boolean } = {}) {
    vi.mocked(browserEngineStatus).mockImplementation((options) => (options?.managedOnly && !managed
      ? { kind: "unavailable", reason: "not installed", installable: true }
      : { kind: "ready", binaryPath: options?.managedOnly ? MANAGED_ENGINE : PATH_ENGINE, version: "0.37.0", managed: options?.managedOnly === true }));
    vi.mocked(clearBrowserSessionState).mockClear().mockResolvedValue(true);
    vi.mocked(closeBrowserSession).mockClear().mockResolvedValue(true);
  }
  function daemons(sessions: string[]) {
    const folder = mkdtempSync(join(tmpdir(), "omb-host-sweep-"));
    folders.push(folder);
    mkdirSync(join(folder, "agent-browser"));
    for (const session of sessions) writeFileSync(join(folder, "agent-browser", `${session}.pid`), "0");
    vi.stubEnv("XDG_RUNTIME_DIR", folder);
    vi.mocked(runningBrowserSessionNames).mockResolvedValue(sessions);
  }
  const deleted = { type: "openmausbot:browser-bot-deleted" as const, requestId: "00000000-0000-4000-8000-000000000000", botId: "gone" };
  const closed = () => vi.mocked(closeBrowserSession).mock.calls.map(([binary, env]) => `${binary} ${env.AGENT_BROWSER_SESSION}`);

  it("on a Cloud home, is closed and its sign-ins erased with the image's agent-browser", async () => {
    engines();
    const { host } = setup(undefined, { cloudHome: true });
    expect(await host.eraseDeletedBrowser(deleted)).toBe(true);
    expect(vi.mocked(clearBrowserSessionState).mock.calls.map(([binary, session]) => `${binary} ${session}`)).toEqual([`${PATH_ENGINE} bot-gone`]);
    vi.mocked(clearBrowserSessionState).mockResolvedValue(false);
    expect(await host.eraseDeletedBrowser(deleted)).toBe(false);
  });

  it("elsewhere, is erased only with the agent-browser OpenMausBot installed, and otherwise just closed", async () => {
    engines();
    const { host } = setup(undefined);
    expect(await host.eraseDeletedBrowser(deleted)).toBe(true);
    expect(clearBrowserSessionState).not.toHaveBeenCalled();
    expect(closed()).toEqual([`${PATH_ENGINE} bot-gone`]);
    engines({ managed: true });
    expect(await host.eraseDeletedBrowser(deleted)).toBe(true);
    expect(vi.mocked(clearBrowserSessionState).mock.calls.map(([binary, session]) => `${binary} ${session}`)).toEqual([`${MANAGED_ENGINE} bot-gone`]);
  });

  it("on a Cloud home, is closed by the minute's sweep even after this run used it, and nobody else's browser is", async () => {
    engines();
    daemons(["bot-gone", "default", "work-own"]);
    const { host } = setup(undefined, { cloudHome: true });
    host.usedBrowserSessions.set("bot-gone", { command: PATH_ENGINE, env: {} });
    host.browserSweep.start();
    await vi.waitFor(() => expect(closed()).toContain(`${PATH_ENGINE} bot-gone`));
    expect(closed()).toEqual([`${PATH_ENGINE} bot-gone`]);
    await host.browserSweep.closeAll();
  });

  it("off a Cloud home, is left to the deletion, as anything else under the same HOME", async () => {
    engines();
    daemons(["bot-gone", "default"]);
    const { host } = setup(undefined);
    host.browserSweep.start();
    await vi.waitFor(() => expect(runningBrowserSessionNames).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed()).toEqual([]);
    await host.browserSweep.closeAll();
  });
});
