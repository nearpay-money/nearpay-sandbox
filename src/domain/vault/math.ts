/**
 * The vault's integer arithmetic (`subscription-vault/src/math.rs`, INV-5): bigint only, with the contract's
 * `u64`/`u128` bounds where they change an outcome.
 */
import { U64_MAX, U128_MAX } from "./serde-json.js";

export const BPS_DENOM = 10_000n;
export const NS_PER_SEC = 1_000_000_000n;

/**
 * `(merchant_share, fee)`: `merchant_share = floor(amount × (10000 − fee_bps) / 10000)`, computed like the
 * contract (`q·k + floor(r·k/10000)`), which is exact for every u128 amount; `fee_bps > 10000` saturates to a zero
 * share.
 */
export function split(amount: bigint, feeBps: number): { share: bigint; fee: bigint } {
  if (amount < 0n || amount > U128_MAX) throw new RangeError("amount out of u128 range");
  const k = BigInt(Math.max(0, 10_000 - feeBps));
  const q = amount / BPS_DENOM;
  const r = amount % BPS_DENOM;
  const share = q * k + (r * k) / BPS_DENOM;
  return { share, fee: amount - share };
}

/**
 * When period `collected + 1` becomes collectable: `start_at + collected × period_secs × 10^9` (ns), or `null` when
 * it does not fit in a u64 (that period can never become due).
 */
export function dueAt(startAtNs: bigint, collectedPeriods: number, periodSecs: bigint): bigint | null {
  const due = startAtNs + BigInt(collectedPeriods) * periodSecs * NS_PER_SEC;
  return due > U64_MAX ? null : due;
}

/** Periods started by `nowNs` (period 1 starts at `start_at`); invariant V3: collected ≤ elapsed. */
export function elapsedPeriods(startAtNs: bigint, periodSecs: bigint, nowNs: bigint): bigint {
  if (nowNs < startAtNs || periodSecs === 0n) return 0n;
  return (nowNs - startAtNs) / (periodSecs * NS_PER_SEC) + 1n;
}

/** `min` / `max` of bigints (`Math.min` does not take bigints). */
export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/** Rust `u64::saturating_add`. */
export function saturatingAddU64(a: bigint, b: bigint): bigint {
  return minBig(a + b, U64_MAX);
}
