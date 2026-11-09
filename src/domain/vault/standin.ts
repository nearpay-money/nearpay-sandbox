/**
 * The vault stand-in's transaction execution (sandbox LLD §3.1, §4.2): runs one function call through the receipt
 * runtime with the §4.2 scenario faults and renders the NEAR RPC `FinalExecutionOutcome` plus the indexer-feed
 * lines (`GET /sim/intents/events` receipt context). Pure: the app layer supplies the state, the block and the
 * transaction metadata, and persists the result.
 */
import { vaultSandboxPartialShare, vaultSandboxScenarioOf } from "@nearpay-internal/spec";
import type { VaultContract } from "./contract.js";
import {
  type EntryCall,
  type ExecutionStatus,
  type FaultInjector,
  type ReceiptOutcome,
  Runtime,
  tokensBurnt,
} from "./runtime.js";
import type { VaultState } from "./state.js";

/** Messages of the injected failures (the token receipt panics with them; consumers see a failed promise). */
export const SCENARIO_FAILURES = {
  merchant: "sandbox scenario 91: the merchant leg fails",
  fee: "sandbox scenario 92: the fee leg fails",
  refund: "sandbox scenario 93: the first refund fails",
} as const;

/**
 * Scenario faults by the last two digits of the mandate's `amount_per_period` (spec `vaultSandboxScenarioOf`):
 * `91` every merchant leg fails, `92` every fee leg fails, `93` the mandate's first refund fails, `94` a merchant leg
 * into `intents.near` delivers `floor(share / 2)` (spec `vaultSandboxPartialShare`). A `near_account` merchant leg is a
 * plain `ft_transfer`, which cannot deliver part of the share, and the contract counts its success as the full
 * share — so `94` behaves like `00` for `near_account` mandates, as it would on chain.
 */
export const vaultFaults: FaultInjector = {
  async legFailure(tag, s) {
    const r = await s.mandate(tag.mandateId);
    if (!r) return null;
    const scenario = vaultSandboxScenarioOf(r.m.amount_per_period.toString());
    if (tag.leg === "merchant" && scenario === "merchant_leg_fails") return SCENARIO_FAILURES.merchant;
    if (tag.leg === "fee" && scenario === "fee_leg_fails") return SCENARIO_FAILURES.fee;
    if (tag.leg === "refund" && scenario === "first_refund_fails" && r.refundsFailed === 0) {
      s.setMandate(tag.mandateId, { ...r, refundsFailed: r.refundsFailed + 1 });
      return SCENARIO_FAILURES.refund;
    }
    return null;
  },
  async intentsDelivered(tag, amount, s) {
    if (tag.leg !== "merchant") return amount;
    const r = await s.mandate(tag.mandateId);
    if (!r || vaultSandboxScenarioOf(r.m.amount_per_period.toString()) !== "partial_delivery") return amount;
    return vaultSandboxPartialShare(amount);
  },
};

export interface TxMeta {
  readonly hash: string;
  readonly signer: string;
  readonly publicKey: string;
  readonly nonce: bigint;
  readonly receiver: string;
  readonly signature: string;
  readonly priorityFee: bigint;
}

export interface FeedLine {
  readonly receipt_id: string;
  readonly log_index: number;
  readonly executor_id: string;
  readonly log: string;
}

export interface VaultTxResult {
  readonly outcome: Record<string, unknown>;
  readonly status: ExecutionStatus;
  readonly receipts: readonly ReceiptOutcome[];
  readonly feed: readonly FeedLine[];
}

export async function executeVaultTx(i: {
  vault: VaultContract;
  state: VaultState;
  blockTimestampNs: bigint;
  blockHash: string;
  tx: TxMeta;
  entry: EntryCall;
  faults?: FaultInjector;
}): Promise<VaultTxResult> {
  const rt = new Runtime({
    vault: i.vault,
    state: i.state,
    blockTimestampNs: i.blockTimestampNs,
    txHash: i.tx.hash,
    faults: i.faults ?? vaultFaults,
  });
  const run = await rt.run(i.entry);
  const receiptsOutcome = run.receipts.map((r) => ({
    id: r.id,
    block_hash: i.blockHash,
    outcome: {
      logs: [...r.logs],
      receipt_ids: [...r.receiptIds],
      gas_burnt: Number(r.gasBurnt),
      tokens_burnt: tokensBurnt(r.gasBurnt),
      executor_id: r.executor,
      status: r.status,
    },
    proof: [],
  }));
  const outcome = {
    final_execution_status: "FINAL",
    status: run.status,
    transaction: {
      signer_id: i.tx.signer,
      public_key: i.tx.publicKey,
      nonce: Number(i.tx.nonce),
      receiver_id: i.tx.receiver,
      actions: [
        {
          FunctionCall: {
            method_name: i.entry.method,
            args: Buffer.from(i.entry.args).toString("base64"),
            gas: Number(i.entry.gas),
            deposit: i.entry.deposit.toString(),
          },
        },
      ],
      priority_fee: Number(i.tx.priorityFee),
      signature: i.tx.signature,
      hash: i.tx.hash,
    },
    transaction_outcome: {
      id: i.tx.hash,
      block_hash: i.blockHash,
      outcome: {
        logs: [],
        receipt_ids: [run.firstReceiptId],
        gas_burnt: Number(run.txGasBurnt),
        tokens_burnt: tokensBurnt(run.txGasBurnt),
        executor_id: i.tx.signer,
        status: { SuccessReceiptId: run.firstReceiptId },
      },
      proof: [],
    },
    receipts_outcome: receiptsOutcome,
  };
  // Failed receipts carry no logs, so every feed line comes from a successful receipt (rails §8.6).
  const feed = run.receipts.flatMap((r) =>
    r.logs.map((log, log_index) => ({ receipt_id: r.id, log_index, executor_id: r.executor, log })),
  );
  return { outcome, status: run.status, receipts: run.receipts, feed };
}
