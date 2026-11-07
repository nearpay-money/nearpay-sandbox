/**
 * Stage 2 refund legs end to end (sandbox LLD §3, §4, §8): EXACT_INPUT / EXACT_OUTPUT route legs, INTENTS-deposit
 * legs funded by a merchant-signed Verifier transfer (or `/sim/intents/transfers`), direct Intents legs, scenario 06
 * duplicates within one refund (and within one payment by `scenario_group`), at time scale 0.01.
 */

import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { ErrorEnvelope, type IntentMessage } from "@nearpay/spec";
import { sql } from "@nearpay-internal/db";
import {
  buildPayload,
  implicitAccountId,
  intentsExecuted,
  makeNonce,
  mtTransfers,
  parseDip4Events,
  signNep413,
} from "@nearpay-internal/intents";
import { OneClickQuoteResponse, OneClickStatusResponse, type SandboxQuoteRequest, SimTx } from "@nearpay-internal/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYER, quoteRequest, USDC_ARB, USDC_BASE, USDC_NEAR } from "../support/requests.js";
import { mintTestToken, type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ timeScale: 0.01, tickMs: 20 });
});
afterAll(async () => {
  await s?.stop();
});

type Q = ReturnType<typeof OneClickQuoteResponse.parse>;
type St = ReturnType<typeof OneClickStatusResponse.parse>;
const MERCHANT_EVM = "0x4de0e65ab08c2a1d21a2651e9462a42ab11b7559";
let groups = 0;
const group = (prefix = "re") => `${prefix}_${Date.now().toString(36)}${groups++}`;

/** A refund route leg as rails sends it (no app fee; scenario amount = refund amount; Base merchant → Arbitrum payer). */
function leg(over: Partial<SandboxQuoteRequest> = {}): SandboxQuoteRequest {
  const amount = over.amount ?? "1000000";
  return quoteRequest({
    swapType: "EXACT_INPUT",
    originAsset: USDC_BASE,
    depositType: "ORIGIN_CHAIN",
    refundTo: MERCHANT_EVM,
    refundType: "ORIGIN_CHAIN",
    destinationAsset: USDC_ARB,
    recipient: PAYER,
    recipientType: "DESTINATION_CHAIN",
    appFees: [],
    amount,
    scenario_amount: amount,
    scenario_kind: "refund",
    scenario_group: group(),
    ...over,
  });
}
async function quote(req: SandboxQuoteRequest): Promise<Q> {
  const r = await s.call("POST", "/v0/quote", req);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return OneClickQuoteResponse.parse(r.body);
}
const addr = (q: Q) => q.quote.depositAddress as string;
async function status(q: Q): Promise<St> {
  return OneClickStatusResponse.parse((await s.call("GET", `/v0/status?depositAddress=${addr(q)}`)).body);
}
async function settle(q: Q, timeoutMs = 10_000): Promise<St> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const st = await status(q);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(st.status)) return st;
    if (Date.now() > until) throw new Error(`timeout, status ${st.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function chainTx(chain: string, hash: string) {
  const r = await s.call("GET", `/sim/chains/${encodeURIComponent(chain)}/tx/${hash}`);
  expect(r.status).toBe(200);
  return SimTx.parse(r.body);
}
async function logsOf(tx: string): Promise<string[]> {
  const r = await s.call("GET", "/sim/intents/events?cursor=0&limit=500");
  const all: { log: string; tx_hash: string; seq: number }[] = [];
  let page = (r.body as { events: typeof all; next_cursor: number }).events;
  let cursor = 0;
  while (page.length) {
    all.push(...page);
    cursor = page[page.length - 1]?.seq ?? cursor;
    page = ((await s.call("GET", `/sim/intents/events?cursor=${cursor}&limit=500`)).body as { events: typeof all })
      .events;
  }
  return all.filter((e) => e.tx_hash === tx).map((e) => e.log);
}
async function balance(account: string, token = USDC_NEAR): Promise<bigint> {
  const r = await s.database.db
    .selectFrom("sim_intents_balances")
    .select("amount")
    .where("account_id", "=", account)
    .where("token", "=", token)
    .executeTakeFirst();
  return BigInt(r?.amount ?? "0");
}
/** The first DIP-4 `transfer` entry of a transaction's logs. */
function dip4Transfer(logs: readonly string[]): unknown {
  const e = parseDip4Events(logs).find((x) => x.event === "transfer");
  return (e?.data as unknown[] | undefined)?.[0];
}
const transfer = (body: Record<string, unknown>) => s.call("POST", "/sim/intents/transfers", body);
const setDeadline = (q: Q, at: Date) =>
  sql`update sim_quotes set deadline = ${at} where deposit_address = ${addr(q)}`.execute(s.database.db);

describe("refund route legs", () => {
  it("EXACT_INPUT: the merchant sends exactly the refund; the payer receives it less the route cost on its chain", async () => {
    const req = leg({ amount: "1000000" });
    const q = await quote(req);
    expect(verifyQuoteSignature(q as never, s.managerPublicKey)).toBe(true);
    expect(q.quote).toMatchObject({ amountIn: "1000000", minAmountIn: "1000000", amountOut: "998000" });
    // the sandbox-only fields are never echoed (1Click parity); no app fee
    expect(q.quoteRequest).not.toHaveProperty("scenario_kind");
    expect(q.quoteRequest).not.toHaveProperty("scenario_group");
    expect(q.quoteRequest).not.toHaveProperty("scenario_amount");
    expect(q.quoteRequest.appFees).toEqual([]);
    const row = await s.database.db
      .selectFrom("sim_quotes")
      .select(["scenario", "scenario_kind", "scenario_group"])
      .where("deposit_address", "=", addr(q))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ scenario: "00", scenario_kind: "refund", scenario_group: req.scenario_group });

    expect((await s.call("POST", "/sim/deposits", { deposit_address: addr(q) })).status).toBe(202);
    const st = await settle(q);
    expect([st.status, st.swapDetails.amountOut, st.swapDetails.depositedAmount]).toEqual([
      "SUCCESS",
      "998000",
      "1000000",
    ]);
    const payout = st.swapDetails.destinationChainTxHashes[0]?.hash as string;
    expect((await chainTx("eip155:42161", payout)).transfers).toEqual([
      { token: USDC_ARB, to: PAYER, amount: "998000" },
    ]);
    // the merchant's deposit is a simulated Base transaction
    const dep = st.swapDetails.originChainTxHashes[0]?.hash as string;
    expect((await chainTx("eip155:8453", dep)).transfers).toEqual([
      { token: USDC_BASE, to: addr(q), amount: "1000000" },
    ]);
  });

  it("EXACT_OUTPUT: the payer receives exactly the refund; the merchant pays the route cost", async () => {
    const q = await quote(leg({ swapType: "EXACT_OUTPUT", amount: "1000000" }));
    expect(q.quote).toMatchObject({ amountOut: "1000000", minAmountOut: "1000000", amountIn: "1002000" });
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const st = await settle(q);
    expect([st.status, st.swapDetails.amountOut]).toEqual(["SUCCESS", "1000000"]);
  });

  it("02 on a refund leg: the merchant underpays and gets the deposit back at the deadline", async () => {
    const q = await quote(leg({ amount: "1000002" }));
    await setDeadline(q, new Date(Date.now() + 300));
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const st = await settle(q);
    expect([st.status, st.swapDetails.refundReason, st.swapDetails.refundedAmount]).toEqual([
      "REFUNDED",
      "PARTIAL_DEPOSIT",
      "1000001",
    ]);
  });
});

describe("Intents-account refunds (INTENTS deposit route legs)", () => {
  it("a merchant-signed transfer from its settled Intents balance funds the leg; the payer is paid on its chain", async () => {
    // The merchant's simulated Intents balance comes from a settled test payment into its Intents account.
    const sk = ed25519.utils.randomSecretKey();
    const merchant = implicitAccountId(ed25519.getPublicKey(sk));
    const pay = await quote(quoteRequest({ recipient: merchant, scenario_amount: "500", amount: "3000000" }));
    await s.call("POST", "/sim/deposits", { deposit_address: addr(pay) });
    expect((await settle(pay)).status).toBe("SUCCESS");
    expect(await balance(merchant)).toBe(3_000_000n);

    const q = await quote(
      leg({
        originAsset: USDC_NEAR,
        depositType: "INTENTS",
        refundTo: merchant,
        refundType: "INTENTS",
        amount: "2000000",
      }),
    );
    expect(addr(q)).toMatch(/^sbx-[0-9a-f]{40}\.near$/);
    const binding = "np1:refundleg";
    const msg = buildPayload({
      signerId: merchant,
      deadline: new Date(Date.now() + 120_000).toISOString(),
      nonce: makeNonce("5a0dbe11"),
      intents: [{ intent: "transfer", receiver_id: addr(q), tokens: { [USDC_NEAR]: "2000000" }, memo: binding }],
    } as never) as IntentMessage;
    const exec = await s.call("POST", "/sim/intents/execute", { signed: [signNep413(msg, sk)] });
    expect(exec.status).toBe(200);
    const ex = exec.body as { status: string; tx_hash: string };
    expect(ex.status).toBe("success");
    expect(await balance(merchant)).toBe(1_000_000n);

    const pending = await status(q);
    expect(pending.swapDetails.depositedAmount).toBe("2000000");
    expect(pending.swapDetails.originChainTxHashes.map((t) => t.hash)).toEqual([ex.tx_hash]);
    const st = await settle(q);
    expect([st.status, st.swapDetails.amountOut]).toEqual(["SUCCESS", "1996000"]);
    const payout = st.swapDetails.destinationChainTxHashes[0]?.hash as string;
    expect((await chainTx("eip155:42161", payout)).transfers).toEqual([
      { token: USDC_ARB, to: PAYER, amount: "1996000" },
    ]);
    // rails' indexer sees the binding on the DIP-4 transfer, not on the NEP-245 mt_transfer
    const logs = await logsOf(ex.tx_hash);
    expect(dip4Transfer(logs)).toMatchObject({
      memo: binding,
    });
    expect(mtTransfers(logs)[0]).not.toHaveProperty("memo");
    // a later wallet report of the same tx is idempotent
    const again = await s.call("POST", "/v0/deposit/submit", { txHash: ex.tx_hash, depositAddress: addr(q) });
    expect(OneClickStatusResponse.parse(again.body).swapDetails.originChainTxHashes).toHaveLength(1);
  });

  it("an INTENTS leg is refunded to the merchant's Intents account when underpaid (02)", async () => {
    const merchant = `m${groups}-refunds.near`;
    const q = await quote(
      leg({
        originAsset: USDC_NEAR,
        depositType: "INTENTS",
        refundTo: merchant,
        refundType: "INTENTS",
        amount: "700002",
      }),
    );
    await setDeadline(q, new Date(Date.now() + 300));
    const r = await transfer({ from: merchant, to: addr(q), token: USDC_NEAR, amount: "700001", memo: "np1:x" });
    expect(r.status).toBe(200);
    const st = await settle(q);
    expect([st.status, st.swapDetails.refundedAmount]).toEqual(["REFUNDED", "700001"]);
    expect(await balance(merchant)).toBe(700_001n); // minted 700001, sent, got it back
  });

  it("a transfer of another asset, or into a leg already funded, is not a deposit", async () => {
    const q = await quote(
      leg({ originAsset: USDC_NEAR, depositType: "INTENTS", refundTo: "merchant.near", refundType: "INTENTS" }),
    );
    await transfer({ from: "merchant.near", to: addr(q), token: "nep141:wrap.near", amount: "1000000" });
    expect((await status(q)).status).toBe("PENDING_DEPOSIT");
    await transfer({ from: "merchant.near", to: addr(q), token: USDC_NEAR, amount: "1000000" });
    const after = (await transfer({ from: "merchant.near", to: addr(q), token: USDC_NEAR, amount: "1000000" }))
      .body as { tx_hash: string };
    const st = await settle(q);
    expect(st.swapDetails.depositedAmount).toBe("1000000");
    expect(st.swapDetails.originChainTxHashes.map((t) => t.hash)).not.toContain(after.tx_hash);
  });

  it("a transfer into an ORIGIN_CHAIN deposit address on NEAR is not attributed", async () => {
    const q = await quote(leg({ originAsset: USDC_NEAR, refundTo: "merchant.near", depositType: "ORIGIN_CHAIN" }));
    await transfer({ from: "merchant.near", to: addr(q), token: USDC_NEAR, amount: "1000000" });
    expect((await status(q)).status).toBe("PENDING_DEPOSIT");
  });
});

describe("POST /sim/intents/transfers (direct Intents legs)", () => {
  it("mints the shortfall, moves the amount and emits what a signed execute emits, with the memo on DIP-4 only", async () => {
    const from = `m${groups++}-direct.near`;
    await s.call("POST", "/sim/intents/fund", { account_id: from, token: USDC_NEAR, amount: "400" });
    const r = await transfer({ from, to: "payer-direct.near", token: USDC_NEAR, amount: "1000", memo: "np1:leg" });
    expect(r.status).toBe(200);
    const { tx_hash } = r.body as { tx_hash: string };
    expect(await balance(from)).toBe(0n);
    const logs = await logsOf(tx_hash);
    expect(logs[0]).toContain('"event":"mt_mint"');
    expect(logs[0]).toContain('"amounts":["600"]');
    expect(mtTransfers(logs)).toEqual([
      { old_owner_id: from, new_owner_id: "payer-direct.near", token_ids: [USDC_NEAR], amounts: ["1000"] },
    ]);
    expect(dip4Transfer(logs)).toMatchObject({
      account_id: from,
      receiver_id: "payer-direct.near",
      tokens: { [USDC_NEAR]: "1000" },
      memo: "np1:leg",
    });
    expect(intentsExecuted(logs)).toEqual([expect.objectContaining({ account_id: from })]);
  });

  it("does not mint when the balance covers the transfer", async () => {
    const from = `m${groups++}-funded.near`;
    await s.call("POST", "/sim/intents/fund", { account_id: from, token: USDC_NEAR, amount: "5000" });
    const { tx_hash } = (await transfer({ from, to: "p.near", token: USDC_NEAR, amount: "1000" })).body as {
      tx_hash: string;
    };
    expect(await balance(from)).toBe(4000n);
    const logs = await logsOf(tx_hash);
    expect(logs.some((l) => l.includes("mt_mint"))).toBe(false);
    expect(dip4Transfer(logs)).not.toHaveProperty("memo");
  });

  it("refuses a zero amount, a self-transfer and a live-mode principal", async () => {
    const zero = await transfer({ from: "a.near", to: "b.near", token: USDC_NEAR, amount: "0" });
    expect([zero.status, ErrorEnvelope.parse(zero.body).error.param]).toEqual([400, "amount"]);
    const self = await transfer({ from: "a.near", to: "a.near", token: USDC_NEAR, amount: "1" });
    expect([self.status, ErrorEnvelope.parse(self.body).error.param]).toEqual([400, "to"]);
    const live = await mintTestToken({ sub: "payments", ptype: "service", scp: ["sandbox.use"], lm: true });
    const r = await s.call(
      "POST",
      "/sim/intents/transfers",
      { from: "a.near", to: "b.near", token: USDC_NEAR, amount: "1" },
      live,
    );
    expect([r.status, ErrorEnvelope.parse(r.body).error.code]).toEqual([403, "livemode_forbidden"]);
  });
});

describe("scenario 06 within one refund / one payment", () => {
  it("a deposit to the new leg also settles the expired leg of the same refund (duplicate leg), not other refunds", async () => {
    const g = group();
    const expired = await quote(leg({ scenario_group: g, amount: "1000006" }));
    const current = await quote(leg({ scenario_group: g, amount: "1000006" }));
    const otherRefund = await quote(leg({ amount: "1000006" }));
    await setDeadline(expired, new Date(Date.now() - 60_000));
    await s.call("POST", "/sim/deposits", { deposit_address: addr(current) });
    const [a, b] = await Promise.all([settle(expired), settle(current)]);
    expect([a.status, b.status]).toEqual(["SUCCESS", "SUCCESS"]);
    expect(a.swapDetails.amountOut).toBe(b.swapDetails.amountOut);
    expect((await status(otherRefund)).status).toBe("PENDING_DEPOSIT");
  });

  it("a deposit to an older leg also settles the newer open leg", async () => {
    const g = group();
    const first = await quote(leg({ scenario_group: g, amount: "2000006" }));
    const second = await quote(leg({ scenario_group: g, amount: "2000006" }));
    await s.call("POST", "/sim/deposits", { deposit_address: addr(first) });
    expect((await settle(second)).status).toBe("SUCCESS");
  });

  it("an Intents-funded 06 leg settles its sibling too", async () => {
    const g = group();
    const intents = {
      originAsset: USDC_NEAR,
      depositType: "INTENTS",
      refundTo: "merchant06.near",
      refundType: "INTENTS",
    } as const;
    const a = await quote(leg({ ...intents, scenario_group: g, amount: "3000006" }));
    const b = await quote(leg({ ...intents, scenario_group: g, amount: "3000006" }));
    await transfer({ from: "merchant06.near", to: addr(b), token: USDC_NEAR, amount: "3000006", memo: "np1:b" });
    expect((await settle(a)).status).toBe("SUCCESS");
    expect((await settle(b)).status).toBe("SUCCESS");
  });

  it("payments group by scenario_group: older attempts of the same payment only, whatever their refund address", async () => {
    const pi = group("pi");
    const older = await quote(quoteRequest({ scenario_amount: "306", scenario_group: pi, scenario_kind: "payment" }));
    const newer = await quote(
      quoteRequest({
        scenario_amount: "306",
        scenario_group: pi,
        refundTo: "0x1111111111111111111111111111111111111111",
      }),
    );
    const otherPayment = await quote(quoteRequest({ scenario_amount: "306", scenario_group: group("pi") }));
    await s.call("POST", "/sim/deposits", { deposit_address: addr(newer) });
    expect((await settle(older)).status).toBe("SUCCESS");
    expect((await status(otherPayment)).status).toBe("PENDING_DEPOSIT");
  });

  it("an expired payment attempt is still refunded after its deadline (Stage 1 behaviour kept)", async () => {
    const pi = group("pi");
    const older = await quote(quoteRequest({ scenario_amount: "406", scenario_group: pi }));
    const newer = await quote(quoteRequest({ scenario_amount: "406", scenario_group: pi }));
    await setDeadline(older, new Date(Date.now() - 60_000));
    await s.call("POST", "/sim/deposits", { deposit_address: addr(newer) });
    const st = await settle(older);
    expect([st.status, st.swapDetails.refundReason]).toEqual(["REFUNDED", "DEPOSIT_AFTER_DEADLINE"]);
  });
});
