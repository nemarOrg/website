/**
 * Client for the observability Worker's public snapshot JSON
 * (`dashboard.nemar.org/observability/api/*`). This is a *different*
 * backend than `api.nemar.org` / `data.nemar.org` — it's unauthenticated
 * (no session cookie involved) and lives on the nemar-observability repo,
 * not nemar-cli. The `/observability/api/drilldown/:key` endpoint is
 * Bearer-only and out of reach from this site (our session cookie is
 * scoped to `app.nemar.org`); drill-down lists are a later phase via
 * nemar-cli `/admin/*`.
 *
 * Both fetchers fail soft: a dashboard.nemar.org outage should degrade the
 * admin Overview, not 500 it. Every error path (network failure, timeout,
 * non-2xx, unparseable body, malformed shape) resolves to `null` rather
 * than throwing. Parsing is defensive per-field: an individual malformed
 * metric is dropped rather than invalidating its whole section, and
 * unknown section keys / severities / units are passed through as-is so
 * the UI can render them sensibly instead of the upstream needing to
 * coordinate a frontend change first.
 */
import { formatBytes, formatCount } from "./format";
import { resolveSignal } from "./request-deadline";

/** Known severities observed today. Unknown strings still flow through —
 *  see `severity` on {@link Metric}. */
export type MetricSeverity = "info" | "ok" | "warn" | "error";

/** Known units observed today. Unknown strings still flow through — see
 *  `unit` on {@link Metric}. */
export type MetricUnit = "datasets" | "bytes" | "count";

export interface MetricBreakdownEntry {
  readonly label: string;
  readonly value: number;
}

export interface Metric {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: MetricUnit | string;
  readonly severity: MetricSeverity | string;
  readonly total?: number;
  readonly hint?: string;
  readonly breakdown?: readonly MetricBreakdownEntry[];
  /**
   * Unit of the `breakdown[].value` numbers when it differs from `unit`. A tile
   * can count datasets while its bars are denominated in bytes — `access.top`
   * and `cf.bytes_by_host` both do. Absent means the breakdown shares `unit`.
   */
  readonly breakdown_unit?: string;
  readonly drilldown?: string;
}

export interface MetricSection {
  readonly key: string;
  readonly label: string;
  readonly source: string;
  readonly updated_at: string;
  readonly metrics: readonly Metric[];
}

export interface MetricSectionError {
  readonly key: string;
  readonly error: string;
}

export interface MetricSnapshot {
  readonly schema_version: string;
  readonly generated_at: string;
  readonly sections: readonly MetricSection[];
  readonly section_errors: readonly MetricSectionError[];
}

export interface MetricPoint {
  readonly at: string;
  readonly value: number;
  readonly total?: number;
}

export interface MetricHistory {
  readonly metric: string;
  readonly points: readonly MetricPoint[];
}

export const DEFAULT_OBSERVABILITY_BASE = "https://dashboard.nemar.org/observability/api";

interface FetchInit {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly baseUrl?: string;
  /** Abort the request after this many ms. Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBreakdownEntry(raw: unknown): MetricBreakdownEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.label !== "string" || !isFiniteNumber(raw.value)) return null;
  return { label: raw.label, value: raw.value };
}

function parseMetric(raw: unknown): Metric | null {
  if (!isRecord(raw)) return null;
  const { key, label, value, unit, severity } = raw;
  if (
    typeof key !== "string" ||
    typeof label !== "string" ||
    !isFiniteNumber(value) ||
    typeof unit !== "string" ||
    typeof severity !== "string"
  ) {
    return null;
  }
  const metric: Metric = { key, label, value, unit, severity };
  const total = isFiniteNumber(raw.total) ? raw.total : undefined;
  const hint = typeof raw.hint === "string" ? raw.hint : undefined;
  const drilldown = typeof raw.drilldown === "string" ? raw.drilldown : undefined;
  const breakdown = Array.isArray(raw.breakdown)
    ? raw.breakdown.map(parseBreakdownEntry).filter((b): b is MetricBreakdownEntry => b !== null)
    : undefined;
  const breakdownUnit = typeof raw.breakdown_unit === "string" ? raw.breakdown_unit : undefined;
  return {
    ...metric,
    ...(total !== undefined && { total }),
    ...(hint !== undefined && { hint }),
    ...(breakdown !== undefined && breakdown.length > 0 && { breakdown }),
    ...(breakdownUnit !== undefined && { breakdown_unit: breakdownUnit }),
    ...(drilldown !== undefined && { drilldown }),
  };
}

function parseSection(raw: unknown): MetricSection | null {
  if (!isRecord(raw)) return null;
  const { key, label, source, updated_at } = raw;
  if (
    typeof key !== "string" ||
    typeof label !== "string" ||
    typeof source !== "string" ||
    typeof updated_at !== "string" ||
    !Array.isArray(raw.metrics)
  ) {
    return null;
  }
  const metrics = raw.metrics.map(parseMetric).filter((m): m is Metric => m !== null);
  return { key, label, source, updated_at, metrics };
}

function parseSectionError(raw: unknown): MetricSectionError | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.key !== "string" || typeof raw.error !== "string") return null;
  return { key: raw.key, error: raw.error };
}

function parseSnapshot(body: unknown): MetricSnapshot | null {
  if (!isRecord(body) || !Array.isArray(body.sections)) return null;
  const sections = body.sections.map(parseSection).filter((s): s is MetricSection => s !== null);
  const sectionErrors = Array.isArray(body.section_errors)
    ? body.section_errors.map(parseSectionError).filter((e): e is MetricSectionError => e !== null)
    : [];
  return {
    schema_version: typeof body.schema_version === "string" ? body.schema_version : "",
    generated_at: typeof body.generated_at === "string" ? body.generated_at : "",
    sections,
    section_errors: sectionErrors,
  };
}

function parsePoint(raw: unknown): MetricPoint | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.at !== "string" || !isFiniteNumber(raw.value)) return null;
  const total = isFiniteNumber(raw.total) ? raw.total : undefined;
  return { at: raw.at, value: raw.value, ...(total !== undefined && { total }) };
}

function parseHistory(body: unknown): MetricHistory | null {
  if (!isRecord(body) || typeof body.metric !== "string" || !Array.isArray(body.points)) {
    return null;
  }
  const points = body.points.map(parsePoint).filter((p): p is MetricPoint => p !== null);
  return { metric: body.metric, points };
}

/**
 * Fetches the current observability snapshot. Never throws: any failure
 * (network error, timeout/abort, non-2xx, unparseable or malformed body)
 * resolves to `null` so the Overview page can render a degraded state
 * instead of 500ing.
 */
export async function fetchObservabilitySnapshot(
  init: FetchInit = {},
): Promise<MetricSnapshot | null> {
  const fetchImpl = init.fetch ?? fetch;
  const base = (init.baseUrl ?? DEFAULT_OBSERVABILITY_BASE).replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchImpl(`${base}/snapshot`, {
      headers: { Accept: "application/json" },
      signal: resolveSignal(init),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return parseSnapshot(body);
}

/**
 * Fetches hourly history for a single metric key. Same fail-soft contract
 * as {@link fetchObservabilitySnapshot}.
 */
export async function fetchMetricHistory(
  metricKey: string,
  init: FetchInit = {},
): Promise<MetricHistory | null> {
  const fetchImpl = init.fetch ?? fetch;
  const base = (init.baseUrl ?? DEFAULT_OBSERVABILITY_BASE).replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchImpl(`${base}/snapshot/history?metric=${encodeURIComponent(metricKey)}`, {
      headers: { Accept: "application/json" },
      signal: resolveSignal(init),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return parseHistory(body);
}

/**
 * Renders a metric's value for display, dispatching on `unit`. Reuses the
 * shared formatters rather than reimplementing byte/count formatting here.
 */
export function formatMetricValue(metric: Metric): string {
  if (metric.unit === "bytes") return formatBytes(metric.value);
  return formatCount(metric.value);
}
