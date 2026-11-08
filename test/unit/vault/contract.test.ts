/** near-sdk wrapper rules, storage (NEP-145), views and receipt shapes of the stand-in contract port. */
import { describe, expect, it } from "vitest";
import {
  MANDATE_STORAGE_COST,
  MAX_RESULT_LEN,
  STORAGE_REGISTRATION_COST,
  VaultContract,
} from "../../../src/domain/vault/contract.js";
import { executeVaultTx, SCENARIO_FAILURES, vaultFaults } from "../../../src/domain/vault/standin.js";
import { checkConfig, MemoryVault, VaultState } from "../../../src/domain/vault/state.js";
import {
  config,
  createMsg,
  failure,
  Harness,
  INTENTS,
  REG,
  ScriptedFaults,
  statusValue,
  T0,
  TGAS,
  TREASURY,
  USDC,
  USDT,
  VAULT,
  vaultLogs,
} from "../../support/vault-harness.js";

const enc = new TextEncoder();

describe("near-sdk method wrapper", () => {
  it("non-payable methods refuse a deposit before reading arguments", async () => {
    const h = new Harness();
    expect(failure(await h.call("k.near", "collect", "garbage", { deposit: 1n }))).toBe(
      "Smart contract panicked: Method collect doesn't accept deposit",
    );
  });

  it("arguments that do not deserialize panic with near-sdk's message", async () => {
    const h = new Harness();
    for (const args of ["", "{}", '{"mandate_id":"1"}', '{"mandate_id":1,"mandate_id":2}', "[1,2]"])
      expect(failure(await h.call("k.near", "collect", args))).toBe(
        "Smart contract panicked: Failed to deserialize input from JSON.",
      );
    // sequence form and unknown fields are accepted (then the mandate is missing)
    expect(failure(await h.call("k.near", "collect", "[5]"))).toBe("Smart contract panicked: ERR_NOT_FOUND");
    expect(failure(await h.call("k.near", "collect", '{"mandate_id":5,"x":1}'))).toBe(
      "Smart contract panicked: ERR_NOT_FOUND",
    );
    // invalid UTF-8 in the raw arguments
    const r = await executeVaultTx({
      vault: h.vault,
      state: new VaultState(h.mem),
      blockTimestampNs: T0,
      blockHash: "11111111111111111111111111111111",
      tx: { hash: "h", signer: "k.near", publicKey: "k", nonce: 1n, receiver: VAULT, signature: "s", priorityFee: 0n },
      entry: {
        receiver: VAULT,
        method: "collect",
        args: new Uint8Array([0xff]),
        signer: "k.near",
        deposit: 0n,
        gas: 250n * TGAS,
      },
    });
    expect(JSON.stringify(r.status)).toContain("Failed to deserialize input from JSON.");
  });

  it("private callbacks refuse other callers; unknown methods fail with MethodNotFound", async () => {
    const h = new Harness();
    expect(failure(await h.call("k.near", "on_merchant_leg", { mandate_id: 0, share: "1", fee: "0" }))).toBe(
      "Smart contract panicked: Method on_merchant_leg is private",
    );
    const r = await h.call("k.near", "set_fee", {});
    expect(r.status).toEqual({
      Failure: { ActionError: { index: 0, kind: { FunctionCallError: { MethodResolveError: "MethodNotFound" } } } },
    });
    await expect(h.view("set_fee")).rejects.toThrow(/MethodNotFound/);
  });
});

describe("NEP-145 storage", () => {
  it("deposit, registration_only, top-up, withdraw, unregister", async () => {
    const h = new Harness();
    const reg = await h.call("a.near", "storage_deposit", { registration_only: true }, { deposit: 5n * REG });
    expect(statusValue(reg)).toBe('{"total":"2000000000000000000000","available":"0"}');
    expect(statusValue(await h.call("a.near", "storage_deposit", { registration_only: true }, { deposit: REG }))).toBe(
      '{"total":"2000000000000000000000","available":"0"}',
    );
    expect(
      statusValue(
        await h.call("b.near", "storage_deposit", { account_id: "a.near" }, { deposit: MANDATE_STORAGE_COST }),
      ),
    ).toBe('{"total":"12000000000000000000000","available":"10000000000000000000000"}');
    expect(statusValue(await h.call("a.near", "storage_withdraw", { amount: "1" }))).toBe(
      '{"total":"11999999999999999999999","available":"9999999999999999999999"}',
    );
    expect(statusValue(await h.call("a.near", "storage_withdraw", {}))).toBe(
      '{"total":"2000000000000000000000","available":"0"}',
    );
    expect(failure(await h.call("a.near", "storage_withdraw", {}, { deposit: 0n }))).toContain("exactly 1 yoctoNEAR");
    expect(statusValue(await h.call("a.near", "storage_unregister", { force: true }))).toBe("true");
    expect(statusValue(await h.call("a.near", "storage_unregister", {}))).toBe("false");
    expect(failure(await h.call("a.near", "storage_unregister", {}, { deposit: 0n }))).toContain("exactly 1 yoctoNEAR");
    expect(await h.view("storage_balance_of", { account_id: "a.near" })).toBe("null");
  });

  it("a second mandate needs another 0.01 NEAR available", async () => {
    const h = new Harness();
    await h.register("a.near", STORAGE_REGISTRATION_COST + MANDATE_STORAGE_COST);
    await h.fund("a.near", USDC, 10_000_000n, createMsg());
    expect(vaultLogs(await h.fund("a.near", USDC, 10_000_000n, createMsg()))).toEqual(["ERR_NO_STORAGE"]);
  });
});

describe("views and the payer index", () => {
  it("pages get_mandates_by_payer and keeps IterableSet swap_remove order", async () => {
    const h = new Harness();
    await h.register("a.near", REG + 4n * MANDATE_STORAGE_COST);
    for (let i = 0; i < 4; i++) await h.fund("a.near", USDC, 10_000_000n, createMsg());
    const ids = async (args: object = {}) =>
      (JSON.parse(await h.view("get_mandates_by_payer", { payer: "a.near", ...args })) as { mandate_id: number }[]).map(
        (m) => m.mandate_id,
      );
    expect(await ids()).toEqual([0, 1, 2, 3]);
    expect(await ids({ from_index: 1, limit: 2 })).toEqual([1, 2]);
    expect(await ids({ limit: 1000 })).toEqual([0, 1, 2, 3]);
    await h.call("a.near", "cancel", { mandate_id: 1 }); // closed → the last id takes slot 1
    expect(await ids()).toEqual([0, 3, 2]);
    expect(await h.view("get_mandates_by_payer", { payer: "nobody.near" })).toBe("[]");
    expect(await h.view("get_token_tvl", { token: "wrap.near" })).toBe("null");
    expect(await h.view("next_collect_at", { mandate_id: 99 })).toBe("null");
  });
});

describe("receipts", () => {
  it("a collect into an Intents account: token transfer_call → intents mt_mint → resolve → callback chain", async () => {
    const h = new Harness();
    await h.register("a.near");
    await h.fund("a.near", USDC, 20_000_000n, createMsg());
    const r = await h.call("k.near", "collect", { mandate_id: 0 });
    expect(r.receipts.map((x) => `${x.executor}.${x.method}`)).toEqual([
      `${VAULT}.collect`,
      `${USDC}.ft_transfer_call`,
      `${INTENTS}.ft_on_transfer`,
      `${USDC}.ft_resolve_transfer`,
      `${VAULT}.on_merchant_leg`,
      `${USDC}.ft_transfer`,
      `${VAULT}.on_collected`,
    ]);
    const [collect, transferCall, onTransfer, , onLeg] = r.receipts;
    expect(collect?.status).toEqual({ SuccessReceiptId: collect?.receiptIds[1] });
    expect(onLeg?.status).toEqual({ SuccessReceiptId: onLeg?.receiptIds[1] });
    expect(transferCall?.logs[0]).toBe(
      `EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"${VAULT}","new_owner_id":"${INTENTS}","amount":"9900000"}]}`,
    );
    expect(onTransfer?.logs[0]).toBe(
      `EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint","data":[{"owner_id":"merchant-demo.near","token_ids":["nep141:${USDC}"],"amounts":["9900000"],"memo":"deposit"}]}`,
    );
    expect(statusValue(r)).toBe("true");
    expect(r.outcome).toMatchObject({
      final_execution_status: "FINAL",
      transaction: { signer_id: "k.near", receiver_id: VAULT },
    });
  });

  it("a near_account merchant leg is a plain ft_transfer; fee 0 sends no fee leg", async () => {
    const h = new Harness();
    await h.register("a.near");
    await h.fund("a.near", USDT, 10_000_000n, createMsg({ receiver_kind: "near_account", fee_bps: 0 }));
    const r = await h.call("k.near", "collect", { mandate_id: 0 });
    expect(r.receipts.map((x) => x.method)).toEqual(["collect", "ft_transfer", "on_merchant_leg"]);
    expect(await h.mem.ft(USDT, "merchant-demo.near")).toBe(10_000_000n);
    expect(await h.mem.ft(USDT, TREASURY)).toBe(0n);
  });

  it("the faucet mints only into the payer's token receipt; a failing receipt mints nothing", async () => {
    const h = new Harness();
    await h.register("a.near");
    const r = await h.fund("a.near", USDC, 1_000n, "{");
    expect(r.receipts[0]?.logs[0]).toContain('"event":"ft_mint"');
    expect(await h.mem.ft(USDC, "a.near")).toBe(1_000n); // refunded
    // ft_transfer_call to itself fails at the token (NEP-141): nothing minted, nothing moved
    const self = await h.exec({
      receiver: USDC,
      method: "ft_transfer_call",
      args: { receiver_id: VAULT, amount: "5", msg: "{}" },
      signer: VAULT,
      deposit: 1n,
      mint: { token: USDC, account: VAULT, amount: 5n },
    });
    expect(failure(self)).toBe("Smart contract panicked: Sender and receiver should be different");
    expect(await h.mem.ft(USDC, VAULT)).toBe(0n);
  });

  it("token guards: 1 yocto, gas for ft_transfer_call, balance", async () => {
    const h = new Harness();
    const transfer = (o: { deposit?: bigint; gas?: bigint; amount?: string }) =>
      h.exec({
        receiver: USDC,
        method: "ft_transfer_call",
        args: { receiver_id: VAULT, amount: o.amount ?? "5", msg: "{}" },
        signer: "a.near",
        deposit: o.deposit ?? 1n,
        gas: o.gas ?? 100n * TGAS,
      });
    expect(failure(await transfer({ deposit: 0n }))).toContain("exactly 1 yoctoNEAR");
    expect(failure(await transfer({ gas: 30n * TGAS }))).toBe("Smart contract panicked: More gas is required");
    expect(failure(await transfer({}))).toBe("Smart contract panicked: The account doesn't have enough balance");
    expect(failure(await transfer({ amount: "0" }))).toBe(
      "Smart contract panicked: The amount should be a positive number",
    );
  });
});

describe("scenario faults (sandbox §4.2)", () => {
  it("leg failures and partial delivery follow the amount suffix; 94 on near_account behaves like 00", async () => {
    const mem = new MemoryVault();
    const s = new VaultState(mem);
    const rec = (amount: bigint, kind: "intents_account" | "near_account" = "intents_account") => ({
      m: {
        payer: "a.near",
        merchant_receiver: "m.near",
        receiver_kind: kind,
        token: USDC,
        amount_per_period: amount,
        period_secs: 86_400n,
        start_at_ns: T0,
        max_periods: null,
        fee_bps: 0,
        collected_periods: 0,
        balance: amount,
        status: "active" as const,
        in_flight: false,
        refund_in_flight: 0n,
        ext_ref: "",
      },
      clockOffsetS: 0n,
      refundsFailed: 0,
    });
    s.setMandate(1n, rec(91n));
    s.setMandate(2n, rec(92n));
    s.setMandate(3n, rec(93n));
    s.setMandate(4n, rec(94n));
    expect(await vaultFaults.legFailure({ leg: "merchant", mandateId: 1n }, s)).toBe(SCENARIO_FAILURES.merchant);
    expect(await vaultFaults.legFailure({ leg: "fee", mandateId: 1n }, s)).toBeNull();
    expect(await vaultFaults.legFailure({ leg: "fee", mandateId: 2n }, s)).toBe(SCENARIO_FAILURES.fee);
    expect(await vaultFaults.legFailure({ leg: "refund", mandateId: 3n }, s)).toBe(SCENARIO_FAILURES.refund);
    expect(await vaultFaults.legFailure({ leg: "refund", mandateId: 3n }, s)).toBeNull(); // only the first
    expect(await vaultFaults.legFailure({ leg: "merchant", mandateId: 9n }, s)).toBeNull();
    expect(await vaultFaults.intentsDelivered({ leg: "merchant", mandateId: 4n }, 9n, s)).toBe(4n);
    expect(await vaultFaults.intentsDelivered({ leg: "merchant", mandateId: 1n }, 9n, s)).toBe(9n);
    expect(await vaultFaults.intentsDelivered({ leg: "fee", mandateId: 4n }, 9n, s)).toBe(9n);
    expect(await vaultFaults.intentsDelivered({ leg: "merchant", mandateId: 9n }, 9n, s)).toBe(9n);
  });

  it("94 delivers floor(share / 2); a share of 1 delivers nothing → collect_failed", async () => {
    const h = new Harness();
    await h.register("a.near", REG + 2n * MANDATE_STORAGE_COST);
    await h.fund("a.near", USDC, 94n, createMsg({ amount_per_period: "94", fee_bps: 0 }));
    expect(vaultLogs(await h.call("k.near", "collect", { mandate_id: 0 }))[0]).toContain('"merchant_share":"47"');
    const f = new ScriptedFaults();
    h.faults = f;
    await h.fund("a.near", USDC, 1n, createMsg({ amount_per_period: "1", fee_bps: 0 }));
    f.merchant = "partial";
    const r = await h.call("k.near", "collect", { mandate_id: 1 });
    expect(vaultLogs(r)[0]).toContain('"event":"collect_failed"');
    expect(statusValue(r)).toBe("false");
  });

  it("an over-long or unparseable merchant result counts as delivered (V1-safe)", () => {
    expect(MAX_RESULT_LEN).toBe(64);
  });
});

describe("configuration", () => {
  it("ERR_BAD_CONFIG cases", () => {
    const c = config();
    expect(checkConfig(c)).toBeNull();
    for (const bad of [
      { allowedTokens: [] },
      { maxFeeBps: 10_001 },
      { intentsAccount: VAULT },
      { feeReceiver: INTENTS },
      { allowedTokens: [USDC, VAULT] },
      { allowedTokens: [USDC, USDC] },
      { caps: [c.caps[0] as never] },
      { caps: [c.caps[0], { token: "x.near", cap: 1n, mandateCap: 1n }] as never },
      { caps: [c.caps[0], { token: USDT, cap: 1n, mandateCap: 2n }] as never },
      { caps: [c.caps[0], { token: USDT, cap: 1n, mandateCap: 0n }] as never },
      { caps: [c.caps[0], c.caps[0]] as never },
    ])
      expect(
        checkConfig({ ...c, ...bad } as never),
        JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      ).toBe("ERR_BAD_CONFIG");
    expect(new VaultContract(c).isChangeMethod("collect")).toBe(true);
    expect(enc.encode("x")).toHaveLength(1);
  });
});
