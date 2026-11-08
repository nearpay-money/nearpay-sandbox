/**
 * JSON as the vault contract reads it (`serde_json` + serde derive + near-sdk JSON types), so the stand-in accepts
 * and rejects exactly the inputs the deployed vault does (sandbox LLD §3.1: "rules … are those of the contract").
 * `JSON.parse` differs from `serde_json` in ways that change outcomes: duplicate keys (serde derive rejects a
 * repeated field, `JSON.parse` keeps the last), number lexemes (`1.0`, `1e2`, `-0` are floats to serde and fail
 * integer fields; integers beyond `u64` are floats too), structs given as arrays (serde accepts the sequence form),
 * unit enum variants given as `{"variant": null}`, lone surrogate escapes (rejected) and the recursion limit (128).
 *
 * Pure: no I/O. Every failure is a {@link SerdeError}; callers map it to the contract's own error (`ERR_BAD_MSG`
 * for `msg`, near-sdk's "Failed to deserialize input from JSON." for method arguments).
 */

export class SerdeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerdeError";
  }
}

const fail = (message: string): never => {
  throw new SerdeError(message);
};

/** A parsed JSON value keeping what serde distinguishes: number lexemes and object key order (with repeats). */
export type JVal =
  | { readonly t: "null" }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "num"; readonly lex: string }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "arr"; readonly v: readonly JVal[] }
  | { readonly t: "obj"; readonly v: readonly (readonly [string, JVal])[] };

/** serde_json's default recursion limit. */
const RECURSION_LIMIT = 128;

/** Parses one JSON document like `serde_json::from_str` (whitespace around it allowed, nothing else). */
export function parseJson(text: string): JVal {
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const hex4 = (): number => {
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("invalid escape");
    i += 4;
    return Number.parseInt(h, 16);
  };
  const str = (): string => {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= n) fail("EOF while parsing a string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return out;
      }
      if (c < 0x20) fail("control character in string");
      if (c === 0x5c) {
        i++;
        const e = text[i++];
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const u = hex4();
            if (u >= 0xdc00 && u <= 0xdfff) fail("lone trailing surrogate");
            if (u >= 0xd800 && u <= 0xdbff) {
              if (text[i] !== "\\" || text[i + 1] !== "u") fail("lone leading surrogate");
              i += 2;
              const lo = hex4();
              if (lo < 0xdc00 || lo > 0xdfff) fail("invalid low surrogate");
              out += String.fromCharCode(u, lo);
            } else out += String.fromCharCode(u);
            break;
          }
          default:
            fail("invalid escape");
        }
        continue;
      }
      // Raw characters: the text is a JS string, so a raw lone surrogate is not valid UTF-8 for Rust.
      if (c >= 0xd800 && c <= 0xdbff) {
        const lo = text.charCodeAt(i + 1);
        if (!(lo >= 0xdc00 && lo <= 0xdfff)) fail("invalid unicode");
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) fail("invalid unicode");
      out += text[i];
      i++;
    }
  };
  const num = (): JVal => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!m) fail("invalid number");
    const lex = (m as RegExpExecArray)[0];
    // serde_json rejects a digit right after a leading zero ("01")
    const after = text[i + lex.length];
    if (after !== undefined && /[0-9]/.test(after)) fail("invalid number");
    i += lex.length;
    return { t: "num", lex };
  };
  const lit = (word: string, v: JVal): JVal => {
    if (text.slice(i, i + word.length) !== word) fail("expected value");
    i += word.length;
    return v;
  };
  const value = (depth: number): JVal => {
    ws();
    if (i >= n) fail("EOF while parsing a value");
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth >= RECURSION_LIMIT) fail("recursion limit exceeded");
    }
    if (c === "{") {
      i++;
      const entries: (readonly [string, JVal])[] = [];
      ws();
      if (text[i] === "}") {
        i++;
        return { t: "obj", v: entries };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("key must be a string");
        const k = str();
        ws();
        if (text[i] !== ":") fail("expected `:`");
        i++;
        entries.push([k, value(depth + 1)]);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return { t: "obj", v: entries };
        }
        fail("expected `,` or `}`");
      }
    }
    if (c === "[") {
      i++;
      const items: JVal[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return { t: "arr", v: items };
      }
      for (;;) {
        items.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return { t: "arr", v: items };
        }
        fail("expected `,` or `]`");
      }
    }
    if (c === '"') return { t: "str", v: str() };
    if (c === "t") return lit("true", { t: "bool", v: true });
    if (c === "f") return lit("false", { t: "bool", v: false });
    if (c === "n") return lit("null", { t: "null" });
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return num();
    return fail("expected value");
  };
  const v = value(0);
  ws();
  if (i !== n) fail("trailing characters");
  return v;
}

// ---------------------------------------------------------------------------------------------
// Decoders (serde derive semantics)
// ---------------------------------------------------------------------------------------------

export type Decoder<T> = (v: JVal) => T;

export const U16_MAX = 0xffffn;
export const U32_MAX = 0xffff_ffffn;
export const U64_MAX = 0xffff_ffff_ffff_ffffn;
export const U128_MAX = (1n << 128n) - 1n;

/** An unsigned integer field (`u16`/`u32`/`u64`): a JSON integer lexeme, no sign, fraction or exponent, in range. */
export function uint(max: bigint): Decoder<bigint> {
  return (v) => {
    if (v.t !== "num" || !/^(0|[1-9][0-9]*)$/.test(v.lex)) return fail("expected an unsigned integer");
    const x = BigInt(v.lex);
    if (x > max) fail("integer out of range");
    return x;
  };
}

/**
 * near-sdk `U128` / `U64`: a JSON string parsed with Rust's `from_str_radix(s, 10)` — an optional leading `+`, then
 * ASCII digits (leading zeros allowed), in range.
 */
export function uintString(max: bigint): Decoder<bigint> {
  return (v) => {
    if (v.t !== "str" || !/^\+?[0-9]+$/.test(v.v)) return fail("expected an unsigned integer string");
    const x = BigInt(v.v.startsWith("+") ? v.v.slice(1) : v.v);
    if (x > max) fail("integer out of range");
    return x;
  };
}

export const string: Decoder<string> = (v) => (v.t === "str" ? v.v : fail("expected a string"));
export const bool: Decoder<boolean> = (v) => (v.t === "bool" ? v.v : fail("expected a boolean"));

/** `Option<T>`: `null` → `null`. */
export function option<T>(inner: Decoder<T>): Decoder<T | null> {
  return (v) => (v.t === "null" ? null : inner(v));
}

/**
 * A fieldless enum (`#[serde(rename_all = "snake_case")]`): the variant name as a string, or serde_json's map form
 * `{"<variant>": null}`.
 */
export function unitEnum<T extends string>(variants: readonly T[]): Decoder<T> {
  const known = (s: string): T => ((variants as readonly string[]).includes(s) ? (s as T) : fail("unknown variant"));
  return (v) => {
    if (v.t === "str") return known(v.v);
    if (v.t === "obj" && v.v.length === 1) {
      const [k, inner] = v.v[0] as readonly [string, JVal];
      if (inner.t !== "null") fail("expected unit");
      return known(k);
    }
    return fail("expected an enum");
  };
}

export interface Field<T> {
  readonly name: string;
  readonly decode: Decoder<T>;
  /**
   * `#[serde(default)]`: missing → default in both map and sequence forms. Without it a missing `Option` field is
   * still `None` in the map form (serde's missing-field rule), but a short sequence fails.
   */
  readonly fallback?: () => T;
  /** The field's type is `Option<_>` (missing in the map form → `null`). */
  readonly optional?: boolean;
}

export function field<T>(name: string, decode: Decoder<T>, o: Omit<Field<T>, "name" | "decode"> = {}): Field<T> {
  return { name, decode, ...o };
}

type FieldValues<F extends readonly Field<unknown>[]> = { [K in keyof F]: F[K] extends Field<infer T> ? T : never };

/**
 * A derived struct: a JSON object (unknown keys rejected with `denyUnknown`, ignored otherwise; a repeated known
 * key is an error) or a JSON array of the fields in declaration order (serde's sequence form).
 */
export function struct<const F extends readonly Field<unknown>[]>(
  fields: F,
  o: { denyUnknown: boolean },
): Decoder<FieldValues<F>> {
  return (v) => {
    const out: unknown[] = [];
    if (v.t === "arr") {
      fields.forEach((f, idx) => {
        const item = v.v[idx];
        if (item !== undefined) out.push(f.decode(item));
        else if (f.fallback) out.push(f.fallback());
        else fail("invalid length");
      });
      if (v.v.length > fields.length) fail("trailing elements");
      return out as FieldValues<F>;
    }
    if (v.t !== "obj") return fail("expected a struct");
    const seen = new Map<string, unknown>();
    for (const [k, item] of v.v) {
      const f = fields.find((x) => x.name === k);
      if (!f) {
        if (o.denyUnknown) fail(`unknown field ${k}`);
        continue;
      }
      if (seen.has(k)) fail(`duplicate field ${k}`);
      seen.set(k, f.decode(item));
    }
    for (const f of fields) {
      if (seen.has(f.name)) out.push(seen.get(f.name));
      else if (f.fallback) out.push(f.fallback());
      else if (f.optional) out.push(null);
      else fail(`missing field ${f.name}`);
    }
    return out as FieldValues<F>;
  };
}

/** UTF-8 length in bytes (Rust `str::len`). */
export function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
