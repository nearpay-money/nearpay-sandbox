/**
 * `POST /v0/quote` (sandbox LLD §3): validates like 1Click, prices with the fixed registry, issues a
 * deterministic deposit address in the origin chain's format, picks the scenario and signs the
 * response with the 1Click construction (`quoteHash` of `@defuse-protocol/one-click-sdk-typescript`:
 * Ed25519 over base58(sha256(stable-stringify({…request, …quote, timestamp})))), so rails and
 * sentinel verify sandbox quotes with the same `verifyQuoteSignature` call and the sandbox key.
 */
import { createHash, sign } from "node:crypto";
import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { NearAccountId } from "@nearpay/spec";
import { validateAddress } from "@nearpay-internal/chains";
import { canonicalJson, sql } from "@nearpay-internal/db";
import { uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { OneClickQuoteResponse, SandboxQuoteRequest } from "@nearpay-internal/spec";
import bs58 from "bs58";
import { formatted, QuoteMathError, quoteAmounts, usdValue } from "../domain/quote-math.js";
import { type SandboxToken, tokenById } from "../domain/tokens.js";
import { scenarioOf } from "../scenarios/scenario.js";
import { chainOf, depositAddress, depositMemo, intentsAccount } from "../simulated-chains/addresses.js";
import { NEAR_CHAIN } from "../simulated-chains/settlement.js";
import { dbNow, depositKey, type Sandbox } from "./context.js";

/** Indicative execution time per origin family, seconds (1Click `timeEstimate`). */
const TIME_ESTIMATE_S: Record<string, number> = { near: 5, evm: 20, solana: 10, bitcoin: 1200 };
/** Destination network cost in USD per chain (drives rails' destination minimums, rails §8.9). */
const WITHDRAW_FEE_USD: Record<string, string> = {
  "near:mainnet": "0.001",
  "eip155:1": "0.5",
  "eip155:8453": "0.02",
  "eip155:42161": "0.02",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "0.002",
  "bip122:000000000019d6689c085ae165831e93": "2",
};

const invalid = (detail: string, param?: string) => ApiError.invalid(detail, param);

function token(assetId: string, param: string): SandboxToken {
  const t = tokenById(assetId);
  if (!t) throw invalid(`${param} ${assetId} is not supported by the sandbox`, param);
  return t;
}

function checkAccountOrAddress(kind: string, value: string, chain: string, param: string): void {
  if (kind === "INTENTS") {
    if (!NearAccountId.safeParse(value).success) throw invalid(`${param} must be a NEAR Intents account`, param);
    return;
  }
  const r = validateAddress(chain, value);
  if (!r.ok) throw invalid(`${param} is not a valid address on ${chain}: ${r.reason}`, param);
}

/** Withdraw fee in destination base units: ceil(fee_usd / unit price). */
function withdrawFee(dest: SandboxToken, chain: string, intents: boolean): string {
  if (intents) return "0";
  const usd = WITHDRAW_FEE_USD[chain] ?? "0.01";
  // fee_usd × 10^decimals / price, rounded up (exact: both are decimal strings)
  const [ui = "0", uf = ""] = usd.split(".");
  const [pi = "0", pf = ""] = dest.priceUsd.split(".");
  const scale = Math.max(uf.length, pf.length);
  const u = BigInt(ui + uf.padEnd(scale, "0"));
  const p = BigInt(pi + pf.padEnd(scale, "0"));
  const num = u * 10n ** BigInt(dest.decimals);
  return ((num + p - 1n) / p).toString();
}

/** The request as 1Click echoes it (the sandbox-only `scenario_amount` is not part of the quote). */
function echo(req: SandboxQuoteRequest): OneClickQuoteResponse["quoteRequest"] {
  const { scenario_amount: _ignored, ...rest } = req;
  return rest as OneClickQuoteResponse["quoteRequest"];
}

export function signQuote(response: Omit<OneClickQuoteResponse, "signature">, key: Sandbox["signingKey"]): string {
  const hash = quoteHash({ ...response, signature: "" } as never);
  return `ed25519:${bs58.encode(sign(null, Buffer.from(hash, "utf8"), key))}`;
}

export async function createQuote(sb: Sandbox, req: SandboxQuoteRequest): Promise<OneClickQuoteResponse> {
  const origin = token(req.originAsset, "originAsset");
  const destination = token(req.destinationAsset, "destinationAsset");
  if (req.swapType !== "EXACT_INPUT" && req.swapType !== "EXACT_OUTPUT")
    throw invalid(`swapType ${req.swapType} is not supported by the sandbox`, "swapType");
  if (
    req.depositType === "CONFIDENTIAL_INTENTS" ||
    req.refundType === "CONFIDENTIAL_INTENTS" ||
    req.recipientType === "CONFIDENTIAL_INTENTS"
  )
    throw invalid("confidential intents are not supported by the sandbox");
  const originChain = chainOf(origin.blockchain);
  const destChain = req.recipientType === "INTENTS" ? NEAR_CHAIN : chainOf(destination.blockchain).caip2;
  checkAccountOrAddress(req.recipientType, req.recipient, destChain, "recipient");
  checkAccountOrAddress(
    req.refundType,
    req.refundTo,
    req.refundType === "INTENTS" ? NEAR_CHAIN : originChain.caip2,
    "refundTo",
  );
  const deadlineMs = Date.parse(req.deadline);
  if (!Number.isFinite(deadlineMs)) throw invalid("deadline must be an ISO 8601 timestamp", "deadline");
  const appFeeBps = (req.appFees ?? []).reduce((s, f) => s + BigInt(f.fee), 0n);
  if (appFeeBps > 500n) throw invalid("appFees must total at most 500 bps", "appFees");
  for (const f of req.appFees ?? []) {
    if (!NearAccountId.safeParse(f.recipient).success)
      throw invalid("appFees recipient must be a NEAR Intents account", "appFees");
  }

  let amounts: ReturnType<typeof quoteAmounts>;
  try {
    amounts = quoteAmounts({
      swapType: req.swapType,
      amount: BigInt(req.amount),
      origin,
      destination,
      appFeeBps,
      slippageBps: BigInt(req.slippageTolerance),
    });
  } catch (e) {
    if (e instanceof QuoteMathError) throw invalid(e.message, "amount");
    throw e;
  }

  const now = await dbNow(sb.db);
  if (!req.dry && deadlineMs <= now.getTime() + 60_000)
    throw invalid("deadline must be at least 60 seconds in the future", "deadline");
  const scenario = scenarioOf(req.scenario_amount ?? req.amount);
  const deadline = new Date(deadlineMs).toISOString();

  let seq: bigint | null = null;
  let address: string | undefined;
  let memo: string | undefined;
  if (!req.dry) {
    const r = await sql<{ s: string }>`select nextval('sim_quote_seq')::text as s`.execute(sb.db);
    seq = BigInt((r.rows[0] as { s: string }).s);
    const seed = `${seq}|${canonicalJson(echo(req))}`;
    address =
      req.depositType === "INTENTS"
        ? intentsAccount(seed)
        : depositAddress(originChain.family, seed, originChain.btc?.hrp ?? "bc");
    if (req.depositMode === "MEMO") memo = depositMemo(seed);
  }

  const quote: OneClickQuoteResponse["quote"] = {
    ...(address ? { depositAddress: address } : {}),
    ...(memo ? { depositMemo: memo } : {}),
    amountIn: amounts.amountIn.toString(),
    amountInFormatted: formatted(amounts.amountIn, origin),
    amountInUsd: usdValue(amounts.amountIn, origin),
    minAmountIn: amounts.minAmountIn.toString(),
    amountOut: amounts.amountOut.toString(),
    amountOutFormatted: formatted(amounts.amountOut, destination),
    amountOutUsd: usdValue(amounts.amountOut, destination),
    minAmountOut: amounts.minAmountOut.toString(),
    ...(req.dry ? {} : { deadline, timeWhenInactive: deadline }),
    timeEstimate: TIME_ESTIMATE_S[originChain.family] ?? 60,
    refundFee: "0",
    withdrawFee: withdrawFee(destination, destChain, req.recipientType === "INTENTS"),
  };
  const correlationId = uuidv7();
  const unsigned = { correlationId, timestamp: now.toISOString(), quoteRequest: echo(req), quote };
  const response: OneClickQuoteResponse = { ...unsigned, signature: signQuote(unsigned, sb.signingKey) };

  if (seq !== null && address) {
    const groupKey = createHash("sha256")
      .update([req.recipient, req.destinationAsset, req.refundTo, req.scenario_amount ?? req.amount].join("|"))
      .digest("hex");
    await sb.db
      .insertInto("sim_quotes")
      .values({
        deposit_key: depositKey(address, memo),
        seq: seq.toString(),
        deposit_address: address,
        deposit_memo: memo ?? null,
        correlation_id: correlationId,
        request: JSON.stringify(req),
        response: JSON.stringify(response),
        scenario,
        group_key: groupKey,
        origin_chain: req.depositType === "INTENTS" ? NEAR_CHAIN : originChain.caip2,
        destination_chain: destChain,
        amount_in: amounts.amountIn.toString(),
        min_amount_in: amounts.minAmountIn.toString(),
        amount_out: amounts.amountOut.toString(),
        deadline,
        state: "PENDING_DEPOSIT",
      })
      .execute();
    sb.log.info({ scenario, deposit: address, origin: req.originAsset }, "sandbox quote issued");
  }
  return response;
}
