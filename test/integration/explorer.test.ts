/** Explorer mirror `GET /api/v0/transactions` (sandbox LLD §3, rails §8.5 test mode) over HTTP on real Postgres. */

import { sql } from "@nearpay-internal/db";
import { ExplorerTransactionList, OneClickQuoteResponse } from "@nearpay-internal/spec";
import { ErrorEnvelope } from "@nearpay-money/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quoteRequest } from "../support/requests.js";
import { mintServiceToken, mintTestToken, type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ timeScale: 0.01, tickMs: 20 });
});
afterAll(async () => {
  await s?.stop();
});

type Q = ReturnType<typeof OneClickQuoteResponse.parse>;
let n = 0;
const referral = () => `exp-${Date.now().toString(36)}-${n++}`;
async function quote(ref: string, over: Parameters<typeof quoteRequest>[0] = {}): Promise<Q> {
  const r = await s.call("POST", "/v0/quote", quoteRequest({ referral: ref, ...over }));
  expect(r.status).toBe(200);
  return OneClickQuoteResponse.parse(r.body);
}
const addr = (q: Q) => q.quote.depositAddress as string;
async function list(query: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const r = await s.call("GET", `/api/v0/transactions?${qs}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return ExplorerTransactionList.parse(r.body);
}
const setCreated = (q: Q, at: string) =>
  sql`update sim_quotes set created_at = ${at} where deposit_address = ${addr(q)}`.execute(s.database.db);
async function waitState(q: Q, state: string) {
  for (let i = 0; i < 400; i++) {
    const r = await sql<{
      state: string;
    }>`select state from sim_quotes where deposit_address = ${addr(q)}`.execute(s.database.db);
    if (r.rows[0]?.state === state) return;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error(`never reached ${state}`);
}

describe("auth", () => {
  it("needs a sandbox.use service token in test mode", async () => {
    expect((await s.call("GET", "/api/v0/transactions", undefined, "")).status).toBe(401);
    expect((await s.call("GET", "/api/v0/transactions", undefined, await mintServiceToken("webhooks"))).status).toBe(
      403,
    );
    const live = await mintTestToken({ sub: "rails", ptype: "service", scp: ["sandbox.use"], lm: true });
    const r = await s.call("GET", "/api/v0/transactions", undefined, live);
    expect([r.status, ErrorEnvelope.parse(r.body).error.code]).toEqual([403, "livemode_forbidden"]);
  });

  it("validates the query like the spec (numberOfTransactions ≤ 1000, statuses format)", async () => {
    expect((await s.call("GET", "/api/v0/transactions?numberOfTransactions=1001")).status).toBe(400);
    expect((await s.call("GET", "/api/v0/transactions?statuses=success")).status).toBe(400);
  });
});

describe("rows and statuses", () => {
  it("hides *_DEPOSIT rows by default and shows them when asked, newest first", async () => {
    const ref = referral();
    const a = await quote(ref);
    const b = await quote(ref);
    expect(await list({ referral: ref })).toEqual([]);
    const rows = await list({ referral: ref, statuses: "PENDING_DEPOSIT" });
    expect(rows.map((r) => r.depositAddress)).toEqual([addr(b), addr(a)]);
    expect(rows[0]).toMatchObject({
      status: "PENDING_DEPOSIT",
      referral: ref,
      amountIn: "0",
      amountOut: "0",
      recipient: "merchant.near",
      depositType: "ORIGIN_CHAIN",
      recipientType: "INTENTS",
      refundType: "ORIGIN_CHAIN",
      appFees: [
        { recipient: "treasury.nearpay.near", fee: 25 },
        { recipient: "sandbox-oneclick-fees.near", fee: 25 },
      ],
    });
  });

  it("shows a known deposit as PROCESSING and a settled one with its amounts", async () => {
    const ref = referral();
    const manual = await quote(ref);
    await s.call("POST", "/sim/advance", { deposit_address: addr(manual), to: "deposit" });
    const [row] = await list({ referral: ref, statuses: "PROCESSING" });
    expect([row?.depositAddress, row?.status, row?.amountIn]).toEqual([addr(manual), "PROCESSING", "0"]);

    const paid = await quote(ref, { scenario_amount: "200" });
    await s.call("POST", "/sim/deposits", { deposit_address: addr(paid) });
    await waitState(paid, "SUCCESS");
    const [done] = await list({ referral: ref, statuses: "SUCCESS" });
    expect(done).toMatchObject({
      depositAddress: addr(paid),
      status: "SUCCESS",
      amountIn: paid.quote.amountIn,
      amountOut: "2000017",
      amountOutFormatted: "2.000017",
    });
    expect(done?.originChainTxHashes).toHaveLength(1);
    expect(done?.nearTxHashes).toEqual(done?.destinationChainTxHashes);
    // default statuses include both now
    expect((await list({ referral: ref })).map((r) => r.status)).toEqual(["SUCCESS", "PROCESSING"]);
  });

  it("shows refunds with their reason", async () => {
    const ref = referral();
    const q = await quote(ref);
    await s.call("POST", "/sim/advance", { deposit_address: addr(q), to: "refund" });
    const [row] = await list({ referral: ref, statuses: "REFUNDED,FAILED" });
    expect(row).toMatchObject({
      status: "REFUNDED",
      refundReason: "MANUAL",
      amountIn: q.quote.amountIn,
      amountOut: "0",
    });
    expect(await list({ referral: ref, statuses: "FAILED" })).toEqual([]);
  });
});

describe("filters and paging", () => {
  it("pages older rows with the lastDepositAddress cursor and newer rows with direction=prev", async () => {
    const ref = referral();
    const qs: Q[] = [];
    for (let i = 0; i < 5; i++) qs.push(await quote(ref));
    const newestFirst = qs.map(addr).reverse();
    const base = { referral: ref, statuses: "PENDING_DEPOSIT", numberOfTransactions: 2 };
    const p1 = await list(base);
    const p2 = await list({ ...base, lastDepositAddress: p1[1]?.depositAddress as string });
    const p3 = await list({ ...base, lastDepositAddress: p2[1]?.depositAddress as string });
    expect([...p1, ...p2, ...p3].map((r) => r.depositAddress)).toEqual(newestFirst);
    const back = await list({ ...base, lastDepositAddress: newestFirst[4] as string, direction: "prev" });
    expect(back.map((r) => r.depositAddress)).toEqual([newestFirst[2], newestFirst[3]]);
    // prev without a cursor starts at the newest, like next
    expect((await list({ ...base, direction: "prev" })).map((r) => r.depositAddress)).toEqual(newestFirst.slice(0, 2));
    // an unknown cursor ends the paging
    expect(await list({ ...base, lastDepositAddress: "0x76b4c56085ed136a8744d52be956396624a730e8" })).toEqual([]);
  });

  it("pages by address and memo for MEMO-mode quotes, and filters by depositMemo", async () => {
    const ref = referral();
    const a = await quote(ref, { depositMode: "MEMO" });
    const b = await quote(ref, { depositMode: "MEMO" });
    const base = { referral: ref, statuses: "PENDING_DEPOSIT" };
    const older = await list({
      ...base,
      lastDepositAddress: addr(b),
      lastDepositMemo: b.quote.depositMemo as string,
    });
    expect(older.map((r) => r.depositAddress)).toEqual([addr(a)]);
    const memo = await list({ ...base, depositMemo: a.quote.depositMemo as string });
    expect(memo.map((r) => [r.depositAddress, r.depositMemo])).toEqual([[addr(a), a.quote.depositMemo]]);
  });

  it("bounds creation time exclusively on both ends", async () => {
    const ref = referral();
    const [a, b, c] = [await quote(ref), await quote(ref), await quote(ref)];
    await setCreated(a, "2026-01-01T00:00:00Z");
    await setCreated(b, "2026-01-01T00:01:00Z");
    await setCreated(c, "2026-01-01T00:02:00Z");
    const rows = await list({
      referral: ref,
      statuses: "PENDING_DEPOSIT",
      startTimestamp: "2026-01-01T00:00:00Z",
      endTimestamp: "2026-01-01T00:02:00Z",
    });
    expect(rows.map((r) => r.depositAddress)).toEqual([addr(b)]);
    expect(rows[0]?.createdAtTimestamp).toBe(Date.parse("2026-01-01T00:01:00Z") / 1000);
  });

  it("searches by deposit address, recipient, refund address or transaction hash", async () => {
    const ref = referral();
    const payer = "0x3333333333333333333333333333333333333333";
    const q = await quote(ref, { refundTo: payer });
    await quote(ref);
    const base = { referral: ref, statuses: "PENDING_DEPOSIT,PROCESSING,SUCCESS" };
    expect((await list({ ...base, search: addr(q) })).map((r) => r.depositAddress)).toEqual([addr(q)]);
    expect((await list({ ...base, search: payer })).map((r) => r.depositAddress)).toEqual([addr(q)]);
    expect(await list({ ...base, search: "merchant.near" })).toHaveLength(2);
    const tx = `0x${"ef".repeat(32)}`;
    await s.call("POST", "/v0/deposit/submit", { txHash: tx, depositAddress: addr(q) });
    expect((await list({ ...base, search: tx })).map((r) => r.depositAddress)).toEqual([addr(q)]);
  });

  it("caps the page at numberOfTransactions (default 50) and ignores showTestTxs", async () => {
    const ref = referral();
    for (let i = 0; i < 3; i++) await quote(ref);
    expect(await list({ referral: ref, statuses: "PENDING_DEPOSIT", numberOfTransactions: 1 })).toHaveLength(1);
    expect(await list({ referral: ref, statuses: "PENDING_DEPOSIT", showTestTxs: "true" })).toHaveLength(3);
    expect(await list({ referral: ref, statuses: "BOGUS" })).toEqual([]);
  });
});
