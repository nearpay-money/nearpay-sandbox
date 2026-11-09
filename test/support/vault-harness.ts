/** In-memory vault stand-in for unit and property tests (no database): the pure domain end to end. */

import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { VaultContract } from "../../src/domain/vault/contract.js";
import type { FaultInjector } from "../../src/domain/vault/runtime.js";
import { executeVaultTx, type VaultTxResult } from "../../src/domain/vault/standin.js";
import { MemoryVault, type VaultConfig, VaultState } from "../../src/domain/vault/state.js";

export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDT = "usdt.tether-token.near";
export const VAULT = "vault.sandbox.near";
export const TREASURY = "treasury.sandbox.near";
export const INTENTS = "intents.near";
export const TGAS = 1_000_000_000_000n;
export const REG = 2_000_000_000_000_000_000_000n;
export const MCOST = 10_000_000_000_000_000_000_000n;
export const T0 = 1_794_268_800_000_000_000n;

export function config(over: Partial<VaultConfig> = {}): VaultConfig {
  return {
    account: VAULT,
    allowedTokens: [USDC, USDT],
    feeReceiver: TREASURY,
    maxFeeBps: 500,
    intentsAccount: INTENTS,
    caps: [
      { token: USDC, cap: 10n ** 15n, mandateCap: 10n ** 12n },
      { token: USDT, cap: 10n ** 15n, mandateCap: 10n ** 12n },
    ],
    ...over,
  };
}

const enc = new TextEncoder();

export class Harness {
  readonly mem = new MemoryVault();
  readonly vault: VaultContract;
  now = T0;
  private n = 0;
  constructor(
    cfg: VaultConfig = config(),
    public faults?: FaultInjector,
  ) {
    this.vault = new VaultContract(cfg);
  }

  async exec(e: {
    receiver: string;
    method: string;
    args: unknown;
    signer: string;
    deposit?: bigint;
    gas?: bigint;
    mint?: { token: string; account: string; amount: bigint };
  }): Promise<VaultTxResult> {
    const s = new VaultState(this.mem);
    const hash = bs58.encode(sha256(enc.encode(`tx:${this.n++}`)));
    const r = await executeVaultTx({
      vault: this.vault,
      state: s,
      blockTimestampNs: this.now,
      blockHash: bs58.encode(sha256(enc.encode(`block:${this.n}`))),
      tx: {
        hash,
        signer: e.signer,
        publicKey: "ed25519:11111111111111111111111111111111",
        nonce: BigInt(this.n),
        receiver: e.receiver,
        signature: "ed25519:1111111111111111111111111111111111111111111111111111111111111111",
        priorityFee: 0n,
      },
      entry: {
        receiver: e.receiver,
        method: e.method,
        args: typeof e.args === "string" ? enc.encode(e.args) : enc.encode(JSON.stringify(e.args)),
        signer: e.signer,
        deposit: e.deposit ?? 0n,
        gas: e.gas ?? 100n * TGAS,
        ...(e.mint ? { mint: e.mint } : {}),
      },
      ...(this.faults ? { faults: this.faults } : {}),
    });
    this.mem.apply(s);
    return r;
  }

  call(signer: string, method: string, args: unknown, o: { deposit?: bigint; gas?: bigint } = {}) {
    const exit = ["cancel", "withdraw", "storage_withdraw", "storage_unregister"].includes(method);
    return this.exec({
      receiver: this.vault.account,
      method,
      args,
      signer,
      deposit: o.deposit ?? (exit ? 1n : 0n),
      gas: o.gas ?? (method === "collect" ? 250n * TGAS : 100n * TGAS),
    });
  }

  register(account: string, amount = REG + MCOST) {
    return this.call(account, "storage_deposit", {}, { deposit: amount });
  }

  /** The payer's `ft_transfer_call` with the faucet minting any shortfall. */
  async fund(payer: string, token: string, amount: bigint, msg: string | object) {
    const have = await this.mem.ft(token, payer);
    return this.exec({
      receiver: token,
      method: "ft_transfer_call",
      args: {
        receiver_id: this.vault.account,
        amount: amount.toString(),
        memo: null,
        msg: typeof msg === "string" ? msg : JSON.stringify(msg),
      },
      signer: payer,
      deposit: 1n,
      gas: 100n * TGAS,
      ...(have < amount ? { mint: { token, account: payer, amount: amount - have } } : {}),
    });
  }

  async view(method: string, args: unknown = {}): Promise<string> {
    return this.vault.view(new VaultState(this.mem), method, enc.encode(JSON.stringify(args)));
  }

  async mandate(id: number) {
    return JSON.parse(await this.view("get_mandate", { mandate_id: id }));
  }
}

export function createMsg(over: Record<string, unknown> = {}) {
  return {
    create_mandate: {
      merchant_receiver: "merchant-demo.near",
      receiver_kind: "intents_account",
      amount_per_period: "10000000",
      period_secs: 2_629_746,
      start_at: null,
      max_periods: null,
      fee_bps: 100,
      ext_ref: "sub_01jbz9k3m4n5p6q7r8s9t0v1w2",
      ...over,
    },
  };
}

/** The vault lines of a result (in order). */
export const vaultLogs = (r: VaultTxResult) => r.feed.filter((f) => f.executor_id === VAULT).map((f) => f.log);
export const statusValue = (r: VaultTxResult) =>
  "SuccessValue" in r.status ? Buffer.from(r.status.SuccessValue, "base64").toString() : null;
export const failure = (r: VaultTxResult) =>
  "Failure" in r.status ? Object.values(r.status.Failure.ActionError.kind.FunctionCallError)[0] : null;

/** Faults set per call by a test (vector reproduction): `next` applies to the following legs, then resets. */
export class ScriptedFaults implements FaultInjector {
  merchant: "fail" | "partial" | null = null;
  fee = false;
  refund = false;
  async legFailure(tag: { leg: string }) {
    if (tag.leg === "merchant" && this.merchant === "fail") return "scripted merchant failure";
    if (tag.leg === "fee" && this.fee) return "scripted fee failure";
    if (tag.leg === "refund" && this.refund) return "scripted refund failure";
    return null;
  }
  async intentsDelivered(tag: { leg: string }, amount: bigint) {
    return tag.leg === "merchant" && this.merchant === "partial" ? amount / 2n : amount;
  }
  reset() {
    this.merchant = null;
    this.fee = false;
    this.refund = false;
  }
}
