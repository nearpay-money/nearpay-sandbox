/**
 * Simulated executions: deposits, timelines, status (`GET /v0/status`), the materializer that applies
 * due timeline steps, and manual control (`POST /sim/advance`). Every change to a quote happens in one
 * transaction holding the quote row (`FOR UPDATE`), so polls, the materializer and test helpers never
 * apply a step twice.
 */

import { explorerTxUrl, getChain } from "@nearpay-internal/chains";
import type { Selectable } from "@nearpay-internal/db";
import { sql, withTx } from "@nearpay-internal/db";
import { ApiError } from "@nearpay-internal/service";
import type { OneClickStatusResponse } from "@nearpay-internal/spec";
import { formatted, scenarioDeposit, usdValue } from "../domain/quote-math.js";
import { tokenById } from "../domain/tokens.js";
import type { SimQuotesTable, StepRow } from "../infra/db/schema.js";
import { dueSteps, isTerminal, nextDue, type Scenario, type Step, timeline } from "../scenarios/scenario.js";
import { txHash } from "../simulated-chains/addresses.js";
import { NEAR_CHAIN, payout, recordTx } from "../simulated-chains/settlement.js";
import { dbNow, depositKey, type Sandbox, type Tx } from "./context.js";

export type QuoteRow = Selectable<SimQuotesTable>;

interface QuoteRequestView {
  originAsset: string;
  destinationAsset: string;
  recipient: string;
  recipientType: string;
  refundTo: string;
  refundType: string;
  referral?: string;
}

const req = (row: QuoteRow) => row.request as unknown as QuoteRequestView;

export async function lockQuote(tx: Tx, key: string): Promise<QuoteRow | undefined> {
  return tx.selectFrom("sim_quotes").selectAll().where("deposit_key", "=", key).forUpdate().executeTakeFirst();
}

export function notFound(address: string): ApiError {
  return new ApiError("resource_missing", {
    params: { object: "deposit address", id: address },
    param: "depositAddress",
  });
}

export function conflict(state: string, detail?: string): ApiError {
  return new ApiError("state_conflict", {
    params: { object: "simulated execution", state },
    ...(detail ? { message: `The simulated execution is ${state}: ${detail}.` } : {}),
  });
}

export function originFamilyTx(row: QuoteRow, seed: string): string {
  const c = getChain(row.origin_chain);
  return txHash(c?.family ?? "evm", seed);
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

/** Applies one timeline/advance step: state plus the payout/refund effects on the simulated chains. */
export async function applyStep(
  sb: Sandbox,
  tx: Tx,
  row: QuoteRow,
  step: Omit<Step, "at">,
  now: Date,
): Promise<QuoteRow> {
  const r = req(row);
  const patch: Partial<Record<keyof SimQuotesTable, unknown>> = { state: step.status, updated_at: now };
  const dest = [...row.destination_tx_hashes];
  const refunds = [...row.refund_tx_hashes];
  const near = [...row.near_tx_hashes];
  if (step.status === "SUCCESS" && step.delivered !== undefined) {
    const out = await payout(
      tx,
      {
        kind: r.recipientType === "INTENTS" ? "intents" : "chain",
        chain: row.destination_chain,
        token: r.destinationAsset,
        to: r.recipient,
        amount: BigInt(step.delivered),
        seed: `settle:${row.deposit_key}`,
      },
      now,
      sb.timeScale,
    );
    dest.push(out.hash);
    if (out.nearTx) near.push(out.hash);
    patch.delivered_amount = step.delivered;
  }
  if ((step.status === "SUCCESS" || step.status === "REFUNDED") && step.refunded && BigInt(step.refunded) > 0n) {
    const out = await payout(
      tx,
      {
        kind: r.refundType === "INTENTS" ? "intents" : "chain",
        chain: r.refundType === "INTENTS" ? NEAR_CHAIN : row.origin_chain,
        token: r.originAsset,
        to: r.refundTo,
        amount: BigInt(step.refunded),
        seed: `refund:${row.deposit_key}:${step.status}`,
      },
      now,
      sb.timeScale,
    );
    refunds.push(out.hash);
    if (out.nearTx) near.push(out.hash);
  }
  if (step.refunded !== undefined) patch.refunded_amount = step.refunded;
  if (step.refundReason) patch.refund_reason = step.refundReason;
  patch.destination_tx_hashes = dest;
  patch.refund_tx_hashes = refunds;
  patch.near_tx_hashes = near;
  const updated = await tx
    .updateTable("sim_quotes")
    .set(patch as never)
    .where("deposit_key", "=", row.deposit_key)
    .returningAll()
    .executeTakeFirstOrThrow();
  sb.log.info({ deposit: row.deposit_address, status: step.status, scenario: row.scenario }, "sandbox step");
  return updated;
}

/** Applies every step that is due at `now`. */
export async function materialize(sb: Sandbox, tx: Tx, row: QuoteRow, now: Date): Promise<QuoteRow> {
  if (row.manual || row.next_at === null || row.next_at.getTime() > now.getTime()) return row;
  const steps = row.timeline as Step[];
  const due = dueSteps(steps, row.applied, now.getTime());
  let current = row;
  for (const s of due) current = await applyStep(sb, tx, current, s, now);
  const applied = row.applied + due.length;
  const next = nextDue(steps, applied);
  return tx
    .updateTable("sim_quotes")
    .set({ applied, next_at: next === null ? null : new Date(next) })
    .where("deposit_key", "=", row.deposit_key)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Materializes due steps of up to `limit` quotes (background loop). Returns quotes processed. */
export async function materializeDue(sb: Sandbox, limit = 50): Promise<number> {
  const due = await sb.db
    .selectFrom("sim_quotes")
    .select("deposit_key")
    .where("next_at", "<=", sql<Date>`now()`)
    .where("manual", "=", false)
    .orderBy("next_at")
    .limit(limit)
    .execute();
  let n = 0;
  for (const { deposit_key } of due) {
    await withTx(sb.db, async (tx) => {
      const row = await tx
        .selectFrom("sim_quotes")
        .selectAll()
        .where("deposit_key", "=", deposit_key)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return;
      await materialize(sb, tx, row, await dbNow(tx));
      n++;
    });
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------------------------

interface DepositInput {
  amount: bigint;
  txHash: string;
}

/** Records a deposit and starts its timeline (or, in manual mode, only moves to KNOWN_DEPOSIT_TX). */
export async function recordDeposit(sb: Sandbox, tx: Tx, row: QuoteRow, d: DepositInput, now: Date): Promise<QuoteRow> {
  const r = req(row);
  await recordTx(tx, {
    hash: d.txHash,
    chain: row.origin_chain,
    transfers: [{ token: r.originAsset, to: row.deposit_address, amount: d.amount.toString() }],
    now,
    finalizeAfterMs: 0,
  });
  const base = {
    deposited_amount: d.amount.toString(),
    deposited_at: now,
    deposit_tx_hashes: [...row.deposit_tx_hashes, d.txHash],
    updated_at: now,
  };
  if (row.manual) {
    return tx
      .updateTable("sim_quotes")
      .set({ ...base, ...(row.state === "PENDING_DEPOSIT" ? { state: "KNOWN_DEPOSIT_TX" } : {}) })
      .where("deposit_key", "=", row.deposit_key)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  const steps = timeline({
    scenario: row.scenario as Scenario,
    depositAt: now.getTime(),
    deposited: d.amount,
    amountIn: BigInt(row.amount_in),
    minAmountIn: BigInt(row.min_amount_in),
    amountOut: BigInt(row.amount_out),
    deadline: row.deadline.getTime(),
    timeScale: sb.timeScale,
  });
  const first = steps[0] as Step;
  return tx
    .updateTable("sim_quotes")
    .set({
      ...base,
      timeline: JSON.stringify(steps satisfies StepRow[]),
      applied: 0,
      next_at: new Date(first.at),
    })
    .where("deposit_key", "=", row.deposit_key)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Scenario 06: a deposit also pays the older open quotes of the same payment (duplicate settlement). */
export async function payOlderSiblings(sb: Sandbox, tx: Tx, row: QuoteRow, now: Date): Promise<void> {
  if (row.scenario !== "06") return;
  const siblings = await tx
    .selectFrom("sim_quotes")
    .selectAll()
    .where("group_key", "=", row.group_key)
    .where("state", "=", "PENDING_DEPOSIT")
    .where("deposited_amount", "is", null)
    .where("seq", "<", row.seq.toString() as never)
    .where("deposit_key", "<>", row.deposit_key)
    .orderBy("seq")
    .forUpdate()
    .execute();
  for (const s of siblings) {
    await recordDeposit(
      sb,
      tx,
      s,
      { amount: BigInt(s.amount_in), txHash: originFamilyTx(s, `dup:${s.deposit_key}`) },
      now,
    );
  }
}

/** `POST /v0/deposit/submit`: the payer's wallet reported a deposit tx (idempotent per tx hash). */
export async function submitDeposit(
  sb: Sandbox,
  b: { txHash: string; depositAddress: string; memo?: string | undefined },
): Promise<OneClickStatusResponse> {
  return withTx(sb.db, async (tx) => {
    let row = await lockQuote(tx, depositKey(b.depositAddress, b.memo));
    if (!row) throw notFound(b.depositAddress);
    const now = await dbNow(tx);
    if (row.deposited_amount === null && !isTerminal(row.state)) {
      const amount = scenarioDeposit(row.scenario, {
        amountIn: BigInt(row.amount_in),
        minAmountIn: BigInt(row.min_amount_in),
      });
      row = await recordDeposit(sb, tx, row, { amount, txHash: b.txHash }, now);
      await payOlderSiblings(sb, tx, row, now);
    } else if (!row.deposit_tx_hashes.includes(b.txHash)) {
      row = await tx
        .updateTable("sim_quotes")
        .set({ deposit_tx_hashes: [...row.deposit_tx_hashes, b.txHash] })
        .where("deposit_key", "=", row.deposit_key)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    row = await materialize(sb, tx, row, now);
    return statusOf(row);
  });
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

function txDetails(chain: string, hashes: readonly string[]) {
  return hashes.map((hash) => ({ hash, explorerUrl: getChain(chain) ? explorerTxUrl(chain, hash) : "" }));
}

/** 1Click status response for a quote row. */
export function statusOf(row: QuoteRow): OneClickStatusResponse {
  const r = req(row);
  const origin = tokenById(r.originAsset);
  const dest = tokenById(r.destinationAsset);
  const fmt = (amount: string | null, t: typeof origin) =>
    amount !== null && t ? { amount, formatted: formatted(BigInt(amount), t), usd: usdValue(BigInt(amount), t) } : null;
  const dep = fmt(row.deposited_amount, origin);
  const out = fmt(row.delivered_amount, dest);
  const ref = fmt(row.refunded_amount, origin);
  return {
    correlationId: row.correlation_id,
    quoteResponse: row.response as never,
    status: row.state,
    updatedAt: row.updated_at.toISOString(),
    swapDetails: {
      intentHashes: [],
      nearTxHashes: row.near_tx_hashes,
      ...(dep ? { amountIn: dep.amount, amountInFormatted: dep.formatted, amountInUsd: dep.usd } : {}),
      ...(out ? { amountOut: out.amount, amountOutFormatted: out.formatted, amountOutUsd: out.usd, slippage: 0 } : {}),
      originChainTxHashes: txDetails(row.origin_chain, row.deposit_tx_hashes),
      destinationChainTxHashes: txDetails(row.destination_chain, row.destination_tx_hashes),
      ...(ref
        ? { refundedAmount: ref.amount, refundedAmountFormatted: ref.formatted, refundedAmountUsd: ref.usd }
        : {}),
      ...(row.refund_reason ? { refundReason: row.refund_reason } : {}),
      ...(dep
        ? { depositedAmount: dep.amount, depositedAmountFormatted: dep.formatted, depositedAmountUsd: dep.usd }
        : {}),
      ...(r.referral ? { referral: r.referral } : {}),
    },
  };
}

/** `GET /v0/status`: materializes due steps first, so a poll always sees the current timeline state. */
export async function getStatus(sb: Sandbox, address: string, memo?: string): Promise<OneClickStatusResponse> {
  return withTx(sb.db, async (tx) => {
    const row = await lockQuote(tx, depositKey(address, memo));
    if (!row) throw notFound(address);
    return statusOf(await materialize(sb, tx, row, await dbNow(tx)));
  });
}
