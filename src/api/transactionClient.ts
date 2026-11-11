import type { HttpClient } from "../http/httpClient.js";
import {
  DEFAULT_PAYMENT_TYPES,
  ENDPOINTS,
  GOJEK_API_BASE_URL,
  MAX_TRANSACTION_PAGE_SIZE,
  PAID_TRANSACTION_STATUSES,
} from "../core/constants.js";
import { toIsoUtc } from "../utils/time.js";
import type {
  MerchantTransaction,
  TransactionLister,
  TransactionQuery,
} from "../core/types.js";
import { normalizeGopayAmount } from "../providers/gopay/amount.js";

interface RawTransaction {
  id: string;
  order_id: string;
  merchant_id: string;
  transaction_status: string;
  payment_type: string;
  gross_amount: number;
  real_gross_amount?: number;
  currency?: string;
  transaction_time: string;
  settlement_time?: string;
  transaction_source?: string;
  [key: string]: unknown;
}

interface TransactionListPayload {
  from: number;
  size: number;
  total: number;
  transactions?: RawTransaction[];
}

/**
 * Reads settled/authorized transactions from the merchant analytics API. This
 * is the signal source the gateway polls to detect incoming QRIS payments.
 */
export class TransactionClient implements TransactionLister {
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async list(
    merchantId: string,
    query: TransactionQuery,
  ): Promise<MerchantTransaction[]> {
    // Undefined -> sensible defaults; an explicit empty array -> omit the
    // filter entirely (fetch all), letting the caller match client-side.
    const statuses = query.statuses ?? PAID_TRANSACTION_STATUSES;
    const paymentTypes = query.paymentTypes ?? DEFAULT_PAYMENT_TYPES;

    const params: Record<string, string | number> = {
      from: query.from ?? 0,
      // Clamped: the feed answers 422 for a larger page, which would fail the
      // entire poll. Returning fewer transactions is the graceful degradation.
      size: Math.min(query.size ?? 20, MAX_TRANSACTION_PAGE_SIZE),
      start_time: toIsoUtc(query.startTime),
      end_time: toIsoUtc(query.endTime),
      merchant_ids: merchantId,
    };
    if (statuses.length > 0) params.statuses = statuses.join(",");
    if (paymentTypes.length > 0) params.payment_types = paymentTypes.join(",");

    const payload = await this.http.requestJson<TransactionListPayload>({
      method: "GET",
      baseUrl: GOJEK_API_BASE_URL,
      path: ENDPOINTS.transactions,
      query: params,
    });

    return (payload.transactions ?? []).flatMap((transaction) => {
      const normalized = normalizeTransaction(transaction);
      return normalized ? [normalized] : [];
    });
  }
}

/**
 * Convert one raw merchant-analytics row into the provider-neutral shape.
 *
 * Returns `undefined` instead of fabricating a value when the row cannot be
 * used safely: a missing id cannot be consumed exactly once, a malformed or
 * sub-rupiah amount cannot be compared to a whole-rupiah payment intent, and
 * a non-IDR row would be divided on the wrong currency scale.
 */
function normalizeTransaction(
  raw: RawTransaction,
): MerchantTransaction | undefined {
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id.length === 0) return undefined;

  const grossAmount = normalizeGopayAmount(raw.gross_amount);
  if (grossAmount === undefined) return undefined;

  const currency = (raw.currency ?? "IDR").toString().toUpperCase();
  if (currency !== "IDR") return undefined;

  return {
    id,
    orderId: raw.order_id,
    merchantId: raw.merchant_id,
    status: raw.transaction_status,
    paymentType: raw.payment_type,
    // The feed reports minor units; the rest of the library uses whole rupiah.
    // This is the single normalization boundary for GoPay.
    grossAmount,
    realGrossAmount: normalizeGopayAmount(raw.real_gross_amount),
    currency,
    transactionTime: raw.transaction_time,
    settlementTime: raw.settlement_time,
    transactionSource: raw.transaction_source,
    // Untouched, so callers can still read the original minor-unit values.
    raw,
  };
}
