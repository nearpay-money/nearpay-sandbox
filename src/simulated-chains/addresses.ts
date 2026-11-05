/**
 * Deterministic deposit addresses and transaction hashes in each chain's real format (sandbox LLD
 * §3): `0x` + keccak(seed)[12..32] for EVM, `sbx-<hash>.near` for NEAR, base58 for Solana, bech32
 * (P2WPKH) for Bitcoin. Every value is valid for `@nearpay-internal/chains` address validation, so
 * rails and checkout treat sandbox output exactly like provider output.
 */
import { type ChainFamily, type ChainInfo, chainByBlockchain } from "@nearpay-internal/chains";
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
