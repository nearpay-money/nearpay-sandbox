import { describe, expect, it } from "vitest";
import {
  createMsg,
  failure,
  Harness,
  statusValue,
  T0,
  TREASURY,
  USDC,
  VAULT,
  vaultLogs,
} from "../../support/vault-harness.js";

describe("vault stand-in smoke", () => {
  it("create → collect → cancel", async () => {
    const h = new Harness();
    await h.register("alice.near");
    const f = await h.fund("alice.near", USDC, 30_000_000n, createMsg());
    expect(statusValue(f)).toBe('"30000000"');
    expect(vaultLogs(f)[0]).toContain('"event":"mandate_created"');
    const c = await h.call("keeper.near", "collect", { mandate_id: 0 });
    expect(statusValue(c)).toBe("true");
    expect(vaultLogs(c)).toEqual([
      'EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"collected","data":[{"mandate_id":0,"period":1,"amount":"10000000","merchant_share":"9900000","fee":"100000","balance":"20000000"}]}',
    ]);
    expect(await h.mem.ft(USDC, TREASURY)).toBe(100_000n);
    expect(h.mem.intents.get(`merchant-demo.near\u0000nep141:${USDC}`)).toBe(9_900_000n);
    const nd = await h.call("keeper.near", "collect", { mandate_id: 0 });
    expect(failure(nd)).toBe("Smart contract panicked: ERR_NOT_DUE");
    h.now = T0 + 2_629_746n * 1_000_000_000n;
    const x = await h.call("alice.near", "cancel", { mandate_id: 0 });
    expect(statusValue(x)).toBe("true");
    expect(vaultLogs(x)).toEqual([
      'EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"canceled","data":[{"mandate_id":0,"by":"alice.near","refunded":"20000000"}]}',
    ]);
    expect(await h.mandate(0)).toBeNull();
    expect(await h.mem.ft(USDC, "alice.near")).toBe(20_000_000n);
    expect(await h.mem.ft(USDC, VAULT)).toBe(0n);
  });
});
