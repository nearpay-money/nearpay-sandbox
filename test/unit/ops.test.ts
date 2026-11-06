/** Ops CLI argument checks (the ledger write itself is covered by the /sim/intents/fund integration tests). */
import { describe, expect, it } from "vitest";
import { runOps } from "../../src/ops/cli.js";

const run = async (argv: string[]) => {
  const lines: string[] = [];
  const code = await runOps(argv, {} as never, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
};

describe("sandbox ops CLI", () => {
  it("prints usage for missing or unknown commands", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["nope"])).text).toMatch(/unknown command/);
  });
  it("validates account, token and amount before touching the ledger", async () => {
    expect((await run(["intents-fund", "Bad Account", "nep141:usdc.near", "1"])).text).toMatch(/NEAR account/);
    expect((await run(["intents-fund", "agent.near", "usdc", "1"])).text).toMatch(/token id/);
    expect((await run(["intents-fund", "agent.near", "nep141:usdc.near", "0"])).text).toMatch(/positive/);
    expect((await run(["intents-balance", "agent.near"])).code).toBe(2);
  });
});
