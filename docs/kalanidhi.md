# KalaNidhi hardening guide

This document describes the hardened `kalanidhi-hardening` branch of
[`FarelRA/merchantid`](https://github.com/FarelRA/merchantid), forked from
[`alhifnywahid/merchantid`](https://github.com/alhifnywahid/merchantid).

The upstream project is MIT-licensed and unofficial. This fork keeps the MIT
license and attribution; it adds fail-closed settlement matching, exact amount
normalization, deterministic reconciliation, a durable store, signed webhooks,
and an encrypted session vault. It does **not** add obfuscation, telemetry,
provider credentials, or new runtime dependencies.

> **Unofficial private API warning**
>
> The GoPay/GoBiz and Shopee adapters call private, undocumented endpoints that
> the merchant web dashboards use. They can change or disappear without notice.
> Use them only with merchant accounts you own and are authorized to automate.
> Automated access may violate the provider's terms of service. This project is
> not affiliated with, endorsed by, or supported by GoPay, GoBiz, Gojek, or
> Shopee. You are responsible for the legal, tax, and contractual consequences
> of using it.

## 1. Integration contract

The intended integration is a private, server-side payment gateway:

1. Merchant backend creates a payment intent with a nominal amount.
2. `PaymentService.createPayment()` allocates a unique final amount and, when a
   static QRIS is configured, builds a dynamic QRIS payload.
3. The buyer transfers the exact `uniqueAmount`.
4. A scheduler (or the built-in timer) calls `PaymentService.tick()`.
5. `tick()` fetches the provider feed, settles exactly one payment per provider
   transaction, expires stale payments, and emits events.
6. The gateway delivers signed webhooks and updates the order state.

```ts
import {
  GopayProvider,
  type CreatePaymentInput,
  type Payment,
} from "merchantid";
import { SqlitePaymentStore } from "merchantid/sqlite";

const store = new SqlitePaymentStore({
  path: "/var/lib/kalanidhi/payments.sqlite",
});

const gopay = new GopayProvider({
  merchantId: process.env.GOPAY_MERCHANT_ID,
  staticQris: process.env.GOPAY_STATIC_QRIS,
  session: await loadSessionFromVault(),
  store,
  onTokenRefreshed: async (session) => {
    await saveSessionToVault(session);
  },
  payment: {
    defaultExpiryMs: 10 * 60 * 1_000,
    clockSkewMs: 60_000,
    maxUniqueOffset: 999,
  },
});

const payments = gopay.payments();

payments.on("paid", (payment: Payment) => {
  // Persist the local order transition and enqueue a signed webhook. Do not
  // treat this listener as a durability boundary; the store write already
  // happened before the event was emitted.
  void onSettled(payment);
});

payments.on("expired", (payment: Payment) => {
  void onExpired(payment);
});

payments.on("error", (error: Error) => {
  // Log the message only. Never log provider payloads, tokens, or QRIS.
  console.error("reconciliation error", error.message);
});
```

The payment core is runtime-agnostic and has no runtime dependencies. The
`merchantid/sqlite`, `merchantid/webhook`, and `merchantid/vault` subpaths are
optional Node-only integrations and must not be imported into browser or Edge
bundles.

### Payment lifecycle

`Payment.status` is one of `pending`, `paid`, `expired`, or `cancelled`.
`cancelPayment()` only cancels a pending payment; it returns the stored payment
unchanged when the payment is already terminal, so a cancellation racing a
settlement cannot un-pay an order.

## 2. Exact settlement matching

A transaction settles a payment only when **all** of these are true:

| Check     | Rule                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amount    | `transaction.grossAmount === payment.uniqueAmount`, whole rupiah, safe positive integer                                                                                       |
| Status    | an explicit success allow-list: `settlement`, `settle`, `settled`, `capture`, `captured`, `success`, `succeeded`, `paid`, `completed`, `complete` (case-insensitive, trimmed) |
| Timestamp | parseable and inside `createdAt - clockSkewMs` .. `expiresAt + clockSkewMs`                                                                                                   |
| Identity  | the provider transaction id is consumed at most once                                                                                                                          |

Fail-closed rules:

- Missing, empty, unknown, or unparseable statuses do **not** settle.
- `refund`, `refunded`, `partial_refund`, `void`, `failed`, `deny`, `cancel`,
  `expire`, `chargeback`, and `reversed` do **not** settle.
- A missing or malformed transaction timestamp does **not** fall back to
  amount + status. It cannot settle.
- Only `grossAmount` is used. `realGrossAmount` is informational and is never
  used for matching, so fee-adjusted or duplicate amount fields cannot settle
  an order.
- A fractional rupiah or raw minor-unit value cannot match an integer payment
  intent.

`reconcile()` is deterministic: it sorts payments by creation time/id and
transactions by settleability, timestamp, id, and amount. It consumes each
provider transaction id once per call, even if the feed returns duplicate rows.
When two defective active payments share an amount, the oldest payment wins.
`PaymentService` additionally remembers consumed transaction ids across ticks
and, with a durable store, claims them across process restarts.

### Clock skew and expiry

`clockSkewMs` widens both ends of the window and delays expiry by the same
amount. Expiry happens only after `expiresAt + clockSkewMs`, the exact moment
the matcher stops accepting transactions. Keep servers on NTP; skew is a
tolerance, not a substitute for correct clocks.

## 3. Unique amount behavior

- Offsets are whole rupiah in `[1, maxUniqueOffset]` (default 999).
- Uniqueness is enforced on the final amount `baseAmount + offset`, per
  `PaymentScope` (`provider` + optional `accountId` + `merchantId`).
- The smallest free offset is chosen. Different base amounts can never collide
  on the same final amount.
- When a payment leaves the active set, its amount is quarantined for
  `2 * clockSkewMs` so an old transaction still inside its matching window
  cannot settle a newly created order with the reused amount. `PaymentService`
  keeps this quarantine in the store when the store implements
  `quarantineAmount()` + `listQuarantinedAmounts()` (the SQLite adapter does, so
  it survives a restart) and only falls back to a process-local map otherwise.
- `InMemoryPaymentStore` and `SqlitePaymentStore` both reject a duplicate active
  amount with `AMOUNT_CONFLICT`. The SQLite adapter enforces it with a partial
  unique index, including across processes, and additionally rejects a pending
  payment whose amount is still quarantined.
- Exhausting the window throws `AMOUNT_POOL_EXHAUSTED`. Do not silently increase
  the offset window beyond what your buyers will tolerate; instead expire or
  reconcile stale orders.

## 4. Durable store and idempotency

`merchantid/sqlite` uses Node's built-in `node:sqlite` (no runtime dependency).
It requires **Node >= 22.13**; the rest of the library still supports Node 18.

```ts
import { SqlitePaymentStore } from "merchantid/sqlite";

const store = new SqlitePaymentStore({
  path: "/var/lib/kalanidhi/payments.sqlite",
  busyTimeoutMs: 5_000,
  wal: true,
});

// Close on shutdown after stopping the poller.
process.on("SIGTERM", () => {
  store.close();
});
```

Existing databases created by an earlier version of the adapter upgrade in place
when opened: the adapter only adds the `quarantined_amounts` table and its
index, and bumps `PRAGMA user_version` to 2. No row is rewritten.

What it guarantees:

- One pending payment per `(scope, final amount)` via a partial unique index.
- `transition()` is an atomic compare-and-set. It checks the expected status,
  writes the terminal status, claims the provider transaction id, and records
  the freed-amount quarantine inside one `BEGIN IMMEDIATE` transaction.
- A provider transaction id can settle at most one payment, even after a process
  restart.
- A freed unique amount stays unavailable for `2 * clockSkewMs` across restarts:
  the deadline lives in the `quarantined_amounts` table, keyed by
  `(scope, amount)`, and `create()` refuses a pending payment whose amount is
  still quarantined even if the caller read the active set before the amount was
  freed. Re-quarantining never shortens an existing deadline.
- `hasConsumedTransaction()` exposes the durable replay guard.
- `pruneConsumedTransactions(beforeMs)` removes claims older than the rolling
  feed lookback. Run it after the lookback, never before.
- `quarantineAmount()`, `isAmountQuarantined()`, `listQuarantinedAmounts()`, and
  `pruneQuarantine(beforeMs)` expose the quarantine directly.
  `PaymentService` prunes lazily on each `createPayment()`, so scheduled pruning
  is optional; it only keeps the table smaller.

Idempotency rules for the gateway:

- Treat `PaymentService` writes as the source of truth. Emit downstream effects
  only after the store transition succeeds.
- Consumer webhooks must deduplicate on `id` / `X-MerchantId-Idempotency-Key`.
- Do not mutate a settled payment back to pending. Refunds are a separate
  reconciliation process (see section 7).
- If you implement a custom `PaymentStore`, implement `transition()` and the
  same unique constraint. Without it, only a single process is safe.
- For restart-safe quarantine, also implement `quarantineAmount()`,
  `listQuarantinedAmounts()` and `pruneQuarantine()`, and honour
  `PaymentTransition.quarantineUntil` inside `transition()`. A store without
  them still works, but the freed-amount window is then process-local and a
  restart can hand the amount out again.

## 5. Session storage and the vault

`merchantid/vault` provides AES-256-GCM envelopes for `SessionState`
(access token, refresh token, token type, optional expiry, stable device id).
It uses `node:crypto` and is Node-only.

```ts
import { SessionVault } from "merchantid/vault";

// Load the key from a secret manager, not from the database or repository.
const vault = SessionVault.fromPassphrase(
  process.env.SESSION_VAULT_PASSPHRASE!,
);
// Or: SessionVault.fromKey(keyBytes32);

const envelope = vault.seal({
  tokens: {
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresAt,
  },
  deviceId,
});

// Persist only the envelope.
await secretStore.put("gopay-session", envelope);

// Later:
const session = vault.open(envelope);
```

Details:

- A fresh 12-byte IV is used for every seal; identical sessions produce
  different ciphertext.
- The envelope carries a random 16-byte scrypt salt in passphrase mode, so a
  restarted process can open old envelopes.
- The envelope header and an optional application context are authenticated as
  AAD. A context mismatch fails authentication.
- Errors are generic (`DECRYPT_FAILED`) and never contain the passphrase,
  tokens, device id, key, or ciphertext.
- Do not log envelopes, tokens, cookies, OTPs, or QRIS payloads.
- Keep the encryption key outside the store that holds the envelope. Rotate
  keys by re-sealing sessions under a new vault.

`InMemoryPaymentStore` is for tests and single-process development only. It does
not survive a restart.

## 6. Webhooks

`merchantid/webhook` delivers `payment.settled`, `payment.expired`, and
`payment.failed` events with an HMAC-SHA256 signature.

`PaymentService` emits `paid` and `expired`; it has no `failed` payment status.
Use `payment.failed` for an application-level order failure (for example, an
operator rejects an unpaid order), not as a settlement status. Feed errors are
surfaced on the service's `error` channel.

```ts
import { createPaymentWebhookEvent, deliverWebhook } from "merchantid/webhook";

const event = createPaymentWebhookEvent("payment.settled", payment);
const result = await deliverWebhook({
  url: "https://merchant.example.com/hooks/kalanidhi",
  secret: process.env.WEBHOOK_SECRET!,
  event,
  timeoutMs: 5_000,
  maxAttempts: 4,
});
```

### Payload

```json
{
  "id": "pay_01J...:payment.settled",
  "type": "payment.settled",
  "createdAt": "2026-11-11T10:00:00.000Z",
  "data": {
    "paymentId": "pay_01J...",
    "reference": "order-42",
    "status": "paid",
    "baseAmount": 10000,
    "uniqueOffset": 1,
    "uniqueAmount": 10001,
    "createdAt": "2026-11-11T09:59:00.000Z",
    "expiresAt": "2026-11-11T10:04:00.000Z",
    "scope": { "provider": "gopay", "merchantId": "G000000001" },
    "transaction": {
      "id": "tx_...",
      "orderId": "QRIS-...",
      "status": "SETTLEMENT",
      "grossAmount": 10001,
      "transactionTime": "2026-11-11T10:00:01+07:00"
    }
  }
}
```

The payload deliberately excludes `qrString`, `metadata`, and the provider
`raw` row.

### Headers and signature

```
X-MerchantId-Event: payment.settled
X-MerchantId-Event-Id: pay_01J...:payment.settled
X-MerchantId-Idempotency-Key: pay_01J...:payment.settled
X-MerchantId-Signature: t=1762855200,v1=<hex hmac>
```

The signed material is the ASCII string `${t}.${rawBody}`, where `t` is Unix
seconds. HMAC is SHA-256 with the shared secret. Verify before parsing the body:

```ts
import { verifyWebhookSignature } from "merchantid/webhook";

const ok = verifyWebhookSignature({
  body: rawBody,
  signatureHeader: req.headers["x-merchantid-signature"]!,
  secret: process.env.WEBHOOK_SECRET!,
  toleranceSeconds: 300,
});
if (!ok) return res.status(401).end();
```

`verifyWebhookSignature` is constant-time and also rejects stale timestamps.
Secrets must be at least 16 bytes; use 32 random bytes in production.

Delivery behavior:

- Default timeout 5s, four total attempts, exponential backoff with jitter.
- Retries 408, 425, 429, and 5xx; does not retry other 4xx.
- Honors `Retry-After` up to the configured maximum.
- Uses the same event id and idempotency key on every attempt.
- Does not follow redirects, so a redirect cannot bypass the SSRF check.

### SSRF protection

`validateWebhookUrl` enforces HTTPS, rejects URL credentials and
localhost/`.internal`/cloud-metadata hosts, resolves the hostname, and rejects
the URL if **any** resolved address is loopback, private, link-local, CGNAT,
multicast, reserved, or a known IPv6 transition range. Redirects are disabled.

Residual risk: validation and `fetch` resolve DNS separately, so DNS rebinding
is possible in principle. Pair this utility with an egress firewall or HTTP
proxy that applies the same deny-list. Do not enable `allowPrivateNetworks` in
production; it exists only for a local development receiver.

## 7. Refund policy

This fork does **not** add a provider refund network call. Upstream contains no
verified refund endpoint for GoPay/GoBiz or Shopee, and inventing one would be
unsafe for a money path.

Refunds are manual:

1. Look up the settled `Payment` and its `transaction.id`.
2. Refund from the GoBiz merchant dashboard (or the provider's official
   merchant support channel) using the original transaction reference.
3. Record the refund in your own ledger with payment id, transaction id,
   amount, reason, operator, and timestamp.
4. Keep the `Payment` status `paid`. Do not silently flip it to `expired` or
   `cancelled`; use a separate refund record so the settlement audit trail stays
   intact.
5. Notify the order system through your own audited process. Do not send a
   `payment.settled` webhook for a refund.

If a future provider exposes a verified refund endpoint, add it as a separate,
tested capability with explicit idempotency and reconciliation. Do not infer an
endpoint from dashboard network traffic without confirming its semantics.

## 8. Deployment notes

- **Node:** Node 18+ for the core, webhook, and vault subpaths. Node 22.13+ for
  `merchantid/sqlite`.
- **Single process vs multi-process:** the in-memory store is single-process
  only. For multiple replicas, use `SqlitePaymentStore` on shared storage or a
  custom store with an equivalent atomic transition, unique index, and durable
  quarantine. A store without the optional quarantine methods still reconciles,
  but a process restart forgets which amounts are still inside their
  `2 * clockSkewMs` window.
- **SQLite:** enable WAL (default for files), run regular backups, and place the
  database on a local filesystem, not a network share. Stop the poller before
  closing the store. Keep `busyTimeoutMs` below your request timeout.
- **Polling:** use one scheduler per scope. If you call `tick()` from an external
  scheduler, add jitter and backoff so replicas do not synchronize on the
  provider feed. `tick()` is re-entrant safe: a second concurrent call returns
  `{ paid: [], expired: [] }` instead of duplicating work.
- **Clock:** run NTP. Keep `clockSkewMs` small (30-120s) and make sure the
  payment expiry is longer than the scheduler interval plus feed indexing delay.
- **Secrets:** load the webhook secret, session vault key, and provider session
  from a secret manager. Never commit `.env` files, tokens, cookies, OTPs,
  QRIS payloads, or database files.
- **Egress:** restrict outbound traffic to the provider hosts and your webhook
  destinations. Apply the same private-address deny-list at the firewall.
- **Observability:** log event ids, payment ids, status transitions, and error
  codes. Never log payloads that contain credentials or QRIS. Alert on repeated
  `AMOUNT_CONFLICT`, `DECRYPT_FAILED`, feed errors, and webhook retry exhaustion.
- **Retention:** keep settled payment and transaction claims at least as long as
  the provider's dispute/chargeback window. Prune consumed transaction claims
  only after the rolling feed lookback can no longer return them.

### External scheduler example

```ts
import { jitteredBackoff } from "merchantid";

let failures = 0;

async function scheduledTick() {
  try {
    await gopay.payments().tick();
    failures = 0;
  } catch {
    failures += 1;
  }
  const delay = jitteredBackoff(failures, {
    baseMs: 3_000,
    maxMs: 60_000,
    jitterRatio: 0.2,
  });
  setTimeout(scheduledTick, delay);
}
```

`PaymentService.tick()` already catches feed errors and emits them on the
`error` channel; the `try/catch` above is for scheduler-level failures. Do not
run both the built-in `start()` timer and an external scheduler for the same
service instance.

## 9. Behavior changes from upstream

These are intentional and covered by tests:

- Settlement matching is fail-closed for missing/unknown status and
  unparseable timestamps.
- Only `grossAmount` is used; `realGrossAmount` no longer settles a payment.
- GoPay `gross_amount` is normalized from sen exactly once. Malformed,
  fractional, non-numeric, negative, unsafe, and non-IDR rows are dropped
  instead of being coerced to 0.
- `reconcile()` ordering is deterministic and duplicate transaction ids are
  consumed once.
- `PaymentStore` gained optional atomic `transition()` and
  `hasConsumedTransaction()` capabilities. Custom stores without them remain
  single-process safe only.
- `PaymentStore` also gained optional `quarantineAmount()`,
  `isAmountQuarantined()`, `listQuarantinedAmounts()`, and `pruneQuarantine()`
  capabilities, plus `PaymentTransition.quarantineUntil` so a durable store can
  record the freed-amount window atomically with the status change.
- The `2 * clockSkewMs` quarantine is durable with `SqlitePaymentStore`:
  `PaymentService` falls back to a process-local map only for stores that lack
  the quarantine methods, and `create()` re-checks the table inside its write
  transaction so a restart or a peer process cannot reuse a quarantined amount.
- `InMemoryPaymentStore` now enforces active-amount uniqueness and rejects
  updates for unknown payments.

## 10. License and attribution

This fork remains MIT-licensed. See `LICENSE` and the upstream repository for
the original copyright and attribution. Keep the upstream notice in
redistributions. The hardening changes are provided as-is, without warranty;
review them against your own threat model and provider agreement before moving
real money.
