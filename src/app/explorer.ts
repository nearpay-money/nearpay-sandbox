/**
 * `GET /api/v0/transactions` (Stage 2, sandbox LLD §3): the Explorer mirror rails' Explorer feed reads in test
 * mode. Rows are the sandbox's quotes (dry quotes are never stored), newest first, with the execution's stored
 * status (at most one materializer tick behind `GET /v0/status`, like the live Explorer lags 1Click).
 *
 * Query (spec `ExplorerTransactionsQuery`): `referral`, `statuses` (default without the `*_DEPOSIT` ones),
 * `startTimestamp` / `endTimestamp` (exclusive, on creation time), `depositMemo`, `search` (deposit address,
 * recipient, refund address or any tx hash), `numberOfTransactions` (≤ 1000, default 50) and the cursor
 * `lastDepositAddress` (+ `lastDepositMemo`) with `direction` `next` (older rows, default) or `prev` (newer rows;
 * still returned newest first). An unknown cursor returns no rows. `showTestTxs` is accepted and ignored (every
 * sandbox row is a test transaction). No rate limit.
 */

import { sql } from "@nearpay-internal/db";
import type { ExplorerTransaction, ExplorerTransactionsQuery } from "@nearpay-internal/spec";
import { explorerRow, statesForStatuses } from "../domain/explorer.js";
import { depositKey, type Sandbox } from "./context.js";
import type { QuoteRow } from "./executions.js";

export const EXPLORER_DEFAULT_PAGE = 50;

type Echo = {
  quoteRequest?: { appFees?: { recipient: string; fee: number }[] | null };
  quote?: { refundFee?: string | null };
};

export function toExplorerRow(row: QuoteRow): ExplorerTransaction {
  const r = row.request as unknown as Parameters<typeof explorerRow>[0]["request"];
  const echo = row.response as unknown as Echo;
  return explorerRow({
    request: r,
    appFees: echo.quoteRequest?.appFees,
    refundFee: echo.quote?.refundFee,
    depositAddress: row.deposit_address,
    depositMemo: row.deposit_memo,
    state: row.state,
    createdAt: row.created_at,
    depositedAmount: row.deposited_amount,
    deliveredAmount: row.delivered_amount,
    refundReason: row.refund_reason,
    nearTxHashes: row.near_tx_hashes,
    originTxHashes: row.deposit_tx_hashes,
    destinationTxHashes: row.destination_tx_hashes,
  });
}

export async function explorerTransactions(sb: Sandbox, q: ExplorerTransactionsQuery): Promise<ExplorerTransaction[]> {
  const limit = q.numberOfTransactions ?? EXPLORER_DEFAULT_PAGE;
  const states = statesForStatuses(q.statuses);
  if (states.length === 0) return [];

  let cursorSeq: string | null = null;
  if (q.lastDepositAddress !== undefined) {
    const c = await sb.db
      .selectFrom("sim_quotes")
      .select("seq")
      .where((eb) =>
        q.lastDepositMemo !== undefined
          ? eb("deposit_key", "=", depositKey(q.lastDepositAddress as string, q.lastDepositMemo))
          : eb("deposit_address", "=", q.lastDepositAddress as string),
      )
      .orderBy("seq", "desc")
      .executeTakeFirst();
    if (!c) return [];
    cursorSeq = String(c.seq);
  }
  // `prev` pages towards newer rows from the cursor; without a cursor every direction starts at the newest.
  const newer = q.direction === "prev" && cursorSeq !== null;

  let query = sb.db.selectFrom("sim_quotes").selectAll().where("state", "in", states);
  if (q.referral !== undefined) query = query.where(sql<boolean>`request->>'referral' = ${q.referral}`);
  if (q.startTimestamp !== undefined) query = query.where("created_at", ">", new Date(q.startTimestamp));
  if (q.endTimestamp !== undefined) query = query.where("created_at", "<", new Date(q.endTimestamp));
  if (q.depositMemo !== undefined) query = query.where("deposit_memo", "=", q.depositMemo);
  if (q.search !== undefined) {
    const term = q.search;
    query = query.where(
      sql<boolean>`(deposit_address = ${term} or request->>'recipient' = ${term} or request->>'refundTo' = ${term}
        or ${term} = any(deposit_tx_hashes) or ${term} = any(destination_tx_hashes)
        or ${term} = any(refund_tx_hashes) or ${term} = any(near_tx_hashes))`,
    );
  }
  if (cursorSeq !== null) query = query.where("seq", newer ? ">" : "<", cursorSeq as never);
  const rows = await query
    .orderBy("seq", newer ? "asc" : "desc")
    .limit(limit)
    .execute();
  if (newer) rows.reverse();
  return rows.map(toExplorerRow);
}
