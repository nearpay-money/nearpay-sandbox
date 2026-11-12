/**
 * Fixed token registry of the sandbox (sandbox LLD §3 `GET /v0/tokens`): the real NEAR Intents
 * asset ids of USDC, USDT, ETH, wNEAR, SOL and BTC on NEAR, Base, Arbitrum, Ethereum, Solana and
 * Bitcoin (taken from 1Click `GET /v0/tokens`, 2026-11-05; Solana USDT from the spec 0.4.0 chain vectors,
 * sandbox LLD §10), with fixed USD prices so every quote is deterministic. Every `sol-` asset id satisfies
 * the SPL rule `nep141:sol-<hex(keccak256(mint)[12..32])>.omft.near` (or `sol-0x<hex>.omdep.near`).
 *
 * Since 2026-11 1Click also lists tokens under the `omdep` PoA bridge suffix (prefix aliases such as `bnb` for BNB
 * Smart Chain; spec `parseAssetId`, 0.5.2). Two live-list `omdep` entries are included so test mode exercises that
 * shape end to end: USDT on BNB Smart Chain and USD1 on Solana.
 */

export interface SandboxToken {
  readonly assetId: string;
  readonly decimals: number;
  /** 1Click `blockchain` code. */
  readonly blockchain: string;
  readonly symbol: string;
  /** Fixed USD price as a decimal string (exact arithmetic; never a float in money paths). */
  readonly priceUsd: string;
  readonly contractAddress?: string;
  readonly coingeckoId: string;
}

const t = (
  blockchain: string,
  symbol: string,
  decimals: number,
  priceUsd: string,
  assetId: string,
  coingeckoId: string,
  contractAddress?: string,
): SandboxToken => ({
  assetId,
  decimals,
  blockchain,
  symbol,
  priceUsd,
  coingeckoId,
  ...(contractAddress ? { contractAddress } : {}),
});

export const PRICES = { USD: "1", ETH: "2500", NEAR: "4", SOL: "150", BTC: "80000" } as const;

export const SANDBOX_TOKENS: readonly SandboxToken[] = Object.freeze([
  // NEAR
  t(
    "near",
    "USDC",
    6,
    PRICES.USD,
    "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    "usd-coin",
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  ),
  t("near", "USDT", 6, PRICES.USD, "nep141:usdt.tether-token.near", "tether", "usdt.tether-token.near"),
  t("near", "wNEAR", 24, PRICES.NEAR, "nep141:wrap.near", "wrapped-near", "wrap.near"),
  // Base
  t(
    "base",
    "USDC",
    6,
    PRICES.USD,
    "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    "usd-coin",
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  ),
  t("base", "ETH", 18, PRICES.ETH, "nep141:base.omft.near", "ethereum"),
  // Arbitrum
  t(
    "arb",
    "USDC",
    6,
    PRICES.USD,
    "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    "usd-coin",
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  ),
  t("arb", "ETH", 18, PRICES.ETH, "nep141:arb.omft.near", "ethereum"),
  // Ethereum
  t(
    "eth",
    "USDC",
    6,
    PRICES.USD,
    "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    "usd-coin",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  ),
  t(
    "eth",
    "USDT",
    6,
    PRICES.USD,
    "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    "tether",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
  ),
  t("eth", "ETH", 18, PRICES.ETH, "nep141:eth.omft.near", "ethereum"),
  // Solana
  t(
    "sol",
    "USDC",
    6,
    PRICES.USD,
    "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    "usd-coin",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  ),
  t(
    "sol",
    "USDT",
    6,
    PRICES.USD,
    "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near",
    "tether",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  ),
  t("sol", "SOL", 9, PRICES.SOL, "nep141:sol.omft.near", "solana"),
  // Bitcoin
  t("btc", "BTC", 8, PRICES.BTC, "nep141:btc.omft.near", "bitcoin"),
  // omdep (2026-11, live 1Click list): USDT on BNB Smart Chain (prefix bnb, blockchain bsc), USD1 on Solana
  t(
    "bsc",
    "USDT",
    18,
    PRICES.USD,
    "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near",
    "tether",
    "0x55d398326f99059ff775485246999027b3197955",
  ),
  t(
    "sol",
    "USD1",
    6,
    PRICES.USD,
    "nep141:sol-0x936420c6ae310eb29511d139991654f922456fbe.omdep.near",
    "usd1-wlfi",
    "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
  ),
]);

const BY_ID = new Map(SANDBOX_TOKENS.map((x) => [x.assetId, x]));

export function tokenById(assetId: string): SandboxToken | undefined {
  return BY_ID.get(assetId);
}
