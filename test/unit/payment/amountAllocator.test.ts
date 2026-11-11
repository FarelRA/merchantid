import { describe, expect, it } from "vitest";
import { AmountAllocator } from "../../../src/payment/amountAllocator.js";

describe("AmountAllocator", () => {
  it("allocates the smallest free offset starting at 1", () => {
    const allocator = new AmountAllocator();
    expect(allocator.allocate(10_000, [])).toBe(1);
    expect(allocator.allocate(10_000, [10_001])).toBe(2);
    expect(allocator.allocate(10_000, [10_001, 10_002])).toBe(3);
  });

  it("reuses freed offsets by picking the smallest gap", () => {
    const allocator = new AmountAllocator();
    // 10_001 and 10_003 are claimed, so offset 2 is the smallest free slot.
    expect(allocator.allocate(10_000, [10_001, 10_003])).toBe(2);
  });

  // Regression guard: uniqueness must hold on the resulting amount. Scoped per
  // base amount, 3500+1 and 3499+2 would both settle at 3501 and a single
  // transaction could be attributed to the wrong order.
  it("avoids an amount already claimed by a different base amount", () => {
    const allocator = new AmountAllocator();
    expect(allocator.allocate(3499, [3501])).toBe(1); // 3500 is free
    expect(allocator.allocate(3499, [3500, 3501])).toBe(3); // 3502
  });

  it("ignores claimed amounts outside this base amount's range", () => {
    const allocator = new AmountAllocator(999);
    // Far away amounts cannot collide, so the first offset stays available.
    expect(allocator.allocate(10_000, [999_999, 1, 50_000])).toBe(1);
  });

  it("throws when every slot in range is claimed", () => {
    const allocator = new AmountAllocator(3);
    expect(() => allocator.allocate(5_000, [5_001, 5_002, 5_003])).toThrowError(
      /No free unique amount slot/,
    );
  });

  it("reports the configured maximum", () => {
    expect(new AmountAllocator(50).max).toBe(50);
    expect(new AmountAllocator().max).toBe(999);
  });

  it("validates maxOffset", () => {
    expect(() => new AmountAllocator(0)).toThrow();
    expect(() => new AmountAllocator(1.5)).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid base amount (%s)",
    (baseAmount) => {
      const allocator = new AmountAllocator(3);
      expect(() => allocator.allocate(baseAmount, [])).toThrowError(
        expect.objectContaining({ code: "CONFIG_INVALID" }),
      );
    },
  );

  it("rejects invalid taken amounts instead of silently ignoring them", () => {
    const allocator = new AmountAllocator(3);
    expect(() => allocator.allocate(10_000, [Number.NaN])).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => allocator.allocate(10_000, [10_001.5])).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => allocator.allocate(10_000, [-1])).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("accepts any iterable of taken amounts", () => {
    const allocator = new AmountAllocator(5);
    expect(allocator.allocate(10_000, new Set([10_001, 10_002]))).toBe(3);
    expect(
      allocator.allocate(10_000, [10_001, 10_002, 10_003][Symbol.iterator]()),
    ).toBe(4);
  });

  it("does not hand out a slot whose amount collides with another base", () => {
    const allocator = new AmountAllocator(3);
    // 3499 + 2 = 3501, which is already active for base 3500.
    expect(allocator.allocate(3499, [3500, 3501])).toBe(3);
    expect(() => allocator.allocate(3499, [3500, 3501, 3502])).toThrowError(
      expect.objectContaining({ code: "AMOUNT_POOL_EXHAUSTED" }),
    );
  });
});
