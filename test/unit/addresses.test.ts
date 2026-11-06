import { CHAINS, validateAddress } from "@nearpay-internal/chains";
import { describe, expect, it } from "vitest";
import { SANDBOX_TOKENS } from "../../src/domain/tokens.js";
import { chainOf, depositAddress, depositMemo, intentsAccount, txHash } from "../../src/simulated-chains/addresses.js";

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
