/** Dependencies shared by the sandbox use cases. */
import type { KeyObject } from "node:crypto";
import type { Kysely, Transaction } from "@nearpay-internal/db";
import { sql } from "@nearpay-internal/db";
import type { Logger } from "@nearpay-internal/service";
import type { VaultContract } from "../domain/vault/contract.js";
import type { DB } from "../infra/db/schema.js";

export interface Sandbox {
  readonly db: Kysely<DB>;
  /** Ed25519 private key that signs quotes (1Click construction; rails/sentinel verify it). */
  readonly signingKey: KeyObject;
  /** Multiplies every timeline offset. */
  readonly timeScale: number;
  readonly log: Logger;
  /** The subscription-vault stand-in (Stage 4, sandbox LLD §3.1). */
  readonly vault: VaultContract;
}

export type Tx = Transaction<DB>;

/** Database time (foundations §10: deadlines and transitions use the database clock). */
export async function dbNow(db: Kysely<DB> | Tx): Promise<Date> {
  const r = await sql<{ now: Date }>`select now() as now`.execute(db);
  return (r.rows[0] as { now: Date }).now;
}

/** Next simulated block height (a sequence: never reused, gaps allowed). */
export async function nextBlock(db: Kysely<DB> | Tx): Promise<bigint> {
  const r = await sql<{ h: string }>`select nextval('sim_block_height')::text as h`.execute(db);
  return BigInt((r.rows[0] as { h: string }).h);
}

/** `address|memo` — the identity of a quote, as 1Click identifies executions. */
export function depositKey(address: string, memo: string | null | undefined): string {
  return `${address}|${memo ?? ""}`;
}
