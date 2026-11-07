/**
 * Explorer mirror rows (sandbox LLD §3 `GET /api/v0/transactions`; spec `ExplorerTransaction`). Pure: maps a
 * simulated execution to the row the live Explorer would show for it.
 *
 * - `status`: the simulated execution's provider status in the Explorer's vocabulary — `KNOWN_DEPOSIT_TX`, which
 *   the Explorer does not list, reads `PROCESSING` (a deposit was seen and is being processed).
 * - `amountIn` / `amountOut` read `0` while in flight, like the live Explorer: `amountIn` is the deposit once
 *   the execution is final, `amountOut` the delivered amount once it succeeded.
 * - The default status filter omits `PENDING_DEPOSIT` and `INCOMPLETE_DEPOSIT`, like the Explorer.
 */
import type { ExplorerTransaction } from "@nearpay-internal/spec";
import { formatted, usdValue } from "./quote-math.js";
import { type SandboxToken, tokenById } from "./tokens.js";

export const EXPLORER_DEFAULT_STATUSES = ["FAILED", "PROCESSING", "REFUNDED", "SUCCESS"] as const;

/** Simulated execution states behind each Explorer status. */
const STATES_BY_STATUS: Record<string, readonly string[]> = {
  PENDING_DEPOSIT: ["PENDING_DEPOSIT"],
  INCOMPLETE_DEPOSIT: ["INCOMPLETE_DEPOSIT"],
  PROCESSING: ["KNOWN_DEPOSIT_TX", "PROCESSING"],
  SUCCESS: ["SUCCESS"],
  REFUNDED: ["REFUNDED"],
  FAILED: ["FAILED"],
};

const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

/** Explorer status of a simulated execution state. */
export function explorerStatus(state: string): string {
  return state === "KNOWN_DEPOSIT_TX" ? "PROCESSING" : state;
}

/**
 * The simulated execution states matching an Explorer `statuses` filter (comma-separated; absent → the
 * Explorer default). Values the Explorer does not document match nothing.
 */
export function statesForStatuses(statuses: string | undefined): string[] {
  const wanted = statuses === undefined ? [...EXPLORER_DEFAULT_STATUSES] : statuses.split(",");
  const out = new Set<string>();
  for (const s of wanted) for (const state of STATES_BY_STATUS[s] ?? []) out.add(state);
  return [...out].sort();
}

export interface ExplorerSource {
  readonly request: {
    readonly originAsset: string;
    readonly destinationAsset: string;
    readonly recipient: string;
    readonly refundTo: string;
    readonly depositType: string;
    readonly recipientType: string;
    readonly refundType: string;
    readonly referral?: string | null | undefined;
  };
  /** The echoed (50/50 split) app fees of the signed quote; absent when the request had none. */
  readonly appFees: readonly { recipient: string; fee: number }[] | null | undefined;
  readonly refundFee: string | null | undefined;
  readonly depositAddress: string;
  readonly depositMemo: string | null;
  readonly state: string;
  readonly createdAt: Date;
  readonly depositedAmount: string | null;
  readonly deliveredAmount: string | null;
  readonly refundReason: string | null;
  readonly nearTxHashes: readonly string[];
  readonly originTxHashes: readonly string[];
  readonly destinationTxHashes: readonly string[];
}

function amountFields(amount: string | null, t: SandboxToken | undefined) {
  if (amount === null || amount === "0" || !t) return { amount: "0", formatted: "0", usd: "0" };
  const v = BigInt(amount);
  return { amount, formatted: formatted(v, t), usd: usdValue(v, t) };
}

export function explorerRow(s: ExplorerSource): ExplorerTransaction {
  const origin = tokenById(s.request.originAsset);
  const dest = tokenById(s.request.destinationAsset);
  const final = FINAL.has(s.state);
  const amountIn = amountFields(final ? s.depositedAmount : null, origin);
  const amountOut = amountFields(s.state === "SUCCESS" ? s.deliveredAmount : null, dest);
  const refundFee = s.refundFee ?? "0";
  return {
    originAsset: s.request.originAsset,
    destinationAsset: s.request.destinationAsset,
    depositAddress: s.depositAddress,
    depositMemo: s.depositMemo,
    depositAddressAndMemo: null,
    recipient: s.request.recipient,
    status: explorerStatus(s.state),
    createdAt: s.createdAt.toISOString(),
    createdAtTimestamp: Math.floor(s.createdAt.getTime() / 1000),
    intentHashes: null,
    referral: s.request.referral ?? null,
    amountIn: amountIn.amount,
    amountInFormatted: amountIn.formatted,
    amountInUsd: amountIn.usd,
    amountOut: amountOut.amount,
    amountOutFormatted: amountOut.formatted,
    amountOutUsd: amountOut.usd,
    appFees: s.appFees ? s.appFees.map((f) => ({ recipient: f.recipient, fee: f.fee })) : null,
    nearTxHashes: [...s.nearTxHashes],
    originChainTxHashes: [...s.originTxHashes],
    destinationChainTxHashes: [...s.destinationTxHashes],
    refundTo: s.request.refundTo,
    senders: [],
    refundFee,
    refundFeeFormatted: origin && refundFee !== "0" ? formatted(BigInt(refundFee), origin) : "0",
    refundReason: s.refundReason,
    depositType: s.request.depositType,
    recipientType: s.request.recipientType,
    refundType: s.request.refundType,
  };
}
