// "Also use on My Cloud": one login from this computer, sent to the person's own Cloud and nowhere else.
//
// The secret leaves this computer's server only over Electron's private utility-process port (server/login-handoff.ts),
// and reaches the Cloud over a pairing made for this one send, as Copy this computer to My Cloud does: the Admin mints
// a one-time code for the Cloud it verified, main redeems it at that Cloud alone, posts to the Cloud's own Logins routes
// and signs out. It never passes through a page, a chat, a bot or a log, and nothing here keeps it. What the Cloud
// already has is read with the window's own Cloud session, and never includes a secret (no Logins route returns one).
import { randomUUID } from "node:crypto";

const REQUEST = "openmausbot:login-handoff";
const RESULT = "openmausbot:login-handoff-result";
const LOGIN_ID = /^[\w-]{1,128}$/;
const VAULT_ID = /^[\w-]{1,128}$/;

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = value => (typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null);

/** Only "1password" or one saved login, by id: a page never names a destination, a field or a value. */
export function handoffWhat(input) {
  if (record(input) && input.kind === "1password") return { kind: "1password" };
  if (record(input) && input.kind === "login" && typeof input.id === "string" && LOGIN_ID.test(input.id)) return { kind: "login", id: input.id };
  return null;
}

/** Main's half of the private ask: each answer is taken only from the server process it was asked of. */
export function createLoginHandoffClient({ timeoutMs = 10_000, randomId = randomUUID } = {}) {
  const pending = new Map();
  const settle = (requestId, action) => {
    const waiting = pending.get(requestId);
    if (!waiting) return;
    pending.delete(requestId);
    clearTimeout(waiting.timer);
    action(waiting);
  };
  return {
    request(proc, what) {
      if (!proc) return Promise.reject(new Error("OpenMausBot on this computer is not running. Try again in a moment."));
      const requestId = randomId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(requestId, () => reject(new Error("OpenMausBot on this computer did not answer. Try again."))), timeoutMs);
        timer.unref?.();
        pending.set(requestId, { proc, resolve, reject, timer });
        try { proc.postMessage({ type: REQUEST, requestId, what }); }
        catch { settle(requestId, () => reject(new Error("OpenMausBot on this computer could not be asked. Try again."))); }
      });
    },
    /** True for a handoff answer, kept or ignored; never logs or throws with what it carried. */
    receive(proc, message) {
      if (!record(message) || message.type !== RESULT) return false;
      const waiting = typeof message.requestId === "string" ? pending.get(message.requestId) : undefined;
      if (!waiting || waiting.proc !== proc) return true;
      settle(message.requestId, ({ resolve, reject }) => {
        if (message.ok === true && (record(message.onePassword) || record(message.login))) resolve(message);
        else reject(new Error(sentence(message.error) ?? "OpenMausBot on this computer could not read that login."));
      });
      return true;
    },
  };
}

/** A login kept to some bots keeps only those that exist on the Cloud too: a send never opens a login to more bots. */
export function botsOnCloud(bots, cloudBotIds) {
  if (bots === "all") return "all";
  return Array.isArray(bots) ? bots.filter(id => cloudBotIds.has(id)) : [];
}

/** What My Cloud has, in the shape the Logins page compares against: never a secret. */
export function cloudLoginsView(listed) {
  if (!record(listed) || !Array.isArray(listed.logins)) return null;
  const onePassword = record(listed.onePassword) ? listed.onePassword : {};
  return {
    logins: listed.logins.filter(login => record(login) && login.source !== "1password" && typeof login.site === "string")
      .map(login => ({ site: login.site, username: typeof login.username === "string" ? login.username : "" })),
    onePassword: {
      connected: onePassword.connected === true,
      vaults: Array.isArray(onePassword.vaults) ? onePassword.vaults.flatMap(vault => (record(vault) && typeof vault.id === "string" ? [vault.id] : [])) : [],
    },
  };
}

async function readJson(response) {
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) throw new Error("My Cloud's answer was too large.");
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * @param {{
 *   handoff: (what: { kind: string, id?: string }) => Promise<{ onePassword?: { token: string, grants: Record<string, unknown> }, login?: Record<string, unknown> }>,
 *   home: () => { origin: string, grant: () => Promise<{ origin: string, code: string }> } | null,
 *   fetch: typeof fetch,
 *   cookieFetch: typeof fetch,
 * }} deps
 */
export function createCloudLogins({ handoff, home, fetch: fetchImpl, cookieFetch }) {
  async function peek(origin) {
    try {
      const response = await cookieFetch(`${origin}/api/logins`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
      return response.ok ? cloudLoginsView(await readJson(response)) : null;
    } catch { return null; }
  }
  async function openSession(target) {
    let grant;
    try { grant = await target.grant(); } catch (error) { throw new Error(sentence(error?.message) ?? "My Cloud is not ready. Check it in Settings → MausBot Cloud, then try again."); }
    // Only the person's own Cloud may be signed in to: never an origin a grant names instead.
    if (!record(grant) || grant.origin !== target.origin || typeof grant.code !== "string") throw new Error("My Cloud is not ready. Check it in Settings → MausBot Cloud, then try again.");
    const response = await fetchImpl(`${target.origin}/api/auth/pair`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code: grant.code, label: "Logins from this computer" }),
    });
    const body = await readJson(response).catch(() => null);
    if (!response.ok || typeof body?.token !== "string" || !body.token.startsWith("omb_sess_")) throw new Error("This app could not sign in to My Cloud to send the login. Try again.");
    return { origin: target.origin, token: body.token };
  }
  async function call(session, method, route, body) {
    const response = await fetchImpl(`${session.origin}${route}`, {
      method, redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(60_000),
      headers: { accept: "application/json", authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = await readJson(response).catch(() => null);
    return { status: response.status, ok: response.ok, body: answer };
  }
  const refusal = (answer, fallback) => {
    if (answer.status === 401 || answer.status === 403) return new Error("My Cloud did not let this app change its logins. Open My Cloud in this app once, then try again.");
    return new Error(sentence(answer.body?.error) ? `My Cloud said: ${sentence(answer.body.error)}` : fallback);
  };

  /** Whether the person has My Cloud, and what of Logins is already there. */
  async function state() {
    const target = home();
    if (!target) return { cloud: null };
    const seen = await peek(target.origin);
    return { cloud: seen ? { reachable: true, ...seen } : { reachable: false } };
  }

  return {
    state,
    async send(input) {
      const what = handoffWhat(input);
      if (!what) throw new Error("Choose a login to send to My Cloud.");
      const target = home();
      if (!target) throw new Error("This computer has no My Cloud yet.");
      const handed = await handoff(what);
      const session = await openSession(target);
      try {
        const listed = await call(session, "GET", "/api/bots");
        const cloudBots = new Set(Array.isArray(listed.body?.bots) ? listed.body.bots.flatMap(bot => (record(bot) && typeof bot.id === "string" ? [bot.id] : [])) : []);
        let narrowed = false;
        if (handed.onePassword) {
          const connected = await call(session, "POST", "/api/logins/1password", { token: handed.onePassword.token });
          if (!connected.ok) throw refusal(connected, "My Cloud could not connect 1Password. Try again.");
          for (const [vault, bots] of Object.entries(handed.onePassword.grants ?? {})) {
            if (!VAULT_ID.test(vault)) continue;
            const kept = botsOnCloud(bots, cloudBots);
            narrowed ||= Array.isArray(bots) && kept.length < bots.length;
            const granted = await call(session, "PATCH", `/api/logins/1password/vaults/${encodeURIComponent(vault)}`, { bots: kept });
            // A vault the Cloud's copy of the token cannot read is not there to narrow.
            if (!granted.ok && granted.status !== 404) throw refusal(granted, "My Cloud connected 1Password but could not keep its vaults to the same bots. Check them in My Cloud's Settings → Logins.");
          }
        } else {
          const login = handed.login;
          const kept = botsOnCloud(login.bots, cloudBots);
          narrowed = Array.isArray(login.bots) && kept.length < login.bots.length;
          const saved = await call(session, "POST", "/api/logins", { site: login.site, username: login.username, password: login.password,
            ...(login.totp ? { totp: login.totp } : {}), bots: kept, exactHost: login.exactHost === true });
          if (!saved.ok) throw refusal(saved, "My Cloud could not save the login. Try again.");
        }
        return { sent: true, ...(narrowed ? { narrowed: true } : {}), ...(await state()) };
      } finally {
        try { await call(session, "POST", "/api/auth/logout", {}); } catch {}
      }
    },
  };
}

/** Only this computer's own Settings page may ask: localOnly refuses every other page, a Cloud page among them. Returns
 * the handoff's receiver, for the server process's private messages. */
export function registerCloudLoginsIpc({ ipcMain, localOnly, server, home, cookieFetch, fetch: fetchImpl = globalThis.fetch }) {
  const client = createLoginHandoffClient();
  const logins = createCloudLogins({ handoff: what => client.request(server(), what), home, fetch: fetchImpl, cookieFetch });
  ipcMain.handle("cloud-logins:state", localOnly("cloud-logins:state", () => logins.state()));
  ipcMain.handle("cloud-logins:send", localOnly("cloud-logins:send", (_event, what) => logins.send(what)));
  return { receive: client.receive };
}
