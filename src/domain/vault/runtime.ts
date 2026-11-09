/**
 * Synchronous receipt runtime of the vault stand-in (sandbox LLD §3.1): executes a function call and every receipt
 * it spawns in NEAR's order — a receipt, then the call its promise chain makes and the call's own receipts, then each
 * callback with the previous result — and records each receipt outcome in mainnet shape. A panicking receipt fails
 * alone (its state changes revert; earlier receipts stay applied), exactly as on chain, so callbacks see the
 * failure as a failed promise result.
 *
 * Besides the vault (`./contract.ts`) the runtime simulates the accounts the vault calls: NEP-141 test tokens
 * (`ft_transfer`, `ft_transfer_call`, `ft_resolve_transfer` with near-contract-standards semantics and `ft_transfer`
 * event logs) and `intents.near`'s `ft_on_transfer` (credits the merchant's Intents balance, NEP-245 `mt_mint`).
 * Scenario faults (sandbox §4.2) are injected at the token legs through {@link FaultInjector}. Pure: no I/O.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { accountId, isValidAccountId } from "./account-id.js";
import {
  type Call,
  type CallResult,
  ContractPanic,
  DESERIALIZE_MESSAGE,
  type LegTag,
  MethodNotFound,
  ONE_YOCTO_MESSAGE,
  type PromiseResult,
  type ReceiptEnv,
  TGAS,
  type VaultContract,
} from "./contract.js";
import { minBig } from "./math.js";
import { field, option, parseJson, SerdeError, string, struct, U128_MAX, uintString } from "./serde-json.js";
import type { VaultState } from "./state.js";

const enc = new TextEncoder();

/** Gas price used for `tokens_burnt` (yoctoNEAR per gas; mainnet's minimum, 100 Mgas⁻¹). */
const GAS_PRICE = 100_000_000n;
/** Gas a simulated receipt burns (gas accounting beyond the floors is not modelled, sandbox §3.1). */
const RECEIPT_GAS = 2_500_000_000_000n;
const TX_GAS = 2_428_000_000_000n;
/** near-contract-standards: `ft_transfer_call` needs more than this prepaid gas; the receiver gets the rest. */
const GAS_FOR_FT_TRANSFER_CALL = 30n * TGAS;
const GAS_FOR_RESOLVE_TRANSFER = 5n * TGAS;

export type ExecutionStatus =
  | { SuccessValue: string }
  | { SuccessReceiptId: string }
  | { Failure: { ActionError: { index: number; kind: { FunctionCallError: Record<string, string> } } } };

export interface ReceiptOutcome {
  readonly id: string;
  readonly executor: string;
  readonly predecessor: string;
  readonly method: string;
  readonly logs: readonly string[];
  readonly receiptIds: readonly string[];
  readonly status: ExecutionStatus;
  readonly gasBurnt: bigint;
}

/** Decides scenario faults at the token legs (sandbox §4.2). Called outside the receipt's frame. */
export interface FaultInjector {
  /** A failure message for this leg's first token receipt, or null. */
  legFailure(tag: LegTag, s: VaultState): Promise<string | null>;
  /** How much of a merchant leg into `intents.near` is delivered (default: all). */
  intentsDelivered(tag: LegTag, amount: bigint, s: VaultState): Promise<bigint>;
}

export const NO_FAULTS: FaultInjector = {
  async legFailure() {
    return null;
  },
  async intentsDelivered(_tag, amount) {
    return amount;
  },
};

export interface RuntimeOptions {
  readonly vault: VaultContract;
  readonly state: VaultState;
  readonly blockTimestampNs: bigint;
  /** Transaction hash (receipt ids derive from it). */
  readonly txHash: string;
  readonly faults: FaultInjector;
}

export interface EntryCall {
  readonly receiver: string;
  readonly method: string;
  readonly args: Uint8Array;
  readonly signer: string;
  readonly deposit: bigint;
  readonly gas: bigint;
  /** Faucet: credit `account` with `amount` of the token in the first receipt, before it runs (logged `ft_mint`). */
  readonly mint?: { readonly token: string; readonly account: string; readonly amount: bigint };
}

export interface RunResult {
  readonly receipts: readonly ReceiptOutcome[];
  readonly firstReceiptId: string;
  /** The transaction's final status (the last receipt of its call chain). */
  readonly status: ExecutionStatus;
  readonly txGasBurnt: bigint;
}

export function eventLine(standard: string, version: string, event: string, data: unknown): string {
  return `EVENT_JSON:${JSON.stringify({ standard, version, event, data })}`;
}

function ftTransferLog(from: string, to: string, amount: bigint, memo: string | null): string {
  return eventLine("nep141", "1.0.0", "ft_transfer", [
    { old_owner_id: from, new_owner_id: to, amount: amount.toString(), ...(memo !== null ? { memo } : {}) },
  ]);
}

export function panicStatus(message: string): ExecutionStatus {
  return {
    Failure: {
      ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } } },
    },
  };
}

const panic = (m: string): never => {
  throw new ContractPanic(m);
};

function decodeArgs<T>(bytes: Uint8Array, d: (v: ReturnType<typeof parseJson>) => T): T {
  try {
    return d(parseJson(bytes));
  } catch (e) {
    if (e instanceof SerdeError) return panic(DESERIALIZE_MESSAGE);
    throw e;
  }
}

const ftTransferArgs = struct(
  [
    field("receiver_id", accountId),
    field("amount", uintString(U128_MAX)),
    field("memo", option(string), { optional: true }),
  ] as const,
  { denyUnknown: false },
);
const ftTransferCallArgs = struct(
  [
    field("receiver_id", accountId),
    field("amount", uintString(U128_MAX)),
    field("memo", option(string), { optional: true }),
    field("msg", string),
  ] as const,
  { denyUnknown: false },
);
const resolveArgs = struct(
  [field("sender_id", accountId), field("receiver_id", accountId), field("amount", uintString(U128_MAX))] as const,
  { denyUnknown: false },
);
const onTransferArgs = struct(
  [field("sender_id", accountId), field("amount", uintString(U128_MAX)), field("msg", string)] as const,
  { denyUnknown: false },
);

interface Pending {
  readonly id: string;
  readonly call: Call;
  readonly predecessor: string;
  readonly promiseResults: readonly PromiseResult[];
  readonly tag: LegTag | undefined;
  readonly mint?: EntryCall["mint"];
}

export class Runtime {
  private readonly receipts: ReceiptOutcome[] = [];
  private counter = 0;

  constructor(private readonly o: RuntimeOptions) {}

  private nextReceiptId(): string {
    return bs58.encode(sha256(enc.encode(`${this.o.txHash}:receipt:${this.counter++}`)));
  }

  async run(entry: EntryCall): Promise<RunResult> {
    const first = this.nextReceiptId();
    await this.exec(
      {
        id: first,
        call: {
          receiver: entry.receiver,
          method: entry.method,
          args: "", // the raw bytes below are what the receipt reads (they may not even be UTF-8)
          deposit: entry.deposit,
          gas: entry.gas,
        },
        predecessor: entry.signer,
        promiseResults: [],
        tag: undefined,
        ...(entry.mint ? { mint: entry.mint } : {}),
      },
      entry.signer,
      entry.args,
    );
    return { receipts: this.receipts, firstReceiptId: first, status: this.finalStatus(first), txGasBurnt: TX_GAS };
  }

  /** Follows `SuccessReceiptId` links from the first receipt to the chain's last outcome. */
  private finalStatus(first: string): ExecutionStatus {
    let id = first;
    for (let i = 0; i < 64; i++) {
      const r = this.receipts.find((x) => x.id === id);
      if (!r) break;
      if ("SuccessReceiptId" in r.status) id = r.status.SuccessReceiptId;
      else return r.status;
    }
    throw new Error("unresolved receipt chain");
  }

  private async exec(p: Pending, signer: string, rawArgs?: Uint8Array): Promise<PromiseResult> {
    const { state } = this.o;
    const call = p.call;
    const args = rawArgs ?? enc.encode(call.args);
    // Scenario faults are decided outside the receipt (their bookkeeping survives the failed receipt).
    let injected: string | null = null;
    if (
      p.tag &&
      (call.method === "ft_transfer" || call.method === "ft_transfer_call") &&
      p.predecessor === this.o.vault.account
    )
      injected = await this.o.faults.legFailure(p.tag, state);
    const logs: string[] = [];
    const env: ReceiptEnv = {
      predecessor: p.predecessor,
      signer,
      deposit: call.deposit,
      gas: call.gas,
      blockTimestampNs: this.o.blockTimestampNs,
      promiseResults: p.promiseResults,
      logs,
    };
    state.begin();
    let result: CallResult;
    try {
      if (injected !== null) panic(injected);
      if (p.mint) {
        const bal = await state.ft(p.mint.token, p.mint.account);
        state.setFt(p.mint.token, p.mint.account, bal + p.mint.amount);
        logs.push(
          eventLine("nep141", "1.0.0", "ft_mint", [
            { owner_id: p.mint.account, amount: p.mint.amount.toString(), memo: "sandbox faucet" },
          ]),
        );
      }
      result = await this.dispatch(call, env, args, p.tag);
    } catch (e) {
      if (!(e instanceof ContractPanic) && !(e instanceof MethodNotFound)) throw e;
      state.rollback();
      this.receipts.push({
        id: p.id,
        executor: call.receiver,
        predecessor: p.predecessor,
        method: call.method,
        logs: [],
        receiptIds: [],
        status:
          e instanceof ContractPanic
            ? panicStatus(e.message)
            : {
                Failure: {
                  ActionError: { index: 0, kind: { FunctionCallError: { MethodResolveError: "MethodNotFound" } } },
                },
              },
        gasBurnt: RECEIPT_GAS,
      });
      return { ok: false };
    }
    state.commit();
    if (result.kind === "value") {
      this.receipts.push({
        id: p.id,
        executor: call.receiver,
        predecessor: p.predecessor,
        method: call.method,
        logs,
        receiptIds: [],
        status: { SuccessValue: Buffer.from(result.bytes).toString("base64") },
        gasBurnt: RECEIPT_GAS,
      });
      return { ok: true, bytes: result.bytes };
    }
    const chain = result.chain;
    const ids = [this.nextReceiptId(), ...chain.callbacks.map(() => this.nextReceiptId())];
    this.receipts.push({
      id: p.id,
      executor: call.receiver,
      predecessor: p.predecessor,
      method: call.method,
      logs,
      receiptIds: ids,
      status: { SuccessReceiptId: ids[ids.length - 1] as string },
      gasBurnt: RECEIPT_GAS,
    });
    let r = await this.exec(
      {
        id: ids[0] as string,
        call: chain.first,
        predecessor: call.receiver,
        promiseResults: [],
        tag: chain.first.tag ?? p.tag,
      },
      signer,
    );
    for (const [i, cb] of chain.callbacks.entries()) {
      r = await this.exec(
        { id: ids[i + 1] as string, call: cb, predecessor: call.receiver, promiseResults: [r], tag: cb.tag ?? p.tag },
        signer,
      );
    }
    return r;
  }

  private async dispatch(call: Call, env: ReceiptEnv, args: Uint8Array, tag: LegTag | undefined): Promise<CallResult> {
    const { vault, state } = this.o;
    if (call.receiver === vault.account) return vault.call(state, env, call.method, args);
    if (call.receiver === vault.config.intentsAccount) return this.intents(call, env, args, tag);
    return this.token(call.receiver, call.method, env, args);
  }

  /** `intents.near` `ft_on_transfer`: the deposit credits `msg`'s Intents balance (`mt_mint`, memo `deposit`). */
  private async intents(call: Call, env: ReceiptEnv, args: Uint8Array, tag: LegTag | undefined): Promise<CallResult> {
    if (call.method !== "ft_on_transfer") throw new MethodNotFound(call.method);
    const [, amount, msg] = decodeArgs(args, onTransferArgs);
    if (!isValidAccountId(msg)) panic("invalid receiver_id in msg");
    const delivered = tag ? await this.o.faults.intentsDelivered(tag, amount, this.o.state) : amount;
    const tokenId = `nep141:${env.predecessor}`;
    if (delivered > 0n) {
      this.o.state.creditIntents({ account: msg, tokenId, amount: delivered });
      env.logs.push(
        eventLine("nep245", "1.0.0", "mt_mint", [
          { owner_id: msg, token_ids: [tokenId], amounts: [delivered.toString()], memo: "deposit" },
        ]),
      );
    }
    return { kind: "value", bytes: enc.encode(`"${(amount - delivered).toString()}"`) };
  }

  private async move(token: string, from: string, to: string, amount: bigint): Promise<void> {
    const s = this.o.state;
    if (from === to) panic("Sender and receiver should be different");
    if (amount === 0n) panic("The amount should be a positive number");
    const fb = await s.ft(token, from);
    if (fb < amount) panic("The account doesn't have enough balance");
    s.setFt(token, from, fb - amount);
    const tb = await s.ft(token, to);
    if (tb + amount > U128_MAX) panic("Balance overflow");
    s.setFt(token, to, tb + amount);
  }

  /** A NEP-141 test token (near-contract-standards `FungibleToken` behaviour; every account is registered). */
  private async token(token: string, method: string, env: ReceiptEnv, args: Uint8Array): Promise<CallResult> {
    switch (method) {
      case "ft_transfer": {
        if (env.deposit !== 1n) panic(ONE_YOCTO_MESSAGE);
        const [receiver, amount, memo] = decodeArgs(args, ftTransferArgs);
        await this.move(token, env.predecessor, receiver, amount);
        env.logs.push(ftTransferLog(env.predecessor, receiver, amount, memo));
        return { kind: "value", bytes: new Uint8Array() };
      }
      case "ft_transfer_call": {
        if (env.deposit !== 1n) panic(ONE_YOCTO_MESSAGE);
        const [receiver, amount, memo, msg] = decodeArgs(args, ftTransferCallArgs);
        if (env.gas <= GAS_FOR_FT_TRANSFER_CALL) panic("More gas is required");
        const sender = env.predecessor;
        await this.move(token, sender, receiver, amount);
        env.logs.push(ftTransferLog(sender, receiver, amount, memo));
        return {
          kind: "promise",
          chain: {
            first: {
              receiver,
              method: "ft_on_transfer",
              args: JSON.stringify({ sender_id: sender, amount: amount.toString(), msg }),
              deposit: 0n,
              gas: env.gas - GAS_FOR_FT_TRANSFER_CALL,
            },
            callbacks: [
              {
                receiver: token,
                method: "ft_resolve_transfer",
                args: JSON.stringify({ sender_id: sender, receiver_id: receiver, amount: amount.toString() }),
                deposit: 0n,
                gas: GAS_FOR_RESOLVE_TRANSFER,
              },
            ],
          },
        };
      }
      case "ft_resolve_transfer": {
        if (env.predecessor !== token) panic("Method ft_resolve_transfer is private");
        const [sender, receiver, amount] = decodeArgs(args, resolveArgs);
        const r = env.promiseResults[0];
        let unused = amount;
        if (r?.ok) {
          try {
            const u = uintString(U128_MAX)(parseJson(r.bytes));
            unused = minBig(u, amount);
          } catch {
            unused = amount;
          }
        }
        let used = amount;
        if (unused > 0n) {
          const rb = await this.o.state.ft(token, receiver);
          if (rb > 0n) {
            const refund = minBig(unused, rb);
            await this.move(token, receiver, sender, refund);
            env.logs.push(ftTransferLog(receiver, sender, refund, "refund"));
            used = amount - refund;
          }
        }
        return { kind: "value", bytes: enc.encode(`"${used.toString()}"`) };
      }
      default:
        throw new MethodNotFound(method);
    }
  }
}

/** `tokens_burnt` of an outcome. */
export function tokensBurnt(gas: bigint): string {
  return (gas * GAS_PRICE).toString();
}
