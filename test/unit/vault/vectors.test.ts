/**
 * Contract test of the vault stand-in against the spec's `test-vectors/vault.json` (sandbox LLD §7; the same file
 * the vault's own unit tests assert): the stand-in, driven through its runtime, must produce every event line, error
 * string, rejection line, view result and RPC shape byte for byte.
 * The vectors are read from the published package (`@nearpay-money/spec/test-vectors/vault.json`).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { nearPanicStatus, SANDBOX_VAULT_DEFAULTS, vaultSandboxScenarioOf } from "@nearpay-internal/spec";
import { formatVaultEventLog, type VaultEvent, vaultMsgJson } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { vaultConfigFrom } from "../../../src/app/vault.js";
import {
  MANDATE_STORAGE_COST,
  MIN_COLLECT_GAS,
  MIN_EXIT_GAS,
  STORAGE_REGISTRATION_COST,
  TGAS,
} from "../../../src/domain/vault/contract.js";
import { split } from "../../../src/domain/vault/math.js";
import {
  MAX_EXT_REF_LEN,
  MAX_MAX_PERIODS,
  MAX_MSG_LEN,
  MAX_PERIOD_SECS,
  MAX_START_DELAY_NS,
  MIN_PERIOD_SECS,
  parseMsg,
} from "../../../src/domain/vault/msg.js";
import { checkConfig } from "../../../src/domain/vault/state.js";
import { config, failure, Harness, ScriptedFaults, statusValue, T0, USDC, USDT } from "../../support/vault-harness.js";

const V = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@nearpay-money/spec/test-vectors/vault.json"), "utf8"),
);
const vectorLog = (c: string): string =>
  (V.events as { case: string; log: string }[]).find((e) => e.case === c)?.log as string;
const vectorView = (c: string): string =>
  (V.views as { case: string; result_json: string }[]).find((e) => e.case === c)?.result_json as string;

const VAULT = "v1.vault.nearpay.near";
const ALICE = "alice.near";
const MERCHANT = "merchant-demo.near";
const DAY_NS = 86_400_000_000_000n;
const WEEK_NS = 7n * DAY_NS;
const MONTH_NS = 2_629_746n * 1_000_000_000n;

/** The deployed configuration the vectors were taken with (get_config vector). */
const vectorConfig = () =>
  config({
    account: VAULT,
    feeReceiver: "treasury.nearpay.near",
    caps: [
      { token: USDC, cap: 10n ** 12n, mandateCap: 10n ** 11n },
      { token: USDT, cap: 10n ** 12n, mandateCap: 10n ** 11n },
    ],
  });

const vaultLines = (r: { feed: readonly { executor_id: string; log: string }[] }) =>
  r.feed.filter((f) => f.executor_id === VAULT).map((f) => f.log);

const msg7 = {
  create_mandate: {
    merchant_receiver: MERCHANT,
    receiver_kind: "intents_account",
    amount_per_period: "10000000",
    period_secs: 2_629_746,
    start_at: null,
    max_periods: null,
    fee_bps: 100,
    ext_ref: "sub_01jbz9k3m4n5p6q7r8s9t0v1w2",
  },
};
const msg8 = {
  create_mandate: {
    merchant_receiver: MERCHANT,
    receiver_kind: "near_account",
    amount_per_period: "5000000",
    period_secs: 604_800,
    start_at: T0.toString(),
    max_periods: 12,
    fee_bps: 0,
    ext_ref: "",
  },
};

/** Mandates 7 and 8 of alice at T0 (next_id starts at 7, like the vectors). */
async function setup(storage = STORAGE_REGISTRATION_COST + 2n * MANDATE_STORAGE_COST) {
  const faults = new ScriptedFaults();
  const h = new Harness(vectorConfig(), faults);
  h.mem.next = 7n;
  await h.register(ALICE, storage);
  const c7 = await h.fund(ALICE, USDC, 30_000_000n, msg7);
  return { h, faults, c7 };
}

describe("events (every vector line, produced by the stand-in)", () => {
  it("mandate_created, topped_up, collected, fee leg failed, partial, collect_failed, canceled", async () => {
    const { h, faults, c7 } = await setup();
    expect(vaultLines(c7)).toEqual([vectorLog("mandate_created")]);
    const c8 = await h.fund(ALICE, USDT, 5_000_000n, msg8);
    expect(vaultLines(c8)).toEqual([vectorLog("mandate_created_max_periods_near_account")]);
    expect(vaultLines(await h.fund(ALICE, USDC, 10_000_000n, { top_up: { mandate_id: 7 } }))).toEqual([
      vectorLog("topped_up"),
    ]);
    const p1 = await h.call("keeper.near", "collect", { mandate_id: 7 });
    expect(vaultLines(p1)).toEqual([vectorLog("collected")]);
    expect(statusValue(p1)).toBe("true");
    h.now = T0 + MONTH_NS;
    faults.fee = true;
    expect(vaultLines(await h.call("keeper.near", "collect", { mandate_id: 7 }))).toEqual([
      vectorLog("collected_fee_leg_failed"),
    ]);
    faults.reset();
    h.now = T0 + 2n * MONTH_NS;
    faults.merchant = "partial";
    expect(vaultLines(await h.call("keeper.near", "collect", { mandate_id: 7 }))).toEqual([
      vectorLog("collected_partial"),
    ]);
    h.now = T0 + 3n * MONTH_NS;
    faults.merchant = "fail";
    const failed = await h.call("keeper.near", "collect", { mandate_id: 7 });
    expect(vaultLines(failed)).toEqual([vectorLog("collect_failed")]);
    expect(statusValue(failed)).toBe("false");
    faults.reset();
    expect(vaultLines(await h.call(ALICE, "cancel", { mandate_id: 7 }))).toEqual([vectorLog("canceled")]);
  });

  it("canceled_refund_failed then withdrawn", async () => {
    const { h, faults } = await setup();
    await h.fund(ALICE, USDC, 10_000_000n, { top_up: { mandate_id: 7 } });
    await h.call("k.near", "collect", { mandate_id: 7 });
    h.now = T0 + MONTH_NS;
    faults.fee = true;
    await h.call("k.near", "collect", { mandate_id: 7 });
    h.now = T0 + 2n * MONTH_NS;
    faults.reset();
    faults.merchant = "partial";
    await h.call("k.near", "collect", { mandate_id: 7 });
    faults.reset();
    faults.refund = true;
    const c = await h.call(MERCHANT, "cancel", { mandate_id: 7 });
    expect(vaultLines(c)).toEqual([vectorLog("canceled_refund_failed")]);
    expect(statusValue(c)).toBe("false");
    faults.reset();
    const w = await h.call(ALICE, "withdraw", { mandate_id: 7 });
    expect(vaultLines(w)).toEqual([vectorLog("withdrawn")]);
    expect(await h.view("get_mandate", { mandate_id: 7 })).toBe("null");
  });

  it("exhausted after max_periods, and the view results of that state", async () => {
    const { h } = await setup();
    await h.fund(ALICE, USDT, 5_000_000n, msg8);
    await h.fund(ALICE, USDC, 10_000_000n, { top_up: { mandate_id: 7 } });
    await h.call("k.near", "collect", { mandate_id: 7 });
    await h.fund(ALICE, USDT, 55_000_001n, { top_up: { mandate_id: 8 } });
    let last: Awaited<ReturnType<Harness["call"]>> | undefined;
    for (let i = 0n; i < 12n; i++) {
      h.now = T0 + i * WEEK_NS;
      last = await h.call("k.near", "collect", { mandate_id: 8 });
      expect(statusValue(last)).toBe("true");
    }
    expect(vaultLines(last as never).at(-1)).toBe(vectorLog("exhausted"));
    expect(failure(await h.call("k.near", "collect", { mandate_id: 8 }))).toBe(
      "Smart contract panicked: ERR_MAX_PERIODS",
    );
    expect(await h.view("get_mandate", { mandate_id: 7 })).toBe(vectorView("get_mandate"));
    expect(await h.view("get_mandate", { mandate_id: 8 })).toBe(vectorView("get_mandate_exhausted"));
    expect(await h.view("get_mandate", { mandate_id: 999 })).toBe(vectorView("get_mandate_missing"));
    expect(await h.view("get_mandates_by_payer", { payer: ALICE })).toBe(vectorView("get_mandates_by_payer"));
    expect(await h.view("next_collect_at", { mandate_id: 7 })).toBe(vectorView("next_collect_at"));
    expect(await h.view("next_collect_at", { mandate_id: 8 })).toBe(vectorView("next_collect_at_none"));
    expect(await h.view("get_config")).toBe(vectorView("get_config"));
    expect(await h.view("get_token_tvl", { token: USDC })).toBe(vectorView("get_token_tvl"));
    expect(await h.view("storage_balance_bounds")).toBe(vectorView("storage_balance_bounds"));
    expect(Buffer.from(await h.view("get_mandate", { mandate_id: 999 })).toJSON().data).toEqual(
      V.rpc.call_function_result_bytes_get_mandate_missing,
    );
  });

  it("storage_balance_of with one open mandate", async () => {
    const { h } = await setup(STORAGE_REGISTRATION_COST + MANDATE_STORAGE_COST);
    expect(await h.view("storage_balance_of", { account_id: ALICE })).toBe(vectorView("storage_balance_of"));
    expect(await h.view("storage_balance_of", { account_id: "nobody.near" })).toBe("null");
  });

  it("the spec formatter reproduces every vector line (the stand-in emits through it)", () => {
    for (const e of V.events as { event: VaultEvent; log: string }[]) expect(formatVaultEventLog(e.event)).toBe(e.log);
  });
});

describe("errors", () => {
  it("panics render as `Smart contract panicked: <code>` in NEAR RPC's Failure shape", async () => {
    const { h } = await setup();
    await h.call("k.near", "collect", { mandate_id: 7 });
    const nd = await h.call("k.near", "collect", { mandate_id: 7 });
    expect(nd.status).toEqual(V.rpc.collect_not_due_status);
    expect(nearPanicStatus("ERR_NOT_DUE")).toEqual(V.rpc.collect_not_due_status);
  });

  it("collect check order", async () => {
    expect(V.errors.collect_check_order).toEqual([
      "ERR_GAS",
      "ERR_NOT_FOUND",
      "ERR_MAX_PERIODS",
      "ERR_NOT_ACTIVE",
      "ERR_IN_FLIGHT",
      "ERR_NOT_DUE",
      "ERR_INSUFFICIENT_BALANCE",
    ]);
    const { h } = await setup();
    const panicOf = async (args: object, gas = 250n * TGAS) =>
      failure(await h.call("k.near", "collect", args, { gas }));
    // ERR_GAS before everything (even an unknown mandate)
    expect(await panicOf({ mandate_id: 999 }, MIN_COLLECT_GAS - 1n)).toBe("Smart contract panicked: ERR_GAS");
    expect(await panicOf({ mandate_id: 999 })).toBe("Smart contract panicked: ERR_NOT_FOUND");
    // in flight is unreachable synchronously; checked in the property test. NOT_DUE before INSUFFICIENT_BALANCE:
    await h.call("k.near", "collect", { mandate_id: 7 });
    await h.call("k.near", "collect", { mandate_id: 7 }, { gas: 250n * TGAS });
    h.now = T0 + MONTH_NS;
    await h.call("k.near", "collect", { mandate_id: 7 });
    expect(await panicOf({ mandate_id: 7 })).toBe("Smart contract panicked: ERR_NOT_DUE");
    h.now = T0 + 2n * MONTH_NS;
    await h.call("k.near", "collect", { mandate_id: 7 }); // period 3 empties the balance
    h.now = T0 + 3n * MONTH_NS;
    expect(await panicOf({ mandate_id: 7 })).toBe("Smart contract panicked: ERR_INSUFFICIENT_BALANCE");
    await h.call(ALICE, "cancel", { mandate_id: 7 });
    // a canceled mandate with no balance is closed (removed): NOT_FOUND
    expect(await panicOf({ mandate_id: 7 })).toBe("Smart contract panicked: ERR_NOT_FOUND");
  });

  it("cancel and withdraw check orders, the 1-yocto guard and ERR_STILL_ACTIVE / ERR_INSUFFICIENT_BALANCE", async () => {
    expect(V.errors.cancel_check_order).toEqual(["ERR_GAS", "ERR_NOT_FOUND", "ERR_UNAUTHORIZED", "ERR_NOT_ACTIVE"]);
    expect(V.errors.withdraw_check_order).toEqual([
      "ERR_GAS",
      "ERR_NOT_FOUND",
      "ERR_UNAUTHORIZED",
      "ERR_STILL_ACTIVE",
      "ERR_IN_FLIGHT",
      "ERR_INSUFFICIENT_BALANCE",
    ]);
    const { h, faults } = await setup();
    const p = (r: Awaited<ReturnType<Harness["call"]>>) => failure(r);
    for (const m of ["cancel", "withdraw"]) {
      expect(p(await h.call(ALICE, m, { mandate_id: 999 }, { gas: MIN_EXIT_GAS - 1n, deposit: 0n }))).toBe(
        "Smart contract panicked: ERR_GAS",
      );
      expect(p(await h.call(ALICE, m, { mandate_id: 999 }, { deposit: 0n }))).toBe(
        `Smart contract panicked: ${V.errors.near_sdk_guards.one_yocto}`,
      );
      expect(p(await h.call(ALICE, m, { mandate_id: 999 }))).toBe("Smart contract panicked: ERR_NOT_FOUND");
      expect(p(await h.call("mallory.near", m, { mandate_id: 7 }))).toBe("Smart contract panicked: ERR_UNAUTHORIZED");
    }
    expect(p(await h.call(ALICE, "withdraw", { mandate_id: 7 }))).toBe("Smart contract panicked: ERR_STILL_ACTIVE");
    faults.refund = true;
    await h.call(ALICE, "cancel", { mandate_id: 7 });
    faults.reset();
    expect(p(await h.call(ALICE, "cancel", { mandate_id: 7 }))).toBe("Smart contract panicked: ERR_NOT_ACTIVE");
    await h.call(ALICE, "withdraw", { mandate_id: 7 });
    expect(await h.view("get_mandate", { mandate_id: 7 })).toBe("null");
  });

  it("every funding rejection line, refunded in full", async () => {
    expect(V.errors.funding_rejection_log_lines).toHaveLength(10);
    const { h } = await setup(STORAGE_REGISTRATION_COST + 3n * MANDATE_STORAGE_COST);
    const lines = new Set<string>();
    const rejectWith = async (payer: string, token: string, amount: bigint, msg: unknown) => {
      const r = await h.fund(payer, token, amount, msg as object);
      expect(statusValue(r)).toBe('"0"'); // the token's resolve: nothing used
      const l = vaultLines(r);
      expect(l).toHaveLength(1);
      lines.add(l[0] as string);
      return l[0];
    };
    expect(await rejectWith("intents.near", USDC, 1n, msg7)).toBe("ERR_UNSUPPORTED_SENDER");
    expect(await rejectWith(ALICE, USDC, 1n, "{")).toBe("ERR_BAD_MSG");
    expect(await rejectWith(ALICE, USDC, 1n, { create_mandate: { ...msg7.create_mandate, fee_bps: 501 } })).toBe(
      "ERR_FEE_TOO_HIGH",
    );
    expect(await rejectWith("bob.near", USDC, 1n, msg7)).toBe("ERR_NO_STORAGE");
    expect(await rejectWith(ALICE, USDC, 1n, { top_up: { mandate_id: 999 } })).toBe("ERR_NOT_FOUND");
    expect(await rejectWith("bob.near", USDC, 1n, { top_up: { mandate_id: 7 } })).toBe("ERR_UNAUTHORIZED");
    expect(await rejectWith(ALICE, USDT, 1n, { top_up: { mandate_id: 7 } })).toBe("ERR_TOKEN_NOT_ALLOWED");
    expect(await rejectWith(ALICE, USDC, 10n ** 11n + 1n, msg7)).toBe("ERR_CAP_EXCEEDED: mandate");
    // TVL cap: ten mandates at the per-mandate cap fill the 10^12 TVL cap
    await h.register("whale.near", STORAGE_REGISTRATION_COST + 11n * MANDATE_STORAGE_COST);
    for (let i = 0; i < 9; i++) await h.fund("whale.near", USDC, 10n ** 11n, msg7);
    expect(await rejectWith("whale.near", USDC, 10n ** 11n, msg7)).toBe("ERR_CAP_EXCEEDED: tvl");
    await h.call(ALICE, "cancel", { mandate_id: 7 });
    expect(await rejectWith(ALICE, USDC, 1n, { top_up: { mandate_id: 7 } })).toBe("ERR_NOT_FOUND"); // closed and removed
    // a canceled mandate kept by a failed refund rejects top-ups with ERR_NOT_ACTIVE
    const kept = await new Promise<Harness>((resolve) => resolve(h));
    const f2 = new ScriptedFaults();
    kept.faults = f2;
    const id = Number(
      JSON.parse((vaultLines(await kept.fund(ALICE, USDC, 1_000_000n, msg7))[0] as string).slice(11)).data[0]
        .mandate_id,
    );
    f2.refund = true;
    await kept.call(ALICE, "cancel", { mandate_id: id });
    f2.reset();
    expect(await rejectWith(ALICE, USDC, 1n, { top_up: { mandate_id: id } })).toBe("ERR_NOT_ACTIVE");
    expect([...lines].sort()).toEqual([...V.errors.funding_rejection_log_lines].sort());
  });

  it("a token outside the allow-list panics (the token refunds)", async () => {
    const { h } = await setup();
    const r = await h.fund(ALICE, "wrap.near", 5n, msg7);
    const vaultReceipt = r.receipts.find((x) => x.executor === VAULT);
    expect(vaultReceipt?.status).toEqual(nearPanicStatus("ERR_TOKEN_NOT_ALLOWED"));
    expect(statusValue(r)).toBe('"0"');
    expect(await h.mem.ft("wrap.near", ALICE)).toBe(5n);
  });

  it("ERR_OPEN_MANDATES, ERR_NO_STORAGE, ERR_INSUFFICIENT_BALANCE on storage; ERR_BAD_CONFIG", async () => {
    const { h } = await setup();
    expect(failure(await h.call(ALICE, "storage_unregister", {}))).toBe("Smart contract panicked: ERR_OPEN_MANDATES");
    expect(failure(await h.call("nobody.near", "storage_withdraw", {}))).toBe(
      "Smart contract panicked: ERR_NO_STORAGE",
    );
    expect(failure(await h.call(ALICE, "storage_withdraw", { amount: "10000000000000000000001" }))).toBe(
      "Smart contract panicked: ERR_INSUFFICIENT_BALANCE",
    );
    expect(failure(await h.call("bob.near", "storage_deposit", {}, { deposit: 1n }))).toBe(
      "Smart contract panicked: ERR_NO_STORAGE",
    );
    expect(checkConfig({ ...vectorConfig(), feeReceiver: VAULT })).toBe("ERR_BAD_CONFIG");
    expect(checkConfig(vectorConfig())).toBeNull();
    expect(V.errors.codes).toHaveLength(17);
    expect(V.errors.panic_messages).toEqual((V.errors.codes as string[]).map((c) => `Smart contract panicked: ${c}`));
  });
});

describe("msg, split, limits, gas, rpc, sandbox defaults", () => {
  it("parses every vector msg and serialises it with the spec helper", () => {
    for (const m of V.msgs as { msg: unknown; json: string }[]) {
      expect(vaultMsgJson(m.msg as never)).toBe(m.json);
      expect(parseMsg(m.json)).not.toBe("ERR_BAD_MSG");
    }
  });

  it("split vectors", () => {
    for (const x of V.split as { amount_per_period: string; fee_bps: number; merchant_share: string; fee: string }[]) {
      const r = split(BigInt(x.amount_per_period), x.fee_bps);
      expect([r.share.toString(), r.fee.toString()]).toEqual([x.merchant_share, x.fee]);
    }
  });

  it("limits and gas equal the contract constants", () => {
    expect({
      min_period_secs: Number(MIN_PERIOD_SECS),
      max_period_secs: Number(MAX_PERIOD_SECS),
      max_max_periods: MAX_MAX_PERIODS,
      max_start_delay_ns: MAX_START_DELAY_NS.toString(),
      max_ext_ref_len: MAX_EXT_REF_LEN,
      max_msg_len: MAX_MSG_LEN,
      mandate_storage_cost: MANDATE_STORAGE_COST.toString(),
      storage_registration_cost: STORAGE_REGISTRATION_COST.toString(),
    }).toEqual(V.limits);
    expect(V.gas.min_collect).toBe(MIN_COLLECT_GAS.toString());
    expect(V.gas.min_exit).toBe(MIN_EXIT_GAS.toString());
  });

  it("collect_success: SuccessValue true and the exact vault receipt", async () => {
    const { h } = await setup();
    await h.fund(ALICE, USDC, 10_000_000n, { top_up: { mandate_id: 7 } });
    const r = await h.call("k.near", "collect", { mandate_id: 7 });
    expect(r.status).toEqual(V.rpc.collect_success.status);
    const withLogs = r.receipts.filter((x) => x.executor === VAULT && x.logs.length);
    expect(withLogs).toHaveLength(1);
    expect(withLogs[0]?.executor).toBe(V.rpc.collect_success.vault_receipt.executor_id);
    expect(withLogs[0]?.logs).toEqual(V.rpc.collect_success.vault_receipt.logs);
    expect(withLogs[0]?.status).toEqual({
      SuccessValue: V.rpc.collect_success.vault_receipt.status_success_value_base64,
    });
  });

  it("sandbox defaults and scenario table", () => {
    const c = vaultConfigFrom({
      sandboxVaultAccount: "vault.sandbox.near",
      sandboxVaultFeeReceiver: "treasury.sandbox.near",
    });
    expect({
      vault_contract: c.account,
      fee_receiver: c.feeReceiver,
      intents_account: c.intentsAccount,
      max_fee_bps: c.maxFeeBps,
    }).toEqual(V.sandbox.defaults);
    expect(V.sandbox.defaults).toEqual(SANDBOX_VAULT_DEFAULTS);
    expect(c.allowedTokens).toEqual([USDC, USDT]);
    for (const [suffix, name] of Object.entries(V.sandbox.scenarios_by_amount_suffix))
      expect(vaultSandboxScenarioOf(`100000${suffix}`)).toBe(name);
    expect(vaultSandboxScenarioOf("10000000")).toBe("success");
  });
});
