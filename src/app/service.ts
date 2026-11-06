/** The `api` process: spec routes, readiness, and the timeline materializer (sandbox LLD §2). */
import { createPrivateKey } from "node:crypto";
import type { KeySource } from "@nearpay-internal/auth";
import { createDb, type Database, migrationStatus, sql } from "@nearpay-internal/db";
import { type BackgroundTask, createService, type Service } from "@nearpay-internal/service";
import { sandboxRoutes } from "../api/routes.js";
import type { Config } from "../config.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import type { Sandbox } from "./context.js";
import { materializeDue } from "./executions.js";

export interface SandboxServiceOptions {
  config: Config;
  /** Token verification (tests); default: identity's JWKS from NP_JWKS_URL. */
  keys?: KeySource;
  /** Existing database (tests); default: a pool from NP_DB_URL_FILE. */
  database?: Database<DB>;
}

function materializer(sb: Sandbox, tickMs: number): BackgroundTask {
  return {
    name: "materializer",
    start() {
      let stopped = false;
      let wake: (() => void) | null = null;
      const loop = (async () => {
        while (!stopped) {
          try {
            const n = await materializeDue(sb);
            if (n === 50) continue;
          } catch (e) {
            sb.log.error({ err: e }, "materializer tick failed");
          }
          await new Promise<void>((r) => {
            const t = setTimeout(r, tickMs);
            wake = () => {
              clearTimeout(t);
              r();
            };
          });
        }
      })();
      return {
        async stop() {
          stopped = true;
          (wake as (() => void) | null)?.();
          await loop;
        },
      };
    },
  };
}

export function createSandboxService(o: SandboxServiceOptions): { service: Service; sandbox: Sandbox } {
  const database = o.database ?? createDb<DB>({ url: o.config.dbUrl, applicationName: "sandbox-api" });
  // The bootstrap creates the logger, so the context gets it right after the service exists.
  const sb: { -readonly [K in keyof Sandbox]: Sandbox[K] } = {
    db: database.db,
    signingKey: createPrivateKey(o.config.sandboxSigningKey),
    timeScale: o.config.sandboxTimeScale,
    log: undefined as unknown as Sandbox["log"],
  };
  const service = createService({
    name: "sandbox",
    config: o.config,
    ...(o.keys ? { keys: o.keys } : {}),
    routes: sandboxRoutes(sb),
    readiness: {
      db: () => sql`select 1`.execute(database.db),
      migrations: async () => {
        const s = await migrationStatus(database.db, MIGRATIONS_DIR);
        if (s.pending.length || s.drift.length)
          throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
      },
    },
  });
  sb.log = service.log;
  service.addBackground(materializer(sb, o.config.sandboxTickMs));
  if (!o.database) service.onShutdown(() => database.close());
  return { service, sandbox: sb };
}
