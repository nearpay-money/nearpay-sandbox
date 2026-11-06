/** Configuration (lld/sandbox.md §6, foundations §13). */
import { baseConfigShape, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

export const configShape = {
  ...baseConfigShape,
  /** Database URL (app role for `api`, migrator role for `migrate`). */
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** Ed25519 PKCS#8 PEM; its public key is NP_SANDBOX_SIGNING_PUBKEY in rails and sentinel. */
  sandboxSigningKey: secret(z.string().includes("BEGIN PRIVATE KEY")),
  /** Multiplies every timeline offset (1.0 real time; the testbed may set 0.1). */
  sandboxTimeScale: z.coerce.number().positive().max(100).default(1),
  /** How often due timeline steps are materialised, ms. */
  sandboxTickMs: z.coerce.number().int().min(10).max(10_000).default(200),
};

export type Config = z.output<z.ZodObject<typeof configShape>>;

export const migrateShape = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
};

export function readConfig(env?: Record<string, string | undefined>): Config {
  return loadConfig(configShape, env ? { env } : {});
}
