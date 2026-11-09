import { KeyPairEd25519 } from "@near-js/crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { decodeSignedTx, implicitKeyOf, signatureValid, TxDecodeError } from "../../../src/domain/vault/near-tx.js";
import { signFunctionCall } from "../../support/near-client.js";

const key = KeyPairEd25519.fromRandom();
const blockHash = bs58.encode(new Uint8Array(32).fill(7));

function signed(over: Partial<Parameters<typeof signFunctionCall>[0]> = {}) {
  return signFunctionCall({
    key,
    signer: "keeper.sandbox.near",
    receiver: "vault.sandbox.near",
    nonce: 42n,
    method: "collect",
    args: { mandate_id: 7 },
    gas: 250_000_000_000_000n,
    deposit: 0n,
    blockHash,
    ...over,
  });
}

describe("borsh SignedTransaction (near-js encoded)", () => {
  it("decodes every field, hashes like near-js and verifies the signature", () => {
    const s = signed();
    const t = decodeSignedTx(s.base64);
    expect(t.version).toBe(0);
    expect(t.signer_id).toBe("keeper.sandbox.near");
    expect(t.public_key).toBe(key.getPublicKey().toString());
    expect(t.nonce).toBe(42n);
    expect(t.receiver_id).toBe("vault.sandbox.near");
    expect(t.block_hash).toBe(blockHash);
    expect(t.hash).toBe(s.hash);
    expect(t.actions).toHaveLength(1);
    const a = t.actions[0] as {
      kind: string;
      call: { method_name: string; args: Uint8Array; gas: bigint; deposit: bigint };
    };
    expect(a.call.method_name).toBe("collect");
    expect(new TextDecoder().decode(a.call.args)).toBe('{"mandate_id":7}');
    expect(a.call.gas).toBe(250_000_000_000_000n);
    expect(a.call.deposit).toBe(0n);
    expect(signatureValid(t)).toBe(true);
  });

  it("decodes a u128 deposit", () => {
    const t = decodeSignedTx(signed({ method: "cancel", deposit: 2n ** 100n + 1n }).base64);
    expect((t.actions[0] as { call: { deposit: bigint } }).call.deposit).toBe(2n ** 100n + 1n);
  });

  it("rejects a signature by another key", () => {
    const other = KeyPairEd25519.fromRandom();
    const s = signed();
    const raw = Buffer.from(s.base64, "base64");
    const forged = Buffer.from(signed({ key: other }).base64, "base64");
    // keep the original transaction, splice in the other key's signature
    raw.set(forged.subarray(forged.length - 64), raw.length - 64);
    expect(signatureValid(decodeSignedTx(raw.toString("base64")))).toBe(false);
  });

  it("rejects truncated, trailing and non-base64 input", () => {
    const raw = Buffer.from(signed().base64, "base64");
    expect(() => decodeSignedTx(raw.subarray(0, raw.length - 1).toString("base64"))).toThrow(TxDecodeError);
    expect(() => decodeSignedTx(Buffer.concat([raw, Buffer.from([0])]).toString("base64"))).toThrow(TxDecodeError);
    expect(() => decodeSignedTx("not base64!")).toThrow(TxDecodeError);
    expect(() => decodeSignedTx("")).toThrow(TxDecodeError);
  });

  it("refuses actions other than FunctionCall", () => {
    const raw = Buffer.from(signed().base64, "base64");
    // the action tag sits right after the actions count: signer(4+19) pk(33) nonce(8) receiver(4+18) hash(32) count(4)
    const at = 4 + 19 + 33 + 8 + 4 + 18 + 32 + 4;
    expect(raw[at]).toBe(2);
    raw[at] = 3;
    expect(() => decodeSignedTx(raw.toString("base64"))).toThrow(/unsupported action Transfer/);
  });

  it("decodes a Transaction V1 (tag 1, priority_fee) and hashes it with the tag", () => {
    const raw = Buffer.from(signed().base64, "base64");
    const txPart = raw.subarray(0, raw.length - 65);
    const v1 = Buffer.concat([Buffer.from([1]), txPart, Buffer.alloc(8), raw.subarray(raw.length - 65)]);
    const t = decodeSignedTx(v1.toString("base64"));
    expect(t.version).toBe(1);
    expect(t.priority_fee).toBe(0n);
    expect(t.hash).not.toBe(signed().hash);
    expect(signatureValid(t)).toBe(false); // the signature covered the V0 bytes
  });

  it("implicit accounts own exactly their key", () => {
    const hex = Buffer.from(bs58.decode(key.getPublicKey().toString().slice(8))).toString("hex");
    expect(implicitKeyOf(hex)).toBe(key.getPublicKey().toString());
    expect(implicitKeyOf("alice.near")).toBeNull();
  });
});
