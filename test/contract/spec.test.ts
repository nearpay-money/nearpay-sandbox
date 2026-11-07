/** Contract: every sandbox route of the spec is served, and sandbox quotes have 1Click's exact shape. */
import { readFileSync } from "node:fs";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  ExplorerTransactionList,
  INTERNAL_ROUTES,
  OneClickQuoteResponse,
  OneClickStatusResponse,
  SandboxQuoteRequest,
} from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxRoutes } from "../../src/api/routes.js";
import { quoteRequest, USDC_NEAR } from "../support/requests.js";
import { type Stack, startStack } from "../support/stack.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const realDryQuote = fixture("oneclick-dry-quote.json");
/** Live mainnet `GET /v0/status` body, PENDING_DEPOSIT (2026-11-07; the spec's fixture, unmodified). */
const realPendingStatus = fixture("oneclick-status-pending-live.json");

/** Key → JSON kind (`null` distinct from objects), the shape a parser sees. */
const kinds = (o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, v === null ? "null" : Array.isArray(v) ? "array" : typeof v]),
  );

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

describe("route coverage", () => {
  it("binds every sandbox route of @nearpay-internal/spec (Stage 1 and Stage 2)", () => {
    const bindings = sandboxRoutes({} as never);
    expect(unimplementedRoutes("sandbox", INTERNAL_ROUTES, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings).toHaveLength(INTERNAL_ROUTES.filter((r) => r.service === "sandbox").length);
    expect(bindings.map((b) => b.route.id)).toEqual(
      expect.arrayContaining(["sandboxSimulateIntentsTransfer", "sandboxExplorerTransactions"]),
    );
  });
});

describe("1Click parity", () => {
  it("the recorded mainnet dry quote parses with the shared schema and verifies with the 1Click key", () => {
    const q = OneClickQuoteResponse.parse(realDryQuote);
    expect(verifyQuoteSignature(q as never)).toBe(true);
  });

  it("a sandbox quote has every field a real 1Click quote has (same keys, same types)", async () => {
    const r = await s.call("POST", "/v0/quote", quoteRequest({ dry: true }));
    const sandbox = OneClickQuoteResponse.parse(r.body);
    const typeMap = (o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? "array" : typeof v]));
    expect(Object.keys(sandbox).sort()).toEqual(Object.keys(realDryQuote).sort());
    expect(typeMap(sandbox.quote)).toEqual(typeMap(realDryQuote.quote));
    for (const k of Object.keys(realDryQuote.quoteRequest).filter(
      (k) => !["confidentiality", "insured", "depositMode"].includes(k),
    ))
      expect(sandbox.quoteRequest, k).toHaveProperty(k);
  });

  it("accepts a plain 1Click request (scenario_amount is optional)", () => {
    const { scenario_amount: _omit, ...plain } = quoteRequest();
    expect(SandboxQuoteRequest.safeParse(plain).success).toBe(true);
  });

  it("a sandbox status is a valid 1Click status", async () => {
    const q = OneClickQuoteResponse.parse((await s.call("POST", "/v0/quote", quoteRequest())).body);
    const st = await s.call("GET", `/v0/status?depositAddress=${q.quote.depositAddress}`);
    expect(OneClickStatusResponse.safeParse(st.body).success).toBe(true);
  });
});

describe("live 1Click shape (spec 0.2.0)", () => {
  it("the recorded mainnet status body parses unmodified with the shared schema", () => {
    expect(OneClickStatusResponse.safeParse(realPendingStatus).success).toBe(true);
  });

  it("a pending sandbox status has the live body's keys with the same null-ness", async () => {
    const q = OneClickQuoteResponse.parse(
      (
        await s.call(
          "POST",
          "/v0/quote",
          quoteRequest({ appFees: [{ recipient: "treasury.nearpay.near", fee: 20 }], slippageTolerance: 30 }),
        )
      ).body,
    );
    const st = (await s.call("GET", `/v0/status?depositAddress=${q.quote.depositAddress}`)).body as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(st).sort()).toEqual(Object.keys(realPendingStatus).sort());
    expect(kinds(st.swapDetails as Record<string, unknown>)).toEqual(kinds(realPendingStatus.swapDetails));
    const qr = st.quoteResponse as Record<string, Record<string, unknown>>;
    expect(qr).not.toHaveProperty("correlationId");
    expect(Object.keys(qr).sort()).toEqual(Object.keys(realPendingStatus.quoteResponse).sort());
    expect(kinds(qr.quote as Record<string, unknown>)).toEqual(kinds(realPendingStatus.quoteResponse.quote));
    // Every field of the live echo is echoed the same way (null stays null); the live one omits quoteWaitingTimeMs.
    expect(kinds(qr.quoteRequest as Record<string, unknown>)).toEqual(
      kinds(realPendingStatus.quoteResponse.quoteRequest),
    );
    expect((qr.quoteRequest as { appFees: unknown[] }).appFees).toEqual([
      { limitOrderId: null, recipient: "treasury.nearpay.near", fee: 10 },
      { limitOrderId: null, recipient: "sandbox-oneclick-fees.near", fee: 10 },
    ]);
  });

  it("the quote response echoes the live request defaults and still verifies", async () => {
    const r = await s.call("POST", "/v0/quote", quoteRequest());
    const q = OneClickQuoteResponse.parse(r.body);
    expect(q.quoteRequest).toMatchObject({
      virtualChainRecipient: null,
      virtualChainRefundRecipient: null,
      confidentiality: "public",
    });
    expect(verifyQuoteSignature(q as never, s.managerPublicKey)).toBe(true);
  });
});

describe("Stage 2 routes", () => {
  it("the Explorer mirror answers a valid ExplorerTransactionList", async () => {
    await s.call("POST", "/v0/quote", quoteRequest());
    const r = await s.call("GET", "/api/v0/transactions?statuses=PENDING_DEPOSIT&numberOfTransactions=5");
    expect(r.status).toBe(200);
    const rows = ExplorerTransactionList.parse(r.body);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("the simulated transfer answers a SimTransferResult", async () => {
    const r = await s.call("POST", "/sim/intents/transfers", {
      from: "merchant-contract.near",
      to: "payer-contract.near",
      token: USDC_NEAR,
      amount: "5",
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ tx_hash: expect.any(String), block_height: expect.any(Number) });
  });
});
