/**
 * The subscription vault's methods, ported rule for rule from `nearpay-contracts/contracts/subscription-vault/src/
 * lib.rs` (contracts-vault v1.6 §3.1–§3.8; read, not imported): the same check orders, the same `ERR_*` panics and
 * rejection log lines, the same state changes and the same receipts (merchant leg → fee leg → `on_collected`,
 * refund → `on_refunded`). near-sdk's method wrapper is reproduced too: non-payable methods refuse a deposit
 * ("Method … doesn't accept deposit"), arguments that do not deserialize panic with "Failed to deserialize input
 * from JSON.", `#[private]` callbacks refuse other callers.
 *
 * A method returns a value (the JSON bytes it serialises) or a promise chain the runtime executes
 * (`./runtime.ts`); a panic throws {@link ContractPanic} and the runtime reverts the receipt. The events are the
 * spec's `formatVaultEventLog` lines, which the contract test pins against `test-vectors/vault.json`.
 */
import { formatVaultEventLog, type VaultEvent } from "@nearpay-money/spec";
import { accountId } from "./account-id.js";
import { dueAt, maxBig, minBig, split } from "./math.js";
import { type CreateMandateMsg, MIN_PERIOD_SECS, parseMsg, validateCreate } from "./msg.js";
import {
  bool,
  type Decoder,
  field,
  option,
  parseJson,
  SerdeError,
  string,
  struct,
  U32_MAX,
  U64_MAX,
  U128_MAX,
  uint,
  uintString,
} from "./serde-json.js";
import {
  held,
  type Mandate,
  type MandateRecord,
  maxReached,
  type StorageAccount,
  type VaultConfig,
  type VaultState,
} from "./state.js";

export const TGAS = 1_000_000_000_000n;
export const MANDATE_STORAGE_COST = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
export const STORAGE_REGISTRATION_COST = 2_000_000_000_000_000_000_000n; // 0.002 NEAR
export const GAS_FT_TRANSFER = 15n * TGAS;
export const GAS_FT_TRANSFER_CALL = 100n * TGAS;
export const GAS_ON_MERCHANT_LEG = 50n * TGAS;
export const GAS_ON_COLLECTED = 20n * TGAS;
export const GAS_ON_REFUNDED = 20n * TGAS;
export const MIN_COLLECT_GAS = 170n * TGAS;
export const MIN_EXIT_GAS = 50n * TGAS;
/** Bytes read from a token's promise result (`MAX_RESULT_LEN`): longer success values are still successes. */
export const MAX_RESULT_LEN = 64;

export const ONE_YOCTO_MESSAGE = "Requires attached deposit of exactly 1 yoctoNEAR";
export const DESERIALIZE_MESSAGE = "Failed to deserialize input from JSON.";
export const REASON_MERCHANT_TRANSFER_FAILED = "merchant_transfer_failed";

/** A contract panic: the receipt fails with `Smart contract panicked: <message>` and its state changes revert. */
export class ContractPanic extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractPanic";
  }
}
/** The method does not exist on the contract (`MethodResolveError::MethodNotFound`). */
export class MethodNotFound extends Error {
  constructor(readonly method: string) {
    super(`MethodNotFound: ${method}`);
    this.name = "MethodNotFound";
  }
}

const panic = (message: string): never => {
  throw new ContractPanic(message);
};

export type PromiseResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false };

/** Simulation metadata on a cross-contract call: which leg of which mandate (scenario injection, sandbox §4.2). */
export interface LegTag {
  readonly leg: "merchant" | "fee" | "refund";
  readonly mandateId: bigint;
}

export interface Call {
  readonly receiver: string;
  readonly method: string;
  /** JSON arguments as sent. */
  readonly args: string;
  readonly deposit: bigint;
  readonly gas: bigint;
  readonly tag?: LegTag;
}

/** `first.then(then[0]).then(then[1])…`: each callback receives the previous call's result. */
export interface Chain {
  readonly first: Call;
  readonly callbacks: readonly Call[];
}

export type CallResult =
  | { readonly kind: "value"; readonly bytes: Uint8Array }
  | { readonly kind: "promise"; readonly chain: Chain };

/** Receipt context of a call (`env::*`). */
export interface ReceiptEnv {
  readonly predecessor: string;
  readonly signer: string;
  readonly deposit: bigint;
  readonly gas: bigint;
  /** Block time (ns): real time (creation clamps, `start_at` bound). */
  readonly blockTimestampNs: bigint;
  readonly promiseResults: readonly PromiseResult[];
  readonly logs: string[];
}

const enc = new TextEncoder();
const value = (json: string): CallResult => ({ kind: "value", bytes: enc.encode(json) });
const jsonU128 = (x: bigint) => `"${x.toString()}"`;

function decodeInput<T>(bytes: Uint8Array, d: Decoder<T>): T {
  try {
    return d(parseJson(bytes));
  } catch (e) {
    if (e instanceof SerdeError) return panic(DESERIALIZE_MESSAGE);
    throw e;
  }
}

const mandateIdArgs = struct([field("mandate_id", uint(U64_MAX))] as const, { denyUnknown: false });
const ftOnTransferArgs = struct(
  [field("sender_id", accountId), field("amount", uintString(U128_MAX)), field("msg", string)] as const,
  { denyUnknown: false },
);
const legArgs = struct(
  [
    field("mandate_id", uint(U64_MAX)),
    field("share", uintString(U128_MAX)),
    field("fee", uintString(U128_MAX)),
  ] as const,
  { denyUnknown: false },
);
const refundedArgs = struct(
  [
    field("mandate_id", uint(U64_MAX)),
    field("amount", uintString(U128_MAX)),
    field("canceled_by", option(accountId), { optional: true }),
  ] as const,
  { denyUnknown: false },
);
const storageDepositArgs = struct(
  [
    field("account_id", option(accountId), { optional: true }),
    field("registration_only", option(bool), { optional: true }),
  ] as const,
  { denyUnknown: false },
);
const storageWithdrawArgs = struct([field("amount", option(uintString(U128_MAX)), { optional: true })] as const, {
  denyUnknown: false,
});
const storageUnregisterArgs = struct([field("force", option(bool), { optional: true })] as const, {
  denyUnknown: false,
});
const payerArgs = struct(
  [
    field("payer", accountId),
    field("from_index", option(uint(U32_MAX)), { optional: true }),
    field("limit", option(uint(U32_MAX)), { optional: true }),
  ] as const,
  { denyUnknown: false },
);
const tokenArgs = struct([field("token", accountId)] as const, { denyUnknown: false });
const accountArgs = struct([field("account_id", accountId)] as const, { denyUnknown: false });

/** Change methods the stand-in exposes, with near-sdk's `#[payable]` marker. */
const PAYABLE = new Set(["cancel", "withdraw", "storage_deposit", "storage_withdraw", "storage_unregister"]);
const PRIVATE = new Set(["on_merchant_leg", "on_collected", "on_refunded"]);
const CHANGE_METHODS = new Set([...PAYABLE, ...PRIVATE, "ft_on_transfer", "collect"]);
export const VIEW_METHODS = [
  "get_mandate",
  "get_mandates_by_payer",
  "next_collect_at",
  "get_config",
  "get_token_tvl",
  "storage_balance_of",
  "storage_balance_bounds",
] as const;

function vaultEvent<N extends VaultEvent["event"]>(
  event: N,
  data: Extract<VaultEvent, { event: N }>["data"][0],
): string {
  return formatVaultEventLog({ standard: "nearpay_vault", version: "1.0.0", event, data: [data] } as VaultEvent);
}

/** `true` unless the single promise result failed (an over-long success is still a success). */
function transferSucceeded(env: ReceiptEnv): boolean {
  return env.promiseResults[0]?.ok !== false;
}

/** Merchant share actually delivered by the merchant leg (`merchant_leg_delivered`). */
function merchantLegDelivered(kind: Mandate["receiver_kind"], share: bigint, r: PromiseResult | undefined): bigint {
  if (!r?.ok) return 0n;
  if (r.bytes.length > MAX_RESULT_LEN) return share; // Err(TooLong) → treated as delivered
  if (kind === "near_account") return share;
  try {
    const used = uintString(U128_MAX)(parseJson(r.bytes));
    return minBig(used, share);
  } catch {
    return share; // unparseable success: assume the tokens left (V1)
  }
}

function storageAvailable(a: StorageAccount): bigint {
  const locked = STORAGE_REGISTRATION_COST + BigInt(a.mandates) * MANDATE_STORAGE_COST;
  return a.total > locked ? a.total - locked : 0n;
}

/**
 * The view's `next_collect_at` on the chain's (real) block time: the mandate's due time minus its stand-in clock offset
 * (sandbox §3.1). A keeper compares it with the block timestamp, which stays real, so an advanced mandate reads as
 * due exactly when `collect` stops answering ERR_NOT_DUE. Offset 0 (every contract vector) = the contract's value.
 */
function nextCollectAt(m: Mandate, clockOffsetS = 0n): bigint | null {
  if (m.status !== "active" || maxReached(m)) return null;
  const due = dueAt(m.start_at_ns, m.collected_periods, m.period_secs);
  return due === null ? null : due - clockOffsetS * 1_000_000_000n;
}

/** `MandateView` JSON in the contract's field order (`clockOffsetS`: the stand-in clock, see `nextCollectAt`). */
export function mandateViewJson(id: bigint, m: Mandate, clockOffsetS = 0n): string {
  const next = nextCollectAt(m, clockOffsetS);
  return JSON.stringify({
    mandate_id: Number(id),
    payer: m.payer,
    merchant_receiver: m.merchant_receiver,
    receiver_kind: m.receiver_kind,
    token: m.token,
    amount_per_period: m.amount_per_period.toString(),
    period_secs: Number(m.period_secs),
    start_at: m.start_at_ns.toString(),
    max_periods: m.max_periods,
    fee_bps: m.fee_bps,
    collected_periods: m.collected_periods,
    balance: m.balance.toString(),
    status: m.status,
    in_flight: m.in_flight,
    refund_in_flight: m.refund_in_flight.toString(),
    ext_ref: m.ext_ref,
    next_collect_at: next === null ? null : next.toString(),
  });
}

function storageBalanceJson(a: StorageAccount | null): string {
  return a === null ? "null" : JSON.stringify({ total: a.total.toString(), available: storageAvailable(a).toString() });
}

export class VaultContract {
  private readonly caps: ReadonlyMap<string, { cap: bigint; mandateCap: bigint }>;

  constructor(readonly config: VaultConfig) {
    this.caps = new Map(config.caps.map((c) => [c.token, { cap: c.cap, mandateCap: c.mandateCap }]));
  }

  get account(): string {
    return this.config.account;
  }

  isChangeMethod(method: string): boolean {
    return CHANGE_METHODS.has(method);
  }

  /** Executes a change method in a receipt (near-sdk wrapper rules first). */
  async call(s: VaultState, env: ReceiptEnv, method: string, args: Uint8Array): Promise<CallResult> {
    if (!CHANGE_METHODS.has(method)) throw new MethodNotFound(method);
    if (PRIVATE.has(method) && env.predecessor !== this.account) panic(`Method ${method} is private`);
    if (!PAYABLE.has(method) && env.deposit !== 0n) panic(`Method ${method} doesn't accept deposit`);
    switch (method) {
      case "ft_on_transfer": {
        const [sender, amount, msg] = decodeInput(args, ftOnTransferArgs);
        return value(jsonU128(await this.ftOnTransfer(s, env, sender, amount, msg)));
      }
      case "collect": {
        const [id] = decodeInput(args, mandateIdArgs);
        return this.collect(s, env, id);
      }
      case "on_merchant_leg": {
        const [id] = decodeInput(args, legArgs);
        return this.onMerchantLeg(s, env, id);
      }
      case "on_collected": {
        const [id, share] = decodeInput(args, legArgs);
        return value(String(await this.settleCollect(s, env, id, share, transferSucceeded(env))));
      }
      case "cancel": {
        const [id] = decodeInput(args, mandateIdArgs);
        return this.cancel(s, env, id);
      }
      case "withdraw": {
        const [id] = decodeInput(args, mandateIdArgs);
        return this.withdraw(s, env, id);
      }
      case "on_refunded": {
        const [id, amount, by] = decodeInput(args, refundedArgs);
        return value(String(await this.onRefunded(s, env, id, amount, by)));
      }
      case "storage_deposit": {
        const [account, registrationOnly] = decodeInput(args, storageDepositArgs);
        return value(await this.storageDeposit(s, env, account ?? env.predecessor, registrationOnly ?? false));
      }
      case "storage_withdraw": {
        const [amount] = decodeInput(args, storageWithdrawArgs);
        return value(await this.storageWithdraw(s, env, amount));
      }
      default: {
        decodeInput(args, storageUnregisterArgs);
        return value(String(await this.storageUnregister(s, env)));
      }
    }
  }

  /** A view call: the exact JSON the contract returns. */
  async view(s: VaultState, method: string, args: Uint8Array): Promise<string> {
    switch (method) {
      case "get_mandate": {
        const [id] = decodeInput(args, mandateIdArgs);
        const r = await s.mandate(id);
        return r ? mandateViewJson(id, r.m, r.clockOffsetS) : "null";
      }
      case "get_mandates_by_payer": {
        const [payer, from, limit] = decodeInput(args, payerArgs);
        const ids = await s.payerIndex(payer);
        const take = Math.min(Number(limit ?? 50n), 100);
        const page = ids.slice(Number(from ?? 0n), Number(from ?? 0n) + take);
        const views: string[] = [];
        for (const id of page) {
          const r = await s.mandate(id);
          if (r) views.push(mandateViewJson(id, r.m, r.clockOffsetS));
        }
        return `[${views.join(",")}]`;
      }
      case "next_collect_at": {
        const [id] = decodeInput(args, mandateIdArgs);
        const r = await s.mandate(id);
        const next = r ? nextCollectAt(r.m, r.clockOffsetS) : null;
        return next === null ? "null" : jsonU128(next);
      }
      case "get_config":
        return JSON.stringify({
          allowed_tokens: this.config.allowedTokens,
          fee_receiver: this.config.feeReceiver,
          max_fee_bps: this.config.maxFeeBps,
          intents_account: this.config.intentsAccount,
          min_period_secs: Number(MIN_PERIOD_SECS),
          caps: this.config.allowedTokens.map((t) => ({
            token: t,
            cap: (this.caps.get(t)?.cap ?? 0n).toString(),
            mandate_cap: (this.caps.get(t)?.mandateCap ?? 0n).toString(),
          })),
          mandate_storage_cost: MANDATE_STORAGE_COST.toString(),
          storage_registration_cost: STORAGE_REGISTRATION_COST.toString(),
        });
      case "get_token_tvl": {
        const [token] = decodeInput(args, tokenArgs);
        const cap = this.caps.get(token);
        if (!cap) return "null";
        return JSON.stringify({
          token,
          tvl: (await s.tvl(token)).toString(),
          cap: cap.cap.toString(),
          mandate_cap: cap.mandateCap.toString(),
        });
      }
      case "storage_balance_of": {
        const [account] = decodeInput(args, accountArgs);
        return storageBalanceJson(await s.storage(account));
      }
      case "storage_balance_bounds":
        return JSON.stringify({ min: STORAGE_REGISTRATION_COST.toString(), max: null });
      default:
        throw new MethodNotFound(method);
    }
  }

  // ------------------------------------------------------------------ funding

  private async ftOnTransfer(
    s: VaultState,
    env: ReceiptEnv,
    sender: string,
    amount: bigint,
    msg: string,
  ): Promise<bigint> {
    const token = env.predecessor;
    if (!this.config.allowedTokens.includes(token)) panic("ERR_TOKEN_NOT_ALLOWED");
    let result: string | null;
    if (sender === this.config.intentsAccount || sender === this.account || sender !== env.signer) {
      result = "ERR_UNSUPPORTED_SENDER";
    } else if (amount === 0n) {
      result = "ERR_BAD_MSG";
    } else {
      const parsed = parseMsg(msg);
      if (parsed === "ERR_BAD_MSG") result = parsed;
      else if ("create_mandate" in parsed)
        result = await this.internalCreate(s, env, token, sender, amount, parsed.create_mandate);
      else result = await this.internalTopUp(s, env, token, sender, amount, parsed.top_up.mandate_id);
    }
    if (result === null) return 0n;
    env.logs.push(result);
    return amount;
  }

  private mandateCapOf(token: string): bigint {
    return this.caps.get(token)?.mandateCap ?? 0n;
  }

  private async tvlAfterDeposit(
    s: VaultState,
    token: string,
    amount: bigint,
  ): Promise<bigint | "ERR_CAP_EXCEEDED: tvl"> {
    const cap = this.caps.get(token)?.cap ?? 0n;
    const t = (await s.tvl(token)) + amount;
    return t <= U128_MAX && t <= cap ? t : "ERR_CAP_EXCEEDED: tvl";
  }

  private async internalCreate(
    s: VaultState,
    env: ReceiptEnv,
    token: string,
    payer: string,
    amount: bigint,
    m: CreateMandateMsg,
  ): Promise<string | null> {
    const invalid = validateCreate(m, this.config.maxFeeBps, this.account, env.blockTimestampNs);
    if (invalid) return invalid;
    const acct = await s.storage(payer);
    if (!acct || storageAvailable(acct) < MANDATE_STORAGE_COST) return "ERR_NO_STORAGE";
    const mandateCap = this.mandateCapOf(token);
    if (m.amount_per_period > mandateCap || amount > mandateCap) return "ERR_CAP_EXCEEDED: mandate";
    const newTvl = await this.tvlAfterDeposit(s, token, amount);
    if (typeof newTvl === "string") return newTvl;
    // ---- all checks passed: mutate
    const now = env.blockTimestampNs;
    const startAt = m.start_at === null ? now : maxBig(m.start_at, now);
    const id = await s.nextId();
    s.setNextId(id + 1n);
    const mandate: Mandate = {
      payer,
      merchant_receiver: m.merchant_receiver,
      receiver_kind: m.receiver_kind,
      token,
      amount_per_period: m.amount_per_period,
      period_secs: m.period_secs,
      start_at_ns: startAt,
      max_periods: m.max_periods,
      fee_bps: m.fee_bps,
      collected_periods: 0,
      balance: amount,
      status: "active",
      in_flight: false,
      refund_in_flight: 0n,
      ext_ref: m.ext_ref,
    };
    env.logs.push(
      vaultEvent("mandate_created", {
        mandate_id: Number(id),
        payer,
        merchant_receiver: mandate.merchant_receiver,
        token,
        amount_per_period: mandate.amount_per_period.toString(),
        period_secs: Number(mandate.period_secs),
        start_at: startAt.toString(),
        max_periods: mandate.max_periods,
        fee_bps: mandate.fee_bps,
        ext_ref: mandate.ext_ref,
        receiver_kind: mandate.receiver_kind,
        balance: amount.toString(),
      }),
    );
    s.setMandate(id, { m: mandate, clockOffsetS: 0n, refundsFailed: 0 });
    s.setTvl(token, newTvl);
    s.setStorage(payer, { ...acct, mandates: acct.mandates + 1 });
    const ids = await s.payerIndex(payer);
    if (!ids.includes(id)) s.setPayerIndex(payer, [...ids, id]);
    return null;
  }

  private async internalTopUp(
    s: VaultState,
    env: ReceiptEnv,
    token: string,
    sender: string,
    amount: bigint,
    id: bigint,
  ): Promise<string | null> {
    const r = await s.mandate(id);
    if (!r) return "ERR_NOT_FOUND";
    const m = r.m;
    if (m.payer !== sender) return "ERR_UNAUTHORIZED";
    if (m.token !== token) return "ERR_TOKEN_NOT_ALLOWED";
    if (m.status !== "active") return "ERR_NOT_ACTIVE";
    const heldAfter = held(m) + amount;
    if (heldAfter > U128_MAX || heldAfter > this.mandateCapOf(token)) return "ERR_CAP_EXCEEDED: mandate";
    const newBalance = m.balance + amount;
    const newTvl = await this.tvlAfterDeposit(s, token, amount);
    if (typeof newTvl === "string") return newTvl;
    s.setTvl(token, newTvl);
    s.setMandate(id, { ...r, m: { ...m, balance: newBalance } });
    env.logs.push(
      vaultEvent("topped_up", { mandate_id: Number(id), amount: amount.toString(), balance: newBalance.toString() }),
    );
    return null;
  }

  // ------------------------------------------------------------------ collect

  private async collect(s: VaultState, env: ReceiptEnv, id: bigint): Promise<CallResult> {
    if (env.gas < MIN_COLLECT_GAS) panic("ERR_GAS");
    const r = (await s.mandate(id)) ?? panic("ERR_NOT_FOUND");
    const m = r.m;
    // The stand-in's per-mandate clock (sandbox §3.1): due checks run on this mandate's time.
    const now = env.blockTimestampNs + r.clockOffsetS * 1_000_000_000n;
    if (m.status === "exhausted") panic("ERR_MAX_PERIODS");
    if (m.status === "canceled") panic("ERR_NOT_ACTIVE");
    if (m.in_flight) panic("ERR_IN_FLIGHT");
    if (maxReached(m)) panic("ERR_MAX_PERIODS");
    const due = dueAt(m.start_at_ns, m.collected_periods, m.period_secs);
    if (due === null || now < due) panic("ERR_NOT_DUE");
    if (m.balance < m.amount_per_period) panic("ERR_INSUFFICIENT_BALANCE");
    const { share, fee } = split(m.amount_per_period, m.fee_bps);
    s.setMandate(id, { ...r, m: { ...m, balance: m.balance - m.amount_per_period, in_flight: true } });
    const tag = { leg: "merchant", mandateId: id } as const;
    const merchantLeg: Call =
      m.receiver_kind === "intents_account"
        ? {
            receiver: m.token,
            method: "ft_transfer_call",
            args: JSON.stringify({
              receiver_id: this.config.intentsAccount,
              amount: share.toString(),
              memo: null,
              msg: m.merchant_receiver,
            }),
            deposit: 1n,
            gas: GAS_FT_TRANSFER_CALL,
            tag,
          }
        : {
            receiver: m.token,
            method: "ft_transfer",
            args: JSON.stringify({ receiver_id: m.merchant_receiver, amount: share.toString(), memo: null }),
            deposit: 1n,
            gas: GAS_FT_TRANSFER,
            tag,
          };
    return {
      kind: "promise",
      chain: {
        first: merchantLeg,
        callbacks: [
          {
            receiver: this.account,
            method: "on_merchant_leg",
            args: JSON.stringify({ mandate_id: Number(id), share: share.toString(), fee: fee.toString() }),
            deposit: 0n,
            gas: GAS_ON_MERCHANT_LEG,
          },
        ],
      },
    };
  }

  private async onMerchantLeg(s: VaultState, env: ReceiptEnv, id: bigint): Promise<CallResult> {
    const r = await s.mandate(id);
    if (!r?.m.in_flight) return value("false");
    const m = r.m;
    const { share, fee } = split(m.amount_per_period, m.fee_bps);
    const used = merchantLegDelivered(m.receiver_kind, share, env.promiseResults[0]);
    if (used === share && fee > 0n) {
      return {
        kind: "promise",
        chain: {
          first: {
            receiver: m.token,
            method: "ft_transfer",
            args: JSON.stringify({ receiver_id: this.config.feeReceiver, amount: fee.toString(), memo: null }),
            deposit: 1n,
            gas: GAS_FT_TRANSFER,
            tag: { leg: "fee", mandateId: id },
          },
          callbacks: [
            {
              receiver: this.account,
              method: "on_collected",
              args: JSON.stringify({ mandate_id: Number(id), share: share.toString(), fee: fee.toString() }),
              deposit: 0n,
              gas: GAS_ON_COLLECTED,
            },
          ],
        },
      };
    }
    return value(String(await this.settleCollect(s, env, id, used, false)));
  }

  /** `settle_collect`: counts the period (or not) and credits back what was not paid out. */
  private async settleCollect(
    s: VaultState,
    env: ReceiptEnv,
    id: bigint,
    usedIn: bigint,
    feeSent: boolean,
  ): Promise<boolean> {
    const r = await s.mandate(id);
    if (!r?.m.in_flight) return false;
    let m = r.m;
    const amount = m.amount_per_period;
    const { share, fee } = split(amount, m.fee_bps);
    const used = minBig(usedIn, share);
    const feePaid = feeSent && used === share ? fee : 0n;
    const sent = used + feePaid;
    const period = m.collected_periods + 1;
    m = { ...m, balance: m.balance + amount - sent, in_flight: false };
    const counted = used > 0n;
    let exhausted = false;
    if (counted) {
      m = { ...m, collected_periods: period };
      env.logs.push(
        vaultEvent("collected", {
          mandate_id: Number(id),
          period,
          amount: sent.toString(),
          merchant_share: used.toString(),
          fee: feePaid.toString(),
          balance: m.balance.toString(),
        }),
      );
      if (m.status === "active" && maxReached(m)) {
        m = { ...m, status: "exhausted" };
        exhausted = true;
      }
    } else {
      env.logs.push(
        vaultEvent("collect_failed", { mandate_id: Number(id), period, reason: REASON_MERCHANT_TRANSFER_FAILED }),
      );
    }
    if (exhausted) env.logs.push(vaultEvent("exhausted", { mandate_id: Number(id) }));
    s.setMandate(id, { ...r, m });
    await this.subTvl(s, m.token, sent);
    await this.maybeClose(s, id);
    return counted;
  }

  // ------------------------------------------------------------------ exit

  private async cancel(s: VaultState, env: ReceiptEnv, id: bigint): Promise<CallResult> {
    if (env.gas < MIN_EXIT_GAS) panic("ERR_GAS");
    if (env.deposit !== 1n) panic(ONE_YOCTO_MESSAGE);
    const caller = env.predecessor;
    const r = (await s.mandate(id)) ?? panic("ERR_NOT_FOUND");
    const m = r.m;
    if (caller !== m.payer && caller !== m.merchant_receiver) panic("ERR_UNAUTHORIZED");
    if (m.status !== "active") panic("ERR_NOT_ACTIVE");
    if (m.balance === 0n) {
      s.setMandate(id, { ...r, m: { ...m, status: "canceled" } });
      env.logs.push(vaultEvent("canceled", { mandate_id: Number(id), by: caller, refunded: "0" }));
      await this.maybeClose(s, id);
      return value("true");
    }
    const refund = m.balance;
    s.setMandate(id, { ...r, m: { ...m, status: "canceled", balance: 0n, refund_in_flight: refund } });
    return { kind: "promise", chain: this.refundChain(m.token, m.payer, id, refund, caller) };
  }

  private async withdraw(s: VaultState, env: ReceiptEnv, id: bigint): Promise<CallResult> {
    if (env.gas < MIN_EXIT_GAS) panic("ERR_GAS");
    if (env.deposit !== 1n) panic(ONE_YOCTO_MESSAGE);
    const caller = env.predecessor;
    const r = (await s.mandate(id)) ?? panic("ERR_NOT_FOUND");
    const m = r.m;
    if (caller !== m.payer) panic("ERR_UNAUTHORIZED");
    if (m.status === "active") panic("ERR_STILL_ACTIVE");
    if (m.refund_in_flight > 0n) panic("ERR_IN_FLIGHT");
    if (m.balance === 0n) panic("ERR_INSUFFICIENT_BALANCE");
    const refund = m.balance;
    s.setMandate(id, { ...r, m: { ...m, balance: 0n, refund_in_flight: refund } });
    return { kind: "promise", chain: this.refundChain(m.token, m.payer, id, refund, null) };
  }

  private refundChain(token: string, payer: string, id: bigint, amount: bigint, canceledBy: string | null): Chain {
    return {
      first: {
        receiver: token,
        method: "ft_transfer",
        args: JSON.stringify({ receiver_id: payer, amount: amount.toString(), memo: null }),
        deposit: 1n,
        gas: GAS_FT_TRANSFER,
        tag: { leg: "refund", mandateId: id },
      },
      callbacks: [
        {
          receiver: this.account,
          method: "on_refunded",
          args: JSON.stringify({ mandate_id: Number(id), amount: amount.toString(), canceled_by: canceledBy }),
          deposit: 0n,
          gas: GAS_ON_REFUNDED,
        },
      ],
    };
  }

  private async onRefunded(
    s: VaultState,
    env: ReceiptEnv,
    id: bigint,
    amount: bigint,
    canceledBy: string | null,
  ): Promise<boolean> {
    const ok = transferSucceeded(env);
    const r = await s.mandate(id);
    if (!r) return false;
    let m = r.m;
    m = { ...m, refund_in_flight: m.refund_in_flight > amount ? m.refund_in_flight - amount : 0n };
    if (!ok) m = { ...m, balance: m.balance + amount };
    s.setMandate(id, { ...r, m });
    if (ok) await this.subTvl(s, m.token, amount);
    if (canceledBy !== null)
      env.logs.push(
        vaultEvent("canceled", { mandate_id: Number(id), by: canceledBy, refunded: (ok ? amount : 0n).toString() }),
      );
    else if (ok) env.logs.push(vaultEvent("withdrawn", { mandate_id: Number(id), amount: amount.toString() }));
    await this.maybeClose(s, id);
    return ok;
  }

  // ------------------------------------------------------------------ NEP-145 storage

  private async storageDeposit(
    s: VaultState,
    env: ReceiptEnv,
    account: string,
    registrationOnly: boolean,
  ): Promise<string> {
    const amount = env.deposit;
    const acct = await s.storage(account);
    if (acct) {
      if (!registrationOnly) s.setStorage(account, { ...acct, total: acct.total + amount });
    } else {
      if (amount < STORAGE_REGISTRATION_COST) panic("ERR_NO_STORAGE");
      s.setStorage(account, { total: registrationOnly ? STORAGE_REGISTRATION_COST : amount, mandates: 0 });
    }
    // NEAR refunds of the unused deposit are not modelled (sandbox §3.1: NEAR itself is unlimited).
    return storageBalanceJson(await s.storage(account));
  }

  private async storageWithdraw(s: VaultState, env: ReceiptEnv, amountArg: bigint | null): Promise<string> {
    if (env.deposit !== 1n) panic(ONE_YOCTO_MESSAGE);
    const account = env.predecessor;
    const acct = (await s.storage(account)) ?? panic("ERR_NO_STORAGE");
    const available = storageAvailable(acct);
    const amount = amountArg ?? available;
    if (amount > available) panic("ERR_INSUFFICIENT_BALANCE");
    s.setStorage(account, { ...acct, total: acct.total - amount });
    return storageBalanceJson(await s.storage(account));
  }

  private async storageUnregister(s: VaultState, env: ReceiptEnv): Promise<boolean> {
    if (env.deposit !== 1n) panic(ONE_YOCTO_MESSAGE);
    const account = env.predecessor;
    const acct = await s.storage(account);
    if (!acct) return false;
    if (acct.mandates > 0) panic("ERR_OPEN_MANDATES");
    s.setStorage(account, null);
    return true;
  }

  // ------------------------------------------------------------------ internals

  private async subTvl(s: VaultState, token: string, amount: bigint): Promise<void> {
    if (amount === 0n) return;
    const cur = await s.tvl(token);
    s.setTvl(token, cur > amount ? cur - amount : 0n);
  }

  /** Removes a closed, empty mandate with nothing in flight and releases its storage lock (`maybe_close`). */
  private async maybeClose(s: VaultState, id: bigint): Promise<void> {
    const r: MandateRecord | null = await s.mandate(id);
    if (!r) return;
    const m = r.m;
    if (m.status === "active" || m.in_flight || m.refund_in_flight !== 0n || m.balance !== 0n) return;
    s.setMandate(id, null);
    const ids = await s.payerIndex(m.payer);
    const at = ids.indexOf(id);
    if (at >= 0) {
      // near-sdk IterableSet::remove = swap_remove: the last id takes the removed slot
      const next = [...ids];
      const last = next.pop() as bigint;
      if (at < next.length) next[at] = last;
      s.setPayerIndex(m.payer, next);
    }
    const acct = await s.storage(m.payer);
    if (acct) s.setStorage(m.payer, { ...acct, mandates: acct.mandates > 0 ? acct.mandates - 1 : 0 });
  }
}
