/**
 * The search overview: what the browser sends to OSA's `POST /nemar/overview` and how it reads the
 * answer (board D2 of the NEMAR AI plan, website#518). Everything here is pure or takes `fetch`
 * from the global, so a unit test can drive it with real-shape fixtures and `Response` objects.
 * The contract is OSA's `docs/search-overview.md`.
 *
 * Four parts.
 *
 * 1. **The endpoint** ({@link resolveOverviewEndpoint}). `PUBLIC_OSA_OVERVIEW_URL`, inlined by Vite
 *    at build time like the other `PUBLIC_OSA_*` values (ADR 0032). Unset means the feature is
 *    off, with no toggle anywhere; a value that is not one of two exact URLs is refused.
 * 2. **The request** ({@link buildOverviewRequest}). The server renders it as a JSON data island on
 *    the Discover page, because that page is edge-cached for 30 minutes and cannot know who has AI
 *    Mode on; the browser posts it when the reader's preference is on. Every limit OSA enforces
 *    with a 422 is applied here first, so a long description or an odd id cuts a row down or drops
 *    it instead of failing the whole overview.
 * 3. **The call** ({@link requestOverview}): a POST with a timeout, and an error class whose
 *    `kind` the panel turns into words.
 * 4. **The answer** ({@link parseOverviewResponse}). A segment list, never markup: text segments
 *    stay plain text and `dataset_id` segments become links to `/dataset/<id>`. An answer that
 *    names an id the request did not carry is an error, not a link, whatever the server said.
 */

import type { FilterState } from "./filters";

/**
 * The only two URLs `PUBLIC_OSA_OVERVIEW_URL` may be: the dev worker (staging) and the production
 * worker, on the two hosts `OSA_API_HOSTS` in `src/middleware.ts` already allows in `connect-src`.
 * Anything else is refused because a fetch to a host the policy does not list is blocked in the
 * browser with no message. `edge.osc.earth` is the host OSA's docs show, and it is refused here
 * until a release adds it to the policy: its worker route is not deployed, and naming it would
 * ship a toggle whose every request fails. The two `*.workers.dev` hosts the policy still lists
 * for cached widget builds are refused too, as `OSA_API_ENDPOINTS` in `./osa-widget` refuses them.
 */
export const OVERVIEW_ENDPOINTS = [
  "https://develop-widget.osc.earth/osa/nemar/overview",
  "https://widget.osc.earth/osa/nemar/overview",
] as const;

export type OverviewEndpoint = (typeof OVERVIEW_ENDPOINTS)[number];

export type OverviewResolution =
  | { kind: "disabled" }
  | { kind: "enabled"; endpoint: OverviewEndpoint }
  | { kind: "misconfigured"; reason: string };

function envValue(): string | undefined {
  const env =
    typeof import.meta.env !== "undefined"
      ? (import.meta.env as unknown as Record<string, string | undefined>)
      : undefined;
  return env?.PUBLIC_OSA_OVERVIEW_URL;
}

/**
 * Decide from `PUBLIC_OSA_OVERVIEW_URL` (or `raw`, for tests) whether the overview is on. Unset
 * or blank is `disabled`, an expected state (production, a local build); a value that is not in
 * {@link OVERVIEW_ENDPOINTS} is `misconfigured` with the reason, and the page renders no toggle.
 */
export function resolveOverviewEndpoint(raw?: string | null): OverviewResolution {
  const value = (raw !== undefined ? (raw ?? "") : (envValue() ?? "")).trim();
  if (!value) return { kind: "disabled" };
  const known = OVERVIEW_ENDPOINTS.find((endpoint) => endpoint === value);
  if (known) return { kind: "enabled", endpoint: known };
  return {
    kind: "misconfigured",
    reason: `PUBLIC_OSA_OVERVIEW_URL is ${JSON.stringify(value)}, which is not one of ${OVERVIEW_ENDPOINTS.join(" or ")}: the site's connect-src names only those two hosts.`,
  };
}

/** The endpoint, or `null` when the overview is off or refused (a refusal is warned once per call). */
export function overviewEndpoint(raw?: string | null): OverviewEndpoint | null {
  const resolved = resolveOverviewEndpoint(raw);
  if (resolved.kind === "misconfigured") console.warn(`[osa-overview] ${resolved.reason}`);
  return resolved.kind === "enabled" ? resolved.endpoint : null;
}

/** The limits OSA enforces on the request (`docs/search-overview.md`). */
export const OVERVIEW_LIMITS = {
  queryMax: 300,
  filterKeysMax: 20,
  rowsMax: 10,
  idMax: 64,
  titleMax: 200,
  descriptionMax: 500,
} as const;

/** The shape OSA accepts for a row id. */
export const OVERVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type OverviewFilterValue = string | boolean | number | string[];

export interface OverviewRequestRow {
  id: string;
  title: string;
  description: string;
  modalities?: string;
}

export interface OverviewRequest {
  query: string;
  filters: Record<string, OverviewFilterValue>;
  total_count?: number;
  results: OverviewRequestRow[];
}

/** A result as the page has it, before the limits are applied. */
export interface OverviewSourceRow {
  id: string;
  title: string | null | undefined;
  description: string | null | undefined;
  /** A string, a list (joined with ", "), or nothing. */
  modalities?: string | readonly string[] | null;
}

/** Cuts to `max` characters as OSA counts them (Unicode code points, not UTF-16 units). */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Keeps string, boolean, integer and string-list values, at most 20 keys; drops the rest. */
export function sanitizeOverviewFilters(
  raw: Record<string, unknown>,
): Record<string, OverviewFilterValue> {
  const out: Record<string, OverviewFilterValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= OVERVIEW_LIMITS.filterKeysMax) break;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isInteger(value)) out[key] = value;
    else if (isStringList(value)) out[key] = [...value];
  }
  return out;
}

/** The reader's filters as the overview understands them; what the search ran with. */
export function overviewFilters(state: FilterState): Record<string, unknown> {
  return {
    modality: state.modalities.length > 0 ? [...state.modalities] : undefined,
    modality_op: state.modalities.length >= 2 && state.modalityOp === "AND" ? "AND" : undefined,
    license: state.licenseTiers.length > 0 ? [...state.licenseTiers] : undefined,
    format: state.fileFormat || undefined,
    participants_min: state.participants.min ?? undefined,
    participants_max: state.participants.max ?? undefined,
    has_hed: state.hasHed || undefined,
    // "Has viewer" sends the same predicate (`filterStateToAPIQuery`).
    has_zarr: state.hasZarr || state.hasViewer || undefined,
  };
}

function joinModalities(value: OverviewSourceRow["modalities"]): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === "string" ? value : value.join(", ");
  return text.trim() === "" ? undefined : text;
}

/**
 * The request for a search, or `null` when there is nothing to read: a blank query, or no row
 * with an acceptable id. Rows keep the search's ranking order; the first ten acceptable ones are
 * sent. `correctedQuery` replaces the query when the API searched other words (the results are
 * for those words). `totalCount` is the number of matches in all.
 */
export function buildOverviewRequest(input: {
  query: string;
  correctedQuery?: string | null;
  filters?: Record<string, unknown>;
  totalCount?: number | null;
  rows: readonly OverviewSourceRow[];
}): OverviewRequest | null {
  const corrected = (input.correctedQuery ?? "").trim();
  const query = clip((corrected || input.query).trim(), OVERVIEW_LIMITS.queryMax).trimEnd();
  if (!query) return null;

  const seen = new Set<string>();
  const results: OverviewRequestRow[] = [];
  for (const row of input.rows) {
    if (results.length >= OVERVIEW_LIMITS.rowsMax) break;
    const id = row.id;
    if (typeof id !== "string" || id.length > OVERVIEW_LIMITS.idMax) continue;
    if (!OVERVIEW_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const out: OverviewRequestRow = {
      id,
      title: clip((row.title ?? "").trim() || id, OVERVIEW_LIMITS.titleMax),
      description: clip(row.description ?? "", OVERVIEW_LIMITS.descriptionMax),
    };
    const modalities = joinModalities(row.modalities);
    if (modalities !== undefined) out.modalities = modalities;
    results.push(out);
  }
  if (results.length === 0) return null;

  const request: OverviewRequest = {
    query,
    filters: sanitizeOverviewFilters(input.filters ?? {}),
    results,
  };
  const total = input.totalCount;
  if (typeof total === "number" && Number.isInteger(total) && total >= 0) {
    request.total_count = total;
  }
  return request;
}

/** A card as Discover holds it: the hydrated dataset and the search snippet, when there is one. */
export interface OverviewCard {
  dataset: {
    /** The dataset's public id ("on002718"); `id` on a hydrated row is a database key. */
    dataset_id: string;
    name: string;
    description: string | null;
    modalities: string;
  };
  snippet?: string;
}

/** A snippet carries the search's `<mark>` highlights; the overview reads it as plain words. */
function snippetText(snippet: string | undefined): string {
  return (snippet ?? "").replace(/<[^>]*>/g, "");
}

/**
 * The request Discover embeds, or `null` when there is nothing to embed: no search ran, it
 * failed, the page is not the first (an overview reads the best matches), or no card is left. The
 * description is the dataset's own, falling back to the search snippet when it has none.
 */
export function overviewRequestForPage(input: {
  isSearch: boolean;
  failed: boolean;
  page: number;
  query: string;
  correctedQuery?: string | null;
  filters?: Record<string, unknown>;
  totalCount: number;
  cards: readonly OverviewCard[];
}): OverviewRequest | null {
  if (!input.isSearch || input.failed || input.page !== 1 || input.cards.length === 0) return null;
  return buildOverviewRequest({
    query: input.query,
    correctedQuery: input.correctedQuery,
    filters: input.filters,
    totalCount: input.totalCount,
    rows: input.cards.map(({ dataset, snippet }) => ({
      id: dataset.dataset_id,
      title: dataset.name,
      description: dataset.description?.trim() ? dataset.description : snippetText(snippet),
      modalities: dataset.modalities,
    })),
  });
}

// ---------------------------------------------------------------------------
// The call and the answer
// ---------------------------------------------------------------------------

export type OverviewErrorKind =
  | "forbidden" // 403: the origin is not allowed
  | "unavailable" // 404: the community has no quick model
  | "invalid" // 422: a field was out of bounds
  | "rate_limited" // 429
  | "server" // 500
  | "upstream" // 502: no overview could be written
  | "http" // any other status
  | "network"
  | "timeout"
  | "bad_response"; // a 200 that is not an overview of the request's results

export class OverviewError extends Error {
  constructor(
    readonly kind: OverviewErrorKind,
    readonly status?: number,
  ) {
    super(`overview failed: ${kind}${status === undefined ? "" : ` (${status})`}`);
    this.name = "OverviewError";
  }
}

const STATUS_KINDS: Record<number, OverviewErrorKind> = {
  403: "forbidden",
  404: "unavailable",
  422: "invalid",
  429: "rate_limited",
  500: "server",
  502: "upstream",
};

/** What the panel says for each failure. Only 429 asks the reader to wait. */
export function overviewErrorMessage(kind: OverviewErrorKind): string {
  switch (kind) {
    case "forbidden":
      return "The AI overview is not enabled for this site.";
    case "unavailable":
      return "The AI overview is not set up yet.";
    case "invalid":
      return "The AI overview could not read this search. Try other words.";
    case "rate_limited":
      return "Too many overviews were requested from this connection. Wait a few minutes, then try again.";
    case "server":
      return "The AI overview service hit an error. Try again in a moment.";
    case "upstream":
      return "No overview could be written this time. Try again in a moment.";
    case "network":
      return "Could not reach the AI overview service. Check your connection and try again.";
    case "timeout":
      return "The AI overview took too long. Try again.";
    case "bad_response":
      return "The AI overview came back in a form that cannot be shown. Try again.";
    default:
      return "The AI overview is unavailable right now. Try again in a moment.";
  }
}

export type OverviewSegment =
  | { kind: "text"; text: string }
  | { kind: "dataset"; id: string; href: string };

export interface OverviewPick {
  id: string;
  href: string;
  reason: string;
}

export interface OverviewAnswer {
  segments: OverviewSegment[];
  picks: OverviewPick[];
  citedIds: string[];
  shown: number | null;
  cached: boolean;
}

/** Where a dataset's page is. */
export function overviewDatasetHref(id: string): string {
  return `/dataset/${encodeURIComponent(id)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PICKS_MAX = 3;

/**
 * Reads a 200 body. Every id it names (in the summary, the picks and `cited_ids`) must be one of
 * `requestIds`: the server promises that, and a page that links whatever id it is handed would
 * not hold if the promise broke. Anything else that is off in shape is an error too, so the panel
 * shows the failure, never half an answer.
 */
export function parseOverviewResponse(body: unknown, requestIds: Iterable<string>): OverviewAnswer {
  const allowed = new Set(requestIds);
  const bad = () => new OverviewError("bad_response", 200);
  if (!isRecord(body) || !Array.isArray(body.summary) || body.summary.length === 0) throw bad();

  const segments: OverviewSegment[] = [];
  for (const raw of body.summary) {
    if (!isRecord(raw)) throw bad();
    if (typeof raw.dataset_id === "string") {
      if (!allowed.has(raw.dataset_id)) throw bad();
      segments.push({
        kind: "dataset",
        id: raw.dataset_id,
        href: overviewDatasetHref(raw.dataset_id),
      });
    } else if (typeof raw.text === "string") {
      segments.push({ kind: "text", text: raw.text });
    } else {
      throw bad();
    }
  }
  if (!segments.some((s) => s.kind === "text" && s.text.trim() !== "")) throw bad();

  const picks: OverviewPick[] = [];
  if (body.picks !== undefined) {
    if (!Array.isArray(body.picks)) throw bad();
    for (const raw of body.picks.slice(0, PICKS_MAX)) {
      if (!isRecord(raw) || typeof raw.id !== "string" || !allowed.has(raw.id)) throw bad();
      const reason = typeof raw.reason === "string" ? raw.reason : "";
      picks.push({ id: raw.id, href: overviewDatasetHref(raw.id), reason });
    }
  }

  const citedIds: string[] = [];
  if (body.cited_ids !== undefined) {
    if (!isStringList(body.cited_ids)) throw bad();
    for (const id of body.cited_ids) {
      if (!allowed.has(id)) throw bad();
      citedIds.push(id);
    }
  }

  return {
    segments,
    picks,
    citedIds,
    shown: typeof body.shown === "number" && Number.isInteger(body.shown) ? body.shown : null,
    cached: body.cached === true,
  };
}

/** The model writes the overview, which takes seconds; longer than this is a failure. */
export const OVERVIEW_TIMEOUT_MS = 30_000;

/** Aborts when any of `signals` does. `AbortSignal.any` where there is one, by hand otherwise. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * POSTs the request and returns the parsed answer, or throws an {@link OverviewError}. `signal`
 * lets the caller cancel (the reader turned AI Mode off, or searched again); that rejects with the
 * signal's own abort error, which is not a failure to show.
 */
export async function requestOverview(
  endpoint: string,
  request: OverviewRequest,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<OverviewAnswer> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? OVERVIEW_TIMEOUT_MS);
  const signal = options.signal ? anySignal([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new OverviewError(timeout.aborted ? "timeout" : "network");
  }
  if (!response.ok) {
    // The body of an error holds nothing the page shows; release it.
    void response.body?.cancel().catch(() => {});
    throw new OverviewError(STATUS_KINDS[response.status] ?? "http", response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new OverviewError(timeout.aborted ? "timeout" : "bad_response", response.status);
  }
  return parseOverviewResponse(
    body,
    request.results.map((row) => row.id),
  );
}
