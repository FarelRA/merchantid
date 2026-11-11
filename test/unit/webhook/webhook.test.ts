import { describe, expect, it, vi } from "vitest";
import {
  createPaymentWebhookEvent,
  createWebhookSignatureHeader,
  deliverWebhook,
  isBlockedAddress,
  signWebhook,
  validateWebhookUrl,
  verifyWebhookSignature,
  WebhookSecurityError,
  type WebhookEvent,
} from "../../../src/webhook/index.js";
import type { Payment } from "../../../src/core/types.js";

const SECRET = "test-webhook-secret-0123456789abcdef";
const NOW = 1_800_000_000_000;

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
): Response {
  return { status, headers: new Headers(headers) } as Response;
}

function makePayment(partial: Partial<Payment> = {}): Payment {
  return {
    id: "pay_1",
    baseAmount: 10_000,
    uniqueOffset: 1,
    uniqueAmount: 10_001,
    status: "paid",
    createdAt: NOW - 60_000,
    expiresAt: NOW + 240_000,
    reference: "order-1",
    qrString: "000201-sensitive-qris-payload",
    metadata: { customerEmail: "secret@example.com" },
    transaction: {
      id: "tx_1",
      orderId: "order-1",
      merchantId: "G1",
      status: "settlement",
      paymentType: "qris",
      grossAmount: 10_001,
      currency: "IDR",
      transactionTime: new Date(NOW - 30_000).toISOString(),
      raw: { token: "provider-secret" },
    },
    ...partial,
  };
}

function event(): WebhookEvent {
  return {
    id: "evt_1",
    type: "payment.settled",
    createdAt: new Date(NOW).toISOString(),
    data: { paymentId: "pay_1" },
  };
}

describe("webhook signatures", () => {
  it("signs timestamp + body and verifies it", () => {
    const body = JSON.stringify(event());
    const timestamp = Math.floor(NOW / 1000);
    const header = createWebhookSignatureHeader(SECRET, timestamp, body);

    expect(header).toBe(
      `t=${timestamp},v1=${signWebhook(SECRET, timestamp, body)}`,
    );
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: header,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body, wrong secret, and malformed header", () => {
    const body = JSON.stringify(event());
    const timestamp = Math.floor(NOW / 1000);
    const header = createWebhookSignatureHeader(SECRET, timestamp, body);

    expect(
      verifyWebhookSignature({
        body: `${body} `,
        signatureHeader: header,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: header,
        secret: "another-secret-that-is-long-enough",
        now: NOW,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: "garbage",
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance", () => {
    const body = JSON.stringify(event());
    const timestamp = Math.floor(NOW / 1000) - 600;
    const header = createWebhookSignatureHeader(SECRET, timestamp, body);

    expect(
      verifyWebhookSignature({
        body,
        signatureHeader: header,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rejects short secrets", () => {
    expect(() => signWebhook("short", 1, "{}")).toThrow(TypeError);
    expect(
      verifyWebhookSignature({
        body: "{}",
        signatureHeader: "t=1,v1=00",
        secret: "short",
        now: 1_000,
      }),
    ).toBe(false);
  });
});

describe("createPaymentWebhookEvent", () => {
  it("sanitizes QRIS, metadata, and raw provider rows", () => {
    const wh = createPaymentWebhookEvent("payment.settled", makePayment(), {
      createdAt: NOW,
    });

    expect(wh.id).toBe("pay_1:payment.settled");
    expect(wh.createdAt).toBe(new Date(NOW).toISOString());
    expect(wh.data).toMatchObject({
      paymentId: "pay_1",
      reference: "order-1",
      status: "paid",
      baseAmount: 10_000,
      uniqueOffset: 1,
      uniqueAmount: 10_001,
      transaction: {
        id: "tx_1",
        status: "settlement",
        grossAmount: 10_001,
      },
    });

    const serialized = JSON.stringify(wh);
    expect(serialized).not.toContain("sensitive-qris-payload");
    expect(serialized).not.toContain("secret@example.com");
    expect(serialized).not.toContain("provider-secret");
  });
});

describe("validateWebhookUrl", () => {
  it.each([
    ["http://example.com/webhook", {}],
    ["https://user:pass@example.com/webhook", {}],
    ["https://localhost/webhook", {}],
    ["https://metadata.google.internal/computeMetadata", {}],
    ["https://127.0.0.1/webhook", {}],
    ["https://169.254.169.254/latest/meta-data", {}],
    ["https://10.0.0.1/webhook", {}],
    ["https://192.168.1.1/webhook", {}],
    ["https://[::1]/webhook", {}],
    ["https://[fe80::1]/webhook", {}],
    ["https://[::ffff:127.0.0.1]/webhook", {}],
    [
      "https://public.example/webhook",
      { resolveHostname: async () => [{ address: "127.0.0.1" }] },
    ],
  ])("rejects unsafe destination %s", async (url, options) => {
    await expect(
      validateWebhookUrl(url, options as never),
    ).rejects.toBeInstanceOf(WebhookSecurityError);
  });

  it("accepts a public HTTPS host after resolving every address", async () => {
    const url = await validateWebhookUrl("https://hooks.example.com/pay", {
      resolveHostname: publicResolver,
    });
    expect(url.toString()).toBe("https://hooks.example.com/pay");
  });

  it("accepts public IPv4 and IPv6 literals without DNS", async () => {
    await expect(
      validateWebhookUrl("https://8.8.8.8/hook"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      validateWebhookUrl("https://[2001:4860:4860::8888]/hook"),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects a whole resolution set if any address is private", async () => {
    await expect(
      validateWebhookUrl("https://mixed.example/hook", {
        resolveHostname: async () => [
          { address: "8.8.8.8" },
          { address: "10.0.0.5" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
  });

  it("supports explicit local development overrides", async () => {
    await expect(
      validateWebhookUrl("http://127.0.0.1:8080/hook", {
        allowHttp: true,
        allowPrivateNetworks: true,
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("classifies reserved addresses", () => {
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
    expect(isBlockedAddress("100.64.0.1")).toBe(true);
    expect(isBlockedAddress("172.16.0.1")).toBe(true);
    expect(isBlockedAddress("203.0.113.1")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("deliverWebhook", () => {
  it("signs the exact body and sends a stable idempotency key", async () => {
    const requests: Array<{
      url: string;
      init: RequestInit;
    }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return makeResponse(200);
    }) as unknown as typeof fetch;

    const result = await deliverWebhook({
      url: "https://hooks.example.com/pay",
      secret: SECRET,
      event: event(),
      now: () => NOW,
      fetch: fetchImpl,
      resolveHostname: publicResolver,
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ok: true, attempts: 1, status: 200 });
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers["x-merchantid-idempotency-key"]).toBe("evt_1");
    expect(headers["x-merchantid-event"]).toBe("payment.settled");
    expect(
      verifyWebhookSignature({
        body: String(requests[0]!.init.body),
        signatureHeader: headers["x-merchantid-signature"]!,
        secret: SECRET,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("retries retryable failures with the same idempotency key", async () => {
    const keys: string[] = [];
    const delays: number[] = [];
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      const headers = init.headers as Record<string, string>;
      keys.push(headers["x-merchantid-idempotency-key"]!);
      return calls === 1 ? makeResponse(503) : makeResponse(204);
    }) as unknown as typeof fetch;

    const result = await deliverWebhook({
      url: "https://hooks.example.com/pay",
      secret: SECRET,
      event: event(),
      maxAttempts: 3,
      baseDelayMs: 100,
      jitterRatio: 0,
      now: () => NOW,
      random: () => 0.5,
      fetch: fetchImpl,
      resolveHostname: publicResolver,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result).toMatchObject({ ok: true, attempts: 2, status: 204 });
    expect(keys).toEqual(["evt_1", "evt_1"]);
    expect(delays).toEqual([100]);
  });

  it("does not retry a non-retryable 4xx", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return makeResponse(400);
    }) as unknown as typeof fetch;

    const result = await deliverWebhook({
      url: "https://hooks.example.com/pay",
      secret: SECRET,
      event: event(),
      maxAttempts: 4,
      fetch: fetchImpl,
      resolveHostname: publicResolver,
      sleep: async () => {},
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      status: 400,
      error: { code: "HTTP_ERROR", retryable: false },
    });
  });

  it("does not follow redirects", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return makeResponse(302, { location: "http://127.0.0.1/internal" });
    }) as unknown as typeof fetch;

    const result = await deliverWebhook({
      url: "https://hooks.example.com/pay",
      secret: SECRET,
      event: event(),
      fetch: fetchImpl,
      resolveHostname: publicResolver,
      sleep: async () => {},
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "REDIRECT_BLOCKED", retryable: false },
    });
  });

  it("times out and reports a retryable failure", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;

    const result = await deliverWebhook({
      url: "https://hooks.example.com/pay",
      secret: SECRET,
      event: event(),
      maxAttempts: 1,
      timeoutMs: 5,
      fetch: fetchImpl,
      resolveHostname: publicResolver,
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      error: { code: "TIMEOUT", retryable: true },
    });
  });

  it("rejects an unsafe URL before calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      deliverWebhook({
        url: "https://127.0.0.1/hook",
        secret: SECRET,
        event: event(),
        fetch: fetchImpl as unknown as typeof fetch,
        resolveHostname: publicResolver,
      }),
    ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts no-secret error messages", async () => {
    const fetchImpl = (async () =>
      makeResponse(500)) as unknown as typeof fetch;
    const result = await deliverWebhook({
      url: "https://hooks.example.com/pay",
      secret: SECRET,
      event: event(),
      maxAttempts: 1,
      fetch: fetchImpl,
      resolveHostname: publicResolver,
      sleep: async () => {},
    });

    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
