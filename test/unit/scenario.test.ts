import { describe, expect, it } from "vitest";
import {
  dueSteps,
  isTerminal,
  nextDue,
  planAdvance,
  type Step,
  scenarioOf,
  type TimelineInput,
  timeline,
} from "../../src/scenarios/scenario.js";

const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const base: TimelineInput = {
  scenario: "00",
  depositAt: T0,
  deposited: 2_014_018n,
  amountIn: 2_014_018n,
  minAmountIn: 2_003_947n,
  amountOut: 2_000_017n,
  deadline: T0 + 900_000,
  timeScale: 1,
};
const shape = (steps: Step[]) => steps.map((s) => [s.status, s.at - T0, s.delivered, s.refunded, s.refundReason]);

describe("scenarioOf", () => {
  it.each([
    ["200", "00"],
    ["201", "01"],
    ["202", "02"],
    ["203", "03"],
    ["204", "04"],
    ["205", "05"],
    ["206", "06"],
    ["207", "07"],
    ["299", "00"],
    ["7", "07"],
    ["0", "00"],
    ["25000006", "06"],
    ["not-a-number", "00"],
  ])("%s → %s", (amount, key) => expect(scenarioOf(amount)).toBe(key));
});

describe("timeline", () => {
  it("00: known, processing and exact success within ~5 s", () => {
    expect(shape(timeline(base))).toEqual([
      ["KNOWN_DEPOSIT_TX", 1000, undefined, undefined, undefined],
      ["PROCESSING", 3000, undefined, undefined, undefined],
      ["SUCCESS", 5000, "2000017", "0", undefined],
    ]);
  });

  it("01: success after 120 s", () => {
    expect(shape(timeline({ ...base, scenario: "01" })).at(-1)).toEqual([
      "SUCCESS",
      120_000,
      "2000017",
      "0",
      undefined,
    ]);
  });

  it("02 / any deposit below minAmountIn: incomplete, then refunded at the deadline", () => {
    for (const scenario of ["02", "00"] as const) {
      expect(shape(timeline({ ...base, scenario, deposited: 1_000_000n }))).toEqual([
        ["INCOMPLETE_DEPOSIT", 1000, undefined, undefined, undefined],
        ["REFUNDED", 900_000, undefined, "1000000", "PARTIAL_DEPOSIT"],
      ]);
    }
  });

  it("refunds an incomplete deposit no earlier than 2 s after it", () => {
    const steps = timeline({ ...base, deposited: 1n, deadline: T0 + 500 });
    expect((steps[1] as Step).at - T0).toBe(2000);
  });

  it("03 / any deposit above amountIn: success with the excess refunded", () => {
    expect(shape(timeline({ ...base, scenario: "03", deposited: 2_215_419n })).at(-1)).toEqual([
      "SUCCESS",
      5000,
      "2000017",
      "201401",
      undefined,
    ]);
  });

  it("treats a deposit between minAmountIn and amountIn as paid (slippage band)", () => {
    expect(shape(timeline({ ...base, deposited: 2_003_947n })).at(-1)).toEqual([
      "SUCCESS",
      5000,
      "2000017",
      "0",
      undefined,
    ]);
  });

  it("04: failed after processing", () => {
    expect(shape(timeline({ ...base, scenario: "04" })).map((s) => s[0])).toEqual([
      "KNOWN_DEPOSIT_TX",
      "PROCESSING",
      "FAILED",
    ]);
  });

  it("05: success one base unit short", () => {
    expect(timeline({ ...base, scenario: "05" }).at(-1)?.delivered).toBe("2000016");
  });

  it("06 behaves like 00 for its own quote", () => {
    expect(shape(timeline({ ...base, scenario: "06" }))).toEqual(shape(timeline(base)));
  });

  it("07: success 5 min after the deadline", () => {
    expect((timeline({ ...base, scenario: "07" }).at(-1) as Step).at - T0).toBe(900_000 + 300_000);
  });

  it("refunds a deposit made after the deadline", () => {
    expect(shape(timeline({ ...base, depositAt: T0 + 900_001 })).map((s) => [s[0], s[4]])).toEqual([
      ["KNOWN_DEPOSIT_TX", undefined],
      ["REFUNDED", "DEPOSIT_AFTER_DEADLINE"],
    ]);
  });

  it("scales relative offsets but not the deadline", () => {
    const fast = timeline({ ...base, timeScale: 0.1 });
    expect(fast.map((s) => s.at - T0)).toEqual([100, 300, 500]);
    const late = timeline({ ...base, scenario: "07", timeScale: 0.1 });
    expect((late.at(-1) as Step).at - T0).toBe(900_000 + 30_000);
  });

  it("rejects a non-positive time scale or deposit", () => {
    expect(() => timeline({ ...base, timeScale: 0 })).toThrow(/timeScale/);
    expect(() => timeline({ ...base, deposited: 0n })).toThrow(/positive/);
  });
});

describe("dueSteps / nextDue", () => {
  const steps = timeline(base);
  it("returns the due prefix after the applied steps", () => {
    expect(dueSteps(steps, 0, T0).length).toBe(0);
    expect(dueSteps(steps, 0, T0 + 1000).map((s) => s.status)).toEqual(["KNOWN_DEPOSIT_TX"]);
    expect(dueSteps(steps, 0, T0 + 10_000).map((s) => s.status)).toEqual(["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
    expect(dueSteps(steps, 1, T0 + 3000).map((s) => s.status)).toEqual(["PROCESSING"]);
    expect(dueSteps(steps, 3, T0 + 10_000)).toEqual([]);
  });
  it("reports the next due time, or null when finished", () => {
    expect(nextDue(steps, 0)).toBe(T0 + 1000);
    expect(nextDue(steps, 2)).toBe(T0 + 5000);
    expect(nextDue(steps, 3)).toBeNull();
  });
});

describe("planAdvance", () => {
  const q = { scenario: "00" as const, amountIn: 100n, amountOut: 90n };
  it("deposits first when needed and plans the step", () => {
    expect(planAdvance({ ...q, current: "PENDING_DEPOSIT", deposited: null }, "deposit")).toEqual({
      ok: true,
      deposit: true,
      step: { status: "KNOWN_DEPOSIT_TX" },
    });
    expect(planAdvance({ ...q, current: "PENDING_DEPOSIT", deposited: null }, "processing")).toMatchObject({
      ok: true,
      deposit: true,
    });
    expect(planAdvance({ ...q, current: "PROCESSING", deposited: 120n }, "success")).toEqual({
      ok: true,
      deposit: false,
      step: { status: "SUCCESS", delivered: "90", refunded: "20" },
    });
    expect(planAdvance({ ...q, scenario: "05", current: "PROCESSING", deposited: 100n }, "success")).toMatchObject({
      step: { delivered: "89", refunded: "0" },
    });
    expect(planAdvance({ ...q, current: "KNOWN_DEPOSIT_TX", deposited: 100n }, "refund")).toEqual({
      ok: true,
      deposit: false,
      step: { status: "REFUNDED", refunded: "100", refundReason: "MANUAL" },
    });
    expect(planAdvance({ ...q, current: "PENDING_DEPOSIT", deposited: null }, "refund")).toMatchObject({
      deposit: true,
      step: { refunded: "100" },
    });
    expect(planAdvance({ ...q, current: "PENDING_DEPOSIT", deposited: null }, "fail")).toEqual({
      ok: true,
      deposit: false,
      step: { status: "FAILED" },
    });
  });
  it("refuses terminal quotes and a second deposit", () => {
    for (const s of ["SUCCESS", "REFUNDED", "FAILED"] as const) {
      expect(planAdvance({ ...q, current: s, deposited: 100n }, "success")).toEqual({
        ok: false,
        reason: `the quote is ${s}`,
      });
      expect(isTerminal(s)).toBe(true);
    }
    expect(planAdvance({ ...q, current: "KNOWN_DEPOSIT_TX", deposited: 100n }, "deposit")).toEqual({
      ok: false,
      reason: "a deposit was already made",
    });
    expect(isTerminal("PROCESSING")).toBe(false);
  });
});
