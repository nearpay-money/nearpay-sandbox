/** The 1Click mirror over HTTP: quotes, signatures, status, deposits, auth and test-mode isolation. */
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { ErrorEnvelope } from "@nearpay/spec";
import { OneClickQuoteResponse, OneClickStatusResponse, OneClickToken } from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ETH_BASE, PAYER, quoteRequest, USDC_ARB, USDC_BASE, USDC_NEAR } from "../support/requests.js";
import { mintServiceToken, mintTestToken, type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const code = (b: unknown) => ErrorEnvelope.parse(b).error.code;

describe("auth and test-mode isolation", () => {
  it("needs a service token", async () => {
    const r = await s.call("GET", "/v0/tokens", undefined, "");
    expect([r.status, code(r.body)]).toEqual([401, "authentication_required"]);
  });

  it("needs the sandbox.use scope", async () => {
    const r = await s.call("GET", "/v0/tokens", undefined, await mintServiceToken("webhooks"));
    expect([r.status, code(r.body)]).toEqual([403, "permission_denied"]);
  });

  it("serves every caller the catalogue gives sandbox.use", async () => {
    for (const svc of ["payments", "rails", "agentpay", "sentinel"] as const) {
      const r = await s.call("GET", "/v0/tokens", undefined, await mintServiceToken(svc));
      expect(r.status, svc).toBe(200);
    }
  });

  it("refuses a live-mode principal (INV-8)", async () => {
    const live = await mintTestToken({ sub: "rails", ptype: "service", scp: ["sandbox.use"], lm: true });
    const r = await s.call("POST", "/v0/quote", quoteRequest(), live);
    expect([r.status, code(r.body)]).toEqual([403, "livemode_forbidden"]);
  });
});

describe("GET /v0/tokens", () => {
  it("lists the fixed registry in the 1Click shape", async () => {
    const r = await s.call("GET", "/v0/tokens");
    const tokens = (r.body as unknown[]).map((t) => OneClickToken.parse(t));
    expect(tokens.find((t) => t.assetId === USDC_NEAR)).toMatchObject({ symbol: "USDC", decimals: 6, price: 1 });
    expect(tokens.find((t) => t.assetId === ETH_BASE)).toMatchObject({ blockchain: "base", price: 2500 });
  });
});

describe("POST /v0/quote", () => {
  it("issues a signed quote that verifies with the 1Click SDK and the sandbox key", async () => {
    const r = await s.call("POST", "/v0/quote", quoteRequest());
    expect(r.status).toBe(200);
    const q = OneClickQuoteResponse.parse(r.body);
    expect(verifyQuoteSignature(q as never, s.managerPublicKey)).toBe(true);
    expect(
      verifyQuoteSignature(
        { ...q, quoteRequest: { ...q.quoteRequest, recipient: "evil.near" } } as never,
        s.managerPublicKey,
      ),
    ).toBe(false);
    // The real 1Click key must not accept sandbox quotes.
    expect(verifyQuoteSignature(q as never)).toBe(false);
    expect(q.quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(q.quote).toMatchObject({ amountOut: "2000017", minAmountOut: "2000017", amountIn: "2014018" });
    expect(q.quote.deadline).toBe(q.quoteRequest.deadline);
    expect(q.quoteRequest).not.toHaveProperty("scenario_amount");
  });

  it("issues a distinct deposit address per quote", async () => {
    const a = OneClickQuoteResponse.parse((await s.call("POST", "/v0/quote", quoteRequest())).body);
    const b = OneClickQuoteResponse.parse((await s.call("POST", "/v0/quote", quoteRequest())).body);
    expect(a.quote.depositAddress).not.toBe(b.quote.depositAddress);
  });

  it("answers a dry quote without a deposit address and stores nothing", async () => {
    const r = await s.call("POST", "/v0/quote", quoteRequest({ dry: true }));
    const q = OneClickQuoteResponse.parse(r.body);
    expect(q.quote.depositAddress).toBeUndefined();
    expect(verifyQuoteSignature(q as never, s.managerPublicKey)).toBe(true);
  });

  it("issues memos in MEMO mode and Intents deposit accounts for INTENTS deposits", async () => {
    const m = OneClickQuoteResponse.parse(
      (await s.call("POST", "/v0/quote", quoteRequest({ depositMode: "MEMO" }))).body,
    );
    expect(m.quote.depositMemo).toMatch(/^\d{10}$/);
    const i = OneClickQuoteResponse.parse(
      (
        await s.call(
          "POST",
          "/v0/quote",
          quoteRequest({
            depositType: "INTENTS",
            originAsset: USDC_NEAR,
            refundType: "INTENTS",
            refundTo: "payer.near",
          }),
        )
      ).body,
    );
    expect(i.quote.depositAddress).toMatch(/^sbx-[0-9a-f]{40}\.near$/);
  });

  it("reports a withdraw fee for chain destinations only", async () => {
    const chain = OneClickQuoteResponse.parse(
      (
        await s.call(
          "POST",
          "/v0/quote",
          quoteRequest({ destinationAsset: USDC_ARB, recipientType: "DESTINATION_CHAIN", recipient: PAYER }),
        )
      ).body,
    );
    expect(chain.quote.withdrawFee).toBe("20000");
    const intents = OneClickQuoteResponse.parse((await s.call("POST", "/v0/quote", quoteRequest())).body);
    expect(intents.quote.withdrawFee).toBe("0");
  });

  it.each([
    [{ originAsset: "nep141:unknown.near" }, "originAsset"],
    [{ destinationAsset: "nep141:unknown.near" }, "destinationAsset"],
    [{ swapType: "FLEX_INPUT" as const }, "swapType"],
    [{ recipient: "not an account" }, "recipient"],
    [
      { recipientType: "DESTINATION_CHAIN" as const, recipient: "merchant.near", destinationAsset: USDC_BASE },
      "recipient",
    ],
    [{ refundTo: "0x123" }, "refundTo"],
    [{ deadline: new Date(Date.now() + 10_000).toISOString() }, "deadline"],
    [{ deadline: "tomorrow" }, "deadline"],
    [{ amount: "0" }, "amount"],
    [{ appFees: [{ recipient: "Bad Account", fee: 10 }] }, "appFees"],
    [{ appFees: [{ recipient: "treasury.nearpay.near", fee: 501 }] }, "appFees"],
  ])("rejects %o (param %s)", async (over, param) => {
    const r = await s.call("POST", "/v0/quote", quoteRequest(over as never));
    expect(r.status).toBe(400);
    expect(ErrorEnvelope.parse(r.body).error).toMatchObject({ code: "invalid_request", param });
  });
});

describe("GET /v0/status and POST /v0/deposit/submit", () => {
  it("answers 404 for an unknown deposit address", async () => {
    const r = await s.call("GET", "/v0/status?depositAddress=0x76b4c56085ed136a8744d52be956396624a730e8");
    expect([r.status, code(r.body)]).toEqual([404, "resource_missing"]);
  });

  it("reports PENDING_DEPOSIT, then the deposit submitted by the payer's wallet, idempotently", async () => {
    const q = OneClickQuoteResponse.parse(
      (await s.call("POST", "/v0/quote", quoteRequest({ scenario_amount: "201" }))).body,
    );
    const address = q.quote.depositAddress as string;
    const pending = OneClickStatusResponse.parse((await s.call("GET", `/v0/status?depositAddress=${address}`)).body);
    expect(pending.status).toBe("PENDING_DEPOSIT");
    expect(pending.quoteResponse.signature).toBe(q.signature);
    const tx = `0x${"ab".repeat(32)}`;
    const first = await s.call("POST", "/v0/deposit/submit", { txHash: tx, depositAddress: address });
    const again = await s.call("POST", "/v0/deposit/submit", { txHash: tx, depositAddress: address });
    const st = OneClickStatusResponse.parse(again.body);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(st.swapDetails.originChainTxHashes).toEqual([{ hash: tx, explorerUrl: `https://basescan.org/tx/${tx}` }]);
    expect(st.swapDetails.depositedAmount).toBe(q.quote.amountIn);
  });

  it("answers 404 for a deposit to an unknown address", async () => {
    const r = await s.call("POST", "/v0/deposit/submit", {
      txHash: `0x${"cd".repeat(32)}`,
      depositAddress: "0x76b4c56085ed136a8744d52be956396624a730e8",
    });
    expect(r.status).toBe(404);
  });
});
