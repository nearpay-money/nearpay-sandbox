/**
 * `ft_on_transfer` `msg` parsing and validation (`subscription-vault/src/msg.rs`, contracts-vault §3.1): the same
 * accepted shapes (serde derive, unknown and repeated fields rejected) and the same first-failure order.
 */
import { accountId } from "./account-id.js";
import { saturatingAddU64, split } from "./math.js";
import {
  field,
  option,
  parseJson,
  SerdeError,
  string,
  struct,
  U16_MAX,
  U32_MAX,
  U64_MAX,
  U128_MAX,
  uint,
  uintString,
  unitEnum,
  utf8Len,
} from "./serde-json.js";

export const MIN_PERIOD_SECS = 86_400n;
export const MAX_PERIOD_SECS = 12n * 366n * 86_400n;
export const MAX_MAX_PERIODS = 2_147_483_647;
export const MAX_START_DELAY_NS = 366n * 86_400n * 1_000_000_000n;
export const MAX_EXT_REF_LEN = 64;
export const MAX_MSG_LEN = 2_048;

export type ReceiverKind = "intents_account" | "near_account";
export const RECEIVER_KINDS = ["intents_account", "near_account"] as const;

export interface CreateMandateMsg {
  readonly merchant_receiver: string;
  readonly receiver_kind: ReceiverKind;
  readonly amount_per_period: bigint;
  readonly period_secs: bigint;
  readonly start_at: bigint | null;
  readonly max_periods: number | null;
  readonly fee_bps: number;
  readonly ext_ref: string;
}

export type VaultMsg = { readonly create_mandate: CreateMandateMsg } | { readonly top_up: { mandate_id: bigint } };

const createMandate = struct(
  [
    field("merchant_receiver", accountId),
    field("receiver_kind", unitEnum(RECEIVER_KINDS)),
    field("amount_per_period", uintString(U128_MAX)),
    field("period_secs", uint(U64_MAX)),
    field("start_at", option(uintString(U64_MAX)), { fallback: () => null }),
    field("max_periods", option(uint(U32_MAX)), { fallback: () => null }),
    field("fee_bps", uint(U16_MAX)),
    field("ext_ref", string),
  ] as const,
  { denyUnknown: true },
);

const topUp = struct([field("mandate_id", uint(U64_MAX))] as const, { denyUnknown: true });

/** `parse_msg`: any failure (too long, bad JSON, wrong shape) is `ERR_BAD_MSG`. */
export function parseMsg(msg: string): VaultMsg | "ERR_BAD_MSG" {
  if (utf8Len(msg) > MAX_MSG_LEN) return "ERR_BAD_MSG";
  try {
    const v = parseJson(msg);
    // externally tagged enum: exactly one key naming a newtype variant
    if (v.t !== "obj" || v.v.length !== 1) return "ERR_BAD_MSG";
    const [tag, inner] = v.v[0] as readonly [string, Parameters<typeof topUp>[0]];
    if (tag === "create_mandate") {
      const [merchant_receiver, receiver_kind, amount_per_period, period_secs, start_at, max_periods, fee, ext_ref] =
        createMandate(inner);
      return {
        create_mandate: {
          merchant_receiver,
          receiver_kind,
          amount_per_period,
          period_secs,
          start_at,
          max_periods: max_periods === null ? null : Number(max_periods),
          fee_bps: Number(fee),
          ext_ref,
        },
      };
    }
    if (tag === "top_up") {
      const [mandate_id] = topUp(inner);
      return { top_up: { mandate_id } };
    }
    return "ERR_BAD_MSG";
  } catch (e) {
    if (e instanceof SerdeError) return "ERR_BAD_MSG";
    throw e;
  }
}

/** ≤ 64 bytes of printable ASCII (0x20–0x7E). */
export function extRefIsValid(extRef: string): boolean {
  return utf8Len(extRef) <= MAX_EXT_REF_LEN && /^[\x20-\x7e]*$/.test(extRef);
}

/**
 * `validate_create` at block time `nowNs`: shape and range rules → `ERR_BAD_MSG`, then `fee_bps > max_fee_bps` →
 * `ERR_FEE_TOO_HIGH`, then a zero merchant share → `ERR_BAD_MSG`.
 */
export function validateCreate(
  m: CreateMandateMsg,
  maxFeeBps: number,
  vault: string,
  nowNs: bigint,
): null | "ERR_BAD_MSG" | "ERR_FEE_TOO_HIGH" {
  const startTooLate = m.start_at !== null && m.start_at > saturatingAddU64(nowNs, MAX_START_DELAY_NS);
  if (
    m.amount_per_period === 0n ||
    m.period_secs < MIN_PERIOD_SECS ||
    m.period_secs > MAX_PERIOD_SECS ||
    m.max_periods === 0 ||
    (m.max_periods !== null && m.max_periods > MAX_MAX_PERIODS) ||
    startTooLate ||
    !extRefIsValid(m.ext_ref) ||
    m.merchant_receiver === vault
  )
    return "ERR_BAD_MSG";
  if (m.fee_bps > maxFeeBps) return "ERR_FEE_TOO_HIGH";
  if (split(m.amount_per_period, m.fee_bps).share === 0n) return "ERR_BAD_MSG";
  return null;
}
