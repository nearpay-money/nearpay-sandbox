/**
 * NEAR transactions as the stand-in's `send_tx` / `broadcast_tx_commit` receive them (sandbox LLD §3.1): the borsh
 * `SignedTransaction` (Transaction V0, or V1 with its leading `1` tag and `priority_fee`), its hash
 * (`base58(sha256(borsh(transaction)))`) and the ed25519 signature over that hash. The stand-in executes exactly one
 * `FunctionCall` on the vault; anything else is an `INVALID_TRANSACTION`. Pure: no I/O.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { U64_MAX, U128_MAX } from "./serde-json.js";

export class TxDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxDecodeError";
  }
}

export interface FunctionCallAction {
  readonly method_name: string;
  readonly args: Uint8Array;
  readonly gas: bigint;
  readonly deposit: bigint;
}

export interface DecodedTx {
  readonly version: 0 | 1;
  readonly signer_id: string;
  /** `ed25519:<base58>`. */
  readonly public_key: string;
  readonly publicKeyBytes: Uint8Array;
  readonly nonce: bigint;
  readonly receiver_id: string;
  readonly block_hash: string;
  /** Action tags as decoded (only FunctionCall carries a payload here). */
  readonly actions: readonly (
    | { readonly kind: "FunctionCall"; readonly call: FunctionCallAction }
    | { readonly kind: string }
  )[];
  readonly priority_fee: bigint;
  readonly signature: string;
  readonly signatureBytes: Uint8Array;
  /** `base58(sha256(borsh(transaction)))`. */
  readonly hash: string;
  readonly hashBytes: Uint8Array;
}

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  get offset() {
    return this.o;
  }
  get done() {
    return this.o === this.b.length;
  }
  private need(n: number) {
    if (this.o + n > this.b.length) throw new TxDecodeError("unexpected end of transaction");
  }
  u8(): number {
    this.need(1);
    return this.b[this.o++] as number;
  }
  u32(): number {
    this.need(4);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4).getUint32(0, true);
    this.o += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8).getBigUint64(0, true);
    this.o += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.b.slice(this.o, this.o + n);
    this.o += n;
    return v;
  }
  vec(): Uint8Array {
    return this.bytes(this.u32());
  }
  string(): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.vec());
    } catch (e) {
      if (e instanceof TxDecodeError) throw e;
      throw new TxDecodeError("invalid utf-8 string");
    }
  }
}

const ACTION_NAMES = [
  "CreateAccount",
  "DeployContract",
  "FunctionCall",
  "Transfer",
  "Stake",
  "AddKey",
  "DeleteKey",
  "DeleteAccount",
  "Delegate",
] as const;

function publicKey(r: Reader): { text: string; bytes: Uint8Array } {
  const type = r.u8();
  if (type !== 0) throw new TxDecodeError("only ed25519 keys are supported by the stand-in");
  const bytes = r.bytes(32);
  return { text: `ed25519:${bs58.encode(bytes)}`, bytes };
}

/** Decodes a base64 borsh `SignedTransaction`. Throws {@link TxDecodeError}. */
export function decodeSignedTx(base64: string): DecodedTx {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new TxDecodeError("signed transaction is not base64");
  const raw = new Uint8Array(Buffer.from(base64, "base64"));
  const r = new Reader(raw);
  let version: 0 | 1 = 0;
  if (raw[0] === 1) {
    version = 1;
    r.u8();
  }
  const signer_id = r.string();
  const pk = publicKey(r);
  const nonce = r.u64();
  const receiver_id = r.string();
  const block_hash = bs58.encode(r.bytes(32));
  const count = r.u32();
  if (count > 100) throw new TxDecodeError("too many actions");
  const actions: DecodedTx["actions"][number][] = [];
  for (let i = 0; i < count; i++) {
    const tag = r.u8();
    if (tag !== 2) {
      // Only FunctionCall is decodable here; the rest of the transaction cannot be located past another action.
      throw new TxDecodeError(`unsupported action ${ACTION_NAMES[tag] ?? tag}: the stand-in executes one FunctionCall`);
    }
    const method_name = r.string();
    const args = r.vec();
    const gas = r.u64();
    const deposit = r.u128();
    actions.push({ kind: "FunctionCall", call: { method_name, args, gas, deposit } });
  }
  const priority_fee = version === 1 ? r.u64() : 0n;
  const txEnd = r.offset;
  const sigType = r.u8();
  if (sigType !== 0) throw new TxDecodeError("only ed25519 signatures are supported by the stand-in");
  const signatureBytes = r.bytes(64);
  if (!r.done) throw new TxDecodeError("trailing bytes after the signature");
  const hashBytes = sha256(raw.slice(0, txEnd));
  return {
    version,
    signer_id,
    public_key: pk.text,
    publicKeyBytes: pk.bytes,
    nonce,
    receiver_id,
    block_hash,
    actions,
    priority_fee,
    signature: `ed25519:${bs58.encode(signatureBytes)}`,
    signatureBytes,
    hash: bs58.encode(hashBytes),
    hashBytes,
  };
}

/** ed25519 signature over the transaction hash (what near-api-js signs). */
export function signatureValid(tx: DecodedTx): boolean {
  try {
    return ed25519.verify(tx.signatureBytes, tx.hashBytes, tx.publicKeyBytes);
  } catch {
    return false;
  }
}

/** 64-hex implicit account: its only key is the account id itself. */
export function implicitKeyOf(account: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(account)) return null;
  return `ed25519:${bs58.encode(Buffer.from(account, "hex"))}`;
}

/** NEAR's prepaid-gas limit per transaction (1 PGas since protocol 83). */
export const MAX_TOTAL_PREPAID_GAS = 1_000_000_000_000_000n;

export { U64_MAX, U128_MAX };
