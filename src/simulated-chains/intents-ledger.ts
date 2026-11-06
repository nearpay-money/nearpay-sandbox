/**
 * Simulated `intents.near` ledger: balances keyed by (account, token) and the event log that the
 * rails sandbox indexer reads (`GET /sim/intents/events`). Log lines use the mainnet NEP-297 shape
 * (`EVENT_JSON:{standard, version, event, data}`): NEP-245 `mt_transfer`/`mt_mint` and DIP-4
 * `transfer`/`intents_executed` (DIP-4 0.4.3 as observed on mainnet, foundations §14).
 */
import { sql } from "@nearpay-internal/db";
import type { Tx } from "../app/context.js";

export const DIP4_VERSION = "0.4.3";
export const NEP245_VERSION = "1.0.0";
/** Liquidity provider of simulated swaps into Intents accounts (never debited). */
export const SOLVER_ACCOUNT = "sbx-solver.near";

export function eventLog(standard: string, version: string, event: string, data: unknown): string {
  return `EVENT_JSON:${JSON.stringify({ standard, version, event, data })}`;
}

export function mtTransferLog(t: {
  from: string;
  to: string;
  tokens: readonly [string, string][];
  memo?: string | undefined;
}): string {
  return eventLog("nep245", NEP245_VERSION, "mt_transfer", [
    {
      old_owner_id: t.from,
      new_owner_id: t.to,
      token_ids: t.tokens.map(([id]) => id),
      amounts: t.tokens.map(([, a]) => a),
      ...(t.memo !== undefined ? { memo: t.memo } : {}),
    },
  ]);
}

export function mtMintLog(owner: string, token: string, amount: string, memo: string): string {
  return eventLog("nep245", NEP245_VERSION, "mt_mint", [
    { owner_id: owner, token_ids: [token], amounts: [amount], memo },
  ]);
}

export async function balanceOf(tx: Tx, account: string, token: string): Promise<bigint> {
  const r = await tx
    .selectFrom("sim_intents_balances")
    .select("amount")
    .where("account_id", "=", account)
    .where("token", "=", token)
    .executeTakeFirst();
  return r ? BigInt(r.amount) : 0n;
}

/** Adds to a balance; returns the new balance. */
export async function credit(tx: Tx, account: string, token: string, amount: bigint): Promise<bigint> {
  const r = await sql<{ amount: string }>`
    insert into sim_intents_balances (account_id, token, amount) values (${account}, ${token}, ${amount.toString()})
    on conflict (account_id, token) do update set amount = sim_intents_balances.amount + excluded.amount
    returning amount::text`.execute(tx);
  return BigInt((r.rows[0] as { amount: string }).amount);
}

/** Subtracts from a balance; the caller has checked it is sufficient (the check constraint backs it). */
export async function debit(tx: Tx, account: string, token: string, amount: bigint): Promise<void> {
  await sql`update sim_intents_balances set amount = amount - ${amount.toString()}::numeric
    where account_id = ${account} and token = ${token}`.execute(tx);
}

export async function appendEvents(tx: Tx, txHash: string, block: bigint, logs: readonly string[]): Promise<void> {
  if (logs.length === 0) return;
  await tx
    .insertInto("sim_intents_events")
    .values(logs.map((log) => ({ tx_hash: txHash, block_height: block.toString(), log })))
    .execute();
}
