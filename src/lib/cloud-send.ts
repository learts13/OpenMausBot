// What Settings → MausBot Cloud and My Cloud's strip say about Send to My Cloud (electron/cloud-send.mjs), in words.
import type { PlanRow, RowState, SendKind } from "../../electron/cloud-send-parts.mjs";
import type { CloudSendNotice, CloudSendOutcome, CloudSendSnapshot } from "../../electron/cloud-send.mjs";
import type { LocaleKey } from "@/locales";
import { activeLocale, t } from "@/lib/i18n";

export type SideKind = "bots" | "skills" | "logins" | "settings";
export const SIDE_KINDS: readonly SideKind[] = ["bots", "skills", "logins", "settings"];

const KIND_OF: Record<SendKind, SideKind> = { bot: "bots", skill: "skills", login: "logins", "1password": "logins", setting: "settings" };
const ON_CLOUD = new Set<RowState>(["on-both", "to-update", "differs"]);

const counted = (count: number, one: LocaleKey, many: LocaleKey) => t(count === 1 ? one : many, { count });

export const listOf = (parts: string[]) => new Intl.ListFormat(activeLocale(), { type: "conjunction" }).format(parts);

/** "Ember", "Ember and Juno", "Ember, Juno and 2 more". */
export function names(labels: string[], shown = 2): string {
  if (labels.length <= shown + 1) return listOf(labels);
  return listOf([...labels.slice(0, shown), t("cloudSend.more", { count: labels.length - shown })]);
}

export const rowName = (row: { kind: SendKind; label: string; detail?: string }) =>
  row.kind === "setting" ? t(row.label === "profile" ? "cloudSend.row.profile" : "cloudSend.row.language")
    : row.kind === "login" && row.detail ? `${row.detail} · ${row.label}` : row.label;

/** Bots by name ("Miso and 9 more"), skills by name while few, logins by count with 1Password named. */
function whatOf(kind: SideKind, rows: ReadonlyArray<{ kind: SendKind; label: string; detail?: string }>): string {
  if (kind === "bots") return names(rows.map(rowName), 1);
  if (kind === "skills") return rows.length <= 2 ? listOf(rows.map(rowName)) : counted(rows.length, "cloudSend.list.skillOne", "cloudSend.list.skills");
  const logins = rows.filter((row) => row.kind === "login").length;
  return listOf([...(logins ? [counted(logins, "cloudSend.list.loginOne", "cloudSend.list.logins")] : []), ...(rows.some((row) => row.kind === "1password") ? [t("cloudSend.list.onePassword")] : [])]);
}

export interface SideLine {
  kind: SideKind;
  here: number;
  cloud: number;
  /** One plain phrase on how the two differ, or "Same on both". */
  difference: string;
  /** Something here is waiting to go. */
  waiting: boolean;
}

/** Counts per kind on each side, and the difference in words ("Ember only here", "1Password only here"). */
export function sideLines(snapshot: Pick<CloudSendSnapshot, "rows" | "cloudOnly">): SideLine[] {
  return SIDE_KINDS.map((kind) => {
    const rows = snapshot.rows.filter((row) => KIND_OF[row.kind] === kind);
    const theirs = snapshot.cloudOnly.filter((row) => KIND_OF[row.kind] === kind);
    const onlyHere = rows.filter((row) => row.state === "only-here");
    const newer = rows.filter((row) => row.state === "to-update");
    const differs = rows.filter((row) => row.state === "differs");
    const here = kind === "settings" ? rows.filter((row) => row.state !== "off").length : rows.length;
    const cloud = rows.filter((row) => ON_CLOUD.has(row.state)).length + theirs.length;
    const phrases: string[] = [];
    if (onlyHere.length) phrases.push(t("cloudSend.diff.onlyHere", { names: whatOf(kind, onlyHere) }));
    if (newer.length) phrases.push(t("cloudSend.diff.changed", { names: kind === "settings" ? listOf(newer.map(rowName)) : whatOf(kind, newer) }));
    if (differs.length) phrases.push(t("cloudSend.diff.differs", { count: differs.length }));
    if (theirs.length && kind !== "settings") phrases.push(t("cloudSend.diff.onlyThere", { names: whatOf(kind, theirs) }));
    return { kind, here, cloud: kind === "settings" ? Math.min(cloud, here) : cloud, difference: phrases.length ? phrases.join(" · ") : t("cloudSend.diff.same"),
      waiting: onlyHere.length + newer.length > 0 };
  });
}

/** "Ember, 2 skills, 3 logins and 1Password". */
export function sentList(result: CloudSendOutcome["result"]): string[] {
  return [
    ...result.bots,
    ...(result.updatedBots.length ? [t("cloudSend.list.changesTo", { names: names(result.updatedBots) })] : []),
    ...(result.skills ? [counted(result.skills, "cloudSend.list.skillOne", "cloudSend.list.skills")] : []),
    ...(result.logins ? [counted(result.logins, "cloudSend.list.loginOne", "cloudSend.list.logins")] : []),
    ...(result.onePassword ? [t("cloudSend.list.onePassword")] : []),
    ...(result.settings.length ? [t("cloudSend.list.settings")] : []),
  ];
}

/** One sentence for what a send did, then a line for each thing worth knowing. */
export function resultLines(outcome: CloudSendOutcome): { text: string; failed: boolean; notes: string[] } {
  const { result } = outcome;
  const sent = sentList(result);
  const first = result.failed[0];
  const text = [
    sent.length ? t("cloudSend.result.sent", { list: listOf(sent) }) : result.failed.length ? "" : t("cloudSend.result.none"),
    first ? t(result.failed.length === 1 ? "cloudSend.result.failedOne" : "cloudSend.result.failed", { count: result.failed.length, name: first.label, error: first.error }) : "",
  ].filter(Boolean).join(" ");
  const notes = [...new Set(result.notes.map((note) =>
    note.kind === "model" ? t("cloudSend.result.model", { bot: note.bot ?? "" })
      : note.kind === "settings" ? t("cloudSend.result.settings", { bot: note.bot ?? "" })
        : note.kind === "memory" ? t("cloudSend.result.memory", { bot: note.bot ?? "" })
          : t("cloudSend.result.narrowed")))];
  return { text, failed: result.failed.length > 0, notes };
}

/** The status line at the top: online and its version, or why it can't compare now. */
export function statusLine(snapshot: CloudSendSnapshot, comparing: boolean): { text: string; tone: "status" | "note" } | null {
  if (snapshot.cloud === "none") return null;
  if (snapshot.cloud === "ready") {
    const older = snapshot.cloudVersion && snapshot.localVersion && olderVersion(snapshot.cloudVersion, snapshot.localVersion);
    return older ? { text: t("cloudSend.status.older", { cloud: snapshot.cloudVersion!, local: snapshot.localVersion! }), tone: "note" }
      : { text: t("cloudSend.status.ready", { version: snapshot.cloudVersion ?? "" }), tone: "status" };
  }
  if (comparing) return { text: t("cloudSend.status.checking"), tone: "status" };
  const key: Record<string, LocaleKey> = {
    asleep: "cloudSend.status.asleep", unreachable: "cloudSend.status.unreachable", outdated: "cloudSend.status.outdated",
    "signed-out": "cloudSend.status.signedOut", "local-unavailable": "cloudSend.status.local",
  };
  return { text: t(key[snapshot.cloud] ?? "cloudSend.status.unreachable"), tone: "note" };
}

function olderVersion(a: string, b: string): boolean {
  const [left, right] = [a, b].map((version) => /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number));
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! < right[i]!;
  return false;
}

/** My Cloud's strip: "Ember, 2 skills and 1Password are on This computer but not here." Null when nothing waits. */
export function noticeLine(notice: CloudSendNotice): { text: string; one: boolean } | null {
  const missing = [
    ...notice.bots,
    ...(notice.skills ? [counted(notice.skills, "cloudSend.list.skillOne", "cloudSend.list.skills")] : []),
    ...(notice.logins ? [counted(notice.logins, "cloudSend.list.loginOne", "cloudSend.list.logins")] : []),
    ...(notice.onePassword ? [t("cloudSend.list.onePassword")] : []),
  ];
  const newer = [
    ...(notice.updatedBots.length ? [t("cloudSend.list.changesTo", { names: names(notice.updatedBots) })] : []),
    ...(notice.settings ? [t("cloudSend.list.settings")] : []),
  ];
  if (missing.length) {
    const one = notice.bots.length + notice.skills + notice.logins + (notice.onePassword ? 1 : 0) === 1 && !newer.length;
    return { text: t(one ? "cloudSend.strip.missingOne" : "cloudSend.strip.missing", { list: listOf([...missing, ...newer]) }), one };
  }
  if (newer.length) return { text: t("cloudSend.strip.newer", { list: listOf(newer) }), one: false };
  return null;
}

/** The rows the details list shows, grouped: bots with their skills under them, then logins, then settings. */
export function detailRows(rows: PlanRow[]): PlanRow[] {
  const order: Record<SendKind, number> = { bot: 0, skill: 0, login: 1, "1password": 1, setting: 2 };
  const bots = new Map(rows.filter((row) => row.kind === "bot").map((row, index) => [row.id ?? row.key, index]));
  return [...rows].sort((a, b) => order[a.kind] - order[b.kind]
    || (bots.get(a.kind === "bot" ? a.id ?? a.key : a.bot ?? "") ?? 0) - (bots.get(b.kind === "bot" ? b.id ?? b.key : b.bot ?? "") ?? 0)
    || (a.kind === "bot" ? -1 : 0) - (b.kind === "bot" ? -1 : 0));
}
