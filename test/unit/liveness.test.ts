import { describe, expect, it } from "vitest";
import type { Sandbox } from "../../src/app/context.js";
import { MATERIALIZER_MAX_SILENCE_MS, materializer } from "../../src/app/service.js";

describe("kit 0.6.0 liveness (KIT-4)", () => {
  it("the materializer declares a budget and beats every tick, failed ones included", async () => {
    const sb = { log: { error() {}, warn() {}, info() {} } } as unknown as Sandbox;
    const task = materializer(sb, 5);
    expect(task.maxSilenceMs).toBe(MATERIALIZER_MAX_SILENCE_MS);
    let beats = 0;
    const running = await task.start({ beat: () => void beats++, idle: () => {} });
    await new Promise((r) => setTimeout(r, 60));
    await running.stop();
    expect(beats).toBeGreaterThan(1);
  });
});
