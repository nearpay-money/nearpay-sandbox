/**
 * Vault stand-in over HTTP on real Postgres (sandbox LLD §3.1, §4.2): a keeper-shaped client (near-js signing) runs
 * collect against `/sim/near-rpc`, payers fund and exit through `/sim/vault/*`, per-mandate clocks advance, and every
 * receipt line reaches the indexer feed with its receipt context. JSON-RPC answers are validated with the spec's
 * `NearRpcResponse`.
 */

import { NearFinalExecutionOutcome, NearRpcResponse, SimVaultClock } from "@nearpay-internal/spec";
import { mintTestToken } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyPairEd25519, signFunctionCall } from "../support/near-client.js";
import { type Stack, startStack } from "../support/stack.js";

const VAULT = "vault.sandbox.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "usdt.tether-token.near";
const TGAS = 1_000_000_000_000n;
const STORAGE = "12000000000000000000000";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

type Outcome = {
  status: Record<string, unknown>;
  receipts_outcome: { id: string; outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }[];
  transaction: { hash: string };
};

let rpcId = 0;
async function rpc(method: string, params: unknown) {
  const r = await s.call("POST", "/sim/near-rpc", { jsonrpc: "2.0", id: ++rpcId, method, params });
  expect(r.status).toBe(200);
  expect(NearRpcResponse.safeParse(r.body).success, JSON.stringify(r.body)).toBe(true);
  return r.body as { result?: unknown; error?: { cause: { name: string; info: Record<string, unknown> } } };
}

async function view(account: string, method: string, args: object = {}) {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const res = r.result as { result: number[] } | undefined;
  return res ? Buffer.from(res.result).toString() : r;
}

async function vcall(signer: string, method: string, args: object, extra: { gas?: string; deposit?: string } = {}) {
  const r = await s.call("POST", "/sim/vault/call", { signer, method, args, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(NearFinalExecutionOutcome.safeParse(r.body).success).toBe(true);
  return r.body as Outcome;
}

async function fund(payer: string, amount: string, msg: object | string, token = USDC) {
  const r = await s.call("POST", "/sim/vault/ft_transfer_call", {
    payer,
    token,
    amount,
    msg: typeof msg === "string" ? msg : JSON.stringify(msg),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(NearFinalExecutionOutcome.safeParse(r.body).success).toBe(true);
  return r.body as Outcome;
}

const value = (o: Outcome) => Buffer.from((o.status as { SuccessValue: string }).SuccessValue, "base64").toString();
const vaultLines = (o: Outcome) =>
  o.receipts_outcome.filter((r) => r.outcome.executor_id === VAULT).flatMap((r) => r.outcome.logs);
const createMsg = (over: Record<string, unknown> = {}) => ({
  create_mandate: {
    merchant_receiver: "merchant-demo.near",
    receiver_kind: "intents_account",
    amount_per_period: "10000000",
    period_secs: 2_629_746,
    start_at: null,
    max_periods: null,
    fee_bps: 100,
    ext_ref: "sub_01jbz9k3m4n5p6q7r8s9t0v1w2",
    ...over,
  },
});

/** Creates a mandate for a fresh payer; returns its id. */
async function newMandate(payer: string, amount: string, over: Record<string, unknown> = {}) {
  await vcall(payer, "storage_deposit", {}, { deposit: STORAGE });
  const o = await fund(payer, amount, createMsg(over));
  const created = vaultLines(o)[0] as string;
  expect(created).toContain('"event":"mandate_created"');
  return JSON.parse(created.slice("EVENT_JSON:".length)).data[0].mandate_id as number;
}

describe("NEAR RPC subset", () => {
  it("views: get_config, storage_balance_bounds, a missing mandate, token balances", async () => {
    expect(JSON.parse((await view(VAULT, "get_config")) as string)).toMatchObject({
      allowed_tokens: [USDC, USDT],
      fee_receiver: "treasury.sandbox.near",
      max_fee_bps: 500,
      intents_account: "intents.near",
      caps: [
        { token: USDC, cap: "1000000000000000", mandate_cap: "1000000000000" },
        { token: USDT, cap: "1000000000000000", mandate_cap: "1000000000000" },
      ],
    });
    expect(await view(VAULT, "storage_balance_bounds")).toBe('{"min":"2000000000000000000000","max":null}');
    expect(await view(VAULT, "get_mandate", { mandate_id: 999_999 })).toBe("null");
    expect(await view(USDC, "ft_balance_of", { account_id: "nobody.near" })).toBe('"0"');
  });

  it("view errors take NEAR RPC shapes", async () => {
    const unknown = (await view("nobody.near", "get_config")) as unknown as { error: { cause: { name: string } } };
    expect(unknown.error.cause.name).toBe("UNKNOWN_ACCOUNT");
    const method = (await view(VAULT, "no_such_view")) as unknown as {
      error: { cause: { name: string; info: { vm_error: string } } };
    };
    expect(method.error.cause).toMatchObject({
      name: "CONTRACT_EXECUTION_ERROR",
      info: { vm_error: "MethodResolveError(MethodNotFound)" },
    });
    const bad = (await view(VAULT, "get_mandate", { mandate_id: "7" })) as unknown as {
      error: { cause: { info: { vm_error: string } } };
    };
    expect(bad.error.cause.info.vm_error).toContain("Failed to deserialize input from JSON.");
  });

  it("block returns a head with hash and time", async () => {
    const r = await rpc("block", { finality: "final" });
    const h = (r.result as { header: { height: number; hash: string; timestamp_nanosec: string } }).header;
    expect(h.height).toBeGreaterThan(0);
    expect(h.hash.length).toBeGreaterThan(30);
    expect(BigInt(h.timestamp_nanosec)).toBeGreaterThan(1_700_000_000_000_000_000n);
  });
});

describe("keeper collect (near-js signed send_tx)", () => {
  const keeper = "keeper.sandbox.near";
  const key = KeyPairEd25519.fromRandom();

  async function signedCollect(mandateId: number, nonce?: bigint, k = key) {
    const ak = await rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: keeper,
      public_key: k.getPublicKey().toString(),
    });
    const akNonce = BigInt((ak.result as { nonce: number } | undefined)?.nonce ?? 0);
    const block = (await rpc("block", { finality: "final" })).result as { header: { hash: string } };
    return signFunctionCall({
      key: k,
      signer: keeper,
      receiver: VAULT,
      nonce: nonce ?? akNonce + 1n,
      method: "collect",
      args: { mandate_id: mandateId },
      gas: 250n * TGAS,
      deposit: 0n,
      blockHash: block.header.hash,
    });
  }

  it("collect → collected, fee to the treasury, merchant credited in Intents; the feed carries receipt context", async () => {
    const id = await newMandate("alice.near", "30000000");
    const tx = await signedCollect(id);
    const r = await rpc("send_tx", { signed_tx_base64: tx.base64, wait_until: "FINAL" });
    const o = r.result as Outcome;
    expect(o.transaction.hash).toBe(tx.hash);
    expect(value(o)).toBe("true");
    expect(vaultLines(o)).toEqual([
      `EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"collected","data":[{"mandate_id":${id},"period":1,"amount":"10000000","merchant_share":"9900000","fee":"100000","balance":"20000000"}]}`,
    ]);
    expect(await view(USDC, "ft_balance_of", { account_id: "treasury.sandbox.near" })).toBe('"100000"');
    const credited = await s.database.db
      .selectFrom("sim_intents_balances")
      .select("amount")
      .where("account_id", "=", "merchant-demo.near")
      .where("token", "=", `nep141:${USDC}`)
      .executeTakeFirstOrThrow();
    expect(BigInt(credited.amount)).toBeGreaterThanOrEqual(9_900_000n);

    // same transaction again: the stored outcome, nothing executes twice
    const again = await rpc("broadcast_tx_commit", [tx.base64]);
    expect((again.result as Outcome).transaction.hash).toBe(tx.hash);
    expect(JSON.parse((await view(VAULT, "get_mandate", { mandate_id: id })) as string).collected_periods).toBe(1);

    // tx status lookup
    const st = await rpc("tx", { tx_hash: tx.hash, sender_account_id: keeper });
    expect(value(st.result as Outcome)).toBe("true");

    // indexer feed: the vault line with its receipt context
    const feed = await s.call("GET", "/sim/intents/events?cursor=0&limit=500");
    const events = (feed.body as { events: Record<string, unknown>[] }).events;
    const line = events.find((e) => e.tx_hash === tx.hash && e.executor_id === VAULT) as Record<string, unknown>;
    expect(line).toMatchObject({ log_index: 0, receipt_status: "success" });
    expect(line.receipt_id).toBe(
      o.receipts_outcome.find((x) => x.outcome.executor_id === VAULT && x.outcome.logs.length)?.id,
    );
    expect(typeof line.block_hash).toBe("string");
    expect(BigInt(line.block_timestamp as string)).toBeGreaterThan(0n);
    const seqs = events.map((e) => e.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("ERR_NOT_DUE until the mandate clock is advanced; other mandates keep their clock", async () => {
    const id = await newMandate("bob.near", "30000000");
    const other = await newMandate("carol.near", "30000000");
    expect(
      value((await rpc("send_tx", { signed_tx_base64: (await signedCollect(id)).base64 })).result as Outcome),
    ).toBe("true");
    const nd = (await rpc("send_tx", { signed_tx_base64: (await signedCollect(id)).base64 })).result as Outcome;
    expect(nd.status).toEqual({
      Failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: ERR_NOT_DUE" } },
        },
      },
    });
    const adv = await s.call("POST", "/sim/vault/advance", { mandate_id: id });
    expect(adv.status).toBe(200);
    const clock = SimVaultClock.parse(adv.body);
    expect(clock.clock_offset_secs).toBeGreaterThan(2_629_000);
    expect(BigInt(clock.now_ns)).toBeGreaterThanOrEqual(BigInt(clock.next_collect_at as string));
    // the views report next_collect_at on the real block time (due minus the offset), so a keeper comparing it with
    // the block timestamp sees the advanced mandate as due
    const blockNs = BigInt(
      ((await rpc("block", { finality: "final" })).result as { header: { timestamp_nanosec: string } }).header
        .timestamp_nanosec,
    );
    const viewNext = BigInt(JSON.parse((await view(VAULT, "next_collect_at", { mandate_id: id })) as string));
    expect(viewNext).toBe(BigInt(clock.next_collect_at as string) - BigInt(clock.clock_offset_secs) * 1_000_000_000n);
    expect(viewNext).toBeLessThanOrEqual(blockNs + 1_000_000_000n);
    const mv = JSON.parse((await view(VAULT, "get_mandate", { mandate_id: id })) as string) as {
      next_collect_at: string;
    };
    expect(BigInt(mv.next_collect_at)).toBe(viewNext);
    const c2 = (await rpc("send_tx", { signed_tx_base64: (await signedCollect(id)).base64 })).result as Outcome;
    expect(vaultLines(c2)[0]).toContain('"period":2');
    // carol's mandate collected period 1 at creation time, but her clock did not move
    await rpc("send_tx", { signed_tx_base64: (await signedCollect(other)).base64 });
    const nd2 = (await rpc("send_tx", { signed_tx_base64: (await signedCollect(other)).base64 })).result as Outcome;
    expect(JSON.stringify(nd2.status)).toContain("ERR_NOT_DUE");
    // advancing by explicit seconds is cumulative and forward-only
    const a2 = SimVaultClock.parse((await s.call("POST", "/sim/vault/advance", { mandate_id: id, secs: 10 })).body);
    expect(a2.clock_offset_secs).toBe(clock.clock_offset_secs + 10);
    expect((await s.call("POST", "/sim/vault/advance", { mandate_id: 987_654 })).status).toBe(404);
  });

  it("refuses bad signatures, reused nonces, a second key and unsupported calls (INVALID_TRANSACTION)", async () => {
    const id = await newMandate("dave.near", "10000000");
    const good = await signedCollect(id);
    const raw = Buffer.from(good.base64, "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 1;
    const bad = await rpc("send_tx", { signed_tx_base64: raw.toString("base64") });
    expect(bad.error?.cause).toMatchObject({ name: "INVALID_TRANSACTION", info: { InvalidSignature: null } });
    await rpc("send_tx", { signed_tx_base64: good.base64 });
    const reused = await rpc("send_tx", { signed_tx_base64: (await signedCollect(id, 1n)).base64 });
    expect(reused.error?.cause.name).toBe("INVALID_TRANSACTION");
    expect(Object.keys(reused.error?.cause.info ?? {})).toEqual(["InvalidNonce"]);
    const otherKey = KeyPairEd25519.fromRandom();
    const second = await rpc("send_tx", { signed_tx_base64: (await signedCollect(id, 1n, otherKey)).base64 });
    expect(Object.keys(second.error?.cause.info ?? {})).toEqual(["InvalidAccessKeyError"]);
    const ak = await rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: keeper,
      public_key: otherKey.getPublicKey().toString(),
    });
    expect(ak.error?.cause.name).toBe("UNKNOWN_ACCESS_KEY");
    const garbage = await rpc("send_tx", { signed_tx_base64: "AAAA" });
    expect(garbage.error?.cause.name).toBe("INVALID_TRANSACTION");
    const unknown = await rpc("tx", { tx_hash: "11111111111111111111111111111111", sender_account_id: keeper });
    expect(unknown.error?.cause.name).toBe("UNKNOWN_TRANSACTION");
  });
});

describe("payer paths (/sim/vault/*)", () => {
  it("funding rejections return the tokens with the exact log line", async () => {
    await vcall("erin.near", "storage_deposit", {}, { deposit: STORAGE });
    const r = await fund("erin.near", "5000000", createMsg({ fee_bps: 501 }));
    expect(value(r)).toBe('"0"');
    expect(vaultLines(r)).toEqual(["ERR_FEE_TOO_HIGH"]);
    expect(await view(USDC, "ft_balance_of", { account_id: "erin.near" })).toBe('"5000000"');
    const cap = await fund("erin.near", "1000000000001", createMsg());
    expect(vaultLines(cap)).toEqual(["ERR_CAP_EXCEEDED: mandate"]);
    const sender = await fund("intents.near", "5000000", createMsg());
    expect(vaultLines(sender)).toEqual(["ERR_UNSUPPORTED_SENDER"]);
    const token = await fund("erin.near", "5000000", createMsg(), "wrap.near");
    const vaultReceipt = token.receipts_outcome.find((x) => x.outcome.executor_id === VAULT);
    expect(JSON.stringify(vaultReceipt?.outcome.status)).toContain("Smart contract panicked: ERR_TOKEN_NOT_ALLOWED");
    expect(value(token)).toBe('"0"');
  });

  it("cancel refunds the payer; withdraw needs a closed mandate; gas and 1-yocto guards", async () => {
    const id = await newMandate("frank.near", "20000000");
    const lowGas = await vcall("frank.near", "cancel", { mandate_id: id }, { gas: String(49n * TGAS) });
    expect(JSON.stringify(lowGas.status)).toContain("ERR_GAS");
    const noYocto = await vcall("frank.near", "cancel", { mandate_id: id }, { deposit: "0" });
    expect(JSON.stringify(noYocto.status)).toContain("Requires attached deposit of exactly 1 yoctoNEAR");
    const still = await vcall("frank.near", "withdraw", { mandate_id: id });
    expect(JSON.stringify(still.status)).toContain("ERR_STILL_ACTIVE");
    const stranger = await vcall("mallory.near", "cancel", { mandate_id: id });
    expect(JSON.stringify(stranger.status)).toContain("ERR_UNAUTHORIZED");
    const c = await vcall("frank.near", "cancel", { mandate_id: id });
    expect(value(c)).toBe("true");
    expect(vaultLines(c)).toEqual([
      `EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"canceled","data":[{"mandate_id":${id},"by":"frank.near","refunded":"20000000"}]}`,
    ]);
    expect(await view(VAULT, "get_mandate", { mandate_id: id })).toBe("null");
    expect(await view(USDC, "ft_balance_of", { account_id: "frank.near" })).toBe('"20000000"');
    expect(await view(VAULT, "storage_balance_of", { account_id: "frank.near" })).toBe(
      '{"total":"12000000000000000000000","available":"10000000000000000000000"}',
    );
  });
});

describe("scenarios 91–94 (sandbox §4.2)", () => {
  async function collectOnce(id: number) {
    return vcall("keeper2.sandbox.near", "collect", { mandate_id: id });
  }

  it("91: the merchant leg fails → collect_failed, period not counted, balance kept", async () => {
    const id = await newMandate("p91.near", "30000091", { amount_per_period: "10000091" });
    const o = await collectOnce(id);
    expect(value(o)).toBe("false");
    expect(vaultLines(o)).toEqual([
      `EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"collect_failed","data":[{"mandate_id":${id},"period":1,"reason":"merchant_transfer_failed"}]}`,
    ]);
    const m = JSON.parse((await view(VAULT, "get_mandate", { mandate_id: id })) as string);
    expect(m).toMatchObject({ collected_periods: 0, balance: "30000091", in_flight: false });
  });

  it("92: the fee leg fails → collected with fee 0, the fee stays in the balance", async () => {
    const id = await newMandate("p92.near", "30000092", { amount_per_period: "10000092" });
    const o = await collectOnce(id);
    // share = floor(10000092 × 9900 / 10000) = 9900091, fee 100001
    expect(vaultLines(o)[0]).toContain('"amount":"9900091","merchant_share":"9900091","fee":"0","balance":"20100001"');
  });

  it("93: the first refund fails → canceled refunded 0; a later withdraw succeeds", async () => {
    const id = await newMandate("p93.near", "20000093", { amount_per_period: "10000093" });
    const c = await vcall("p93.near", "cancel", { mandate_id: id });
    expect(value(c)).toBe("false");
    expect(vaultLines(c)).toEqual([
      `EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"canceled","data":[{"mandate_id":${id},"by":"p93.near","refunded":"0"}]}`,
    ]);
    const w = await vcall("p93.near", "withdraw", { mandate_id: id });
    expect(value(w)).toBe("true");
    expect(vaultLines(w)).toEqual([
      `EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"withdrawn","data":[{"mandate_id":${id},"amount":"20000093"}]}`,
    ]);
  });

  it("94: partial delivery floor(share/2) → collected with the short share, fee 0", async () => {
    const id = await newMandate("p94.near", "30000094", { amount_per_period: "10000094" });
    const o = await collectOnce(id);
    // share 9900093 → delivered 4950046; balance 30000094 − 4950046
    expect(vaultLines(o)[0]).toContain('"amount":"4950046","merchant_share":"4950046","fee":"0","balance":"25050048"');
  });
});

describe("indexer feed order", () => {
  it("a line that commits late is still delivered after the cursor (positions in commit order)", async () => {
    const db = s.database.db;
    const before = (await s.call("GET", "/sim/intents/events?cursor=0&limit=500")).body as { next_cursor: number };
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    // A inserts first (lower sequence value) but commits after B
    const a = db.transaction().execute(async (tx) => {
      await tx.insertInto("sim_intents_events").values({ tx_hash: "late-tx-A", block_height: "1", log: "A" }).execute();
      await held;
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      await db
        .insertInto("sim_intents_events")
        .values({ tx_hash: "early-tx-B", block_height: "2", log: "B" })
        .execute();
      const first = await s.call("GET", `/sim/intents/events?cursor=${before.next_cursor}&limit=500`);
      expect(first.status).toBe(200);
      const page = first.body as { events: { tx_hash: string }[]; next_cursor: number };
      expect(page.events.map((e) => e.tx_hash)).toEqual(["early-tx-B"]);
      release();
      await a;
      const second = (await s.call("GET", `/sim/intents/events?cursor=${page.next_cursor}&limit=500`)).body as {
        events: { tx_hash: string }[];
      };
      expect(second.events.map((e) => e.tx_hash)).toEqual(["late-tx-A"]);
    } finally {
      release(); // never leave the transaction open (the stack could not stop)
      await a;
    }
  });
});

describe("test mode only", () => {
  it("refuses a live-mode principal (INV-8)", async () => {
    const live = await mintTestToken({ sub: "billing", ptype: "service", scp: ["sandbox.use"], lm: true });
    for (const [url, body] of [
      ["/sim/vault/call", { signer: "a.near", method: "collect", args: { mandate_id: 0 } }],
      ["/sim/vault/advance", { mandate_id: 0 }],
      ["/sim/near-rpc", { jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }],
      ["/sim/vault/ft_transfer_call", { payer: "a.near", token: USDC, amount: "1", msg: "{}" }],
    ] as const) {
      const r = await s.call("POST", url, body, live);
      expect([r.status, (r.body as { error: { code: string } }).error.code]).toEqual([403, "livemode_forbidden"]);
    }
  });
});
