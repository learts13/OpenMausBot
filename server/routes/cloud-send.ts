// GET /api/cloud-send: Send to My Cloud's comparison of this server (server/cloud-send.ts). Admin scope (request-auth's
// default): the owner's app reads it on this computer and on their own Cloud.
import { botAvatarUrlSchema } from "../../shared/bot-avatar.ts";
import { readAttachment } from "../attachments.ts";
import { cloudSendSummary, type CloudSendSources } from "../cloud-send.ts";
import type { AppConfig } from "../config.ts";
import type { LoginStore } from "../login-store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CloudSendRouteDeps extends Pick<CloudSendSources, "appVersion" | "bots" | "skills"> {
  messagesTail(threadId: string, limit: number): { messages: ReadonlyArray<{ role: string; text?: string }>; hasMore: boolean };
  logins: Pick<LoginStore, "changes" | "onePasswordConnectedAt" | "onePasswordGrants">;
  config(): Pick<AppConfig, "profile" | "language">;
}

export function createCloudSendRoutes(deps: CloudSendRouteDeps): RouteHandler {
  const sources: CloudSendSources = {
    appVersion: deps.appVersion,
    bots: deps.bots,
    greetingOnly: (threadId, name) => {
      const tail = deps.messagesTail(threadId, 2);
      return !tail.hasMore && tail.messages.length === 1 && tail.messages[0]!.role === "bot" && Boolean(tail.messages[0]!.text?.includes(name));
    },
    skills: deps.skills,
    picture: (avatarUrl) => botAvatarUrlSchema.safeParse(avatarUrl).success ? readAttachment(avatarUrl.slice("/api/attachments/".length))?.bytes ?? null : null,
    logins: () => deps.logins.changes(),
    onePassword: () => {
      const connectedAt = deps.logins.onePasswordConnectedAt();
      return connectedAt === null ? null : { connectedAt, grants: deps.logins.onePasswordGrants() };
    },
    settings: () => { const { profile, language } = deps.config(); return { profile, language }; },
  };
  return async ({ res, path, method, json }) => {
    if (path !== "/api/cloud-send") return PASS;
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    res.setHeader("cache-control", "no-store");
    return json(res, 200, cloudSendSummary(sources));
  };
}
