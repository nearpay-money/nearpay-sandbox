/**
 * `GET /sim/chains/{chain}/tx/{hash}`: what a simulated chain transaction transferred (sandbox verifiers), with the
 * sender of each transfer (rails fills `Evidence.sender` from it).
 */
import { ApiError } from "@nearpay-internal/service";
import { dbNow, type Sandbox } from "../app/context.js";

export async function getChainTx(sb: Sandbox, chain: string, hash: string) {
  const row = await sb.db
    .selectFrom("sim_txs")
    .select(["transfers", "finalized_at"])
    .where("hash", "=", hash)
    .where("chain", "=", chain)
    .executeTakeFirst();
  if (!row) throw ApiError.missing("transaction", hash, "hash");
  const now = await dbNow(sb.db);
  return {
    finalized: row.finalized_at.getTime() <= now.getTime(),
    // spec 0.3.1: every transfer names its sender; rows recorded before it say null (unknown)
    transfers: row.transfers.map((t) => ({ token: t.token, from: t.from ?? null, to: t.to, amount: t.amount })),
  };
}
