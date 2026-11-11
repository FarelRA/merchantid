import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

const SCOPE_A: PaymentScope = {
  provider: "gopay",
  merchantId: "G000000001",
};
const SCOPE_B: PaymentScope = {
  provider: "gopay",
  merchantId: "G000000002",
};

function payment(
  id: string,
  scope: PaymentScope | undefined,
  uniqueAmount = 10_001,
): Payment {
  return {
    id,
    ...(scope ? { scope } : {}),
    baseAmount: 10_000,
    uniqueOffset: uniqueAmount - 10_000,
    uniqueAmount,
    status: "pending",
    createdAt: 1_800_000_000_000,
    expiresAt: 1_800_000_300_000,
    reference: `ref-${id}`,
    metadata: { orderId: id },
  };
}

function tempDatabase(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "merchantid-sqlite-"));
  return {
    path: join(dir, "payments.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describeSqlite("SqlitePaymentStore", () => {
  const SqlitePaymentStore = sqlite!.SqlitePaymentStore;

  it("persists a payment across store instances", () => {
    const db = tempDatabase();
    try {
      const first = new SqlitePaymentStore({ path: db.path });
      first.create(payment("p1", SCOPE_A));
      first.close();

      const second = new SqlitePaymentStore({ path: db.path });
      expect(second.get("p1")).toMatchObject({
        id: "p1",
        scope: SCOPE_A,
        status: "pending",
        uniqueAmount: 10_001,
        metadata: { orderId: "p1" },
      });
      expect(second.listActive(SCOPE_A)).toHaveLength(1);
      expect(second.listActive(SCOPE_B)).toHaveLength(0);
      second.close();
    } finally {
      db.cleanup();
    }
  });

  it("round-trips a transaction and drops it when absent", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const pending = payment("p1", SCOPE_A);
    store.create(pending);

    const paid: Payment = {
      ...pending,
      status: "paid",
      transaction: {
        id: "tx-1",
        orderId: "order-1",
        merchantId: "G1",
        status: "settlement",
        paymentType: "qris",
        grossAmount: 10_001,
        currency: "IDR",
        transactionTime: new Date(pending.createdAt).toISOString(),
        raw: { gross_amount: 1000100 },
      },
    };
    expect(
      store.transition({
        id: "p1",
        expectedStatus: "pending",
        payment: paid,
        transactionId: "tx-1",
      }),
    ).toMatchObject({ status: "paid", transaction: { id: "tx-1" } });
    expect(store.hasConsumedTransaction("tx-1")).toBe(true);
    store.close();
  });

  it("allows the same amount in different scopes but not within one scope", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    store.create(payment("a", SCOPE_A));
    store.create(payment("b", SCOPE_B));

    expect(() => store.create(payment("c", SCOPE_A))).toThrowError(
      expect.objectContaining({ code: "AMOUNT_CONFLICT" }),
    );
    expect(() => store.create(payment("d", undefined))).not.toThrow();
    expect(() => store.create(payment("e", undefined))).toThrowError(
      expect.objectContaining({ code: "AMOUNT_CONFLICT" }),
    );
    store.close();
  });

  it("enforces uniqueness across two connections to the same file", () => {
    const db = tempDatabase();
    try {
      const first = new SqlitePaymentStore({ path: db.path });
      const second = new SqlitePaymentStore({ path: db.path });
      first.create(payment("a", SCOPE_A));

      expect(() => second.create(payment("b", SCOPE_A))).toThrowError(
        expect.objectContaining({ code: "AMOUNT_CONFLICT" }),
      );
      expect(() => second.create(payment("c", SCOPE_B))).not.toThrow();

      first.close();
      second.close();
    } finally {
      db.cleanup();
    }
  });

  it("releases the active amount when a payment becomes terminal", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const original = payment("p1", SCOPE_A);
    store.create(original);

    store.transition({
      id: "p1",
      expectedStatus: "pending",
      payment: { ...original, status: "cancelled" },
    });

    expect(() => store.create(payment("p2", SCOPE_A))).not.toThrow();
    store.close();
  });

  it("performs compare-and-set and never overwrites a terminal status", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const original = payment("p1", SCOPE_A);
    store.create(original);

    expect(
      store.transition({
        id: "p1",
        expectedStatus: "paid",
        payment: { ...original, status: "paid" },
      }),
    ).toBeUndefined();

    expect(
      store.transition({
        id: "p1",
        expectedStatus: "pending",
        payment: { ...original, status: "paid" },
      }),
    ).toMatchObject({ status: "paid" });

    expect(
      store.transition({
        id: "p1",
        expectedStatus: "pending",
        payment: { ...original, status: "cancelled" },
      }),
    ).toBeUndefined();
    expect(store.get("p1")?.status).toBe("paid");
    store.close();
  });

  it("claims a provider transaction id exactly once", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const first = payment("p1", SCOPE_A, 10_001);
    const second = payment("p2", SCOPE_A, 10_002);
    store.create(first);
    store.create(second);

    expect(
      store.transition({
        id: "p1",
        expectedStatus: "pending",
        payment: { ...first, status: "paid" },
        transactionId: "tx-shared",
      }),
    ).toBeDefined();

    expect(
      store.transition({
        id: "p2",
        expectedStatus: "pending",
        payment: { ...second, status: "paid" },
        transactionId: "tx-shared",
      }),
    ).toBeUndefined();

    expect(store.get("p2")?.status).toBe("pending");
    expect(store.listActive(SCOPE_A)).toHaveLength(1);
    store.close();
  });

  it("rejects an update that collides with another active amount", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const first = payment("p1", SCOPE_A, 10_001);
    const second = payment("p2", SCOPE_A, 10_002);
    store.create(first);
    store.create(second);

    expect(() =>
      store.update({ ...second, uniqueAmount: 10_001, uniqueOffset: 1 }),
    ).toThrowError(expect.objectContaining({ code: "AMOUNT_CONFLICT" }));
    store.close();
  });

  it("settles through PaymentService using the atomic transition path", async () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const intent = payment("p1", SCOPE_A);
    store.create(intent);
    const transaction: MerchantTransaction = {
      id: "tx-service",
      orderId: "order-1",
      merchantId: "G1",
      status: "settlement",
      paymentType: "qris",
      grossAmount: 10_001,
      currency: "IDR",
      transactionTime: new Date(intent.createdAt).toISOString(),
      raw: {},
    };
    const service = new PaymentService({
      merchantId: SCOPE_A.merchantId,
      scope: SCOPE_A,
      store,
      transactions: {
        async list() {
          return [transaction];
        },
      },
      clockSkewMs: 0,
    });

    const result = await service.tick();

    expect(result.paid).toHaveLength(1);
    expect(store.get("p1")?.status).toBe("paid");
    expect(store.hasConsumedTransaction("tx-service")).toBe(true);
    store.close();
  });

  it("prunes consumed transaction claims older than the lookback", () => {
    const store = new SqlitePaymentStore({ path: ":memory:" });
    const original = payment("p1", SCOPE_A);
    store.create(original);
    store.transition({
      id: "p1",
      expectedStatus: "pending",
      payment: { ...original, status: "paid" },
      transactionId: "tx-old",
    });

    expect(store.pruneConsumedTransactions(Date.now() + 1)).toBe(1);
    expect(store.hasConsumedTransaction("tx-old")).toBe(false);
    store.close();
  });
});
