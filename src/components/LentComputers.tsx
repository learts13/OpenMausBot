import { useEffect, useState } from "react";
import { Laptop } from "lucide-react";

import { activeLocale, t } from "@/lib/i18n";
import { localizedRelativeTime } from "@/lib/memory";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

/** A computer lent to this server, now or before (server/shared-computers.ts KnownLentComputer). */
export interface KnownLentComputer {
  id: string;
  name: string;
  platform: "darwin" | "win32" | "linux" | null;
  online: boolean;
  busy: boolean;
  lent: boolean;
  lastSeenAt: number;
  lastUsedAt: number | null;
  scopes: { folders: number; terminal: boolean; screen: boolean };
}

const PLATFORM: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export function lentComputerLines(computer: KnownLentComputer, now = Date.now()): string[] {
  const state = !computer.lent ? t("lending.cloudSide.stopped", { when: localizedRelativeTime(computer.lastSeenAt, activeLocale(), now) })
    : computer.busy ? t("lending.cloudSide.busy")
    : computer.online ? t("lending.cloudSide.online")
    : t("lending.cloudSide.offline", { when: localizedRelativeTime(computer.lastSeenAt, activeLocale(), now) });
  const what = [
    ...(computer.scopes.folders ? [t("lending.cloudSide.folders", { count: String(computer.scopes.folders) })] : []),
    ...(computer.scopes.screen ? [t("lending.cloudSide.screen")] : []),
    ...(computer.scopes.terminal ? [t("lending.cloudSide.terminal")] : []),
  ];
  return [state, ...(computer.lent && what.length ? [t("lending.cloudSide.lends", { what: what.join(", ") })] : []),
    computer.lastUsedAt ? t("lending.cloudSide.lastUsed", { when: localizedRelativeTime(computer.lastUsedAt, activeLocale(), now) }) : t("lending.cloudSide.neverUsed")];
}

/** My Cloud's own page: each computer lent to it, whether it is online or since when not, what it lends and when My
 * Cloud last used it. Changing what is lent happens on that computer, which this opens when the page is in the app. */
export function LentComputersCard() {
  const [known, setKnown] = useState<KnownLentComputer[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api<{ known?: KnownLentComputer[] }>("/api/shared-computers")
      .then((answer) => { if (alive) { setKnown(answer.known ?? []); setFailed(false); } })
      .catch(() => { if (alive) setFailed(true); });
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const manage = window.ogb?.cloudLending;
  return <Card title={t("lending.cloudSide.title")}>
    <div data-lent-computers={known === null ? "loading" : known.length} className="flex flex-col gap-3">
      {failed && <p role="alert" className="text-[13px] text-danger">{t("lending.cloudSide.error")}</p>}
      {known?.length === 0 && <p className="text-[13px] text-ink-secondary">{t("lending.cloudSide.empty")}</p>}
      {!!known?.length && <ul className="divide-y divide-hairline/40">
        {known.map((computer) => <li key={computer.id} data-lent-computer={computer.online ? "online" : computer.lent ? "offline" : "stopped"} className="flex items-start gap-2 py-2.5">
          <Laptop size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-ink">{computer.name}{computer.platform ? <span className="font-normal text-ink-secondary"> · {PLATFORM[computer.platform]}</span> : null}</p>
            {lentComputerLines(computer).map((line) => <p key={line} className="text-[12px] text-ink-secondary">{line}</p>)}
          </div>
        </li>)}
      </ul>}
      {manage && <button type="button" className="ui-button w-fit" onClick={() => void manage.open().catch(() => {})}>{t("lending.cloudSide.manage")}</button>}
    </div>
  </Card>;
}
