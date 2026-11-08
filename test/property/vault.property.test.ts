/**
 * Vault invariants V1–V10 (contracts-vault §5) on the stand-in, mirroring the contract's own proptest model
 * (`subscription-vault/src/tests/invariants.rs`): random interleavings of every public method with randomly delayed
 * and randomly failing promise outcomes (full, failed, partial, garbage-success merchant legs; failing fee legs and
 * refunds), checked against a model of the token ledger after every step, then a final drain in which every payer
 * exits (V2). A second property runs random operation sequences through the synchronous runtime itself (the stand-in
 * as billing reaches it) with random scenario faults and checks the same invariants against the simulated NEP-141
 * ledger.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CallResult,
  ContractPanic,
  MANDATE_STORAGE_COST,
  type PromiseResult,
  STORAGE_REGISTRATION_COST,
  TGAS,
  VaultContract,
} from "../../src/domain/vault/contract.js";
import { dueAt, elapsedPeriods, split } from "../../src/domain/vault/math.js";
import type { FaultInjector } from "../../src/domain/vault/runtime.js";
import { MemoryVault, VaultState } from "../../src/domain/vault/state.js";
import { config, Harness, INTENTS, T0, TREASURY, USDC, USDT, VAULT } from "../support/vault-harness.js";

const PAYERS = ["alice.near", "bob.near", "carol.test"] as const;
const MERCHANTS = ["merchant.near", "shop.test"] as const;
const TOKENS = [USDC, USDT] as const;
const MALLORY = "mallory.near";
const AMOUNT = 1_000_000n;
const PROP_CAP = 60n * AMOUNT;
const PROP_MANDATE_CAP = 6n * AMOUNT;
const AMOUNTS = [1n, 7n, 999_999n, AMOUNT, 3_333_333n, 7n * AMOUNT] as const;
const DAY_NS = 86_400_000_000_000n;
const enc = new TextEncoder();

const propConfig = () =>
  config({ caps: TOKENS.map((token) => ({ token, cap: PROP_CAP, mandateCap: PROP_MANDATE_CAP })) });

type Leg = { kind: "full" } | { kind: "fail" } | { kind: "partial"; permille: number } | { kind: "garbage" };
type Op =
  | {
      t: "create";
      payer: number;
      merchant: number;
      token: number;
      intents: boolean;
      amountIdx: number;
      periodsFunded: number;
      extra: number;
      feeBps: number;
      maxPeriods: number | null;
      startDays: number;
      daily: boolean;
      register: boolean;
    }
  | { t: "topup"; sender: number; mandate: number; otherToken: boolean; amount: bigint }
  | { t: "collect"; mandate: number }
  | { t: "deliver"; pending: number; leg: Leg; ok: boolean }
  | { t: "cancel"; who: number; mandate: number }
  | { t: "withdraw"; payer: boolean; mandate: number }
  | { t: "advance"; hours: number }
  | { t: "storage_withdraw"; payer: number };

const legArb: fc.Arbitrary<Leg> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ kind: "full" as const }) },
  { weight: 3, arbitrary: fc.constant({ kind: "fail" as const }) },
  {
    weight: 1,
    arbitrary: fc.integer({ min: 0, max: 999 }).map((permille) => ({ kind: "partial" as const, permille })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "garbage" as const }) },
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("create" as const),
      payer: fc.integer({ min: 0, max: 2 }),
      merchant: fc.integer({ min: 0, max: 1 }),
      token: fc.integer({ min: 0, max: 1 }),
      intents: fc.boolean(),
      amountIdx: fc.integer({ min: 0, max: AMOUNTS.length - 1 }),
      periodsFunded: fc.integer({ min: 0, max: 5 }),
      extra: fc.integer({ min: 0, max: 999 }),
      feeBps: fc.oneof(
        { weight: 9, arbitrary: fc.integer({ min: 0, max: 500 }) },
        { weight: 1, arbitrary: fc.constant(501) },
      ),
      maxPeriods: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 3 })),
      startDays: fc.integer({ min: 0, max: 2 }),
      daily: fc.boolean(),
      register: fc.boolean().map((b) => b || Math.random() < 0.8),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("topup" as const),
      sender: fc.integer({ min: 0, max: 3 }),
      mandate: fc.nat(7),
      otherToken: fc.integer({ min: 0, max: 9 }).map((x) => x === 0),
      amount: fc.bigInt({ min: 1n, max: 3n * AMOUNT - 1n }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("collect" as const), mandate: fc.nat(7) }) },
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant("deliver" as const),
      pending: fc.nat(7),
      leg: legArb,
      ok: fc.integer({ min: 0, max: 9 }).map((x) => x < 8),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("cancel" as const),
      who: fc.integer({ min: 0, max: 2 }),
      mandate: fc.nat(7),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("withdraw" as const),
      payer: fc.integer({ min: 0, max: 9 }).map((x) => x > 0),
      mandate: fc.nat(7),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("advance" as const),
      hours: fc.oneof(fc.integer({ min: 1, max: 47 }), fc.integer({ min: 700, max: 799 })),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant("storage_withdraw" as const), payer: fc.integer({ min: 0, max: 2 }) }),
  },
);

type Pending =
  | { kind: "merchant"; id: bigint; share: bigint; fee: bigint }
  | { kind: "fee"; id: bigint; share: bigint; fee: bigint }
  | { kind: "refund"; id: bigint; amount: bigint; by: string | null };

interface Track {
  terms: string;
  token: string;
  payer: string;
  kind: "intents_account" | "near_account";
  deposited: bigint;
  toPayer: bigint;
  toMerchant: bigint;
  toFee: bigint;
  stranded: bigint;
  inflightOut: bigint;
}

interface View {
  mandate_id: number;
  payer: string;
  merchant_receiver: string;
  receiver_kind: "intents_account" | "near_account";
  token: string;
  amount_per_period: string;
  period_secs: number;
  start_at: string;
  max_periods: number | null;
  fee_bps: number;
  collected_periods: number;
  balance: string;
  status: "active" | "canceled" | "exhausted";
  in_flight: boolean;
  refund_in_flight: string;
  ext_ref: string;
}

const termsOf = (m: View) =>
  JSON.stringify([
    m.payer,
    m.merchant_receiver,
    m.receiver_kind,
    m.token,
    m.amount_per_period,
    m.period_secs,
    m.start_at,
    m.max_periods,
    m.fee_bps,
    m.ext_ref,
  ]);

const ok = (s: string): PromiseResult => ({ ok: true, bytes: enc.encode(s) });
const FAILED: PromiseResult = { ok: false };

/** The contract model of invariants.rs, on the stand-in's contract port with explicit promise delivery. */
class Model {
  readonly mem = new MemoryVault();
  readonly vault = new VaultContract(propConfig());
  now = T0;
  holdings = new Map<string, bigint>();
  stranded = new Map<string, bigint>();
  ids: bigint[] = [];
  track = new Map<bigint, Track>();
  pending: Pending[] = [];
  closed = new Set<bigint>();

  private hold(token: string, delta: bigint) {
    this.holdings.set(token, (this.holdings.get(token) ?? 0n) + delta);
  }

  /** One receipt on the contract: state changes revert on panic. */
  async invoke(
    method: string,
    args: unknown,
    o: { predecessor: string; signer?: string; deposit?: bigint; gas?: bigint; results?: PromiseResult[] },
  ): Promise<{ result: CallResult | null; err: string | null; logs: string[] }> {
    const s = new VaultState(this.mem);
    const logs: string[] = [];
    s.begin();
    try {
      const result = await this.vault.call(
        s,
        {
          predecessor: o.predecessor,
          signer: o.signer ?? o.predecessor,
          deposit: o.deposit ?? 0n,
          gas: o.gas ?? 100n * TGAS,
          blockTimestampNs: this.now,
          promiseResults: o.results ?? [],
          logs,
        },
        method,
        enc.encode(JSON.stringify(args)),
      );
      s.commit();
      this.mem.apply(s);
      return { result, err: null, logs };
    } catch (e) {
      if (!(e instanceof ContractPanic)) throw e;
      s.rollback();
      return { result: null, err: e.message, logs: [] };
    }
  }

  async mandate(id: bigint): Promise<View | null> {
    return JSON.parse(
      await this.vault.view(
        new VaultState(this.mem),
        "get_mandate",
        enc.encode(JSON.stringify({ mandate_id: Number(id) })),
      ),
    );
  }

  private pick(i: number): bigint | null {
    return this.ids.length ? (this.ids[i % this.ids.length] as bigint) : null;
  }

  private valueOf(r: CallResult | null): string {
    expect(r?.kind).toBe("value");
    return new TextDecoder().decode((r as { bytes: Uint8Array }).bytes);
  }

  async apply(op: Op): Promise<void> {
    switch (op.t) {
      case "create": {
        const payer = PAYERS[op.payer] as string;
        const token = TOKENS[op.token] as string;
        const amount = AMOUNTS[op.amountIdx] as bigint;
        if (op.register) {
          const need = this.mem.storages.has(payer)
            ? MANDATE_STORAGE_COST
            : STORAGE_REGISTRATION_COST + MANDATE_STORAGE_COST;
          expect((await this.invoke("storage_deposit", {}, { predecessor: payer, deposit: need })).err).toBeNull();
        }
        const funding = amount * BigInt(op.periodsFunded) + BigInt(op.extra);
        if (funding === 0n) return;
        const msg = JSON.stringify({
          create_mandate: {
            merchant_receiver: MERCHANTS[op.merchant],
            receiver_kind: op.intents ? "intents_account" : "near_account",
            amount_per_period: amount.toString(),
            period_secs: op.daily ? 86_400 : 30 * 86_400,
            start_at: (this.now + BigInt(op.startDays) * DAY_NS).toString(),
            max_periods: op.maxPeriods,
            fee_bps: op.feeBps,
            ext_ref: "sub_test",
          },
        });
        const r = await this.invoke(
          "ft_on_transfer",
          { sender_id: payer, amount: funding.toString(), msg },
          { predecessor: token, signer: payer },
        );
        expect(r.err).toBeNull();
        const unused = BigInt(JSON.parse(this.valueOf(r.result)));
        if (unused === 0n) {
          const id = BigInt(JSON.parse((r.logs[0] as string).slice("EVENT_JSON:".length)).data[0].mandate_id);
          this.hold(token, funding);
          const m = (await this.mandate(id)) as View;
          this.track.set(id, {
            terms: termsOf(m),
            token,
            payer,
            kind: m.receiver_kind,
            deposited: funding,
            toPayer: 0n,
            toMerchant: 0n,
            toFee: 0n,
            stranded: 0n,
            inflightOut: 0n,
          });
          this.ids.push(id);
        } else {
          expect(unused).toBe(funding);
          expect(r.logs).toHaveLength(1);
          expect(r.logs[0]).toMatch(/^ERR_[A-Z_]+(: (mandate|tvl))?$/);
        }
        return;
      }
      case "topup": {
        const id = this.pick(op.mandate);
        if (id === null) return;
        const t = this.track.get(id) as Track;
        const sender = op.sender < PAYERS.length ? (PAYERS[op.sender] as string) : MALLORY;
        const token = op.otherToken ? (TOKENS.find((x) => x !== t.token) as string) : t.token;
        const r = await this.invoke(
          "ft_on_transfer",
          {
            sender_id: sender,
            amount: op.amount.toString(),
            msg: JSON.stringify({ top_up: { mandate_id: Number(id) } }),
          },
          { predecessor: token, signer: sender },
        );
        if (BigInt(JSON.parse(this.valueOf(r.result))) === 0n) {
          expect(token).toBe(t.token);
          expect(sender).toBe(t.payer);
          this.hold(token, op.amount);
          t.deposited += op.amount;
        }
        return;
      }
      case "collect": {
        const id = this.pick(op.mandate);
        if (id === null) return;
        const before = await this.mandate(id);
        const r = await this.invoke(
          "collect",
          { mandate_id: Number(id) },
          { predecessor: "keeper.near", gas: 250n * TGAS },
        );
        this.checkCollectRule(before, r.err);
        if (r.err === null) {
          const m = before as View;
          expect(r.result?.kind).toBe("promise");
          const chain = (
            r.result as unknown as {
              chain: {
                first: { receiver: string; method: string; args: string };
                callbacks: { receiver: string; method: string }[];
              };
            }
          ).chain;
          const args = JSON.parse(chain.first.args);
          expect(chain.first.receiver).toBe(m.token);
          if (m.receiver_kind === "intents_account") {
            expect([chain.first.method, args.receiver_id, args.msg]).toEqual([
              "ft_transfer_call",
              INTENTS,
              m.merchant_receiver,
            ]);
          } else {
            expect([chain.first.method, args.receiver_id]).toEqual(["ft_transfer", m.merchant_receiver]); // V4
          }
          const { share, fee } = split(BigInt(m.amount_per_period), m.fee_bps);
          expect(BigInt(args.amount)).toBe(share);
          expect([chain.callbacks[0]?.receiver, chain.callbacks[0]?.method]).toEqual([VAULT, "on_merchant_leg"]);
          this.pending.push({ kind: "merchant", id, share, fee });
        }
        return;
      }
      case "deliver": {
        if (this.pending.length === 0) return;
        const p = this.pending.splice(op.pending % this.pending.length, 1)[0] as Pending;
        await this.deliver(p, op.leg, op.ok);
        return;
      }
      case "cancel": {
        const id = this.pick(op.mandate);
        if (id === null) return;
        const t = this.track.get(id) as Track;
        const m0 = await this.mandate(id);
        const caller = op.who === 0 ? t.payer : op.who === 1 ? (m0?.merchant_receiver ?? MERCHANTS[0]) : MALLORY;
        const r = await this.invoke("cancel", { mandate_id: Number(id) }, { predecessor: caller, deposit: 1n });
        if (m0 === null) expect(r.err).toBe("ERR_NOT_FOUND");
        else if (op.who === 2) expect(r.err).toBe("ERR_UNAUTHORIZED");
        else if (m0.status !== "active") expect(r.err).toBe("ERR_NOT_ACTIVE");
        else {
          expect(r.err).toBeNull(); // V2: an active mandate can always be canceled
          this.afterRefundCall(id, r.result, BigInt(m0.balance), caller);
        }
        return;
      }
      case "withdraw": {
        const id = this.pick(op.mandate);
        if (id === null) return;
        const t = this.track.get(id) as Track;
        const caller = op.payer ? t.payer : MALLORY;
        const m0 = await this.mandate(id);
        const r = await this.invoke("withdraw", { mandate_id: Number(id) }, { predecessor: caller, deposit: 1n });
        if (m0 === null) expect(r.err).toBe("ERR_NOT_FOUND");
        else if (!op.payer) expect(r.err).toBe("ERR_UNAUTHORIZED");
        else if (m0.status === "active") expect(r.err).toBe("ERR_STILL_ACTIVE");
        else if (BigInt(m0.refund_in_flight) > 0n) expect(r.err).toBe("ERR_IN_FLIGHT");
        else if (BigInt(m0.balance) === 0n) expect(r.err).toBe("ERR_INSUFFICIENT_BALANCE");
        else {
          expect(r.err).toBeNull();
          this.afterRefundCall(id, r.result, BigInt(m0.balance), null);
        }
        return;
      }
      case "advance":
        this.now += BigInt(op.hours) * 3_600_000_000_000n;
        return;
      case "storage_withdraw": {
        const p = PAYERS[op.payer] as string;
        const before = this.mem.storages.get(p);
        const r = await this.invoke("storage_withdraw", {}, { predecessor: p, deposit: 1n });
        if (!before) expect(r.err).toBe("ERR_NO_STORAGE");
        else expect(r.err).toBeNull();
        return;
      }
    }
  }

  /** V9: collect succeeds iff its preconditions hold, else the documented error in check order. */
  checkCollectRule(m: View | null, err: string | null) {
    if (!m) return expect(err).toBe("ERR_NOT_FOUND");
    const due = dueAt(BigInt(m.start_at), m.collected_periods, BigInt(m.period_secs));
    const isDue = due !== null && this.now >= due;
    const expected =
      m.status === "exhausted"
        ? "ERR_MAX_PERIODS"
        : m.status === "canceled"
          ? "ERR_NOT_ACTIVE"
          : m.in_flight
            ? "ERR_IN_FLIGHT"
            : m.max_periods !== null && m.collected_periods >= m.max_periods
              ? "ERR_MAX_PERIODS"
              : !isDue
                ? "ERR_NOT_DUE"
                : BigInt(m.balance) < BigInt(m.amount_per_period)
                  ? "ERR_INSUFFICIENT_BALANCE"
                  : null;
    expect(err).toBe(expected);
  }

  afterRefundCall(id: bigint, result: CallResult | null, balance: bigint, by: string | null) {
    if (balance === 0n) {
      expect(result?.kind).toBe("value");
      return;
    }
    expect(result?.kind).toBe("promise");
    const chain = (
      result as unknown as {
        chain: { first: { receiver: string; method: string; args: string }; callbacks: { method: string }[] };
      }
    ).chain;
    const t = this.track.get(id) as Track;
    const args = JSON.parse(chain.first.args);
    expect([chain.first.receiver, chain.first.method]).toEqual([t.token, "ft_transfer"]);
    expect(args.receiver_id).toBe(t.payer); // V4: refunds only to the payer
    expect(BigInt(args.amount)).toBe(balance);
    expect(chain.callbacks[0]?.method).toBe("on_refunded");
    this.pending.push({ kind: "refund", id, amount: balance, by });
  }

  async deliver(p: Pending, leg: Leg, okLeg: boolean) {
    const t = this.track.get(p.id) as Track;
    const token = t.token;
    if (p.kind === "merchant") {
      let result: PromiseResult;
      let moved: bigint;
      let garbage = false;
      if (leg.kind === "fail") [result, moved] = [FAILED, 0n];
      else if (t.kind === "near_account") [result, moved] = [ok(""), p.share];
      else if (leg.kind === "full") [result, moved] = [ok(`"${p.share}"`), p.share];
      else if (leg.kind === "partial") {
        const used = (p.share * BigInt(leg.permille)) / 1000n;
        [result, moved] = [ok(`"${used}"`), used];
      } else {
        [result, moved] = [ok('"garbage"'), 0n];
        garbage = true;
      }
      this.hold(token, -moved);
      t.toMerchant += moved;
      t.inflightOut += moved;
      if (garbage) {
        // the vault assumes the share left; it stays unattributed (V1 slack)
        this.stranded.set(token, (this.stranded.get(token) ?? 0n) + p.share);
        t.stranded += p.share;
        t.inflightOut += p.share;
      }
      const r = await this.invoke(
        "on_merchant_leg",
        { mandate_id: Number(p.id), share: p.share.toString(), fee: p.fee.toString() },
        {
          predecessor: VAULT,
          results: [result],
        },
      );
      expect(r.err).toBeNull();
      if (r.result?.kind === "promise") {
        const chain = r.result.chain;
        const args = JSON.parse(chain.first.args);
        expect([chain.first.receiver, chain.first.method, args.receiver_id]).toEqual([token, "ft_transfer", TREASURY]); // V4
        expect(BigInt(args.amount)).toBe(p.fee);
        expect(moved === p.share || garbage).toBe(true);
        this.pending.push({ kind: "fee", id: p.id, share: p.share, fee: p.fee });
      } else {
        t.inflightOut = 0n;
      }
      return;
    }
    if (p.kind === "fee") {
      if (okLeg) {
        this.hold(token, -p.fee);
        t.toFee += p.fee;
      }
      t.inflightOut = 0n;
      const r = await this.invoke(
        "on_collected",
        { mandate_id: Number(p.id), share: p.share.toString(), fee: p.fee.toString() },
        {
          predecessor: VAULT,
          results: [okLeg ? ok("") : FAILED],
        },
      );
      expect(this.valueOf(r.result)).toBe("true");
      return;
    }
    if (okLeg) {
      this.hold(token, -p.amount);
      t.toPayer += p.amount;
    }
    const r = await this.invoke(
      "on_refunded",
      { mandate_id: Number(p.id), amount: p.amount.toString(), canceled_by: p.by },
      { predecessor: VAULT, results: [okLeg ? ok("") : FAILED] },
    );
    expect(this.valueOf(r.result)).toBe(String(okLeg));
  }

  async check() {
    const held = new Map<string, bigint>();
    const out = new Map<string, bigint>();
    const openByPayer = new Map<string, Set<bigint>>();
    for (const id of this.ids) {
      const m = await this.mandate(id);
      const t = this.track.get(id) as Track;
      const pendCollect = this.pending.filter((p) => (p.kind === "merchant" || p.kind === "fee") && p.id === id).length;
      const pendRefund = this.pending.reduce((a, p) => a + (p.kind === "refund" && p.id === id ? p.amount : 0n), 0n);
      if (m) {
        expect(this.closed.has(id), `closed mandate ${id} reappeared`).toBe(false);
        expect(termsOf(m), "V5").toBe(t.terms);
        expect(m.in_flight, "V6 in_flight").toBe(pendCollect === 1);
        expect(pendCollect).toBeLessThanOrEqual(1);
        expect(BigInt(m.refund_in_flight), "V6 refund_in_flight").toBe(pendRefund);
        const amount = BigInt(m.amount_per_period);
        const paid = t.toMerchant + t.toFee;
        const counted = BigInt(m.collected_periods) + (m.in_flight ? 1n : 0n);
        expect(paid <= counted * amount, "V3 paid").toBe(true);
        if (!m.in_flight) expect(paid <= BigInt(m.collected_periods) * amount, "V3 paid").toBe(true);
        expect(
          BigInt(m.collected_periods) <= elapsedPeriods(BigInt(m.start_at), BigInt(m.period_secs), this.now),
          "V3 periods",
        ).toBe(true);
        if (m.max_periods !== null) {
          expect(m.collected_periods).toBeLessThanOrEqual(m.max_periods);
          expect(m.status === "exhausted").toBe(m.collected_periods === m.max_periods && m.status !== "canceled");
        }
        const inFlightAmt = m.in_flight ? amount : 0n;
        const h = BigInt(m.balance) + inFlightAmt + BigInt(m.refund_in_flight);
        expect(h <= PROP_MANDATE_CAP, "V10 held").toBe(true);
        expect(amount <= PROP_MANDATE_CAP, "V10 amount").toBe(true);
        held.set(m.token, (held.get(m.token) ?? 0n) + h);
        expect(t.deposited + t.inflightOut, "conservation").toBe(h + t.toPayer + t.toMerchant + t.toFee + t.stranded);
        if (!m.in_flight) expect(t.inflightOut).toBe(0n);
        out.set(m.token, (out.get(m.token) ?? 0n) + t.inflightOut);
        if (!openByPayer.has(m.payer)) openByPayer.set(m.payer, new Set());
        openByPayer.get(m.payer)?.add(id);
      } else {
        this.closed.add(id);
        expect(pendCollect).toBe(0);
        expect(pendRefund).toBe(0n);
        expect(t.deposited, "closed conservation").toBe(t.toPayer + t.toMerchant + t.toFee + t.stranded);
      }
    }
    for (const token of TOKENS) {
      const tvl = this.mem.tvls.get(token) ?? 0n;
      const h = this.holdings.get(token) ?? 0n;
      const st = this.stranded.get(token) ?? 0n;
      const sum = held.get(token) ?? 0n;
      const o = out.get(token) ?? 0n;
      expect(tvl, "tvl accounting").toBe(sum);
      expect(tvl - o <= h, "V1").toBe(true);
      if (o === 0n) expect(tvl <= h, "V1").toBe(true);
      expect(h + o, "unexplained tokens").toBe(tvl + st);
      expect(tvl <= PROP_CAP, "V7").toBe(true);
    }
    for (const p of PAYERS) {
      const open = [...(openByPayer.get(p) ?? [])].sort();
      const idx = [...(this.mem.index.get(p) ?? [])].sort();
      expect(idx, "V8 index").toEqual(open);
      expect(this.mem.storages.get(p)?.mandates ?? 0, "V8 storage lock").toBe(open.length);
    }
  }

  /** V2 end state: deliver everything, then every payer exits and every unspent token returns. */
  async drain() {
    while (this.pending.length) await this.deliver(this.pending.pop() as Pending, { kind: "full" }, true);
    await this.check();
    for (const id of [...this.ids]) {
      let m = await this.mandate(id);
      if (!m) continue;
      if (m.status === "active") {
        const r = await this.invoke("cancel", { mandate_id: Number(id) }, { predecessor: m.payer, deposit: 1n });
        expect(r.err, `V2 cancel ${id}`).toBeNull();
        this.afterRefundCall(id, r.result, BigInt(m.balance), m.payer);
      }
      while (this.pending.length) await this.deliver(this.pending.pop() as Pending, { kind: "full" }, true);
      m = await this.mandate(id);
      if (m) {
        expect(BigInt(m.balance) > 0n, `open zero-balance mandate ${id}`).toBe(true);
        const r = await this.invoke("withdraw", { mandate_id: Number(id) }, { predecessor: m.payer, deposit: 1n });
        expect(r.err, `V2 withdraw ${id}`).toBeNull();
        this.afterRefundCall(id, r.result, BigInt(m.balance), null);
        while (this.pending.length) await this.deliver(this.pending.pop() as Pending, { kind: "full" }, true);
      }
      expect(await this.mandate(id), `V2: mandate ${id} not closed`).toBeNull();
      await this.check();
    }
    for (const token of TOKENS) {
      expect(this.mem.tvls.get(token) ?? 0n).toBe(0n);
      expect(this.holdings.get(token) ?? 0n).toBe(this.stranded.get(token) ?? 0n);
    }
    for (const p of PAYERS) {
      if (this.mem.storages.has(p)) {
        const r = await this.invoke("storage_unregister", {}, { predecessor: p, deposit: 1n });
        expect(this.valueOf(r.result), `storage stuck for ${p}`).toBe("true");
      }
    }
  }
}

const CASES = Number(process.env.VAULT_PROP_CASES ?? 200);

describe("vault invariants V1–V10 (contract model, delayed and failing promises)", () => {
  it("hold under random interleavings and a final drain", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 70, size: "max" }), async (ops) => {
        const model = new Model();
        for (const op of ops) {
          await model.apply(op);
          await model.check();
        }
        await model.drain();
      }),
      { numRuns: CASES },
    );
  }, 300_000);

  it("a fixed adversarial schedule: everything in flight, delivered in reverse", async () => {
    const model = new Model();
    const ops: Op[] = [
      {
        t: "create",
        payer: 0,
        merchant: 0,
        token: 0,
        intents: true,
        amountIdx: 3,
        periodsFunded: 3,
        extra: 5,
        feeBps: 100,
        maxPeriods: 2,
        startDays: 0,
        daily: true,
        register: true,
      },
      {
        t: "create",
        payer: 1,
        merchant: 1,
        token: 0,
        intents: false,
        amountIdx: 4,
        periodsFunded: 1,
        extra: 0,
        feeBps: 0,
        maxPeriods: null,
        startDays: 0,
        daily: true,
        register: true,
      },
      { t: "collect", mandate: 0 },
      { t: "collect", mandate: 1 },
      { t: "cancel", who: 1, mandate: 0 },
      { t: "cancel", who: 0, mandate: 1 },
      { t: "deliver", pending: 3, leg: { kind: "full" }, ok: false },
      { t: "deliver", pending: 2, leg: { kind: "full" }, ok: true },
      { t: "deliver", pending: 1, leg: { kind: "garbage" }, ok: true },
      { t: "deliver", pending: 0, leg: { kind: "full" }, ok: false },
      { t: "deliver", pending: 0, leg: { kind: "full" }, ok: true },
      { t: "withdraw", payer: true, mandate: 0 },
      { t: "withdraw", payer: true, mandate: 1 },
    ];
    for (const op of ops) {
      await model.apply(op);
      await model.check();
    }
    await model.drain();
  });
});

// ---------------------------------------------------------------------------------------------
// The synchronous stand-in (runtime + NEP-141 ledgers) under random operations and scenario faults
// ---------------------------------------------------------------------------------------------

type StandinOp =
  | {
      t: "create";
      payer: number;
      amountIdx: number;
      periods: number;
      feeBps: number;
      maxPeriods: number | null;
      intents: boolean;
      token: number;
    }
  | { t: "topup"; mandate: number; amount: bigint }
  | { t: "collect"; mandate: number; merchant: "ok" | "fail" | "partial"; feeFails: boolean }
  | { t: "cancel"; mandate: number; byMerchant: boolean; refundFails: boolean }
  | { t: "withdraw"; mandate: number; refundFails: boolean }
  | { t: "advance"; days: number };

const standinOpArb: fc.Arbitrary<StandinOp> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("create" as const),
      payer: fc.integer({ min: 0, max: 2 }),
      amountIdx: fc.integer({ min: 0, max: AMOUNTS.length - 1 }),
      periods: fc.integer({ min: 1, max: 5 }),
      feeBps: fc.integer({ min: 0, max: 500 }),
      maxPeriods: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 3 })),
      intents: fc.boolean(),
      token: fc.integer({ min: 0, max: 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("topup" as const),
      mandate: fc.nat(7),
      amount: fc.bigInt({ min: 1n, max: 2n * AMOUNT }),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant("collect" as const),
      mandate: fc.nat(7),
      merchant: fc.constantFrom("ok" as const, "ok" as const, "fail" as const, "partial" as const),
      feeFails: fc.integer({ min: 0, max: 3 }).map((x) => x === 0),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("cancel" as const),
      mandate: fc.nat(7),
      byMerchant: fc.boolean(),
      refundFails: fc.integer({ min: 0, max: 2 }).map((x) => x === 0),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("withdraw" as const),
      mandate: fc.nat(7),
      refundFails: fc.integer({ min: 0, max: 3 }).map((x) => x === 0),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("advance" as const), days: fc.integer({ min: 1, max: 40 }) }) },
);

class OneShotFaults implements FaultInjector {
  merchant: "ok" | "fail" | "partial" = "ok";
  fee = false;
  refund = false;
  async legFailure(tag: { leg: string }) {
    if (tag.leg === "merchant" && this.merchant === "fail") return "fault";
    if (tag.leg === "fee" && this.fee) return "fault";
    if (tag.leg === "refund" && this.refund) return "fault";
    return null;
  }
  async intentsDelivered(tag: { leg: string }, amount: bigint) {
    return tag.leg === "merchant" && this.merchant === "partial" ? amount / 2n : amount;
  }
}

describe("vault invariants on the synchronous stand-in (runtime, NEP-141 ledgers, scenario faults)", () => {
  it("the vault's token balance equals its TVL, terms never change, payers always recover everything", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(standinOpArb, { minLength: 1, maxLength: 40, size: "max" }), async (ops) => {
        const faults = new OneShotFaults();
        const h = new Harness(propConfig(), faults);
        const ids: number[] = [];
        const terms = new Map<number, string>();
        for (const p of PAYERS) await h.register(p, STORAGE_REGISTRATION_COST + 10n * MANDATE_STORAGE_COST);
        const pick = (i: number) => (ids.length ? (ids[i % ids.length] as number) : null);
        for (const op of ops) {
          faults.merchant = "ok";
          faults.fee = false;
          faults.refund = false;
          if (op.t === "create") {
            const payer = PAYERS[op.payer] as string;
            const amount = AMOUNTS[op.amountIdx] as bigint;
            const token = TOKENS[op.token] as string;
            const msg = {
              create_mandate: {
                merchant_receiver: "merchant.near",
                receiver_kind: op.intents ? "intents_account" : "near_account",
                amount_per_period: amount.toString(),
                period_secs: 86_400,
                start_at: null,
                max_periods: op.maxPeriods,
                fee_bps: op.feeBps,
                ext_ref: "sub_x",
              },
            };
            const r = await h.fund(payer, token, amount * BigInt(op.periods), msg);
            const line = r.feed.find((f) => f.executor_id === VAULT)?.log ?? "";
            if (line.startsWith("EVENT_JSON:")) {
              const id = JSON.parse(line.slice(11)).data[0].mandate_id as number;
              ids.push(id);
              terms.set(id, termsOf(await h.mandate(id)));
            }
          } else if (op.t === "topup") {
            const id = pick(op.mandate);
            if (id === null) continue;
            const m = await h.mandate(id);
            if (!m) continue;
            await h.fund(m.payer, m.token, op.amount, { top_up: { mandate_id: id } });
          } else if (op.t === "collect") {
            const id = pick(op.mandate);
            if (id === null) continue;
            faults.merchant = op.merchant;
            faults.fee = op.feeFails;
            await h.call("keeper.near", "collect", { mandate_id: id });
          } else if (op.t === "cancel") {
            const id = pick(op.mandate);
            if (id === null) continue;
            const m = await h.mandate(id);
            if (!m) continue;
            faults.refund = op.refundFails;
            const r = await h.call(op.byMerchant ? m.merchant_receiver : m.payer, "cancel", { mandate_id: id });
            if (m.status === "active") expect("Failure" in r.status ? null : "ok", "V2 cancel").toBe("ok");
          } else if (op.t === "withdraw") {
            const id = pick(op.mandate);
            if (id === null) continue;
            const m = await h.mandate(id);
            if (!m) continue;
            faults.refund = op.refundFails;
            await h.call(m.payer, "withdraw", { mandate_id: id });
          } else {
            h.now += BigInt(op.days) * DAY_NS;
          }
          // V1 exactly (no garbage results here): the vault holds what its mandates hold; V5; V7; V8; V10
          for (const token of TOKENS) {
            expect(await h.mem.ft(token, VAULT), "V1").toBe(h.mem.tvls.get(token) ?? 0n);
            expect((h.mem.tvls.get(token) ?? 0n) <= PROP_CAP, "V7").toBe(true);
          }
          for (const id of ids) {
            const m = await h.mandate(id);
            if (!m) continue;
            expect(termsOf(m), "V5").toBe(terms.get(id));
            expect(m.in_flight, "nothing stays in flight synchronously").toBe(false);
            expect(BigInt(m.refund_in_flight)).toBe(0n);
            expect(BigInt(m.balance) <= PROP_MANDATE_CAP, "V10").toBe(true);
            expect(
              BigInt(m.collected_periods) <= elapsedPeriods(BigInt(m.start_at), BigInt(m.period_secs), h.now),
              "V3",
            ).toBe(true);
          }
          for (const p of PAYERS) {
            const open = ids.filter((id) => h.mem.mandates.get(BigInt(id))?.m.payer === p).sort();
            expect([...(h.mem.index.get(p) ?? [])].map(Number).sort(), "V8 index").toEqual(open);
            expect(h.mem.storages.get(p)?.mandates, "V8 storage").toBe(open.length);
          }
        }
        // V2: drain — every payer exits with everything left
        faults.merchant = "ok";
        faults.fee = false;
        faults.refund = false;
        for (const id of ids) {
          const m = await h.mandate(id);
          if (!m) continue;
          if (m.status === "active") await h.call(m.payer, "cancel", { mandate_id: id });
          const after = await h.mandate(id);
          if (after) await h.call(m.payer, "withdraw", { mandate_id: id });
          expect(await h.mandate(id), `V2: ${id} not closed`).toBeNull();
        }
        for (const token of TOKENS) {
          expect(await h.mem.ft(token, VAULT)).toBe(0n);
          expect(h.mem.tvls.get(token) ?? 0n).toBe(0n);
        }
        for (const p of PAYERS) expect(statusOf(await h.call(p, "storage_unregister", {}))).toBe("true");
      }),
      { numRuns: Math.max(30, Math.floor(CASES / 2)) },
    );
  }, 300_000);
});

function statusOf(r: { status: Record<string, unknown> }): string | null {
  return "SuccessValue" in r.status ? Buffer.from(r.status.SuccessValue as string, "base64").toString() : null;
}
