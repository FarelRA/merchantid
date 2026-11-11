/**
 * Public and internal domain types for the gateway.
 */

/** OAuth-style token pair returned by the GoID token endpoint. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry as epoch milliseconds, when derivable from the response. */
  expiresAt?: number;
  tokenType: string;
}

/** Persisted authentication session. Contains auth tokens and device identity. */
export interface SessionState {
  tokens: TokenSet;
  /** Stable device identifier for consistent x-uniqueid header across sessions. */
  deviceId?: string;
  /** When the session was last refreshed (epoch milliseconds), for debugging. */
  lastRefreshedAt?: number;
}

/**
 * The single capability {@link TokenManager} needs from the auth layer.
 *
 * Declaring it here keeps `core` free of any dependency on the `api` adapters:
 * `AuthClient` satisfies this structurally, and tests (or alternative auth
 * backends) can supply their own implementation.
 */
export interface TokenRefresher {
  refresh(refreshToken: string): Promise<TokenSet>;
}

/** Result of requesting an OTP for a phone number. */
export interface LoginRequestResult {
  /**
   * Opaque token some GoID flows return alongside the OTP challenge. Pass it
   * back when verifying if present.
   */
  otpToken?: string;
  raw: unknown;
}

/** Normalized merchant profile. */
export interface MerchantProfile {
  id: string;
  merchantName: string;
  outletName?: string;
  phone?: string;
  email?: string;
  serverKey?: string;
  clientKey?: string;
  timezone?: string;
  /** Payment outlets, each with its own GoPay static QRIS. */
  outlets: MerchantOutlet[];
  raw: unknown;
}

/**
 * A point-of-payment (outlet/terminal) with its GoPay static QRIS. A merchant
 * may have several; each has its own `qrString`.
 */
export interface MerchantOutlet {
  popId: string;
  name?: string;
  status?: string;
  /** GoPay receiver id backing this outlet's QRIS. */
  receiverId?: string;
  /** The static EMVCo QRIS payload for this outlet (from `aspi_qr_string`). */
  qrString?: string;
  raw: unknown;
}

/**
 * Full merchant record persisted in config. One entry per merchant the account
 * has access to. Includes the resolved outlets and their static QRIS strings.
 */
export interface StoredMerchant {
  id: string;
  merchantName: string;
  outletName?: string;
  phone?: string;
  email?: string;
  businessType?: string;
  merchantType?: string;
  serviceArea?: string;
  outlets: MerchantOutlet[];
  /** Convenience: the primary outlet's static QRIS, when available. */
  qrString?: string;
  /** Full raw merchant payload from the API for advanced use. */
  raw: unknown;
}

/** A single transaction as returned by the merchant analytics API. */
export interface MerchantTransaction {
  id: string;
  orderId: string;
  merchantId: string;
  status: string;
  paymentType: string;
  /**
   * The captured amount in **whole rupiah**, normalized exactly once by the
   * provider adapter. This is the only amount field used for matching.
   */
  grossAmount: number;
  /**
   * Optional provider-reported "real" gross amount, also in whole rupiah.
   * Informational only: it is deliberately not used to settle a payment,
   * because accepting a second amount field makes exact matching ambiguous.
   */
  realGrossAmount?: number;
  currency: string;
  transactionTime: string;
  settlementTime?: string;
  transactionSource?: string;
  raw: unknown;
}

/**
 * The single capability {@link PaymentService} needs from the transaction feed.
 *
 * Mirrors {@link TokenRefresher}: keeping it in `core` lets the payment domain
 * stay independent of the `api` adapters. `TransactionClient` satisfies it.
 */
export interface TransactionLister {
  list(
    merchantId: string,
    query: TransactionQuery,
  ): Promise<MerchantTransaction[]>;
}

/** Filter for listing transactions. */
export interface TransactionQuery {
  from?: number;
  size?: number;
  statuses?: readonly string[];
  paymentTypes?: readonly string[];
  startTime: Date;
  endTime: Date;
}

/** Identifies the provider account and merchant that own a payment. */
export interface PaymentScope {
  /** Stable provider id such as `gopay` or `shopee`. */
  provider: string;
  /** Optional provider account id when it is available. */
  accountId?: string;
  /** Provider-native merchant/store id used to poll transactions. */
  merchantId: string;
}

/** Lifecycle status of a payment tracked by the gateway. */
export type PaymentStatus = "pending" | "paid" | "expired" | "cancelled";

/** A payment intent created by the gateway. */
export interface Payment {
  /** Caller-facing identifier. */
  id: string;
  /** Provider ownership. Omitted only on explicitly unscoped records. */
  scope?: PaymentScope;
  /** The base amount requested by the merchant, in whole rupiah. */
  baseAmount: number;
  /** The unique offset added for disambiguation. */
  uniqueOffset: number;
  /** The exact amount the buyer must transfer (baseAmount + uniqueOffset). */
  uniqueAmount: number;
  status: PaymentStatus;
  createdAt: number;
  expiresAt: number;
  /** Optional caller-supplied reference (e.g. internal order id). */
  reference?: string;
  /** Dynamic QRIS payload string when a static QRIS was configured. */
  qrString?: string;
  /** Matched transaction once paid. */
  transaction?: MerchantTransaction;
  metadata?: Record<string, unknown>;
}

/**
 * A compare-and-set status transition, optionally claiming the provider
 * transaction that caused it in the same atomic operation.
 *
 * `expectedStatus` prevents a stale poller from overwriting a terminal status
 * (`paid` -> `cancelled`). When `transactionId` is present, a durable store
 * must claim it exactly once across all processes: a transaction that already
 * settled one payment may never settle another.
 */
export interface PaymentTransition {
  /** Payment being transitioned. Must match `payment.id`. */
  id: string;
  /** Status the stored row must still have for the transition to apply. */
  expectedStatus: PaymentStatus;
  /** Complete next state to persist. */
  payment: Payment;
  /** Provider transaction id to claim atomically, when settling. */
  transactionId?: string;
  /**
   * When set, the store also quarantines the payment's `uniqueAmount` for the
   * scope until this epoch millisecond, inside the same atomic operation as the
   * status write. Without it a crash between the status write and a separate
   * quarantine write would release the amount while a transaction for the old
   * payment is still inside the matching window.
   */
  quarantineUntil?: number;
}

/**
 * One entry in the durable amount quarantine: the unique amount of a payment
 * that just left the active set, and the moment it may be reallocated.
 *
 * The window is `2 * clockSkewMs` (see `PaymentService`): after that, no
 * provider transaction belonging to the old payment can fall inside a new
 * payment's matching window.
 */
export interface AmountQuarantine {
  /** Provider ownership of the slot. Omitted for explicitly unscoped payments. */
  scope?: PaymentScope;
  /** The exact unique amount that is unavailable. */
  amount: number;
  /** Epoch milliseconds after which the amount may be reallocated. */
  quarantinedUntil: number;
  /** Epoch milliseconds the entry was recorded, for pruning/audit. */
  createdAt?: number;
}

/** Contract for persisting active payments. */
export interface PaymentStore {
  create(payment: Payment): Promise<void> | void;
  update(payment: Payment): Promise<void> | void;
  get(id: string): Promise<Payment | undefined> | Payment | undefined;
  /**
   * All payments still occupying a unique amount slot. Implementations should
   * apply `scope` when supplied; callers also filter defensively when a
   * custom store returns records from other scopes.
   */
  listActive(scope?: PaymentScope): Promise<Payment[]> | Payment[];
  /**
   * Optional atomic compare-and-set. `PaymentService` uses it when present so
   * concurrent pollers and multi-process deployments cannot double-settle a
   * payment or overwrite a terminal status. Implementations that omit it keep
   * the previous get-then-update behaviour (single-process safe only).
   *
   * Must return the persisted payment on success and `undefined` when the
   * expected status no longer holds or the transaction was already claimed.
   */
  transition?(
    transition: PaymentTransition,
  ): Promise<Payment | undefined> | Payment | undefined;
  /**
   * Optional durable replay guard. Durable stores should also enforce this in
   * {@link transition}; this read-only probe lets callers inspect prior claims.
   */
  hasConsumedTransaction?(transactionId: string): Promise<boolean> | boolean;
  /**
   * Record or extend a durable amount quarantine. Re-quarantining the same
   * `(scope, amount)` must keep the later deadline rather than shortening it.
   *
   * Once present, a store must refuse to persist a new pending payment whose
   * amount is still quarantined (see {@link create}) so the guard cannot be
   * bypassed by a process that read the active set before its peer wrote.
   */
  quarantineAmount?(entry: AmountQuarantine): Promise<void> | void;
  /**
   * Read-only probe for a single `(scope, amount)` pair. `at` defaults to the
   * current time so callers can ask about the present without a clock of their
   * own.
   */
  isAmountQuarantined?(
    scope: PaymentScope | undefined,
    amount: number,
    at?: number,
  ): Promise<boolean> | boolean;
  /**
   * Every amount still quarantined in `scope` at `at`. `PaymentService` folds
   * these into the allocator's taken set, so a durable store should index the
   * deadline rather than scanning the table.
   *
   * When this and {@link quarantineAmount} are both absent, `PaymentService`
   * falls back to a process-local map that a restart discards.
   */
  listQuarantinedAmounts?(
    scope?: PaymentScope,
    at?: number,
  ): Promise<number[]> | number[];
  /** Delete quarantines that expired at or before `beforeMs`; returns the count. */
  pruneQuarantine?(beforeMs: number): Promise<number> | number;
}
