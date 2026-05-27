import type { LandingPayload, Manifest, NeuroschemaDataset } from "./neuroschema";
import type { Dataset } from "./types";

const DEFAULT_DATA_BASE = "https://data.nemar.org";

export interface SummaryTotals {
  files?: number;
  bytes?: number;
  subjects?: number;
}

export interface SummaryReadme {
  path?: string;
  // Schema 1.1+ fields (nemar-cli#616, still open at time of writing — the
  // 256 KB inline cap referenced below is proposed, not yet enforced). Older
  // summary.json docs have only `path`; consumers must tolerate the absence
  // of every field below. On a truncated README the generator emits
  // `truncated: true` with `content: null` (declared as `string | null` so
  // the wire shape and the static type agree).
  content?: string | null;
  content_bytes?: number;
  sha256?: string;
  truncated?: boolean;
}

export interface Summary {
  schema_version?: string;
  dataset_id: string;
  version: string;
  doi?: string;
  concept_doi?: string;
  created?: string;
  totals?: SummaryTotals;
  modalities?: string[];
  subjects?: string[];
  readme?: SummaryReadme;
  paths: string[];
}

function dataBase(envOverride?: string): string {
  if (envOverride) return envOverride.replace(/\/$/, "");
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_DATA_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_DATA_BASE).replace(/\/$/, "");
}

export interface DataApiInit {
  signal?: AbortSignal;
  dataBase?: string;
  timeoutMs?: number;
}

/**
 * Tagged result of a `jsonFetch` call. Every failure mode is captured as
 * data — nothing throws. Lets callers branch on the real reason a fetch
 * didn't succeed (404 vs timeout vs 5xx vs malformed JSON), which is the
 * difference between "render real 404" and "render degraded state."
 */
export type FetchOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: "rate_limited" }
  | { kind: "upstream_error"; status: number; statusText: string }
  | { kind: "timeout" }
  | { kind: "network_error"; message: string }
  | { kind: "parse_error"; message: string };

/**
 * Retries once on 429 honoring Retry-After before settling on
 * `rate_limited`. Bails the wait early when the parent abort signal
 * fires so caller cancellation doesn't burn the full Retry-After delay.
 */
async function jsonFetch<T>(
  url: string,
  init: DataApiInit,
  accept = "application/json",
): Promise<FetchOutcome<T>> {
  const controller = new AbortController();
  const timeout = init.timeoutMs ?? 5_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  // When the inner controller aborts we need to know WHY for the outcome
  // tag: parent caller cancellation vs our own timeout vs an upstream
  // abort. AbortError alone doesn't carry that signal. Track it ourselves.
  const isParentAborted = () => init.signal?.aborted === true;

  async function attempt(): Promise<Response> {
    return fetch(url, { signal: controller.signal, headers: { Accept: accept } });
  }

  function abortToOutcome(err: unknown): FetchOutcome<T> {
    const name = (err as { name?: string }).name ?? "";
    const message = (err as Error).message ?? String(err);
    if (name === "AbortError") {
      if (isParentAborted()) {
        return { kind: "network_error", message: "request cancelled by caller" };
      }
      return { kind: "timeout" };
    }
    return { kind: "network_error", message };
  }

  try {
    let res: Response;
    try {
      res = await attempt();
    } catch (err) {
      return abortToOutcome(err);
    }

    if (res.status === 429) {
      // Rate-limited. Wait Retry-After (or 1s default) and try once more.
      // Listen on the inner controller so an abort during the wait bails
      // immediately instead of burning the full Retry-After delay.
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "1", 10);
      const waitMs = Math.min(Math.max(retryAfter, 1) * 1000, 5_000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      if (controller.signal.aborted) {
        return abortToOutcome({ name: "AbortError" });
      }
      try {
        res = await attempt();
      } catch (err) {
        return abortToOutcome(err);
      }
      if (res.status === 429) return { kind: "rate_limited" };
    }

    if (res.status === 404) return { kind: "not_found" };
    if (res.status >= 500 && res.status < 600) {
      return { kind: "upstream_error", status: res.status, statusText: res.statusText };
    }
    if (!res.ok) {
      return { kind: "upstream_error", status: res.status, statusText: res.statusText };
    }

    try {
      const value = (await res.json()) as T;
      return { kind: "ok", value };
    } catch (err) {
      return { kind: "parse_error", message: (err as Error).message ?? String(err) };
    }
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Compatibility wrapper for callers that just want `T | null`. Logs every
 * non-ok outcome except `not_found` (which is a routine "the resource
 * doesn't exist" — not worth a log line on every dataset page render).
 */
async function jsonFetchOrNull<T>(
  url: string,
  init: DataApiInit,
  accept = "application/json",
): Promise<T | null> {
  const out = await jsonFetch<T>(url, init, accept);
  if (out.kind === "ok") return out.value;
  if (out.kind !== "not_found") {
    const detail = out.kind === "upstream_error" ? `${out.kind} ${out.status}` : out.kind;
    console.warn(`[data-api] ${url}: ${detail}`);
  }
  return null;
}

export function outcomeValue<T>(outcome: FetchOutcome<T>): T | null {
  return outcome.kind === "ok" ? outcome.value : null;
}

/**
 * Dataset detail page status resolution.
 *
 * The SSR page needs to choose between 404 (real "this dataset does not
 * exist"), 503 (degraded — dataset may exist but the data layer can't
 * answer right now), and 200 (render normally). The decision is non-
 * obvious because the two upstream signals (landing + metadata) can each
 * be any of seven outcomes, and only one of the nine combinations is a
 * confirmed 404 — both reporting not_found independently. A single
 * not_found from either signal could be a partial publish or a transient
 * 404 from the data layer.
 */
export type DatasetPageStatus =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "degraded"; signal: "landing" | "metadata"; outcome: string };

export function resolveDatasetPageStatus<L, M>(
  landingOut: FetchOutcome<L>,
  metadataOut: FetchOutcome<M>,
): DatasetPageStatus {
  // Confirmed 404: both signals independently report missing.
  if (landingOut.kind === "not_found" && metadataOut.kind === "not_found") {
    return { kind: "not_found" };
  }
  // Landing not_found alone is treated as degraded, not 404 — a partial
  // publish (metadata exists but no landing yet, or vice versa) is a real
  // state we shouldn't mask as a typo.
  if (landingOut.kind !== "ok" && landingOut.kind !== "not_found") {
    return { kind: "degraded", signal: "landing", outcome: landingOut.kind };
  }
  if (landingOut.kind === "not_found") {
    return { kind: "degraded", signal: "landing", outcome: "not_found" };
  }
  // metadata.json is OPTIONAL on the data side — a fresh dataset can have
  // landing without metadata yet. Only degrade on hard failures, not on
  // not_found.
  if (metadataOut.kind !== "ok" && metadataOut.kind !== "not_found") {
    return { kind: "degraded", signal: "metadata", outcome: metadataOut.kind };
  }
  return { kind: "ok" };
}

// ============================================================================
// Typed fetchers — preserve the existing `T | null` API.
// ============================================================================

export async function getLanding(
  datasetId: string,
  init: DataApiInit = {},
): Promise<LandingPayload | null> {
  return jsonFetchOrNull<LandingPayload>(landingUrl(datasetId, init), init);
}

export async function getMetadata(
  datasetId: string,
  init: DataApiInit = {},
): Promise<NeuroschemaDataset | null> {
  return jsonFetchOrNull<NeuroschemaDataset>(metadataUrl(datasetId, init), init);
}

export async function getSummary(
  datasetId: string,
  version: string,
  init: DataApiInit = {},
): Promise<Summary | null> {
  return jsonFetchOrNull<Summary>(summaryUrl(datasetId, version, init), {
    ...init,
    timeoutMs: init.timeoutMs ?? 1_500,
  });
}

export async function getManifest(
  datasetId: string,
  version: string,
  init: DataApiInit = {},
): Promise<Manifest | null> {
  return jsonFetchOrNull<Manifest>(manifestUrl(datasetId, version, init), init);
}

// ============================================================================
// Outcome variants — for callers that need to distinguish failure modes
// (e.g., real 404 vs degraded data layer). Same URLs + same fetch semantics
// as the legacy helpers; the only difference is the return shape.
// ============================================================================

export async function getLandingOutcome(
  datasetId: string,
  init: DataApiInit = {},
): Promise<FetchOutcome<LandingPayload>> {
  return jsonFetch<LandingPayload>(landingUrl(datasetId, init), init);
}

export async function getMetadataOutcome(
  datasetId: string,
  init: DataApiInit = {},
): Promise<FetchOutcome<NeuroschemaDataset>> {
  return jsonFetch<NeuroschemaDataset>(metadataUrl(datasetId, init), init);
}

export async function getSummaryOutcome(
  datasetId: string,
  version: string,
  init: DataApiInit = {},
): Promise<FetchOutcome<Summary>> {
  return jsonFetch<Summary>(summaryUrl(datasetId, version, init), {
    ...init,
    timeoutMs: init.timeoutMs ?? 1_500,
  });
}

export async function getManifestOutcome(
  datasetId: string,
  version: string,
  init: DataApiInit = {},
): Promise<FetchOutcome<Manifest>> {
  return jsonFetch<Manifest>(manifestUrl(datasetId, version, init), init);
}

/**
 * Per-field envelope used inside `DatasetPageBundle`. The CLI worker wraps
 * each constituent payload with an `ok` flag so partial failures in its
 * internal fan-in are explicit at parse time. We don't lose this signal —
 * `bundleFieldToOutcome` lifts it into the existing `FetchOutcome` union so
 * the same `resolveDatasetPageStatus` resolver works for both code paths.
 */
export interface BundleField<T> {
  ok: boolean;
  data: T | null;
}

/**
 * Shape of `GET https://data.nemar.org/<id>/page-bundle.json?v=<v>`
 * (nemar-cli#617). The endpoint accepts either an explicit `v=` or no
 * version (resolves to `landing.latest` internally) and returns landing +
 * metadata + summary + catalog row in a single 1-RTT response.
 *
 * `complete` is true when all four child fetches succeeded inside the
 * worker; `enrichment_degraded` flags a partial-but-renderable response.
 */
export interface DatasetPageBundle {
  dataset_id: string;
  version: string;
  served_at: string;
  complete: boolean;
  enrichment_degraded: boolean;
  landing: BundleField<LandingPayload>;
  metadata: BundleField<NeuroschemaDataset>;
  summary: BundleField<Summary>;
  catalog_row: BundleField<Dataset>;
}

/**
 * Fetch the unified dataset page bundle. `v` may be null to let the upstream
 * resolve to `landing.latest`. 4 s timeout (tighter than the 5 s default on
 * the fan-out helpers) so a slow bundle falls back fast rather than
 * bottlenecking the page when the upstream is degraded.
 */
export async function getDatasetPageBundleOutcome(
  datasetId: string,
  v: string | null,
  init: DataApiInit = {},
): Promise<FetchOutcome<DatasetPageBundle>> {
  return jsonFetch<DatasetPageBundle>(bundleUrl(datasetId, v, init), {
    ...init,
    timeoutMs: init.timeoutMs ?? 4_000,
  });
}

/**
 * Lift a bundle field into the `FetchOutcome` shape so the same
 * `resolveDatasetPageStatus` resolver works for both the bundle-served and
 * fan-out paths. The bundle's `ok: false` is lossy (no HTTP status) so we
 * map to `upstream_error` with a sentinel status; `ok: true` with `data:
 * null` is treated the same (the field exists in the envelope but the
 * payload didn't make it).
 */
export function bundleFieldToOutcome<T>(field: BundleField<T>): FetchOutcome<T> {
  if (field.ok && field.data !== null) return { kind: "ok", value: field.data };
  return { kind: "upstream_error", status: 0, statusText: "bundle field ok=false" };
}

// ============================================================================
// URL helpers (shared between the legacy + outcome variants)
// ============================================================================

function landingUrl(datasetId: string, init: DataApiInit): string {
  return `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/`;
}

function bundleUrl(datasetId: string, v: string | null, init: DataApiInit): string {
  const base = `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/page-bundle.json`;
  return v ? `${base}?v=${encodeURIComponent(v)}` : base;
}

function metadataUrl(datasetId: string, init: DataApiInit): string {
  return `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/metadata.json`;
}

function summaryUrl(datasetId: string, version: string, init: DataApiInit): string {
  return `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/${encodeURIComponent(
    version,
  )}/summary.json`;
}

function manifestUrl(datasetId: string, version: string, init: DataApiInit): string {
  return `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/${encodeURIComponent(
    version,
  )}/manifest.json`;
}

/**
 * Returns true when the landing payload indicates the dataset has no published
 * version yet.
 *
 * Returns false on null — a missing/unreachable dataset is distinct from an
 * unpublished one and we don't want to mask 404/5xx as "not yet published."
 *
 * Uses OR (either signal missing → unpublished) rather than AND because the
 * conservative call is to show "not yet published" briefly during a publish
 * race; the alternative (treating an inconsistent payload as published) lets
 * the caller fall through to the manifest path and surface the 5s-timeout-500
 * symptom we are specifically trying to fix.
 */
export function isUnpublished(landing: LandingPayload | null): boolean {
  if (!landing) return false;
  return !landing.latest || landing.versions.length === 0;
}

/**
 * Fetch the bytes behind a presigned manifest entry URL (used for README).
 * Returns null if absent or the fetch times out.
 */
export async function fetchManifestEntryText(
  url: string,
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = init.timeoutMs ?? 3_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[data-api] manifest entry ${url}: ${res.status} ${res.statusText}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`[data-api] manifest entry ${url}: ${(err as Error).message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Locate the README path in a summary. Priority:
 *   1. Explicit `summary.readme.path` (the publisher's authoritative pick,
 *      may point at a non-root README like `docs/README.md`)
 *   2. Root-level README in `summary.paths` matched case-insensitively
 *      against {readme.md, readme, readme.txt}. Subdirectory READMEs are
 *      intentionally NOT matched here — BIDS treats only the root one
 *      as the dataset README.
 */
export function findReadmePathInSummary(summary: Summary): string | null {
  if (summary.readme?.path) return summary.readme.path;
  const candidates = ["readme.md", "readme", "readme.txt"];
  for (const p of summary.paths) {
    if (candidates.includes(p.toLowerCase())) return p;
  }
  return null;
}

/**
 * Returns inline README markdown when summary.json (schema 1.1+) carries it
 * and the generator didn't mark it `truncated: true`. Schema 1.0 docs and
 * over-cap READMEs return null so the caller falls through to the GitHub /
 * manifest path. The string is the raw markdown source; callers must run it
 * through the same markdown renderer used for other README paths.
 */
export function findReadmeContentInSummary(summary: Summary): string | null {
  const r = summary.readme;
  if (!r) return null;
  if (r.truncated === true) return null;
  if (typeof r.content !== "string") return null;
  // Reject whitespace-only content: the markdown renderer turns it into
  // empty HTML, which (because `source` is then non-null) gets cached with
  // PUBLISHED_CACHE for the full SWR window instead of falling through to
  // Steps 1-4. Trim-check the existence, but return the original content
  // so leading whitespace inside otherwise-valid markdown is preserved.
  if (r.content.trim().length === 0) return null;
  return r.content;
}

/** Find the README entry in a manifest by case-insensitive name match. */
export function findReadmeEntry(manifest: Manifest): Manifest[number] | null {
  const candidates = ["readme.md", "readme", "readme.txt"];
  for (const entry of manifest) {
    const lower = entry.path.toLowerCase();
    if (candidates.includes(lower)) return entry;
  }
  return null;
}

/**
 * Best-effort fetch of the README from the dataset's GitHub repo, used when
 * the data.nemar.org manifest doesn't list one (git-annex manifests typically
 * carry annexed content only, not git-tracked files like README.md at root).
 * Races HEAD/main/master across README.md/README/README.txt/readme.md in
 * parallel; first 200 wins. Returns null on any failure. SSR-only — no CORS.
 */
export async function fetchGithubReadme(
  githubUrl: string,
  init: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const match = /github\.com\/([^/]+)\/([^/?#]+)/.exec(githubUrl);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");
  const branches = ["HEAD", "main", "master"];
  const filenames = ["README.md", "README", "README.txt", "readme.md"];

  const controller = new AbortController();
  const timeout = init.timeoutMs ?? 1_500;
  const timer = setTimeout(() => controller.abort(), timeout);
  const onParentAbort = () => controller.abort();
  if (init.signal) init.signal.addEventListener("abort", onParentAbort);

  const urls: string[] = [];
  for (const branch of branches) {
    for (const filename of filenames) {
      urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`);
    }
  }

  try {
    return await Promise.any(
      urls.map(async (url) => {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        return res.text();
      }),
    );
  } catch (err) {
    // AggregateError when all 12 candidate URLs fail; flatten its inner
    // errors so a GitHub outage or rename leaves a triageable tail-log
    // entry instead of a silent null.
    const detail =
      err instanceof AggregateError
        ? err.errors.map((e) => (e as Error).message).join(" | ")
        : ((err as Error).message ?? String(err));
    console.warn(`[data-api] github readme ${owner}/${repo}: ${detail}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (init.signal) init.signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Build a download URL for the dataset zip archive at a given version.
 *
 * The archives live at `s3://nemar/<id>/archives/<v>.zip`. The link points
 * at `<root>/<id>/<v>.zip`; data.nemar.org's worker resolves and signs the
 * S3 path on demand. If the worker route ever 404s, the UI surfaces the
 * upstream error rather than masking it.
 */
export function archiveZipUrl(datasetId: string, version: string, base?: string): string {
  const root = (base ?? dataBase()).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(datasetId)}/${encodeURIComponent(version)}.zip`;
}
