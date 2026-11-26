/**
 * `verify.ts`: `nemar.view-digest.v1` held to neuroschema's vectors (`view-digest.v1.json`, every
 * case's canonical text and digest, every refusal), and the file check held to the digests NEMAR
 * recorded: each file of neuroschema's model vectors against its declaration, and each copy this
 * site ships against `pin.json`.
 */

import { describe, expect, it } from "vitest";
import { KindRefused, parseIJson } from "../src/lib/quality-views/read";
import {
  canonicalJson,
  digestable,
  subtleSha256,
  verifyBytes,
  viewDigest,
  viewDigestOfText,
} from "../src/lib/quality-views/verify";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const read = (path: string) => JSON.parse(fs.readFileSync(repoPath(path), "utf8"));

interface DigestCase {
  readonly name: string;
  readonly declaration: unknown;
  readonly canonical: string;
  readonly sha256: string;
}
const vectors = read("test/fixtures/quality-views/vectors/view-digest.v1.json") as {
  format: string;
  cases: DigestCase[];
  refusals: { name: string; json: string }[];
};

describe("nemar.view-digest.v1", () => {
  it("is the vectors' format, with every case and refusal", () => {
    expect(vectors.format).toBe("nemar.view-digest.v1");
    expect(vectors.cases.length).toBe(9);
    expect(vectors.refusals.length).toBe(14);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    expect(canonicalJson(c.declaration)).toBe(c.canonical);
    expect(await viewDigest(c.declaration)).toBe(c.sha256);
    // The text written canonically digests the same, through the I-JSON reader.
    expect(await viewDigestOfText(c.canonical)).toBe(c.sha256);
  });

  it.each(vectors.refusals.map((r) => [r.name, r] as const))("refuses %s", async (_name, r) => {
    expect(await viewDigestOfText(r.json)).toBeNull();
  });

  it("has no digest for a value JSON cannot hold, or for a declaration that is not an object", async () => {
    expect(canonicalJson({ x: Number.NaN })).toBeNull();
    expect(canonicalJson({ x: undefined })).toBeNull();
    expect(canonicalJson({ s: "\ud800" })).toBeNull();
    expect(await viewDigest([1, 2])).toBeNull();
    expect(await viewDigest("view")).toBeNull();
    expect(await viewDigest(null)).toBeNull();
  });

  it("has a digest for 64 levels of nesting and none for 65, however the value was made", async () => {
    const nest = (levels: number): unknown => {
      let value: unknown = 7;
      for (let i = 1; i < levels; i++) value = [value];
      return { x: value };
    };
    expect(await viewDigest(nest(64))).toMatch(/^[0-9a-f]{64}$/);
    expect(await viewDigest(nest(65))).toBeNull();
    expect(digestable(nest(64))).toBe(true);
    expect(digestable(nest(65))).toBe(false);
  });

  it("canonicalizes a member named __proto__ as any other member", async () => {
    const value = parseIJson('{"b":1,"__proto__":{"a":2}}');
    expect(canonicalJson(value)).toBe('{"__proto__":{"a":2},"b":1}');
  });

  it("lets a reader's own fault through instead of calling it a refusal", async () => {
    // Every refusal the reader makes is a KindRefused; nothing else is swallowed.
    expect(() => parseIJson('{"a":1,"a":2}')).toThrow(KindRefused);
    expect(digestable({ a: [1, "x", null, true] })).toBe(true);
  });
});

describe("a file against the size and SHA-256 NEMAR recorded", () => {
  interface Entry {
    readonly location: string;
    readonly size: number;
    readonly sha256: string;
  }
  interface ModelCase {
    name: string;
    word?: string;
    model?: { refused: { word: string } | null };
    view: { data?: Entry[] };
    files: Record<string, { text?: string; base64?: string }>;
  }
  const models = read("test/fixtures/quality-views/vectors/kinds-models.v1.json") as {
    cases: ModelCase[];
    refusals: ModelCase[];
  };
  const bytesOf = (held: { text?: string; base64?: string } | undefined): Uint8Array | null =>
    held === undefined
      ? null
      : held.text !== undefined
        ? new TextEncoder().encode(held.text)
        : Uint8Array.from(atob(held.base64!), (c) => c.charCodeAt(0));
  const words = async (c: ModelCase) =>
    Promise.all((c.view.data ?? []).map((e) => verifyBytes(bytesOf(c.files[e.location]), e)));

  it("passes every declared file of every drawn case of the model vectors", async () => {
    let checked = 0;
    // A case refused by a cap is refused before any digest, so its file need not be its own.
    for (const c of models.cases.filter((c) => c.model?.refused?.word !== "cap_exceeded")) {
      for (const [i, word] of (await words(c)).entries()) {
        const entry = c.view.data![i];
        if (!(entry.location in c.files)) continue;
        checked++;
        expect(word, `${c.name}: ${entry.location}`).toBeNull();
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("finds the word of each refusal of the model vectors about a file", async () => {
    const about = models.refusals.filter((r) => r.word?.startsWith("file_"));
    expect(about.length).toBeGreaterThanOrEqual(10);
    for (const r of about) expect(await words(r), r.name).toContain(r.word);
  });

  const pin = read("src/lib/quality-views/vocabulary/pin.json") as {
    files: { copy: string; size: number; sha256: string }[];
  };
  const shipped = pin.files.filter((f) => f.copy.startsWith("src/"));

  it("passes each copy this site ships, by the digest in pin.json", async () => {
    expect(shipped.length).toBeGreaterThan(10);
    for (const file of shipped) {
      const bytes = fs.readFileSync(repoPath(file.copy));
      expect(await verifyBytes(bytes, file), file.copy).toBeNull();
    }
  });

  it("names what is wrong: missing, the size, then the digest", async () => {
    const file = shipped.find((f) => f.copy.endsWith("registry.json"))!;
    const bytes = new Uint8Array(fs.readFileSync(repoPath(file.copy)));
    expect(await verifyBytes(null, file)).toBe("file_missing");
    expect(await verifyBytes(bytes.slice(0, -1), file)).toBe("file_size_mismatch");
    const flipped = bytes.slice();
    flipped[10] ^= 1;
    expect(await verifyBytes(flipped, file)).toBe("file_digest_mismatch");
  });

  it("never hashes bytes of the wrong length", async () => {
    let hashed = 0;
    const count = async (b: Uint8Array) => {
      hashed++;
      return subtleSha256(b);
    };
    expect(await verifyBytes(new Uint8Array(3), { size: 4, sha256: "0".repeat(64) }, count)).toBe(
      "file_size_mismatch",
    );
    expect(hashed).toBe(0);
  });
});
