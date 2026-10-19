// Send to My Cloud in the real renderer, against two real servers and main's own wiring (testing/cloud-send-fixture.ts):
// this computer with Ember (instructions, picture, two skills, notes), two logins and 1Password; My Cloud with its own
// Chief and nine bots. Prints this computer's page (Settings → MausBot Cloud) and My Cloud's page, then waits.
// Run: node --experimental-strip-types scripts/verify-cloud-send.ts
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";
import { SPOTLIGHTS } from "../src/lib/first-conversation.ts";
import { TOUR_STEPS } from "../src/lib/guided-tour.ts";
import { launchCloudSendFixture, type CloudSendFixture } from "./testing/cloud-send-fixture.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const environments = createRequire(import.meta.url)("../electron/environments.cjs");
const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`;

export async function seedAmit(fx: CloudSendFixture, onePasswordToken: string): Promise<{ ember: string }> {
  const ember = (await fx.local("POST", "/api/bots", { name: "Ember", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot.id as string;
  await fx.local("PATCH", `/api/bots/${ember}`, { soul: "You are Ember, Amit's research and coding helper.", title: "Research", approvalMode: "full", avatarUrl: await fx.picture(DOT) });
  for (const [name, description] of [["weekly-summary", "Summarise the week in five lines."], ["invoice-check", "Check an invoice against the contract."]]) {
    await fx.local("POST", `/api/bots/${ember}/skill-template`, { name, description, warnings: [], source: "this computer", text: skill(name!, description!), enabled: true });
  }
  await fx.local("PUT", `/api/bots/${ember}/memory/file`, { path: "memory/clients.md", text: "Acme pays on the 5th.\n" });
  await fx.local("POST", "/api/logins", { site: "github.com", username: "amit", password: `fake-${randomBytes(6).toString("hex")}`, bots: "all" });
  await fx.local("POST", "/api/logins", { site: "app.example-crm.test", username: "amit@example.test", password: `fake-${randomBytes(6).toString("hex")}`, bots: [ember] });
  const welcomed = { onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS] } };
  await fx.local("PATCH", "/api/config", welcomed);
  await fx.onCloud("PATCH", "/api/config", { onboarding: { ...welcomed.onboarding, hintsSeen: [...welcomed.onboarding.hintsSeen, "cloud-welcome-done", "cloud-setup-hidden"] } });
  await fx.local("POST", "/api/logins/1password", { token: onePasswordToken });
  await fx.local("PATCH", "/api/config", { profile: { name: "Amit", aboutMe: "Solo developer. Prefers short answers." } });
  for (const name of ["Miso", "Atlas", "Juno", "Kit", "Lark", "Nova", "Pip", "Rune", "Sage", "Wren"]) {
    const bot = (await fx.onCloud("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
    await fx.onCloud("PATCH", `/api/bots/${bot.id}`, { soul: `You are ${name}.` });
  }
  await fx.onCloud("POST", "/api/logins", { site: "mail.example.test", username: "amit", password: `fake-${randomBytes(6).toString("hex")}`, bots: "all" });
  return { ember };
}

async function readJson(req: IncomingMessage): Promise<{ page?: string; args?: unknown[] }> {
  let text = "";
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}
const reply = (res: ServerResponse, status: number, value: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value ?? null)); };

export async function mountCloudSendPages(fx: CloudSendFixture): Promise<{ local: MountedPreview; cloud: MountedPreview }> {
  const send = {
    path: /^\/__send\/([\w:-]+)$/, method: "POST",
    handler: async (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray | null) => {
      const { page, args = [] } = await readJson(req);
      try { reply(res, 200, await fx.call(match![1]!, page === "cloud" ? "cloud" : "local", ...args)); }
      catch (error) { reply(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    },
  };
  const menu = {
    path: "/__menu", method: "GET",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const page = new URL(req.url ?? "/", "http://fixture").searchParams.get("page");
      const cloud = { id: "cloud", name: "My Cloud", origin: "https://omb-u-6b65ec5f6111.fly.dev" };
      const state = { environments: [cloud], activeId: page === "cloud" ? "cloud" : "local" };
      const options = await environments.placesMenuOptions({ cloud, activeId: state.activeId, platform: "darwin", send: fx.menu(),
        localBots: () => fx.local("GET", "/api/bots").then((answer) => answer.body) });
      const items = environments.workspaceMenuTemplate(state, { onSwitch() {}, onConnect() {}, onForget() {}, sublabels: { cloud: "Always on" }, ...options });
      reply(res, 200, items.map(({ click: _click, ...item }: Record<string, unknown>) => item));
    },
  };
  const local = await mountPreview({ info: { url: fx.desktopBase } }, { entry: "/scripts/testing/cloud-send-preview.tsx", route: "/__cloud-send.html",
    title: "This computer and My Cloud", logLevel: "warn", extraRoutes: [send, menu], proxyHeaders: { "x-openmausbot-desktop-owner": fx.ownerCapability } });
  const cloud = await mountPreview({ info: { url: fx.cloudBase } }, { entry: "/scripts/testing/cloud-send-preview.tsx", route: "/__my-cloud.html",
    title: "My Cloud", logLevel: "warn", extraRoutes: [send, menu], proxyHeaders: { ...fx.edge, authorization: `Bearer ${fx.owner}` } });
  return { local, cloud };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = `ops_fake-verify-${randomBytes(12).toString("hex")}`;
  const fx = await launchCloudSendFixture({ onePasswordToken: token });
  let pages: Awaited<ReturnType<typeof mountCloudSendPages>> | undefined;
  try {
    await seedAmit(fx, token);
    pages = await mountCloudSendPages(fx);
    console.log(JSON.stringify({ thisComputer: `${pages.local.previewUrl}?page=local`, myCloud: `${pages.cloud.previewUrl}?page=cloud`, desktop: fx.desktopBase, cloud: fx.cloudBase }, null, 2));
    await parkUntilSignal();
  } finally {
    await pages?.local.close();
    await pages?.cloud.close();
    await fx.close();
  }
}
