/**
 * Chain-specific fields of simulated transactions (sandbox LLD §10, spec 0.4.0 `SimTx`): Solana slots, SPL token
 * accounts and failed signatures; Bitcoin heights, output indexes and confirmations; and what scenarios `08`/`09`
 * change on the destination side. Pure: no I/O, no clock.
 */
import type { ChainFamily } from "@nearpay-internal/chains";

/** Simulated Solana slot of the n-th recorded transaction. */
export const SOLANA_SLOT_BASE = 380_000_000n;
/** Simulated Bitcoin height of the n-th recorded transaction. */
export const BITCOIN_HEIGHT_BASE = 900_000n;
/** A new Bitcoin confirmation every 30 s (× the time scale), capped at 6. */
export const BTC_CONFIRMATION_MS = 30_000;
export const BTC_MAX_CONFIRMATIONS = 6;
/** Scenario `08`: the destination transaction stays not final this long (× the time scale). */
export const SLOW_FINALITY_MS = 60_000;
/** Usual finality delay of a simulated payout (× the time scale); Bitcoin is final (1 confirmation) when recorded. */
export const PAYOUT_FINALITY_MS = 2_000;
/** Scenario `09` (Bitcoin): the solver's change output paid back to itself. */
export const BTC_CHANGE_SATS = 10_000n;

/** `SimTx.block_ref` (Solana slot / Bitcoin height); null for chains whose block the sandbox does not simulate. */
export function blockRefOf(family: ChainFamily, seq: bigint): string | null {
  if (family === "solana") return (SOLANA_SLOT_BASE + seq).toString();
  if (family === "bitcoin") return (BITCOIN_HEIGHT_BASE + seq).toString();
  return null;
}

/**
 * Bitcoin confirmations now: 0 before the first confirmation (`firstConfirmationMs`, the row's `finalized_at`), then
 * 1 and one more per 30 s × time scale, capped at 6. `finalized` is `confirmations ≥ 1`.
 */
export function bitcoinConfirmations(nowMs: number, firstConfirmationMs: number, timeScale: number): number {
  if (nowMs < firstConfirmationMs) return 0;
  const step = BTC_CONFIRMATION_MS * timeScale;
  return Math.min(BTC_MAX_CONFIRMATIONS, 1 + Math.floor((nowMs - firstConfirmationMs) / step));
}

/** How a destination-side transaction (payout or refund) is recorded for a scenario and chain family. */
export interface DestinationPlan {
  /** Delay before the transaction is final (Bitcoin: its first confirmation), ms before the time scale. */
  readonly finalityMs: number;
  /** Scenario `09` on Solana: a failed signature is recorded before the real one. */
  readonly failedFirst: boolean;
  /** Scenario `09` on Bitcoin: the destination is paid in two outputs (vout 0 and 2) around a change output (vout 1). */
  readonly splitOutputs: boolean;
}

export function destinationPlan(scenario: string, family: ChainFamily, leg: "payout" | "refund"): DestinationPlan {
  const base = family === "bitcoin" ? 0 : PAYOUT_FINALITY_MS;
  return {
    finalityMs: scenario === "08" ? SLOW_FINALITY_MS : base,
    failedFirst: scenario === "09" && leg === "payout" && family === "solana",
    splitOutputs: scenario === "09" && leg === "payout" && family === "bitcoin",
  };
}

/** Scenario `09` (Bitcoin) output amounts: `floor(a/2)` and the rest; an amount below 2 stays one output. */
export function splitBitcoinPayout(amount: bigint): bigint[] {
  if (amount < 2n) return [amount];
  const first = amount / 2n;
  return [first, amount - first];
}
