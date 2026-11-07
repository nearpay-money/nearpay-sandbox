/** Kysely table types of the sandbox database (migrations/0001_sandbox.sql, 0002_sandbox_stage2.sql). */
import type { ColumnType, Generated, KitTables } from "@nearpay-internal/db";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
/** numeric(78,0): read as a decimal string, written as a string (INV-5). */
type Numeric = ColumnType<string, string, string>;
type NullableNumeric = ColumnType<string | null, string | null | undefined, string | null>;
type Json<T> = ColumnType<T, string, string>;
type TextArray = ColumnType<string[], string[] | undefined, string[]>;

export interface StepRow {
  status: string;
  at: number;
  delivered?: string;
  refunded?: string;
  refundReason?: string;
}

export interface SimQuotesTable {
  deposit_key: string;
  seq: ColumnType<bigint, bigint | string, never>;
  deposit_address: string;
  deposit_memo: string | null;
  correlation_id: string;
  request: Json<Record<string, unknown>>;
  response: Json<Record<string, unknown>>;
  scenario: string;
  group_key: string;
  /** Stage 2 (0002): `pi_…`/`re_…` as rails sent it; null on Stage 1 rows and plain 1Click requests. */
  scenario_group: string | null;
  scenario_kind: ColumnType<"payment" | "refund", "payment" | "refund" | undefined, "payment" | "refund">;
  origin_chain: string;
  destination_chain: string;
  amount_in: Numeric;
  min_amount_in: Numeric;
  amount_out: Numeric;
  deadline: Timestamp;
  state: string;
  manual: Generated<boolean>;
  deposited_amount: NullableNumeric;
  deposited_at: NullableTimestamp;
  deposit_tx_hashes: TextArray;
  timeline: ColumnType<StepRow[], string | undefined, string>;
  applied: Generated<number>;
  next_at: NullableTimestamp;
  delivered_amount: NullableNumeric;
  refunded_amount: NullableNumeric;
  refund_reason: string | null;
  destination_tx_hashes: TextArray;
  refund_tx_hashes: TextArray;
  near_tx_hashes: TextArray;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type SimTransfer = {
  token: string;
  to: string;
  amount: string;
};

export interface SimTxsTable {
  hash: string;
  chain: string;
  transfers: Json<SimTransfer[]>;
  finalized_at: Timestamp;
  created_at: Timestamp;
}

export interface SimIntentsBalancesTable {
  account_id: string;
  token: string;
  amount: Numeric;
}

export interface SimIntentsNoncesTable {
  account_id: string;
  nonce: string;
  created_at: Timestamp;
}

export interface SimIntentsKeysTable {
  account_id: string;
  public_key: string;
  created_at: Timestamp;
}

export interface SimIntentsEventsTable {
  seq: Generated<bigint>;
  tx_hash: string;
  block_height: ColumnType<bigint, bigint | string, never>;
  log: string;
  created_at: Timestamp;
}

export interface SandboxTables {
  sim_quotes: SimQuotesTable;
  sim_txs: SimTxsTable;
  sim_intents_balances: SimIntentsBalancesTable;
  sim_intents_nonces: SimIntentsNoncesTable;
  sim_intents_keys: SimIntentsKeysTable;
  sim_intents_events: SimIntentsEventsTable;
}

export type DB = SandboxTables & KitTables;
