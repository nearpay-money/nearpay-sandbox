/**
 * Sandbox ops CLI (test mode only): `docker compose -p nearpay exec sandbox-api /nodejs/bin/node
 * dist/ops.js <command>`. Seeds simulated NEAR Intents balances for demos and E2E suites (an
 * `mt_mint` in the simulated ledger, exactly what `POST /sim/intents/fund` does). Prints one JSON
 * document; errors print `{"error": …}` and exit 1 (2: usage).
 */

import { withTx } from "@nearpay-internal/db";
import { NearAccountId } from "@nearpay-money/spec";
import type { Sandbox } from "../app/context.js";
import { balanceOf } from "../simulated-chains/intents-ledger.js";
import { fundIntents } from "../simulated-chains/verifier.js";

export const USAGE = `usage: ops.js <command> [arguments]

  intents-fund <account> <token> <amount>   credit a simulated Intents balance (base units)
  intents-balance <account> <token>         read a simulated Intents balance`;

class UsageError extends Error {}

const TOKEN = /^nep(141|245):[a-z0-9._:-]{2,200}$/;

function args3(a: readonly string[], n: number): string[] {
  if (a.length !== n) throw new UsageError(`expected ${n} arguments`);
  const [account, token, amount] = a as [string, string, string?];
  if (!NearAccountId.safeParse(account).success) throw new UsageError(`not a NEAR account id: ${account}`);
  if (!TOKEN.test(token)) throw new UsageError(`not an Intents token id (nep141:… / nep245:…): ${token}`);
  if (amount !== undefined && !/^[1-9][0-9]{0,77}$/.test(amount))
    throw new UsageError(`not a positive base-unit amount: ${amount}`);
  return a as string[];
}

export async function runOps(
  argv: readonly string[],
  sb: Sandbox,
  io: { out?: (l: string) => void; err?: (l: string) => void } = {},
): Promise<number> {
  const out = io.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = io.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  const [cmd, ...rest] = argv;
  try {
    let result: unknown;
    if (cmd === "intents-fund") {
      const [account, token, amount] = args3(rest, 3) as [string, string, string];
      result = { account, token, ...(await fundIntents(sb, { account_id: account, token, amount })) };
    } else if (cmd === "intents-balance") {
      const [account, token] = args3(rest, 2) as [string, string];
      const balance = await withTx(sb.db, (tx) => balanceOf(tx, account, token));
      result = { account, token, balance: balance.toString() };
    } else throw new UsageError(cmd ? `unknown command '${cmd}'` : "missing command");
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    err(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    return 1;
  }
}
