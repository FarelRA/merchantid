import type {
  Payment,
  PaymentScope,
  PaymentStore,
  PaymentTransition,
} from "../core/types.js";
import { paymentScopeKey, samePaymentScope } from "../core/provider.js";
import { MerchantIdError } from "../core/errors.js";

function clonePayment(payment: Payment): Payment {
  return {
    ...payment,
    scope: payment.scope ? { ...payment.scope } : undefined,
  };
}

function activeAmountKey(payment: Payment): string {
  return `${paymentScopeKey(payment.scope)}\u0000${payment.uniqueAmount}`;
}

/**
 * Default in-memory {@link PaymentStore}. Suitable for single-process usage and
 * tests. For multi-process deployments, provide a durable store (SQLite, Redis,
 * Postgres) implementing the same interface; see `SqlitePaymentStore`.
 *
 * It enforces the same active-amount uniqueness rule as the durable adapter and
 * implements the optional atomic `transition` capability, so two
 * `PaymentService` instances sharing this store cannot double-settle a payment
 * or overwrite a terminal status.
 */
export class InMemoryPaymentStore implements PaymentStore {
  private readonly payments = new Map<string, Payment>();
  private readonly consumedTransactions = new Map<string, string>();

  create(payment: Payment): void {
    this.assertAmountAvailable(payment, payment.id);
    this.payments.set(payment.id, clonePayment(payment));
  }

  update(payment: Payment): void {
    if (!this.payments.has(payment.id)) {
      throw new MerchantIdError(
        "CONFIG_INVALID",
        `Cannot update unknown payment ${payment.id}`,
      );
    }
    this.assertAmountAvailable(payment, payment.id);
    this.payments.set(payment.id, clonePayment(payment));
  }

  get(id: string): Payment | undefined {
    const found = this.payments.get(id);
    return found ? clonePayment(found) : undefined;
  }

  listActive(scope?: PaymentScope): Payment[] {
    return [...this.payments.values()]
      .filter(
        (payment) =>
          payment.status === "pending" &&
          (!scope ||
            (payment.scope !== undefined &&
              samePaymentScope(payment.scope, scope))),
      )
      .map(clonePayment);
  }

  /**
   * Atomically check the expected status, claim the provider transaction (when
   * supplied), and write the next state. JavaScript runs this method to
   * completion without interleaving, so the check and write cannot race inside
   * one process.
   */
  transition(transition: PaymentTransition): Payment | undefined {
    const current = this.payments.get(transition.id);
    if (
      !current ||
      current.status !== transition.expectedStatus ||
      transition.payment.id !== transition.id
    ) {
      return undefined;
    }

    if (
      transition.transactionId !== undefined &&
      this.consumedTransactions.has(transition.transactionId)
    ) {
      return undefined;
    }

    const next = clonePayment(transition.payment);
    this.assertAmountAvailable(next, transition.id);
    this.payments.set(transition.id, next);
    if (transition.transactionId !== undefined) {
      this.consumedTransactions.set(transition.transactionId, transition.id);
    }
    return clonePayment(next);
  }

  hasConsumedTransaction(transactionId: string): boolean {
    return this.consumedTransactions.has(transactionId);
  }

  private assertAmountAvailable(payment: Payment, ignoreId?: string): void {
    if (payment.status !== "pending") return;
    const key = activeAmountKey(payment);
    for (const [id, existing] of this.payments) {
      if (id === ignoreId || existing.status !== "pending") continue;
      if (activeAmountKey(existing) === key) {
        throw new MerchantIdError(
          "AMOUNT_CONFLICT",
          "Unique amount is already active in this scope",
          {
            details: {
              uniqueAmount: payment.uniqueAmount,
              provider: payment.scope?.provider,
              merchantId: payment.scope?.merchantId,
            },
          },
        );
      }
    }
  }
}
