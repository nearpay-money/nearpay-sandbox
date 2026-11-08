/**
 * Solana and Bitcoin simulation end to end (sandbox LLD §10, spec 0.4.0 `SimTx`): deposits, payouts and refunds on
 * both chains carry their chain fields, scenario `08` holds the destination transaction not final for 60 s (Bitcoin:
 * 0 confirmations), scenario `09` records a failed Solana signature before the payout and splits a Bitcoin payout over
 * two outputs. Time scale 0.01.
 */
import { sql } from "@nearpay-internal/db";
import { OneClickQuoteResponse, OneClickStatusResponse } from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { associatedTokenAccount, solverAddress } from "../../src/simulated-chains/addresses.js";
import { SimTx } from "../../src/spec-0.4-gap.js";
import { quoteRequest, USDC_BASE } from "../support/requests.js";
import { type Stack, startStack } from "../support/stack.js";

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BITCOIN = "bip122:000000000019d6689c085ae165831e93";
const SOL_USDC = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const SOL_USDT = "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near";
const SOL = "nep141:sol.omft.near";
const BTC = "nep141:btc.omft.near";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
/** Chain-vector test wallet and its USDC token account (solana-transfer.json). */
const SOL_WALLET = "EyjEeiTxb4rvkoN3ZA2zTimuc6VyF8V1QuH9TT66Gkn6";
const SOL_WALLET_USDC_ATA = "DN5C7q7RzxDXor5jNHDBxfHU5yp3M58XJXcWR4WvvyAp";
const BTC_DEST = "bc1qpct5sxzppv204tth290uen85nqkhzw9sq5m0ku";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ timeScale: 0.01, tickMs: 20 });
});
afterAll(async () => {
  await s?.stop();
});

type Q = ReturnType<typeof OneClickQuoteResponse.parse>;
async function quote(over: Parameters<typeof quoteRequest>[0]): Promise<Q> {
  const r = await s.call("POST", "/v0/quote", quoteRequest(over));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return OneClickQuoteResponse.parse(r.body);
}
const addr = (q: Q) => q.quote.depositAddress as string;
async function settle(q: Q) {
  const until = Date.now() + 10_000;
  for (;;) {
    const [row] = (
      await sql<{ state: string }>`select state from sim_quotes where deposit_address = ${addr(q)}`.execute(
        s.database.db,
      )
    ).rows;
    if (row && ["SUCCESS", "REFUNDED", "FAILED"].includes(row.state))
      return OneClickStatusResponse.parse((await s.call("GET", `/v0/status?depositAddress=${addr(q)}`)).body);
    if (Date.now() > until) throw new Error(`timeout, state ${row?.state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function chainTx(chain: string, hash: string) {
  const r = await s.call("GET", `/sim/chains/${encodeURIComponent(chain)}/tx/${hash}`);
  expect(r.status).toBe(200);
  return SimTx.parse(r.body);
}
const payTo = (destinationAsset: string, recipient: string, scenario: string) =>
  quote({ destinationAsset, recipient, recipientType: "DESTINATION_CHAIN", scenario_amount: `2${scenario}` });

describe("Solana", () => {
  it("SPL payout: slot, the recipient's associated token account, final after the usual delay", async () => {
    const q = await payTo(SOL_USDC, SOL_WALLET, "00");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const st = await settle(q);
    expect(st.status).toBe("SUCCESS");
    expect(st.swapDetails.destinationChainTxHashes).toHaveLength(1);
    const hash = st.swapDetails.destinationChainTxHashes[0]?.hash as string;
    await new Promise((r) => setTimeout(r, 100));
    const tx = await chainTx(SOLANA, hash);
    expect(tx.finalized).toBe(true);
    expect(BigInt(tx.block_ref as string)).toBeGreaterThan(380_000_000n);
    expect(tx.confirmations).toBeUndefined();
    expect(tx.failed).toBeUndefined();
    expect(tx.transfers).toEqual([
      {
        token: SOL_USDC,
        from: solverAddress(SOLANA),
        to: SOL_WALLET,
        amount: "2000017",
        token_account: SOL_WALLET_USDC_ATA,
      },
    ]);
  });

  it("USDT (new in the registry) and native SOL payouts", async () => {
    const usdt = await payTo(SOL_USDT, SOL_WALLET, "00");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(usdt) });
    const u = await chainTx(SOLANA, (await settle(usdt)).swapDetails.destinationChainTxHashes[0]?.hash as string);
    expect(u.transfers[0]?.token_account).toBe(associatedTokenAccount(SOL_WALLET, USDT_MINT));
    const sol = await payTo(SOL, SOL_WALLET, "00");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(sol) });
    const n = await chainTx(SOLANA, (await settle(sol)).swapDetails.destinationChainTxHashes[0]?.hash as string);
    expect(n.transfers[0]?.token_account).toBeNull();
  });

  it("SPL deposit into a Solana deposit address names the deposit address's token account", async () => {
    const q = await quote({
      originAsset: SOL_USDC,
      refundTo: SOL_WALLET,
      refundType: "ORIGIN_CHAIN",
      scenario_amount: "200",
    });
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const st = await settle(q);
    const dep = await chainTx(SOLANA, st.swapDetails.originChainTxHashes[0]?.hash as string);
    expect(dep.transfers[0]).toMatchObject({
      from: SOL_WALLET,
      to: addr(q),
      token_account: associatedTokenAccount(addr(q), USDC_MINT),
    });
    expect(dep.block_ref).toBeDefined();
  });

  it("09: a failed signature precedes the real payout", async () => {
    const q = await payTo(SOL_USDC, SOL_WALLET, "09");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const hashes = (await settle(q)).swapDetails.destinationChainTxHashes.map((h) => h.hash);
    expect(hashes).toHaveLength(2);
    const failed = await chainTx(SOLANA, hashes[0] as string);
    expect(failed).toMatchObject({ failed: true, transfers: [] });
    const real = await chainTx(SOLANA, hashes[1] as string);
    expect(real.failed).toBeUndefined();
    expect(real.transfers).toEqual([
      {
        token: SOL_USDC,
        from: solverAddress(SOLANA),
        to: SOL_WALLET,
        amount: "2000017",
        token_account: SOL_WALLET_USDC_ATA,
      },
    ]);
    expect(BigInt(real.block_ref as string)).toBeGreaterThan(BigInt(failed.block_ref as string));
  });

  it("08: the destination transaction is not final for 60 s (× time scale)", async () => {
    const q = await payTo(SOL_USDC, SOL_WALLET, "08");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const hash = (await settle(q)).swapDetails.destinationChainTxHashes[0]?.hash as string;
    expect((await chainTx(SOLANA, hash)).finalized).toBe(false);
    await new Promise((r) => setTimeout(r, 700));
    expect((await chainTx(SOLANA, hash)).finalized).toBe(true);
  });
});

describe("Bitcoin", () => {
  it("payout: height, vout 0, confirmations growing from 1 every 30 s (× time scale) up to 6", async () => {
    const q = await payTo(BTC, BTC_DEST, "00");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const hash = (await settle(q)).swapDetails.destinationChainTxHashes[0]?.hash as string;
    const tx = await chainTx(BITCOIN, hash);
    expect(tx.finalized).toBe(true);
    expect(tx.confirmations).toBeGreaterThanOrEqual(1);
    expect(BigInt(tx.block_ref as string)).toBeGreaterThan(900_000n);
    expect(tx.transfers).toEqual([
      { token: BTC, from: solverAddress(BITCOIN), to: BTC_DEST, amount: "2000017", vout: 0 },
    ]);
    await new Promise((r) => setTimeout(r, 2_000));
    expect((await chainTx(BITCOIN, hash)).confirmations).toBe(6);
  });

  it("deposit and refund (scenario 02) on Bitcoin carry vout and confirmations", async () => {
    const q = await quote({ originAsset: BTC, refundTo: BTC_DEST, refundType: "ORIGIN_CHAIN", scenario_amount: "202" });
    await sql`update sim_quotes set deadline = now() + interval '200 milliseconds' where deposit_address = ${addr(q)}`.execute(
      s.database.db,
    );
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const st = await settle(q);
    expect(st.status).toBe("REFUNDED");
    const dep = await chainTx(BITCOIN, st.swapDetails.originChainTxHashes[0]?.hash as string);
    expect(dep.transfers[0]).toMatchObject({ from: BTC_DEST, to: addr(q), vout: 0 });
    expect(dep.confirmations).toBeGreaterThanOrEqual(1);
    const refundHash = (
      await sql<{
        h: string[];
      }>`select refund_tx_hashes as h from sim_quotes where deposit_address = ${addr(q)}`.execute(s.database.db)
    ).rows[0]?.h[0] as string;
    const refund = await chainTx(BITCOIN, refundHash);
    expect(refund.transfers).toEqual([
      { token: BTC, from: solverAddress(BITCOIN), to: BTC_DEST, amount: dep.transfers[0]?.amount, vout: 0 },
    ]);
  });

  it("08: 0 confirmations (not final) for 60 s, then 1, then 2 after another 30 s", async () => {
    const q = await payTo(BTC, BTC_DEST, "08");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const hash = (await settle(q)).swapDetails.destinationChainTxHashes[0]?.hash as string;
    const t0 = await chainTx(BITCOIN, hash);
    expect([t0.finalized, t0.confirmations]).toEqual([false, 0]);
    await new Promise((r) => setTimeout(r, 650));
    const t1 = await chainTx(BITCOIN, hash);
    expect(t1.finalized).toBe(true);
    expect(t1.confirmations).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 350));
    expect((await chainTx(BITCOIN, hash)).confirmations).toBeGreaterThanOrEqual(2);
  });

  it("09: the payout pays the destination in two outputs (vout 0 and 2) around the solver's change (vout 1)", async () => {
    const q = await payTo(BTC, BTC_DEST, "09");
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const st = await settle(q);
    expect(st.swapDetails.destinationChainTxHashes).toHaveLength(1);
    const tx = await chainTx(BITCOIN, st.swapDetails.destinationChainTxHashes[0]?.hash as string);
    const solver = solverAddress(BITCOIN);
    expect(tx.transfers).toEqual([
      { token: BTC, from: solver, to: BTC_DEST, amount: "1000008", vout: 0 },
      { token: BTC, from: solver, to: solver, amount: "10000", vout: 1 },
      { token: BTC, from: solver, to: BTC_DEST, amount: "1000009", vout: 2 },
    ]);
    const toDest = tx.transfers.filter((t) => t.to === BTC_DEST).reduce((a, t) => a + BigInt(t.amount), 0n);
    expect(toDest.toString()).toBe(st.swapDetails.amountOut);
  });
});

describe("other chains are unchanged", () => {
  it("09 on an EVM chain behaves like 00 and gets no chain fields", async () => {
    const q = await quote({
      destinationAsset: USDC_BASE,
      recipient: "0x52908400098527886e0f7030069857d2e4169ee7",
      recipientType: "DESTINATION_CHAIN",
      originAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
      scenario_amount: "209",
    });
    await s.call("POST", "/sim/deposits", { deposit_address: addr(q) });
    const st = await settle(q);
    expect(st.swapDetails.destinationChainTxHashes).toHaveLength(1);
    const tx = await chainTx("eip155:8453", st.swapDetails.destinationChainTxHashes[0]?.hash as string);
    expect(Object.keys(tx).sort()).toEqual(["finalized", "transfers"]);
    expect(Object.keys(tx.transfers[0] ?? {}).sort()).toEqual(["amount", "from", "to", "token"]);
  });
});
