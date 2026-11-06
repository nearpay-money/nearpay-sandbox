import { describe, expect, it } from "vitest";
import { formatted, QuoteMathError, quoteAmounts, scenarioDeposit, usdValue } from "../../src/domain/quote-math.js";
import { SANDBOX_TOKENS, type SandboxToken, tokenById } from "../../src/domain/tokens.js";

const tok = (id: string) => tokenById(id) as SandboxToken;
const USDC_BASE = tok("nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near");
const USDC_NEAR = tok("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
const ETH_BASE = tok("nep141:base.omft.near");
const WNEAR = tok("nep141:wrap.near");

describe("quoteAmounts EXACT_OUTPUT", () => {
  it("adds app fees and the 20 bps route cost on a same-price pair, rounding the input up", () => {
    const q = quoteAmounts({
      swapType: "EXACT_OUTPUT",
      amount: 2_000_017n,
      origin: USDC_BASE,
      destination: USDC_NEAR,
      appFeeBps: 50n,
      slippageBps: 50n,
    });
    // 2_000_017 × 1.007 = 2_014_017.119 → ceil
    expect(q).toEqual({
      amountIn: 2_014_018n,
      minAmountIn: 2_003_947n,
      amountOut: 2_000_017n,
      minAmountOut: 2_000_017n,
    });
  });

  it("converts across decimals and prices exactly (ETH 2500 USD → 2 USDC)", () => {
    const q = quoteAmounts({
      swapType: "EXACT_OUTPUT",
      amount: 2_000_000n,
      origin: ETH_BASE,
      destination: USDC_NEAR,
      appFeeBps: 0n,
      slippageBps: 100n,
    });
    // 2 USD / 2500 = 0.0008 ETH = 8e14 wei, × 1.002 = 801_600_000_000_000
    expect(q.amountIn).toBe(801_600_000_000_000n);
    expect(q.minAmountIn).toBe(793_584_000_000_000n);
  });

  it("rounds a 24-decimal token up to the next base unit", () => {
    const q = quoteAmounts({
      swapType: "EXACT_OUTPUT",
      amount: 1n,
      origin: WNEAR,
      destination: USDC_NEAR,
      appFeeBps: 0n,
      slippageBps: 0n,
    });
    // 1e-6 USD / 4 USD × 1e24 × 1.002 = 250_500_000_000_000_000 exactly
    expect(q.amountIn).toBe(250_500_000_000_000_000n);
  });
});

describe("quoteAmounts EXACT_INPUT", () => {
  it("deducts fees and rounds the output down", () => {
    const q = quoteAmounts({
      swapType: "EXACT_INPUT",
      amount: 1_000_001n,
      origin: USDC_NEAR,
      destination: USDC_BASE,
      appFeeBps: 0n,
      slippageBps: 30n,
    });
    // 1_000_001 × 0.998 = 998_000.998 → 998_000; × 0.997 = 995_006
    expect(q).toEqual({ amountIn: 1_000_001n, minAmountIn: 1_000_001n, amountOut: 998_000n, minAmountOut: 995_006n });
  });
});

describe("quoteAmounts validation", () => {
  const base = {
    swapType: "EXACT_OUTPUT" as const,
    amount: 1n,
    origin: USDC_BASE,
    destination: USDC_NEAR,
    appFeeBps: 0n,
    slippageBps: 0n,
  };
  it.each([
    [{ amount: 0n }, /positive/],
    [{ appFeeBps: 501n }, /appFees/],
    [{ appFeeBps: -1n }, /appFees/],
    [{ slippageBps: 10_001n }, /slippage/],
    [{ slippageBps: -1n }, /slippage/],
  ])("rejects %o", (over, msg) => {
    expect(() => quoteAmounts({ ...base, ...over })).toThrow(msg);
    expect(() => quoteAmounts({ ...base, ...over })).toThrow(QuoteMathError);
  });

  it("rejects an EXACT_INPUT too small to produce any output", () => {
    expect(() =>
      quoteAmounts({ ...base, swapType: "EXACT_INPUT", origin: ETH_BASE, destination: USDC_NEAR, amount: 1n }),
    ).toThrow(/too small/);
  });
});

describe("display strings", () => {
  it("formats amounts and USD values exactly", () => {
    expect(formatted(2_014_018n, USDC_BASE)).toBe("2.014018");
    expect(usdValue(2_014_018n, USDC_BASE)).toBe("2.0140");
    expect(usdValue(801_600_000_000_000n, ETH_BASE)).toBe("2.0040");
  });
});

describe("scenarioDeposit", () => {
  const q = { amountIn: 2_014_018n, minAmountIn: 2_003_947n };
  it("pays exactly by default, below the minimum for 02, above the quote for 03", () => {
    expect(scenarioDeposit("00", q)).toBe(2_014_018n);
    expect(scenarioDeposit("02", q)).toBe(2_003_946n);
    expect(scenarioDeposit("03", q)).toBe(2_215_419n);
  });
  it("keeps tiny deposits positive", () => {
    expect(scenarioDeposit("02", { amountIn: 1n, minAmountIn: 1n })).toBe(1n);
    expect(scenarioDeposit("03", { amountIn: 5n, minAmountIn: 5n })).toBe(6n);
  });
});

describe("token registry", () => {
  it("uses unique, well-formed NEAR Intents asset ids", () => {
    const ids = SANDBOX_TOKENS.map((t) => t.assetId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^nep141:[a-z0-9.\-_]+$/);
    expect(tokenById("nep141:unknown.near")).toBeUndefined();
  });
});
