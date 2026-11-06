/** `GET /sim/chains/{chain}/tx/{hash}`: what a simulated chain transaction transferred (sandbox verifiers). */
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
  return { finalized: row.finalized_at.getTime() <= now.getTime(), transfers: row.transfers };
}
