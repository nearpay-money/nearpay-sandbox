/**
 * Scenario timelines 00–07 end to end over HTTP (sandbox LLD §4, api-conventions §8), at time scale
 * 0.01 with the background materializer running, plus manual control (`/sim/advance`).
 */

import { sql } from "@nearpay-internal/db";
import { mtTransfers } from "@nearpay-internal/intents";
import { OneClickQuoteResponse, OneClickStatusResponse, SimTx } from "@nearpay-internal/spec";
import { ErrorEnvelope } from "@nearpay-money/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { solverAddress } from "../../src/simulated-chains/addresses.js";
import { MERCHANT, PAYER, quoteRequest, USDC_ARB, USDC_NEAR } from "../support/requests.js";
import { type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ timeScale: 0.01, tickMs: 20 });
});
afterAll(async () => {
  await s?.stop();
});

type Q = ReturnType<typeof OneClickQuoteResponse.parse>;
type St = ReturnType<typeof OneClickStatusResponse.parse>;

async function quote(over: Parameters<typeof quoteRequest>[0] = {}): Promise<Q> {
  const r = await s.call("POST", "/v0/quote", quoteRequest(over));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return OneClickQuoteResponse.parse(r.body);
}
const addr = (q: Q) => q.quote.depositAddress as string;
async function status(q: Q): Promise<St> {
  return OneClickStatusResponse.parse((await s.call("GET", `/v0/status?depositAddress=${addr(q)}`)).body);
}
async function deposit(q: Q, amount_in?: string): Promise<number> {
  return (await s.call("POST", "/sim/deposits", { deposit_address: addr(q), ...(amount_in ? { amount_in } : {}) }))
    .status;
}
/** Waits for a terminal status (the materializer applies steps in the background). */
async function settle(q: Q, timeoutMs = 10_000): Promise<St> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [row] = (
      await sql<{ state: string }>`select state from sim_quotes where deposit_address = ${addr(q)}`.execute(
        s.database.db,
      )
    ).rows;
    if (row && ["SUCCESS", "REFUNDED", "FAILED"].includes(row.state)) return status(q);
    if (Date.now() > until) throw new Error(`timeout, state ${row?.state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function chainTx(chain: string, hash: string) {
  const r = await s.call("GET", `/sim/chains/${encodeURIComponent(chain)}/tx/${hash}`);
  expect(r.status).toBe(200);
  return SimTx.parse(r.body);
}
async function events() {
  const r = await s.call("GET", "/sim/intents/events?cursor=0&limit=500");
  return (r.body as { events: { log: string; tx_hash: string }[] }).events;
}
const setDeadline = (q: Q, at: Date) =>
  sql`update sim_quotes set deadline = ${at} where deposit_address = ${addr(q)}`.execute(s.database.db);

describe("scenario 00 (happy path)", () => {
  it("settles the exact amount into the merchant's Intents account with an indexable event", async () => {
    const q = await quote({ scenario_amount: "200" });
    expect(await deposit(q)).toBe(202);
    const st = await settle(q);
    expect(st.status).toBe("SUCCESS");
    expect(st.swapDetails).toMatchObject({
      amountIn: q.quote.amountIn,
      amountOut: "2000017",
      depositedAmount: q.quote.amountIn,
    });
    expect(st.swapDetails.refundedAmount).toBe("0");
    const dest = st.swapDetails.destinationChainTxHashes[0]?.hash as string;
    expect(st.swapDetails.nearTxHashes).toContain(dest);
    expect((await chainTx("near:mainnet", dest)).transfers).toEqual([
      { token: USDC_NEAR, from: "sbx-solver.near", to: MERCHANT, amount: "2000017" },
    ]);
    const logs = (await events()).filter((e) => e.tx_hash === dest).map((e) => e.log);
    expect(mtTransfers(logs)).toEqual([
      { old_owner_id: "sbx-solver.near", new_owner_id: MERCHANT, token_ids: [USDC_NEAR], amounts: ["2000017"] },
    ]);
    const bal = await sql<{
      amount: string;
    }>`select amount::text from sim_intents_balances where account_id = ${MERCHANT} and token = ${USDC_NEAR}`.execute(
      s.database.db,
    );
    expect(BigInt(bal.rows[0]?.amount ?? "0")).toBeGreaterThanOrEqual(2_000_017n);
  });

  it("settles a chain destination with a simulated chain transaction that finalizes", async () => {
    const q = await quote({
      destinationAsset: USDC_ARB,
      recipientType: "DESTINATION_CHAIN",
      recipient: PAYER,
      scenario_amount: "300",
    });
    await deposit(q);
    const st = await settle(q);
    const hash = st.swapDetails.destinationChainTxHashes[0]?.hash as string;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(st.swapDetails.destinationChainTxHashes[0]?.explorerUrl).toBe(`https://arbiscan.io/tx/${hash}`);
    const tx = await chainTx("eip155:42161", hash);
    expect(tx.transfers).toEqual([
      { token: USDC_ARB, from: solverAddress("eip155:42161"), to: PAYER, amount: "2000017" },
    ]);
    // the payer's deposit is sent from its refund address on the origin chain (spec 0.3.1 `from`)
    const dep = st.swapDetails.originChainTxHashes[0]?.hash as string;
    expect((await chainTx("eip155:8453", dep)).transfers[0]?.from).toBe(PAYER);
    await new Promise((r) => setTimeout(r, 40)); // finality after 2 s × 0.01
    expect((await chainTx("eip155:42161", hash)).finalized).toBe(true);
    expect(st.swapDetails.nearTxHashes).toEqual([]);
  });

  it("goes through KNOWN_DEPOSIT_TX and PROCESSING on the way", async () => {
    const slow = await startStack({ timeScale: 1, tickMs: 50 });
    try {
      const r = await slow.call("POST", "/v0/quote", quoteRequest());
      const q = OneClickQuoteResponse.parse(r.body);
      await slow.call("POST", "/sim/deposits", { deposit_address: addr(q) });
      const seen = new Set<string>();
      const until = Date.now() + 8_000;
      while (Date.now() < until && !seen.has("SUCCESS")) {
        const st = OneClickStatusResponse.parse((await slow.call("GET", `/v0/status?depositAddress=${addr(q)}`)).body);
        seen.add(st.status);
        await new Promise((x) => setTimeout(x, 200));
      }
      expect([...seen]).toEqual(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
    } finally {
      await slow.stop();
    }
  });
});

describe("scenarios 01–07", () => {
  it("01: succeeds only after 120 s (scaled)", async () => {
    const q = await quote({ scenario_amount: "201" });
    const t0 = Date.now();
    await deposit(q);
    expect((await settle(q)).status).toBe("SUCCESS");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_150);
  });

  it("02: underpaid → INCOMPLETE_DEPOSIT → REFUNDED at the deadline (PARTIAL_DEPOSIT)", async () => {
    const q = await quote({ scenario_amount: "202" });
    await setDeadline(q, new Date(Date.now() + 500));
    await deposit(q);
    await new Promise((r) => setTimeout(r, 100));
    expect((await status(q)).status).toBe("INCOMPLETE_DEPOSIT");
    const st = await settle(q);
    const deposited = BigInt(q.quote.minAmountIn) - 1n;
    expect(st.status).toBe("REFUNDED");
    expect(st.swapDetails).toMatchObject({ refundReason: "PARTIAL_DEPOSIT", refundedAmount: deposited.toString() });
    const refund = (
      await sql<{
        refund_tx_hashes: string[];
      }>`select refund_tx_hashes from sim_quotes where deposit_address = ${addr(q)}`.execute(s.database.db)
    ).rows[0]?.refund_tx_hashes[0] as string;
    expect((await chainTx("eip155:8453", refund)).transfers).toEqual([
      {
        token: q.quoteRequest.originAsset,
        from: solverAddress("eip155:8453"),
        to: PAYER,
        amount: deposited.toString(),
      },
    ]);
  });

  it("03: overpaid → SUCCESS with the excess refunded", async () => {
    const q = await quote({ scenario_amount: "203" });
    await deposit(q);
    const st = await settle(q);
    const amountIn = BigInt(q.quote.amountIn);
    expect(st.status).toBe("SUCCESS");
    expect(st.swapDetails).toMatchObject({ amountOut: "2000017", refundedAmount: (amountIn / 10n).toString() });
  });

  it("04: FAILED after PROCESSING", async () => {
    const q = await quote({ scenario_amount: "204" });
    await deposit(q);
    const st = await settle(q);
    expect(st.status).toBe("FAILED");
    expect(st.swapDetails.destinationChainTxHashes).toEqual([]);
  });

  it("05: SUCCESS but the destination receives one base unit less (short evidence)", async () => {
    const q = await quote({ scenario_amount: "205" });
    await deposit(q);
    const st = await settle(q);
    expect(st.swapDetails.amountOut).toBe("2000016");
    const tx = await chainTx("near:mainnet", st.swapDetails.destinationChainTxHashes[0]?.hash as string);
    expect(tx.transfers[0]?.amount).toBe("2000016");
  });

  it("06: paying the second attempt also settles the first (duplicate settlement)", async () => {
    const first = await quote({ scenario_amount: "206" });
    const second = await quote({ scenario_amount: "206" });
    const unrelated = await quote({ scenario_amount: "206", refundTo: "0x1111111111111111111111111111111111111111" });
    await deposit(second);
    const [a, b] = await Promise.all([settle(first), settle(second)]);
    expect([a.status, b.status]).toEqual(["SUCCESS", "SUCCESS"]);
    expect((await status(unrelated)).status).toBe("PENDING_DEPOSIT");
  });

  it("06: paying the first attempt does not settle a newer one", async () => {
    const first = await quote({ scenario_amount: "1206" });
    const second = await quote({ scenario_amount: "1206" });
    await deposit(first);
    expect((await settle(first)).status).toBe("SUCCESS");
    expect((await status(second)).status).toBe("PENDING_DEPOSIT");
  });

  it("07: SUCCESS 5 min (scaled) after the deadline", async () => {
    const q = await quote({ scenario_amount: "207" });
    const deadline = Date.now() + 300;
    await setDeadline(q, new Date(deadline));
    await deposit(q);
    const st = await settle(q);
    expect(st.status).toBe("SUCCESS");
    expect(Date.now()).toBeGreaterThanOrEqual(deadline + 3_000);
  });

  it("refunds a deposit made after the deadline", async () => {
    const q = await quote({ scenario_amount: "200" });
    await setDeadline(q, new Date(Date.now() - 1000));
    await deposit(q);
    const st = await settle(q);
    expect([st.status, st.swapDetails.refundReason]).toEqual(["REFUNDED", "DEPOSIT_AFTER_DEADLINE"]);
  });

  it("follows the deposit amount, not the scenario: an explicit low deposit is refunded", async () => {
    const q = await quote({ scenario_amount: "200" });
    await setDeadline(q, new Date(Date.now() + 300));
    expect(await deposit(q, "1")).toBe(202);
    expect((await settle(q)).status).toBe("REFUNDED");
  });

  it("refunds into an Intents account when refundType is INTENTS", async () => {
    const q = await quote({
      scenario_amount: "203",
      depositType: "INTENTS",
      originAsset: USDC_NEAR,
      refundType: "INTENTS",
      refundTo: "payer.near",
    });
    await deposit(q);
    const st = await settle(q);
    expect(st.swapDetails.nearTxHashes).toHaveLength(2); // settlement + excess refund, both on the Verifier
    const transfers = mtTransfers((await events()).map((e) => e.log)).filter((t) => t.new_owner_id === "payer.near");
    expect(transfers.at(-1)?.amounts).toEqual([st.swapDetails.refundedAmount]);
  });
});

describe("simulated deposits", () => {
  it("refuses a second deposit, unknown addresses and non-positive amounts", async () => {
    const q = await quote();
    expect(await deposit(q)).toBe(202);
    const again = await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    expect([again.status, ErrorEnvelope.parse(again.body).error.code]).toEqual([409, "state_conflict"]);
    const unknown = await s.call("POST", "/sim/deposits", {
      deposit_address: "0x76b4c56085ed136a8744d52be956396624a730e8",
    });
    expect(unknown.status).toBe(404);
    const zero = await s.call("POST", "/sim/deposits", { deposit_address: addr(await quote()), amount_in: "0" });
    expect(zero.status).toBe(400);
  });

  it("refuses deposits into a finished execution", async () => {
    const q = await quote();
    await s.call("POST", "/sim/advance", { deposit_address: addr(q), to: "fail" });
    const r = await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    expect(r.status).toBe(409);
  });

  it("answers 404 for unknown simulated transactions", async () => {
    const r = await s.call("GET", `/sim/chains/eip155:8453/tx/0x${"00".repeat(32)}`);
    expect(r.status).toBe(404);
  });
});

describe("manual control (/sim/advance)", () => {
  const advance = (q: Q, to: string) => s.call("POST", "/sim/advance", { deposit_address: addr(q), to });

  it("steps deposit → processing → success and stops the automatic timeline", async () => {
    const q = await quote({ scenario_amount: "201" });
    expect((await advance(q, "deposit")).status).toBe(202);
    expect((await status(q)).status).toBe("KNOWN_DEPOSIT_TX");
    await new Promise((r) => setTimeout(r, 200));
    expect((await status(q)).status).toBe("KNOWN_DEPOSIT_TX"); // no automatic progress in manual mode
    await advance(q, "processing");
    expect((await status(q)).status).toBe("PROCESSING");
    await advance(q, "success");
    const st = await status(q);
    expect(st.status).toBe("SUCCESS");
    expect(st.swapDetails.amountOut).toBe("2000017");
    const r = await advance(q, "refund");
    expect([r.status, ErrorEnvelope.parse(r.body).error.code]).toEqual([409, "state_conflict"]);
  });

  it("deposits implicitly when skipping ahead, and refunds the deposit", async () => {
    const q = await quote();
    await advance(q, "refund");
    const st = await status(q);
    expect(st.status).toBe("REFUNDED");
    expect(st.swapDetails).toMatchObject({
      refundReason: "MANUAL",
      refundedAmount: q.quote.amountIn,
      depositedAmount: q.quote.amountIn,
    });
  });

  it("takes over a running timeline", async () => {
    const q = await quote({ scenario_amount: "201" });
    await deposit(q);
    await advance(q, "fail");
    expect((await status(q)).status).toBe("FAILED");
  });

  it("refuses a second deposit step and unknown addresses", async () => {
    const q = await quote();
    await advance(q, "deposit");
    expect((await advance(q, "deposit")).status).toBe(409);
    const r = await s.call("POST", "/sim/advance", {
      deposit_address: "0x76b4c56085ed136a8744d52be956396624a730e8",
      to: "success",
    });
    expect(r.status).toBe(404);
  });

  it("records a deposit made in manual mode without restarting the timeline", async () => {
    const q = await quote();
    await advance(q, "fail");
    const q2 = await quote();
    await advance(q2, "processing");
    expect((await status(q2)).swapDetails.depositedAmount).toBe(q2.quote.amountIn);
  });
});
