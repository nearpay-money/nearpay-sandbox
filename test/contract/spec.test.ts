/** Contract: every sandbox route of the spec is served, and sandbox quotes have 1Click's exact shape. */
import { readFileSync } from "node:fs";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  INTERNAL_ROUTES,
  OneClickQuoteResponse,
  OneClickStatusResponse,
  SandboxQuoteRequest,
} from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxRoutes } from "../../src/api/routes.js";
import { quoteRequest } from "../support/requests.js";
import { type Stack, startStack } from "../support/stack.js";

const realDryQuote = JSON.parse(readFileSync(new URL("../fixtures/oneclick-dry-quote.json", import.meta.url), "utf8"));

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

describe("route coverage", () => {
  it("binds every Stage-1 sandbox route of @nearpay-internal/spec", () => {
    const bindings = sandboxRoutes({} as never);
    expect(unimplementedRoutes("sandbox", INTERNAL_ROUTES, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings).toHaveLength(INTERNAL_ROUTES.filter((r) => r.service === "sandbox").length);
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
