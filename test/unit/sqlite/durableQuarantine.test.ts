import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PaymentService } from "../../../src/payment/paymentService.js";
import type {
  MerchantTransaction,
  Payment,
  PaymentScope,
} from "../../../src/core/types.js";
import type { SqlitePaymentStore as SqliteStore } from "../../../src/sqlite/index.js";

interface BuiltinLoader {
  getBuiltinModule?: (id: string) => unknown;
}

let sqlite: { SqlitePaymentStore: typeof SqliteStore } | undefined;
const loadBuiltin = (process as NodeJS.Process & BuiltinLoader)
  .getBuiltinModule;
const sqliteBuiltin =
  typeof loadBuiltin === "function"
    ? (loadBuiltin("node:sqlite") as { DatabaseSync?: unknown } | undefined)
    : undefined;
if (typeof sqliteBuiltin?.DatabaseSync === "function") {
  try {
    sqlite = await import("../../../src/sqlite/index.js");
  } catch {
    // Optional integration: a load failure must not fail the Node 18 suite.
  }
}
const describeSqlite = sqlite ? describe : describe.skip;

const SCOPE: PaymentScope = { provider: "gopay", merchantId: "G000000001" };
const OTHER_SCOPE: PaymentScope = {
  provider: "gopay",
  merchantId: "G000000002",
};
const QUARANTINE_MS = 2 * 60_000;

function tempDatabase(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "merchantid-quarantine-"));
  return {
    path: join(dir, "payments.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function pendingPayment(
  id: string,
  uniqueAmount = 3_501,
  scope: PaymentScope | undefined = SCOPE,
): Payment {
  return {
    id,
    ...(scope ? { scope } : {}),
    baseAmount: 3_500,
    uniqueOffset: uniqueAmount - 3_500,
    uniqueAmount,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
  };
}

function makeTx(partial: Partial<MerchantTransaction>): MerchantTransaction {
  return {
    id: "tx",
    orderId: "order",
    merchantId: "G1",
    status: "settlement",
    paymentType: "qris",
    grossAmount: 0,
    currency: "IDR",
    transactionTime: new Date().toISOString(),
    raw: {},
    ...partial,
  };
}

function serviceFor(
  store: SqliteStore,
  clockSkewMs: number,
  transactions: MerchantTransaction[] = [],
): PaymentService {
  return new PaymentService({
    merchantId: SCOPE.merchantId,
    scope: SCOPE,
    store,
    transactions: {
      async list() {
        return transactions;
      },
    },
    clockSkewMs,
  });
}

describeSqlite("durable amount quarantine", () => {
  const SqlitePaymentStore = sqlite!.SqlitePaymentStore;

  it("keeps a freed amount unavailable across a restart until the window ends", async () => {
    const db = tempDatabase();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
      const first = new SqlitePaymentStore({ path: db.path });
      const firstService = serviceFor(first, 60_000);
      const created = await firstService.createPayment({ amount: 3_500 });
      expect(created.uniqueAmount).toBe(3_501);

      await firstService.cancelPayment(created.id);
      expect(first.isAmountQuarantined(SCOPE, 3_501)).toBe(true);
      first.close();

      // A new process opens the same file. Without the durable table the
      // in-process map would be empty here and 3501 would be handed out again.
      const second = new SqlitePaymentStore({ path: db.path });
      const secondService = serviceFor(second, 60_000);
      expect(second.isAmountQuarantined(SCOPE, 3_501)).toBe(true);
      expect(second.listQuarantinedAmounts(SCOPE)).toEqual([3_501]);

      const next = await secondService.createPayment({ amount: 3_500 });
      expect(next.uniqueAmount).toBe(3_502);

      // One millisecond past `2 * clockSkewMs` the slot is reusable again.
      vi.setSystemTime(Date.now() + QUARANTINE_MS + 1);
      const reused = await secondService.createPayment({ amount: 3_500 });
      expect(reused.uniqueAmount).toBe(3_501);
      expect(second.isAmountQuarantined(SCOPE, 3_501)).toBe(false);
      second.close();
    } finally {
      vi.useRealTimers();
      db.cleanup();
    }
  });

  it("cannot settle a new payment with a transaction consumed before the restart", async () => {
    const db = tempDatabase();
    try {
      const store = new SqlitePaymentStore({ path: db.path });
      const feed: MerchantTransaction[] = [];
      const firstService = serviceFor(store, 0, feed);
      const first = await firstService.createPayment({ amount: 3_500 });
      // Build the transaction after the payment so its timestamp falls inside
      // the (zero-skew) window.
      feed.push(makeTx({ id: "tx-consumed", grossAmount: 3_501 }));

      expect((await firstService.tick()).paid).toHaveLength(1);
      expect(store.get(first.id)?.status).toBe("paid");
      store.close();

      const reopened = new SqlitePaymentStore({ path: db.path });
      expect(reopened.hasConsumedTransaction("tx-consumed")).toBe(true);

      // clockSkewMs 0 disables the quarantine, so the amount is reused and the
      // only guard left is the durable transaction claim. The same id is still
      // returned by the feed.
      const secondService = serviceFor(reopened, 0, feed);
      const second = await secondService.createPayment({ amount: 3_500 });
      expect(second.uniqueAmount).toBe(first.uniqueAmount);

      const tick = await secondService.tick();
      expect(tick.paid).toHaveLength(0);
      expect(reopened.get(second.id)?.status).toBe("pending");
      reopened.close();
    } finally {
      db.cleanup();
    }
  });

  it("cannot settle a reused amount with a stale transaction after the restart", async () => {
    const db = tempDatabase();
    try {
      // The old payment expired long ago; its buyer transferred late, so the
      // row is still in the feed but outside any new payment's window.
      const staleTransaction = makeTx({
        id: "tx-late",
        grossAmount: 3_501,
        transactionTime: new Date(Date.now() - 3_600_000).toISOString(),
      });

      const store = new SqlitePaymentStore({ path: db.path });
      const firstService = serviceFor(store, 0);
      const first = await firstService.createPayment({
        amount: 3_500,
        expiresInMs: -1,
      });
      expect((await firstService.tick()).expired).toHaveLength(1);
      expect(store.get(first.id)?.status).toBe("expired");
      store.close();

      const reopened = new SqlitePaymentStore({ path: db.path });
      const secondService = serviceFor(reopened, 0, [staleTransaction]);
      const second = await secondService.createPayment({ amount: 3_500 });
      expect(second.uniqueAmount).toBe(first.uniqueAmount);

      const tick = await secondService.tick();
      expect(tick.paid).toHaveLength(0);
      expect(reopened.get(second.id)?.status).toBe("pending");
      reopened.close();
    } finally {
      db.cleanup();
    }
  });

  it("prunes quarantines once their window ends", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const until = Date.now() + 60_000;
    store.quarantineAmount({
      scope: SCOPE,
      amount: 10_001,
      quarantinedUntil: until,
    });

    expect(store.isAmountQuarantined(SCOPE, 10_001)).toBe(true);
    // The deadline itself is already outside the window.
    expect(store.isAmountQuarantined(SCOPE, 10_001, until)).toBe(false);
    expect(store.listQuarantinedAmounts(SCOPE, until)).toEqual([]);

    expect(() => store.create(pendingPayment("blocked", 10_001))).toThrowError(
      expect.objectContaining({ code: "AMOUNT_CONFLICT" }),
    );

    expect(store.pruneQuarantine(until)).toBe(1);
    expect(store.isAmountQuarantined(SCOPE, 10_001)).toBe(false);
    expect(store.listQuarantinedAmounts(SCOPE)).toEqual([]);
    expect(() => store.create(pendingPayment("allowed", 10_001))).not.toThrow();
    store.close();
  });

  it("refuses a quarantined amount after reopening the database", () => {
    const db = tempDatabase();
    try {
      const first = new SqlitePaymentStore({ path: db.path });
      first.quarantineAmount({
        scope: SCOPE,
        amount: 3_501,
        quarantinedUntil: Date.now() + QUARANTINE_MS,
      });
      first.close();

      const second = new SqlitePaymentStore({ path: db.path });
      expect(() => second.create(pendingPayment("late"))).toThrowError(
        expect.objectContaining({
          code: "AMOUNT_CONFLICT",
          details: expect.objectContaining({ quarantined: true }),
        }),
      );
      // Scope isolation matches active-amount uniqueness: another merchant may
      // use the same number.
      expect(() =>
        second.create(pendingPayment("other", 3_501, OTHER_SCOPE)),
      ).not.toThrow();
      second.close();
    } finally {
      db.cleanup();
    }
  });

  it("rejects a reuse attempt from another connection that read before the release", () => {
    const db = tempDatabase();
    try {
      const first = new SqlitePaymentStore({ path: db.path });
      const second = new SqlitePaymentStore({ path: db.path });
      const original = pendingPayment("p1");
      first.create(original);
      // The second connection observed the slot as active before it was freed,
      // exactly like a peer process that allocated against a stale snapshot.
      expect(second.listActive(SCOPE)).toHaveLength(1);

      first.transition({
        id: "p1",
        expectedStatus: "pending",
        payment: { ...original, status: "cancelled" },
        quarantineUntil: Date.now() + QUARANTINE_MS,
      });

      expect(() => second.create(pendingPayment("p2"))).toThrowError(
        expect.objectContaining({
          code: "AMOUNT_CONFLICT",
          details: expect.objectContaining({ quarantined: true }),
        }),
      );
      first.close();
      second.close();
    } finally {
      db.cleanup();
    }
  });

  it("quarantines the released amount in the same transition as the status write", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const original = pendingPayment("p1");
    store.create(original);
    const until = Date.now() + QUARANTINE_MS;

    expect(
      store.transition({
        id: "p1",
        expectedStatus: "pending",
        payment: { ...original, status: "paid" },
        quarantineUntil: until,
      }),
    ).toMatchObject({ status: "paid" });

    expect(store.isAmountQuarantined(SCOPE, 3_501)).toBe(true);
    expect(() => store.create(pendingPayment("p2"))).toThrowError(
      expect.objectContaining({ code: "AMOUNT_CONFLICT" }),
    );
    store.close();
  });

  it("never shortens an existing quarantine when re-quarantined", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const early = Date.now() + 1_000;
    const late = Date.now() + QUARANTINE_MS;

    store.quarantineAmount({
      scope: SCOPE,
      amount: 3_501,
      quarantinedUntil: late,
    });
    store.quarantineAmount({
      scope: SCOPE,
      amount: 3_501,
      quarantinedUntil: early,
    });

    expect(store.isAmountQuarantined(SCOPE, 3_501, early + 1)).toBe(true);
    expect(store.listQuarantinedAmounts(SCOPE, early + 1)).toEqual([3_501]);
    store.close();
  });

  it("drops expired rows when a new payment is created", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    store.quarantineAmount({
      scope: SCOPE,
      amount: 3_501,
      quarantinedUntil: Date.now() - 1,
    });

    expect(store.create(pendingPayment("reused"))).toBeUndefined();
    // `create` prunes lazily: a leftover row would still be counted here.
    expect(store.pruneQuarantine(Date.now())).toBe(0);
    store.close();
  });
});
