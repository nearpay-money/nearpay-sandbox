/**
 * Process entry (foundations §15): `node dist/main.js api|migrate|healthcheck`.
 * - `api`      1Click mirror, simulated chains and Verifier, timeline materializer (sandbox LLD §2)
 * - `migrate`  applies kit + sandbox migrations with the migrator role (one-shot)
 */
import { createDb, migrate } from "@nearpay-internal/db";
import { loadConfig, runMain } from "@nearpay-internal/service";
import { migrateShape, readConfig } from "./config.js";
import { MIGRATIONS_DIR } from "./infra/db/migrations.js";

await runMain({
  api: async () => {
    const { createSandboxService } = await import("./app/service.js");
    return createSandboxService({ config: readConfig() }).service;
  },
  migrate: async () => {
    const config = loadConfig(migrateShape);
    const database = createDb({ url: config.dbUrl, applicationName: "sandbox-migrate" });
    try {
      const applied = await migrate(database.db, MIGRATIONS_DIR, (m) => process.stdout.write(`${m}\n`));
      process.stdout.write(`migrations up to date (${applied.length} applied)\n`);
    } finally {
      await database.close();
    }
    return undefined;
  },
});
