import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSendBridge, CloudSendNotice, CloudSendPageBridge, CloudSendSnapshot } from "../../electron/cloud-send.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudSendCard } from "./CloudSendCard";
import { CloudSendStrip } from "./CloudSendStrip";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; "aria-checked"?: boolean; "aria-label"?: string; "data-cloud-send-all"?: boolean }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
function render(component: () => ReactNode) {
  f.index = 0; f.effects = []; let tree: ReactNode;
  function Capture() { tree = component(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture)).replaceAll("&#x27;", "'");
  return { html, nodes: Children.toArray(nodes(tree)).flatMap((node) => [node as Node]) };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deep = (value: ReactNode): Node[] => {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  if (typeof node.type === "function") return deep((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...Children.toArray(node.props.children).flatMap(deep)];
};
const tree = (component: () => ReactNode) => { f.index = 0; f.effects = []; return deep(component()); };
const text = (node: Node): string => Children.toArray(node.props.children).map((child) => isValidElement(child) ? text(child as Node) : String(child)).join("");

const snapshot: CloudSendSnapshot = {
  cloud: "ready", auto: true, running: null, pending: 2, signature: "sig", dismissed: "", last: null, cloudVersion: "0.1.117", localVersion: "0.1.117",
  rows: [
    { key: "bot:ember", kind: "bot", label: "Ember", id: "ember", state: "only-here" },
    { key: "bot:juno", kind: "bot", label: "Juno", id: "juno", state: "differs", differs: ["title"] },
    { key: "1password", kind: "1password", label: "1Password", state: "only-here" },
  ],
  cloudOnly: [{ key: "bot:miso", kind: "bot", label: "Miso" }],
};
let bridge: CloudSendBridge;
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = [];
  bridge = {
    state: vi.fn().mockResolvedValue(snapshot), refresh: vi.fn().mockResolvedValue(snapshot), onState: vi.fn(() => () => {}),
    send: vi.fn().mockResolvedValue({ at: 1, reason: "button", result: { bots: ["Ember"], updatedBots: [], skills: 0, logins: 0, onePassword: true, settings: [], failed: [], notes: [] } }),
    setAuto: vi.fn().mockResolvedValue({ ...snapshot, auto: false }), setItem: vi.fn().mockResolvedValue(snapshot),
  };
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); });

const card = () => CloudSendCard();
async function ready() {
  vi.stubGlobal("window", { ogb: { cloudSend: bridge } });
  render(card); for (const effect of f.effects) effect(); await flush();
}

it("Settings → MausBot Cloud: both sides side by side, Send everything, and the switch, on by default", async () => {
  await ready();
  const { html } = render(card);
  expect(bridge.refresh).toHaveBeenCalledTimes(1);
  expect(html).toContain("This computer and My Cloud");
  expect(html).toContain("My Cloud is online · version 0.1.117");
  expect(html).toContain("Ember only here · 1 different on My Cloud · Miso only on My Cloud");
  expect(html).toContain("1Password only here");
  expect(html).toContain("Send everything to My Cloud");
  expect(html).toContain("Keep My Cloud up to date with this computer");
  expect(html).toContain('aria-labelledby="cloud-send-auto" data-cloud-send-auto="true" type="button" role="switch" aria-checked="true"');
  expect(html).toContain("Stays separate: the chats on each side");
  tree(card).find((node) => node.props["data-cloud-send-all"])!.props.onClick!(); await flush();
  expect(bridge.send).toHaveBeenCalledWith();
  expect(render(card).html).toContain("Sent to My Cloud: Ember and 1Password.");
  tree(card).find((node) => node.props["aria-checked"] === true)!.props.onClick!(); await flush();
  expect(bridge.setAuto).toHaveBeenCalledWith(false);
});

it("Choose what goes: a switch per item, and Use this computer's where My Cloud's differs", async () => {
  await ready();
  tree(card).find((node) => node.type === "button" && text(node).includes("Choose what goes"))!.props.onClick!();
  const open = tree(card);
  expect(render(card).html).toContain("Different on My Cloud");
  open.find((node) => node.props["aria-label"] === "Also on My Cloud: Ember")!.props.onClick!(); await flush();
  expect(bridge.setItem).toHaveBeenCalledWith("bot:ember", false);
  open.find((node) => node.type === "button" && text(node) === "Use this computer's")!.props.onClick!(); await flush();
  expect(bridge.send).toHaveBeenCalledWith({ keys: ["bot:juno"], force: ["bot:juno"] });
});

it("is absent without My Cloud, in a browser and on a paired remote client", async () => {
  vi.mocked(bridge.state).mockResolvedValue({ ...snapshot, cloud: "none" });
  vi.mocked(bridge.refresh).mockResolvedValue({ ...snapshot, cloud: "none" });
  await ready();
  expect(render(card).html).toBe("");
  vi.stubGlobal("window", {});
  f.values = [];
  expect(render(card).html).toBe("");
  vi.stubGlobal("window", { ogb: { cloudSend: bridge, remoteClient: { active: true } } });
  f.values = [];
  expect(render(card).html).toBe("");
});

const notice: CloudSendNotice = { ready: true, bots: ["Ember"], updatedBots: [], skills: 2, logins: 0, onePassword: true, settings: 0, signature: "sig-1", dismissed: false, running: false, last: null };
let page: CloudSendPageBridge;
const strip = (cloudHome = true) => () => CloudSendStrip({ cloudHome });
async function onCloud(value = notice, cloudHome = true) {
  page = { notice: vi.fn().mockResolvedValue(value), send: vi.fn().mockResolvedValue({ ...value, bots: [], skills: 0, onePassword: false, signature: "", last: { at: 2, failed: 0 } }),
    dismiss: vi.fn().mockResolvedValue({ ...value, dismissed: true }), onNotice: vi.fn(() => () => {}) };
  vi.stubGlobal("window", { ogb: { cloudSendPage: page } });
  render(strip(cloudHome)); for (const effect of f.effects) effect(); await flush();
}

it("My Cloud's strip names what is on This computer but not here; Bring them over sends, Not now hides it until something new", async () => {
  await onCloud();
  expect(render(strip()).html).toContain("Ember, 2 skills, and 1Password are on This computer but not here.");
  const bring = tree(strip()).find((node) => node.type === "button" && text(node) === "Bring them over")!;
  bring.props.onClick!(); await flush();
  expect(page.send).toHaveBeenCalledTimes(1);
  expect(render(strip()).html).toContain("Done. My Cloud has them now.");
  f.values = [];
  await onCloud();
  tree(strip()).find((node) => node.type === "button" && text(node) === "Not now")!.props.onClick!(); await flush();
  expect(page.dismiss).toHaveBeenCalledWith("sig-1");
  expect(render(strip()).html).toBe("");
});

it("the strip stays away when nothing waits, when dismissed, and on any page but My Cloud's", async () => {
  await onCloud({ ...notice, bots: [], skills: 0, onePassword: false });
  expect(render(strip()).html).toBe("");
  f.values = [];
  await onCloud({ ...notice, dismissed: true });
  expect(render(strip()).html).toBe("");
  f.values = [];
  await onCloud(notice, false);
  expect(render(strip(false)).html).toBe("");
  expect(page.notice).not.toHaveBeenCalled();
});
