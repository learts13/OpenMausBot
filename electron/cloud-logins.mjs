// The private ask for one login's secrets, which Send to My Cloud (cloud-send.mjs) carries to the person's own Cloud.
//
// The secret leaves this computer's server only over Electron's private utility-process port (server/login-handoff.ts)
// and is answered only to the process it was asked of; nothing here keeps or logs it.
import { randomUUID } from "node:crypto";

const REQUEST = "openmausbot:login-handoff";
const RESULT = "openmausbot:login-handoff-result";
const LOGIN_ID = /^[\w-]{1,128}$/;

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
