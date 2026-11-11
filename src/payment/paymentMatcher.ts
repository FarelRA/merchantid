import type { MerchantTransaction, Payment } from "../core/types.js";

/**
 * Transaction statuses that may settle a payment.
 *
 * This is an allow-list, not a deny-list. The GoPay feed is a private,
 * undocumented API and its status vocabulary can grow without notice, so the
 * only safe default is to refuse anything that has not been explicitly
 * verified as money received. A payment that stays pending can be reconciled
 * by an operator; a payment that settles on `refund`, `failed`, or an empty
 * status cannot be un-settled safely.
 *
 * Compared case-insensitively after trimming.
 */
const SETTLED_STATUSES = new Set([
  "settlement",
  "settle",
  "settled",
  "capture",
  "captured",
  "success",
  "succeeded",
  "paid",
  "completed",
  "complete",
]);

/**
 * Statuses that are explicitly known not to represent captured money.
 *
 * They are already excluded by {@link SETTLED_STATUSES}; listing them keeps
 * the rejection contract readable and gives tests a stable set to pin.
 */
const REJECTED_STATUSES = new Set([
  "refund",
  "refunded",
  "partial_refund",
  "partial-refund",
  "partialrefund",
  "void",
  "voided",
  "failed",
  "failure",
  "deny",
  "denied",
  "cancel",
  "cancelled",
  "canceled",
  "expire",
  "expired",
  "pending",
  "authorize",
  "authorized",
  "chargeback",
  "reversed",
]);

/** Statuses this matcher will settle. Exported for adapters and diagnostics. */
export const SETTLEABLE_TRANSACTION_STATUSES: readonly string[] = Object.freeze(
  [...SETTLED_STATUSES],
);

/** Statuses this matcher will never settle. Exported for diagnostics. */
export const REJECTED_TRANSACTION_STATUSES: readonly string[] = Object.freeze([
  ...REJECTED_STATUSES,
]);

function normalizeStatus(status: unknown): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

/** Whether a provider status is verified as captured/settled money. */
export function isSettleableStatus(status: unknown): boolean {
  return SETTLED_STATUSES.has(normalizeStatus(status));
}

/** Whether a provider status is known to be non-settling. */
export function isRejectedStatus(status: unknown): boolean {
  return REJECTED_STATUSES.has(normalizeStatus(status));
}

/**
 * Parse a provider timestamp. Returns `undefined` for missing, empty, or
 * unparseable values; callers must treat that as "cannot verify".
 */
export function transactionTimeMs(
  transaction: MerchantTransaction,
): number | undefined {
  if (typeof transaction.transactionTime !== "string") return undefined;
  const value = transaction.transactionTime.trim();
  if (value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Determines whether a transaction settles a given pending payment.
 *
 * Matching rules, all of which are required:
 *
 * - The transaction amount (`grossAmount`, already normalized to whole rupiah
 *   by the provider adapter) must be exactly the payment's `uniqueAmount`.
 *   `realGrossAmount` is informational only; accepting two amount fields made
 *   it possible for a fee-adjusted or duplicate value to settle an order.
 * - The transaction status must be in the verified success allow-list. Empty,
 *   missing, unknown, `refund`, `partial_refund`, `void`, and `failed` values
 *   are rejected (fail closed).
 * - The transaction timestamp must parse and fall inside the payment window
 *   (`createdAt - clockSkewMs` .. `expiresAt + clockSkewMs`). A missing or
 *   malformed timestamp is treated as unverifiable, not as a match.
 *
 * The amount is the primary discriminator; uniqueness of amounts across active
 * payments is guaranteed by the allocator, so an exact amount match within the
 * window identifies the payer.
 */
export function matchesPayment(
  payment: Payment,
  transaction: MerchantTransaction,
  clockSkewMs = 60_000,
): boolean {
  if (
    !isPositiveSafeInteger(payment.uniqueAmount) ||
    !Number.isFinite(payment.createdAt) ||
    !Number.isFinite(payment.expiresAt)
  ) {
    return false;
  }

  // Single canonical amount field. It must already be whole rupiah; a raw
  // minor-unit value or a fractional rupiah can never match an integer intent.
  if (
    !isPositiveSafeInteger(transaction.grossAmount) ||
    transaction.grossAmount !== payment.uniqueAmount
  ) {
    return false;
  }

  // The amount scale is only meaningful for IDR. A non-IDR row in the IDR feed
  // means the provider changed its shape; refuse it rather than guessing.
  if (
    typeof transaction.currency !== "string" ||
    transaction.currency.trim().toUpperCase() !== "IDR"
  ) {
    return false;
  }

  if (!isSettleableStatus(transaction.status)) {
    return false;
  }

  const txTime = transactionTimeMs(transaction);
  if (txTime === undefined) {
    // Cannot verify the payment window. Do not fall back to amount + status:
    // an old transaction with the same amount must not settle a new order.
    return false;
  }

  const skew =
    typeof clockSkewMs === "number" && Number.isFinite(clockSkewMs)
      ? Math.max(0, clockSkewMs)
      : 0;
  const windowStart = payment.createdAt - skew;
  const windowEnd = payment.expiresAt + skew;
  return txTime >= windowStart && txTime <= windowEnd;
}

interface RankedTransaction {
  transaction: MerchantTransaction;
  time: number | undefined;
  settleable: boolean;
}

function rankTransaction(transaction: MerchantTransaction): RankedTransaction {
  return {
    transaction,
    time: transactionTimeMs(transaction),
    settleable: isSettleableStatus(transaction.status),
  };
}

/**
 * Deterministic transaction order.
 *
 * Provider feeds are commonly newest-first and may contain duplicate rows for
 * the same transaction id. Sorting by (settleable, timestamp, id, amount) makes
 * `reconcile` return the same assignment regardless of feed order, including
 * when two pending payments happen to share an amount. Unverifiable timestamps
 * sort last so they cannot win over a properly timestamped row.
 */
function compareRanked(
  left: RankedTransaction,
  right: RankedTransaction,
): number {
  if (left.settleable !== right.settleable) return left.settleable ? -1 : 1;

  if (left.time !== right.time) {
    if (left.time === undefined) return 1;
    if (right.time === undefined) return -1;
    return left.time - right.time;
  }

  const byId = left.transaction.id.localeCompare(right.transaction.id);
  if (byId !== 0) return byId;

  const byOrderId = String(left.transaction.orderId ?? "").localeCompare(
    String(right.transaction.orderId ?? ""),
  );
  if (byOrderId !== 0) return byOrderId;

  const byStatus = String(left.transaction.status ?? "").localeCompare(
    String(right.transaction.status ?? ""),
  );
  if (byStatus !== 0) return byStatus;

  return left.transaction.grossAmount - right.transaction.grossAmount;
}

function comparePayments(left: Payment, right: Payment): number {
  if (left.createdAt !== right.createdAt)
    return left.createdAt - right.createdAt;
  if (left.uniqueAmount !== right.uniqueAmount) {
    return left.uniqueAmount - right.uniqueAmount;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Given a list of pending payments and freshly fetched transactions, return the
 * pairs that match.
 *
 * Guarantees:
 * - A provider transaction id is consumed at most once, even if the feed
 *   returns duplicate rows for it.
 * - The result is deterministic: the same payment/transaction sets produce the
 *   same pairs regardless of input order.
 * - The oldest matching payment wins when two active payments are defective
 *   enough to share an amount.
 * - A transaction is only assigned inside its payment's window; an invalid
 *   timestamp or non-settling status never matches.
 */
export function reconcile(
  pending: readonly Payment[],
  transactions: readonly MerchantTransaction[],
  clockSkewMs = 60_000,
): Array<{ payment: Payment; transaction: MerchantTransaction }> {
  const matches: Array<{ payment: Payment; transaction: MerchantTransaction }> =
    [];
  const consumed = new Set<string>();

  const orderedPayments = [...pending]
    .filter((payment) => isPositiveSafeInteger(payment.uniqueAmount))
    .sort(comparePayments);

  // Invalid ids cannot be consumed; leaving them in would let two rows settle
  // two payments while looking like distinct transactions.
  const orderedTransactions = transactions
    .filter(
      (transaction) =>
        typeof transaction.id === "string" && transaction.id.trim().length > 0,
    )
    .map(rankTransaction)
    .sort(compareRanked)
    .map((ranked) => ranked.transaction);

  for (const payment of orderedPayments) {
    for (const transaction of orderedTransactions) {
      if (consumed.has(transaction.id)) continue;
      if (matchesPayment(payment, transaction, clockSkewMs)) {
        matches.push({ payment, transaction });
        consumed.add(transaction.id);
        break;
      }
    }
  }

  return matches;
}
