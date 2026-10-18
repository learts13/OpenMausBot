export type HandoffWhat = { kind: "1password" } | { kind: "login"; id: string };

/** What of Logins My Cloud has: never a secret. */
export interface CloudLoginsView {
  logins: Array<{ site: string; username: string }>;
  onePassword: { connected: boolean; vaults: string[] };
}
export interface CloudLoginsState {
  /** Null when this computer has no My Cloud. Unreachable when its own session could not read it just now. */
  cloud: null | ({ reachable: true } & CloudLoginsView) | { reachable: false };
}
export interface CloudLoginsSent extends CloudLoginsState {
  sent: true;
  /** A login kept to some bots reached My Cloud for those of them it has. */
  narrowed?: true;
}
export interface CloudLoginsBridge {
  state(): Promise<CloudLoginsState>;
  send(what: HandoffWhat): Promise<CloudLoginsSent>;
}

interface PrivateProcess { postMessage(message: unknown): void }
interface CloudTarget { origin: string; grant(): Promise<{ origin: string; code: string }> }

export function handoffWhat(input: unknown): HandoffWhat | null;
export function botsOnCloud(bots: unknown, cloudBotIds: ReadonlySet<string>): "all" | string[];
export function cloudLoginsView(listed: unknown): CloudLoginsView | null;
export function createLoginHandoffClient(options?: { timeoutMs?: number; randomId?: () => string }): {
  request(proc: PrivateProcess | null | undefined, what: HandoffWhat): Promise<{ onePassword?: { token: string; grants: Record<string, unknown> }; login?: Record<string, unknown> }>;
  receive(proc: unknown, message: unknown): boolean;
};
export function createCloudLogins(deps: {
  handoff(what: HandoffWhat): Promise<{ onePassword?: { token: string; grants: Record<string, unknown> }; login?: Record<string, unknown> }>;
  home(): CloudTarget | null;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  cookieFetch: (url: string, init?: RequestInit) => Promise<Response>;
}): CloudLoginsBridge;
export function registerCloudLoginsIpc(deps: {
  ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void };
  localOnly<T extends (...args: any[]) => unknown>(channel: string, handler: T): T;
  server(): PrivateProcess | null | undefined;
  home(): CloudTarget | null;
  cookieFetch: (url: string, init?: RequestInit) => Promise<Response>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}): { receive(proc: unknown, message: unknown): boolean };
