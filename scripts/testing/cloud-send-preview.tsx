// The whole app as the desktop app shows it, against scripts/verify-cloud-send.ts's two real servers: this computer's page
// (?page=local, opened on Settings → MausBot Cloud) or My Cloud's (?page=cloud). Only main's bridges are stand-ins, and
// Send to My Cloud's call main's own wiring through /__send. The switcher's native menu is drawn from main's own template
// (/__menu), since a page cannot show a native menu.
import { createRoot } from "react-dom/client";
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { NOTICES } from "../../src/lib/notices";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const page = params.get("page") === "cloud" ? "cloud" : "local";
const GB = 1024 ** 3;

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`/__send/${channel}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page, args }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value as T;
}

/** Main pushes state changes; here the page asks once a second while it listens. */
function polled<T>(channel: string) {
  return (listener: (value: T) => void) => {
    const timer = setInterval(() => { void call<T>(channel).then(listener).catch(() => {}); }, 1_000);
    return () => clearInterval(timer);
  };
}

const machine = { status: "ready", origin: "https://omb-u-6b65ec5f6111.fly.dev" };
const account = { status: "connected", account: { id: "fixture", email: "amit@example.test" }, entitlement: { plan: "pro", tier: "pro", status: "active", expiresAt: null, version: 3 }, machine } as unknown as CloudAccountState;

async function showMenu() {
  const items = await (await fetch(`/__menu?page=${page}`)).json() as Array<{ id?: string; type?: string; label?: string; sublabel?: string; enabled?: boolean; checked?: boolean }>;
  document.querySelector("[data-menu-stand-in]")?.remove();
  const menu = document.createElement("div");
  menu.setAttribute("data-menu-stand-in", "");
  menu.setAttribute("role", "menu");
  menu.style.cssText = "position:fixed;left:12px;top:52px;z-index:80;min-width:330px;padding:5px;border-radius:9px;background:rgba(246,246,246,.97);color:#1d1d1f;box-shadow:0 10px 32px rgba(0,0,0,.28),0 0 0 .5px rgba(0,0,0,.25);font:13px -apple-system,BlinkMacSystemFont,sans-serif";
  for (const item of items) {
    if (item.type === "separator") { const line = document.createElement("div"); line.style.cssText = "height:1px;margin:5px 8px;background:rgba(0,0,0,.12)"; menu.append(line); continue; }
    const row = document.createElement("div");
    row.setAttribute("role", "menuitem");
    if (item.id) row.dataset.menuItem = item.id;
    row.style.cssText = `padding:4px 10px 4px 24px;border-radius:5px;position:relative;${item.enabled === false ? "color:#8e8e93" : ""}${item.id === "workspace-copy-to-cloud" ? "background:#0a64d8;color:white" : ""}`;
    row.textContent = item.label ?? "";
    if (item.checked) { const mark = document.createElement("span"); mark.textContent = "✓"; mark.style.cssText = "position:absolute;left:8px"; row.prepend(mark); }
    if (item.sublabel) { const sub = document.createElement("div"); sub.textContent = item.sublabel; sub.style.cssText = `font-size:11px;${item.id === "workspace-copy-to-cloud" ? "" : "color:#8e8e93"}`; row.append(sub); }
    menu.append(row);
  }
  document.body.append(menu);
}

window.ogb = {
  platform: "darwin",
  getCapabilities: async () => initialDesktopCapabilities(),
  onCapabilitiesChanged: () => () => {},
  workspaces: { state: async () => page === "cloud" ? { local: false, name: "My Cloud", origin: location.origin } : { local: true, name: "This computer" }, menu: showMenu },
  cloudLending: { open: async () => {} },
  cloudSendPage: {
    notice: () => call("cloud-send:notice"), send: () => call("cloud-send:page-send"), dismiss: (signature: string) => call("cloud-send:dismiss", signature),
    onNotice: polled("cloud-send:notice"),
  },
  ...(page === "cloud" ? {
    cloudPlan: { state: async () => ({ status: "paid", tier: "pro" }), manage: async () => {}, useThisComputer: async () => {} },
  } : {
    remoteClient: { active: false },
    environments: { onOpenSettings: () => () => {} },
    cloudAccount: {
      state: async () => account, refresh: async () => account, begin: async () => account, signInAgain: async () => account, reopen: async () => account,
      cancel: async () => account, signOut: async () => account, openDashboard: async () => account, connectHome: async () => account, connectHomeForPhone: async () => account,
      onState: () => () => {},
      lending: { state: async () => ({ state: { enabled: true, connected: true, folders: [], screen: true }, activity: [] }), chooseFolder: async () => null, save: async () => ({}), stop: async () => ({}) },
    },
    cloudMove: {
      state: async () => ({ phase: "idle", local: { bots: 1, rooms: 0, chats: 23, bytes: 0.2 * GB, files: 120 }, suggest: false, blocked: null,
        destination: { id: "cloud", name: "My Cloud", origin: machine.origin, kind: "cloud" },
        cloud: { contents: { bots: 10, rooms: 1, chats: 140 }, empty: false, freeBytes: 14 * GB, previous: null, heldBytes: 0 }, fit: { fit: "now", neededBytes: GB, freeBytes: 14 * GB } }),
      start: async () => ({ phase: "idle" }), cancel: async () => ({ phase: "idle" }), restorePrevious: async () => ({ phase: "idle" }), bring: async () => ({ phase: "idle" }),
      dismiss: async () => ({ phase: "idle" }), onState: () => () => {},
    },
    cloudSend: {
      state: () => call("cloud-send:state"), refresh: () => call("cloud-send:refresh"), send: (options?: unknown) => call("cloud-send:send", options),
      setAuto: (on: boolean) => call("cloud-send:auto", on), setItem: (key: string, on: boolean) => call("cloud-send:item", key, on),
      onState: polled("cloud-send:state"),
    },
    cloudLogins: { state: () => call("cloud-logins:state"), send: (what: unknown) => call("cloud-logins:send", what) },
  }),
} as unknown as typeof window.ogb;

setAnalyticsEnabled(false);
setEmailGateDone("skipped");
try {
  localStorage.setItem("omb-advanced-mode", params.get("advanced") === "1" ? "1" : "0");
  for (const notice of NOTICES) localStorage.setItem(notice, "1");
} catch {}
applySkin((params.get("skin") ?? "midnight") as SkinId);
if (page === "local" && params.get("settings") !== "0" && !params.has("desktop-settings")) {
  history.replaceState(null, "", `${location.pathname}?${new URLSearchParams({ ...Object.fromEntries(params), "desktop-settings": "cloud-settings" })}`);
}
createRoot(document.getElementById("root")!).render(<App />);
