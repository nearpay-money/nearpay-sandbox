/**
 * Deterministic deposit addresses and transaction hashes in each chain's real format (sandbox LLD
 * §3): `0x` + keccak(seed)[12..32] for EVM, `sbx-<hash>.near` for NEAR, base58 for Solana, bech32
 * (P2WPKH) for Bitcoin. Every value is valid for `@nearpay-internal/chains` address validation, so
 * rails and checkout treat sandbox output exactly like provider output.
 */
import { type ChainFamily, type ChainInfo, chainByBlockchain, getChain } from "@nearpay-internal/chains";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bech32 } from "@scure/base";
import bs58 from "bs58";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** 32 bytes derived from a seed string. */
export function seedBytes(seed: string): Uint8Array {
  return sha256(enc.encode(seed));
}

/** Chain of a 1Click `blockchain` code; the sandbox only knows chains the kit registry knows. */
export function chainOf(blockchain: string): ChainInfo {
  const c = chainByBlockchain(blockchain);
  if (!c) throw new RangeError(`unknown blockchain ${blockchain}`);
  return c;
}

export function depositAddress(family: ChainFamily, seed: string, btcHrp = "bc"): string {
  const s = seedBytes(seed);
  switch (family) {
    case "evm":
      return `0x${hex(keccak_256(s).slice(12, 32))}`;
    case "near":
      return intentsAccount(seed);
    case "solana":
      return bs58.encode(s);
    case "bitcoin":
      return bech32.encode(btcHrp, [0, ...bech32.toWords(s.slice(0, 20))]);
  }
}

/** A NEAR account the sandbox controls (deposit accounts, Intents deposit addresses). */
export function intentsAccount(seed: string): string {
  return `sbx-${hex(seedBytes(seed)).slice(0, 40)}.near`;
}

/** Numeric memo for `depositMode: MEMO` quotes. */
export function depositMemo(seed: string): string {
  const s = seedBytes(`memo:${seed}`);
  return (new DataView(s.buffer, s.byteOffset, 8).getBigUint64(0) % 10_000_000_000n).toString().padStart(10, "0");
}

/** A transaction hash in the chain family's format. */
export function txHash(family: ChainFamily, seed: string): string {
  const s = seedBytes(`tx:${seed}`);
  switch (family) {
    case "evm":
      return `0x${hex(s)}`;
    case "near":
      return bs58.encode(s);
    case "solana":
      return bs58.encode(new Uint8Array([...s, ...seedBytes(`tx2:${seed}`)]));
    case "bitcoin":
      return hex(s);
  }
}

/**
 * Documented test addresses of the simulated payer (sandbox LLD §4.1; the refund addresses payments' test helper
 * sends, payments LLD §21.5). The sandbox names this payer as the sender (`SimTx.transfers[].from`) of a deposit
 * whose refund address is not on the deposit chain.
 */
export const SIMULATED_PAYER: Readonly<Record<ChainFamily, string>> = {
  evm: "0x000000000000000000000000000000000000dEaD",
  near: "sandbox-payer.near",
  solana: "11111111111111111111111111111111",
  bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
};

/** NEAR account of the simulated liquidity provider: sender of every simulated payout and refund on NEAR. */
export const SOLVER_ACCOUNT = "sbx-solver.near";

function chainInfo(chain: string): ChainInfo {
  const c = getChain(chain);
  if (!c) throw new RangeError(`unknown chain ${chain}`);
  return c;
}

/** The simulated payer's address on `chain` (bitcoin chains with another HRP get a derived address). */
export function simulatedPayer(chain: string): string {
  const c = chainInfo(chain);
  const hrp = c.btc?.hrp ?? "bc";
  if (c.family === "bitcoin" && hrp !== "bc") return depositAddress("bitcoin", "sandbox-payer", hrp);
  return SIMULATED_PAYER[c.family];
}

/** The simulated liquidity provider's address on `chain`: sender of the payouts and refunds the sandbox makes. */
export function solverAddress(chain: string): string {
  const c = chainInfo(chain);
  if (c.family === "near") return SOLVER_ACCOUNT;
  return depositAddress(c.family, "sbx-solver", c.btc?.hrp ?? "bc");
}

// ---------------------------------------------------------------------------------------------
// Solana token accounts (sandbox LLD §10: `SimTx.transfers[].token_account`)
// ---------------------------------------------------------------------------------------------

export const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** `true` when the 32 bytes are a point on ed25519 (a wallet key); program-derived addresses are off the curve. */
export function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Solana `find_program_address`: the first bump from 255 down whose derived address is off the curve. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } {
  const program = bs58.decode(programId);
  const marker = enc.encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(new Uint8Array(Buffer.concat([...seeds, Uint8Array.of(bump), program, marker])));
    if (!onCurve(h)) return { address: bs58.encode(h), bump };
  }
  throw new Error("no viable program address");
}

/** Associated token account of `owner` for `mint` (classic Token program). */
export function associatedTokenAccount(owner: string, mint: string): string {
  return findProgramAddress(
    [bs58.decode(owner), bs58.decode(SOLANA_TOKEN_PROGRAM), bs58.decode(mint)],
    SOLANA_ATA_PROGRAM,
  ).address;
}
