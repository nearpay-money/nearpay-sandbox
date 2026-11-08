/**
 * `GET /sim/chains/{chain}/tx/{hash}`: what a simulated chain transaction transferred (sandbox verifiers), with the
 * sender of each transfer (rails fills `Evidence.sender` from it) and, since spec 0.4.0 (sandbox LLD §10), the
 * chain fields: `block_ref` (Solana slot / Bitcoin height), Bitcoin `confirmations` and output `vout`, Solana
 * `token_account` and `failed`. Rows recorded before v1.6 answer the new fields absent (rails: unknown).
 */
import { getChain } from "@nearpay-internal/chains";
import { ApiError } from "@nearpay-internal/service";
import { dbNow, type Sandbox } from "../app/context.js";
import { bitcoinConfirmations } from "../domain/chain-txs.js";

export async function getChainTx(sb: Sandbox, chain: string, hash: string) {
  const row = await sb.db
    .selectFrom("sim_txs")
    .select(["transfers", "finalized_at", "block_ref", "failed"])
    .where("hash", "=", hash)
    .where("chain", "=", chain)
    .executeTakeFirst();
  if (!row) throw ApiError.missing("transaction", hash, "hash");
  const now = (await dbNow(sb.db)).getTime();
  const family = getChain(chain)?.family;
  const v16 = row.block_ref !== null;
  const confirmations =
    v16 && family === "bitcoin" ? bitcoinConfirmations(now, row.finalized_at.getTime(), sb.timeScale) : null;
  return {
    finalized: row.finalized_at.getTime() <= now,
    // spec 0.3.1: every transfer names its sender; rows recorded before it say null (unknown)
    transfers: row.transfers.map((t) => ({
      token: t.token,
      from: t.from ?? null,
      to: t.to,
      amount: t.amount,
      ...(t.vout !== undefined ? { vout: t.vout } : {}),
      ...(t.token_account !== undefined ? { token_account: t.token_account } : {}),
    })),
    ...(v16 ? { block_ref: row.block_ref } : {}),
    ...(confirmations !== null ? { confirmations } : {}),
    ...(row.failed ? { failed: true } : {}),
  };
}
