export type SendKind = "bot" | "skill" | "login" | "1password" | "setting";

export interface SendItem {
  key: string;
  kind: SendKind;
  label: string;
  detail?: string;
  id?: string;
  bot?: string;
  parts: Record<string, string>;
}
export interface SendSummary { v: 1; appVersion: string | null; items: SendItem[] }

export type RowState = "only-here" | "on-both" | "to-update" | "differs" | "removed" | "off";
export interface PlanRow {
  key: string;
  kind: SendKind;
  label: string;
  detail?: string;
  id?: string;
  bot?: string;
  state: RowState;
  parts?: string[];
  differs?: string[];
}
export interface SendPlan {
  rows: PlanRow[];
  cloudOnly: Array<{ key: string; kind: SendKind; label: string; detail?: string; bot?: string }>;
  baseline: Record<string, Record<string, [string, string]>>;
  removed: string[];
}
export type SentRecord = Record<string, Record<string, [string, string]>>;
export type OffReason = "you" | "removed";

export declare const BOT_PARTS: Readonly<Record<string, readonly string[]>>;
export declare const PICTURE_PART: "picture";
export declare const SETTINGS: readonly ["profile", "language"];
export declare const KINDS: readonly SendKind[];
export declare const EMPTY: "-";
export declare const itemKey: Readonly<{
  bot(id: string): string;
  skill(botId: string, name: string): string;
  login(site: string, username: string, exactHost?: string): string;
  onePassword(): string;
  setting(name: string): string;
}>;
export declare function parseSendSummary(value: unknown): SendSummary | null;
export declare function planSend(input: { local: SendSummary | null; cloud: SendSummary | null; sent?: SentRecord; off?: Record<string, OffReason>; force?: string[] }): SendPlan;
export declare function pendingRows(plan: SendPlan): PlanRow[];
export declare function differenceSignature(plan: SendPlan): string;
