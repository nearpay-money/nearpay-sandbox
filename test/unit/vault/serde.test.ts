/** The serde_json-faithful input layer and the `msg` rules (contracts-vault §3.1, `msg.rs`). */
import { describe, expect, it } from "vitest";
import { isValidAccountId } from "../../../src/domain/vault/account-id.js";
import { dueAt, elapsedPeriods, saturatingAddU64, split } from "../../../src/domain/vault/math.js";
import { extRefIsValid, parseMsg, validateCreate } from "../../../src/domain/vault/msg.js";
import {
  bool,
  field,
  option,
  parseJson,
  SerdeError,
  struct,
  U16_MAX,
  U64_MAX,
  U128_MAX,
  uint,
  uintString,
  unitEnum,
} from "../../../src/domain/vault/serde-json.js";

const cm = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    create_mandate: {
      merchant_receiver: "m.near",
      receiver_kind: "intents_account",
      amount_per_period: "10000000",
      period_secs: 86_400,
      start_at: null,
      max_periods: null,
      fee_bps: 100,
      ext_ref: "sub_1",
      ...over,
    },
  });

describe("parseJson (serde_json grammar)", () => {
  it("accepts JSON with whitespace and keeps number lexemes", () => {
    expect(parseJson(' { "a" : [1, -2.5e3, true, false, null, "x\\u00e9\\n"] } ')).toEqual({
      t: "obj",
      v: [
        [
          "a",
          {
            t: "arr",
            v: [
              { t: "num", lex: "1" },
              { t: "num", lex: "-2.5e3" },
              { t: "bool", v: true },
              { t: "bool", v: false },
              { t: "null" },
              { t: "str", v: "xé\n" },
            ],
          },
        ],
      ],
    });
  });

  it.each([
    ["trailing", "{} x"],
    ["leading zero", "01"],
    ["bare minus", "-"],
    ["unterminated string", '"abc'],
    ["control char", '"a\u0001"'],
    ["bad escape", '"\\x"'],
    ["short unicode escape", '"\\u12"'],
    ["lone leading surrogate", '"\\ud800"'],
    ["lone trailing surrogate", '"\\udc00"'],
    ["bad low surrogate", '"\\ud800\\u0041"'],
    ["raw lone surrogate", '"\ud800"'],
    ["raw lone low surrogate", '"\udc00"'],
    ["unquoted key", "{a:1}"],
    ["missing colon", '{"a" 1}'],
    ["missing comma", '{"a":1 "b":2}'],
    ["array missing comma", "[1 2]"],
    ["bad literal", "tru"],
    ["empty", ""],
    ["junk", "@"],
  ])("rejects %s", (_n, text) => {
    expect(() => parseJson(text)).toThrow(SerdeError);
  });

  it("accepts surrogate pairs (escaped and raw) and empty containers", () => {
    expect(parseJson('"\\ud83d\\ude00"')).toEqual({ t: "str", v: "😀" });
    expect(parseJson('"😀"')).toEqual({ t: "str", v: "😀" });
    expect(parseJson("[]")).toEqual({ t: "arr", v: [] });
    expect(parseJson('"\\"\\\\\\/\\b\\f\\r\\t"')).toEqual({ t: "str", v: '"\\/\b\f\r\t' });
  });

  it("stops at serde_json's recursion limit (128)", () => {
    expect(() => parseJson(`${"[".repeat(128)}${"]".repeat(128)}`)).not.toThrow();
    expect(() => parseJson(`${"[".repeat(129)}${"]".repeat(129)}`)).toThrow(/recursion/);
  });
});

describe("decoders", () => {
  it("unsigned integers: integer lexemes only, in range (floats, -0 and negatives fail)", () => {
    const u16 = uint(U16_MAX);
    expect(u16(parseJson("65535"))).toBe(65535n);
    for (const bad of ["65536", "1.0", "1e2", "-0", "-1", '"1"']) expect(() => u16(parseJson(bad))).toThrow(SerdeError);
    expect(uint(U64_MAX)(parseJson("18446744073709551615"))).toBe(U64_MAX);
    expect(() => uint(U64_MAX)(parseJson("18446744073709551616"))).toThrow(SerdeError);
  });

  it("U128 strings parse like Rust from_str_radix (optional +, leading zeros)", () => {
    const u = uintString(U128_MAX);
    expect(u(parseJson('"+007"'))).toBe(7n);
    expect(u(parseJson(`"${U128_MAX}"`))).toBe(U128_MAX);
    for (const bad of ['"-1"', '"+"', '""', '" 1"', '"1.0"', "1", `"${U128_MAX + 1n}"`, '"++1"'])
      expect(() => u(parseJson(bad))).toThrow(SerdeError);
  });

  it("unit enums accept the name or serde's map form", () => {
    const e = unitEnum(["a", "b"] as const);
    expect(e(parseJson('"a"'))).toBe("a");
    expect(e(parseJson('{"b":null}'))).toBe("b");
    for (const bad of ['"c"', '{"a":1}', '{"a":null,"b":null}', "1"])
      expect(() => e(parseJson(bad))).toThrow(SerdeError);
  });

  it("structs: map and sequence forms, duplicates, unknown fields, defaults", () => {
    const s = struct([field("x", uint(U64_MAX)), field("y", option(bool), { optional: true })] as const, {
      denyUnknown: false,
    });
    expect(s(parseJson('{"x":1}'))).toEqual([1n, null]);
    expect(s(parseJson('{"x":1,"z":{"deep":[1]},"z":2}'))).toEqual([1n, null]);
    expect(s(parseJson("[1, true]"))).toEqual([1n, true]);
    expect(() => s(parseJson("[1]"))).toThrow(/invalid length/); // no #[serde(default)] → short sequence fails
    expect(() => s(parseJson("[1, true, 3]"))).toThrow(SerdeError);
    expect(() => s(parseJson('{"x":1,"x":2}'))).toThrow(/duplicate/);
    expect(() => s(parseJson('{"y":true}'))).toThrow(/missing/);
    expect(() => s(parseJson('"x"'))).toThrow(SerdeError);
    const strict = struct([field("x", uint(U64_MAX), { fallback: () => 5n })] as const, { denyUnknown: true });
    expect(strict(parseJson("{}"))).toEqual([5n]);
    expect(strict(parseJson("[]"))).toEqual([5n]);
    expect(() => strict(parseJson('{"q":1}'))).toThrow(/unknown/);
  });
});

describe("parseMsg (VaultMsg)", () => {
  it("parses create_mandate and top_up", () => {
    expect(parseMsg(cm())).toMatchObject({
      create_mandate: { amount_per_period: 10_000_000n, fee_bps: 100, start_at: null },
    });
    expect(parseMsg('{"top_up":{"mandate_id":7}}')).toEqual({ top_up: { mandate_id: 7n } });
    expect(parseMsg('{"top_up":[7]}')).toEqual({ top_up: { mandate_id: 7n } });
    // omitted optional fields default (serde(default))
    const { create_mandate: c } = JSON.parse(cm());
    const { start_at: _s, max_periods: _m, ...rest } = c;
    expect(parseMsg(JSON.stringify({ create_mandate: rest }))).toMatchObject({
      create_mandate: { start_at: null, max_periods: null },
    });
    expect(parseMsg(cm({ receiver_kind: { near_account: null }, start_at: "+0005", max_periods: 3 }))).toMatchObject({
      create_mandate: { receiver_kind: "near_account", start_at: 5n, max_periods: 3 },
    });
  });

  it.each([
    ["not JSON", "{"],
    ["a string", '"top_up"'],
    ["two variants", '{"top_up":{"mandate_id":1},"create_mandate":{}}'],
    ["no variant", "{}"],
    ["unknown variant", '{"withdraw":{}}'],
    ["unknown field", cm({ extra: 1 })],
    ["duplicate field", cm().replace('"fee_bps":100', '"fee_bps":100,"fee_bps":1')],
    ["float fee", cm({ fee_bps: 1.5 })],
    ["fee above u16", cm({ fee_bps: 70_000 })],
    ["amount as number", cm({ amount_per_period: 10 })],
    ["negative amount", cm({ amount_per_period: "-1" })],
    ["bad account", cm({ merchant_receiver: "Bad.near" })],
    ["max_periods above u32", cm({ max_periods: 4_294_967_296 })],
    ["top_up extra field", '{"top_up":{"mandate_id":1,"x":2}}'],
    ["too long", `${cm({ ext_ref: "a".repeat(2100) })}`],
  ])("ERR_BAD_MSG: %s", (_n, msg) => {
    expect(parseMsg(msg)).toBe("ERR_BAD_MSG");
  });
});

describe("validateCreate", () => {
  const base = (over: Record<string, unknown> = {}) => (parseMsg(cm(over)) as { create_mandate: never }).create_mandate;
  const now = 1_794_268_800_000_000_000n;
  it("rule order: shape → fee → zero share", () => {
    expect(validateCreate(base(), 500, "v.near", now)).toBeNull();
    expect(validateCreate(base({ fee_bps: 501 }), 500, "v.near", now)).toBe("ERR_FEE_TOO_HIGH");
    expect(validateCreate(base({ fee_bps: 501, period_secs: 1 }), 500, "v.near", now)).toBe("ERR_BAD_MSG");
    expect(validateCreate(base({ amount_per_period: "1", fee_bps: 1 }), 500, "v.near", now)).toBe("ERR_BAD_MSG");
  });
  it.each([
    ["zero amount", { amount_per_period: "0" }],
    ["short period", { period_secs: 86_399 }],
    ["long period", { period_secs: 379_468_801 }],
    ["zero max", { max_periods: 0 }],
    ["max above 2^31-1", { max_periods: 2_147_483_648 }],
    ["start too late", { start_at: (now + 31_622_400_000_000_001n).toString() }],
    ["ext_ref not printable", { ext_ref: "a\tb" }],
    ["ext_ref too long", { ext_ref: "a".repeat(65) }],
    ["merchant is the vault", { merchant_receiver: "v.near" }],
  ])("ERR_BAD_MSG: %s", (_n, over) => {
    expect(validateCreate(base(over), 500, "v.near", now)).toBe("ERR_BAD_MSG");
  });
  it("bounds are inclusive", () => {
    expect(
      validateCreate(
        base({ period_secs: 379_468_800, max_periods: 2_147_483_647, ext_ref: "~".repeat(64) }),
        500,
        "v.near",
        now,
      ),
    ).toBeNull();
    expect(
      validateCreate(base({ start_at: (now + 31_622_400_000_000_000n).toString() }), 500, "v.near", now),
    ).toBeNull();
    expect(extRefIsValid("é")).toBe(false);
  });
});

describe("math and account ids", () => {
  it("split, dueAt, elapsedPeriods, saturating add", () => {
    expect(split(10_000_000n, 100)).toEqual({ share: 9_900_000n, fee: 100_000n });
    expect(split(100n, 20_000)).toEqual({ share: 0n, fee: 100n });
    expect(() => split(-1n, 0)).toThrow(RangeError);
    expect(dueAt(5n, 0, 86_400n)).toBe(5n);
    expect(dueAt(U64_MAX, 1, 86_400n)).toBeNull();
    expect(elapsedPeriods(100n, 86_400n, 99n)).toBe(0n);
    expect(elapsedPeriods(100n, 86_400n, 100n)).toBe(1n);
    expect(elapsedPeriods(100n, 0n, 200n)).toBe(0n);
    expect(saturatingAddU64(U64_MAX, 1n)).toBe(U64_MAX);
  });
  it.each([
    ["alice.near", true],
    ["a1-b_c.d", true],
    ["0x52908400098527886e0f7030069857d2e4169ee7", true],
    ["a", false],
    ["a".repeat(65), false],
    ["Alice.near", false],
    [".alice", false],
    ["alice.", false],
    ["al..ice", false],
    ["al-.ice", false],
    ["al ice", false],
  ])("%s → %s", (id, valid) => {
    expect(isValidAccountId(id)).toBe(valid);
  });
});
