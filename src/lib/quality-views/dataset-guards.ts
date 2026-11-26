/**
 * Hand-written guards for what the dataset summary reads of a dataset document (neuroschema 0.6.0;
 * website ADR 0035 decision 4; the live-views plan's W5), built from `guards.ts`'s combinators so
 * they read like the schema keywords they stand for.
 *
 * - `datasetQualityValid`: `extensions/dataQuality.schema.json` at `level: dataset`, rule for rule
 *   (closed at every level, its root included; every integer at most 2^53 - 1; lengths in code
 *   points; a Zarr input describes the serving copy and a BIDS input the archive). Held to Ajv's
 *   verdicts over nemar-cli's vendored bundle by `test/quality-summary.test.ts`.
 * - `dataPaperValid`: `definitions/dataPaper.schema.json`, whole.
 * - `documentHeadValid`: the root `neuroschema.schema.json` and the identity members of the
 *   document it selects (the dataset's `dataset_id`, `name`, `source`, `recording_modality` and
 *   `data_papers`; a record's `dataset`, `bids_relpath` and `modality`). It is not the whole
 *   document's schema: the page reads the rest of `metadata.json` member by member, null-safely.
 *
 * The data paper and the root are held to neuroschema's verdict corpus (`kinds-verdicts.v1.json`)
 * by `test/quality-views-dataset-guards.test.ts`. The corpus's `dataQuality` cases are recording
 * entries, which the per-recording panel reads (phase W6).
 *
 * `writerRuleBroken` runs the writer's rules no schema can state (nemar-process
 * `dataquality.problems`, nemar-cli `writerRuleBroken`), in the backend's order and words.
 */

import { type Guard, kit } from "./guards";
import { MAX_SAFE } from "./read";

const { all, any, arr, eq, ifThen, int, isNull, num, obj, oneIn, relativeLocation, sha256, str } =
  kit;

/** `type: object` whose every member name meets `name` and every value `value`
 *  (`propertyNames` with `additionalProperties`). */
const record =
  (name: Guard, value: Guard): Guard =>
  (v) =>
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(v).every(([k, item]) => name(k) && value(item));

const count = int(0, MAX_SAFE);
const nullableNumber = any(num(), isNull);
const version = str({ pattern: /^[0-9A-Za-z._+-]{1,64}$/ });
const recipeId = str({ pattern: /^[a-z0-9-]{1,64}$/ });
const failureCode = str({ pattern: /^[a-z][a-z0-9_]{0,63}$/ });
const metricName = str({
  max: 128,
  pattern: /^[A-Za-z][A-Za-z0-9_-]*(:[A-Za-z][A-Za-z0-9_-]*)?$/,
});

const range = obj({
  req: ["min", "max"],
  props: { min: nullableNumber, max: nullableNumber },
  closed: true,
});
const checkpointCounts = obj({
  req: ["passed", "failed", "skipped", "total"],
  props: { passed: count, failed: count, skipped: count, total: count },
  closed: true,
});
const inputProfilePairing = all(
  ifThen(
    obj({ req: ["input_kind"], props: { input_kind: eq("zarr") } }),
    obj({ props: { profile: eq("serving") } }),
  ),
  ifThen(
    obj({ req: ["input_kind"], props: { input_kind: eq("bids") } }),
    obj({ props: { profile: eq("archive") } }),
  ),
);

const distribution = obj({
  req: ["n", "unit", "min", "median", "max", "histogram"],
  props: {
    n: count,
    unit: str({ min: 1, max: 32 }),
    description: str({ min: 1, max: 500 }),
    min: nullableNumber,
    median: nullableNumber,
    max: nullableNumber,
    histogram: obj({
      req: ["edges", "counts", "underflow", "overflow"],
      props: {
        edges: arr({ min: 2, items: num() }),
        counts: arr({ min: 1, items: count }),
        underflow: count,
        overflow: count,
        missing: count,
      },
      closed: true,
    }),
  },
  closed: true,
});
const notProcessed = obj({
  req: ["path", "status", "code"],
  props: { path: relativeLocation, status: oneIn("failed", "skipped"), code: failureCode },
  closed: true,
});
const datasetRecipeSummary = obj({
  req: [
    "recipe_version",
    "dataset_version",
    "input_kind",
    "profile",
    "record_sha256",
    "counts",
    "distributions",
    "observed_range",
    "not_processed",
    "not_processed_truncated",
  ],
  props: {
    recipe_version: version,
    dataset_version: any(version, isNull),
    input_kind: oneIn("bids", "zarr"),
    profile: oneIn("archive", "serving"),
    record_sha256: sha256,
    counts: checkpointCounts,
    distributions: record(metricName, distribution),
    observed_range: record(metricName, range),
    not_processed: arr({ max: 200, items: notProcessed }),
    not_processed_truncated: count,
  },
  closed: true,
  also: [inputProfilePairing],
});

/** `dataQuality` at `level: dataset`: the root closed to `level` and `recipes`. */
export const datasetQualityValid: Guard = obj({
  req: ["level", "recipes"],
  props: { level: eq("dataset"), recipes: record(recipeId, datasetRecipeSummary) },
  closed: true,
});

// ── The dataset document ────────────────────────────────────────────────

export const dataPaperValid: Guard = obj({
  req: ["doi"],
  props: {
    doi: str({ pattern: /^10\.[0-9]{4,9}\/[!-~]+$/ }),
    title: any(str(), isNull),
    year: any(int(-MAX_SAFE, MAX_SAFE), isNull),
    venue: any(str(), isNull),
    judge_model: any(str(), isNull),
  },
  closed: true,
});

const DATASET_ID = /^[a-z]{2}[0-9]+$/;
const datasetHead = obj({
  req: ["dataset_id", "name", "source", "recording_modality"],
  props: {
    dataset_id: str({ pattern: DATASET_ID }),
    name: str(),
    source: oneIn("openneuro", "nemar", "gin", "other"),
    recording_modality: arr({ min: 1, items: str() }),
    data_papers: arr({ items: dataPaperValid }),
  },
});
const recordHead = obj({
  req: ["dataset", "bids_relpath", "modality"],
  props: { dataset: str({ pattern: DATASET_ID }), bids_relpath: str(), modality: str() },
});

/** The root's envelope and the identity of the document it selects (see the file's comment). */
export const documentHeadValid: Guard = obj({
  req: ["schema_version", "doc_type"],
  props: {
    schema_version: str({ pattern: /^[0-9]+\.[0-9]+\.[0-9]+$/ }),
    doc_type: oneIn("dataset", "record"),
  },
  also: [
    ifThen(obj({ req: ["doc_type"], props: { doc_type: eq("dataset") } }), datasetHead, recordHead),
  ],
});

// ── The writer's rules ──────────────────────────────────────────────────

/** The words of a writer rule broken, nemar-cli's `WRITER_RULE_WORDS` without `integer_unsafe`
 *  (the schema's integer cap refuses such a document first, since the page reads numbers as
 *  binary64). */
export type WriterRuleWord =
  | "counts_unbalanced"
  | "listing_mismatch"
  | "distribution_invalid"
  | "observed_range_mismatch";

/** A dataset recipe summary that `datasetQualityValid` admits. */
export interface DatasetRecipeSummary {
  readonly recipe_version: string;
  readonly dataset_version: string | null;
  readonly input_kind: "bids" | "zarr";
  readonly profile: "archive" | "serving";
  readonly record_sha256: string;
  readonly counts: { passed: number; failed: number; skipped: number; total: number };
  readonly distributions: Readonly<Record<string, Distribution>>;
  readonly observed_range: Readonly<Record<string, { min: number | null; max: number | null }>>;
  readonly not_processed: readonly { path: string; status: "failed" | "skipped"; code: string }[];
  readonly not_processed_truncated: number;
}
export interface Distribution {
  readonly n: number;
  readonly unit: string;
  readonly description?: string;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
  readonly histogram: {
    readonly edges: readonly number[];
    readonly counts: readonly number[];
    readonly underflow: number;
    readonly overflow: number;
    readonly missing?: number;
  };
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function distributionHolds(d: Distribution): boolean {
  const { edges, counts, underflow, overflow } = d.histogram;
  if (counts.length !== edges.length - 1) return false;
  for (let i = 1; i < edges.length; i++) if (!(edges[i - 1] < edges[i])) return false;
  // n is the bins, the underflow and the overflow; a missing value is in none of them.
  if (d.n !== sum(counts) + underflow + overflow) return false;
  if (d.n === 0) return d.min === null && d.median === null && d.max === null;
  return (
    d.min !== null && d.median !== null && d.max !== null && d.min <= d.median && d.median <= d.max
  );
}

/** The first writer rule an entry breaks, or null, in the backend's order. */
export function writerRuleBroken(entry: DatasetRecipeSummary): WriterRuleWord | null {
  const c = entry.counts;
  if (c.passed + c.failed + c.skipped !== c.total) return "counts_unbalanced";
  if (entry.not_processed.length + entry.not_processed_truncated !== c.failed + c.skipped) {
    return "listing_mismatch";
  }
  for (const d of Object.values(entry.distributions)) {
    if (!distributionHolds(d)) return "distribution_invalid";
  }
  const names = Object.keys(entry.distributions);
  if (names.length !== Object.keys(entry.observed_range).length) return "observed_range_mismatch";
  for (const name of names) {
    // Own members only: a metric named `constructor` must not find Object.prototype's.
    if (!Object.hasOwn(entry.observed_range, name)) return "observed_range_mismatch";
    const range = entry.observed_range[name];
    const d = entry.distributions[name];
    if (range.min !== d.min || range.max !== d.max) {
      return "observed_range_mismatch";
    }
  }
  return null;
}
