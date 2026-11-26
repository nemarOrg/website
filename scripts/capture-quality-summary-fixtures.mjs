/**
 * Capture the dataset quality summary fixtures from the REAL nemar-cli metadata route and its real
 * checks (nemar-cli ADR 0137 decisions 7 and 8; epic nemarOrg/nemar-cli#2324 phase W5, website#588).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's epic #2324 branch> \
 *     bun scripts/capture-quality-summary-fixtures.mjs
 *
 * The checkout needs `bun install` at its root and in `backend/`. Nothing is stood in for:
 *
 * - `metadata-*.json`: `GET /<id>/metadata.json` through the backend's own `dataRoutes` over a real
 *   migrated database, with the stamps, derivatives and kept summaries written as the backend's own
 *   `backend/test/metadata-json-quality.test.ts` writes them. The summary is nemar-ica's real one
 *   (nemar-process P7, `backend/test/helpers/quality-fixture.ts`), or that summary widened to several
 *   recordings (`spread`, below), which this script holds to the backend's schema and writer rules
 *   before it stores it. Each world is one gate: shown, a canary only, a concealed deposit, withdrawn,
 *   tombstoned, never published, private.
 * - `dataset-quality-verdicts.json`: dataset-level `dataQuality` documents, each with the verdict of
 *   Ajv over nemar-cli's vendored neuroschema bundle (`test/contract/neuroschema-validator.ts`) and the
 *   first writer rule the backend's `writerRuleBroken` finds (null when none), for the site's
 *   hand-written guard to reproduce. The documents are the real summary and named changes of it.
 *
 * Dataset ids are in a band no live dataset uses. No real host, person or path appears.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to a checkout of nemar-cli's epic #2324 branch.");
  process.exit(1);
}
const root = resolve(NEMAR_CLI_DIR);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "test", "fixtures", "quality-summary");
const load = (path) => import(join(root, path));

const COMMIT = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();

const { Hono } = await import(Bun.resolveSync("hono", join(root, "backend")));
const { dataRoutes } = await load("backend/src/routes/data.ts");
const { freshDb, realD1 } = await load("backend/test/helpers/d1.ts");
const { fixtureEntry, newJobId, seedDerivative, seedIcaStamp } = await load(
  "backend/test/helpers/quality-fixture.ts",
);
const { DatasetQualityDocumentSchema, writerRuleBroken } = await load(
  "backend/src/services/quality-documents.ts",
);
const { compileNeuroschemaValidator } = await load("test/contract/neuroschema-validator.ts");

const validateQuality = compileNeuroschemaValidator("nsc:/extensions/dataQuality.schema.json");
const validateExtensions = compileNeuroschemaValidator(
  "nsc:/extensions/extensionsContainer.schema.json",
);

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Ajv's verdict and the backend's first writer rule broken, for one dataset-level document. */
function verdictOf(document) {
  const valid = validateQuality(document) === true;
  const errors = valid
    ? []
    : (validateQuality.errors ?? []).map((e) => [e.keyword, e.instancePath.replace(/^\//, "")]);
  let writerRule = null;
  const parsed = DatasetQualityDocumentSchema.safeParse(document);
  if (valid !== parsed.success) {
    throw new Error(`Ajv and the backend's schema disagree on ${JSON.stringify(document)}`);
  }
  if (parsed.success) {
    for (const entry of Object.values(parsed.data.recipes)) {
      writerRule ??= writerRuleBroken(entry, false);
    }
  }
  return { valid, errors, writer_rule: writerRule };
}

const BASE = fixtureEntry();

/**
 * The real summary widened to six recordings: three passed, two failed and one skipped, two of the
 * three listed and one left out by the cap; percentGoodChannels over three values (one under the
 * first edge) and a missing one; and a metric with no value at all.
 */
function spread() {
  const e = clone(BASE);
  e.counts = { passed: 3, failed: 2, skipped: 1, total: 6 };
  e.not_processed = [
    { path: "sub-04/eeg/sub-04_task-rest_eeg.set", status: "failed", code: "ica_not_converged" },
    { path: "sub-05/eeg/sub-05_task-rest_eeg.set", status: "skipped", code: "too_few_channels" },
  ];
  e.not_processed_truncated = 1;
  const d = e.distributions.percentGoodChannels;
  d.n = 3;
  d.histogram.counts = [0, 0, 0, 0, 0, 0, 0, 1, 0, 1];
  d.histogram.underflow = 1;
  d.histogram.missing = 1;
  d.min = -2.5;
  d.median = 75.25;
  d.max = 90.4762;
  e.observed_range.percentGoodChannels = { min: -2.5, max: 90.4762 };
  e.distributions.channelsInterpolated = {
    description: "Channels the floor interpolated.",
    histogram: { counts: [0, 0, 0], edges: [0, 4, 8, 16], missing: 0, overflow: 0, underflow: 0 },
    max: null,
    median: null,
    min: null,
    n: 0,
    unit: "count",
  };
  e.observed_range.channelsInterpolated = { min: null, max: null };
  return e;
}

const SPREAD = spread();
for (const [name, entry] of [
  ["base", BASE],
  ["spread", SPREAD],
]) {
  const v = verdictOf({ level: "dataset", recipes: { "nemar-ica": entry } });
  if (!v.valid || v.writer_rule !== null)
    throw new Error(`${name} is not a summary the backend keeps`);
}

// --- 1. metadata.json, one world per gate ---------------------------------------------------------

let db = freshDb();
const app = new Hono();
app.route("/", dataRoutes);
const env = () => ({ DB: realD1(db), ENVIRONMENT: "test" });

function seedDataset(id, over = {}) {
  const anonymous = over.anonymous ?? 0;
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox, anonymous, modalities,
                           withdrawn_at, first_published_at, ezid_status)
     VALUES (?, ?, -1, 'active', ?, 0, ?, 'eeg', ?, ?, ?)`,
    [
      id,
      `Quality summary fixture ${id}`,
      over.visibility ?? "public",
      anonymous,
      over.withdrawnAt ?? null,
      over.firstPublishedAt !== undefined
        ? over.firstPublishedAt
        : anonymous === 1
          ? null
          : "2026-01-01 00:00:00",
      over.ezidStatus ?? null,
    ],
  );
}

async function run(datasetId, over = {}) {
  const d1 = realD1(db);
  const jobId = newJobId();
  const runs = db
    .query("SELECT COUNT(*) AS n FROM compute_pipeline_stamps WHERE dataset_id = ?")
    .get(datasetId).n;
  const stampId = await seedIcaStamp(d1, { datasetId, jobId, version: `v1.0.${runs}` });
  await seedDerivative(d1, {
    datasetId,
    stampId,
    jobId,
    retention: over.retention ?? "catalog",
  });
  db.run(
    "INSERT INTO compute_quality_documents (stamp_id, dataset_id, recipe, entry, record_sha256) VALUES (?, ?, ?, ?, ?)",
    [stampId, datasetId, "nemar-ica", JSON.stringify(over.entry ?? BASE), "4".repeat(64)],
  );
}

async function metadata(id) {
  const res = await app.request(`/${id}/metadata.json`, {}, env());
  const text = await res.text();
  return { status: res.status, text };
}

const WORLDS = [
  ["shown", "nm099201", {}, {}],
  ["spread", "nm099202", {}, { entry: SPREAD }],
  ["published", "nm099203", {}, { retention: "published" }],
  ["canary-only", "nm099204", {}, { retention: "canary" }],
  ["concealed", "nm099205", { anonymous: 1 }, {}],
  ["withdrawn", "nm099206", { withdrawnAt: "2026-11-24 10:00:00" }, {}],
  ["tombstoned", "nm099207", { ezidStatus: "unavailable" }, {}],
  ["never-published", "nm099208", { firstPublishedAt: null }, {}],
  ["private", "nm099209", { visibility: "private" }, {}],
];

const files = {};
for (const [name, id, dataset, derivative] of WORLDS) {
  seedDataset(id, dataset);
  await run(id, derivative);
  const { status, text } = await metadata(id);
  const body = status === 200 ? JSON.parse(text) : null;
  if (body && !validateExtensions(body.extensions)) {
    throw new Error(`${name}: the extensions do not validate`);
  }
  files[`metadata-${name}.json`] = {
    _provenance: {
      command:
        "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-quality-summary-fixtures.mjs",
      nemar_cli_commit: COMMIT,
      route: `GET /${id}/metadata.json`,
      world: { dataset, derivative: { retention: derivative.retention ?? "catalog" } },
      note: "The real dataRoutes over a real migrated database; rows as backend/test/metadata-json-quality.test.ts writes them. `text` is the body as served, byte for byte.",
    },
    status,
    text,
  };
}
db = null;

// --- 2. The guard's verdicts ------------------------------------------------------------------------

/** A document of one entry, nemar-ica's (`entry`, the real summary by default). */
const doc = (entry = BASE) => ({ level: "dataset", recipes: { "nemar-ica": clone(entry) } });
/** The document of `entry` with `edit` applied to a copy of its entry. */
const change =
  (edit, entry = BASE) =>
  () => {
    const d = doc(entry);
    edit(d.recipes["nemar-ica"]);
    return d;
  };
const icaRank = (edit) => change((e) => edit(e.distributions.icaRank));
const listed = (edit) => change((e) => edit(e.not_processed[0]), SPREAD);
const metric = (name) =>
  change((e) => {
    e.distributions[name] = e.distributions.icaRank;
    e.observed_range[name] = e.observed_range.icaRank;
  });

const CASES = [
  ["real_summary", "nemar-ica's real summary.", () => doc()],
  ["spread", "The summary over six recordings, some not processed.", () => doc(SPREAD)],
  ["no_recipes", "A document with no recipe.", () => ({ level: "dataset", recipes: {} })],
  [
    "root_member",
    "A member beside level and recipes: the root is closed.",
    () => ({ ...doc(), counts: {} }),
  ],
  ["level_missing", "No level.", () => ({ recipes: doc().recipes })],
  ["level_record", "A dataset entry under level record.", () => ({ ...doc(), level: "record" })],
  ["level_unknown", "A level that is neither.", () => ({ ...doc(), level: "subject" })],
  [
    "recipe_id_pattern",
    "A recipe id with an uppercase letter.",
    () => ({ level: "dataset", recipes: { "Nemar-ica": clone(BASE) } }),
  ],
  [
    "recipe_id_newline",
    "A recipe id with a final newline.",
    () => ({ level: "dataset", recipes: { "nemar-ica\n": clone(BASE) } }),
  ],
  [
    "entry_member",
    "A member the entry does not have: it is closed.",
    change((e) => {
      e.views = [];
    }),
  ],
  [
    "entry_counts_missing",
    "No counts.",
    change((e) => {
      delete e.counts;
    }),
  ],
  [
    "entry_not_processed_missing",
    "No not_processed.",
    change((e) => {
      delete e.not_processed;
    }),
  ],
  [
    "counts_member",
    "A member the counts do not have.",
    change((e) => {
      e.counts.queued = 0;
    }),
  ],
  [
    "counts_negative",
    "A negative count.",
    change((e) => {
      e.counts.failed = -1;
    }),
  ],
  [
    "counts_fraction",
    "A count that is not an integer.",
    change((e) => {
      e.counts.total = 1.5;
    }),
  ],
  [
    "counts_unsafe",
    "A count beyond 2^53 - 1.",
    change((e) => {
      e.counts.total = 9007199254740992;
    }),
  ],
  [
    "recipe_version_space",
    "A recipe version with a space.",
    change((e) => {
      e.recipe_version = "1 0";
    }),
  ],
  [
    "dataset_version_null",
    "An unversioned dataset.",
    change((e) => {
      e.dataset_version = null;
    }),
  ],
  [
    "record_sha256_upper",
    "A record digest in uppercase.",
    change((e) => {
      e.record_sha256 = "A".repeat(64);
    }),
  ],
  [
    "record_sha256_short",
    "A record digest of 63 digits.",
    change((e) => {
      e.record_sha256 = "a".repeat(63);
    }),
  ],
  [
    "input_profile_pairing",
    "A Zarr input that describes the archive.",
    change((e) => {
      e.input_kind = "zarr";
    }),
  ],
  [
    "serving_pair",
    "A Zarr input that describes the serving copy.",
    change((e) => {
      e.input_kind = "zarr";
      e.profile = "serving";
    }),
  ],
  ["metric_name_two_colons", "A metric name with two colons.", metric("a:b:c")],
  ["metric_name_long", "A metric name of 129 characters.", metric(`m${"x".repeat(128)}`)],
  [
    "unit_empty",
    "An empty unit.",
    icaRank((d) => {
      d.unit = "";
    }),
  ],
  [
    "unit_33",
    "A unit of 33 characters.",
    icaRank((d) => {
      d.unit = "u".repeat(33);
    }),
  ],
  [
    "unit_32_astral",
    "A unit of 32 code points, 64 UTF-16 units: lengths count code points.",
    icaRank((d) => {
      d.unit = "\u{1d707}".repeat(32);
    }),
  ],
  [
    "unit_missing",
    "A distribution with no unit.",
    icaRank((d) => {
      delete d.unit;
    }),
  ],
  [
    "description_501",
    "A description of 501 characters.",
    icaRank((d) => {
      d.description = "d".repeat(501);
    }),
  ],
  [
    "description_missing",
    "A distribution with no description, which is optional.",
    icaRank((d) => {
      delete d.description;
    }),
  ],
  [
    "distribution_member",
    "A member a distribution does not have.",
    icaRank((d) => {
      d.mean = 18;
    }),
  ],
  [
    "median_string",
    "A median that is text.",
    icaRank((d) => {
      d.median = "18";
    }),
  ],
  [
    "n_fraction",
    "An n that is not an integer.",
    icaRank((d) => {
      d.n = 1.5;
    }),
  ],
  [
    "edges_one",
    "A histogram with one edge.",
    icaRank((d) => {
      d.histogram.edges = [0];
    }),
  ],
  [
    "counts_empty",
    "A histogram with no count.",
    icaRank((d) => {
      d.histogram.counts = [];
    }),
  ],
  [
    "histogram_member",
    "A member a histogram does not have.",
    icaRank((d) => {
      d.histogram.bins = 8;
    }),
  ],
  [
    "histogram_missing_overflow",
    "A histogram with no overflow.",
    icaRank((d) => {
      delete d.histogram.overflow;
    }),
  ],
  [
    "histogram_missing_missing",
    "A histogram with no missing count, which is optional.",
    icaRank((d) => {
      delete d.histogram.missing;
    }),
  ],
  [
    "edge_string",
    "An edge that is text.",
    icaRank((d) => {
      d.histogram.edges[1] = "8";
    }),
  ],
  [
    "range_member",
    "A member a range does not have.",
    change((e) => {
      e.observed_range.icaRank.mid = 18;
    }),
  ],
  [
    "range_string",
    "A range end that is text.",
    change((e) => {
      e.observed_range.icaRank.min = "18";
    }),
  ],
  [
    "not_processed_201",
    "201 recordings listed, one over the cap.",
    change((e) => {
      e.not_processed = Array.from({ length: 201 }, (_, i) => ({
        path: `sub-${i}/eeg/x.set`,
        status: "failed",
        code: "x",
      }));
    }),
  ],
  [
    "not_processed_absolute",
    "A not-processed path with a leading slash.",
    listed((r) => {
      r.path = "/sub-04/eeg/x.set";
    }),
  ],
  [
    "not_processed_dotdot",
    "A not-processed path with a .. segment.",
    listed((r) => {
      r.path = "sub-04/../x.set";
    }),
  ],
  [
    "not_processed_status",
    "A status that is neither failed nor skipped.",
    listed((r) => {
      r.status = "error";
    }),
  ],
  [
    "not_processed_code",
    "A code with an uppercase letter.",
    listed((r) => {
      r.code = "Bad";
    }),
  ],
  [
    "not_processed_member",
    "A member a listed recording does not have.",
    listed((r) => {
      r.reason = "x";
    }),
  ],
  [
    "truncated_negative",
    "A negative count left out.",
    change((e) => {
      e.not_processed_truncated = -1;
    }),
  ],
  // The writer's rules: the schema holds, the backend refuses.
  [
    "writer_counts_unbalanced",
    "Counts that do not add up to the total.",
    change((e) => {
      e.counts.total = 2;
    }),
  ],
  [
    "writer_listing_mismatch",
    "Listed and left out are not the failed and the skipped.",
    change((e) => {
      e.not_processed_truncated = 0;
    }, SPREAD),
  ],
  [
    "writer_counts_length",
    "One count fewer than the edges is the rule; here two fewer.",
    icaRank((d) => {
      d.histogram.counts.pop();
    }),
  ],
  [
    "writer_edges_flat",
    "Edges that do not strictly rise.",
    icaRank((d) => {
      d.histogram.edges[1] = 0;
    }),
  ],
  [
    "writer_n_sum",
    "An n that is not the bins, the underflow and the overflow.",
    icaRank((d) => {
      d.n = 2;
    }),
  ],
  [
    "writer_n_counts_missing",
    "The missing count is in no bin and not in n.",
    icaRank((d) => {
      d.histogram.missing = 1;
      d.n = 2;
    }),
  ],
  [
    "writer_null_with_values",
    "A null median with values.",
    icaRank((d) => {
      d.median = null;
    }),
  ],
  [
    "writer_values_without_n",
    "A median with no values.",
    change((e) => {
      e.distributions.channelsInterpolated.median = 1;
    }, SPREAD),
  ],
  [
    "writer_median_above_max",
    "A median above the max.",
    icaRank((d) => {
      d.median = 19;
    }),
  ],
  [
    "writer_range_mismatch",
    "An observed range that is not the distribution's min and max.",
    change((e) => {
      e.observed_range.icaRank.max = 19;
    }),
  ],
  [
    "writer_range_missing",
    "A distribution with no observed range.",
    change((e) => {
      delete e.observed_range.icaRank;
    }),
  ],
  [
    "writer_range_extra",
    "An observed range with no distribution.",
    change((e) => {
      e.observed_range.other = { min: 1, max: 2 };
    }),
  ],
];

const verdicts = {
  _provenance: {
    command: "NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/capture-quality-summary-fixtures.mjs",
    nemar_cli_commit: COMMIT,
    note: "valid is Ajv's verdict over nemar-cli's vendored neuroschema bundle (nsc:/extensions/dataQuality.schema.json), held equal to the backend's DatasetQualityDocumentSchema; writer_rule is the backend's writerRuleBroken on a valid document (null when every rule holds).",
  },
  format: "nemar.website-dataset-quality-verdicts.v1",
  cases: CASES.map(([name, covers, build]) => ({
    name,
    covers,
    document: build(),
    ...verdictOf(build()),
  })),
};
files["dataset-quality-verdicts.json"] = verdicts;

await mkdir(OUT, { recursive: true });
/** Pretty, except that each verdict case is one line (a case of 201 listed recordings is long). */
function serialize(content) {
  if (!Array.isArray(content.cases)) return `${JSON.stringify(content, null, 2)}\n`;
  const { cases, ...head } = content;
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  return `${top},\n  "cases": [\n${cases.map((c) => `    ${JSON.stringify(c)}`).join(",\n")}\n  ]\n}\n`;
}
for (const [name, content] of Object.entries(files)) {
  await writeFile(join(OUT, name), serialize(content));
}
console.log(`wrote ${Object.keys(files).join(", ")} to ${OUT} from nemar-cli ${COMMIT}`);
process.exit(0);
