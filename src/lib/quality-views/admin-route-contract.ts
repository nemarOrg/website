/**
 * The admin mount of the quality route: a hand copy of the admin part of nemar-cli's
 * `shared/contract/quality-route.ts` (nemar-cli ADR 0137 decision 7, epic #2324 phase B3b; website
 * phase W9, #588), the part the run drill-down and its same-origin proxy need.
 * `test/quality-route-contract-drift.test.ts` holds it to nemar-cli, value for value and, for the
 * functions, answer for answer on the same inputs (the reviewer's dot-segment and encoding cases of
 * nemar-cli #2390 among them).
 *
 *   GET /admin/compute/pipeline/runs/<stamp>/quality/record/<recording path>
 *   GET /admin/compute/pipeline/runs/<stamp>/quality/file/<sha256>/<recording path>
 *
 * The run's own derivative (canary, catalog or published, superseded included) while it is stored
 * and in date, for an administrator only: every answer is `no-store`, with no `Cache-Tag` and no
 * `ETag`. Kept apart from `route-contract.ts`, the public mount, so a dataset page carries none of
 * this.
 *
 * THE PROXY'S OBLIGATIONS, copied from nemar-cli's docblock (the website's
 * `src/pages/admin/pipelines/runs/[stamp]/quality/[...rest].ts`, `admin-proxy.ts`). It must:
 *  1. take `rest` from the raw `url.pathname`, never from decoded route parameters, and refuse a
 *     request whose URL holds any `?`, a bare one included;
 *  2. build the upstream path with `qualityAdminForwardPath(stamp, rest)` and refuse when it is null;
 *  3. answer GET only;
 *  4. forward the caller's own session cookie or bearer key, never a service identity, so the
 *     backend checks the caller's own role on every request;
 *  5. set `Cache-Control: no-store` on every answer it gives, upstream 401, 403 and 429 included;
 *  6. stop at 4 MiB (`QUALITY_FILE_MAX_BYTES`) by counting the bytes it streams, not by trusting
 *     `Content-Length`;
 *  7. strip hop-by-hop headers and `Set-Cookie`, and pass through only `Content-Type`,
 *     `Content-Disposition` and `X-Content-Type-Options`.
 *
 * Import-free apart from the public mount's recording rule, which is the one rule both mounts use.
 */

import {
  QUALITY_FILE_SEGMENT,
  QUALITY_RECORD_SEGMENT,
  QUALITY_ROUTE_WORDS,
  isQualityRecordingPath,
} from "./route-contract";

/** nemar-cli `shared/contract/compute-stamp.ts`: a pipeline stamp id. */
export const COMPUTE_PIPELINE_STAMP_ID_RE = /^[1-9][0-9]{0,15}$/;

/** The admin mount's segment after `runs/<stamp>/`. */
export const QUALITY_ADMIN_SEGMENT = "quality";

/** The admin mount's words: the public route's, and where the run's derivative stands. */
export const QUALITY_ADMIN_ROUTE_WORDS = Object.freeze({
  ...QUALITY_ROUTE_WORDS,
  stamp_not_found: 404,
  derivative_not_keyed: 404,
  derivative_copying: 409,
  derivative_failed: 409,
  method_not_allowed: 405,
  quality_unavailable: 503,
});

export type QualityAdminRouteWord = keyof typeof QUALITY_ADMIN_ROUTE_WORDS;

/** One raw recording segment: unreserved characters, sub-delimiters, `:` `@`, and percent escapes. */
export const QUALITY_ADMIN_SEGMENT_RE = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})+$/;

/** Percent escapes a recording segment may never carry: `/`, `\`, `.` and the control characters. */
const FORBIDDEN_ESCAPE_RE = /%(?:2[Ff]|5[Cc]|2[Ee]|[01][0-9A-Fa-f]|7[Ff])/;

const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * The admin request a raw `rest` names, or null when it is outside the grammar, the decoded
 * recording held to `isQualityRecordingPath`.
 */
export function qualityAdminRest(
  rest: string,
):
  | { kind: "record"; recording: string }
  | { kind: "file"; sha256: string; recording: string }
  | null {
  const segments = rest.split("/");
  const kind = segments.shift();
  let sha256: string | undefined;
  if (kind === QUALITY_FILE_SEGMENT) {
    sha256 = segments.shift();
    if (sha256 === undefined || !HEX64_RE.test(sha256)) return null;
  } else if (kind !== QUALITY_RECORD_SEGMENT) {
    return null;
  }
  if (segments.length === 0) return null;
  const decoded: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === ".." || !QUALITY_ADMIN_SEGMENT_RE.test(segment)) return null;
    if (FORBIDDEN_ESCAPE_RE.test(segment)) return null;
    let part: string;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return null;
    }
    decoded.push(part);
  }
  const recording = decoded.join("/");
  if (!isQualityRecordingPath(recording)) return null;
  return sha256 === undefined ? { kind: "record", recording } : { kind: "file", sha256, recording };
}

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** The admin record path of a run's recording. */
export function qualityAdminRecordPath(stampId: number, recording: string): string {
  return `/admin/compute/pipeline/runs/${stampId}/${QUALITY_ADMIN_SEGMENT}/${QUALITY_RECORD_SEGMENT}/${encodePath(recording)}`;
}

/** The admin file path of one declared file of a run's recording. */
export function qualityAdminFilePath(stampId: number, sha256: string, recording: string): string {
  return `/admin/compute/pipeline/runs/${stampId}/${QUALITY_ADMIN_SEGMENT}/${QUALITY_FILE_SEGMENT}/${sha256}/${encodePath(recording)}`;
}

/**
 * The upstream path the proxy forwards to, or null when the stamp is not a stamp id or `rawRest`
 * is outside the grammar. Built from the two raw strings it validated, so what is forwarded is
 * exactly what was checked.
 */
export function qualityAdminForwardPath(stamp: string, rawRest: string): string | null {
  if (!COMPUTE_PIPELINE_STAMP_ID_RE.test(stamp) || !Number.isSafeInteger(Number(stamp)))
    return null;
  if (qualityAdminRest(rawRest) === null) return null;
  return `/admin/compute/pipeline/runs/${stamp}/${QUALITY_ADMIN_SEGMENT}/${rawRest}`;
}

// ── The site's own mount of the proxy ───────────────────────────────────

/** The site path the drill-down page lives at, and under which the proxy answers. */
export const SITE_RUN_PATH = "/admin/pipelines/runs";

/** The site's proxy path of a run's recording record (what the browser fetches). */
export function siteAdminRecordPath(stampId: number, recording: string): string {
  return `${SITE_RUN_PATH}/${stampId}/${QUALITY_ADMIN_SEGMENT}/${QUALITY_RECORD_SEGMENT}/${encodePath(recording)}`;
}

/** The site's proxy path of one declared file of a run's recording. */
export function siteAdminFilePath(stampId: number, sha256: string, recording: string): string {
  return `${SITE_RUN_PATH}/${stampId}/${QUALITY_ADMIN_SEGMENT}/${QUALITY_FILE_SEGMENT}/${sha256}/${encodePath(recording)}`;
}
