/**
 * Use cases of the subscription-vault stand-in (sandbox LLD §3.1, §4.2; OQ-T-03): the NEAR JSON-RPC subset billing's
 * keeper and rails use (`POST /sim/near-rpc`), the payer's unsigned `ft_transfer_call` and change calls
 * (`/sim/vault/ft_transfer_call`, `/sim/vault/call`) and the per-mandate clock (`/sim/vault/advance`).
 *
 * Every execution is one database transaction holding the Verifier lock (vault receipts credit the simulated
 * Intents ledger the Verifier also moves, and the contract executes one receipt at a time): the pure runtime
 * (`domain/vault`) runs against the loaded state, then the committed writes, the receipt lines of the indexer feed
 * (`/sim/intents/events` with receipt context) and the outcome (for `tx`) are stored together.
 */
import { sql, withTx } from "@nearpay-internal/db";
import { ApiError } from "@nearpay-internal/service";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { SANDBOX_TOKENS } from "../domain/tokens.js";
import { accountId, isValidAccountId } from "../domain/vault/account-id.js";
import { ContractPanic, MethodNotFound, TGAS, type VaultContract } from "../domain/vault/contract.js";
import { dueAt } from "../domain/vault/math.js";
import {
  type DecodedTx,
  decodeSignedTx,
  implicitKeyOf,
  MAX_TOTAL_PREPAID_GAS,
  signatureValid,
  TxDecodeError,
} from "../domain/vault/near-tx.js";
import { field, parseJson, SerdeError, struct, U128_MAX } from "../domain/vault/serde-json.js";
import { executeVaultTx, type TxMeta } from "../domain/vault/standin.js";
import { type TokenCap, type VaultConfig, VaultState } from "../domain/vault/state.js";
import { dbVaultLoader, persistVault } from "../infra/db/vault-store.js";
import { appendReceiptLines } from "../simulated-chains/intents-ledger.js";
import { VAULT_CALL_METHODS } from "../spec-0.4-gap.js";
import { dbNow, nextBlock, type Sandbox, type Tx } from "./context.js";

const enc = new TextEncoder();
/** Same lock as the simulated Verifier: one receipt at a time across the Verifier and the vault. */
const LOCK = "sandbox:verifier";
const NS_PER_MS = 1_000_000n;
const ZERO_KEY = "ed25519:11111111111111111111111111111111";
const ZERO_SIG = `ed25519:${bs58.encode(new Uint8Array(64))}`;
/** NEP-145 balance the simulated test tokens report for every account (all accounts are registered). */
const TOKEN_STORAGE_BALANCE = '{"total":"1250000000000000000000","available":"0"}';

/** Stand-in configuration (sandbox §3.1): the registry's NEAR USDC and USDT, `max_fee_bps` 500, `intents.near`. */
export function vaultConfigFrom(c: {
  sandboxVaultAccount: string;
  sandboxVaultFeeReceiver: string;
  sandboxVaultCaps?: string | undefined;
}): VaultConfig {
  const allowed = SANDBOX_TOKENS.filter(
    (t) => t.blockchain === "near" && (t.symbol === "USDC" || t.symbol === "USDT"),
  ).map((t) => t.contractAddress as string);
  let caps: TokenCap[] = allowed.map((token) => ({ token, cap: 10n ** 15n, mandateCap: 10n ** 12n }));
  if (c.sandboxVaultCaps) {
    const parsed = JSON.parse(c.sandboxVaultCaps) as { token: string; cap: string; mandate_cap: string }[];
    if (!Array.isArray(parsed)) throw new Error("NP_SANDBOX_VAULT_CAPS must be a JSON array");
    caps = allowed.map((token) => {
      const e = parsed.find((x) => x.token === token);
      if (!e) throw new Error(`NP_SANDBOX_VAULT_CAPS: no caps for ${token}`);
      if (!/^(0|[1-9][0-9]{0,38})$/.test(e.cap) || !/^(0|[1-9][0-9]{0,38})$/.test(e.mandate_cap))
        throw new Error("NP_SANDBOX_VAULT_CAPS: caps are u128 decimal strings");
      return { token, cap: BigInt(e.cap), mandateCap: BigInt(e.mandate_cap) };
    });
  }
  for (const a of [c.sandboxVaultAccount, c.sandboxVaultFeeReceiver])
    if (!isValidAccountId(a)) throw new Error(`invalid NEAR account ${a}`);
  return {
    account: c.sandboxVaultAccount,
    allowedTokens: allowed,
    feeReceiver: c.sandboxVaultFeeReceiver,
    maxFeeBps: 500,
    intentsAccount: "intents.near",
    caps,
  };
}

interface Block {
  readonly height: bigint;
  readonly hash: string;
  readonly timestampNs: bigint;
}

const blockHashOf = (height: bigint) => bs58.encode(sha256(enc.encode(`sandbox block:${height}`)));

async function newBlock(tx: Tx): Promise<Block> {
  const height = await nextBlock(tx);
  const now = await dbNow(tx);
  return { height, hash: blockHashOf(height), timestampNs: BigInt(now.getTime()) * NS_PER_MS };
}

/** The latest simulated block without allocating one (views, `block`, access keys). */
async function headBlock(db: Sandbox["db"] | Tx): Promise<Block> {
  const r = await sql<{ h: string }>`select last_value::text as h from sim_block_height`.execute(db);
  const height = BigInt((r.rows[0] as { h: string }).h);
  const now = await dbNow(db);
  return { height, hash: blockHashOf(height), timestampNs: BigInt(now.getTime()) * NS_PER_MS };
}

interface Execution {
  readonly signer: string;
  readonly receiver: string;
  readonly method: string;
  readonly args: Uint8Array;
  readonly deposit: bigint;
  readonly gas: bigint;
  readonly mint?: { token: string; account: string; amount: bigint };
}

/** Runs one transaction through the stand-in and stores everything it produced. Caller holds the lock. */
async function execute(sb: Sandbox, tx: Tx, e: Execution, meta: Omit<TxMeta, "receiver" | "signer"> | null) {
  const block = await newBlock(tx);
  const state = new VaultState(dbVaultLoader(tx));
  const hash =
    meta?.hash ??
    bs58.encode(
      sha256(
        enc.encode(
          `sandbox unsigned:${block.height}:${e.signer}:${e.receiver}:${e.method}:${Buffer.from(e.args).toString("base64")}`,
        ),
      ),
    );
  const r = await executeVaultTx({
    vault: sb.vault,
    state,
    blockTimestampNs: block.timestampNs,
    blockHash: block.hash,
    tx: {
      hash,
      signer: e.signer,
      receiver: e.receiver,
      publicKey: meta?.publicKey ?? ZERO_KEY,
      nonce: meta?.nonce ?? 0n,
      signature: meta?.signature ?? ZERO_SIG,
      priorityFee: meta?.priorityFee ?? 0n,
    },
    entry: { ...e, ...(e.mint ? { mint: e.mint } : {}) },
  });
  await persistVault(tx, state);
  await appendReceiptLines(
    tx,
    { txHash: hash, block: block.height, blockHash: block.hash, blockTimestampNs: block.timestampNs },
    r.feed,
  );
  await tx
    .insertInto("sim_near_txs")
    .values({ hash, signer_id: e.signer, outcome: JSON.stringify(r.outcome) })
    .onConflict((oc) => oc.column("hash").doNothing())
    .execute();
  sb.log.info(
    {
      tx: hash,
      signer: e.signer,
      receiver: e.receiver,
      method: e.method,
      status: Object.keys(r.status)[0],
      lines: r.feed.length,
    },
    "sandbox vault transaction",
  );
  return r.outcome;
}

function lock(tx: Tx) {
  return sql`select pg_advisory_xact_lock(hashtext(${LOCK}))`.execute(tx);
}

const EXIT_METHODS = new Set(["cancel", "withdraw", "storage_withdraw", "storage_unregister"]);

/** `POST /sim/vault/call`: a change call as `signer`, unsigned (defaults per sandbox §3.1). */
export async function vaultCall(
  sb: Sandbox,
  b: {
    signer: string;
    method: string;
    args: Record<string, unknown>;
    gas?: string | undefined;
    deposit?: string | undefined;
  },
) {
  const gas = b.gas !== undefined ? BigInt(b.gas) : b.method === "collect" ? 250n * TGAS : 100n * TGAS;
  if (gas > MAX_TOTAL_PREPAID_GAS) throw ApiError.invalid("gas exceeds the 1 PGas prepaid-gas limit", "gas");
  const deposit = b.deposit !== undefined ? BigInt(b.deposit) : EXIT_METHODS.has(b.method) ? 1n : 0n;
  if (deposit > U128_MAX) throw ApiError.invalid("deposit exceeds u128", "deposit");
  if (!isValidAccountId(b.signer)) throw ApiError.invalid("signer is not a valid NEAR account", "signer");
  return withTx(sb.db, async (tx) => {
    await lock(tx);
    return execute(
      sb,
      tx,
      {
        signer: b.signer,
        receiver: sb.vault.account,
        method: b.method,
        args: enc.encode(JSON.stringify(b.args)),
        deposit,
        gas,
      },
      null,
    );
  });
}

/** `POST /sim/vault/ft_transfer_call`: the payer's `ft_transfer_call` to the vault; the faucet mints any shortfall. */
export async function vaultFtTransferCall(
  sb: Sandbox,
  b: { payer: string; token: string; amount: string; msg: string },
) {
  const amount = BigInt(b.amount);
  if (amount <= 0n) throw ApiError.invalid("amount must be positive", "amount");
  if (amount > U128_MAX) throw ApiError.invalid("amount exceeds u128", "amount");
  if (!isValidAccountId(b.payer)) throw ApiError.invalid("payer is not a valid NEAR account", "payer");
  if (!isValidAccountId(b.token)) throw ApiError.invalid("token is not a valid NEAR account", "token");
  return withTx(sb.db, async (tx) => {
    await lock(tx);
    const have = await dbVaultLoader(tx).ft(b.token, b.payer);
    return execute(
      sb,
      tx,
      {
        signer: b.payer,
        receiver: b.token,
        method: "ft_transfer_call",
        args: enc.encode(JSON.stringify({ receiver_id: sb.vault.account, amount: b.amount, memo: null, msg: b.msg })),
        deposit: 1n,
        gas: 100n * TGAS,
        ...(have < amount ? { mint: { token: b.token, account: b.payer, amount: amount - have } } : {}),
      },
      null,
    );
  });
}

/** `POST /sim/vault/advance`: moves one mandate's clock forward (sandbox §3.1). */
export async function vaultAdvance(sb: Sandbox, b: { mandate_id: number; secs?: number | undefined }) {
  return withTx(sb.db, async (tx) => {
    await lock(tx);
    const id = BigInt(b.mandate_id);
    const rec = await dbVaultLoader(tx).mandate(id);
    if (rec?.m.status !== "active") throw ApiError.missing("mandate", String(b.mandate_id), "mandate_id");
    const nowNs = BigInt((await dbNow(tx)).getTime()) * NS_PER_MS;
    const next = dueAt(rec.m.start_at_ns, rec.m.collected_periods, rec.m.period_secs);
    let offset = rec.clockOffsetS;
    if (b.secs !== undefined) offset += BigInt(b.secs);
    else if (next !== null) {
      // exactly up to next_collect_at (ceil to whole seconds); no-op when already due
      const needed = next > nowNs ? (next - nowNs + 999_999_999n) / 1_000_000_000n : 0n;
      if (needed > offset) offset = needed;
    }
    if (offset !== rec.clockOffsetS)
      await tx
        .updateTable("sim_vault_mandates")
        .set({ clock_offset_s: offset.toString(), updated_at: new Date() })
        .where("mandate_id", "=", id as never)
        .execute();
    sb.log.info({ mandate: b.mandate_id, offset: offset.toString() }, "sandbox vault clock advanced");
    return {
      mandate_id: b.mandate_id,
      clock_offset_secs: Number(offset),
      now_ns: (nowNs + offset * 1_000_000_000n).toString(),
      next_collect_at: next === null ? null : next.toString(),
    };
  });
}

// =============================================================================================
// NEAR JSON-RPC subset (`POST /sim/near-rpc`)
// =============================================================================================

type RpcId = string | number;

function rpcError(id: RpcId, cause: string, info: Record<string, unknown>, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      name: "HANDLER_ERROR",
      cause: { name: cause, info },
      code: -32000,
      message: "Server error",
      data: data ?? message,
    },
  };
}

function invalidTx(id: RpcId, variant: Record<string, unknown>) {
  return rpcError(id, "INVALID_TRANSACTION", variant, "invalid transaction", {
    TxExecutionError: { InvalidTxError: variant },
  });
}

const tokenAccountArgs = struct([field("account_id", accountId)] as const, { denyUnknown: false });

async function isToken(sb: Sandbox, tx: Tx, account: string): Promise<boolean> {
  if (sb.vault.config.allowedTokens.includes(account)) return true;
  return (
    (await tx
      .selectFrom("sim_ft_balances")
      .select("token")
      .where("token", "=", account)
      .limit(1)
      .executeTakeFirst()) !== undefined
  );
}

export type NearRpcBody =
  | { jsonrpc: "2.0"; id: RpcId; method: "block"; params: { finality: string } }
  | {
      jsonrpc: "2.0";
      id: RpcId;
      method: "query";
      params:
        | {
            request_type: "call_function";
            finality: string;
            account_id: string;
            method_name: string;
            args_base64: string;
          }
        | { request_type: "view_access_key"; finality: string; account_id: string; public_key: string };
    }
  | {
      jsonrpc: "2.0";
      id: RpcId;
      method: "send_tx";
      params: { signed_tx_base64: string; wait_until?: string | undefined };
    }
  | { jsonrpc: "2.0"; id: RpcId; method: "broadcast_tx_commit"; params: [string] }
  | {
      jsonrpc: "2.0";
      id: RpcId;
      method: "tx";
      params: { tx_hash: string; sender_account_id: string; wait_until?: string | undefined };
    };

export async function nearRpc(sb: Sandbox, body: NearRpcBody): Promise<Record<string, unknown>> {
  const id = body.id;
  switch (body.method) {
    case "block": {
      const b = await headBlock(sb.db);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          author: "sandbox.near",
          header: {
            height: Number(b.height),
            hash: b.hash,
            timestamp_nanosec: b.timestampNs.toString(),
            timestamp: Number(b.timestampNs),
          },
          chunks: [],
        },
      };
    }
    case "query":
      return body.params.request_type === "call_function"
        ? callFunction(sb, id, body.params)
        : viewAccessKey(sb, id, body.params);
    case "send_tx":
      return sendTx(sb, id, body.params.signed_tx_base64);
    case "broadcast_tx_commit":
      return sendTx(sb, id, body.params[0]);
    case "tx": {
      const row = await sb.db
        .selectFrom("sim_near_txs")
        .select("outcome")
        .where("hash", "=", body.params.tx_hash)
        .where("signer_id", "=", body.params.sender_account_id)
        .executeTakeFirst();
      if (!row)
        return rpcError(
          id,
          "UNKNOWN_TRANSACTION",
          { requested_transaction_hash: body.params.tx_hash },
          `Transaction ${body.params.tx_hash} doesn't exist`,
        );
      return { jsonrpc: "2.0", id, result: row.outcome };
    }
  }
}

async function callFunction(
  sb: Sandbox,
  id: RpcId,
  p: { account_id: string; method_name: string; args_base64: string },
): Promise<Record<string, unknown>> {
  return withTx(sb.db, async (tx) => {
    const b = await headBlock(tx);
    const at = { block_height: Number(b.height), block_hash: b.hash };
    const args = new Uint8Array(Buffer.from(p.args_base64, "base64"));
    const ok = (json: string) => ({ jsonrpc: "2.0", id, result: { result: [...enc.encode(json)], logs: [], ...at } });
    const vmError = (vm_error: string) =>
      rpcError(id, "CONTRACT_EXECUTION_ERROR", { vm_error, ...at }, `wasm execution failed with error: ${vm_error}`);
    try {
      if (p.account_id === sb.vault.account)
        return ok(await sb.vault.view(new VaultState(dbVaultLoader(tx)), p.method_name, args));
      if (await isToken(sb, tx, p.account_id)) {
        if (p.method_name !== "ft_balance_of" && p.method_name !== "storage_balance_of")
          throw new MethodNotFound(p.method_name);
        let account: string;
        try {
          [account] = tokenAccountArgs(parseJson(args));
        } catch (e) {
          if (e instanceof SerdeError) throw new ContractPanic("Failed to deserialize input from JSON.");
          throw e;
        }
        if (p.method_name === "storage_balance_of") return ok(TOKEN_STORAGE_BALANCE);
        return ok(`"${(await dbVaultLoader(tx).ft(p.account_id, account)).toString()}"`);
      }
    } catch (e) {
      if (e instanceof MethodNotFound) return vmError("MethodResolveError(MethodNotFound)");
      if (e instanceof ContractPanic)
        return vmError(`HostError(GuestPanic { panic_msg: ${JSON.stringify(e.message)} })`);
      throw e;
    }
    return rpcError(
      id,
      "UNKNOWN_ACCOUNT",
      { requested_account_id: p.account_id, ...at },
      `account ${p.account_id} does not exist while viewing`,
    );
  });
}

async function viewAccessKey(
  sb: Sandbox,
  id: RpcId,
  p: { account_id: string; public_key: string },
): Promise<Record<string, unknown>> {
  const b = await headBlock(sb.db);
  const at = { block_height: Number(b.height), block_hash: b.hash };
  const keys = await sb.db
    .selectFrom("sim_access_keys")
    .select(["public_key", "nonce"])
    .where("account_id", "=", p.account_id)
    .execute();
  const implicit = implicitKeyOf(p.account_id);
  const mine = keys.find((k) => k.public_key === p.public_key);
  // A key is usable when it is registered, or when it would register on first use (no key yet for a named
  // account; the account's own key for an implicit account).
  const usable = mine !== undefined || (implicit !== null ? implicit === p.public_key : keys.length === 0);
  if (!usable)
    return rpcError(
      id,
      "UNKNOWN_ACCESS_KEY",
      { public_key: p.public_key, ...at },
      `access key ${p.public_key} does not exist while viewing`,
    );
  return { jsonrpc: "2.0", id, result: { nonce: mine ? Number(mine.nonce) : 0, permission: "FullAccess", ...at } };
}

async function sendTx(sb: Sandbox, id: RpcId, signedBase64: string): Promise<Record<string, unknown>> {
  let t: DecodedTx;
  try {
    t = decodeSignedTx(signedBase64);
  } catch (e) {
    if (e instanceof TxDecodeError) return rpcError(id, "INVALID_TRANSACTION", { error_message: e.message }, e.message);
    throw e;
  }
  return withTx(sb.db, async (tx) => {
    await lock(tx);
    // A transaction that was already executed answers its outcome again (re-send after a transport error).
    const known = await tx.selectFrom("sim_near_txs").select("outcome").where("hash", "=", t.hash).executeTakeFirst();
    if (known) return { jsonrpc: "2.0", id, result: known.outcome };
    if (!isValidAccountId(t.signer_id)) return invalidTx(id, { InvalidSignerId: { signer_id: t.signer_id } });
    if (!isValidAccountId(t.receiver_id)) return invalidTx(id, { InvalidReceiverId: { receiver_id: t.receiver_id } });
    if (!signatureValid(t)) return invalidTx(id, { InvalidSignature: null });
    // Key: implicit accounts sign with their own key; a named account registers the first key that signs for it.
    const keys = await tx
      .selectFrom("sim_access_keys")
      .select(["public_key", "nonce"])
      .where("account_id", "=", t.signer_id)
      .forUpdate()
      .execute();
    const implicit = implicitKeyOf(t.signer_id);
    const mine = keys.find((k) => k.public_key === t.public_key);
    const usable = mine !== undefined || (implicit !== null ? implicit === t.public_key : keys.length === 0);
    if (!usable)
      return invalidTx(id, {
        InvalidAccessKeyError: { AccessKeyNotFound: { account_id: t.signer_id, public_key: t.public_key } },
      });
    const akNonce = mine ? BigInt(mine.nonce) : 0n;
    if (t.nonce <= akNonce)
      return invalidTx(id, { InvalidNonce: { tx_nonce: Number(t.nonce), ak_nonce: Number(akNonce) } });
    if (t.nonce > BigInt(Number.MAX_SAFE_INTEGER))
      return invalidTx(id, {
        NonceTooLarge: { tx_nonce: t.nonce.toString(), upper_bound: String(Number.MAX_SAFE_INTEGER) },
      });
    if (t.receiver_id !== sb.vault.account)
      return rpcError(
        id,
        "INVALID_TRANSACTION",
        { error_message: `the stand-in only executes calls to ${sb.vault.account}` },
        "unsupported receiver",
      );
    const action = t.actions[0];
    if (t.actions.length !== 1 || !action || action.kind !== "FunctionCall" || !("call" in action))
      return rpcError(
        id,
        "INVALID_TRANSACTION",
        { error_message: "the stand-in executes exactly one FunctionCall" },
        "unsupported actions",
      );
    const call = action.call;
    if (!(VAULT_CALL_METHODS as readonly string[]).includes(call.method_name))
      return rpcError(
        id,
        "INVALID_TRANSACTION",
        { error_message: `method ${call.method_name} is not served by the stand-in` },
        "unsupported method",
      );
    if (call.gas === 0n) return invalidTx(id, { ActionsValidation: { FunctionCallZeroAttachedGas: null } });
    if (call.gas > MAX_TOTAL_PREPAID_GAS)
      return invalidTx(id, {
        ActionsValidation: {
          TotalPrepaidGasExceeded: { total_prepaid_gas: Number(call.gas), limit: Number(MAX_TOTAL_PREPAID_GAS) },
        },
      });
    // the nonce is consumed by a valid transaction whatever its execution outcome
    await tx
      .insertInto("sim_access_keys")
      .values({ account_id: t.signer_id, public_key: t.public_key, nonce: t.nonce.toString() })
      .onConflict((oc) => oc.columns(["account_id", "public_key"]).doUpdateSet({ nonce: t.nonce.toString() }))
      .execute();
    const outcome = await execute(
      sb,
      tx,
      {
        signer: t.signer_id,
        receiver: t.receiver_id,
        method: call.method_name,
        args: call.args,
        deposit: call.deposit,
        gas: call.gas,
      },
      { hash: t.hash, publicKey: t.public_key, nonce: t.nonce, signature: t.signature, priorityFee: t.priority_fee },
    );
    return { jsonrpc: "2.0", id, result: outcome };
  });
}

export type { VaultContract };
