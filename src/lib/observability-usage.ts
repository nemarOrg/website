/**
 * Usage for the admin Overview's small "last 30 days" panel, read from the
 * public observability dashboard's range endpoints
 * (`/observability/api/timeseries` and `/audience`). Those endpoints send no
 * CORS headers, so this is server-side only: the Overview page fetches both
 * during SSR, with the same fail-soft, 5s-deadline contract as
 * `observability.ts`. Every failure resolves to `null`, and the panel then
 * says the figures are unavailable rather than showing zeros.
 *
 * The figures and their wording follow the public dashboard's KPI cards
 * (requests, data served, website sessions), so both surfaces say the same
 * thing about the same dates: unknown is not zero, requests are not people,
 * and storage egress is not completed downloads.
 */
import type { KpiSpec } from "./admin-overview";
import {
  DEFAULT_OBSERVABILITY_BASE,
  type MetricPoint,
  formatCompactCount,
  formatExactCount,
  formatSiBytes,
} from "./observability";
import { resolveSignal } from "./request-deadline";

export interface UsageRange {
  /** First UTC day, `YYYY-MM-DD`. */
  readonly start: string;
  /** Last UTC day, `YYYY-MM-DD`, inclusive. */
  readonly end: string;
}

export interface DailyPoint {
  readonly date: string;
  readonly value: number;
}

export interface DailySeries {
  readonly section: string;
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly points: readonly DailyPoint[];
}

export interface UsageTimeseries {
  readonly start: string;
  readonly end: string;
  readonly series: readonly DailySeries[];
}

export interface Coverage {
  readonly start: string;
  readonly end: string;
}

export interface AudienceSource {
  /** `available`, `partial`, `unconfigured`, `unavailable`, or a word this client has not seen. */
  readonly status: string;
  readonly coverage: Coverage | null;
}

export interface UsageAudience {
  readonly start: string;
  readonly end: string;
  readonly cloudflare: AudienceSource & { readonly requests: number | null };
  readonly umami: AudienceSource & { readonly visitors: number | null };
}

interface FetchInit {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDay(day: string, offset: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return isoDay(d);
}

/**
 * The public dashboard's default range: the 30 complete UTC days ending
 * yesterday, so no day in it is still in progress.
 */
export function last30DaysUtc(now: Date = new Date()): UsageRange {
  const end = shiftDay(isoDay(now), -1);
  return { start: shiftDay(end, -29), end };
}

function parseCoverage(raw: unknown): Coverage | null {
  if (!isRecord(raw)) return null;
  const { start, end } = raw;
  return typeof start === "string" && DAY.test(start) && typeof end === "string" && DAY.test(end)
    ? { start, end }
    : null;
}

/** Validates a `/timeseries` body; drops malformed series and points one by one. */
export function parseTimeseries(body: unknown): UsageTimeseries | null {
  if (!isRecord(body) || !Array.isArray(body.series)) return null;
  if (typeof body.start !== "string" || typeof body.end !== "string") return null;
  const series: DailySeries[] = [];
  for (const raw of body.series) {
    if (!isRecord(raw) || !Array.isArray(raw.points)) continue;
    const { section, key, label, unit } = raw;
    if (
      typeof section !== "string" ||
      typeof key !== "string" ||
      typeof label !== "string" ||
      typeof unit !== "string"
    ) {
      continue;
    }
    const points: DailyPoint[] = [];
    for (const p of raw.points) {
      if (!isRecord(p) || typeof p.date !== "string" || !DAY.test(p.date)) continue;
      const value = finiteOrNull(p.value);
      if (value !== null) points.push({ date: p.date, value });
    }
    series.push({ section, key, label, unit, points });
  }
  return { start: body.start, end: body.end, series };
}

function parseSource(raw: unknown): AudienceSource | null {
  if (!isRecord(raw) || typeof raw.status !== "string") return null;
  return { status: raw.status, coverage: parseCoverage(raw.coverage) };
}

/** Validates an `/audience` body. A source that is missing reads as unavailable, never as zero. */
export function parseAudience(body: unknown): UsageAudience | null {
  if (!isRecord(body) || typeof body.start !== "string" || typeof body.end !== "string") {
    return null;
  }
  const cf = isRecord(body.cloudflare) ? body.cloudflare : {};
  const um = isRecord(body.umami) ? body.umami : {};
  const unavailable: AudienceSource = { status: "unavailable", coverage: null };
  return {
    start: body.start,
    end: body.end,
    cloudflare: { ...(parseSource(cf) ?? unavailable), requests: finiteOrNull(cf.requests) },
    umami: { ...(parseSource(um) ?? unavailable), visitors: finiteOrNull(um.visitors) },
  };
}

async function getJson<T>(
  path: string,
  parse: (body: unknown) => T | null,
  init: FetchInit,
): Promise<T | null> {
  const fetchImpl = init.fetch ?? fetch;
  const base = (init.baseUrl ?? DEFAULT_OBSERVABILITY_BASE).replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      headers: { Accept: "application/json" },
      signal: resolveSignal(init),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return parse(await res.json());
  } catch {
    return null;
  }
}

function rangeQuery(range: UsageRange): string {
  return `start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`;
}

/** Daily usage series for a range. Never throws; any failure is `null`. */
export function fetchUsageTimeseries(
  range: UsageRange,
  init: FetchInit = {},
): Promise<UsageTimeseries | null> {
  return getJson(`/timeseries?${rangeQuery(range)}`, parseTimeseries, init);
}

/** Range totals from the network edge and website analytics. Never throws; any failure is `null`. */
export function fetchUsageAudience(
  range: UsageRange,
  init: FetchInit = {},
): Promise<UsageAudience | null> {
  return getJson(`/audience?${rangeQuery(range)}`, parseAudience, init);
}

// ---------- the three cards ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function longDay(day: string): string {
  return `${shortDay(day)}, ${new Date(`${day}T00:00:00Z`).getUTCFullYear()}`;
}

/** "Aug 29 to Sep 27, 2026", the dashboard's range wording. */
export function rangeText(range: UsageRange): string {
  if (range.start === range.end) return longDay(range.start);
  if (range.start.slice(0, 4) === range.end.slice(0, 4)) {
    return `${shortDay(range.start)} to ${longDay(range.end)}`;
  }
  return `${longDay(range.start)} to ${longDay(range.end)}`;
}

function rangeDays(range: UsageRange): number {
  return (
    Math.round(
      (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000,
    ) + 1
  );
}

const STATUS_WORDS: Readonly<Record<string, string>> = {
  available: "Measured",
  partial: "Partial coverage",
  unconfigured: "Not configured",
  unavailable: "Unavailable",
};

function statusWords(status: string): string {
  return Object.hasOwn(STATUS_WORDS, status) ? STATUS_WORDS[status] : "Unknown status";
}

function mutedKpi(key: string, label: string, value: string, context: string[]): KpiSpec {
  return { key, label, value, muted: true, delta: null, context, spark: null, anchor: null };
}

const LOAD_FAILED = "Could not load usage for these dates. Unknown is not zero.";

function coveredOnly(source: AudienceSource, range: UsageRange): string | null {
  const c = source.coverage;
  if (!c || (c.start === range.start && c.end === range.end)) return null;
  return `Measured ${rangeText(c)} only.`;
}

/**
 * The usage panel's cards for a range: network edge requests, data served
 * from storage, and anonymous website sessions. A source that did not load,
 * is not configured, or reported nothing for the range renders muted with
 * the reason, never as zero.
 */
export function usageKpis(
  range: UsageRange,
  timeseries: UsageTimeseries | null,
  audience: UsageAudience | null,
): KpiSpec[] {
  const specs: KpiSpec[] = [];

  // Requests at the network edge.
  if (!audience) {
    specs.push(mutedKpi("usage.requests", "Requests", "Unavailable", [LOAD_FAILED]));
  } else if (audience.cloudflare.requests === null) {
    specs.push(
      mutedKpi("usage.requests", "Requests", "Not measured", [
        `${statusWords(audience.cloudflare.status)}. Unknown is not zero.`,
      ]),
    );
  } else {
    const partial = coveredOnly(audience.cloudflare, range);
    specs.push({
      key: "usage.requests",
      label: "Requests",
      value: formatCompactCount(audience.cloudflare.requests),
      muted: false,
      delta: null,
      context: [
        partial ?? "Network edge requests for every day in the range.",
        "Includes automated traffic; not a count of people.",
      ],
      spark: null,
      anchor: null,
    });
  }

  // Bytes served from storage (egress), summed over the reported days.
  const egress =
    timeseries?.series.find((s) => s.section.toLowerCase() === "egress" && s.unit === "bytes") ??
    null;
  if (!timeseries) {
    specs.push(mutedKpi("usage.served", "Data served", "Unavailable", [LOAD_FAILED]));
  } else if (!egress) {
    specs.push(
      mutedKpi("usage.served", "Data served", "Not measured", [
        "No storage egress series is reporting. Unknown is not zero.",
      ]),
    );
  } else {
    const inRange = egress.points
      .filter((p) => p.date >= range.start && p.date <= range.end)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const days = rangeDays(range);
    if (inRange.length === 0) {
      specs.push(
        mutedKpi("usage.served", "Data served", "Not measured", [
          "No days reported in these dates. Unknown is not zero.",
        ]),
      );
    } else {
      const total = inRange.reduce((sum, p) => sum + p.value, 0);
      const last = inRange[inRange.length - 1].date;
      const points: MetricPoint[] = inRange.map((p) => ({
        at: `${p.date}T00:00:00Z`,
        value: p.value,
      }));
      specs.push({
        key: "usage.served",
        label: "Data served",
        value: formatSiBytes(total),
        muted: false,
        delta: null,
        context: [
          inRange.length === days
            ? "Storage egress for every day in the range."
            : `${formatExactCount(inRange.length)} of ${formatExactCount(days)} days reported, through ${shortDay(last)}.`,
          "Includes internal processing; not completed downloads.",
        ],
        spark:
          points.length >= 2
            ? { label: "Data served", points, format: "bytes", cadence: "daily" }
            : null,
        anchor: null,
      });
    }
  }

  // Anonymous website sessions.
  if (!audience) {
    specs.push(mutedKpi("usage.sessions", "Website sessions", "Unavailable", [LOAD_FAILED]));
  } else if (audience.umami.visitors === null) {
    const why =
      audience.umami.status === "unconfigured"
        ? "Website analytics are not reporting yet."
        : audience.umami.status === "unavailable"
          ? "Website analytics are unavailable right now."
          : `${statusWords(audience.umami.status)}.`;
    specs.push(
      mutedKpi("usage.sessions", "Website sessions", "Not measured", [
        `${why} Unknown is not zero.`,
      ]),
    );
  } else {
    const partial = coveredOnly(audience.umami, range);
    specs.push({
      key: "usage.sessions",
      label: "Website sessions",
      value: formatCompactCount(audience.umami.visitors),
      muted: false,
      delta: null,
      context: [
        partial ?? "Anonymous unique sessions after consent.",
        "A session is not an identified person.",
      ],
      spark: null,
      anchor: null,
    });
  }

  return specs;
}
