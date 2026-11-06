/**
 * Quote amounts (sandbox LLD §3 `POST /v0/quote`), exact rational arithmetic only (INV-5).
 *
 * EXACT_OUTPUT: the recipient gets exactly `amount`;
 *   amountIn    = ceil(amountOut × price(out)/price(in) × 10^(dIn−dOut) × (1 + (appFees + 20 bps)/10 000))
 *   minAmountIn = floor(amountIn × (10 000 − slippage)/10 000), minAmountOut = amountOut.
 * EXACT_INPUT (Stage 2 refund legs): the payer sends exactly `amount`;
 *   amountOut    = floor(amountIn × price(in)/price(out) × 10^(dOut−dIn) × (1 − (appFees + 20 bps)/10 000))
 *   minAmountOut = floor(amountOut × (10 000 − slippage)/10 000), minAmountIn = amountIn.
 * The 20 bps stand for the route's own cost (the sandbox charges no real fee).
 */
import {
  ceil,
  div,
  floor,
  formatUnits,
  mul,
  parseDecimal,
  type Rational,
  rational,
  toDecimalString,
} from "@nearpay-internal/money";
import type { SandboxToken } from "./tokens.js";

/** Route cost the sandbox adds on top of app fees, bps. */
export const ROUTE_COST_BPS = 20n;

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT";

export interface QuoteAmounts {
  readonly amountIn: bigint;
  readonly minAmountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
}

export class QuoteMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteMathError";
  }
}

const TEN_K = 10_000n;

/** Value of one base unit of `t` in USD. */
function unitUsd(t: SandboxToken): Rational {
  return div(parseDecimal(t.priceUsd), rational(10n ** BigInt(t.decimals)));
}

export function quoteAmounts(p: {
  swapType: SwapType;
  amount: bigint;
  origin: SandboxToken;
  destination: SandboxToken;
  appFeeBps: bigint;
  slippageBps: bigint;
}): QuoteAmounts {
  if (p.amount <= 0n) throw new QuoteMathError("amount must be positive");
  if (p.appFeeBps < 0n || p.appFeeBps > 500n) throw new QuoteMathError("appFees must total 0–500 bps");
  if (p.slippageBps < 0n || p.slippageBps > TEN_K) throw new QuoteMathError("slippageTolerance must be 0–10000 bps");
  const cost = p.appFeeBps + ROUTE_COST_BPS;
  // out units per in unit
  const rate = div(unitUsd(p.origin), unitUsd(p.destination));
  if (p.swapType === "EXACT_OUTPUT") {
    const amountOut = p.amount;
    const gross = mul(div(rational(amountOut), rate), rational(TEN_K + cost, TEN_K));
    const amountIn = ceil(gross);
    if (amountIn <= 0n) throw new QuoteMathError("amount is too small to quote");
    const minAmountIn = floor(rational(amountIn * (TEN_K - p.slippageBps), TEN_K));
    return { amountIn, minAmountIn, amountOut, minAmountOut: amountOut };
  }
  const amountIn = p.amount;
  const amountOut = floor(mul(mul(rational(amountIn), rate), rational(TEN_K - cost, TEN_K)));
  if (amountOut <= 0n) throw new QuoteMathError("amount is too small to quote");
  const minAmountOut = floor(rational(amountOut * (TEN_K - p.slippageBps), TEN_K));
  return { amountIn, minAmountIn: amountIn, amountOut, minAmountOut };
}

/** USD value of `amount` base units of `t`, 4 decimals (the `*Usd` strings of a quote). */
export function usdValue(amount: bigint, t: SandboxToken): string {
  return toDecimalString(mul(rational(amount), unitUsd(t)), 4);
}

/** Human amount (the `*Formatted` strings of a quote). */
export function formatted(amount: bigint, t: SandboxToken): string {
  return formatUnits(amount, t.decimals);
}

/** Default deposit of a scenario: below the minimum (02), above the quote (03), else exact. */
export function scenarioDeposit(scenario: string, q: Pick<QuoteAmounts, "amountIn" | "minAmountIn">): bigint {
  if (scenario === "02") return q.minAmountIn > 1n ? q.minAmountIn - 1n : 1n;
  if (scenario === "03") return q.amountIn + (q.amountIn / 10n > 0n ? q.amountIn / 10n : 1n);
  return q.amountIn;
}
