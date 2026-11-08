/**
 * Postgres adapter of the vault stand-in's state (migration 0003): the {@link VaultLoader} the pure contract reads
 * through and the persistence of a transaction's committed writes. Callers hold the vault lock for the whole
 * transaction (vault calls are serialised, the contract's single-threaded receipt order), so absolute writes are
 * safe; Intents credits go through the shared Verifier ledger as deltas.
 */
import { sql } from "@nearpay-internal/db";
import type { Tx } from "../../app/context.js";
import type { Mandate, MandateRecord, StorageAccount, VaultLoader, VaultState } from "../../domain/vault/state.js";
import { credit } from "../../simulated-chains/intents-ledger.js";

export function mandateToJson(m: Mandate): Record<string, unknown> {
  return {
    ...m,
    amount_per_period: m.amount_per_period.toString(),
    period_secs: m.period_secs.toString(),
    start_at_ns: m.start_at_ns.toString(),
    balance: m.balance.toString(),
    refund_in_flight: m.refund_in_flight.toString(),
  };
}

export function mandateFromJson(j: Record<string, unknown>): Mandate {
  const big = (k: string) => BigInt(j[k] as string);
  return {
    payer: j.payer as string,
    merchant_receiver: j.merchant_receiver as string,
    receiver_kind: j.receiver_kind as Mandate["receiver_kind"],
    token: j.token as string,
    amount_per_period: big("amount_per_period"),
    period_secs: big("period_secs"),
    start_at_ns: big("start_at_ns"),
    max_periods: (j.max_periods as number | null) ?? null,
    fee_bps: j.fee_bps as number,
    collected_periods: j.collected_periods as number,
    balance: big("balance"),
    status: j.status as Mandate["status"],
    in_flight: j.in_flight as boolean,
    refund_in_flight: big("refund_in_flight"),
    ext_ref: j.ext_ref as string,
  };
}

export function dbVaultLoader(tx: Tx): VaultLoader {
  let globals: Promise<{ next: bigint; tvl: Record<string, string> }> | null = null;
  const loadGlobals = () => {
    globals ??= tx
      .selectFrom("sim_vault_state")
      .select(["next_id", "tvl"])
      .executeTakeFirstOrThrow()
      .then((r) => ({ next: BigInt(r.next_id), tvl: r.tvl }));
    return globals;
  };
  return {
    async mandate(id) {
      if (id > 9_223_372_036_854_775_807n) return null;
      const r = await tx
        .selectFrom("sim_vault_mandates")
        .select(["state", "clock_offset_s", "refunds_failed"])
        .where("mandate_id", "=", id)
        .executeTakeFirst();
      return r
        ? { m: mandateFromJson(r.state), clockOffsetS: BigInt(r.clock_offset_s), refundsFailed: r.refunds_failed }
        : null;
    },
    async storage(account) {
      const r = await tx
        .selectFrom("sim_vault_storage")
        .select(["total", "mandates"])
        .where("account_id", "=", account)
        .executeTakeFirst();
      return r ? { total: BigInt(r.total), mandates: r.mandates } : null;
    },
    async payerIndex(payer) {
      const r = await tx
        .selectFrom("sim_vault_payer_index")
        .select("mandate_ids")
        .where("payer", "=", payer)
        .executeTakeFirst();
      return r ? r.mandate_ids.map((x) => BigInt(x)) : [];
    },
    async ft(token, account) {
      const r = await tx
        .selectFrom("sim_ft_balances")
        .select("amount")
        .where("token", "=", token)
        .where("account_id", "=", account)
        .executeTakeFirst();
      return r ? BigInt(r.amount) : 0n;
    },
    async nextId() {
      return (await loadGlobals()).next;
    },
    async tvl(token) {
      return BigInt((await loadGlobals()).tvl[token] ?? "0");
    },
  };
}

/** Persists the committed writes of a stand-in transaction (and its Intents credits). */
export async function persistVault(tx: Tx, s: VaultState): Promise<void> {
  const { changes, intents } = s.changes();
  const tvl: Record<string, string> = {};
  let nextId: bigint | null = null;
  for (const c of changes) {
    switch (c.kind) {
      case "mandate":
        await persistMandate(tx, c.id, c.value);
        break;
      case "storage":
        await persistStorage(tx, c.account, c.value);
        break;
      case "index":
        if (c.value.length === 0) await tx.deleteFrom("sim_vault_payer_index").where("payer", "=", c.payer).execute();
        else
          await tx
            .insertInto("sim_vault_payer_index")
            .values({ payer: c.payer, mandate_ids: JSON.stringify(c.value.map(String)) })
            .onConflict((oc) => oc.column("payer").doUpdateSet({ mandate_ids: JSON.stringify(c.value.map(String)) }))
            .execute();
        break;
      case "ft":
        await tx
          .insertInto("sim_ft_balances")
          .values({ token: c.token, account_id: c.account, amount: c.value.toString() })
          .onConflict((oc) => oc.columns(["token", "account_id"]).doUpdateSet({ amount: c.value.toString() }))
          .execute();
        break;
      case "nextId":
        nextId = c.value;
        break;
      case "tvl":
        tvl[c.token] = c.value.toString();
        break;
    }
  }
  if (nextId !== null || Object.keys(tvl).length > 0) {
    await sql`update sim_vault_state set
      next_id = coalesce(${nextId === null ? null : nextId.toString()}::bigint, next_id),
      tvl = tvl || ${JSON.stringify(tvl)}::jsonb`.execute(tx);
  }
  for (const i of intents) await credit(tx, i.account, i.tokenId, i.amount);
}

async function persistMandate(tx: Tx, id: bigint, r: MandateRecord | null): Promise<void> {
  if (!r) {
    await tx.deleteFrom("sim_vault_mandates").where("mandate_id", "=", id).execute();
    return;
  }
  const row = {
    state: JSON.stringify(mandateToJson(r.m)),
    clock_offset_s: r.clockOffsetS.toString(),
    refunds_failed: r.refundsFailed,
    updated_at: sql<Date>`now()` as unknown as Date,
  };
  await tx
    .insertInto("sim_vault_mandates")
    .values({ mandate_id: id.toString(), payer: r.m.payer, ...row })
    .onConflict((oc) => oc.column("mandate_id").doUpdateSet(row))
    .execute();
}

async function persistStorage(tx: Tx, account: string, v: StorageAccount | null): Promise<void> {
  if (!v) {
    await tx.deleteFrom("sim_vault_storage").where("account_id", "=", account).execute();
    return;
  }
  const row = { total: v.total.toString(), mandates: v.mandates };
  await tx
    .insertInto("sim_vault_storage")
    .values({ account_id: account, ...row })
    .onConflict((oc) => oc.column("account_id").doUpdateSet(row))
    .execute();
}
