import type {
  DatabaseSync as DatabaseSyncType,
  SQLInputValue,
  StatementSync,
} from "node:sqlite";
import type {
  AmountQuarantine,
  Payment,
  PaymentScope,
  PaymentStore,
  PaymentTransition,
} from "../core/types.js";
import { paymentScopeKey } from "../core/provider.js";
import { MerchantIdError } from "../core/errors.js";

/**
 * Durable SQLite {@link PaymentStore} built on Node's built-in `node:sqlite`.
 *
 * Published as `merchantid/sqlite`; it is not part of the runtime-agnostic main
 * entry. Requires Node >= 22.13 (the first release where `node:sqlite` no
 * longer needs an experimental flag). No runtime dependency is added.
 *
 * Guarantees:
 * - A partial unique index enforces one pending payment per
 *   `(scope, uniqueAmount)`. SQLite checks it atomically inside `INSERT` /
 *   `UPDATE`, so two processes cannot both claim the same final amount.
 * - `transition` runs the compare-and-set, the status write, the provider
 *   transaction claim, and (when asked) the amount quarantine in one
 *   `BEGIN IMMEDIATE` transaction. A transaction id can settle at most one
 *   payment, and a freed amount cannot be reallocated before its quarantine
 *   ends, even across process restarts.
 * - `create` rejects a pending payment whose amount is still quarantined, so a
 *   process that read the active set before its peer freed an amount still
 *   cannot reuse it.
 * - WAL mode and a busy timeout let readers proceed while a writer commits.
 *
 * The schema is intentionally small and additive; migrate by adding columns
 * rather than rewriting rows. `PRAGMA user_version` is set to 2.
 */

export interface SqlitePaymentStoreOptions {
  /** File path, or `:memory:` for tests. */
  path: string;
  /** SQLite busy timeout. Default: 5000ms. */
  busyTimeoutMs?: number;
  /** WAL is enabled by default for file databases. */
  wal?: boolean;
}

const SCHEMA_VERSION = 2;

interface SqliteBuiltin {
  DatabaseSync: new (path: string) => DatabaseSyncType;
}

/**
 * Load `node:sqlite` without emitting a bare `sqlite` import.
 *
 * esbuild's node target rewrites `node:sqlite` to `sqlite` in the published
 * bundle, which is not a resolvable builtin. `process.getBuiltinModule` exists
 * on every Node version that ships the module (>= 22.3) and keeps the subpath
 * loadable from both ESM and CJS builds.
 */
function loadSqlite(): SqliteBuiltin {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  const sqlite = getBuiltinModule?.("node:sqlite") as SqliteBuiltin | undefined;
  if (!sqlite || typeof sqlite.DatabaseSync !== "function") {
    throw new MerchantIdError(
      "CONFIG_INVALID",
      "merchantid/sqlite requires Node >= 22.13 with the built-in node:sqlite module",
    );
  }
  return sqlite;
}

interface PaymentRow {
  id: string;
  status: string;
  scope_provider: string | null;
  scope_account_id: string | null;
  scope_merchant_id: string | null;
  scope_key: string;
  base_amount: number;
  unique_offset: number;
  unique_amount: number;
  created_at: number;
  expires_at: number;
  reference: string | null;
  qr_string: string | null;
  transaction_json: string | null;
  metadata_json: string | null;
  transaction_id: string | null;
}

function rowToPayment(row: PaymentRow): Payment {
  const scope: PaymentScope | undefined =
    row.scope_provider !== null
      ? {
          provider: row.scope_provider,
          ...(row.scope_account_id !== null
            ? { accountId: row.scope_account_id }
            : {}),
          merchantId: row.scope_merchant_id ?? "",
        }
      : undefined;

  return {
    id: row.id,
    ...(scope ? { scope } : {}),
    baseAmount: row.base_amount,
    uniqueOffset: row.unique_offset,
    uniqueAmount: row.unique_amount,
    status: row.status as Payment["status"],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.reference !== null ? { reference: row.reference } : {}),
    ...(row.qr_string !== null ? { qrString: row.qr_string } : {}),
    ...(row.transaction_json !== null
      ? {
          transaction: JSON.parse(row.transaction_json) as NonNullable<
            Payment["transaction"]
          >,
        }
      : {}),
    ...(row.metadata_json !== null
      ? {
          metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
        }
      : {}),
  };
}

function paymentValues(payment: Payment): SQLInputValue[] {
  return [
    payment.id,
    payment.status,
    payment.scope?.provider ?? null,
    payment.scope?.accountId ?? null,
    payment.scope?.merchantId ?? null,
    paymentScopeKey(payment.scope),
    payment.baseAmount,
    payment.uniqueOffset,
    payment.uniqueAmount,
    payment.createdAt,
    payment.expiresAt,
    payment.reference ?? null,
    payment.qrString ?? null,
    payment.transaction ? JSON.stringify(payment.transaction) : null,
    payment.metadata ? JSON.stringify(payment.metadata) : null,
    payment.transaction?.id ?? null,
  ];
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed|constraint failed: payments/i.test(error.message)
  );
}

export class SqlitePaymentStore implements PaymentStore {
  private readonly db: DatabaseSyncType;
  private readonly insertStatement: StatementSync;
  private readonly updateStatement: StatementSync;
  private readonly getStatement: StatementSync;
  private readonly activeStatement: StatementSync;
  private readonly activeByScopeStatement: StatementSync;
  private readonly consumedStatement: StatementSync;
  private readonly pruneConsumedStatement: StatementSync;
  private readonly quarantineUpsertStatement: StatementSync;
  private readonly quarantineProbeStatement: StatementSync;
  private readonly quarantineListStatement: StatementSync;
  private readonly pruneQuarantineStatement: StatementSync;

  constructor(options: SqlitePaymentStoreOptions) {
    if (typeof options.path !== "string" || options.path.length === 0) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "SqlitePaymentStore requires a path",
      );
    }
    this.db = new (loadSqlite().DatabaseSync)(options.path);
    const busyTimeout = Math.max(0, Math.floor(options.busyTimeoutMs ?? 5_000));
    this.db.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    if (options.path !== ":memory:" && options.wal !== false) {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        scope_provider TEXT,
        scope_account_id TEXT,
        scope_merchant_id TEXT,
        scope_key TEXT NOT NULL DEFAULT '',
        base_amount INTEGER NOT NULL,
        unique_offset INTEGER NOT NULL,
        unique_amount INTEGER NOT NULL,
        created_at REAL NOT NULL,
        expires_at REAL NOT NULL,
        reference TEXT,
        qr_string TEXT,
        transaction_json TEXT,
        metadata_json TEXT,
        transaction_id TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS payments_active_amount_unique
        ON payments(scope_key, unique_amount)
        WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS payments_status_idx
        ON payments(status);

      CREATE TABLE IF NOT EXISTS consumed_transactions (
        transaction_id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        consumed_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quarantined_amounts (
        scope_key TEXT NOT NULL,
        amount INTEGER NOT NULL,
        quarantined_until REAL NOT NULL,
        created_at REAL NOT NULL,
        PRIMARY KEY (scope_key, amount)
      );

      CREATE INDEX IF NOT EXISTS quarantined_amounts_until_idx
        ON quarantined_amounts(quarantined_until);
    `);

    const userVersion = this.db.prepare("PRAGMA user_version").get() as
      { user_version?: number } | undefined;
    if ((userVersion?.user_version ?? 0) < SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }

    this.insertStatement = this.db.prepare(`
      INSERT INTO payments (
        id, status, scope_provider, scope_account_id, scope_merchant_id,
        scope_key, base_amount, unique_offset, unique_amount, created_at,
        expires_at, reference, qr_string, transaction_json, metadata_json,
        transaction_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateStatement = this.db.prepare(`
      UPDATE payments SET
        status = ?, scope_provider = ?, scope_account_id = ?,
        scope_merchant_id = ?, scope_key = ?, base_amount = ?,
        unique_offset = ?, unique_amount = ?, created_at = ?, expires_at = ?,
        reference = ?, qr_string = ?, transaction_json = ?,
        metadata_json = ?, transaction_id = ?
      WHERE id = ?
    `);
    this.getStatement = this.db.prepare("SELECT * FROM payments WHERE id = ?");
    this.activeStatement = this.db.prepare(
      "SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at, id",
    );
    this.activeByScopeStatement = this.db.prepare(
      "SELECT * FROM payments WHERE status = 'pending' AND scope_key = ? ORDER BY created_at, id",
    );
    this.consumedStatement = this.db.prepare(
      "SELECT 1 AS found FROM consumed_transactions WHERE transaction_id = ?",
    );
    this.pruneConsumedStatement = this.db.prepare(
      "DELETE FROM consumed_transactions WHERE consumed_at < ?",
    );
    // The deadline only ever moves forward: a settle and a cancel racing on the
    // same amount must not shorten the window recorded by the other.
    this.quarantineUpsertStatement = this.db.prepare(`
      INSERT INTO quarantined_amounts (
        scope_key, amount, quarantined_until, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key, amount) DO UPDATE SET
        quarantined_until = MAX(quarantined_until, excluded.quarantined_until),
        created_at = MIN(created_at, excluded.created_at)
    `);
    this.quarantineProbeStatement = this.db.prepare(
      "SELECT 1 AS found FROM quarantined_amounts WHERE scope_key = ? AND amount = ? AND quarantined_until > ?",
    );
    this.quarantineListStatement = this.db.prepare(
      "SELECT amount FROM quarantined_amounts WHERE scope_key = ? AND quarantined_until > ? ORDER BY amount",
    );
    this.pruneQuarantineStatement = this.db.prepare(
      "DELETE FROM quarantined_amounts WHERE quarantined_until <= ?",
    );
  }

  create(payment: Payment): void {
    // Only a pending row occupies an amount slot, so only it has to clear the
    // quarantine. Terminal rows are written as-is (migrations, imports).
    if (payment.status !== "pending") {
      this.insertPayment(payment);
      return;
    }

    // The active-set read and the insert are separate round trips, so a peer
    // process may free (or a restart may recall) a quarantined amount between
    // them. Re-checking here, inside the same write transaction as the insert,
    // is what makes the quarantine effective across processes and restarts.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.pruneQuarantineStatement.run(Date.now());
      if (this.isAmountQuarantined(payment.scope, payment.uniqueAmount)) {
        throw this.amountConflict(payment, true);
      }
      this.insertStatement.run(...paymentValues(payment));
      this.db.exec("COMMIT");
    } catch (error) {
      this.rollback();
      if (isUniqueConstraintError(error)) {
        throw this.amountConflict(payment, false);
      }
      throw error;
    }
  }

  private insertPayment(payment: Payment): void {
    try {
      this.insertStatement.run(...paymentValues(payment));
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw this.amountConflict(payment, false);
      }
      throw error;
    }
  }

  private amountConflict(
    payment: Payment,
    quarantined: boolean,
  ): MerchantIdError {
    return new MerchantIdError(
      "AMOUNT_CONFLICT",
      quarantined
        ? "Unique amount is quarantined in this scope"
        : "Unique amount is already active in this scope",
      {
        details: {
          uniqueAmount: payment.uniqueAmount,
          provider: payment.scope?.provider,
          merchantId: payment.scope?.merchantId,
          quarantined,
        },
      },
    );
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
  }

  update(payment: Payment): void {
    try {
      const [, ...rest] = paymentValues(payment);
      const result = this.updateStatement.run(...rest, payment.id);
      if (Number(result.changes) === 0) {
        throw new MerchantIdError(
          "CONFIG_INVALID",
          `Cannot update unknown payment ${payment.id}`,
        );
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw this.amountConflict(payment, false);
      }
      throw error;
    }
  }

  get(id: string): Payment | undefined {
    const row = this.getStatement.get(id) as PaymentRow | undefined;
    return row ? rowToPayment(row) : undefined;
  }

  listActive(scope?: PaymentScope): Payment[] {
    const rows = scope
      ? (this.activeByScopeStatement.all(
          paymentScopeKey(scope),
        ) as unknown as PaymentRow[])
      : (this.activeStatement.all() as unknown as PaymentRow[]);
    return rows.map(rowToPayment);
  }

  transition(transition: PaymentTransition): Payment | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getStatement.get(transition.id) as
        PaymentRow | undefined;
      if (
        !row ||
        row.status !== transition.expectedStatus ||
        transition.payment.id !== transition.id
      ) {
        this.db.exec("ROLLBACK");
        return undefined;
      }

      if (transition.transactionId !== undefined) {
        const claimed = this.consumedStatement.get(transition.transactionId);
        if (claimed) {
          this.db.exec("ROLLBACK");
          return undefined;
        }
      }

      const [, ...rest] = paymentValues(transition.payment);
      this.updateStatement.run(...rest, transition.id);
      if (transition.transactionId !== undefined) {
        this.db
          .prepare(
            "INSERT INTO consumed_transactions (transaction_id, payment_id, consumed_at) VALUES (?, ?, ?)",
          )
          .run(transition.transactionId, transition.id, Date.now());
      }
      // Released amount and terminal status commit together: a crash can no
      // longer leave the slot free while the old payment is still settleable.
      if (transition.quarantineUntil !== undefined) {
        this.quarantineAmount({
          scope: transition.payment.scope,
          amount: transition.payment.uniqueAmount,
          quarantinedUntil: transition.quarantineUntil,
          createdAt: Date.now(),
        });
      }

      this.db.exec("COMMIT");
      const persisted = this.getStatement.get(transition.id) as
        PaymentRow | undefined;
      return persisted ? rowToPayment(persisted) : undefined;
    } catch (error) {
      this.rollback();
      if (isUniqueConstraintError(error)) {
        throw new MerchantIdError(
          "AMOUNT_CONFLICT",
          "Unique amount is already active in this scope",
          { details: { id: transition.id } },
        );
      }
      throw error;
    }
  }

  hasConsumedTransaction(transactionId: string): boolean {
    return Boolean(this.consumedStatement.get(transactionId));
  }

  /** Delete transaction claims older than the rolling feed lookback. */
  pruneConsumedTransactions(beforeEpochMs: number): number {
    const result = this.pruneConsumedStatement.run(beforeEpochMs);
    return Number(result.changes);
  }

  /**
   * Record or extend the quarantine of a freed unique amount.
   *
   * Safe to call on its own, but `transition()` can record it atomically with
   * the status write via `quarantineUntil`; prefer that inside the money path.
   */
  quarantineAmount(entry: AmountQuarantine): void {
    if (
      !Number.isSafeInteger(entry.amount) ||
      !Number.isFinite(entry.quarantinedUntil)
    ) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        "quarantineAmount requires a safe integer amount and a finite deadline",
      );
    }
    this.quarantineUpsertStatement.run(
      paymentScopeKey(entry.scope),
      entry.amount,
      entry.quarantinedUntil,
      entry.createdAt ?? Date.now(),
    );
  }

  isAmountQuarantined(
    scope: PaymentScope | undefined,
    amount: number,
    at: number = Date.now(),
  ): boolean {
    return Boolean(
      this.quarantineProbeStatement.get(paymentScopeKey(scope), amount, at),
    );
  }

  listQuarantinedAmounts(
    scope?: PaymentScope,
    at: number = Date.now(),
  ): number[] {
    const rows = this.quarantineListStatement.all(
      paymentScopeKey(scope),
      at,
    ) as unknown as Array<{ amount: number }>;
    return rows.map((row) => row.amount);
  }

  /** Delete quarantines that ended at or before `beforeMs`. */
  pruneQuarantine(beforeMs: number): number {
    const result = this.pruneQuarantineStatement.run(beforeMs);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience factory. */
export function createSqlitePaymentStore(
  path: string,
  options: Omit<SqlitePaymentStoreOptions, "path"> = {},
): SqlitePaymentStore {
  return new SqlitePaymentStore({ path, ...options });
}
