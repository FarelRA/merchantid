import { describe, expect, it } from "vitest";
import {
  isRejectedStatus,
  isSettleableStatus,
  matchesPayment,
  reconcile,
  transactionTimeMs,
} from "../../../src/payment/paymentMatcher.js";
import type { MerchantTransaction, Payment } from "../../../src/core/types.js";

function makePayment(partial: Partial<Payment> = {}): Payment {
  const createdAt = Date.parse("2026-07-14T21:40:00+07:00");
  return {
    id: "pay_1",
    baseAmount: 500000,
    uniqueOffset: 0,
    uniqueAmount: 500000,
    status: "pending",
    createdAt,
    expiresAt: createdAt + 5 * 60 * 1000,
    ...partial,
  };
}

function makeTx(
  partial: Partial<MerchantTransaction> = {},
): MerchantTransaction {
  return {
    id: "tx_1",
    orderId: "GMA-1",
    merchantId: "G000000001",
    status: "SETTLEMENT",
    paymentType: "QRIS",
    grossAmount: 500000,
    currency: "IDR",
    transactionTime: "2026-07-14T21:40:35+07:00",
    raw: {},
    ...partial,
  };
}

describe("matchesPayment", () => {
  it("matches on exact amount within the time window", () => {
    expect(matchesPayment(makePayment(), makeTx())).toBe(true);
  });

  it("rejects amount mismatch", () => {
    expect(matchesPayment(makePayment(), makeTx({ grossAmount: 500001 }))).toBe(
      false,
    );
  });

  it("rejects transactions outside the window", () => {
    const tx = makeTx({ transactionTime: "2026-07-14T23:00:00+07:00" });
    expect(matchesPayment(makePayment(), tx)).toBe(false);
  });

  it("rejects a transaction before the clock-skew window", () => {
    const payment = makePayment();
    const tx = makeTx({
      transactionTime: new Date(payment.createdAt - 61_000).toISOString(),
    });
    expect(matchesPayment(payment, tx)).toBe(false);
  });

  it("includes both window boundaries after applying clock skew", () => {
    const payment = makePayment();
    expect(
      matchesPayment(
        payment,
        makeTx({
          transactionTime: new Date(payment.createdAt - 60_000).toISOString(),
        }),
      ),
    ).toBe(true);
    expect(
      matchesPayment(
        payment,
        makeTx({
          transactionTime: new Date(payment.expiresAt + 60_000).toISOString(),
        }),
      ),
    ).toBe(true);
  });
});

describe("matchesPayment status filtering", () => {
  it.each([
    "settlement",
    "SETTLEMENT",
    " capture ",
    "captured",
    "success",
    "succeeded",
    "paid",
    "settled",
    "completed",
    "complete",
  ])("settles on the success-like status %s", (status) => {
    expect(matchesPayment(makePayment(), makeTx({ status }))).toBe(true);
    expect(isSettleableStatus(status)).toBe(true);
  });

  it.each([
    "pending",
    "deny",
    "cancel",
    "expire",
    "failure",
    "failed",
    "refund",
    "refunded",
    "partial_refund",
    "partial-refund",
    "void",
    "voided",
    "chargeback",
    "reversed",
  ])("refuses to settle on the non-success status %s", (status) => {
    expect(matchesPayment(makePayment(), makeTx({ status }))).toBe(false);
    expect(isSettleableStatus(status)).toBe(false);
  });

  it("explicitly tags refund, partial refund, void, and failed statuses", () => {
    expect(isRejectedStatus("refund")).toBe(true);
    expect(isRejectedStatus("partial_refund")).toBe(true);
    expect(isRejectedStatus("void")).toBe(true);
    expect(isRejectedStatus("failed")).toBe(true);
  });

  // Fail-closed: a missing/empty status is unverifiable, not a success. The
  // previous fail-open rule let an unlabelled old transaction settle a new
  // order whose amount had been re-allocated.
  it.each([undefined, null, "", "   ", "unknown", "settlement_pending"])(
    "treats a missing or unknown status (%s) as unverified",
    (status) => {
      expect(
        matchesPayment(
          makePayment(),
          makeTx({ status: status as unknown as string }),
        ),
      ).toBe(false);
    },
  );
});

describe("matchesPayment amount source", () => {
  it("uses only grossAmount, never realGrossAmount", () => {
    const tx = makeTx({ grossAmount: 0, realGrossAmount: 500000 });
    expect(matchesPayment(makePayment(), tx)).toBe(false);
  });

  it("requires an exact match, not a range", () => {
    expect(matchesPayment(makePayment(), makeTx({ grossAmount: 499999 }))).toBe(
      false,
    );
  });

  it("rejects a fractional rupiah amount", () => {
    expect(
      matchesPayment(makePayment(), makeTx({ grossAmount: 500000.5 })),
    ).toBe(false);
  });

  it("does not accept raw minor units against a whole-rupiah intent", () => {
    const payment = makePayment({ uniqueAmount: 3001 });
    const rawScale = makeTx({ grossAmount: 300100 });
    expect(matchesPayment(payment, rawScale)).toBe(false);
  });

  it("rejects a non-IDR transaction even when the number matches", () => {
    expect(matchesPayment(makePayment(), makeTx({ currency: "USD" }))).toBe(
      false,
    );
  });

  it.each([Number.NaN, Infinity, -Infinity, -1, 0])(
    "rejects an invalid transaction amount (%s)",
    (grossAmount) => {
      expect(matchesPayment(makePayment(), makeTx({ grossAmount }))).toBe(
        false,
      );
    },
  );
});

describe("matchesPayment timestamp handling", () => {
  it("rejects an unparseable timestamp instead of falling back to amount", () => {
    const tx = makeTx({ transactionTime: "not-a-date" });
    expect(matchesPayment(makePayment(), tx)).toBe(false);
    expect(transactionTimeMs(tx)).toBeUndefined();
  });

  it.each(["", "   ", undefined as unknown as string])(
    "rejects a missing timestamp (%s)",
    (transactionTime) => {
      expect(matchesPayment(makePayment(), makeTx({ transactionTime }))).toBe(
        false,
      );
    },
  );

  it("accepts a transaction inside the clock-skew tolerance", () => {
    const payment = makePayment();
    // 30s before creation, inside the default 60s skew allowance.
    const tx = makeTx({
      transactionTime: new Date(payment.createdAt - 30_000).toISOString(),
    });
    expect(matchesPayment(payment, tx)).toBe(true);
  });

  it("rejects a transaction outside the clock-skew tolerance", () => {
    const payment = makePayment();
    const tx = makeTx({
      transactionTime: new Date(payment.createdAt - 120_000).toISOString(),
    });
    expect(matchesPayment(payment, tx)).toBe(false);
  });

  it("never lets a negative skew widen the window", () => {
    const payment = makePayment();
    const tx = makeTx({
      transactionTime: new Date(payment.createdAt - 10_000).toISOString(),
    });
    expect(matchesPayment(payment, tx, -60_000)).toBe(false);
  });
});

describe("reconcile", () => {
  it("assigns each transaction to at most one payment", () => {
    const p1 = makePayment({ id: "p1", uniqueAmount: 10001, uniqueOffset: 1 });
    const p2 = makePayment({ id: "p2", uniqueAmount: 10002, uniqueOffset: 2 });

    const t1 = makeTx({ id: "t1", grossAmount: 10001 });
    const t2 = makeTx({ id: "t2", grossAmount: 10002 });

    const matches = reconcile([p2, p1], [t2, t1]);
    expect(matches).toHaveLength(2);

    const byPayment = Object.fromEntries(
      matches.map((m) => [m.payment.id, m.transaction.id]),
    );
    expect(byPayment["p1"]).toBe("t1");
    expect(byPayment["p2"]).toBe("t2");
  });

  it("does not settle two payments from one transaction", () => {
    const p1 = makePayment({ id: "p1", uniqueAmount: 10001, uniqueOffset: 1 });
    const p2 = makePayment({ id: "p2", uniqueAmount: 10001, uniqueOffset: 1 });
    const t1 = makeTx({ id: "t1", grossAmount: 10001 });

    const matches = reconcile([p1, p2], [t1]);
    expect(matches).toHaveLength(1);
    // Oldest pending order wins deterministically when two active payments
    // defectively share an amount.
    expect(matches[0]?.payment.id).toBe("p1");
  });

  it("consumes a duplicated transaction id only once", () => {
    const p1 = makePayment({ id: "p1", uniqueAmount: 10001, uniqueOffset: 1 });
    const p2 = makePayment({ id: "p2", uniqueAmount: 10002, uniqueOffset: 2 });
    const duplicate = makeTx({ id: "tx-dup", grossAmount: 10001 });
    const sameIdOtherAmount = makeTx({ id: "tx-dup", grossAmount: 10002 });

    const matches = reconcile([p1, p2], [duplicate, sameIdOtherAmount]);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.payment.id).toBe("p1");
    expect(matches[0]?.transaction.id).toBe("tx-dup");
  });

  it("is deterministic regardless of input order", () => {
    const p1 = makePayment({
      id: "p1",
      createdAt: 1_000,
      expiresAt: 10_000,
      uniqueAmount: 10001,
      uniqueOffset: 1,
    });
    const p2 = makePayment({
      id: "p2",
      createdAt: 2_000,
      expiresAt: 11_000,
      uniqueAmount: 10001,
      uniqueOffset: 1,
    });
    const t1 = makeTx({
      id: "t1",
      grossAmount: 10001,
      transactionTime: new Date(1_500).toISOString(),
    });
    const t2 = makeTx({
      id: "t2",
      grossAmount: 10001,
      transactionTime: new Date(9_500).toISOString(),
    });

    const forward = reconcile([p1, p2], [t1, t2]);
    const reversed = reconcile([p2, p1], [t2, t1]);
    const shuffled = reconcile([p2, p1], [t1, t2]);

    expect(forward).toEqual(reversed);
    expect(forward).toEqual(shuffled);
    expect(forward).toHaveLength(2);
  });

  it("does not settle a refund transaction even with a matching amount", () => {
    const payment = makePayment({ uniqueAmount: 10001, uniqueOffset: 1 });
    const refund = makeTx({
      id: "tx-refund",
      grossAmount: 10001,
      status: "refund",
    });

    expect(reconcile([payment], [refund])).toEqual([]);
  });

  it("does not settle a transaction with a missing timestamp", () => {
    const payment = makePayment({ uniqueAmount: 10001, uniqueOffset: 1 });
    const tx = makeTx({
      id: "tx-no-time",
      grossAmount: 10001,
      transactionTime: "not-a-date",
    });

    expect(reconcile([payment], [tx])).toEqual([]);
  });

  it("does not settle a transaction outside the payment window", () => {
    const payment = makePayment({
      uniqueAmount: 10001,
      uniqueOffset: 1,
      createdAt: 1_000_000,
      expiresAt: 1_060_000,
    });
    const tooEarly = makeTx({
      id: "tx-early",
      grossAmount: 10001,
      transactionTime: new Date(800_000).toISOString(),
    });
    const tooLate = makeTx({
      id: "tx-late",
      grossAmount: 10001,
      transactionTime: new Date(1_300_000).toISOString(),
    });

    expect(reconcile([payment], [tooEarly, tooLate], 0)).toEqual([]);
  });

  it("uses a settleable duplicate over a non-settling duplicate", () => {
    const payment = makePayment({ uniqueAmount: 10001, uniqueOffset: 1 });
    const refund = makeTx({
      id: "tx-same",
      grossAmount: 10001,
      status: "refund",
    });
    const settlement = makeTx({
      id: "tx-same",
      grossAmount: 10001,
      status: "settlement",
    });

    // Feed order must not matter: ranking puts the settleable row first.
    expect(reconcile([payment], [refund, settlement])).toHaveLength(1);
    expect(reconcile([payment], [settlement, refund])).toHaveLength(1);
  });

  it("ignores transactions without an id", () => {
    const payment = makePayment({ uniqueAmount: 10001, uniqueOffset: 1 });
    const noId = makeTx({ id: "", grossAmount: 10001 });
    expect(reconcile([payment], [noId])).toEqual([]);
  });

  it("is stable across repeated calls", () => {
    const payments = [
      makePayment({ id: "p2", uniqueAmount: 10002, uniqueOffset: 2 }),
      makePayment({ id: "p1", uniqueAmount: 10001, uniqueOffset: 1 }),
    ];
    const transactions = [
      makeTx({ id: "t2", grossAmount: 10002 }),
      makeTx({ id: "t1", grossAmount: 10001 }),
    ];

    const first = reconcile(payments, transactions);
    const second = reconcile(payments, transactions);
    expect(second).toEqual(first);
  });
});
