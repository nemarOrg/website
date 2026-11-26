/**
 * A recording's record as the public quality route serves it (`record.ts`) and the page's client
 * of the route (`quality-api.ts`), on answers captured from the real nemar-cli route
 * (`scripts/capture-quality-fixtures.mjs`, `test/fixtures/quality-views/route/`), and on
 * neuroschema's vectors: `record-checks.v1.json` and the `dataQuality` cases of the verdict corpus
 * that phase W4 left to the panel.
 *
 * The answers reach the client as `Response` objects built from the captured bytes, status and
 * headers: the route's own answers, replayed (HTTP fixtures), never a stand-in for the code read.
 */

import { describe, expect, it } from "vitest";
import { declarationValid } from "../src/lib/quality-views/guards";
import { COMPUTED_SCHEMAS } from "../src/lib/quality-views/guards-computed";
import { fetchRecord, fileUrl, lenientBase, recordFiles } from "../src/lib/quality-views/quality-api";
import {
  type QualityRecord,
  etagDigest,
  readRecordAnswer,
  recordChecks,
  recordDocumentValid,
} from "../src/lib/quality-views/record";
import { viewDigest } from "../src/lib/quality-views/verify";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const ROUTE = "test/fixtures/quality-views/route";
const json = (path: string) => JSON.parse(fs.readFileSync(repoPath(path), "utf8"));
const captured = json(`${ROUTE}/record.json`) as {
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
};
const refusals = json(`${ROUTE}/refusals.json`) as Record<
  string,
  { status: number; headers: Record<string, string>; body: string }
>;
const files = json(`${ROUTE}/files.json`) as Record<string, { location: string }>;
const provenance = json(`${ROUTE}/provenance.json`) as {
  dataset_id: string;
  recipe: string;
  recording: string;
};
const ASK = {
  base: "https://data.example.invalid",
  datasetId: provenance.dataset_id,
  recipe: provenance.recipe,
  recording: provenance.recording,
};
const BODY = new TextEncoder().encode(captured.body);
const ETAG = captured.headers.ETag;

/** A fetch that answers with one captured answer, for the client's own reading of it. */
const answering =
  (status: number, headers: Record<string, string>, body: BodyInit | null) =>
  async (): Promise<Response> =>
    new Response(body, { status, headers });

describe("a record answer", () => {
  it("reads the captured answer, and every view's digest is the one the route computed", async () => {
    const record = (await readRecordAnswer(BODY, ETAG, ASK)) as QualityRecord;
    expect(record.derivative.key).toMatch(/^[0-9a-f]{64}$/);
    expect(record.views.map((v) => v.key)).toEqual([
      "icmaps",
      "icactivity",
      "midsegment",
      "icclasses",
      "spectrum",
    ]);
    for (const view of record.views) {
      expect(await viewDigest(view)).toBe(record.digests[view.key as string]);
    }
    expect(etagDigest(ETAG)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks the digest before it parses: a body that is not the one served is never read", async () => {
    const changed = BODY.slice();
    changed[changed.length - 2] ^= 1;
    expect(await readRecordAnswer(changed, ETAG, ASK)).toBe("record_digest_mismatch");
    // Bytes that are not JSON at all: parsed first, they would be `record_invalid`.
    const garbage = new Uint8Array([0xff, 0xfe, 0x7b]);
    expect(await readRecordAnswer(garbage, ETAG, ASK)).toBe("record_digest_mismatch");
    expect(await readRecordAnswer(garbage, null, ASK, false)).toBe("record_invalid");
  });

  it("refuses an answer from the data plane without a readable ETag digest, and reads one locally", async () => {
    for (const etag of [null, "", '"not-a-digest"', 'W/"abc"']) {
      expect(await readRecordAnswer(BODY, etag, ASK), String(etag)).toBe("record_digest_missing");
    }
    // Local development only (a same-origin or loopback base).
    expect(await readRecordAnswer(BODY, null, ASK, false)).toMatchObject({ recipe: ASK.recipe });
  });

  it("was captured with the ETag the panel requires, exposed to the site's origins", () => {
    expect(etagDigest(captured.headers.ETag)).toMatch(/^[0-9a-f]{64}$/);
    // nemar-cli#2400: the public quality route exposes ETag; without it the browser cannot read it.
    const exposed = captured.headers["Access-Control-Expose-Headers"] ?? "";
    expect(exposed.split(",").map((h) => h.trim().toLowerCase())).toContain("etag");
  });

  it("is lenient only for a loopback host", () => {
    expect(lenientBase("https://data.nemar.org")).toBe(false);
    expect(lenientBase("https://data.example.invalid")).toBe(false);
    // The page's own origin is not enough: a same-origin data plane is still the data plane.
    expect(lenientBase("https://nemar.org/data")).toBe(false);
    expect(lenientBase("http://localhost:8787/data")).toBe(true);
    expect(lenientBase("http://127.0.0.1:8787/data")).toBe(true);
    expect(lenientBase("http://[::1]:8787/data")).toBe(true);
    expect(lenientBase("http://localhost.example.org/data")).toBe(false);
    expect(lenientBase("not a url")).toBe(false);
  });


  it("refuses a fetched record whose ETag the data plane does not expose", async () => {
    const hidden = { ...captured.headers };
    delete hidden.ETag;
    expect(await fetchRecord(ASK, { fetch: answering(200, hidden, captured.body) })).toEqual({
      kind: "failed",
      word: "record_digest_missing",
    });
  });

  it("refuses an answer for another recording, dataset or recipe", async () => {
    for (const other of [
      { ...ASK, recording: "sub-X/eeg/sub-X_task-COVID_eeg.edf" },
      { ...ASK, datasetId: "nm000001" },
    ]) {
      expect(await readRecordAnswer(BODY, ETAG, other)).toBe("record_elsewhere");
    }
    // Asked of another recipe, the document holds no entry for it.
    expect(await readRecordAnswer(BODY, ETAG, { ...ASK, recipe: "nemar-floor" })).toBe(
      "record_elsewhere",
    );
  });

  it("refuses an envelope or a document the shape does not admit", async () => {
    const body = JSON.parse(captured.body);
    const variants = [
      { ...body, format: "nemar.quality-record.v2" },
      { ...body, derivative: { ...body.derivative, key: "x" } },
      { ...body, view_digests: { icmaps: "nope" } },
      { ...body, dataQuality: { ...body.dataQuality, level: "dataset" } },
    ];
    for (const variant of variants) {
      const bytes = new TextEncoder().encode(JSON.stringify(variant));
      expect(await readRecordAnswer(bytes, null, ASK, false)).toBe("record_invalid");
    }
    const shuffled = structuredClone(body);
    shuffled.dataQuality.recipes["nemar-ica"].views[1].key = "icmaps";
    expect(
      await readRecordAnswer(new TextEncoder().encode(JSON.stringify(shuffled)), null, ASK, false),
    ).toBe("record_checks_failed");
  });
});

describe("nemar.record-checks.v1", () => {
  const vectors = json("test/fixtures/quality-views/vectors/record-checks.v1.json") as {
    format: string;
    cases: { name: string; recipe: string; entry: unknown; expected: unknown[] }[];
  };
  it("is the vectors' format", () => expect(vectors.format).toBe("nemar.record-checks.v1"));
  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(recordChecks(c.recipe, c.entry)).toEqual(c.expected);
  });
});

describe("the verdict corpus's dataQuality cases (deferred from W4 to the panel)", () => {
  const corpus = json("test/fixtures/quality-views/vectors/kinds-verdicts.v1.json") as {
    cases: { name: string; schema: string; instance: unknown; valid: boolean; covers: string }[];
  };
  const cases = corpus.cases.filter((c) => c.schema === "dataQuality");
  it("holds the cases", () => expect(cases.length).toBeGreaterThanOrEqual(8));
  // The page's verdict: the document's shape here, and each view by the worker's guards.
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const recipes = (c.instance as { recipes?: Record<string, { views?: unknown[] }> }).recipes;
    const views = Object.values(recipes ?? {}).flatMap((entry) => entry.views ?? []);
    const verdict =
      recordDocumentValid(c.instance) && views.every((v) => declarationValid(v, COMPUTED_SCHEMAS));
    expect(verdict, c.covers).toBe(c.valid);
  });
});

describe("the route's client", () => {
  it("reads a record", async () => {
    const outcome = await fetchRecord(ASK, {
      fetch: answering(captured.status, captured.headers, captured.body),
    });
    expect(outcome.kind).toBe("ok");
  });

  it("says a recording has no quality on quality_not_found", async () => {
    for (const name of ["no_record", "dataset_not_public"]) {
      const r = refusals[name];
      expect(await fetchRecord(ASK, { fetch: answering(r.status, r.headers, r.body) })).toEqual({
        kind: "none",
      });
    }
  });

  it("words every other refusal of the route", async () => {
    const r = refusals.path_invalid;
    expect(await fetchRecord(ASK, { fetch: answering(r.status, r.headers, r.body) })).toEqual({
      kind: "failed",
      word: "recording_path_invalid",
    });
  });

  it("says the route is not on this server when a 404 carries no word of the route's", async () => {
    const html = answering(404, { "Content-Type": "text/html" }, "<h1>Not found</h1>");
    expect(await fetchRecord(ASK, { fetch: html })).toEqual({ kind: "unavailable" });
    const other = answering(404, {}, JSON.stringify({ error: "not_a_route_word" }));
    expect(await fetchRecord(ASK, { fetch: other })).toEqual({ kind: "unavailable" });
  });

  it("fails on a server error, an unreachable route and a damaged answer", async () => {
    expect(await fetchRecord(ASK, { fetch: answering(500, {}, "oops") })).toEqual({
      kind: "failed",
      word: "http_500",
    });
    const offline = async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    };
    expect(await fetchRecord(ASK, { fetch: offline })).toEqual({
      kind: "failed",
      word: "network",
    });
    const damaged = captured.body.replace('"icmaps"', '"icmapz"');
    expect(await fetchRecord(ASK, { fetch: answering(200, captured.headers, damaged) })).toEqual({
      kind: "failed",
      word: "record_digest_mismatch",
    });
  });

  it("asks the record and each file at the route's paths, reading no more than a file's size", async () => {
    const asked: string[] = [];
    const outcome = await fetchRecord(ASK, {
      fetch: async (url) => {
        asked.push(String(url));
        return new Response(captured.body, { headers: captured.headers });
      },
    });
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    expect(asked).toEqual([`${ASK.base}${captured.path}`]);
    const [sha, { location }] = Object.entries(files)[0];
    const bytes = new Uint8Array(fs.readFileSync(repoPath(`${ROUTE}/files/${sha}`)));
    const file = { location, size: bytes.length, sha256: sha };
    expect(fileUrl(ASK.base, outcome.record, file)).toContain(
      `/file/${outcome.record.derivative.key}/${sha}/`,
    );
    const exact = recordFiles(ASK.base, outcome.record, {
      fetch: async () => new Response(bytes),
    });
    expect(await exact(file)).toEqual(bytes);
    const longer = recordFiles(ASK.base, outcome.record, {
      fetch: async () => new Response(new Uint8Array([...bytes, 10])),
    });
    expect(await longer(file)).toBeNull();
    const refused = recordFiles(ASK.base, outcome.record, {
      fetch: answering(404, {}, refusals.not_declared.body),
    });
    expect(await refused(file)).toBeNull();
  });
});
