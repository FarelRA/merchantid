import { describe, expect, it } from "vitest";
import { jitteredBackoff } from "../../../src/utils/polling.js";

describe("jitteredBackoff", () => {
  it("grows exponentially from the base delay", () => {
    const options = { baseMs: 1_000, jitterRatio: 0, maxMs: 60_000 };
    expect(jitteredBackoff(0, options)).toBe(1_000);
    expect(jitteredBackoff(1, options)).toBe(2_000);
    expect(jitteredBackoff(2, options)).toBe(4_000);
    expect(jitteredBackoff(3, options)).toBe(8_000);
  });

  it("caps the exponential delay before jitter", () => {
    const options = { baseMs: 1_000, maxMs: 5_000, jitterRatio: 0 };
    expect(jitteredBackoff(10, options)).toBe(5_000);
  });

  it("keeps jitter within the configured band and the ceiling", () => {
    const low = jitteredBackoff(3, {
      baseMs: 1_000,
      maxMs: 60_000,
      jitterRatio: 0.5,
      random: () => 0,
    });
    const high = jitteredBackoff(3, {
      baseMs: 1_000,
      maxMs: 60_000,
      jitterRatio: 0.5,
      random: () => 0.999_999,
    });

    expect(low).toBe(4_000);
    expect(high).toBe(12_000);
  });

  it("never returns a negative or above-ceiling delay", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const delay = jitteredBackoff(attempt, {
        baseMs: 100,
        maxMs: 1_000,
        jitterRatio: 1,
        random: () => 0,
      });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });

  it("validates its inputs", () => {
    expect(() => jitteredBackoff(-1)).toThrow(RangeError);
    expect(() => jitteredBackoff(1.5)).toThrow(RangeError);
    expect(() => jitteredBackoff(0, { baseMs: -1 })).toThrow(RangeError);
    expect(() => jitteredBackoff(0, { maxMs: -1 })).toThrow(RangeError);
    expect(() => jitteredBackoff(0, { jitterRatio: 2 })).toThrow(RangeError);
    expect(() => jitteredBackoff(0, { random: () => 1 })).toThrow(RangeError);
  });
});
