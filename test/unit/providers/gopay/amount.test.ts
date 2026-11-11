import { describe, expect, it } from "vitest";
import { normalizeGopayAmount } from "../../../../src/providers/gopay/amount.js";

describe("normalizeGopayAmount", () => {
  it.each([
    [100_100, 1_001], // Rp 1.001
    [1_000_100, 10_001], // Rp 10.001
    [10_000_000, 100_000], // Rp 100.000
    [300_100, 3_001], // documented feed example
    [0, 0],
  ])("converts sen %i to whole rupiah %i exactly once", (sen, rupiah) => {
    expect(normalizeGopayAmount(sen)).toBe(rupiah);
  });

  it("never accepts a value already expressed in rupiah", () => {
    // 1001 rupiah is 100100 sen; if this helper accepted rupiah, 1001 would
    // become 10.01. It is deliberately not divisible by 100.
    expect(normalizeGopayAmount(1_001)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    "100100",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -100_100,
    100_150, // Rp 1.001,50: sub-rupiah, cannot match an integer intent
    1.5,
    Number.MAX_SAFE_INTEGER,
  ])("rejects malformed value %s", (value) => {
    expect(normalizeGopayAmount(value)).toBeUndefined();
  });

  it("does not coerce malformed values to zero", () => {
    expect(normalizeGopayAmount(undefined)).not.toBe(0);
    expect(normalizeGopayAmount("garbage")).not.toBe(0);
  });
});
