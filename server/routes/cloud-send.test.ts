import { describe, expect, it } from "vitest";
import { createCloudSendRoutes } from "./cloud-send.ts";

const handler = (messages: Array<{ role: string; text?: string }>, hasMore = false) => createCloudSendRoutes({
  appVersion: "0.1.117",
  bots: () => [{ id: "bot-00000001", threadId: "thread-0001", name: "Yuki", title: "", description: "", soul: "", tasks: [{ threadId: "thread-0001" }] } as never],
  messagesTail: () => ({ messages, hasMore }),
  skills: () => [],
  logins: { changes: () => [], onePasswordConnectedAt: () => null, onePasswordGrants: () => ({}) },
  config: () => ({}),
});
async function bots(route: ReturnType<typeof createCloudSendRoutes>): Promise<string[]> {
  let body: { items: Array<{ kind: string; label: string }> } | undefined;
  await route({ path: "/api/cloud-send", method: "GET", res: { setHeader() {} }, json: (_res: unknown, _status: number, value: unknown) => { body = value as typeof body; } } as never);
  return body!.items.filter((item) => item.kind === "bot").map((item) => item.label);
}

describe("GET /api/cloud-send", () => {
  it("leaves out a starter that holds only its own greeting, and keeps a bot that was renamed, written to, or arrived without one", async () => {
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Yuki. What would you like me to do?" }]))).toEqual([]);
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Pearl. What would you like me to do?" }]))).toEqual(["Yuki"]);
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Yuki." }, { role: "user", text: "hello" }]))).toEqual(["Yuki"]);
    expect(await bots(handler([]))).toEqual(["Yuki"]);
    expect(await bots(handler([{ role: "bot", text: "Hi, I'm Yuki." }], true))).toEqual(["Yuki"]);
  });
});
