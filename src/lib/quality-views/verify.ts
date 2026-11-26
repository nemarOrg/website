/**
 * Checking what NEMAR recorded (nemar-cli ADR 0137 decision 6; website ADR 0035 decision 4): a
 * file's bytes against its declared size and SHA-256, and a view declaration's digest,
 * `nemar.view-digest.v1` (neuroschema 0.6.0 `docs/views/view-digest.md`): the SHA-256 of the UTF-8
 * bytes of the declaration's RFC 8785 (JSON Canonicalization Scheme, JCS) form.
 *
 * Both run on the page with SubtleCrypto and no dependency. A check that passes means the bytes
 * match the digest NEMAR recorded; it says nothing about who made them, since the backend serves
 * both the files and their digests, and no wording built on it may claim authenticity.
 *
 * The readers are `read.ts`'s (I-JSON); this file only canonicalizes and hashes what they read.
 * `test/quality-views-verify.test.ts` replays neuroschema's `view-digest.v1` vectors.
 */

import { KindRefused, MAX_DEPTH, forbiddenCharacter, parseIJson } from "./read";

/** The lowercase hex SHA-256 of `bytes`. */
export async function subtleSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Why bytes are not the file NEMAR recorded, in the model's words. */
export type FileWord = "file_missing" | "file_size_mismatch" | "file_digest_mismatch";

/**
 * Whether `bytes` are the file declared with `size` and `sha256`: null when they are, otherwise the
 * word. The size is compared first, so bytes of the wrong length are never hashed.
 */
export async function verifyBytes(
  bytes: Uint8Array | null,
  file: { readonly size: number; readonly sha256: string },
  hash: (bytes: Uint8Array) => Promise<string> = subtleSha256,
): Promise<FileWord | null> {
  if (bytes === null) return "file_missing";
  if (bytes.length !== file.size) return "file_size_mismatch";
  return (await hash(bytes)) === file.sha256 ? null : "file_digest_mismatch";
}

/**
 * Whether a value has a canonical form: every string free of lone surrogates and noncharacters,
 * every number finite, at most 64 levels of nesting, and nothing but JSON's values.
 */
export function digestable(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return !forbiddenCharacter(value);
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value !== "object" || depth + 1 > MAX_DEPTH) return false;
  const members = Array.isArray(value) ? value : Object.entries(value).flat();
  return members.every((member) => digestable(member, depth + 1));
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean") return String(value);
  // ECMAScript's number printing, which RFC 8785 adopts: shortest round trip, -0 as 0.
  if (typeof value === "number") return String(value + 0);
  // JSON.stringify escapes exactly what RFC 8785 escapes (quote, backslash, U+0000 to U+001F,
  // with the short forms and lowercase hex) for a string free of lone surrogates.
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  // The default sort compares UTF-16 code units, the order RFC 8785 names.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** The RFC 8785 text of `value`, or null when it has none (see `digestable`). */
export function canonicalJson(value: unknown): string | null {
  return digestable(value) ? canonical(value) : null;
}

/**
 * `nemar.view-digest.v1` of a declaration as written in the record (with no field a route added):
 * the SHA-256 of its canonical UTF-8 bytes, or null when it is not a JSON object with a canonical
 * form.
 */
export async function viewDigest(declaration: unknown): Promise<string | null> {
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
    return null;
  }
  const text = canonicalJson(declaration);
  return text === null ? null : subtleSha256(new TextEncoder().encode(text));
}

/** The view digest of a declaration's JSON text, read as I-JSON (a duplicate member however
 *  escaped, a lone surrogate, a noncharacter, a number past binary64 or nesting past 64 has none). */
export async function viewDigestOfText(text: string): Promise<string | null> {
  let value: unknown;
  try {
    value = parseIJson(text);
  } catch (error) {
    if (error instanceof KindRefused) return null;
    throw error;
  }
  return viewDigest(value);
}
