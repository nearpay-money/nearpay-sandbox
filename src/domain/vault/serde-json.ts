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

/**
 * A parsed JSON value keeping what serde distinguishes: number lexemes and object key order (with repeats).
 *
 * serde_json validates a string only when a typed field reads it: inside a value it ignores (the value of an unknown
 * key of a struct without `deny_unknown_fields`, which is every near-sdk method-argument struct) a string may hold
 * invalid UTF-8 or lone surrogate escapes, and containers may nest without limit (`ignore_value` is iterative and does
 * not count recursion). So the parser checks only the syntax `ignore_value` checks and records the rest: `bad` on a
 * string that is not valid Unicode, `bad` on an object with such a key, and `deep` for a container at nesting level
 * 128 or more (where a typed read hits serde_json's recursion limit). Every decoder refuses all three.
 */
export type JVal =
  | { readonly t: "null" }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "num"; readonly lex: string }
  | { readonly t: "str"; readonly v: string; readonly bad?: true }
  | { readonly t: "arr"; readonly v: readonly JVal[] }
  | { readonly t: "obj"; readonly v: readonly (readonly [string, JVal])[]; readonly bad?: true }
  | { readonly t: "deep" };

/**
 * serde_json's default recursion limit: `remaining_depth` starts at 128 and the container that brings it to 0 fails,
 * so a typed read handles at most 127 nested containers.
 */
const MAX_TYPED_NESTING = 127;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const REPLACEMENT = [0xef, 0xbf, 0xbd];
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const lossyUtf8 = new TextDecoder("utf-8");

const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isDigit = (c: number | undefined) => c !== undefined && c >= 0x30 && c <= 0x39;
const hexVal = (c: number | undefined): number => {
  if (c === undefined) return -1;
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
};

function pushCodePoint(out: number[], cp: number): void {
  for (const b of utf8.encode(String.fromCodePoint(cp))) out.push(b);
}

/**
 * Parses one JSON document like serde_json (whitespace around it allowed, nothing else): `serde_json::from_slice`
 * for bytes (near-sdk method arguments and promise results), `serde_json::from_str` for a string (`msg`; a Rust
 * `String` is valid Unicode, so a string with a lone surrogate is refused).
 */
export function parseJson(input: string | Uint8Array): JVal {
  if (typeof input === "string" && LONE_SURROGATE.test(input)) fail("invalid unicode");
  const b = typeof input === "string" ? utf8.encode(input) : input;
  const n = b.length;
  let i = 0;
  const ws = () => {
    while (i < n && isWs(b[i] as number)) i++;
  };
  const hex4 = (): number => {
    let x = 0;
    for (let k = 0; k < 4; k++) {
      const h = hexVal(b[i++]);
      if (h < 0) fail("invalid escape");
      x = x * 16 + h;
    }
    return x;
  };
  /** A string after its opening quote. Syntax errors throw; content that is not valid Unicode marks it `bad`. */
  const str = (): { v: string; bad: boolean } => {
    const out: number[] = [];
    let bad = false;
    for (;;) {
      if (i >= n) fail("EOF while parsing a string");
      const c = b[i++] as number;
      if (c === 0x22) break;
      if (c < 0x20) fail("control character in string");
      if (c !== 0x5c) {
        out.push(c);
        continue;
      }
      const e = b[i++];
      switch (e) {
        case 0x22:
        case 0x5c:
        case 0x2f:
          out.push(e);
          break;
        case 0x62:
          out.push(0x08);
          break;
        case 0x66:
          out.push(0x0c);
          break;
        case 0x6e:
          out.push(0x0a);
          break;
        case 0x72:
          out.push(0x0d);
          break;
        case 0x74:
          out.push(0x09);
          break;
        case 0x75: {
          const u = hex4();
          if (u >= 0xd800 && u <= 0xdbff && b[i] === 0x5c && b[i + 1] === 0x75) {
            i += 2;
            const lo = hex4();
            if (lo >= 0xdc00 && lo <= 0xdfff) pushCodePoint(out, 0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00));
            else {
              bad = true; // a typed read fails; an ignored one consumed two escapes, as here
              out.push(...REPLACEMENT);
            }
          } else if (u >= 0xd800 && u <= 0xdfff) {
            bad = true;
            out.push(...REPLACEMENT);
          } else pushCodePoint(out, u);
          break;
        }
        default:
          fail("invalid escape");
      }
    }
    const bytes = Uint8Array.from(out);
    try {
      return { v: strictUtf8.decode(bytes), bad };
    } catch {
      return { v: lossyUtf8.decode(bytes), bad: true };
    }
  };
  const num = (): JVal => {
    const s = i;
    if (b[i] === 0x2d) i++;
    if (b[i] === 0x30) {
      i++;
      if (isDigit(b[i])) fail("invalid number"); // "01"
    } else if (isDigit(b[i])) while (isDigit(b[i])) i++;
    else fail("invalid number");
    if (b[i] === 0x2e) {
      i++;
      if (!isDigit(b[i])) fail("invalid number");
      while (isDigit(b[i])) i++;
    }
    if (b[i] === 0x65 || b[i] === 0x45) {
      i++;
      if (b[i] === 0x2b || b[i] === 0x2d) i++;
      if (!isDigit(b[i])) fail("invalid number");
      while (isDigit(b[i])) i++;
    }
    return { t: "num", lex: String.fromCharCode(...b.subarray(s, i)) };
  };
  const lit = (word: string): void => {
    for (let k = 0; k < word.length; k++) if (b[i++] !== word.charCodeAt(k)) fail("expected value");
  };
  /** A scalar at `b[i]` (after whitespace); `null` when it is a container. */
  const scalar = (): JVal | null => {
    const c = b[i];
    if (c === 0x22) {
      i++;
      const s = str();
      return s.bad ? { t: "str", v: s.v, bad: true } : { t: "str", v: s.v };
    }
    if (c === 0x74) {
      lit("true");
      return { t: "bool", v: true };
    }
    if (c === 0x66) {
      lit("false");
      return { t: "bool", v: false };
    }
    if (c === 0x6e) {
      lit("null");
      return { t: "null" };
    }
    if (c === 0x2d || isDigit(c)) return num();
    if (c === 0x7b || c === 0x5b) return null;
    return fail("expected value");
  };
  const key = () => {
    ws();
    if (b[i] !== 0x22) fail("key must be a string");
    i++;
    str();
    ws();
    if (b[i++] !== 0x3a) fail("expected `:`");
  };
  /** serde_json's `ignore_value` for a container at `b[i]`: iterative, syntax only, no depth limit. */
  const skipContainer = (): JVal => {
    const stack: number[] = [];
    for (;;) {
      ws();
      if (i >= n) fail("EOF while parsing a value");
      const c = b[i];
      if (c === 0x7b || c === 0x5b) {
        i++;
        ws();
        const close = c === 0x7b ? 0x7d : 0x5d;
        if (b[i] !== close) {
          stack.push(close);
          if (close === 0x7d) key();
          continue;
        }
        i++;
      } else scalar();
      // after a value: close containers, then step to the next element
      for (;;) {
        const top = stack[stack.length - 1];
        if (top === undefined) return { t: "deep" };
        ws();
        if (b[i] === top) {
          i++;
          stack.pop();
          continue;
        }
        if (b[i] !== 0x2c) fail(top === 0x7d ? "expected `,` or `}`" : "expected `,` or `]`");
        i++;
        if (top === 0x7d) key();
        break;
      }
    }
  };
  const value = (nesting: number): JVal => {
    ws();
    if (i >= n) fail("EOF while parsing a value");
    const s = scalar();
    if (s) return s;
    if (nesting >= MAX_TYPED_NESTING) return skipContainer();
    if (b[i++] === 0x7b) {
      const entries: (readonly [string, JVal])[] = [];
      let bad = false;
      ws();
      if (b[i] === 0x7d) {
        i++;
        return { t: "obj", v: entries };
      }
      for (;;) {
        ws();
        if (b[i] !== 0x22) fail("key must be a string");
        i++;
        const k = str();
        if (k.bad) bad = true;
        ws();
        if (b[i] !== 0x3a) fail("expected `:`");
        i++;
        entries.push([k.v, value(nesting + 1)]);
        ws();
        if (b[i] === 0x2c) {
          i++;
          continue;
        }
        if (b[i] === 0x7d) {
          i++;
          return bad ? { t: "obj", v: entries, bad: true } : { t: "obj", v: entries };
        }
        fail("expected `,` or `}`");
      }
    }
    const items: JVal[] = [];
    ws();
    if (b[i] === 0x5d) {
      i++;
      return { t: "arr", v: items };
    }
    for (;;) {
      items.push(value(nesting + 1));
      ws();
      if (b[i] === 0x2c) {
        i++;
        continue;
      }
      if (b[i] === 0x5d) {
        i++;
        return { t: "arr", v: items };
      }
      fail("expected `,` or `]`");
    }
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
    if (v.t !== "str" || v.bad || !/^\+?[0-9]+$/.test(v.v)) return fail("expected an unsigned integer string");
    const x = BigInt(v.v.startsWith("+") ? v.v.slice(1) : v.v);
    if (x > max) fail("integer out of range");
    return x;
  };
}

export const string: Decoder<string> = (v) => (v.t === "str" && !v.bad ? v.v : fail("expected a string"));
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
    if (v.t === "str" && !v.bad) return known(v.v);
    if (v.t === "obj" && !v.bad && v.v.length === 1) {
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
    if (v.t !== "obj" || v.bad) return fail("expected a struct");
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
