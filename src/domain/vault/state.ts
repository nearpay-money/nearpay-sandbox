/**
 * State of the vault stand-in (contracts-vault §2: mandates, `next_id`, per-token TVL, NEP-145 storage accounts, the
 * payer index) plus the simulated NEP-141 ledgers the receipts move tokens on and the Intents credits of merchant
 * legs. Pure: the loader is a port (Postgres in the app, Maps in tests).
 *
 * {@link VaultState} reads through to the loader once per key and buffers every write in frames: a receipt runs in
 * its own frame and a panic rolls back exactly that receipt, as NEAR reverts a failed receipt's state changes while
 * earlier receipts of the transaction stay applied. Values are immutable records (replaced on write), so a
 * rolled-back frame leaves no trace.
 */
import type { ReceiverKind } from "./msg.js";

export type MandateStatus = "active" | "canceled" | "exhausted";

/** The contract's `Mandate` (`types.rs`), amounts and times as bigint. */
export interface Mandate {
  readonly payer: string;
  readonly merchant_receiver: string;
  readonly receiver_kind: ReceiverKind;
  readonly token: string;
  readonly amount_per_period: bigint;
  readonly period_secs: bigint;
  readonly start_at_ns: bigint;
  readonly max_periods: number | null;
  readonly fee_bps: number;
  readonly collected_periods: number;
  readonly balance: bigint;
  readonly status: MandateStatus;
  readonly in_flight: boolean;
  readonly refund_in_flight: bigint;
  readonly ext_ref: string;
}

/** A mandate plus the stand-in's own per-mandate data (not contract state): its clock and scenario counter. */
export interface MandateRecord {
  readonly m: Mandate;
  /** Forward-only clock offset of this mandate (sandbox §3.1 `/sim/vault/advance`), seconds. */
  readonly clockOffsetS: bigint;
  /** Refunds of this mandate that failed by scenario `93` (only the first one fails). */
  readonly refundsFailed: number;
}

export interface StorageAccount {
  readonly total: bigint;
  readonly mandates: number;
}

export interface TokenCap {
  readonly token: string;
  readonly cap: bigint;
  readonly mandateCap: bigint;
}

/** Constructor arguments of the stand-in (sandbox §3.1 "Configuration", fixed at boot). */
export interface VaultConfig {
  readonly account: string;
  readonly allowedTokens: readonly string[];
  readonly feeReceiver: string;
  readonly maxFeeBps: number;
  readonly intentsAccount: string;
  readonly caps: readonly TokenCap[];
}

/** `Mandate::held`: balance + in-flight collect + in-flight refund (V1 sums it per token). */
export function held(m: Mandate): bigint {
  return m.balance + (m.in_flight ? m.amount_per_period : 0n) + m.refund_in_flight;
}

export function maxReached(m: Mandate): boolean {
  return m.max_periods !== null && m.collected_periods >= m.max_periods;
}

/** The constructor's `ERR_BAD_CONFIG` rules: a stand-in configured like no deployable vault refuses to boot. */
export function checkConfig(c: VaultConfig): string | null {
  const me = c.account;
  const tokens = new Set(c.allowedTokens);
  if (
    c.allowedTokens.length === 0 ||
    !Number.isInteger(c.maxFeeBps) ||
    c.maxFeeBps < 0 ||
    c.maxFeeBps > 10_000 ||
    c.feeReceiver === me ||
    c.intentsAccount === me ||
    c.feeReceiver === c.intentsAccount ||
    tokens.has(me) ||
    tokens.has(c.feeReceiver) ||
    tokens.has(c.intentsAccount) ||
    c.caps.length !== c.allowedTokens.length ||
    tokens.size !== c.allowedTokens.length
  )
    return "ERR_BAD_CONFIG";
  const seen = new Set<string>();
  for (const cap of c.caps) {
    if (!tokens.has(cap.token) || cap.mandateCap === 0n || cap.mandateCap > cap.cap || seen.has(cap.token))
      return "ERR_BAD_CONFIG";
    seen.add(cap.token);
  }
  return null;
}

/** Reads of committed state (one call per key and transaction). */
export interface VaultLoader {
  mandate(id: bigint): Promise<MandateRecord | null>;
  storage(account: string): Promise<StorageAccount | null>;
  /** Open mandate ids of a payer in the contract's `IterableSet` order (empty when none). */
  payerIndex(payer: string): Promise<readonly bigint[]>;
  /** Simulated NEP-141 balance. */
  ft(token: string, account: string): Promise<bigint>;
  nextId(): Promise<bigint>;
  tvl(token: string): Promise<bigint>;
}

/** A credit of the simulated Intents ledger (the merchant leg into `intents.near`). */
export interface IntentsCredit {
  readonly account: string;
  readonly tokenId: string;
  readonly amount: bigint;
}

const DELETED = Symbol("deleted");
type Slot = unknown | typeof DELETED;

interface Frame {
  readonly writes: Map<string, Slot>;
  readonly intents: IntentsCredit[];
}

const key = {
  mandate: (id: bigint) => `m:${id}`,
  storage: (a: string) => `s:${a}`,
  index: (p: string) => `p:${p}`,
  ft: (t: string, a: string) => `f:${t}\u0000${a}`,
  nextId: () => "n",
  tvl: (t: string) => `t:${t}`,
};

/** The kinds of keys {@link VaultState.changes} reports. */
export type Change =
  | { kind: "mandate"; id: bigint; value: MandateRecord | null }
  | { kind: "storage"; account: string; value: StorageAccount | null }
  | { kind: "index"; payer: string; value: readonly bigint[] }
  | { kind: "ft"; token: string; account: string; value: bigint }
  | { kind: "nextId"; value: bigint }
  | { kind: "tvl"; token: string; value: bigint };

export class VaultState {
  private readonly cache = new Map<string, unknown>();
  private readonly frames: Frame[] = [{ writes: new Map(), intents: [] }];

  constructor(private readonly loader: VaultLoader) {}

  private lookup(k: string): { found: true; value: unknown } | { found: false } {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const w = (this.frames[i] as Frame).writes;
      if (w.has(k)) {
        const v = w.get(k);
        return { found: true, value: v === DELETED ? null : v };
      }
    }
    if (this.cache.has(k)) return { found: true, value: this.cache.get(k) };
    return { found: false };
  }

  private async read<T>(k: string, load: () => Promise<T>): Promise<T> {
    const hit = this.lookup(k);
    if (hit.found) return hit.value as T;
    const v = await load();
    this.cache.set(k, v);
    return v;
  }

  private write(k: string, v: unknown): void {
    (this.frames[this.frames.length - 1] as Frame).writes.set(k, v === null ? DELETED : v);
  }

  mandate(id: bigint): Promise<MandateRecord | null> {
    return this.read(key.mandate(id), () => this.loader.mandate(id));
  }
  setMandate(id: bigint, r: MandateRecord | null): void {
    this.write(key.mandate(id), r);
  }
  storage(a: string): Promise<StorageAccount | null> {
    return this.read(key.storage(a), () => this.loader.storage(a));
  }
  setStorage(a: string, s: StorageAccount | null): void {
    this.write(key.storage(a), s);
  }
  payerIndex(p: string): Promise<readonly bigint[]> {
    return this.read(key.index(p), () => this.loader.payerIndex(p));
  }
  setPayerIndex(p: string, ids: readonly bigint[]): void {
    this.write(key.index(p), Object.freeze([...ids]));
  }
  ft(t: string, a: string): Promise<bigint> {
    return this.read(key.ft(t, a), () => this.loader.ft(t, a));
  }
  setFt(t: string, a: string, v: bigint): void {
    if (v < 0n) throw new RangeError("negative balance");
    this.write(key.ft(t, a), v);
  }
  nextId(): Promise<bigint> {
    return this.read(key.nextId(), () => this.loader.nextId());
  }
  setNextId(v: bigint): void {
    this.write(key.nextId(), v);
  }
  tvl(t: string): Promise<bigint> {
    return this.read(key.tvl(t), () => this.loader.tvl(t));
  }
  setTvl(t: string, v: bigint): void {
    this.write(key.tvl(t), v);
  }
  creditIntents(c: IntentsCredit): void {
    (this.frames[this.frames.length - 1] as Frame).intents.push(c);
  }

  /** Starts a receipt. */
  begin(): void {
    this.frames.push({ writes: new Map(), intents: [] });
  }
  /** The receipt succeeded: its writes join the enclosing frame. */
  commit(): void {
    const top = this.frames.pop();
    const under = this.frames[this.frames.length - 1];
    if (!top || !under) throw new Error("no receipt frame");
    for (const [k, v] of top.writes) under.writes.set(k, v);
    under.intents.push(...top.intents);
  }
  /** The receipt panicked: its writes are discarded. */
  rollback(): void {
    if (this.frames.length < 2) throw new Error("no receipt frame");
    this.frames.pop();
  }

  /** Every committed write (after all receipts finished), for persistence. */
  changes(): { changes: Change[]; intents: readonly IntentsCredit[] } {
    if (this.frames.length !== 1) throw new Error("receipt frames still open");
    const base = this.frames[0] as Frame;
    const out: Change[] = [];
    for (const [k, slot] of base.writes) {
      const v = slot === DELETED ? null : slot;
      const rest = k.slice(2);
      switch (k[0]) {
        case "m":
          out.push({ kind: "mandate", id: BigInt(rest), value: v as MandateRecord | null });
          break;
        case "s":
          out.push({ kind: "storage", account: rest, value: v as StorageAccount | null });
          break;
        case "p":
          out.push({ kind: "index", payer: rest, value: (v as readonly bigint[] | null) ?? [] });
          break;
        case "f": {
          const [token, account] = rest.split("\u0000") as [string, string];
          out.push({ kind: "ft", token, account, value: v as bigint });
          break;
        }
        case "n":
          out.push({ kind: "nextId", value: v as bigint });
          break;
        case "t":
          out.push({ kind: "tvl", token: rest, value: v as bigint });
          break;
      }
    }
    return { changes: out, intents: [...base.intents] };
  }
}

/** In-memory committed state (unit and property tests; `apply` persists {@link VaultState.changes}). */
export class MemoryVault implements VaultLoader {
  readonly mandates = new Map<bigint, MandateRecord>();
  readonly storages = new Map<string, StorageAccount>();
  readonly index = new Map<string, readonly bigint[]>();
  readonly fts = new Map<string, bigint>();
  readonly tvls = new Map<string, bigint>();
  readonly intents = new Map<string, bigint>();
  next = 0n;

  async mandate(id: bigint) {
    return this.mandates.get(id) ?? null;
  }
  async storage(a: string) {
    return this.storages.get(a) ?? null;
  }
  async payerIndex(p: string) {
    return this.index.get(p) ?? [];
  }
  async ft(t: string, a: string) {
    return this.fts.get(`${t}\u0000${a}`) ?? 0n;
  }
  async nextId() {
    return this.next;
  }
  async tvl(t: string) {
    return this.tvls.get(t) ?? 0n;
  }

  apply(s: VaultState): void {
    const { changes, intents } = s.changes();
    for (const c of changes) {
      switch (c.kind) {
        case "mandate":
          if (c.value) this.mandates.set(c.id, c.value);
          else this.mandates.delete(c.id);
          break;
        case "storage":
          if (c.value) this.storages.set(c.account, c.value);
          else this.storages.delete(c.account);
          break;
        case "index":
          if (c.value.length) this.index.set(c.payer, c.value);
          else this.index.delete(c.payer);
          break;
        case "ft":
          this.fts.set(`${c.token}\u0000${c.account}`, c.value);
          break;
        case "nextId":
          this.next = c.value;
          break;
        case "tvl":
          this.tvls.set(c.token, c.value);
          break;
      }
    }
    for (const i of intents) {
      const k = `${i.account}\u0000${i.tokenId}`;
      this.intents.set(k, (this.intents.get(k) ?? 0n) + i.amount);
    }
  }
}
