import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudLendingBridge, CloudLendingSnapshot } from "../../electron/computer-sharing.mjs";
import { setLocale } from "@/lib/i18n";
const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = next; }]; },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
}));
import { CloudLending, lendingStatusKey, lendingStoppedLine } from "./CloudLending";

type Node = ReactElement<{ children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { checked: boolean } }) => void; role?: string; type?: string; "aria-label"?: string; disabled?: boolean; checked?: boolean }>;
function nodes(value: ReactNode): Node[] { if (!isValidElement(value)) return []; const node = value as Node; return [node, ...Children.toArray(node.props.children).flatMap(nodes)]; }
let bridge: CloudLendingBridge;
function render() { f.index = 0; f.effects = []; let tree: ReactNode; function Capture() { tree = CloudLending({ bridge }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture)); return { html, nodes: nodes(tree) }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const folder = { id: "11111111-1111-4111-8111-111111111111", name: "Plans", path: "/Users/me/Plans", write: false };
const off: CloudLendingSnapshot = { available: true, screenAvailable: true, state: { enabled: false, folders: [], screen: false, busy: false }, activity: [] };
const lent: CloudLendingSnapshot = { available: true, screenAvailable: true, state: { enabled: true, folders: [folder], screen: false, busy: false, connected: true }, activity: [] };
async function ready(snapshot: CloudLendingSnapshot) {
  vi.mocked(bridge.state).mockResolvedValue(snapshot);
  render(); const cleanup = f.effects[0]!(); await flush(); return cleanup;
}
const toggle = () => render().nodes.find(node => node.props.role === "switch" || node.props["aria-label"] === "Let My Cloud use this computer")!;
beforeEach(() => {
  f.values = []; f.index = 0; f.effects = [];
  bridge = { state: vi.fn(), chooseFolder: vi.fn().mockResolvedValue(folder), save: vi.fn().mockResolvedValue(lent), stop: vi.fn().mockResolvedValue(off) };
  vi.stubGlobal("window", { confirm: vi.fn(() => { throw new Error("no confirmation dialogs"); }) });
  setLocale("en");
});
afterEach(() => { vi.unstubAllGlobals(); });

it("says where lending stands in one line", () => {
  expect(lendingStatusKey(lent, true)).toBe("lending.status.lent");
  expect(lendingStatusKey({ ...lent, state: { ...lent.state!, busy: true } }, true)).toBe("lending.status.busy");
  expect(lendingStatusKey({ ...lent, state: { ...lent.state!, connected: false, problem: "connect-first" } }, true)).toBe("lending.status.connectFirst");
  expect(lendingStatusKey({ ...lent, state: { ...lent.state!, connected: false } }, true)).toBe("lending.status.starting");
  expect(lendingStatusKey(off, true)).toBe("lending.status.chooseSomething");
  expect(lendingStatusKey(off, false)).toBeNull();
  expect(lendingStatusKey({ ...off, state: { ...off.state!, problem: "signed-out" } }, false)).toBe("lending.status.signedOut");
});

it("shows nothing until the person is signed in to a known Cloud", async () => {
  await ready({ available: false, screenAvailable: false });
  expect(render().html).toBe("");
});

it("is a switch, off by default; turning it on shows the choices and lends nothing until one is chosen", async () => {
  await ready(off);
  let view = render();
  expect(view.html).toContain("Let My Cloud use this computer");
  expect(view.html).not.toContain("Apps and screen");
  toggle().props.onClick!();
  await flush();
  view = render();
  expect(view.html).toContain("Choose what My Cloud can use.");
  expect(view.html).toContain("If someone else writes in a conversation, it can no longer use your computer.");
  expect(view.html).toContain("Apps and screen");
  expect(bridge.save).not.toHaveBeenCalled();
  view.nodes.find(node => node.type === "button" && Children.toArray(node.props.children).includes("Add folder"))!.props.onClick!();
  await flush();
  expect(bridge.save).toHaveBeenCalledExactlyOnceWith({ folders: [folder], screen: false });
});

it("while lent, says so, shows this computer's activity, and removing the last choice stops lending instead of saving nothing", async () => {
  await ready({ ...lent, state: { ...lent.state!, busy: true }, activity: [{ at: 1_790_000_000_000, server: "My Cloud", origin: "https://c.test", action: "read_file", detail: "Plans/todo.md", ok: true }] });
  const view = render();
  expect(view.html).toContain("My Cloud is using this computer now.");
  expect(view.html).toContain("Plans/todo.md");
  expect(view.html).toContain("Read a file");
  view.nodes.find(node => node.props["aria-label"] === "Remove Plans")!.props.onClick!();
  await flush();
  expect(bridge.stop).toHaveBeenCalledOnce();
  expect(bridge.save).not.toHaveBeenCalled();
});

it("turning the switch off stops lending at once", async () => {
  await ready(lent);
  toggle().props.onClick!();
  await flush();
  expect(bridge.stop).toHaveBeenCalledOnce();
});

it("apps and screen cannot be chosen until this app's computer control is ready", async () => {
  await ready({ ...lent, screenAvailable: false });
  const view = render();
  const checkbox = view.nodes.find(node => node.type === "input" && node.props.checked === false && node.props.disabled === true);
  expect(checkbox).toBeTruthy();
  expect(view.html).toContain("Set up computer control for this app first");
});

// A customer saw the switch off while his computer still showed apps and screen lent, with no reason given.
it("an off switch says why and since when, keeps the choices, and lends the same again in one click", async () => {
  const at = new Date(2026, 9, 7, 14, 2).getTime();
  const stopped: CloudLendingSnapshot = { available: true, screenAvailable: true, activity: [],
    state: { enabled: false, folders: [folder], screen: true, busy: false, stopped: { reason: "signed-out", at } } };
  expect(lendingStoppedLine(stopped.state)).toBe("Off since Oct 7, 2026, 2:02 PM, when you signed out of MausBot Cloud.");
  expect(lendingStoppedLine({ ...stopped.state!, stopped: { reason: "you", at } })).toBe("Off since Oct 7, 2026, 2:02 PM: you turned it off.");
  expect(lendingStoppedLine({ ...stopped.state!, stopped: { reason: "something-new", at } })).toBe("Off since Oct 7, 2026, 2:02 PM.");
  expect(lendingStoppedLine(lent.state)).toBeNull();
  await ready(stopped);
  const view = render();
  expect(view.html).toContain('data-lending-stopped="signed-out"');
  expect(view.html).not.toContain("Apps and screen<");
  view.nodes.find(node => node.type === "button" && Children.toArray(node.props.children).join("") === "Lend the same again")!.props.onClick!();
  await flush();
  expect(vi.mocked(bridge.save).mock.calls).toEqual([[{ folders: [folder], screen: true }]]);
});

it("says how it is lent when Computer access lent it, terminal included, and when My Cloud last used it", async () => {
  const viaAccess: CloudLendingSnapshot = { available: true, screenAvailable: true,
    activity: [{ at: Date.now() - 3 * 60_000, server: "My Cloud", origin: "https://omb-u-1.fly.dev", action: "computer_call", detail: "", ok: true }],
    state: { enabled: true, folders: [], screen: true, busy: false, via: "access", terminal: true, problem: "access-off" } };
  expect(lendingStatusKey(viaAccess, true)).toBe("lending.status.accessOff");
  await ready(viaAccess);
  const html = render().html;
  expect(html).toContain("Lent through Computer access in Settings → Servers, terminal included.");
  expect(html).toContain("My Cloud last used this computer 3 minutes ago.");
  await ready({ ...lent, activity: [] });
  expect(render().html).toContain("My Cloud hasn&#x27;t used this computer yet.");
});
