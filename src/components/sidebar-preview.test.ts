import { describe, expect, it } from "vitest";

import type { Bot, Message } from "@/state/store";
import { botPreview } from "./sidebar-preview";

const bot = { id: "scout", name: "Scout", messages: [] } as unknown as Bot;
const run = (status: NonNullable<Message["routineRun"]>["status"]): Message => ({
  id: `run-${status}`, role: "bot", kind: "routine.run", at: 1,
  text: `Routine “Lead count” ${status}`,
  routineRun: { runId: "r1", routineId: "lead-count", routineName: "Lead count", status },
} as Message);

describe("a bot's preview after one of its automations ran", () => {
  it("says what happened in the Automations page's words", () => {
    expect(botPreview(bot, [run("completed")], [], false)).toBe("“Lead count” finished");
    expect(botPreview(bot, [run("failed")], [], false)).toBe("“Lead count” didn't finish");
    expect(botPreview(bot, [run("waiting")], [], false)).toBe("“Lead count” needs you");
    expect(botPreview(bot, [run("running")], [], false)).toBe("“Lead count” is running");
    expect(botPreview(bot, [run("completed")], [], false)).not.toMatch(/routine/i);
  });
});
