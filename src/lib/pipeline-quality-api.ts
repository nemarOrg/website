/**
 * Admin client for a run's quality (website phase W9, #588; nemar-cli ADR 0137 decision 7, epic
 * #2324 phase B3): `GET /admin/compute/pipeline/runs/<id>/quality?after=`, where the run's
 * derivative stands in one word and a page of the recordings that succeeded. READ ONLY.
 *
 * Transport and errors are the admin Compute client's (`computeFetch`). The guard is hand-written
 * for an OPEN contract, as `compute-pipeline-api.ts`'s are: an extra key is tolerated and every
 * word is a string, but a missing or wrongly typed required key is a shape error for the whole
 * answer. A recording path is text derived from a dataset: the page prints it as text and checks
 * it again (`isQualityRecordingPath`) before the browser asks the proxy for it.
 */

import {
  ComputeAdminApiError,
  type ComputeAdminInit,
  MALFORMED_SENTENCE,
  computeFetch,
} from "./compute-admin-api";

function fail(): never {
  throw new ComputeAdminApiError(200, undefined, MALFORMED_SENTENCE);
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : fail();
const str = (v: unknown): string => (typeof v === "string" ? v : fail());
const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) ? v : fail());
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const strOrNull = (v: unknown): string | null => (v === null ? null : str(v));
const intOrNull = (v: unknown): number | null => (v === null ? null : int(v));

export interface RunQualityDerivative {
  readonly key: string;
  readonly state: string;
  readonly retention: string;
  readonly failure: string | null;
  readonly created_at: string;
  readonly stored_at: string | null;
  readonly expires_at: string | null;
  readonly superseded_at: string | null;
  readonly serving_index: string | null;
}

export interface RunQuality {
  readonly stamp_id: number;
  readonly dataset_id: string;
  readonly version: string;
  readonly recipe: string;
  readonly recipe_version: string;
  readonly input: string;
  readonly stamp_state: string;
  /** Whether the dataset passes the public quality route's gate now. */
  readonly dataset_public: boolean;
  /** One of `COMPUTE_RUN_QUALITY_STATES`, or a word this build does not know. */
  readonly quality: string;
  readonly skip: string | null;
  readonly derivative: RunQualityDerivative | null;
  readonly recordings: {
    readonly state: string;
    readonly succeeded: number | null;
    readonly unlisted: number;
    readonly items: readonly { readonly path: string }[];
    readonly next_after: string | null;
  };
}

export function parseRunQuality(value: unknown): RunQuality {
  const d = dict(value);
  const der = d.derivative === null ? null : dict(d.derivative);
  const rec = dict(d.recordings);
  return {
    stamp_id: int(d.stamp_id),
    dataset_id: str(d.dataset_id),
    version: str(d.version),
    recipe: str(d.recipe),
    recipe_version: str(d.recipe_version),
    input: str(d.input),
    stamp_state: str(d.stamp_state),
    dataset_public: bool(d.dataset_public),
    quality: str(d.quality),
    skip: strOrNull(d.skip),
    derivative:
      der === null
        ? null
        : {
            key: str(der.key),
            state: str(der.state),
            retention: str(der.retention),
            failure: strOrNull(der.failure),
            created_at: str(der.created_at),
            stored_at: strOrNull(der.stored_at),
            expires_at: strOrNull(der.expires_at),
            superseded_at: strOrNull(der.superseded_at),
            serving_index: strOrNull(der.serving_index),
          },
    recordings: {
      state: str(rec.state),
      succeeded: intOrNull(rec.succeeded),
      unlisted: int(rec.unlisted),
      items: (Array.isArray(rec.items) ? rec.items : fail()).map((i) => ({
        path: str(dict(i).path),
      })),
      next_after: strOrNull(rec.next_after),
    },
  };
}

/** A run's quality; `after` is the last path of the page before, already checked by the page. */
export function getRunQuality(
  stampId: number,
  after: string | null,
  init: ComputeAdminInit = {},
): Promise<RunQuality> {
  const qs = after === null ? "" : `?${new URLSearchParams({ after })}`;
  return computeFetch("GET", `/pipeline/runs/${stampId}/quality${qs}`, init, parseRunQuality);
}
