/**
 * Solana and Bitcoin simulation (sandbox LLD §10, spec 0.4.0): formats against the chain vectors, the SPL asset-id
 * rule of every `sol-` registry entry, associated token accounts, Bitcoin confirmations, and what scenarios `08`/`09`
 * change on the destination side.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { validateAddress } from "@nearpay-internal/chains";
import { assetIdBlockchain, parseAssetId } from "@nearpay-money/spec";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  BITCOIN_HEIGHT_BASE,
  bitcoinConfirmations,
  blockRefOf,
  destinationPlan,
  SOLANA_SLOT_BASE,
  splitBitcoinPayout,
} from "../../src/domain/chain-txs.js";
import { SANDBOX_TOKENS, tokenById } from "../../src/domain/tokens.js";
import { scenarioOf, timeline } from "../../src/scenarios/scenario.js";
import {
  associatedTokenAccount,
  depositAddress,
  findProgramAddress,
  onCurve,
  SOLANA_ATA_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  txHash,
} from "../../src/simulated-chains/addresses.js";

const fixture = (n: string) =>
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`@nearpay-money/spec/test-vectors/${n}`), "utf8"));
const CHAINS = fixture("chains-solana-bitcoin.json");
const SOLANA_TRANSFER = fixture("solana-transfer.json");
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BITCOIN = "bip122:000000000019d6689c085ae165831e93";

describe("registry (Solana USDT, SPL asset-id rule)", () => {
  it("every chain-vector asset is in the registry with its decimals and mint", () => {
    for (const a of CHAINS.assets as { asset_id: string; decimals: number; token: { address: string | null } }[]) {
      const t = tokenById(a.asset_id);
      expect(t, a.asset_id).toBeDefined();
      expect(t?.decimals).toBe(a.decimals);
      expect(t?.contractAddress ?? null).toBe(a.token.address);
    }
    expect(tokenById("nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near")).toMatchObject({
      symbol: "USDT",
      decimals: 6,
      priceUsd: "1",
      contractAddress: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    });
  });

  it("every sol- entry names its mint: nep141:sol-<hex(keccak256(mint)[12..32])>.omft.near or sol-0x<hex>.omdep.near", () => {
    const spl = SANDBOX_TOKENS.filter((t) => t.assetId.startsWith("nep141:sol-"));
    expect(spl.length).toBeGreaterThanOrEqual(3);
    for (const t of spl) {
      const h = Buffer.from(keccak_256(bs58.decode(t.contractAddress as string)).slice(12, 32)).toString("hex");
      expect([`nep141:sol-${h}.omft.near`, `nep141:sol-0x${h}.omdep.near`]).toContain(t.assetId);
      expect(parseAssetId(t.assetId)).toMatchObject({ blockchain: "sol", kind: "hash20", token: h });
    }
    for (const m of CHAINS.omft.spl_mints as { mint: string; keccak256_hex: string; asset_id: string }[])
      expect(Buffer.from(keccak_256(bs58.decode(m.mint))).toString("hex")).toBe(m.keccak256_hex);
  });
});

describe("formats (chain vectors)", () => {
  it("deposit addresses and tx hashes are valid in the vectors' rules", () => {
    for (const seed of ["a", "b", "c"]) {
      const sol = depositAddress("solana", seed);
      expect(bs58.decode(sol)).toHaveLength(32);
      expect(validateAddress(SOLANA, sol)).toMatchObject({ ok: true });
      const btc = depositAddress("bitcoin", seed);
      expect(btc).toMatch(/^bc1q[02-9ac-hj-np-z]{38}$/); // P2WPKH, 20-byte program
      expect(validateAddress(BITCOIN, btc)).toMatchObject({ ok: true });
      expect(bs58.decode(txHash("solana", seed))).toHaveLength(64);
      expect(txHash("bitcoin", seed)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the vectors' Solana addresses: on-curve wallets, off-curve token accounts", () => {
    for (const a of (CHAINS.addresses.solana as { address: string; valid: boolean; on_curve?: boolean }[]).filter(
      (x) => x.valid,
    ))
      expect(onCurve(bs58.decode(a.address)), a.address).toBe(a.on_curve);
  });

  it("associated token accounts match the Solana transfer vectors (address and bump)", () => {
    const { payer, deposit_address } = SOLANA_TRANSFER.inputs;
    const { mint, payer_ata, deposit_ata } = SOLANA_TRANSFER.spl;
    expect([SOLANA_TOKEN_PROGRAM, SOLANA_ATA_PROGRAM]).toEqual([
      SOLANA_TRANSFER.programs.token,
      SOLANA_TRANSFER.programs.associated_token,
    ]);
    for (const [owner, want] of [
      [payer, payer_ata],
      [deposit_address, deposit_ata],
    ] as const) {
      const pda = findProgramAddress(
        [bs58.decode(owner), bs58.decode(SOLANA_TOKEN_PROGRAM), bs58.decode(mint)],
        SOLANA_ATA_PROGRAM,
      );
      expect(pda).toEqual({ address: want.address, bump: want.bump });
      expect(associatedTokenAccount(owner, mint)).toBe(want.address);
    }
  });

  it("block_ref: Solana slot 380000000 + n, Bitcoin height 900000 + n, none elsewhere", () => {
    expect(blockRefOf("solana", 1n)).toBe((SOLANA_SLOT_BASE + 1n).toString());
    expect(blockRefOf("bitcoin", 7n)).toBe((BITCOIN_HEIGHT_BASE + 7n).toString());
    expect(blockRefOf("evm", 1n)).toBeNull();
    expect(blockRefOf("near", 1n)).toBeNull();
  });
});

describe("Bitcoin confirmations", () => {
  it("1 when recorded, +1 per 30 s × time scale, capped at 6; 0 before the first", () => {
    expect(bitcoinConfirmations(999, 1_000, 1)).toBe(0);
    expect(bitcoinConfirmations(1_000, 1_000, 1)).toBe(1);
    expect(bitcoinConfirmations(30_999, 1_000, 1)).toBe(1);
    expect(bitcoinConfirmations(31_000, 1_000, 1)).toBe(2);
    expect(bitcoinConfirmations(10_000_000, 1_000, 1)).toBe(6);
    expect(bitcoinConfirmations(4_000, 1_000, 0.1)).toBe(2);
  });
});

describe("scenarios 08 and 09", () => {
  it("are scenario keys with the 00 timeline (only the destination transactions differ)", () => {
    expect(scenarioOf("208")).toBe("08");
    expect(scenarioOf("209")).toBe("09");
    expect(scenarioOf("291")).toBe("00"); // vault suffixes do not select payment scenarios
    const base = {
      depositAt: 0,
      deposited: 100n,
      amountIn: 100n,
      minAmountIn: 99n,
      amountOut: 90n,
      deadline: 1_000_000,
      timeScale: 1,
    };
    const zero = timeline({ ...base, scenario: "00" });
    expect(timeline({ ...base, scenario: "08" })).toEqual(zero);
    expect(timeline({ ...base, scenario: "09" })).toEqual(zero);
  });

  it("destination plans per scenario, family and leg", () => {
    expect(destinationPlan("00", "solana", "payout")).toEqual({
      finalityMs: 2_000,
      failedFirst: false,
      splitOutputs: false,
    });
    expect(destinationPlan("00", "bitcoin", "payout")).toEqual({
      finalityMs: 0,
      failedFirst: false,
      splitOutputs: false,
    });
    expect(destinationPlan("08", "bitcoin", "refund").finalityMs).toBe(60_000);
    expect(destinationPlan("08", "evm", "payout").finalityMs).toBe(60_000);
    expect(destinationPlan("09", "solana", "payout").failedFirst).toBe(true);
    expect(destinationPlan("09", "solana", "refund").failedFirst).toBe(false);
    expect(destinationPlan("09", "bitcoin", "payout").splitOutputs).toBe(true);
    expect(destinationPlan("09", "bitcoin", "refund").splitOutputs).toBe(false);
    expect(destinationPlan("09", "evm", "payout")).toEqual({
      finalityMs: 2_000,
      failedFirst: false,
      splitOutputs: false,
    });
  });

  it("09 Bitcoin split: floor(a/2) and the rest; below 2 stays one output", () => {
    expect(splitBitcoinPayout(101n)).toEqual([50n, 51n]);
    expect(splitBitcoinPayout(2n)).toEqual([1n, 1n]);
    expect(splitBitcoinPayout(1n)).toEqual([1n]);
  });
});

describe("asset id shapes (spec 0.5.2)", () => {
  it("every token's id names the chain of its blockchain code (omft, omdep with the bnb alias, NEP-141)", () => {
    for (const t of SANDBOX_TOKENS) expect(assetIdBlockchain(t.assetId), t.assetId).toBe(t.blockchain);
    expect(tokenById("nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near")).toMatchObject({
      blockchain: "bsc",
      decimals: 18,
      contractAddress: "0x55d398326f99059ff775485246999027b3197955",
    });
  });
});
