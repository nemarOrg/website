import type { LandingPayload, NeuroschemaDataset } from "./neuroschema";

const DEFAULT_DATA_BASE = "https://data.nemar.org";

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
  if (landingOut.kind === "not_found" && metadataOut.kind === "not_found") {
    return { kind: "not_found" };
  }
  if (landingOut.kind !== "ok" && landingOut.kind !== "not_found") {
    return { kind: "degraded", signal: "landing", outcome: landingOut.kind };
  }
  if (landingOut.kind === "not_found") {
    return { kind: "degraded", signal: "landing", outcome: "not_found" };
  }
  if (metadataOut.kind !== "ok" && metadataOut.kind !== "not_found") {
    return { kind: "degraded", signal: "metadata", outcome: metadataOut.kind };
  }
  return { kind: "ok" };
}

// ============================================================================
// Typed fetchers — landing + metadata only. After #76 these are the only two
// SSR fetches the dataset detail page makes against data.nemar.org; summary,
// manifest, page-bundle, and the partial-endpoint pipeline that consumed them
// all went away with the pivot to canonical sources (GitHub raw README,
// data.nemar.org/<id>/<v>/?format=json directory listings).
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

function landingUrl(datasetId: string, init: DataApiInit): string {
  return `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/`;
}

function metadataUrl(datasetId: string, init: DataApiInit): string {
  return `${dataBase(init.dataBase)}/${encodeURIComponent(datasetId)}/metadata.json`;
}

/**
 * Returns true when the landing payload indicates the dataset has no published
 * version yet.
 *
 * Returns false on null — a missing/unreachable dataset is distinct from an
 * unpublished one and we don't want to mask 404/5xx as "not yet published."
 */
export function isUnpublished(landing: LandingPayload | null): boolean {
  if (!landing) return false;
  return !landing.latest || landing.versions.length === 0;
}

/**
 * Build a download URL for the dataset zip archive at a given version.
 *
 * The archives live at `s3://nemar/<id>/archives/<v>.zip`. The link points
 * at `<root>/<id>/<v>.zip`; data.nemar.org's worker resolves and signs the
 * S3 path on demand.
 */
export function archiveZipUrl(datasetId: string, version: string, base?: string): string {
  const root = (base ?? dataBase()).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(datasetId)}/${encodeURIComponent(version)}.zip`;
}
