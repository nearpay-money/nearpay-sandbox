/**
 * Effects of a simulated swap on the simulated chains: the destination transfer at SUCCESS, the
 * refund at REFUNDED (and of an excess at SUCCESS). Intents recipients are credited on the simulated
 * Verifier ledger with an `mt_transfer` event (the rails sandbox indexer attributes it, like the NEAR
 * indexer on mainnet); chain recipients get a simulated chain transaction the sandbox verifiers read
 * (`GET /sim/chains/{chain}/tx/{hash}`).
 */
import { type ChainFamily, getChain } from "@nearpay-internal/chains";
import type { Tx } from "../app/context.js";
import { nextBlock } from "../app/context.js";
import type { SimTransfer } from "../infra/db/schema.js";
import { solverAddress, txHash } from "./addresses.js";
import { appendEvents, credit, DIP4_VERSION, eventLog, mtTransferLog, SOLVER_ACCOUNT } from "./intents-ledger.js";

export const NEAR_CHAIN = "near:mainnet";

function family(chain: string): ChainFamily {
  const c = getChain(chain);
  if (!c) throw new RangeError(`unknown chain ${chain}`);
  return c.family;
}

/** Records a simulated chain transaction (final after `finalizeAfterMs`). */
export async function recordTx(
  tx: Tx,
  t: { hash: string; chain: string; transfers: SimTransfer[]; now: Date; finalizeAfterMs: number },
): Promise<void> {
  await tx
    .insertInto("sim_txs")
    .values({
      hash: t.hash,
      chain: t.chain,
      transfers: JSON.stringify(t.transfers),
      finalized_at: new Date(t.now.getTime() + t.finalizeAfterMs),
    })
    .onConflict((oc) => oc.column("hash").doNothing())
    .execute();
}

export interface Payout {
  /** `intents` = credit an Intents account; `chain` = a transfer on `chain`. */
  readonly kind: "intents" | "chain";
  readonly chain: string;
  readonly token: string;
  readonly to: string;
  readonly amount: bigint;
  /** Unique per payout (deterministic tx hash). */
  readonly seed: string;
}

export interface PayoutResult {
  readonly hash: string;
  readonly chain: string;
  /** NEAR transactions (Intents payouts). */
  readonly nearTx: boolean;
}

/**
 * Pays `amount` of `token` to `to` from the simulated liquidity provider: the transfer's `from` is `SOLVER_ACCOUNT`
 * for Intents credits (the `mt_transfer` `old_owner_id` the rails indexer reads) and the provider's address on the
 * chain otherwise (`solverAddress`).
 */
export async function payout(tx: Tx, p: Payout, now: Date, timeScale: number): Promise<PayoutResult> {
  const finalizeAfterMs = Math.round(2_000 * timeScale);
  if (p.kind === "intents") {
    const hash = txHash("near", p.seed);
    const block = await nextBlock(tx);
    await credit(tx, p.to, p.token, p.amount);
    await appendEvents(tx, hash, block, [
      mtTransferLog({ from: SOLVER_ACCOUNT, to: p.to, tokens: [[p.token, p.amount.toString()]] }),
      eventLog("dip4", DIP4_VERSION, "transfer", [
        { account_id: SOLVER_ACCOUNT, receiver_id: p.to, tokens: { [p.token]: p.amount.toString() } },
      ]),
    ]);
    await recordTx(tx, {
      hash,
      chain: NEAR_CHAIN,
      transfers: [{ token: p.token, from: SOLVER_ACCOUNT, to: p.to, amount: p.amount.toString() }],
      now,
      finalizeAfterMs,
    });
    return { hash, chain: NEAR_CHAIN, nearTx: true };
  }
  const hash = txHash(family(p.chain), p.seed);
  await recordTx(tx, {
    hash,
    chain: p.chain,
    transfers: [{ token: p.token, from: solverAddress(p.chain), to: p.to, amount: p.amount.toString() }],
    now,
    finalizeAfterMs,
  });
  return { hash, chain: p.chain, nearTx: family(p.chain) === "near" };
}
