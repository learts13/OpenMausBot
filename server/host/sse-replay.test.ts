import { describe, expect, it } from "vitest";

import { ReplayBuffer, type ReplayFrame } from "./sse-replay.ts";

const frame = (seq: number, chars = 10, kind = "message"): ReplayFrame => {
  const text = `${seq}:`.padEnd(chars, "x");
  return { seq, kind, frame: text, clientFrame: text, payload: { kind } };
};
const seqs = (buffer: ReplayBuffer) => [...buffer].map((entry) => entry.seq);

describe("ReplayBuffer", () => {
  it("keeps the newest frames up to its count", () => {
    const buffer = new ReplayBuffer(3, 1_000_000);
    for (let seq = 1; seq <= 5; seq++) buffer.push(frame(seq));
    expect(seqs(buffer)).toEqual([3, 4, 5]);
  });

  it("drops the oldest frames once they hold more than its size, payloads counted", () => {
    const buffer = new ReplayBuffer(500, 1_000);
    for (let seq = 1; seq <= 10; seq++) buffer.push(frame(seq, 200));
    expect(seqs(buffer)).toEqual([9, 10]);
  });

  it("counts a member frame that differs from the admin frame", () => {
    const buffer = new ReplayBuffer(500, 1_000);
    for (let seq = 1; seq <= 4; seq++) buffer.push({ ...frame(seq, 200), clientFrame: "y".repeat(200) });
    expect(seqs(buffer)).toEqual([4]);
  });

  it("keeps the newest frame even when it alone is over the size", () => {
    const buffer = new ReplayBuffer(500, 1_000);
    buffer.push(frame(1));
    buffer.push(frame(2, 5_000));
    expect(seqs(buffer)).toEqual([2]);
    expect(buffer.covers(1, 2)).toBe(true);
    expect(buffer.covers(0, 2)).toBe(false);
  });

  it("covers a cursor only when no frame after it was dropped", () => {
    const empty = new ReplayBuffer();
    expect(empty.covers(4, 4)).toBe(true);
    expect(empty.covers(3, 4)).toBe(false);
    const buffer = new ReplayBuffer(2, 1_000_000);
    for (let seq = 1; seq <= 4; seq++) buffer.push(frame(seq));
    expect(buffer.covers(2, 4)).toBe(true);
    expect(buffer.covers(4, 4)).toBe(true);
    expect(buffer.covers(1, 4)).toBe(false);
  });

  it("does not count a screen frame's slot, which keeps no payload", () => {
    const buffer = new ReplayBuffer(500, 1_000);
    buffer.push(frame(1, 400));
    for (let seq = 2; seq <= 50; seq++) buffer.push({ seq, kind: "screen", frame: null, clientFrame: null, payload: null });
    expect(seqs(buffer)[0]).toBe(1);
  });
});
