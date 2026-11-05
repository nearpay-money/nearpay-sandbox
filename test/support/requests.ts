/** Quote requests as rails' sandbox provider sends them. */
import type { SandboxQuoteRequest } from "@nearpay-internal/spec";

export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
export const ETH_BASE = "nep141:base.omft.near";
export const PAYER = "0x52908400098527886e0f7030069857d2e4169ee7";
export const MERCHANT = "merchant.near";
export const TREASURY = "treasury.nearpay.near";

export function quoteRequest(over: Partial<SandboxQuoteRequest> = {}): SandboxQuoteRequest {
  return {
    dry: false,
    depositMode: "SIMPLE",
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 50,
    originAsset: USDC_BASE,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_NEAR,
    amount: "2000017",
    refundTo: PAYER,
    refundType: "ORIGIN_CHAIN",
    recipient: MERCHANT,
    recipientType: "INTENTS",
    deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
    referral: "nearpay",
    appFees: [{ recipient: TREASURY, fee: 50 }],
    quoteWaitingTimeMs: 3000,
    scenario_amount: "200",
    ...over,
  };
}
