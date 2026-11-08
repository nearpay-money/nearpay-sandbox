/**
 * Simulated NEAR Intents Verifier (sandbox LLD §3 `/sim/intents/*`): `simulate_intents` and
 * `execute_intents` over the simulated ledger with real signature checks (`@nearpay-internal/intents`
 * `verifySigned`) and the mainnet rejection messages (reference/landscape.md §1), so agentpay's error
 * mapping (`classifyVerifierError`) behaves the same in test and live mode.
 *
 * Rules per payload, in order (a batch is atomic, like one `execute_intents` receipt):
 *  1. signature verifies (NEP-413, ERC-191, raw ed25519) and the message is a Verifier message;
 *  2. `deadline` is in the future ("deadline has expired");
 *  3. the key may sign for `signer_id`: implicit accounts (64-hex, `0x…`) only with their own key;
 *     named accounts with a key registered earlier — the first key that signs for a named account is
 *     registered (the sandbox's stand-in for `add_public_key`);
 *  4. the nonce was not used by that account ("nonce was already used");
 *  5. only `transfer` intents; balances cover them ("insufficient balance or overflow").
 * The nonce salt is not checked (mainnet `simulate_intents` does not check it either).
 */

import { sql, withTx } from "@nearpay-internal/db";
import { erc191Hash, fromBase64, nep413Hash, verifySigned } from "@nearpay-internal/intents";
import { ApiError } from "@nearpay-internal/service";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { dbNow, nextBlock, type Sandbox, type Tx } from "../app/context.js";
import { attributeIntentsDeposits } from "../app/executions.js";
import { txHash } from "./addresses.js";
import {
  appendEvents,
  balanceOf,
  credit,
  DIP4_VERSION,
  debit,
  eventLog,
  mtMintLog,
  mtTransferLog,
} from "./intents-ledger.js";

const IMPLICIT_RE = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;
const enc = new TextEncoder();

export type VerifierFailureKind = "invalid" | "insufficient";

export class VerifierRejection extends Error {
  constructor(
    readonly kind: VerifierFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "VerifierRejection";
  }
}

const reject = (message: string, kind: VerifierFailureKind = "invalid"): never => {
  throw new VerifierRejection(kind, message);
};

interface Transfer {
  readonly from: string;
  readonly to: string;
  readonly tokens: [string, string][];
  readonly memo?: string | undefined;
}

export interface CheckedPayload {
  readonly signerId: string;
  readonly signer: string;
  readonly nonce: string;
  readonly intentHash: string;
  readonly transfers: readonly Transfer[];
  /** The key must be registered for the named account when the batch executes. */
  readonly registerKey: boolean;
}

function intentHash(payload: unknown): string {
  const p = payload as { standard: string; payload: unknown };
  if (p.standard === "nep413") {
    const n = p.payload as { message: string; nonce: string; recipient: string };
    return bs58.encode(nep413Hash(n.message, fromBase64(n.nonce), n.recipient));
  }
  if (p.standard === "erc191") return bs58.encode(erc191Hash(p.payload as string));
  return bs58.encode(sha256(enc.encode(p.payload as string)));
}

/** Balances as they evolve through a batch (simulation never writes). */
class Ledger {
  private readonly cache = new Map<string, bigint>();
  constructor(private readonly tx: Tx) {}
  private k(a: string, t: string) {
    return `${a}\u0000${t}`;
  }
  async get(a: string, t: string): Promise<bigint> {
    const key = this.k(a, t);
    if (!this.cache.has(key)) this.cache.set(key, await balanceOf(this.tx, a, t));
    return this.cache.get(key) as bigint;
  }
  async move(from: string, to: string, t: string, amount: bigint): Promise<void> {
    const have = await this.get(from, t);
    if (have < amount) reject("insufficient balance or overflow", "insufficient");
    this.cache.set(this.k(from, t), have - amount);
    this.cache.set(this.k(to, t), (await this.get(to, t)) + amount);
  }
}

async function check(
  tx: Tx,
  payload: unknown,
  nowMs: number,
  ledger: Ledger,
  seenNonces: Set<string>,
  keysRegistered: Map<string, Set<string>>,
): Promise<CheckedPayload> {
  const v = verifySigned(payload);
  if (!v.ok) return reject(v.reason === "invalid_signature" ? "invalid signature" : `invalid payload: ${v.detail}`);
  const m = v.message;
  if (Date.parse(m.deadline) <= nowMs) reject("deadline has expired");

  // Key authorization
  let registerKey = false;
  if (!v.implicitMatch) {
    if (IMPLICIT_RE.test(m.signer_id)) reject(`public key '${v.signer}' doesn't exist for account '${m.signer_id}'`);
    let keys = keysRegistered.get(m.signer_id);
    if (!keys) {
      const rows = await tx
        .selectFrom("sim_intents_keys")
        .select("public_key")
        .where("account_id", "=", m.signer_id)
        .execute();
      keys = new Set(rows.map((r) => r.public_key));
      keysRegistered.set(m.signer_id, keys);
    }
    if (keys.size === 0) {
      registerKey = true;
      keys.add(v.signer);
    } else if (!keys.has(v.signer)) {
      reject(`public key '${v.signer}' doesn't exist for account '${m.signer_id}'`);
    }
  }

  // Nonce
  const nonceKey = `${m.signer_id}\u0000${m.nonce}`;
  const used =
    seenNonces.has(nonceKey) ||
    (await tx
      .selectFrom("sim_intents_nonces")
      .select("nonce")
      .where("account_id", "=", m.signer_id)
      .where("nonce", "=", m.nonce)
      .executeTakeFirst()) !== undefined;
  if (used) reject("nonce was already used");
  seenNonces.add(nonceKey);

  // Intents
  const transfers: Transfer[] = [];
  for (const intent of m.intents) {
    if (intent.intent !== "transfer") reject(`unsupported intent: ${intent.intent}`);
    const t = intent as { receiver_id: string; tokens: Record<string, string>; memo?: string };
    const tokens = Object.entries(t.tokens);
    if (tokens.length === 0) reject("invalid payload: transfer without tokens");
    for (const [token, amount] of tokens) {
      if (BigInt(amount) <= 0n) reject("invalid payload: transfer amount must be positive");
      await ledger.move(m.signer_id, t.receiver_id, token, BigInt(amount));
    }
    transfers.push({ from: m.signer_id, to: t.receiver_id, tokens, memo: t.memo });
  }
  return {
    signerId: m.signer_id,
    signer: v.signer,
    nonce: m.nonce,
    intentHash: intentHash(payload),
    transfers,
    registerKey,
  };
}

async function checkBatch(tx: Tx, signed: readonly unknown[], nowMs: number): Promise<CheckedPayload[]> {
  const ledger = new Ledger(tx);
  const nonces = new Set<string>();
  const keys = new Map<string, Set<string>>();
  const out: CheckedPayload[] = [];
  for (const p of signed) out.push(await check(tx, p, nowMs, ledger, nonces, keys));
  return out;
}

function logsOf(checked: readonly CheckedPayload[]): string[] {
  const logs: string[] = [];
  for (const c of checked) {
    for (const t of c.transfers) {
      // Mainnet (SP-14, 2026-11-06): the NEP-245 mt_transfer of a `transfer` intent carries no memo;
      // the memo (the payment binding) appears only on the DIP-4 `transfer` event.
      logs.push(mtTransferLog({ from: t.from, to: t.to, tokens: t.tokens }));
      logs.push(
        eventLog("dip4", DIP4_VERSION, "transfer", [
          {
            intent_hash: c.intentHash,
            account_id: t.from,
            receiver_id: t.to,
            tokens: Object.fromEntries(t.tokens),
            ...(t.memo !== undefined ? { memo: t.memo } : {}),
          },
        ]),
      );
    }
    logs.push(
      eventLog("dip4", DIP4_VERSION, "intents_executed", [
        { intent_hash: c.intentHash, account_id: c.signerId, nonce: c.nonce },
      ]),
    );
  }
  return logs;
}

const executed = (checked: readonly CheckedPayload[]) =>
  checked.map((c) => ({ intent_hash: c.intentHash, account_id: c.signerId, nonce: c.nonce }));

/** The sandbox Verifier salt (any salt is accepted; see the module comment). */
export const SANDBOX_SALT = "5a0dbe11";

const LOCK = "sandbox:verifier";

/** `simulate_intents`: the outcome without changing anything; rejections become API errors. */
export async function simulateIntents(sb: Sandbox, signed: readonly unknown[]) {
  return withTx(sb.db, async (tx) => {
    const now = await dbNow(tx);
    let checked: CheckedPayload[];
    try {
      checked = await checkBatch(tx, signed, now.getTime());
    } catch (e) {
      if (e instanceof VerifierRejection) throw toApiError(e);
      throw e;
    }
    return {
      intents_executed: executed(checked),
      logs: logsOf(checked),
      min_deadline: minDeadline(signed),
      state: { fee: 0, current_salt: SANDBOX_SALT },
    };
  });
}

function minDeadline(signed: readonly unknown[]): string {
  let min = Number.POSITIVE_INFINITY;
  for (const p of signed) {
    const v = verifySigned(p);
    if (v.ok) min = Math.min(min, Date.parse(v.message.deadline));
  }
  return Number.isFinite(min) ? new Date(min).toISOString() : new Date(0).toISOString();
}

export function toApiError(e: VerifierRejection): ApiError {
  return e.kind === "insufficient"
    ? new ApiError("insufficient_balance", { message: `Smart contract panicked: ${e.message}` })
    : new ApiError("intent_invalid", { params: { reason: e.message } });
}

export type ExecuteOutcome = {
  tx_hash: string;
  block_height: number;
  status: "success" | "failure";
  failure: string | null;
  intents_executed: { intent_hash: string; account_id: string; nonce: string }[];
};

/**
 * `execute_intents`: one simulated transaction. A rejected payload fails the whole batch with the
 * Verifier's message and changes nothing (an on-chain failure, not an API error).
 */
export async function executeIntents(sb: Sandbox, signed: readonly unknown[]): Promise<ExecuteOutcome> {
  return withTx(sb.db, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${LOCK}))`.execute(tx);
    const now = await dbNow(tx);
    const block = await nextBlock(tx);
    const hash = txHash("near", `execute:${block}:${JSON.stringify(signed)}`);
    let checked: CheckedPayload[];
    try {
      checked = await checkBatch(tx, signed, now.getTime());
    } catch (e) {
      if (!(e instanceof VerifierRejection)) throw e;
      sb.log.info({ tx: hash, failure: e.message }, "sandbox execute_intents failed");
      return {
        tx_hash: hash,
        block_height: Number(block),
        status: "failure",
        failure: `Smart contract panicked: ${e.message}`,
        intents_executed: [],
      };
    }
    // Transfers into INTENTS deposit addresses are those quotes' deposits (quote rows locked before balances).
    const credits = checked.flatMap((c) =>
      c.transfers.flatMap((t) =>
        t.tokens.map(([token, amount]) => ({ from: t.from, to: t.to, token, amount: BigInt(amount), memo: t.memo })),
      ),
    );
    const deposits = await attributeIntentsDeposits(sb, tx, credits, hash, now);
    for (const c of checked) {
      for (const t of c.transfers) {
        for (const [token, amount] of t.tokens) {
          await debit(tx, t.from, token, BigInt(amount));
          await credit(tx, t.to, token, BigInt(amount));
        }
      }
      await tx.insertInto("sim_intents_nonces").values({ account_id: c.signerId, nonce: c.nonce }).execute();
      if (c.registerKey)
        await tx
          .insertInto("sim_intents_keys")
          .values({ account_id: c.signerId, public_key: c.signer })
          .onConflict((oc) => oc.doNothing())
          .execute();
    }
    await appendEvents(tx, hash, block, logsOf(checked));
    sb.log.info({ tx: hash, payloads: checked.length, deposits }, "sandbox execute_intents");
    return {
      tx_hash: hash,
      block_height: Number(block),
      status: "success",
      failure: null,
      intents_executed: executed(checked),
    };
  });
}

/** `POST /sim/intents/fund`: credits a simulated balance (an `mt_mint`, like a deposit into intents.near). */
export async function fundIntents(sb: Sandbox, b: { account_id: string; token: string; amount: string }) {
  return withTx(sb.db, async (tx) => {
    const amount = BigInt(b.amount);
    if (amount <= 0n) throw ApiError.invalid("amount must be positive", "amount");
    const block = await nextBlock(tx);
    const balance = await credit(tx, b.account_id, b.token, amount);
    await appendEvents(tx, txHash("near", `fund:${block}`), block, [
      mtMintLog(b.account_id, b.token, b.amount, "sandbox deposit"),
    ]);
    return { balance: balance.toString() };
  });
}

/**
 * `GET /sim/intents/events`: the simulated indexer feed, in commit order. `seq` is the commit-ordered position
 * (migration 0003), so a cursor never skips a line that committed late. Lines of vault stand-in receipts carry their
 * receipt context (Stage 4); Verifier lines keep the Stage 1 shape (absent executor = `intents.near`).
 */
export async function intentsEvents(sb: Sandbox, cursor: number, limit: number) {
  const rows = await sb.db
    .selectFrom("sim_intents_events")
    .select([
      "pos",
      "tx_hash",
      "block_height",
      "log",
      "receipt_id",
      "log_index",
      "executor_id",
      "block_hash",
      "block_timestamp",
      "receipt_status",
    ])
    .where("pos", ">", BigInt(cursor) as never)
    .orderBy("pos")
    .limit(limit)
    .execute();
  const events = rows.map((r) => ({
    seq: Number(r.pos),
    tx_hash: r.tx_hash,
    block_height: Number(r.block_height),
    log: r.log,
    ...(r.receipt_id !== null ? { receipt_id: r.receipt_id } : {}),
    ...(r.log_index !== null ? { log_index: r.log_index } : {}),
    ...(r.executor_id !== null ? { executor_id: r.executor_id } : {}),
    ...(r.block_hash !== null ? { block_hash: r.block_hash } : {}),
    ...(r.block_timestamp !== null ? { block_timestamp: r.block_timestamp } : {}),
    ...(r.receipt_status !== null ? { receipt_status: r.receipt_status } : {}),
  }));
  return { events, next_cursor: events.length ? (events[events.length - 1] as { seq: number }).seq : cursor };
}

/**
 * `POST /sim/intents/transfers` (Stage 2, payments' refund test helper): an executed transfer without a
 * signature. Credits `from` with any shortfall first (an `mt_mint`, like `/sim/intents/fund`), then moves `amount`
 * to `to` and emits what a signed execute emits — NEP-245 `mt_transfer` (no memo), DIP-4 `transfer` (with the memo,
 * the leg binding) and `intents_executed` (synthetic intent hash and nonce). A transfer into an INTENTS deposit
 * address is that quote's deposit (refund route legs), exactly as with a signed execute. Serialised with executes
 * (the Verifier lock), one transaction.
 */
export async function simulateTransfer(
  sb: Sandbox,
  b: { from: string; to: string; token: string; amount: string; memo?: string | undefined },
): Promise<{ tx_hash: string; block_height: number }> {
  const amount = BigInt(b.amount);
  if (amount <= 0n) throw ApiError.invalid("amount must be positive", "amount");
  if (b.from === b.to) throw ApiError.invalid("from and to must be different accounts", "to");
  return withTx(sb.db, async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${LOCK}))`.execute(tx);
    const now = await dbNow(tx);
    const block = await nextBlock(tx);
    const hash = txHash("near", `transfer:${block}`);
    const deposits = await attributeIntentsDeposits(
      sb,
      tx,
      [{ from: b.from, to: b.to, token: b.token, amount, memo: b.memo }],
      hash,
      now,
    );
    const logs: string[] = [];
    const shortfall = amount - (await balanceOf(tx, b.from, b.token));
    if (shortfall > 0n) {
      await credit(tx, b.from, b.token, shortfall);
      logs.push(mtMintLog(b.from, b.token, shortfall.toString(), "sandbox deposit"));
    }
    await debit(tx, b.from, b.token, amount);
    await credit(tx, b.to, b.token, amount);
    const intent = bs58.encode(sha256(enc.encode(`sandbox transfer:${hash}`)));
    const nonce = Buffer.from(sha256(enc.encode(`sandbox nonce:${hash}`))).toString("base64");
    logs.push(
      mtTransferLog({ from: b.from, to: b.to, tokens: [[b.token, amount.toString()]] }),
      eventLog("dip4", DIP4_VERSION, "transfer", [
        {
          intent_hash: intent,
          account_id: b.from,
          receiver_id: b.to,
          tokens: { [b.token]: amount.toString() },
          ...(b.memo !== undefined ? { memo: b.memo } : {}),
        },
      ]),
      eventLog("dip4", DIP4_VERSION, "intents_executed", [{ intent_hash: intent, account_id: b.from, nonce }]),
    );
    await appendEvents(tx, hash, block, logs);
    sb.log.info({ tx: hash, from: b.from, to: b.to, minted: shortfall > 0n, deposits }, "sandbox simulated transfer");
    return { tx_hash: hash, block_height: Number(block) };
  });
}
