import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Payment, PaymentScope } from "../core/types.js";
import { jitteredBackoff } from "../utils/polling.js";

/**
 * Signed webhook delivery for payment lifecycle events.
 *
 * Node-only because SSRF protection must resolve DNS and HMAC uses
 * `node:crypto`. It is published as the `merchantid/webhook` subpath so the
 * main entry remains runtime-agnostic.
 */

export type WebhookEventType =
  "payment.settled" | "payment.expired" | "payment.failed";

export interface PaymentWebhookTransaction {
  id: string;
  orderId: string;
  status: string;
  grossAmount: number;
  transactionTime: string;
  settlementTime?: string;
}

export interface PaymentWebhookScope {
  provider: string;
  merchantId: string;
  accountId?: string;
}

/**
 * Sanitized payment payload. Deliberately excludes `qrString`, `metadata`, and
 * the provider `raw` row: webhooks leave the trust boundary and must not carry
 * QR payloads, customer data, or provider credentials.
 */
export interface PaymentWebhookData {
  paymentId: string;
  reference?: string;
  status: Payment["status"];
  baseAmount: number;
  uniqueOffset: number;
  uniqueAmount: number;
  createdAt: string;
  expiresAt: string;
  scope?: PaymentWebhookScope;
  transaction?: PaymentWebhookTransaction;
}

export interface WebhookEvent<T = unknown> {
  /** Stable event id; also the default idempotency key. */
  id: string;
  type: WebhookEventType;
  /** ISO-8601 creation time. */
  createdAt: string;
  data: T;
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function sanitizeScope(scope?: PaymentScope): PaymentWebhookScope | undefined {
  if (!scope) return undefined;
  return {
    provider: scope.provider,
    merchantId: scope.merchantId,
    ...(scope.accountId !== undefined ? { accountId: scope.accountId } : {}),
  };
}

/** Build a sanitized webhook event for a payment lifecycle transition. */
export function createPaymentWebhookEvent(
  type: WebhookEventType,
  payment: Payment,
  options: { id?: string; createdAt?: number } = {},
): WebhookEvent<PaymentWebhookData> {
  return {
    id: options.id ?? `${payment.id}:${type}`,
    type,
    createdAt: toIso(options.createdAt ?? Date.now()),
    data: {
      paymentId: payment.id,
      reference: payment.reference,
      status: payment.status,
      baseAmount: payment.baseAmount,
      uniqueOffset: payment.uniqueOffset,
      uniqueAmount: payment.uniqueAmount,
      createdAt: toIso(payment.createdAt),
      expiresAt: toIso(payment.expiresAt),
      ...(payment.scope ? { scope: sanitizeScope(payment.scope) } : {}),
      ...(payment.transaction
        ? {
            transaction: {
              id: payment.transaction.id,
              orderId: payment.transaction.orderId,
              status: payment.transaction.status,
              grossAmount: payment.transaction.grossAmount,
              transactionTime: payment.transaction.transactionTime,
              settlementTime: payment.transaction.settlementTime,
            },
          }
        : {}),
    },
  };
}

const MIN_SECRET_BYTES = 16;
const DEFAULT_TOLERANCE_SECONDS = 300;

function assertSecret(secret: string): void {
  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES
  ) {
    throw new TypeError(
      `Webhook secret must be at least ${MIN_SECRET_BYTES} bytes of high-entropy data`,
    );
  }
}

/**
 * HMAC-SHA256 over `${timestamp}.${body}`. The timestamp is part of the signed
 * material so a captured request cannot be replayed forever.
 */
export function signWebhook(
  secret: string,
  timestamp: number,
  body: string,
): string {
  assertSecret(secret);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError(
      "timestamp must be a non-negative integer (unix seconds)",
    );
  }
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
}

/** Header value: `t=<unix seconds>,v1=<hex hmac>`. */
export function createWebhookSignatureHeader(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return `t=${timestamp},v1=${signWebhook(secret, timestamp, body)}`;
}

export interface VerifyWebhookSignatureOptions {
  body: string;
  /** Raw `X-MerchantId-Signature` header value. */
  signatureHeader: string;
  secret: string;
  /** Permitted clock difference. Default: 300 seconds. */
  toleranceSeconds?: number;
  /** Injectable clock in milliseconds. */
  now?: number;
}

/**
 * Verify a webhook signature and timestamp. Returns `false` for every failure
 * mode (malformed header, stale timestamp, wrong secret) instead of leaking
 * which part failed.
 */
export function verifyWebhookSignature(
  options: VerifyWebhookSignatureOptions,
): boolean {
  try {
    assertSecret(options.secret);
  } catch {
    return false;
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance < 0) return false;

  const parts = new Map<string, string>();
  for (const part of options.signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0 || parts.has(key)) {
      return false;
    }
    parts.set(key, value);
  }

  const timestampValue = parts.get("t");
  const signature = parts.get("v1");
  if (!timestampValue || !signature || !/^\d+$/.test(timestampValue)) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp)) return false;

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const expected = Buffer.from(
    signWebhook(options.secret, timestamp, options.body),
    "hex",
  );
  const received = Buffer.from(signature, "hex");
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

// ---------------------------------------------------------------------------
// SSRF-safe URL validation
// ---------------------------------------------------------------------------

export interface ResolvedHostAddress {
  address: string;
  family?: number;
}

export type HostResolver = (
  hostname: string,
) => Promise<readonly ResolvedHostAddress[]>;

export interface WebhookUrlOptions {
  /** Allow plain HTTP. Default: false (HTTPS only). */
  allowHttp?: boolean;
  /**
   * Resolve DNS and reject private/reserved destinations. Default: true.
   * Disabling it is only safe in tests where no network request is made.
   */
  resolveDns?: boolean;
  /** Test seam. Defaults to `node:dns/promises` lookup with all addresses. */
  resolveHostname?: HostResolver;
  /**
   * DANGEROUS: allow loopback/private targets. Intended only for a local
   * development receiver. Never enable in production.
   */
  allowPrivateNetworks?: boolean;
}

export type WebhookSecurityErrorCode =
  | "INVALID_URL"
  | "INSECURE_PROTOCOL"
  | "URL_CREDENTIALS"
  | "BLOCKED_HOST"
  | "BLOCKED_ADDRESS"
  | "DNS_LOOKUP_FAILED";

export class WebhookSecurityError extends Error {
  public readonly code: WebhookSecurityErrorCode;

  constructor(code: WebhookSecurityErrorCode, message: string) {
    super(message);
    this.name = "WebhookSecurityError";
    this.code = code;
  }
}

const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "localdomain",
  "svc",
  "cluster.local",
];

const BLOCKED_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
  "0.0.0.0",
  "::",
  "::1",
]);

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    octets.push(octet);
  }
  return octets;
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return true;
  const [a, b, c] = octets as [number, number, number, number];

  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol / TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

function parseEmbeddedIpv4FromIpv6(address: string): string | undefined {
  const lower = address.toLowerCase();
  const dotted = lower.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1]) return dotted[1];

  // ::ffff:7f00:1 style IPv4-mapped address.
  const mapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] && mapped[2]) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return undefined;
}

/** Whether an IP literal is loopback, private, link-local, or reserved. */
export function isBlockedAddress(address: string): boolean {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");
  const family = isIP(trimmed);
  if (family === 4) return isBlockedIpv4(trimmed);
  if (family !== 6) return true;

  const lower = trimmed.toLowerCase();
  const embedded = parseEmbeddedIpv4FromIpv6(lower);
  if (embedded) return isBlockedIpv4(embedded);

  if (lower === "::" || lower === "::1") return true;

  const firstGroup = lower.split(":")[0] ?? "";
  const firstByte = Number.parseInt(
    firstGroup.padStart(4, "0").slice(0, 2),
    16,
  );
  if (Number.isNaN(firstByte)) return true;

  return (
    firstByte === 0xfc || // unique local fc00::/7
    firstByte === 0xfd ||
    (firstByte === 0xfe && /^fe[89ab]/.test(firstGroup)) || // link-local fe80::/10
    firstByte === 0xff || // multicast
    lower.startsWith("2001:db8") || // documentation
    lower.startsWith("2001:10") || // ORCHID
    lower.startsWith("2001:2") || // benchmarking
    lower.startsWith("2001::") || // Teredo
    lower.startsWith("2002:") || // 6to4, may embed private IPv4
    lower.startsWith("64:ff9b") || // NAT64
    lower.startsWith("100::") // discard
  );
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.includes("%")) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

async function defaultResolveHostname(
  hostname: string,
): Promise<readonly ResolvedHostAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

/**
 * Validate a webhook destination before any request is made.
 *
 * Blocks non-HTTPS URLs, credentials in the URL, localhost/*.internal names,
 * cloud metadata hosts, and every loopback/private/link-local/reserved IPv4 or
 * IPv6 address. Hostnames are resolved and *all* answers are checked, so a
 * public name pointing at `127.0.0.1` is rejected.
 *
 * Residual risk: this check and `fetch` perform separate DNS lookups, so a
 * determined attacker controlling DNS could rebind between them. Pair this
 * with an egress firewall / HTTP proxy that applies the same deny-list. See
 * `docs/kalanidhi.md`.
 *
 * @throws {WebhookSecurityError} when the destination is unsafe.
 */
export async function validateWebhookUrl(
  input: string,
  options: WebhookUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebhookSecurityError("INVALID_URL", "Webhook URL is not valid");
  }

  if (
    url.protocol !== "https:" &&
    !(options.allowHttp && url.protocol === "http:")
  ) {
    throw new WebhookSecurityError(
      "INSECURE_PROTOCOL",
      "Webhook URL must use HTTPS",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebhookSecurityError(
      "URL_CREDENTIALS",
      "Webhook URL must not contain credentials",
    );
  }
  if (url.port === "0") {
    throw new WebhookSecurityError(
      "INVALID_URL",
      "Webhook URL port is invalid",
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (options.allowPrivateNetworks) return url;

  if (isBlockedHostname(hostname)) {
    throw new WebhookSecurityError(
      "BLOCKED_HOST",
      `Webhook host ${hostname} is not a public destination`,
    );
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedAddress(hostname)) {
      throw new WebhookSecurityError(
        "BLOCKED_ADDRESS",
        `Webhook address ${hostname} is not a public destination`,
      );
    }
    return url;
  }

  if (options.resolveDns === false) return url;

  const resolver = options.resolveHostname ?? defaultResolveHostname;
  let addresses: readonly ResolvedHostAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new WebhookSecurityError(
      "DNS_LOOKUP_FAILED",
      "Webhook hostname could not be resolved",
    );
  }

  if (addresses.length === 0) {
    throw new WebhookSecurityError(
      "DNS_LOOKUP_FAILED",
      "Webhook hostname resolved to no addresses",
    );
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new WebhookSecurityError(
        "BLOCKED_ADDRESS",
        "Webhook hostname resolves to a non-public address",
      );
    }
  }

  return url;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface WebhookDeliveryError {
  code:
    | "HTTP_ERROR"
    | "NETWORK_ERROR"
    | "TIMEOUT"
    | "REDIRECT_BLOCKED"
    | "INVALID_RESPONSE";
  message: string;
  retryable: boolean;
}

export interface WebhookDeliveryResult {
  ok: boolean;
  eventId: string;
  idempotencyKey: string;
  attempts: number;
  status?: number;
  error?: WebhookDeliveryError;
  durationMs: number;
}

export interface WebhookDeliveryOptions {
  url: string;
  /** At least 16 bytes. HMAC-SHA256 key. */
  secret: string;
  event: WebhookEvent;
  /** Stable across retries. Defaults to `event.id`. */
  idempotencyKey?: string;
  /** Total tries including the first. Default: 4. */
  maxAttempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  allowHttp?: boolean;
  /** DANGEROUS: allow private/loopback destinations for local development. */
  allowPrivateNetworks?: boolean;
  /** Disable DNS resolution checks. Default: true (resolve and check). */
  resolveDns?: boolean;
  /** Test seam / custom transport. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test seam for retry sleeps. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  resolveHostname?: HostResolver;
  /** Extra non-secret headers. Reserved headers cannot be overwritten. */
  headers?: Record<string, string>;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response, nowMs: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) {
    return Number(value.trim()) * 1_000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
}

/**
 * Deliver one webhook event with a signed, timestamped request.
 *
 * - Request body is serialized once, so the signature and retries cover the
 *   exact bytes the receiver sees.
 * - Every retry uses the same `Idempotency-Key` and event id.
 * - Timeouts abort the request; redirects are not followed (a redirect could
 *   bypass the SSRF check).
 * - Retries are bounded and use exponential backoff with jitter. 4xx responses
 *   other than 408/425/429 are not retried.
 *
 * @throws {WebhookSecurityError} before any network call when the URL is
 * unsafe. Callers should treat that as a configuration error, not a delivery
 * failure to retry.
 */
export async function deliverWebhook(
  options: WebhookDeliveryOptions,
): Promise<WebhookDeliveryResult> {
  if (!options.event || typeof options.event.id !== "string") {
    throw new TypeError("event with a string id is required");
  }
  assertSecret(options.secret);

  const maxAttempts = positiveInteger(
    options.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const baseDelayMs = nonNegativeNumber(
    options.baseDelayMs,
    DEFAULT_BASE_DELAY_MS,
    "baseDelayMs",
  );
  const maxDelayMs = nonNegativeNumber(
    options.maxDelayMs,
    DEFAULT_MAX_DELAY_MS,
    "maxDelayMs",
  );
  const jitterRatio = nonNegativeNumber(
    options.jitterRatio,
    0.2,
    "jitterRatio",
  );
  if (jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch is not available in this runtime");
  }
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const idempotencyKey = options.idempotencyKey ?? options.event.id;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    throw new TypeError("idempotencyKey must be a non-empty string");
  }
  const body = JSON.stringify(options.event);
  const startedAt = now();

  await validateWebhookUrl(options.url, {
    allowHttp: options.allowHttp,
    allowPrivateNetworks: options.allowPrivateNetworks,
    resolveDns: options.resolveDns,
    resolveHostname: options.resolveHostname,
  });

  let lastError: WebhookDeliveryError | undefined;
  let lastStatus: number | undefined;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timestamp = Math.floor(now() / 1000);

    try {
      const response = await fetchImpl(options.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          ...options.headers,
          "content-type": "application/json",
          "user-agent": "merchantid-webhook/1",
          "x-merchantid-event": options.event.type,
          "x-merchantid-event-id": options.event.id,
          "x-merchantid-idempotency-key": idempotencyKey,
          "x-merchantid-signature": createWebhookSignatureHeader(
            options.secret,
            timestamp,
            body,
          ),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = response.status;

      if (response.status >= 200 && response.status < 300) {
        return {
          ok: true,
          eventId: options.event.id,
          idempotencyKey,
          attempts: attempt,
          status: response.status,
          durationMs: now() - startedAt,
        };
      }

      if (response.status >= 300 && response.status < 400) {
        lastError = {
          code: "REDIRECT_BLOCKED",
          message:
            "Webhook endpoint returned a redirect; redirects are not followed",
          retryable: false,
        };
      } else {
        lastError = {
          code: "HTTP_ERROR",
          message: `Webhook endpoint returned HTTP ${response.status}`,
          retryable: isRetryableStatus(response.status),
        };
      }

      if (attempt < maxAttempts && lastError.retryable) {
        const serverDelay = retryAfterMs(response, now());
        const backoff = jitteredBackoff(attempt - 1, {
          baseMs: baseDelayMs,
          maxMs: maxDelayMs,
          jitterRatio,
          random: options.random,
        });
        await sleep(Math.min(maxDelayMs, Math.max(backoff, serverDelay ?? 0)));
        continue;
      }
      break;
    } catch {
      clearTimeout(timer);
      const aborted = controller.signal.aborted;
      lastError = {
        code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
        message: aborted
          ? `Webhook request timed out after ${timeoutMs}ms`
          : "Webhook request failed before a response was received",
        retryable: true,
      };
      if (attempt < maxAttempts) {
        const backoff = jitteredBackoff(attempt - 1, {
          baseMs: baseDelayMs,
          maxMs: maxDelayMs,
          jitterRatio,
          random: options.random,
        });
        await sleep(backoff);
        continue;
      }
    }
  }

  return {
    ok: false,
    eventId: options.event.id,
    idempotencyKey,
    attempts,
    status: lastStatus,
    error: lastError,
    durationMs: now() - startedAt,
  };
}
