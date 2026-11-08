import { CHAINS, validateAddress } from "@nearpay-internal/chains";
import { describe, expect, it } from "vitest";
import { depositSender } from "../../src/app/executions.js";
import { SANDBOX_TOKENS } from "../../src/domain/tokens.js";
import {
  chainOf,
  depositAddress,
  depositMemo,
  intentsAccount,
  SIMULATED_PAYER,
  SOLVER_ACCOUNT,
  simulatedPayer,
  solverAddress,
  txHash,
} from "../../src/simulated-chains/addresses.js";

describe("deterministic addresses", () => {
  it("issues valid addresses in every sandbox chain's format", () => {
    for (const t of SANDBOX_TOKENS) {
      const c = chainOf(t.blockchain);
      for (const seed of ["1|a", "2|a", "3|b"]) {
        const a = depositAddress(c.family, seed, c.btc?.hrp ?? "bc");
        expect(validateAddress(c.caip2, a), `${c.caip2} ${a}`).toMatchObject({ ok: true });
      }
    }
  });

  it("is deterministic per seed and distinct across seeds", () => {
    expect(depositAddress("evm", "s")).toBe(depositAddress("evm", "s"));
    expect(depositAddress("evm", "s")).not.toBe(depositAddress("evm", "t"));
    expect(depositAddress("evm", "s")).toMatch(/^0x[0-9a-f]{40}$/);
    expect(depositAddress("near", "s")).toMatch(/^sbx-[0-9a-f]{40}\.near$/);
    expect(depositAddress("bitcoin", "s")).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/);
    expect(intentsAccount("s")).toBe(depositAddress("near", "s"));
  });

  it("derives 10-digit memos", () => {
    expect(depositMemo("x")).toMatch(/^\d{10}$/);
    expect(depositMemo("x")).toBe(depositMemo("x"));
  });

  it("formats transaction hashes per family", () => {
    expect(txHash("evm", "a")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(txHash("bitcoin", "a")).toMatch(/^[0-9a-f]{64}$/);
    expect(txHash("near", "a")).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(txHash("solana", "a")).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
  });

  it("knows only kit-registry chains", () => {
    expect(() => chainOf("nope")).toThrow(/unknown blockchain/);
    expect(CHAINS.map((c) => c.blockchain)).toEqual(
      expect.arrayContaining(["near", "base", "arb", "eth", "sol", "btc"]),
    );
  });
});

describe("transfer senders (spec 0.3.1 SimTx.transfers[].from, sandbox LLD §4.1)", () => {
  it("the simulated payer and liquidity provider have valid addresses on every sandbox chain", () => {
    for (const t of SANDBOX_TOKENS) {
      const c = chainOf(t.blockchain);
      expect(validateAddress(c.caip2, simulatedPayer(c.caip2)), `payer ${c.caip2}`).toMatchObject({ ok: true });
      expect(validateAddress(c.caip2, solverAddress(c.caip2)), `solver ${c.caip2}`).toMatchObject({ ok: true });
    }
  });

  it("documents payments' test refund addresses as the simulated payer", () => {
    expect(SIMULATED_PAYER).toEqual({
      evm: "0x000000000000000000000000000000000000dEaD",
      near: "sandbox-payer.near",
      solana: "11111111111111111111111111111111",
      bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    });
    expect(solverAddress("near:mainnet")).toBe(SOLVER_ACCOUNT);
  });

  it("a deposit is sent by the refund address when it is on the deposit chain, else by the simulated payer", () => {
    const base = "eip155:8453";
    expect(depositSender({ refundTo: "0xabc", refundType: "ORIGIN_CHAIN" }, base)).toBe("0xabc");
    expect(depositSender({ refundTo: "payer.near", refundType: "INTENTS" }, base)).toBe(SIMULATED_PAYER.evm);
    expect(depositSender({ refundTo: "payer.near", refundType: "INTENTS" }, "near:mainnet")).toBe("payer.near");
    expect(depositSender({ refundTo: "payer.near", refundType: "ORIGIN_CHAIN" }, "near:mainnet")).toBe("payer.near");
  });
});
