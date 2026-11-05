/** Property tests: every timeline is ordered, ends in exactly one terminal step and conserves value. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isTerminal, SCENARIOS, timeline } from "../../src/scenarios/scenario.js";

const T0 = Date.UTC(2026, 10, 5);

describe("timeline invariants", () => {
  it("ordered, single terminal step, payer refunds never exceed the deposit, merchant never gets more than quoted", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SCENARIOS),
        fc.bigInt({ min: 2n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.bigInt({ min: 1n, max: 3n * 10n ** 30n }),
        fc.integer({ min: -100_000, max: 3_600_000 }),
        fc.double({ min: 0.001, max: 10, noNaN: true }),
        (scenario, amountIn, slip, deposited, deadlineOffset, timeScale) => {
          const minAmountIn = (amountIn * BigInt(10_000 - slip)) / 10_000n;
          const amountOut = amountIn / 2n + 1n;
          const steps = timeline({
            scenario,
            depositAt: T0,
            deposited,
            amountIn,
            minAmountIn,
            amountOut,
            deadline: T0 + deadlineOffset,
            timeScale,
          });
          for (let i = 1; i < steps.length; i++) expect(steps[i]?.at).toBeGreaterThanOrEqual(steps[i - 1]?.at ?? 0);
          expect(steps.filter((s) => isTerminal(s.status))).toHaveLength(1);
          const last = steps.at(-1);
          expect(last && isTerminal(last.status)).toBe(true);
          for (const s of steps) {
            if (s.refunded !== undefined) expect(BigInt(s.refunded)).toBeLessThanOrEqual(deposited);
            if (s.delivered !== undefined) expect(BigInt(s.delivered)).toBeLessThanOrEqual(amountOut);
            if (s.status === "SUCCESS") {
              expect(deposited).toBeGreaterThanOrEqual(minAmountIn);
              expect(BigInt(s.refunded ?? "0")).toBe(deposited > amountIn ? deposited - amountIn : 0n);
            }
          }
          if (deposited < minAmountIn && T0 <= T0 + deadlineOffset) expect(last?.status).toBe("REFUNDED");
        },
      ),
      { numRuns: 500 },
    );
  });
});
