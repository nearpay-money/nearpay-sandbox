/** Scenario groups (sandbox LLD §4, Stage 2): which quotes a scenario 06 deposit also pays. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  duplicateInTime,
  duplicateTargets,
  type GroupInput,
  groupKey,
  type Step,
  type TimelineInput,
  timeline,
} from "../../src/scenarios/scenario.js";

const g: GroupInput = {
  scenarioKind: "payment",
  recipient: "merchant.near",
  destinationAsset: "nep141:wrap.near",
  refundTo: "0x52908400098527886e0f7030069857d2e4169ee7",
  scenarioAmount: "206",
};

describe("groupKey", () => {
  it("keeps the Stage 1 grouping without scenario_group (same hash as Stage 1)", () => {
    const stage1 = createHash("sha256")
      .update([g.recipient, g.destinationAsset, g.refundTo, g.scenarioAmount].join("|"))
      .digest("hex");
    expect(groupKey(g)).toBe(stage1);
    expect(groupKey({ ...g, scenarioGroup: null })).toBe(stage1);
    expect(groupKey({ ...g, scenarioGroup: "" })).toBe(stage1);
    expect(groupKey({ ...g, scenarioKind: "refund" })).toBe(stage1);
  });

  it("separates different payers or amounts in the Stage 1 grouping", () => {
    expect(groupKey({ ...g, refundTo: "0x1111111111111111111111111111111111111111" })).not.toBe(groupKey(g));
    expect(groupKey({ ...g, scenarioAmount: "1206" })).not.toBe(groupKey(g));
  });

  it("groups by scenario_group only when present: one payment or one refund, whatever the quote fields", () => {
    const a = groupKey({ ...g, scenarioGroup: "pi_123" });
    expect(groupKey({ ...g, scenarioGroup: "pi_123", refundTo: "0xother", scenarioAmount: "999" })).toBe(a);
    expect(groupKey({ ...g, scenarioGroup: "pi_124" })).not.toBe(a);
    expect(groupKey(g)).not.toBe(a);
  });

  it("never mixes a payment's attempts with a refund's legs", () => {
    expect(groupKey({ ...g, scenarioGroup: "x_1", scenarioKind: "refund" })).not.toBe(
      groupKey({ ...g, scenarioGroup: "x_1", scenarioKind: "payment" }),
    );
  });

  it("is a 64-hex digest", () => {
    expect(groupKey({ ...g, scenarioGroup: "re_1", scenarioKind: "refund" })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("duplicate policy", () => {
  it("a payment's 06 deposit pays its older attempts; a refund's pays every other open leg, in time", () => {
    expect(duplicateTargets("payment")).toBe("older");
    expect(duplicateTargets("refund")).toBe("others");
    expect(duplicateInTime("payment")).toBe(false);
    expect(duplicateInTime("refund")).toBe(true);
  });
});

describe("timeline inTime (refund duplicates)", () => {
  const T0 = Date.UTC(2026, 10, 7, 10);
  const base: TimelineInput = {
    scenario: "06",
    depositAt: T0,
    deposited: 1_000_000n,
    amountIn: 1_000_000n,
    minAmountIn: 1_000_000n,
    amountOut: 998_000n,
    deadline: T0 - 60_000,
    timeScale: 1,
  };
  it("a late deposit is refunded unless it counts as made in time", () => {
    expect((timeline(base).at(-1) as Step).refundReason).toBe("DEPOSIT_AFTER_DEADLINE");
    const steps = timeline({ ...base, inTime: true });
    expect(steps.map((s) => s.status)).toEqual(["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
    expect(steps.at(-1)).toMatchObject({ delivered: "998000", refunded: "0" });
  });
});
