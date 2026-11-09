/**
 * Integration harness: Postgres provisioned like nearpay-deploy's `postgres-init` (a migrator role that
 * owns the database and an app role with DML only), migrations applied as the migrator, and the
 * sandbox service running as the app role — so a migration that forgets a grant fails here, not in
 * Compose.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import {
  mintServiceToken,
  mintTestToken,
  provisionServiceDatabase,
  type Started,
  startPostgres,
  testKeySource,
} from "@nearpay-internal/testing";
import { createSandboxService } from "../../src/app/service.js";
import type { Config } from "../../src/config.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";

export interface Stack {
  readonly pg: Started;
  readonly database: Database<DB>;
  readonly service: ReturnType<typeof createSandboxService>["service"];
  readonly signingKey: KeyObject;
  readonly publicKey: KeyObject;
  /** `ed25519:<base58>` form of the sandbox key (what rails/sentinel pass to verifyQuoteSignature). */
  readonly managerPublicKey: string;
  readonly token: string;
  call(method: "GET" | "POST", url: string, body?: unknown, token?: string): Promise<{ status: number; body: unknown }>;
  stop(): Promise<void>;
}

export async function startStack(o: { timeScale?: number; tickMs?: number } = {}): Promise<Stack> {
  const pgc = await startPostgres({ database: "postgres" });
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pgc.url, "sandbox");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const database = createDb<DB>({ url: appUrl, applicationName: "sandbox-test" });
  const config: Config = {
    env: "test",
    logLevel: "silent",
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
    sandboxSigningKey: pem,
    sandboxTimeScale: o.timeScale ?? 0.01,
    sandboxTickMs: o.tickMs ?? 25,
    sandboxVaultAccount: "vault.sandbox.near",
    sandboxVaultFeeReceiver: "treasury.sandbox.near",
  };
  const { service } = createSandboxService({ config, keys: testKeySource(), database });
  await service.start();
  const token = await mintServiceToken("rails");
  const raw = publicKey.export({ format: "jwk" }).x as string;
  const { default: bs58 } = await import("bs58");
  const managerPublicKey = `ed25519:${bs58.encode(Buffer.from(raw, "base64url"))}`;

  return {
    pg: pgc,
    database,
    service,
    signingKey: privateKey,
    publicKey,
    managerPublicKey,
    token,
    async call(method, url, body, t) {
      const r = await service.app.inject({
        method,
        url,
        ...(body !== undefined ? { payload: body as object } : {}),
        headers: t === "" ? {} : { "x-nearpay-token": t ?? token },
      });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
    },
    async stop() {
      await service.stop();
      await database.close();
      await pgc.stop();
    },
  };
}

export { mintServiceToken, mintTestToken };
