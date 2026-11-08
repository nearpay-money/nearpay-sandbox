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
import {
  dueSteps,
  duplicateInTime,
  duplicateTargets,
  isTerminal,
  nextDue,
  type Scenario,
  type Step,
  timeline,
} from "../scenarios/scenario.js";
import { simulatedPayer, txHash } from "../simulated-chains/addresses.js";
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
  referral?: string | null;
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
  /** Counts as made before the deadline (a refund leg's scenario `06` duplicate). */
  inTime?: boolean;
  /** Sender, when known (Intents transfers name it); otherwise `depositSender`. */
  from?: string;
}

/**
 * Who sent a simulated deposit (spec 0.3.1 `SimTx.transfers[].from`): the payer's refund address when it is on the
 * deposit chain (the wallet that pays is the one refunds return to), otherwise the documented simulated payer of
 * that chain (sandbox LLD §4.1).
 */
export function depositSender(r: { refundTo: string; refundType: string }, originChain: string): string {
  const refundChain = r.refundType === "INTENTS" ? NEAR_CHAIN : originChain;
  return refundChain === originChain ? r.refundTo : simulatedPayer(originChain);
}

/** Records a deposit and starts its timeline (or, in manual mode, only moves to KNOWN_DEPOSIT_TX). */
export async function recordDeposit(sb: Sandbox, tx: Tx, row: QuoteRow, d: DepositInput, now: Date): Promise<QuoteRow> {
  const r = req(row);
  await recordTx(tx, {
    hash: d.txHash,
    chain: row.origin_chain,
    transfers: [
      {
        token: r.originAsset,
        from: d.from ?? depositSender(r, row.origin_chain),
        to: row.deposit_address,
        amount: d.amount.toString(),
      },
    ],
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
    ...(d.inTime ? { inTime: true } : {}),
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

/**
 * Scenario 06 (sandbox LLD §4): a deposit also pays other open quotes of its group — a payment's older attempts
 * (duplicate settlement → overpayment), or every other open leg of a refund (duplicate refund leg; the duplicate
 * deposit counts as made in time, so an expired leg still settles). Siblings are locked in `seq` order.
 */
export async function payDuplicateSiblings(sb: Sandbox, tx: Tx, row: QuoteRow, now: Date): Promise<void> {
  if (row.scenario !== "06") return;
  const kind = row.scenario_kind;
  let q = tx
    .selectFrom("sim_quotes")
    .selectAll()
    .where("group_key", "=", row.group_key)
    .where("state", "=", "PENDING_DEPOSIT")
    .where("deposited_amount", "is", null)
    .where("deposit_key", "<>", row.deposit_key);
  if (duplicateTargets(kind) === "older") q = q.where("seq", "<", row.seq.toString() as never);
  const siblings = await q.orderBy("seq").forUpdate().execute();
  for (const s of siblings) {
    await recordDeposit(
      sb,
      tx,
      s,
      {
        amount: BigInt(s.amount_in),
        txHash: originFamilyTx(s, `dup:${s.deposit_key}`),
        ...(duplicateInTime(kind) ? { inTime: true } : {}),
      },
      now,
    );
    sb.log.info({ deposit: s.deposit_address, of: row.deposit_address, kind }, "sandbox duplicate deposit (06)");
  }
}

/** One token movement into an Intents account (a Verifier transfer). */
export interface IntentsCredit {
  readonly from: string;
  readonly to: string;
  readonly token: string;
  readonly amount: bigint;
  readonly memo?: string | undefined;
}

/**
 * Intents transfers into the deposit address of an `INTENTS`-deposit quote are its deposit, as 1Click sees a
 * transfer inside intents.near (refund route legs from a merchant's Intents account, sandbox LLD §3/§8): the
 * deposit is recorded with the Verifier transaction hash and the scenario timeline starts (plus scenario `06`
 * duplicates). Called before the transfer moves balances, so the lock order (quote rows, then balances) matches
 * the materializer's. Transfers of another asset, or into a quote that already has a deposit or is final, are
 * not attributed (logged). Returns the number of deposits recorded.
 */
export async function attributeIntentsDeposits(
  sb: Sandbox,
  tx: Tx,
  credits: readonly IntentsCredit[],
  txHash: string,
  now: Date,
): Promise<number> {
  const receivers = [...new Set(credits.map((c) => c.to))];
  if (receivers.length === 0) return 0;
  const rows = await tx
    .selectFrom("sim_quotes")
    .selectAll()
    .where("deposit_address", "in", receivers)
    .where("origin_chain", "=", NEAR_CHAIN)
    .where(sql<boolean>`request->>'depositType' = 'INTENTS'`)
    .orderBy("deposit_key")
    .forUpdate()
    .execute();
  if (rows.length === 0) return 0;
  const byKey = new Map(rows.map((r) => [r.deposit_key, r]));
  let n = 0;
  for (const c of credits) {
    const row = byKey.get(depositKey(c.to, c.memo)) ?? byKey.get(depositKey(c.to, null));
    if (!row) continue;
    if (req(row).originAsset !== c.token || row.deposited_amount !== null || isTerminal(row.state)) {
      sb.log.warn(
        { deposit: c.to, token: c.token, state: row.state, tx: txHash },
        "sandbox Intents transfer into a deposit address not attributed",
      );
      continue;
    }
    const updated = await recordDeposit(sb, tx, row, { amount: c.amount, txHash, from: c.from }, now);
    byKey.set(row.deposit_key, updated);
    await payDuplicateSiblings(sb, tx, updated, now);
    n++;
  }
  return n;
}

/** `POST /v0/deposit/submit`: the payer's wallet reported a deposit tx (idempotent per tx hash). */
export async function submitDeposit(
  sb: Sandbox,
  b: { txHash: string; depositAddress: string; memo?: string | null | undefined },
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
      await payDuplicateSiblings(sb, tx, row, now);
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

/**
 * The quote response as live 1Click nests it in `GET /v0/status` (mainnet, 2026-11-07; spec 0.2.0
 * `OneClickStatusQuoteResponse`): without `correlationId` (the status carries its own), and its `quoteRequest` echo
 * omits `quoteWaitingTimeMs`, although the signature covers it (the quote was signed over the full request), so a
 * verifier has to put the requested value back — sentinel does (rails' 3000).
 */
export function statusQuoteResponse(stored: unknown): OneClickStatusResponse["quoteResponse"] {
  const { correlationId: _id, ...q } = stored as OneClickStatusResponse["quoteResponse"];
  const { quoteWaitingTimeMs: _omitted, ...quoteRequest } = q.quoteRequest;
  return { ...q, quoteRequest };
}

/**
 * 1Click status response for a quote row, in live 1Click's shape (recorded mainnet status body, 2026-11-07;
 * spec 0.2.0): every swap detail is present, unset ones as `null`; `refundedAmount*` read `"0"` until a refund;
 * `refundFee` / `withdrawFee` repeat the quote's; no `referral`.
 */
export function statusOf(row: QuoteRow): OneClickStatusResponse {
  const r = req(row);
  const origin = tokenById(r.originAsset);
  const dest = tokenById(r.destinationAsset);
  const fmt = (amount: string | null, t: typeof origin) =>
    amount !== null && t ? { amount, formatted: formatted(BigInt(amount), t), usd: usdValue(BigInt(amount), t) } : null;
  const dep = fmt(row.deposited_amount, origin);
  const out = fmt(row.delivered_amount, dest);
  const ref = fmt(row.refunded_amount, origin);
  const quote = (row.response as { quote?: { refundFee?: string | null; withdrawFee?: string | null } }).quote;
  return {
    correlationId: row.correlation_id,
    quoteResponse: statusQuoteResponse(row.response),
    status: row.state,
    updatedAt: row.updated_at.toISOString(),
    swapDetails: {
      depositedAmount: dep?.amount ?? null,
      depositedAmountUsd: dep?.usd ?? null,
      depositedAmountFormatted: dep?.formatted ?? null,
      intentHashes: [],
      nearTxHashes: row.near_tx_hashes,
      amountIn: dep?.amount ?? null,
      amountInFormatted: dep?.formatted ?? null,
      amountInUsd: dep?.usd ?? null,
      amountOut: out?.amount ?? null,
      amountOutFormatted: out?.formatted ?? null,
      amountOutUsd: out?.usd ?? null,
      slippage: out ? 0 : null,
      refundedAmount: ref?.amount ?? "0",
      refundedAmountFormatted: ref?.formatted ?? "0",
      refundedAmountUsd: ref?.usd ?? "0",
      refundReason: row.refund_reason ?? null,
      refundFee: quote?.refundFee ?? "0",
      withdrawFee: quote?.withdrawFee ?? "0",
      originChainTxHashes: txDetails(row.origin_chain, row.deposit_tx_hashes),
      destinationChainTxHashes: txDetails(row.destination_chain, row.destination_tx_hashes),
    },
  };
}

/** `GET /v0/status`: materializes due steps first, so a poll always sees the current timeline state. */
export async function getStatus(
  sb: Sandbox,
  address: string,
  memo?: string | undefined,
): Promise<OneClickStatusResponse> {
  return withTx(sb.db, async (tx) => {
    const row = await lockQuote(tx, depositKey(address, memo));
    if (!row) throw notFound(address);
    return statusOf(await materialize(sb, tx, row, await dbNow(tx)));
  });
}
