/**
 * The public quality route's paths, words and bounds: a hand copy of nemar-cli's
 * `shared/contract/quality-route.ts` (nemar-cli ADR 0137 decisions 6 and 7, epic #2324 phase B2),
 * the part a dataset page reads. `test/quality-route-contract-drift.test.ts` holds it to nemar-cli
 * `dev`, value for value and, for the functions, answer for answer on the same inputs.
 *
 *   GET <data plane>/<id>/quality/v1/<recipe>/record/<recording path>
 *   GET <data plane>/<id>/quality/v1/<recipe>/file/<derivative key>/<sha256>/<recording path>
 *
 * Public answers are `Cache-Control: public, max-age=300` with an `ETag` (the SHA-256 of the body);
 * every refusal is `{ "error": <word> }` and `no-store`. The admin mount (phase W9) is not copied
 * here. Import-free, so the panel and the idle preload carry only this.
 */

export const QUALITY_ROUTE_SEGMENT = "quality";
export const QUALITY_ROUTE_VERSION = "v1";
export const QUALITY_RECORD_SEGMENT = "record";
export const QUALITY_FILE_SEGMENT = "file";
export const QUALITY_RECORD_FORMAT = "nemar.quality-record.v1";
export const QUALITY_RECORD_MAX_BYTES = 512 * 1024;
export const QUALITY_FILE_MAX_BYTES = 4_194_304;
export const QUALITY_RECORDING_PATH_MAX = 1024;
export const QUALITY_PUBLIC_MAX_AGE = 300;

/** neuroschema 0.6.0's `relativeLocation`, the same text as nemar-cli's (escapes and all). */
export const QUALITY_RELATIVE_LOCATION_SOURCE = String.raw`^(?! )(?![\s\S]* $)(?!/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!(?:[\s\S]*/)?\.\.?(?:/|$))(?![\s\S]*//)(?![\s\S]*/$)[^\\%?#\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+$(?!\n)`;

const RELATIVE_LOCATION_RE = new RegExp(QUALITY_RELATIVE_LOCATION_SOURCE, "u");

/** nemar-cli `shared/compute-naming.ts`: a recording's file name is `<stem>_eeg.<extension>`. */
const RECORDING_NAME_RE = /^(?<stem>[^/]+)_eeg\.(?<extension>[^/]+)$/;

/** Whether a path is one the quality routes take: a `relativeLocation` naming a recording. */
export function isQualityRecordingPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= QUALITY_RECORDING_PATH_MAX &&
    RELATIVE_LOCATION_RE.test(path) &&
    RECORDING_NAME_RE.test(path.slice(path.lastIndexOf("/") + 1))
  );
}

/** The route's words, each with its HTTP status. */
export const QUALITY_ROUTE_WORDS = Object.freeze({
  quality_not_found: 404,
  recording_path_invalid: 400,
  views_expired: 410,
  view_not_declared: 404,
  view_data_missing: 404,
  view_data_corrupt: 502,
  record_unreadable: 502,
});

export type QualityRouteWord = keyof typeof QUALITY_ROUTE_WORDS;

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** The record endpoint's path for a recording, under a data-plane origin. */
export function qualityRecordPath(datasetId: string, recipe: string, recording: string): string {
  return `/${datasetId}/${QUALITY_ROUTE_SEGMENT}/${QUALITY_ROUTE_VERSION}/${recipe}/${QUALITY_RECORD_SEGMENT}/${encodePath(recording)}`;
}

/** The file endpoint's path for one declared file of a recording. */
export function qualityFilePath(
  datasetId: string,
  recipe: string,
  key: string,
  sha256: string,
  recording: string,
): string {
  return `/${datasetId}/${QUALITY_ROUTE_SEGMENT}/${QUALITY_ROUTE_VERSION}/${recipe}/${QUALITY_FILE_SEGMENT}/${key}/${sha256}/${encodePath(recording)}`;
}
