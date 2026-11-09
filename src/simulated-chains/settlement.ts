/**
 * Effects of a simulated swap on the simulated chains: the destination transfer at SUCCESS, the
 * refund at REFUNDED (and of an excess at SUCCESS). Intents recipients are credited on the simulated
 * Verifier ledger with an `mt_transfer` event (the rails sandbox indexer attributes it, like the NEAR
 * indexer on mainnet); chain recipients get a simulated chain transaction the sandbox verifiers read
 * (`GET /sim/chains/{chain}/tx/{hash}`).
 */
import { type ChainFamily, getChain } from "@nearpay-internal/chains";
import { sql } from "@nearpay-internal/db";
import type { Tx } from "../app/context.js";
import { nextBlock } from "../app/context.js";
import { BTC_CHANGE_SATS, blockRefOf, destinationPlan, splitBitcoinPayout } from "../domain/chain-txs.js";
import { tokenById } from "../domain/tokens.js";
import type { SimTransfer } from "../infra/db/schema.js";
import { associatedTokenAccount, solverAddress, txHash } from "./addresses.js";
import { appendEvents, credit, DIP4_VERSION, eventLog, mtTransferLog, SOLVER_ACCOUNT } from "./intents-ledger.js";

export const NEAR_CHAIN = "near:mainnet";

function family(chain: string): ChainFamily {
  const c = getChain(chain);
  if (!c) throw new RangeError(`unknown chain ${chain}`);
  return c.family;
}

/**
 * Chain fields of a transfer (sandbox LLD §10): Solana SPL transfers name the recipient's associated token account
 * (null for SOL), Bitcoin transfers their output index (in order unless given).
 */
export function decorateTransfers(chain: string, transfers: readonly SimTransfer[]): SimTransfer[] {
  const f = family(chain);
  if (f === "solana")
    return transfers.map((t) => {
      const mint = tokenById(t.token)?.contractAddress;
      return { ...t, token_account: mint ? associatedTokenAccount(t.to, mint) : null };
    });
  if (f === "bitcoin") return transfers.map((t, i) => ({ ...t, vout: t.vout ?? i }));
  return [...transfers];
}

/**
 * Records a simulated chain transaction (final after `finalizeAfterMs`; for Bitcoin that is its first confirmation).
 * Solana and Bitcoin transactions get a simulated slot / height (`block_ref`) and their chain fields.
 */
export async function recordTx(
  tx: Tx,
  t: { hash: string; chain: string; transfers: SimTransfer[]; now: Date; finalizeAfterMs: number; failed?: boolean },
): Promise<void> {
  const f = getChain(t.chain)?.family;
  let blockRef: string | null = null;
  if (f === "solana" || f === "bitcoin") {
    const r = await sql<{ n: string }>`select nextval('sim_chain_block_seq')::text as n`.execute(tx);
    blockRef = blockRefOf(f, BigInt((r.rows[0] as { n: string }).n));
  }
  await tx
    .insertInto("sim_txs")
    .values({
      hash: t.hash,
      chain: t.chain,
      transfers: JSON.stringify(f ? decorateTransfers(t.chain, t.transfers) : t.transfers),
      finalized_at: new Date(t.now.getTime() + t.finalizeAfterMs),
      block_ref: blockRef,
      failed: t.failed ?? false,
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
  /** Scenario of the quote (`08` slow finality, `09` failed signature / split outputs; sandbox LLD §10). */
  readonly scenario?: string;
  /** Destination payout or refund (scenario `09` applies to payouts only). */
  readonly leg?: "payout" | "refund";
}

export interface PayoutResult {
  /** Transaction hashes in order (scenario `09` on Solana: the failed signature first). */
  readonly hashes: readonly string[];
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
  const fam = p.kind === "intents" ? "near" : family(p.chain);
  const plan = destinationPlan(p.scenario ?? "00", fam, p.leg ?? "payout");
  const finalizeAfterMs = Math.round(plan.finalityMs * timeScale);
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
    return { hashes: [hash], chain: NEAR_CHAIN, nearTx: true };
  }
  const solver = solverAddress(p.chain);
  const hashes: string[] = [];
  if (plan.failedFirst) {
    // Scenario 09 (Solana): a signature that landed but failed precedes the real payout; rails must skip it.
    const failed = txHash(fam, `failed:${p.seed}`);
    await recordTx(tx, { hash: failed, chain: p.chain, transfers: [], now, finalizeAfterMs, failed: true });
    hashes.push(failed);
  }
  const hash = txHash(fam, p.seed);
  let transfers: SimTransfer[] = [{ token: p.token, from: solver, to: p.to, amount: p.amount.toString() }];
  const parts = plan.splitOutputs ? splitBitcoinPayout(p.amount) : [p.amount];
  if (parts.length === 2) {
    // Scenario 09 (Bitcoin): two outputs to the destination around the solver's change; rails must sum them.
    transfers = [
      { token: p.token, from: solver, to: p.to, amount: (parts[0] as bigint).toString(), vout: 0 },
      { token: p.token, from: solver, to: solver, amount: BTC_CHANGE_SATS.toString(), vout: 1 },
      { token: p.token, from: solver, to: p.to, amount: (parts[1] as bigint).toString(), vout: 2 },
    ];
  }
  await recordTx(tx, { hash, chain: p.chain, transfers, now, finalizeAfterMs });
  hashes.push(hash);
  return { hashes, chain: p.chain, nearTx: fam === "near" };
}
