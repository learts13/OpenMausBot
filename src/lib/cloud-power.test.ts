import { afterEach, describe, expect, it, vi } from "vitest";
import { asleepAnswer, cloudAsleep, markCloudAsleep, markCloudAwake, onCloudPower, resetCloudPowerForTests, sleepingFrame } from "./cloud-power";

afterEach(() => resetCloudPowerForTests());

class Target {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, new Set([...this.listeners.get(type) ?? [], listener])); }
  removeEventListener(type: string, listener: () => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string) { for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(); }
  get size() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

describe("a page of a Cloud home that sleeps", () => {
  it("goes quiet when told, tells listeners once, and wakes on the person's next action", () => {
    const target = new Target(), heard = vi.fn();
    onCloudPower(heard);
    markCloudAsleep(target as unknown as Window);
    markCloudAsleep(target as unknown as Window);
    expect(cloudAsleep()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    target.emit("keydown");
    expect(cloudAsleep()).toBe(false);
    expect(heard).toHaveBeenLastCalledWith(false);
    expect(target.size).toBe(0);
    markCloudAwake();
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("knows the home's asleep answer and its sleeping frame", () => {
    expect(asleepAnswer({ status: 503, headers: new Headers({ "x-omb-cloud-power": "asleep" }) })).toBe(true);
    expect(asleepAnswer({ status: 503, headers: new Headers() })).toBe(false);
    expect(asleepAnswer({ status: 200, headers: new Headers({ "x-omb-cloud-power": "asleep" }) })).toBe(false);
    expect(sleepingFrame({ kind: "power", state: "sleeping" })).toBe(true);
    expect(sleepingFrame({ kind: "power", state: "awake" })).toBe(false);
    expect(sleepingFrame({ kind: "message" })).toBe(false);
  });
});
