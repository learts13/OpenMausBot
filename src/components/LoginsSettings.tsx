import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Cloud, KeyRound, Loader2, LockKeyhole, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import type { CloudLoginsState } from "../../electron/cloud-logins.mjs";
import type { LoginBots, LoginSummary, OnePasswordStatus, OnePasswordVault } from "../../shared/logins";
import { t } from "@/lib/i18n";
import { addLogin, changeLogin, connectOnePassword, deleteLogin, disconnectOnePassword, grantVault, listLogins, refreshOnePassword } from "@/lib/logins";
import { relativeTime } from "@/lib/memory";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore } from "@/state/store";
import { LoginBotPicker, LoginForm } from "./LoginForm";
import { Card } from "./SettingsPrimitives";

// Security: a row never shows the password, which no route returns.

const SOURCE_KEYS = {
  card: "settings.logins.source.card",
  settings: "settings.logins.source.settings",
  "1password": "settings.logins.source.1password",
} as const;

const ROW_BUTTON = "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

type CloudSide = CloudLoginsState["cloud"];
type SendWhat = { kind: "1password" } | { kind: "login"; id: string };

/** The same account on My Cloud: one username on one site, as the Cloud's own Logins counts it. */
export function loginOnCloud(cloud: CloudSide, login: Pick<LoginSummary, "site" | "username">): boolean | null {
  if (!cloud) return null;
  if (!cloud.reachable) return null;
  return cloud.logins.some((entry) => entry.site === login.site && entry.username.toLowerCase() === login.username.toLowerCase());
}

/** This computer's Settings with a My Cloud: what Logins the Cloud has, and Also use on My Cloud. Bots, chats, skills and
 * logins live on each side; a login goes over only when the person sends it, straight to their own Cloud. */
function useCloudLogins() {
  const bridge = window.ogb?.cloudLogins;
  const [cloud, setCloud] = useState<CloudSide>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ id: string; text: string; failed?: boolean } | null>(null);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    try { setCloud((await bridge.state()).cloud); } catch { setCloud(null); }
  }, [bridge]);
  useEffect(() => { void refresh(); }, [refresh]);
  const send = async (what: SendWhat) => {
    if (!bridge || sending) return;
    const id = what.kind === "login" ? what.id : "1password";
    setSending(id);
    setOutcome(null);
    try {
      const sent = await bridge.send(what);
      setCloud(sent.cloud);
      setOutcome({ id, text: t(sent.narrowed ? "settings.logins.sentNarrowed" : "settings.logins.sent") });
    } catch (cause) {
      setOutcome({ id, failed: true, text: cause instanceof Error && cause.message ? cause.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/u, "") : t("settings.logins.sendError") });
    } finally { setSending(null); }
  };
  return { available: Boolean(bridge) && cloud !== null, cloud, sending, outcome, send };
}

function CloudOutcome({ id, outcome, inset = false }: { id: string; outcome: { id: string; text: string; failed?: boolean } | null; inset?: boolean }) {
  if (outcome?.id !== id) return null;
  return <p role={outcome.failed ? "alert" : "status"} data-cloud-outcome={id}
    className={`${inset ? "ms-6 " : ""}text-[12px] ${outcome.failed ? "text-danger" : "text-ink-secondary"}`}>{outcome.text}</p>;
}

export function LoginsSettings() {
  const { state } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const bots = state.bots.map((bot) => ({ id: bot.id, name: bot.name }));
  const [logins, setLogins] = useState<LoginSummary[] | null>(null);
  const [onePassword, setOnePassword] = useState<OnePasswordStatus>({ connected: false });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [site, setSite] = useState("");
  const [addBots, setAddBots] = useState<LoginBots>("all");
  const [addExact, setAddExact] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBots, setEditBots] = useState<LoginBots>("all");
  const [editExact, setEditExact] = useState(false);
  const [removeTotp, setRemoveTotp] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cloudSide = useCloudLogins();
  const where = (onCloud: boolean | null) => !cloudSide.available ? null
    : t(onCloud === null ? "settings.logins.where.unknown" : onCloud ? "settings.logins.where.both" : "settings.logins.where.here");

  const load = async () => {
    try {
      const answer = await listLogins();
      setLogins(answer.logins);
      setOnePassword(answer.onePassword ?? { connected: false });
      setError(null);
    }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.loadError")); }
  };
  useEffect(() => { if (ownerOrAdmin) void load(); }, [ownerOrAdmin]);

  if (ownerOrAdmin === false) {
    return <Card title={t("settings.logins.title")} subtitle={t("settings.logins.adminOnly")} />;
  }

  const botNames = (value: LoginBots) => {
    if (value === "all") return t("settings.logins.allBots");
    const names = value.flatMap((id) => bots.find((bot) => bot.id === id)?.name ?? []);
    return names.length ? names.join(", ") : t("settings.logins.noBots");
  };
  const startEdit = (login: LoginSummary) => {
    setAdding(false);
    setDeleting(null);
    setRemoveTotp(false);
    setEditBots(login.bots);
    setEditExact(login.exactHost);
    setEditing(login.id);
  };
  const remove = async (id: string) => {
    if (deleting !== id) { setDeleting(id); return; }
    setBusy(true);
    try { await deleteLogin(id); setDeleting(null); await load(); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.deleteError")); }
    finally { setBusy(false); }
  };

  return (
    <Card title={t("settings.logins.title")} subtitle={t("settings.logins.subtitle")}>
      <div className="flex flex-col gap-3" aria-busy={logins === null || busy}>
        {cloudSide.available && <p className="text-[12px] leading-relaxed text-ink-secondary" data-logins-sides>{t("settings.logins.eachSide")}</p>}
        {state.config?.cloudHome === true && <p className="text-[12px] leading-relaxed text-ink-secondary" data-logins-cloud-own>{t("settings.logins.cloudOwn")}</p>}
        {logins === null && !error && <p className="text-[12px] text-ink-secondary">{t("settings.logins.loading")}</p>}
        {logins?.length === 0 && !adding && <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.logins.empty")}</p>}
        {!!logins?.length && (
          <ul className="divide-y divide-hairline/30" data-logins-list>
            {logins.map((login) => (
              <li key={login.id} className="flex flex-col gap-2 py-2.5" data-login-row={login.site}>
                <div className="flex min-w-0 items-start gap-2">
                  <KeyRound size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-ink-tertiary" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span dir="ltr" className="truncate text-[13px] font-medium text-ink" title={login.site}>{login.site}</span>
                      {login.hasTotp && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-ink/[0.07] px-1.5 text-[11px] text-ink-secondary">
                          <ShieldCheck size={11} aria-hidden="true" />{t("settings.logins.twoFactor")}
                        </span>
                      )}
                    </div>
                    <div dir="auto" className="truncate text-[12px] text-ink-secondary">{login.username || t("settings.logins.noUsername")}</div>
                    {signInHostsLine(login) && <div dir="ltr" className="truncate text-[11.5px] text-ink-tertiary" data-login-hosts>{signInHostsLine(login)}</div>}
                    <div className="mt-0.5 text-[11.5px] leading-snug text-ink-tertiary">
                      {[t(SOURCE_KEYS[login.source]), botNames(login.bots),
                        login.lastUsedAt ? t("settings.logins.used", { when: relativeTime(login.lastUsedAt) }) : t("settings.logins.neverUsed")].join(" · ")}
                    </div>
                    {login.source !== "1password" && where(loginOnCloud(cloudSide.cloud, login)) && (
                      <div className="text-[11.5px] leading-snug text-ink-tertiary" data-login-where={loginOnCloud(cloudSide.cloud, login) ? "both" : "here"}>{where(loginOnCloud(cloudSide.cloud, login))}</div>
                    )}
                  </div>
                  {login.source !== "1password" && (
                    <div className="flex shrink-0 gap-1">
                      {cloudSide.available && loginOnCloud(cloudSide.cloud, login) !== true && (
                        <button type="button" className={ROW_BUTTON} disabled={busy || cloudSide.sending !== null} onClick={() => void cloudSide.send({ kind: "login", id: login.id })}
                          aria-label={t("settings.logins.alsoCloudFor", { site: login.site })} data-also-cloud={login.id}>
                          {cloudSide.sending === login.id ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />}{t("settings.logins.alsoCloud")}
                        </button>
                      )}
                      <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => startEdit(login)}
                        aria-label={t("settings.logins.changeFor", { site: login.site })}>{t("settings.logins.change")}</button>
                      <button type="button" className={ROW_BUTTON} disabled={busy} onClick={() => void remove(login.id)}
                        aria-label={deleting === login.id ? t("settings.logins.deleteConfirm") : t("settings.logins.deleteFor", { site: login.site })}>
                        <Trash2 size={13} />{deleting === login.id ? t("settings.logins.deleteConfirm") : t("settings.logins.delete")}
                      </button>
                    </div>
                  )}
                </div>
                <CloudOutcome id={login.id} outcome={cloudSide.outcome} inset />
                {editing === login.id && (
                  <div className="ms-6 rounded-lg bg-inset/60 p-3">
                    <LoginForm username={false} replacing submitLabel={t("settings.logins.saveChange")} autoFocus
                      onCancel={() => setEditing(null)}
                      onSubmit={async (fields) => {
                        await changeLogin(login.id, { password: fields.password, totp: fields.totp, removeTotp, bots: editBots, ...(editExact === login.exactHost ? {} : { exactHost: editExact }) });
                        setEditing(null);
                        await load();
                      }}>
                      {login.hasTotp && (
                        <label className="flex items-center gap-2 text-[12.5px] text-ink">
                          <input type="checkbox" checked={removeTotp} onChange={(event) => setRemoveTotp(event.target.checked)} />
                          {t("settings.logins.removeTotp")}
                        </label>
                      )}
                      <ExactHostChoice checked={editExact} onChange={setEditExact}
                        label={t("settings.logins.exactHostFor", { hosts: login.hosts.join(", "), site: login.site })} />
                      <LoginBotPicker value={editBots} onChange={setEditBots} bots={bots} />
                    </LoginForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <div className="rounded-lg bg-inset/60 p-3">
            <LoginForm site={{ value: site, onChange: setSite }} submitLabel={t("settings.logins.save")} autoFocus
              onCancel={() => setAdding(false)}
              onSubmit={async (fields) => {
                await addLogin(site, fields, addBots, addExact);
                setAdding(false);
                setSite("");
                setAddBots("all");
                setAddExact(false);
                await load();
              }}>
              <ExactHostChoice checked={addExact} onChange={setAddExact} label={t("settings.logins.exactHost")} />
              <LoginBotPicker value={addBots} onChange={setAddBots} bots={bots} />
            </LoginForm>
          </div>
        ) : (
          <button type="button" className="ui-button ui-button-md self-start" disabled={logins === null}
            onClick={() => { setEditing(null); setDeleting(null); setAdding(true); }}>
            <Plus size={14} />{t("settings.logins.add")}
          </button>
        )}
        <p className="text-[11.5px] leading-relaxed text-ink-tertiary">{t("settings.logins.limits")}</p>
        {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
        <OnePasswordConnection status={onePassword} disabled={logins === null} bots={bots} botNames={botNames}
          onChange={async (next) => { setOnePassword(next); await load(); }} cloud={cloudSide} where={where} />
      </div>
    </Card>
  );
}

/** Where a login signs in beyond its site's own pages, or that it is kept to those hosts. */
function signInHostsLine(login: LoginSummary): string | null {
  if (login.exactHost) return t("settings.logins.onlyOn", { hosts: login.hosts.join(", ") });
  const elsewhere = login.hosts.filter((host) => host !== login.site);
  return elsewhere.length ? t("settings.logins.signsInOn", { hosts: elsewhere.join(", ") }) : null;
}

function ExactHostChoice({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex items-start gap-2 text-[12.5px] leading-snug text-ink">
      <input type="checkbox" name="exactHost" className="mt-[2px]" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function VaultAccess({ vault, bots, botNames, disabled, onChange }: {
  vault: OnePasswordVault;
  bots: ReadonlyArray<{ id: string; name: string }>;
  botNames: (value: LoginBots) => string;
  disabled: boolean;
  onChange: (status: OnePasswordStatus) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<LoginBots>(vault.bots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try { await onChange(await grantVault(vault.id, value)); setEditing(false); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.onePassword.error")); }
    finally { setBusy(false); }
  };
  return (
    <li className="flex flex-col gap-2 py-2" data-vault={vault.title}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-ink">{vault.title}</div>
          <div className="text-[11.5px] text-ink-tertiary">{t("settings.logins.onePassword.vaultUse", { count: String(vault.items), who: botNames(vault.bots) })}</div>
        </div>
        {!editing && (
          <button type="button" className={ROW_BUTTON} disabled={disabled || busy} onClick={() => { setValue(vault.bots); setEditing(true); }}
            aria-label={t("settings.logins.onePassword.changeVault", { vault: vault.title })}>{t("settings.logins.change")}</button>
        )}
      </div>
      {editing && (
        <div className="flex flex-col gap-2 rounded-lg bg-inset/60 p-3">
          <LoginBotPicker value={value} onChange={setValue} bots={bots} disabled={busy} />
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="ui-button ui-button-md" disabled={busy} onClick={() => setEditing(false)}>{t("logins.cancel")}</button>
            <button type="button" className="ui-button ui-button-md ui-button-primary" disabled={busy} onClick={() => void save()}>{t("settings.logins.saveChange")}</button>
          </div>
        </div>
      )}
    </li>
  );
}

function OnePasswordConnection({ status, disabled, bots, botNames, onChange, cloud, where }: {
  status: OnePasswordStatus;
  disabled: boolean;
  bots: ReadonlyArray<{ id: string; name: string }>;
  botNames: (value: LoginBots) => string;
  onChange: (status: OnePasswordStatus) => Promise<void>;
  cloud: ReturnType<typeof useCloudLogins>;
  where: (onCloud: boolean | null) => string | null;
}) {
  const onCloud = !cloud.cloud ? null : cloud.cloud.reachable ? cloud.cloud.onePassword.connected : null;
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"connect" | "refresh" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<OnePasswordStatus>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try { await onChange(await work()); if (kind === "connect") setToken(""); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : t("settings.logins.onePassword.error")); }
    finally { setBusy(null); }
  };
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) void run("connect", () => connectOnePassword(token.trim()));
  };
  return (
    <section className="mt-1 flex flex-col gap-2 border-t border-hairline/30 pt-3" aria-label={t("settings.logins.onePassword.title")} data-onepassword>
      <div className="text-[13px] font-medium text-ink">{t("settings.logins.onePassword.title")}</div>
      {status.connected ? (
        <>
          <p className="text-[12.5px] leading-snug text-ink-secondary">
            {t("settings.logins.onePassword.connected", { vaults: (status.vaults ?? []).map((vault) => vault.title).join(", ") || "—", count: String(status.items ?? 0) })}
          </p>
          {status.error && <p role="alert" className="text-[12px] text-danger">{status.error}</p>}
          {where(onCloud) && <p className="text-[12px] text-ink-secondary" data-onepassword-where={onCloud ? "both" : "here"}>{where(onCloud)}</p>}
          {!!status.vaults?.length && (
            <ul className="divide-y divide-hairline/30" aria-label={t("settings.logins.onePassword.vaults")}>
              {status.vaults.map((vault) => <VaultAccess key={vault.id} vault={vault} bots={bots} botNames={botNames} disabled={disabled} onChange={onChange} />)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ui-button ui-button-md" disabled={disabled || busy !== null} onClick={() => void run("refresh", refreshOnePassword)}>
              {busy === "refresh" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}{t("settings.logins.onePassword.refresh")}
            </button>
            <button type="button" className="ui-button ui-button-md" disabled={disabled || busy !== null} onClick={() => void run("disconnect", disconnectOnePassword)}>
              {t("settings.logins.onePassword.disconnect")}
            </button>
            {cloud.available && onCloud !== true && (
              <button type="button" className="ui-button ui-button-md" disabled={disabled || busy !== null || cloud.sending !== null} onClick={() => void cloud.send({ kind: "1password" })} data-also-cloud="1password">
                {cloud.sending === "1password" ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />}{t("settings.logins.alsoCloud")}
              </button>
            )}
          </div>
          <CloudOutcome id="1password" outcome={cloud.outcome} />
        </>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={connect}>
          <p className="text-[12px] leading-relaxed text-ink-secondary">{t("settings.logins.onePassword.guide")}</p>
          <div className="flex flex-wrap gap-2">
            <input name="onePasswordToken" type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={token}
              onChange={(event) => setToken(event.target.value)} disabled={disabled || busy !== null}
              aria-label={t("settings.logins.onePassword.token")} placeholder={t("settings.logins.onePassword.token")}
              className="min-w-0 flex-1 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60" />
            <button type="submit" className="ui-button ui-button-md ui-button-primary" disabled={disabled || busy !== null || !token.trim()}>
              {busy === "connect" && <Loader2 size={13} className="animate-spin" />}{t("settings.logins.onePassword.connect")}
            </button>
          </div>
        </form>
      )}
      <p className="flex items-start gap-1 text-[11.5px] leading-snug text-ink-tertiary">
        <LockKeyhole size={11} aria-hidden="true" className="mt-[3px] shrink-0" /> {t("settings.logins.onePassword.note")}
      </p>
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    </section>
  );
}
