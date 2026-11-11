import { describe, expect, it } from "vitest";
import * as api from "../../src/index.js";

describe("MerchantId public API contract", () => {
  it("exports the canonical composition root, providers, errors, and transport", () => {
    expect(api.MerchantId).toBeTypeOf("function");
    expect(api.createMerchantId).toBeTypeOf("function");
    expect(api.GopayProvider).toBeTypeOf("function");
    expect(api.ShopeeProvider).toBeTypeOf("function");
    expect(api.ShopeeHttpClient).toBeTypeOf("function");
    expect(api.MerchantIdError).toBeTypeOf("function");
    expect(api.PaymentService).toBeTypeOf("function");
    expect(api.samePaymentScope).toBeTypeOf("function");
    expect(api.paymentScopeKey).toBeTypeOf("function");
    expect(api.matchesPayment).toBeTypeOf("function");
    expect(api.reconcile).toBeTypeOf("function");
    expect(api.isSettleableStatus).toBeTypeOf("function");
    expect(api.normalizeGopayAmount).toBeTypeOf("function");
    expect(api.jitteredBackoff).toBeTypeOf("function");
  });

  it("keeps Node-only integrations out of the runtime-agnostic root", () => {
    for (const name of [
      "SqlitePaymentStore",
      "createSqlitePaymentStore",
      "SessionVault",
      "deliverWebhook",
      "validateWebhookUrl",
    ]) {
      expect(name in api).toBe(false);
    }
  });

  it.each([
    "IndoPay",
    "createIndoPay",
    "GopayMerchant",
    "ShopeeMerchant",
    "GopayMerchantError",
    "GopayErrorCode",
  ])("does not expose removed facade %s", (name) => {
    expect(name in api).toBe(false);
  });
});
