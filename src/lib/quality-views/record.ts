/**
 * A recording's quality record as the public route serves it (`nemar.quality-record.v1`; nemar-cli
 * `backend/src/services/quality-serve.ts`, ADR 0137 decisions 6 to 8), read and checked before
 * anything of it is drawn:
 *
 * 1. The bytes, against the digest the answer names (its `ETag`, the SHA-256 of the body), BEFORE
 *    they are parsed: a body that is not the one served is never read (`record_digest_mismatch`).
 *    From the data plane the digest is REQUIRED: the route sends a strong `ETag` and exposes it to
 *    the site's origins (`Access-Control-Expose-Headers`), and an answer with none, or one that
 *    names no SHA-256, is refused (`record_digest_missing`), never read unchecked. Only local
 *    development reads an answer without one (`requireDigest: false`, which `quality-api.ts` gives
 *    for a same-origin or loopback base alone).
 * 2. The text, as Internet JSON (`read.ts`).
 * 3. The answer's envelope (an open contract: an extra member is tolerated, a missing or wrongly
 *    typed one refuses it), and that it is the dataset, recipe and recording asked for.
 * 4. The `dataQuality` document's record shape, closed as neuroschema's schema is
 *    (`recordDocumentValid`); each view's own declaration is checked by the map worker's guards
 *    when it is drawn (`buildModel`), so this file carries none of them.
 * 5. `nemar.record-checks.v1` (`recordChecks`), held to `views/vectors/record-checks.v1.json`.
 *
 * Each view's `nemar.view-digest.v1` is recomputed by the panel against `view_digests` before the
 * view is drawn (`verify.ts`).
 */

import { subtleSha256 } from "./model";
import { KindRefused, readJson } from "./read";
import { QUALITY_RECORD_FORMAT } from "./route-contract";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Json, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const text =
  (pattern: RegExp) =>
  (v: unknown): boolean =>
    typeof v === "string" && pattern.test(v);

// processingTypes.schema.json (neuroschema 0.6.0); `$` without the `m` flag ends the text, so the
// schemas' `$(?!\n)` is plain `$` here, and a length counted in code points is a `u` quantifier.
const recipeId = text(/^[a-z0-9-]{1,64}$/);
const version = text(/^[0-9A-Za-z._+-]{1,64}$/);
const sha256 = text(/^[0-9a-f]{64}$/);
const metricName = text(/^(?=[\s\S]{1,128}$)[A-Za-z][A-Za-z0-9_-]*(:[A-Za-z][A-Za-z0-9_-]*)?$/);
const pluginName = text(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const viewKey = text(/^[a-z][a-z0-9_]{0,63}$/);
const kindName = text(/^(?=[\s\S]{1,128}$)[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/);
const failureCode = text(/^[a-z][a-z0-9_]{0,63}$/);
const numberOrNull = (v: unknown): boolean => v === null || typeof v === "number";

/** A closed object: `required` present, every member one of `props` and meeting it. */
function closed(v: unknown, props: Record<string, (v: unknown) => boolean>, required: string[]) {
  if (!isObject(v) || !required.every((k) => own(v, k))) return false;
  return Object.keys(v).every((k) => own(props, k) && props[k](v[k]));
}

const producer = (name: (v: unknown) => boolean) => (v: unknown) =>
  closed(v, { name, version }, ["name", "version"]);
const METRIC = {
  value: numberOrNull,
  unit: text(/^[\s\S]{1,32}$/u),
  description: text(/^[\s\S]{1,500}$/u),
  bounds: (v: unknown) => closed(v, { min: numberOrNull, max: numberOrNull }, ["min", "max"]),
  plugin: producer(pluginName),
  recipe: producer(recipeId),
};

/** `qualityMetric`, with the producer its name requires: a bare name a recipe, `<plugin>:<name>` a plugin. */
function metricValid(name: string, metric: unknown): boolean {
  if (!metricName(name) || !closed(metric, METRIC, ["value", "unit", "description"])) return false;
  const m = metric as Json;
  if (own(m, "plugin") === own(m, "recipe")) return false;
  return own(m, name.includes(":") ? "plugin" : "recipe");
}

const PROFILE_OF_INPUT: Readonly<Record<string, string>> = { bids: "archive", zarr: "serving" };
const skipped = (v: unknown): boolean =>
  closed(v, { key: viewKey, kind: kindName, reason: failureCode }, ["key", "kind", "reason"]);

/** `recordRecipeResults`, every member but the views' own declarations. */
function entryValid(entry: unknown): boolean {
  const props = {
    recipe_version: version,
    input_kind: (v: unknown) => v === "bids" || v === "zarr",
    profile: (v: unknown) => v === "archive" || v === "serving",
    record_sha256: sha256,
    metrics: (v: unknown) => isObject(v) && Object.entries(v).every(([k, m]) => metricValid(k, m)),
    views: (v: unknown) => Array.isArray(v) && v.length <= 32,
    views_skipped: (v: unknown) => Array.isArray(v) && v.length <= 32 && v.every(skipped),
  };
  const required = ["recipe_version", "input_kind", "profile", "record_sha256", "metrics", "views"];
  if (!closed(entry, props, required)) return false;
  const e = entry as Json & { views: unknown[] };
  // inputProfilePairing, and every store input names the copy the entry's run read.
  if (PROFILE_OF_INPUT[e.input_kind as string] !== e.profile) return false;
  return e.views.every((view) => {
    const inputs = isObject(view) && Array.isArray(view.inputs) ? view.inputs : [];
    return inputs.every(
      (input) =>
        !isObject(input) ||
        !isObject(input.store) ||
        !own(input.store, "profile") ||
        input.store.profile === e.profile,
    );
  });
}

/** neuroschema's `dataQuality` at `level: record`, closed at its root and in each entry; each view
 *  must still pass `view.schema.json#/$defs/view`, which the worker checks. */
export function recordDocumentValid(doc: unknown): boolean {
  if (!closed(doc, { level: (v) => v === "record", recipes: isObject }, ["level", "recipes"])) {
    return false;
  }
  return Object.entries((doc as { recipes: Json }).recipes).every(
    ([name, entry]) => recipeId(name) && entryValid(entry),
  );
}

// ── nemar.record-checks.v1 ──────────────────────────────────────────────

export interface RecordFinding {
  readonly word: "metric_producer_mismatch" | "view_source_mismatch" | "view_key_repeated";
  readonly at: string;
}

const objectOf = (v: unknown): Json => (isObject(v) ? v : {});
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The findings of one recording's entry for its recipe, in document order (metrics, views, then
 *  the views skipped); an empty list passes (nemar-cli `shared/contract/data-quality.ts`). */
export function recordChecks(recipe: string, entry: unknown): RecordFinding[] {
  const e = objectOf(entry);
  const findings: RecordFinding[] = [];
  for (const [name, metric] of Object.entries(objectOf(e.metrics))) {
    const at = name.indexOf(":");
    const m = objectOf(metric);
    const producer = at < 0 ? objectOf(m.recipe).name : objectOf(m.plugin).name;
    if (producer !== (at < 0 ? recipe : name.slice(0, at))) {
      findings.push({ word: "metric_producer_mismatch", at: `metrics/${name}` });
    }
  }
  const keys = new Set<unknown>();
  listOf(e.views).forEach((view, index) => {
    const v = objectOf(view);
    const source = objectOf(v.source);
    if (isObject(source.recipe) && source.recipe.name !== recipe) {
      findings.push({ word: "view_source_mismatch", at: `views/${index}/source` });
    }
    if (keys.has(v.key)) findings.push({ word: "view_key_repeated", at: `views/${index}/key` });
    keys.add(v.key);
  });
  listOf(e.views_skipped).forEach((skip, index) => {
    const key = objectOf(skip).key;
    if (keys.has(key))
      findings.push({ word: "view_key_repeated", at: `views_skipped/${index}/key` });
    keys.add(key);
  });
  return findings;
}

// ── The answer ──────────────────────────────────────────────────────────

export interface QualityDerivative {
  readonly key: string;
  readonly version: string;
  readonly recipe_version: string;
  readonly retention: string;
  readonly stored_at: string;
}

export interface QualityRecord {
  readonly datasetId: string;
  readonly recipe: string;
  readonly recording: string;
  readonly derivative: QualityDerivative;
  /** The recipe's entry: its views (each still to be checked and its digest compared), metrics
   *  and the views it skipped. */
  readonly views: readonly Json[];
  readonly skipped: readonly { key: string; kind: string; reason: string }[];
  readonly metrics: Readonly<Record<string, Json>>;
  /** Each view's `nemar.view-digest.v1`, by key, as the backend computed it. */
  readonly digests: Readonly<Record<string, string>>;
}

/** The digest an `ETag` names (`"<sha256>"`, weak or strong), or null. */
export function etagDigest(etag: string | null): string | null {
  const m = etag ? /^(?:W\/)?"([0-9a-f]{64})"$/.exec(etag.trim()) : null;
  return m ? m[1] : null;
}

/**
 * Read a record answer's bytes for the recording asked for. The digest is checked first; nothing
 * is parsed when it differs or, with `requireDigest` (the default), when there is none. Resolves with the record, or with the fixed word it is refused with.
 */
export async function readRecordAnswer(
  bytes: Uint8Array,
  etag: string | null,
  asked: { readonly datasetId: string; readonly recipe: string; readonly recording: string },
  requireDigest = true,
): Promise<QualityRecord | string> {
  const digest = etagDigest(etag);
  if (digest === null && requireDigest) return "record_digest_missing";
  if (digest !== null && (await subtleSha256(bytes)) !== digest) {
    return "record_digest_mismatch";
  }
  let body: unknown;
  try {
    body = readJson(bytes);
  } catch (error) {
    if (error instanceof KindRefused) return "record_invalid";
    throw error;
  }
  const b = objectOf(body);
  const d = objectOf(b.derivative);
  const doc = objectOf(b.dataQuality);
  const digests = objectOf(b.view_digests);
  if (
    b.format !== QUALITY_RECORD_FORMAT ||
    !sha256(d.key) ||
    !["version", "recipe_version", "retention", "stored_at"].every(
      (k) => typeof d[k] === "string",
    ) ||
    !Object.values(digests).every(sha256) ||
    !recordDocumentValid(b.dataQuality)
  ) {
    return "record_invalid";
  }
  if (
    b.dataset_id !== asked.datasetId ||
    b.recipe !== asked.recipe ||
    b.recording !== asked.recording
  ) {
    return "record_elsewhere";
  }
  const entry = objectOf(objectOf(doc.recipes)[asked.recipe]);
  if (!own(objectOf(doc.recipes), asked.recipe)) return "record_invalid";
  if (recordChecks(asked.recipe, entry).length > 0) return "record_checks_failed";
  return {
    datasetId: asked.datasetId,
    recipe: asked.recipe,
    recording: asked.recording,
    derivative: d as unknown as QualityDerivative,
    views: entry.views as Json[],
    skipped: listOf(entry.views_skipped) as QualityRecord["skipped"],
    metrics: entry.metrics as Record<string, Json>,
    digests: digests as Record<string, string>,
  };
}
