/**
 * Spec route bindings (`@nearpay-internal/spec` sandbox routes, sandbox LLD §3). Every route needs a
 * service token with `sandbox.use` (checked by the service bootstrap from the spec); a principal in
 * live mode is refused (INV-8: live objects never reach the sandbox).
 */

import { ApiError, implement, type RequestContext, type RouteBinding } from "@nearpay-internal/service";
import {
  sandboxAdvance,
  sandboxExecuteIntents,
  sandboxExplorerTransactions,
  sandboxFundIntents,
  sandboxGetTx,
  sandboxIntentsEvents,
  sandboxNearRpc,
  sandboxQuote,
  sandboxSimulateDeposit,
  sandboxSimulateIntents,
  sandboxSimulateIntentsTransfer,
  sandboxStatus,
  sandboxSubmitDeposit,
  sandboxTokens,
  sandboxVaultAdvance,
  sandboxVaultCall,
  sandboxVaultFtTransferCall,
} from "@nearpay-internal/spec";
import type { Sandbox } from "../app/context.js";
import { getStatus, submitDeposit } from "../app/executions.js";
import { explorerTransactions } from "../app/explorer.js";
import { createQuote } from "../app/quotes.js";
import { type NearRpcBody, nearRpc, vaultAdvance, vaultCall, vaultFtTransferCall } from "../app/vault.js";
import { SANDBOX_TOKENS } from "../domain/tokens.js";
import { getChainTx } from "../simulated-chains/chain-txs.js";
import {
  executeIntents,
  fundIntents,
  intentsEvents,
  simulateIntents,
  simulateTransfer,
} from "../simulated-chains/verifier.js";
import { advance, simulateDeposit } from "../test-helpers/control.js";

/** INV-8: the sandbox serves test mode only. */
function testModeOnly(ctx: RequestContext): void {
  if (ctx.principal?.lm === true) throw new ApiError("livemode_forbidden");
}

export function sandboxRoutes(sb: Sandbox): RouteBinding[] {
  return [
    implement(sandboxTokens, async (ctx) => {
      testModeOnly(ctx);
      const at = new Date().toISOString();
      return SANDBOX_TOKENS.map((t) => ({
        assetId: t.assetId,
        decimals: t.decimals,
        blockchain: t.blockchain,
        symbol: t.symbol,
        price: Number(t.priceUsd),
        priceUpdatedAt: at,
        ...(t.contractAddress ? { contractAddress: t.contractAddress } : {}),
        coingeckoId: t.coingeckoId,
      }));
    }),
    implement(sandboxQuote, async (ctx) => {
      testModeOnly(ctx);
      return createQuote(sb, ctx.body);
    }),
    implement(sandboxStatus, async (ctx) => {
      testModeOnly(ctx);
      return getStatus(sb, ctx.query.depositAddress, ctx.query.depositMemo);
    }),
    implement(sandboxSubmitDeposit, async (ctx) => {
      testModeOnly(ctx);
      return submitDeposit(sb, ctx.body);
    }),
    implement(sandboxGetTx, async (ctx) => {
      testModeOnly(ctx);
      return getChainTx(sb, ctx.params.chain, ctx.params.hash);
    }),
    implement(sandboxSimulateDeposit, async (ctx) => {
      testModeOnly(ctx);
      await simulateDeposit(sb, ctx.body);
    }),
    implement(sandboxAdvance, async (ctx) => {
      testModeOnly(ctx);
      await advance(sb, ctx.body);
    }),
    implement(sandboxSimulateIntents, async (ctx) => {
      testModeOnly(ctx);
      return simulateIntents(sb, ctx.body.signed);
    }),
    implement(sandboxExecuteIntents, async (ctx) => {
      testModeOnly(ctx);
      return executeIntents(sb, ctx.body.signed);
    }),
    implement(sandboxFundIntents, async (ctx) => {
      testModeOnly(ctx);
      return fundIntents(sb, ctx.body);
    }),
    implement(sandboxIntentsEvents, async (ctx) => {
      testModeOnly(ctx);
      return intentsEvents(sb, ctx.query.cursor, ctx.query.limit);
    }),
    // Stage 2
    implement(sandboxSimulateIntentsTransfer, async (ctx) => {
      testModeOnly(ctx);
      return simulateTransfer(sb, ctx.body);
    }),
    implement(sandboxExplorerTransactions, async (ctx) => {
      testModeOnly(ctx);
      return explorerTransactions(sb, ctx.query);
    }),
    // Stage 4 — subscription-vault stand-in (sandbox LLD §3.1)
    implement(sandboxNearRpc, async (ctx) => {
      testModeOnly(ctx);
      return nearRpc(sb, ctx.body as NearRpcBody) as never;
    }),
    implement(sandboxVaultFtTransferCall, async (ctx) => {
      testModeOnly(ctx);
      return vaultFtTransferCall(sb, ctx.body) as never;
    }),
    implement(sandboxVaultCall, async (ctx) => {
      testModeOnly(ctx);
      return vaultCall(sb, ctx.body) as never;
    }),
    implement(sandboxVaultAdvance, async (ctx) => {
      testModeOnly(ctx);
      return vaultAdvance(sb, ctx.body);
    }),
  ];
}
