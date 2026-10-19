import { useEffect, useRef, useState } from "react";
import { ChevronRight, Cloud, Laptop, Loader2, RefreshCw } from "lucide-react";
import type { PlanRow, RowState } from "../../electron/cloud-send-parts.mjs";
import type { CloudSendBridge, CloudSendOutcome, CloudSendSnapshot } from "../../electron/cloud-send.mjs";
import type { LocaleKey } from "@/locales";
import { detailRows, resultLines, rowName, sideLines, statusLine, type SideKind } from "@/lib/cloud-send";
import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/memory";
import { Card, Switch } from "./SettingsPrimitives";

const KIND_LABEL: Record<SideKind, LocaleKey> = {
  bots: "cloudSend.kind.bots", skills: "cloudSend.kind.skills", logins: "cloudSend.kind.logins", settings: "cloudSend.kind.settings",
};
const ROW_STATE: Record<RowState, LocaleKey> = {
  "only-here": "cloudSend.row.onlyHere", "on-both": "cloudSend.row.onBoth", "to-update": "cloudSend.row.toUpdate",
  differs: "cloudSend.row.differs", removed: "cloudSend.row.removed", off: "cloudSend.row.off",
};

const cleanError = (cause: unknown) => cause instanceof Error && cause.message
  ? cause.message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/u, "") : t("cloudSend.status.unreachable");

/** This computer's side of Send to My Cloud: main's snapshot, a fresh comparison on open, and the actions. */
export function useCloudSend(bridge: CloudSendBridge | undefined) {
  const [snapshot, setSnapshot] = useState<CloudSendSnapshot | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CloudSendOutcome | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!bridge) return;
    const unsubscribe = bridge.onState((next) => { if (alive.current) setSnapshot(next); });
    void bridge.state().then((next) => { if (alive.current) setSnapshot(next); }).catch(() => {});
    setComparing(true);
    void bridge.refresh().then((next) => { if (alive.current) setSnapshot(next); }).catch(() => {}).finally(() => { if (alive.current) setComparing(false); });
    return () => { alive.current = false; unsubscribe(); };
  }, [bridge]);
  const act = async (action: () => Promise<CloudSendSnapshot | CloudSendOutcome>) => {
    setError(null);
    try {
      const result = await action();
      if (!alive.current) return;
      if ("result" in result) setOutcome(result);
      else setSnapshot(result);
    } catch (cause) { if (alive.current) setError(cleanError(cause)); }
  };
  return {
    snapshot, comparing, error, outcome,
    refresh: () => { setComparing(true); void act(() => bridge!.refresh()).finally(() => setComparing(false)); },
    sendAll: () => act(() => bridge!.send()),
    useMine: (key: string) => act(() => bridge!.send({ keys: [key], force: [key] })),
    setAuto: (on: boolean) => act(() => bridge!.setAuto(on)),
    setItem: (key: string, on: boolean) => act(() => bridge!.setItem(key, on)),
  };
}

function SideBySide({ snapshot }: { snapshot: CloudSendSnapshot }) {
  const lines = sideLines(snapshot);
  return <table data-cloud-send-sides className="w-full table-fixed border-separate border-spacing-0 text-[13px]">
    <thead>
      <tr className="text-left text-[12px] text-ink-secondary">
        <th scope="col" className="w-[22%] pb-2 font-normal"><span className="sr-only">{t("cloudSend.details")}</span></th>
        <th scope="col" className="w-[19%] pb-2 font-medium"><span className="inline-flex items-center gap-1.5"><Laptop size={13} aria-hidden="true" />{t("cloudSend.colHere")}</span></th>
        <th scope="col" className="w-[19%] pb-2 font-medium"><span className="inline-flex items-center gap-1.5"><Cloud size={13} aria-hidden="true" />{t("cloudSend.colCloud")}</span></th>
        <th scope="col" className="pb-2 font-normal"><span className="sr-only">{t("cloudSend.diff.same")}</span></th>
      </tr>
    </thead>
    <tbody>
      {lines.map((line) => <tr key={line.kind} data-cloud-send-kind={line.kind} data-waiting={line.waiting || undefined}>
        <th scope="row" className="border-t border-hairline/30 py-2 pe-2 text-left font-medium text-ink">{t(KIND_LABEL[line.kind])}</th>
        <td className="border-t border-hairline/30 py-2 pe-2 tabular-nums text-ink">{line.kind === "settings" ? t("cloudSend.settingsCount") : line.here}</td>
        <td className="border-t border-hairline/30 py-2 pe-2 tabular-nums text-ink">{line.kind === "settings" ? t("cloudSend.settingsCount") : line.cloud}</td>
        <td className={`border-t border-hairline/30 py-2 text-[12.5px] ${line.waiting ? "font-medium text-accent-text" : "text-ink-secondary"}`}>{line.difference}</td>
      </tr>)}
    </tbody>
  </table>;
}

function ItemRow({ row, onItem, onUseMine, busy }: { row: PlanRow; onItem(key: string, on: boolean): void; onUseMine(key: string): void; busy: boolean }) {
  const name = row.kind === "skill" ? row.label : rowName(row);
  const on = row.state !== "off" && row.state !== "removed";
  return <li data-cloud-send-row={row.key} data-state={row.state} className={`flex items-center gap-3 py-2 ${row.kind === "skill" ? "ps-6" : ""}`}>
    <div className="min-w-0 flex-1">
      <div dir="auto" className="truncate text-[13px] text-ink">{name}</div>
      <div className={`text-[11.5px] ${row.state === "only-here" || row.state === "to-update" ? "text-accent-text" : "text-ink-tertiary"}`}>{t(ROW_STATE[row.state])}</div>
    </div>
    {row.state === "differs" && <button type="button" className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
      disabled={busy} onClick={() => onUseMine(row.key)}>{t("cloudSend.row.useMine")}</button>}
    {row.kind !== "skill" && <Switch checked={on} disabled={busy} aria-label={t("cloudSend.row.also", { name })} onClick={() => onItem(row.key, !on)} />}
  </li>;
}

/** Settings → MausBot Cloud, first: what each side has, Send everything, and Keep My Cloud up to date. */
export function CloudSendCard() {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudSend;
  const send = useCloudSend(bridge);
  const [open, setOpen] = useState(false);
  const { snapshot } = send;
  if (!bridge || !snapshot || snapshot.cloud === "none") return null;
  const ready = snapshot.cloud === "ready";
  const running = Boolean(snapshot.running);
  const status = statusLine(snapshot, send.comparing);
  const last = send.outcome ?? snapshot.last;
  const shown = last ? resultLines(last) : null;
  const progress = snapshot.running?.progress;
  const rows = detailRows(snapshot.rows);
  return <Card title={t("cloudSend.title")} subtitle={t("cloudSend.intro")}>
    <div data-cloud-send={snapshot.cloud} data-running={running || undefined} className="flex flex-col gap-4">
      {status && <div className="flex flex-wrap items-center gap-2">
        <p role="status" className={status.tone === "status" ? "text-[13px] text-ink-secondary" : "text-[13px] text-ink"}>{status.text}</p>
        {!ready && !send.comparing && <button type="button" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-text underline underline-offset-2 hover:text-ink" onClick={send.refresh}>
          <RefreshCw size={12} aria-hidden="true" />{t("cloudSend.check")}</button>}
      </div>}
      {ready && <SideBySide snapshot={snapshot} />}
      <div className="flex flex-col items-start gap-2">
        <button type="button" data-cloud-send-all className="ui-button ui-button-primary inline-flex items-center gap-2" disabled={!ready || running} onClick={() => void send.sendAll()}>
          {running && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {running ? t("cloudSend.sending") : t("cloudSend.send")}
          {running && progress && <span className="tabular-nums opacity-80">{t("cloudSend.progress", progress)}</span>}
        </button>
        {send.error && <p role="alert" className="text-[13px] text-danger">{send.error}</p>}
        {shown && !running && <div data-cloud-send-result className="flex flex-col gap-1">
          <p role={shown.failed ? "alert" : "status"} className={shown.failed ? "text-[13px] text-danger" : "text-[13px] text-ink"}>{shown.text}</p>
          {shown.notes.map((note) => <p key={note} className="text-[12px] text-ink-secondary">{note}</p>)}
          {last && <p className="text-[12px] text-ink-tertiary">{t(last.reason === "auto" ? "cloudSend.result.auto" : "cloudSend.result.when", { when: localizedRelativeTime(last.at, activeLocale()) })}</p>}
        </div>}
      </div>
      <div className="flex items-start justify-between gap-4 rounded-lg bg-raised/60 p-3">
        <div className="min-w-0">
          <div id="cloud-send-auto" className="text-[13px] font-medium text-ink">{t("cloudSend.auto")}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("cloudSend.autoHelp")}</p>
        </div>
        <Switch checked={snapshot.auto} aria-labelledby="cloud-send-auto" data-cloud-send-auto onClick={() => void send.setAuto(!snapshot.auto)} />
      </div>
      <p className="text-[12px] leading-relaxed text-ink-secondary" data-cloud-send-separate>{t("cloudSend.separate")}</p>
      {ready && rows.length > 0 && <div>
        <button type="button" aria-expanded={open} className="inline-flex items-center gap-1 text-[13px] font-medium text-ink hover:text-accent-text" onClick={() => setOpen(!open)}>
          <ChevronRight size={14} aria-hidden="true" className={open ? "rotate-90 transition-transform" : "transition-transform"} />{t("cloudSend.details")}
        </button>
        {open && <ul data-cloud-send-rows className="mt-1 divide-y divide-hairline/30">
          {rows.map((row) => <ItemRow key={row.key} row={row} busy={running} onItem={(key, on) => void send.setItem(key, on)} onUseMine={(key) => void send.useMine(key)} />)}
        </ul>}
      </div>}
    </div>
  </Card>;
}
