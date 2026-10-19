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

export function handoffWhat(input: unknown): HandoffWhat | null;
export function botsOnCloud(bots: unknown, cloudBotIds: ReadonlySet<string>): "all" | string[];
export function createLoginHandoffClient(options?: { timeoutMs?: number; randomId?: () => string }): {
  request(proc: PrivateProcess | null | undefined, what: HandoffWhat): Promise<{ onePassword?: { token: string; grants: Record<string, unknown> }; login?: Record<string, unknown> }>;
  receive(proc: unknown, message: unknown): boolean;
};
