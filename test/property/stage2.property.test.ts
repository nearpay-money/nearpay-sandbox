/**
 * Stage 2 property tests: refund-leg quote amounts (no app fee, EXACT_INPUT / EXACT_OUTPUT, INV-5 exact
 * arithmetic), refund duplicates settle in time, and Explorer rows never show money before it settled.
 */
import { EXPLORER_STATUSES } from "@nearpay-internal/spec";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { explorerRow, explorerStatus, statesForStatuses } from "../../src/domain/explorer.js";
import { quoteAmounts, ROUTE_COST_BPS } from "../../src/domain/quote-math.js";
import { SANDBOX_TOKENS } from "../../src/domain/tokens.js";
import { isTerminal, SCENARIOS, timeline } from "../../src/scenarios/scenario.js";

/** Value of `amount` base units in USD as an exact fraction [num, den] (price × amount / 10^decimals). */
function usd(amount: bigint, t: (typeof SANDBOX_TOKENS)[number]): [bigint, bigint] {
  const [i = "0", f = ""] = t.priceUsd.split(".");
  return [amount * BigInt(i + f), 10n ** BigInt(t.decimals + f.length)];
}
const le = (a: [bigint, bigint], b: [bigint, bigint]) => a[0] * b[1] <= b[0] * a[1];
const scale = (a: [bigint, bigint], n: bigint, d: bigint): [bigint, bigint] => [a[0] * n, a[1] * d];

describe("refund-leg quote amounts (no app fee)", () => {
  it("EXACT_INPUT: the merchant sends exactly amount; the payer's value never exceeds it less the route cost", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SANDBOX_TOKENS),
        fc.constantFrom(...SANDBOX_TOKENS),
        fc.bigInt({ min: 1n, max: 10n ** 27n }),
        fc.integer({ min: 0, max: 10_000 }),
        (origin, destination, amount, slip) => {
          let q: ReturnType<typeof quoteAmounts>;
          try {
            q = quoteAmounts({
              swapType: "EXACT_INPUT",
              amount,
              origin,
              destination,
              appFeeBps: 0n,
              slippageBps: BigInt(slip),
            });
          } catch {
            return; // too small to produce any output: refused, never a zero-output leg
          }
          expect([q.amountIn, q.minAmountIn]).toEqual([amount, amount]);
          expect(q.amountOut).toBeGreaterThan(0n);
          expect(q.minAmountOut).toBeLessThanOrEqual(q.amountOut);
          expect(le(usd(q.amountOut, destination), scale(usd(amount, origin), 10_000n - ROUTE_COST_BPS, 10_000n))).toBe(
            true,
          );
          // floor: one more output unit would exceed the value
          expect(
            le(usd(q.amountOut + 1n, destination), scale(usd(amount, origin), 10_000n - ROUTE_COST_BPS, 10_000n)),
          ).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("EXACT_OUTPUT: the payer receives exactly amount; the merchant's input covers it plus the route cost", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SANDBOX_TOKENS),
        fc.constantFrom(...SANDBOX_TOKENS),
        fc.bigInt({ min: 1n, max: 10n ** 27n }),
        fc.integer({ min: 0, max: 10_000 }),
        (origin, destination, amount, slip) => {
          const q = quoteAmounts({
            swapType: "EXACT_OUTPUT",
            amount,
            origin,
            destination,
            appFeeBps: 0n,
            slippageBps: BigInt(slip),
          });
          expect([q.amountOut, q.minAmountOut]).toEqual([amount, amount]);
          expect(q.minAmountIn).toBeLessThanOrEqual(q.amountIn);
          const need = scale(usd(amount, destination), 10_000n + ROUTE_COST_BPS, 10_000n);
          expect(le(need, usd(q.amountIn, origin))).toBe(true);
          if (q.amountIn > 1n) expect(le(need, usd(q.amountIn - 1n, origin))).toBe(false); // ceil
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("refund duplicates (scenario 06, inTime)", () => {
  it("a sufficient duplicate deposit always succeeds with the quoted output, whenever it is recorded", () => {
    const T0 = Date.UTC(2026, 10, 7);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.integer({ min: -3_600_000, max: 3_600_000 }),
        fc.double({ min: 0.001, max: 10, noNaN: true }),
        (amountIn, deadlineOffset, timeScale) => {
          const steps = timeline({
            scenario: "06",
            depositAt: T0,
            deposited: amountIn,
            amountIn,
            minAmountIn: amountIn,
            amountOut: amountIn,
            deadline: T0 + deadlineOffset,
            timeScale,
            inTime: true,
          });
          expect(steps.filter((s) => isTerminal(s.status))).toEqual([
            expect.objectContaining({ status: "SUCCESS", delivered: amountIn.toString(), refunded: "0" }),
          ]);
        },
      ),
    );
  });

  it("inTime never changes the outcome of a deposit made before the deadline", () => {
    const T0 = Date.UTC(2026, 10, 7);
    fc.assert(
      fc.property(
        fc.constantFrom(...SCENARIOS),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.integer({ min: 0, max: 3_600_000 }),
        (scenario, amountIn, deposited, deadlineOffset) => {
          const i = {
            scenario,
            depositAt: T0,
            deposited,
            amountIn,
            minAmountIn: amountIn,
            amountOut: amountIn,
            deadline: T0 + deadlineOffset,
            timeScale: 1,
          };
          expect(timeline({ ...i, inTime: true })).toEqual(timeline(i));
        },
      ),
    );
  });
});

describe("Explorer rows", () => {
  const states = [
    "PENDING_DEPOSIT",
    "KNOWN_DEPOSIT_TX",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
  ];
  it("every state has a documented Explorer status, and filtering by it finds the state", () => {
    for (const s of states) {
      expect(EXPLORER_STATUSES).toContain(explorerStatus(s));
      expect(statesForStatuses(explorerStatus(s))).toContain(s);
    }
  });

  it("amountOut is non-zero only for SUCCESS, amountIn only for final states", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...states),
        fc.option(fc.bigInt({ min: 1n, max: 10n ** 30n })),
        fc.option(fc.bigInt({ min: 1n, max: 10n ** 30n })),
        (state, dep, out) => {
          const row = explorerRow({
            request: {
              originAsset: "nep141:wrap.near",
              destinationAsset: "nep141:wrap.near",
              recipient: "a.near",
              refundTo: "b.near",
              depositType: "INTENTS",
              recipientType: "INTENTS",
              refundType: "INTENTS",
            },
            appFees: null,
            refundFee: "0",
            depositAddress: "sbx-1.near",
            depositMemo: null,
            state,
            createdAt: new Date(0),
            depositedAmount: dep === null ? null : dep.toString(),
            deliveredAmount: out === null ? null : out.toString(),
            refundReason: null,
            nearTxHashes: [],
            originTxHashes: [],
            destinationTxHashes: [],
          });
          if (state !== "SUCCESS" || out === null) expect(row.amountOut).toBe("0");
          else expect(row.amountOut).toBe(out.toString());
          if (!isTerminal(state) || dep === null) expect(row.amountIn).toBe("0");
          else expect(row.amountIn).toBe(dep.toString());
        },
      ),
    );
  });
});
