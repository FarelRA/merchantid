export interface BackoffOptions {
  /** First retry delay. Default: 250ms. */
  baseMs?: number;
  /** Hard ceiling for the exponential component. Default: 30s. */
  maxMs?: number;
  /**
   * Fraction of the delay to randomize in either direction (0..1). Default:
   * 0.2, meaning a delay may land between 80% and 120% of the exponential
   * value. Set to 0 for deterministic tests.
   */
  jitterRatio?: number;
  /** Injectable RNG for deterministic tests. Must return [0, 1). */
  random?: () => number;
}

const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 30_000;
const DEFAULT_JITTER_RATIO = 0.2;

/**
 * Exponential backoff with symmetric jitter.
 *
 * `attempt` is zero-based: 0 returns the base delay. The exponential component
 * is capped at `maxMs` before jitter, and the result is clamped to
 * `[0, maxMs]` after jitter so callers never receive a negative or unbounded
 * sleep.
 *
 * Use this for external scheduler polling and webhook retries. Polling every
 * replica at exactly the same interval synchronizes load on the private
 * merchant feed and makes rate limiting worse; jitter spreads it out.
 */
export function jitteredBackoff(
  attempt: number,
  options: BackoffOptions = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError("attempt must be a non-negative integer");
  }

  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;

  if (!Number.isFinite(baseMs) || baseMs < 0) {
    throw new RangeError("baseMs must be a finite, non-negative number");
  }
  if (!Number.isFinite(maxMs) || maxMs < 0) {
    throw new RangeError("maxMs must be a finite, non-negative number");
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1");
  }

  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 52));
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError("random must return a number in [0, 1)");
  }

  const jitter = exponential * jitterRatio * (randomValue * 2 - 1);
  return Math.round(Math.min(maxMs, Math.max(0, exponential + jitter)));
}
