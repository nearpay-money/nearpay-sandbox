/**
 * NEAR account id validation as near-sdk's `AccountId` deserialisation does it (`near-account-id` rules): 2–64
 * characters of `a-z`, `0-9` and the separators `-`, `_`, `.`; a separator may not start or end the id or follow
 * another separator. The vault rejects an argument that breaks them before its own checks run.
 */
import type { Decoder } from "./serde-json.js";
import { SerdeError, string } from "./serde-json.js";

const isSeparator = (c: string) => c === "-" || c === "_" || c === ".";

export function isValidAccountId(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  let lastSep = true; // a leading separator is invalid
  for (const c of id) {
    if (isSeparator(c)) {
      if (lastSep) return false;
      lastSep = true;
    } else if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
      lastSep = false;
    } else return false;
  }
  return !lastSep;
}

export const accountId: Decoder<string> = (v) => {
  const s = string(v);
  if (!isValidAccountId(s)) throw new SerdeError("invalid account id");
  return s;
};
