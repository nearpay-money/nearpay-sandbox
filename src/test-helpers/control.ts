/**
 * Test-control endpoints (sandbox LLD §3): the payer's simulated deposit (`POST /sim/deposits`, behind
 * checkout's "Simulate payment") and manual stepping (`POST /sim/advance`, behind payments'
 * `/v1/test_helpers/payment_attempts/{attempt}/advance`).
 */
import { withTx } from "@nearpay-internal/db";
import { ApiError } from "@nearpay-internal/service";
import { dbNow, depositKey, type Sandbox } from "../app/context.js";
import {
  applyStep,
  conflict,
  lockQuote,
  materialize,
  notFound,
  originFamilyTx,
  payDuplicateSiblings,
  recordDeposit,
} from "../app/executions.js";
import { scenarioDeposit } from "../domain/quote-math.js";
import {
  type AdvanceTarget,
  isTerminal,
  type ProviderStatus,
  planAdvance,
  type Scenario,
} from "../scenarios/scenario.js";

/** `POST /sim/deposits`: the payer's simulated deposit (default: the scenario's deposit amount). */
export async function simulateDeposit(
  sb: Sandbox,
  b: { deposit_address: string; memo?: string | undefined; amount_in?: string | undefined },
): Promise<void> {
  await withTx(sb.db, async (tx) => {
    const row = await lockQuote(tx, depositKey(b.deposit_address, b.memo));
    if (!row) throw notFound(b.deposit_address);
    if (isTerminal(row.state)) throw conflict(row.state);
    if (row.deposited_amount !== null) throw conflict(row.state, "a deposit was already made");
    const now = await dbNow(tx);
    const amount =
      b.amount_in !== undefined
        ? BigInt(b.amount_in)
        : scenarioDeposit(row.scenario, { amountIn: BigInt(row.amount_in), minAmountIn: BigInt(row.min_amount_in) });
    if (amount <= 0n) throw ApiError.invalid("amount_in must be positive", "amount_in");
    const updated = await recordDeposit(
      sb,
      tx,
      row,
      { amount, txHash: originFamilyTx(row, `deposit:${row.deposit_key}`) },
      now,
    );
    await payDuplicateSiblings(sb, tx, updated, now);
  });
}

/** `POST /sim/advance`: moves a quote to a step and stops its timeline (manual mode). */
export async function advance(
  sb: Sandbox,
  b: { deposit_address: string; memo?: string | undefined; to: AdvanceTarget },
): Promise<void> {
  await withTx(sb.db, async (tx) => {
    let row = await lockQuote(tx, depositKey(b.deposit_address, b.memo));
    if (!row) throw notFound(b.deposit_address);
    const now = await dbNow(tx);
    // Catch up first: a step that is already due happened before this request.
    row = await materialize(sb, tx, row, now);
    const plan = planAdvance(
      {
        current: row.state as ProviderStatus,
        scenario: row.scenario as Scenario,
        deposited: row.deposited_amount === null ? null : BigInt(row.deposited_amount),
        amountIn: BigInt(row.amount_in),
        amountOut: BigInt(row.amount_out),
      },
      b.to,
    );
    if (!plan.ok) throw conflict(row.state, plan.reason);
    row = await tx
      .updateTable("sim_quotes")
      .set({ manual: true, next_at: null })
      .where("deposit_key", "=", row.deposit_key)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (plan.deposit)
      row = await recordDeposit(
        sb,
        tx,
        row,
        { amount: BigInt(row.amount_in), txHash: originFamilyTx(row, `deposit:${row.deposit_key}`) },
        now,
      );
    if (plan.step.status !== "KNOWN_DEPOSIT_TX" || row.state !== "KNOWN_DEPOSIT_TX")
      await applyStep(sb, tx, row, plan.step, now);
  });
}
