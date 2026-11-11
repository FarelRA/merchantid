import { TRANSACTION_AMOUNT_SCALE } from "../../core/constants.js";

/**
 * Convert a GoPay merchant-analytics amount from sen (ISO 4217 minor units) to
 * whole rupiah exactly once.
 *
 * The feed's `gross_amount` is always in sen: Rp 1.001 arrives as `100100`,
 * Rp 10.001 as `1000100`, and Rp 100.000 as `10000000`. This helper is the only
 * place that division happens. The matcher and `Payment.uniqueAmount` both work
 * in whole rupiah, so accepting a second scale anywhere else would allow a
 * Rp 300.100 transaction to settle a Rp 3.001 order.
 *
 * Returns `undefined` for every malformed value instead of coercing to 0:
 * - non-number (the feed has been known to change field types),
 * - `NaN`, `Infinity`, negatives, or unsafe integers,
 * - sub-rupiah sen values such as `100150` (Rp 1.001,50). IDR QRIS amounts are
 *   whole rupiah; rounding would manufacture a false match.
 *
 * Callers should drop the transaction row when this returns `undefined`.
 */
export function normalizeGopayAmount(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return undefined;
  }

  if (value % TRANSACTION_AMOUNT_SCALE !== 0) {
    return undefined;
  }

  const rupiah = value / TRANSACTION_AMOUNT_SCALE;
  return Number.isSafeInteger(rupiah) ? rupiah : undefined;
}
