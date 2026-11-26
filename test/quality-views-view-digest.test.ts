/**
 * `nemar.view-digest.v1` (`src/lib/quality-views/view-digest.ts`) replays neuroschema's
 * `views/vectors/view-digest.v1.json`: every case's canonical text byte for byte and its SHA-256,
 * and every refusal has no digest (the site's I-JSON reader refuses its text).
 */

import { describe, expect, it } from "vitest";
import { KindRefused, parseIJson } from "../src/lib/quality-views/read";
import { canonicalJson, viewDigest } from "../src/lib/quality-views/view-digest";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const vectors = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/view-digest.v1.json"), "utf8"),
) as {
  format: string;
  cases: { name: string; declaration: unknown; canonical: string; sha256: string }[];
  refusals: { name: string; json: string }[];
};

describe("nemar.view-digest.v1", () => {
  it("is the vectors' format", () => {
    expect(vectors.format).toBe("nemar.view-digest.v1");
    expect(vectors.cases.length).toBeGreaterThanOrEqual(9);
    expect(vectors.refusals.length).toBeGreaterThanOrEqual(14);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    expect(canonicalJson(c.declaration)).toBe(c.canonical);
    expect(await viewDigest(c.declaration)).toBe(c.sha256);
    // Read by the site's own I-JSON reader, the digest is the same.
    expect(await viewDigest(parseIJson(JSON.stringify(c.declaration)))).toBe(c.sha256);
  });

  it.each(vectors.refusals.map((r) => [r.name, r] as const))("refuses %s", async (_name, r) => {
    // The reader refuses the text, or what it reads is no declaration: either way, no digest.
    let read: unknown;
    try {
      read = parseIJson(r.json);
    } catch (error) {
      expect(error).toBeInstanceOf(KindRefused);
      return;
    }
    await expect(viewDigest(read)).rejects.toThrow(RangeError);
  });

  it("gives no digest to what is not a declaration or has no canonical form", async () => {
    await expect(viewDigest([1])).rejects.toThrow(RangeError);
    await expect(viewDigest(null)).rejects.toThrow(RangeError);
    await expect(viewDigest({ n: Number.NaN })).rejects.toThrow(RangeError);
    await expect(viewDigest({ s: "\ud800" })).rejects.toThrow(RangeError);
    let deep: unknown = 1;
    for (let k = 0; k < 64; k++) deep = [deep];
    await expect(viewDigest({ deep })).rejects.toThrow(RangeError);
  });
});
