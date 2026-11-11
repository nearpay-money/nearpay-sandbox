/** The simulated Verifier: real signatures, mainnet rejection messages, atomic batches, event feed. */

import {
  buildPayload,
  classifyVerifierError,
  evmAddress,
  implicitAccountId,
  intentsExecuted,
  makeNonce,
  mtTransfers,
  parseDip4Events,
  signErc191,
  signNep413,
  signRawEd25519,
} from "@nearpay-internal/intents";
import { ErrorEnvelope, type IntentMessage, type MultiPayload } from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USDC_NEAR } from "../support/requests.js";
import { type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const SALT = "5a0dbe11";
const edKey = () => ed25519.utils.randomSecretKey();
const deadline = (ms = 120_000) => new Date(Date.now() + ms).toISOString();

function message(signer: string, intents: IntentMessage["intents"], over: Partial<IntentMessage> = {}): IntentMessage {
  return buildPayload({
    signerId: signer,
    deadline: deadline(),
    nonce: makeNonce(SALT),
    intents,
    ...over,
  } as never) as IntentMessage;
}
const transfer = (to: string, amount: string, memo?: string) =>
  ({ intent: "transfer", receiver_id: to, tokens: { [USDC_NEAR]: amount }, ...(memo ? { memo } : {}) }) as const;

async function fund(account: string, amount: string) {
  const r = await s.call("POST", "/sim/intents/fund", { account_id: account, token: USDC_NEAR, amount });
  expect(r.status).toBe(200);
  return (r.body as { balance: string }).balance;
}
const simulate = (signed: MultiPayload[]) => s.call("POST", "/sim/intents/simulate", { signed });
const execute = async (signed: MultiPayload[]) => {
  const r = await s.call("POST", "/sim/intents/execute", { signed });
  expect(r.status).toBe(200);
  return r.body as {
    tx_hash: string;
    block_height: number;
    status: string;
    failure: string | null;
    intents_executed: unknown[];
  };
};
async function balance(account: string): Promise<bigint> {
  const r = await s.database.db
    .selectFrom("sim_intents_balances")
    .select("amount")
    .where("account_id", "=", account)
    .where("token", "=", USDC_NEAR)
    .executeTakeFirst();
  return BigInt(r?.amount ?? "0");
}

describe("fund", () => {
  it("credits balances and emits an mt_mint", async () => {
    const acct = implicitAccountId(ed25519.getPublicKey(edKey()));
    expect(await fund(acct, "1000")).toBe("1000");
    expect(await fund(acct, "500")).toBe("1500");
    const r = await s.call("POST", "/sim/intents/fund", { account_id: acct, token: USDC_NEAR, amount: "0" });
    expect(r.status).toBe(400);
  });
});

describe("simulate and execute", () => {
  it("executes an implicit-account NEP-413 payment (merchant + fee transfers with the binding memo)", async () => {
    const sk = edKey();
    const payer = implicitAccountId(ed25519.getPublicKey(sk));
    await fund(payer, "10025");
    const binding = "np1:3yZe7d5Bcv1ZTkNe5U5w4mbR1XK8Wb1pXtZqYfVvR8c1";
    const signed = signNep413(
      message(payer, [transfer("merchant.near", "10000", binding), transfer("treasury.nearpay.near", "25", binding)]),
      sk,
    );
    const sim = await simulate([signed]);
    expect(sim.status).toBe(200);
    const out = sim.body as {
      intents_executed: { account_id: string }[];
      logs: string[];
      state: { current_salt: string };
    };
    expect(out.intents_executed).toHaveLength(1);
    expect(out.intents_executed[0]?.account_id).toBe(payer);
    expect(out.state.current_salt).toBe(SALT);
    expect(await balance(payer)).toBe(10_025n); // simulation changes nothing

    const before = await balance("merchant.near");
    const ex = await execute([signed]);
    expect([ex.status, ex.failure]).toEqual(["success", null]);
    expect(ex.tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(await balance(payer)).toBe(0n);
    expect((await balance("merchant.near")) - before).toBe(10_000n);

    const feed = await s.call("GET", "/sim/intents/events?cursor=0&limit=500");
    const logs = (feed.body as { events: { tx_hash: string; log: string }[] }).events
      .filter((e) => e.tx_hash === ex.tx_hash)
      .map((e) => e.log);
    expect(mtTransfers(logs)).toEqual([
      { old_owner_id: payer, new_owner_id: "merchant.near", token_ids: [USDC_NEAR], amounts: ["10000"] },
      {
        old_owner_id: payer,
        new_owner_id: "treasury.nearpay.near",
        token_ids: [USDC_NEAR],
        amounts: ["25"],
      },
    ]);
    // The binding memo rides on the DIP-4 transfer events only, as on mainnet (SP-14).
    const dip4 = parseDip4Events(logs).filter((e) => e.event === "transfer");
    expect(dip4.map((e) => (e.data as { memo?: string }[])[0]?.memo)).toEqual([binding, binding]);
    expect(intentsExecuted(logs)).toEqual(ex.intents_executed);
  });

  it("rejects a replayed nonce (simulate: intent_invalid; execute: on-chain failure)", async () => {
    const sk = edKey();
    const payer = implicitAccountId(ed25519.getPublicKey(sk));
    await fund(payer, "20");
    const signed = signNep413(message(payer, [transfer("merchant.near", "5")]), sk);
    expect((await execute([signed])).status).toBe("success");
    const sim = await simulate([signed]);
    expect([sim.status, ErrorEnvelope.parse(sim.body).error.code]).toEqual([400, "intent_invalid"]);
    expect(classifyVerifierError(ErrorEnvelope.parse(sim.body).error.message)).toBe("nonce_used");
    const ex = await execute([signed]);
    expect(ex.status).toBe("failure");
    expect(classifyVerifierError(ex.failure as string)).toBe("nonce_used");
    expect(await balance(payer)).toBe(15n);
  });

  it("maps an insufficient balance like mainnet", async () => {
    const sk = edKey();
    const payer = implicitAccountId(ed25519.getPublicKey(sk));
    const signed = signNep413(message(payer, [transfer("merchant.near", "5")]), sk);
    const sim = await simulate([signed]);
    expect([sim.status, ErrorEnvelope.parse(sim.body).error.code]).toEqual([402, "insufficient_balance"]);
    expect(classifyVerifierError(ErrorEnvelope.parse(sim.body).error.message)).toBe("insufficient_funds");
    const ex = await execute([signed]);
    expect(classifyVerifierError(ex.failure as string)).toBe("insufficient_funds");
  });

  it("rejects a bad signature, an expired deadline and a key that does not own the implicit account", async () => {
    const sk = edKey();
    const payer = implicitAccountId(ed25519.getPublicKey(sk));
    await fund(payer, "100");
    const good = signNep413(message(payer, [transfer("merchant.near", "5")]), sk) as MultiPayload & {
      signature: string;
    };
    const bad = { ...good, signature: signNep413(message(payer, [transfer("merchant.near", "6")]), sk).signature };
    expect(classifyVerifierError(ErrorEnvelope.parse((await simulate([bad as MultiPayload])).body).error.message)).toBe(
      "invalid_signature",
    );
    const expired = signNep413(message(payer, [transfer("merchant.near", "5")], { deadline: deadline(-1000) }), sk);
    expect(classifyVerifierError(ErrorEnvelope.parse((await simulate([expired])).body).error.message)).toBe(
      "deadline_invalid",
    );
    const other = edKey();
    const stolen = signNep413(message(payer, [transfer("merchant.near", "5")]), other);
    const msg = ErrorEnvelope.parse((await simulate([stolen])).body).error.message;
    expect(msg).toContain(`doesn't exist for account '${payer}'`);
    expect(classifyVerifierError(msg)).toBe("invalid_signature");
  });

  it("registers the first key of a named account and refuses other keys afterwards", async () => {
    const owner = edKey();
    const name = `agent-${Date.now()}.near`;
    await fund(name, "100");
    expect((await execute([signNep413(message(name, [transfer("merchant.near", "1")]), owner)])).status).toBe(
      "success",
    );
    expect((await execute([signNep413(message(name, [transfer("merchant.near", "1")]), owner)])).status).toBe(
      "success",
    );
    const intruder = await execute([signNep413(message(name, [transfer("merchant.near", "1")]), edKey())]);
    expect(intruder.status).toBe("failure");
    expect(classifyVerifierError(intruder.failure as string)).toBe("invalid_signature");
    expect(await balance(name)).toBe(98n);
  });

  it("accepts ERC-191 from an eth-implicit account and raw ed25519 from an implicit account", async () => {
    const evmSk = secp256k1.utils.randomSecretKey();
    const evmAcct = evmAddress(secp256k1.getPublicKey(evmSk));
    await fund(evmAcct, "50");
    const e = await execute([signErc191(message(evmAcct, [transfer("merchant.near", "50")]), evmSk)]);
    expect(e.status).toBe("success");
    const sk = edKey();
    const acct = implicitAccountId(ed25519.getPublicKey(sk));
    await fund(acct, "7");
    expect((await execute([signRawEd25519(message(acct, [transfer("merchant.near", "7")]), sk)])).status).toBe(
      "success",
    );
  });

  it("refuses intents other than transfer", async () => {
    const sk = edKey();
    const acct = implicitAccountId(ed25519.getPublicKey(sk));
    const signed = signNep413(message(acct, [{ intent: "ft_withdraw", token: "usdc.near" } as never]), sk);
    const sim = await simulate([signed]);
    expect(ErrorEnvelope.parse(sim.body).error.message).toContain("unsupported intent: ft_withdraw");
  });

  it("executes a batch atomically: one bad payload fails all and changes nothing", async () => {
    const a = edKey();
    const b = edKey();
    const accA = implicitAccountId(ed25519.getPublicKey(a));
    const accB = implicitAccountId(ed25519.getPublicKey(b));
    await fund(accA, "10");
    const okPayload = signNep413(message(accA, [transfer("merchant.near", "10")]), a);
    const broke = signNep413(message(accB, [transfer("merchant.near", "10")]), b); // accB has no funds
    const ex = await execute([okPayload, broke]);
    expect(ex.status).toBe("failure");
    expect(await balance(accA)).toBe(10n);
    // the good payload alone still works (its nonce was not consumed)
    expect((await execute([okPayload])).status).toBe("success");
  });

  it("checks balances across the payloads of one batch", async () => {
    const sk = edKey();
    const acct = implicitAccountId(ed25519.getPublicKey(sk));
    await fund(acct, "10");
    const p1 = signNep413(message(acct, [transfer("merchant.near", "6")]), sk);
    const p2 = signNep413(message(acct, [transfer("merchant.near", "6")]), sk);
    const sim = await simulate([p1, p2]);
    expect(ErrorEnvelope.parse(sim.body).error.code).toBe("insufficient_balance");
  });
});

describe("event feed", () => {
  it("pages by cursor", async () => {
    await fund(implicitAccountId(ed25519.getPublicKey(edKey())), "1");
    await fund(implicitAccountId(ed25519.getPublicKey(edKey())), "1");
    const all = (await s.call("GET", "/sim/intents/events?cursor=0&limit=500")).body as {
      events: { seq: number }[];
      next_cursor: number;
    };
    expect(all.events.length).toBeGreaterThanOrEqual(2);
    const seqs = all.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    const page = (await s.call("GET", `/sim/intents/events?cursor=${seqs[0]}&limit=1`)).body as {
      events: { seq: number }[];
      next_cursor: number;
    };
    expect(page.events.map((e) => e.seq)).toEqual([seqs[1]]);
    expect(page.next_cursor).toBe(seqs[1]);
    const end = (await s.call("GET", `/sim/intents/events?cursor=${all.next_cursor}`)).body as {
      events: unknown[];
      next_cursor: number;
    };
    expect(end).toEqual({ events: [], next_cursor: all.next_cursor });
  });
});
