/**
 * Ops CLI entry: `docker compose -p nearpay exec sandbox-api /nodejs/bin/node dist/ops.js …`.
 * Reads the api container's configuration; logs go to stderr, results to stdout.
 */
import { createPrivateKey } from "node:crypto";
import { createDb } from "@nearpay-internal/db";
import { ConfigError, createLogger } from "@nearpay-internal/service";
import { readConfig } from "./config.js";
import type { DB } from "./infra/db/schema.js";
import { runOps } from "./ops/cli.js";

let code = 1;
try {
  const config = readConfig();
  const log = createLogger({
    service: "sandbox-ops",
    env: config.env,
    level: config.logLevel,
    destination: process.stderr,
  });
  const database = createDb<DB>({ url: config.dbUrl, applicationName: "sandbox-ops" });
  try {
    code = await runOps(process.argv.slice(2), {
      db: database.db,
      signingKey: createPrivateKey(config.sandboxSigningKey),
      timeScale: config.sandboxTimeScale,
      log,
    });
  } finally {
    await database.close();
  }
} catch (e) {
  process.stderr.write(
    `${e instanceof ConfigError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
}
process.exit(code);
