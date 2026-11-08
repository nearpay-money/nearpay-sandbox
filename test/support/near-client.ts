/**
 * A keeper-shaped NEAR client for tests: signs transactions with @near-js (the library NearPay's services use), so
 * the stand-in's borsh decoding and signature check are exercised against an independent encoder.
 */
import { KeyPairEd25519 } from "@near-js/crypto";
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
  Signature,
  SignedTransaction,
} from "@near-js/transactions";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";

export { KeyPairEd25519 };

export function signFunctionCall(o: {
  key: KeyPairEd25519;
  signer: string;
  receiver: string;
  nonce: bigint;
  method: string;
  args: object | Uint8Array;
  gas: bigint;
  deposit: bigint;
  blockHash: string;
}): { base64: string; hash: string } {
  const tx = createTransaction(
    o.signer,
    o.key.getPublicKey(),
    o.receiver,
    o.nonce,
    [actionCreators.functionCall(o.method, o.args, o.gas, o.deposit)],
    bs58.decode(o.blockHash),
  );
  const hash = sha256(encodeTransaction(tx));
  const sig = o.key.sign(hash);
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({ keyType: tx.publicKey.keyType, data: sig.signature }),
  });
  return { base64: Buffer.from(signed.encode()).toString("base64"), hash: bs58.encode(hash) };
}
