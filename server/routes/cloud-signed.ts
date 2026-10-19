// The Admin's signed requests to a Cloud home. They run before the session gate: the signature is the credential. Never
// log their headers, bodies or codes. A bad pairing signature counts against the pairing lockout; a health or power read
// opens nothing, so each route has its own nonces and never locks the Admin out of pairing. The power routes are the sleep
// handshake of a plan that sleeps (server/cloud-power.ts); the Admin calls them for no other plan.
import type { IncomingMessage, ServerResponse } from "node:http";
import { CLOUD_HEALTH_PATH, CLOUD_PAIRING_PATH, createCloudPairing, createCloudRequestVerifier, readSignedBody } from "../cloud-home.ts";
import type { CloudHealth } from "../cloud-health.ts";
import { CLOUD_IDLE_ACTIVITY_MS, CLOUD_POWER_PATH, CLOUD_POWER_SLEEP_PATH, type CloudPower } from "../cloud-power.ts";
import { json } from "../harness/http.ts";
import { requestSource } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";

export interface CloudSignedRequest { req: IncomingMessage; res: ServerResponse; url: URL; path: string; method: string }

export function createCloudSignedRoutes(deps: {
  secret: string;
  sessions: Pick<SessionRegistry, "openPairing" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  health: Pick<CloudHealth, "report">;
  /** The home's power once the server listens (null before, and on a server that is not a Cloud home). */
  power?: () => Pick<CloudPower, "report" | "prepareSleep"> | null;
  now?: () => number;
}) {
  const pairing = createCloudPairing({ secret: deps.secret, sessions: deps.sessions, now: deps.now });
  const healthRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const powerReads = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  const sleepRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  /** True when the request was one of these and has been answered. */
  return async ({ req, res, url, path, method }: CloudSignedRequest): Promise<boolean> => {
    const power = path === CLOUD_POWER_PATH || path === CLOUD_POWER_SLEEP_PATH ? deps.power?.() ?? null : null;
    if (path !== CLOUD_PAIRING_PATH && path !== CLOUD_HEALTH_PATH && !power) return false;
    res.setHeader("cache-control", "no-store");
    const source = requestSource(req);
    const header = (name: string) => { const value = req.headers[name]; return typeof value === "string" ? value : undefined; };
    const signed = { timestamp: header("x-omb-cloud-timestamp"), nonce: header("x-omb-cloud-nonce"), signature: header("x-omb-cloud-signature") };
    if (power && path === CLOUD_POWER_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = powerReads.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) { console.warn(`cloud power read refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      const minutes = url.searchParams.get("idleMinutes");
      const window = minutes !== null && /^\d{1,4}$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 24 * 60 ? Number(minutes) * 60_000 : CLOUD_IDLE_ACTIVITY_MS;
      json(res, 200, power.report(window));
      return true;
    }
    if (power) {
      if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) { json(res, 415, { error: "send the sleep request as JSON (content-type: application/json)" }); return true; }
      const body = await readSignedBody(req);
      const verdict = sleepRequests.verify({ ...signed, method, target: `${path}${url.search}`, body });
      if (!verdict.ok) { console.warn(`cloud sleep request refused from ${source}: ${verdict.error}`); json(res, verdict.status, { error: verdict.error }); return true; }
      let parsed: unknown;
      try { parsed = body.length ? JSON.parse(body.toString("utf8")) : {}; } catch { json(res, 400, { error: "invalid_body" }); return true; }
      const minutes = (parsed as { idleMinutes?: unknown } | null)?.idleMinutes;
      if (minutes !== undefined && !(Number.isInteger(minutes) && (minutes as number) >= 1 && (minutes as number) <= 24 * 60)) { json(res, 400, { error: "invalid_idle_minutes" }); return true; }
      const answer = power.prepareSleep(minutes === undefined ? CLOUD_IDLE_ACTIVITY_MS : (minutes as number) * 60_000);
      json(res, answer.ok ? 200 : 409, answer);
      return true;
    }
    if (path === CLOUD_HEALTH_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = healthRequests.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) {
        console.warn(`cloud health refused from ${source}: ${verdict.error}`);
        json(res, verdict.status, { error: verdict.error });
        return true;
      }
      json(res, 200, deps.health.report(url.searchParams.get("after")));
      return true;
    }
    if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      json(res, 415, { error: "send the pairing request as JSON (content-type: application/json)" });
      return true;
    }
    const result = pairing.handle({ ...signed, body: await readSignedBody(req), source });
    if (result.status !== 200) console.warn(`cloud pairing refused from ${source}: ${String(result.body.error)}`);
    json(res, result.status, result.body);
    return true;
  };
}
