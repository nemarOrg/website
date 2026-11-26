/**
 * `nemar.view-digest.v1` (neuroschema 0.6.0 `docs/views/view-digest.md`; nemar-cli ADR 0137,
 * the live-views plan's C10): the SHA-256 of a view declaration's canonical JSON, the JSON
 * Canonicalization Scheme of RFC 8785. The backend computes each view's digest when it serves a
 * recording's record (`view_digests`); the panel recomputes it from the declaration it read and
 * draws nothing of a view whose digest differs, and the exports of phase W8 embed it.
 *
 * The declaration is read by the site's I-JSON reader (`read.ts`), which refuses duplicate
 * members, lone surrogates, noncharacters and nesting past 64; `canonicalJson` refuses what that
 * reader would, so no value that has no digest gets one. `test/quality-views-view-digest.test.ts`
 * replays `views/vectors/view-digest.v1.json`.
 */

import { subtleSha256 } from "./model";
import { MAX_DEPTH, forbiddenCharacter } from "./read";

/** The RFC 8785 text of a JSON value; a `RangeError` for a value that has no canonical form. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (value === null || value === true || value === false) return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("not_finite");
    return String(value);
  }
  if (typeof value === "string") {
    if (forbiddenCharacter(value)) throw new RangeError("forbidden_character");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || depth + 1 > MAX_DEPTH) throw new RangeError("not_json");
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  const members = Object.keys(value)
    .sort()
    .map((name) => {
      if (forbiddenCharacter(name)) throw new RangeError("forbidden_character");
      return `${JSON.stringify(name)}:${canonicalJson((value as Record<string, unknown>)[name], depth + 1)}`;
    });
  return `{${members.join(",")}}`;
}

/** A declaration's `nemar.view-digest.v1`, or a `RangeError` when it has none. */
export async function viewDigest(declaration: unknown): Promise<string> {
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
    throw new RangeError("not_an_object");
  }
  return subtleSha256(new TextEncoder().encode(canonicalJson(declaration)));
}
