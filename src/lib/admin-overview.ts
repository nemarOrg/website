/**
 * Pure view model for the admin Overview (`/admin`): what needs attention,
 * each section's status, the headline cards, and the geometry of the small
 * charts. The page and its components only draw what this module decides,
 * so every decision is unit-tested; Astro frontmatter is outside the vitest
 * surface.
 *
 * The public observability dashboard deliberately states facts without a
 * verdict. This page is the operator's, so it carries one: metrics the
 * snapshot marks `warn` or `error` lead the page, and healthy sections stay
 * compact. Severity comes from the upstream; nothing here re-derives it. An
 * unknown severity string ranks with `info`, so a word this client has never
 * seen neither raises an alarm nor hides a row.
 */
import { ADMIN_TABS, adminMetricHref } from "./admin-tabs";
import {
  type Metric,
  type MetricBreakdownEntry,
  type MetricPoint,
  type MetricSection,
  type MetricSnapshot,
  formatExactCount,
  formatMetricValue,
  formatSiBytes,
} from "./observability";

export type StatusTone = "ok" | "warn" | "error";

const SEVERITY_RANK: Readonly<Record<string, number>> = { error: 3, warn: 2, ok: 1 };

/** error 3, warn 2, ok 1, anything else (info, unknown) 0. */
export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0;
}

/** The mark a metric row carries, or null for a plain count (info, unknown). */
export function toneForSeverity(severity: string): StatusTone | null {
  if (severity === "error" || severity === "warn" || severity === "ok") return severity;
  return null;
}

/** Words a screen reader hears before a marked row, since the mark is an icon. */
export const TONE_WORDS: Readonly<Record<StatusTone, string>> = {
  ok: "Normal",
  warn: "Warning",
  error: "Error",
};

// Plain names for section keys that only arrive as a key (a section error
// carries no label). Mirrors the dashboard's SECTION_LABELS.
const SECTION_LABELS: Readonly<Record<string, string>> = {
  datasets: "Datasets",
  sizes: "Dataset sizes",
  archive: "Archives",
  zarr: "Zarr conversion",
  imports: "OpenNeuro import",
  publication: "Publication",
  access: "Access",
  cf: "Edge traffic",
  users: "Users",
  egress: "Storage egress",
  sync: "Sync",
};

function readableId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unnamed";
}

/** A section's display name: its own label when the snapshot has it, else a plain name for the key. */
export function sectionLabel(key: string, snapshot?: MetricSnapshot | null): string {
  const section = snapshot?.sections.find((s) => s.key === key);
  if (section) return section.label;
  return Object.hasOwn(SECTION_LABELS, key) ? SECTION_LABELS[key] : readableId(key);
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  "nemar-cli": "the NEMAR database",
  access: "NEMAR access logs",
  cloudflare: "Cloudflare edge analytics",
  "aws-s3-cloudwatch": "S3 CloudWatch metrics",
  umami: "website analytics",
};

/** Where a section's numbers come from, in words. */
export function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : readableId(source);
}

/** In-page anchor id for a section card. */
export function sectionAnchor(key: string): string {
  return `section-${key.replace(/[^a-z0-9_-]/gi, "-")}`;
}

/** Percent of a total to one decimal, or null when there is no total to be a share of. */
export function percentOf(value: number, total: number | undefined): number | null {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(value)) return null;
  return Math.round((value / total) * 1000) / 10;
}

/** "1.2% of 668", or null for a metric with no total. */
export function shareText(metric: Metric): string | null {
  const pct = percentOf(metric.value, metric.total);
  if (pct === null || metric.total === undefined) return null;
  return `${pct}% of ${formatMetricValue({ ...metric, value: metric.total })}`;
}

function plural(count: number, one: string, many: string): string {
  return `${formatExactCount(count)} ${count === 1 ? one : many}`;
}

// ---------- section status ----------

export interface SectionStatus {
  readonly tone: StatusTone;
  readonly errors: number;
  readonly warnings: number;
  /** Badge text: "1 error, 1 warning", "2 warnings", or "OK". */
  readonly text: string;
}

export function sectionStatus(section: MetricSection): SectionStatus {
  const errors = section.metrics.filter((m) => m.severity === "error").length;
  const warnings = section.metrics.filter((m) => m.severity === "warn").length;
  const tone: StatusTone = errors > 0 ? "error" : warnings > 0 ? "warn" : "ok";
  const parts = [
    errors > 0 ? plural(errors, "error", "errors") : "",
    warnings > 0 ? plural(warnings, "warning", "warnings") : "",
  ].filter(Boolean);
  return { tone, errors, warnings, text: parts.length > 0 ? parts.join(", ") : "OK" };
}

/** The catalog sections: what NEMAR holds rather than a pipeline's state. */
export const CATALOG_SECTION_KEYS: readonly string[] = ["datasets", "sizes"];

export interface ArrangedSections {
  /** Sections with a warn or error metric, errors first, snapshot order within a tone. */
  readonly problems: readonly MetricSection[];
  /** Operational sections with nothing at warn or error. */
  readonly healthy: readonly MetricSection[];
  readonly catalog: readonly MetricSection[];
}

export function arrangeSections(snapshot: MetricSnapshot): ArrangedSections {
  const catalog = snapshot.sections.filter((s) => CATALOG_SECTION_KEYS.includes(s.key));
  const operational = snapshot.sections.filter((s) => !CATALOG_SECTION_KEYS.includes(s.key));
  const rank = (s: MetricSection) => severityRank(sectionStatus(s).tone);
  const problems = operational
    .filter((s) => sectionStatus(s).tone !== "ok")
    // Array.prototype.sort is stable, so snapshot order holds within a tone.
    .sort((a, b) => rank(b) - rank(a));
  const healthy = operational.filter((s) => sectionStatus(s).tone === "ok");
  return { problems, healthy, catalog };
}

/**
 * The metric a coverage ring shows: the first one the snapshot calls `ok`
 * that is a count out of a total ("With archive, 660 of 668"). The same rule
 * the dashboard's pipeline cards use, so both rings show the same number.
 */
export function coverageMetric(section: MetricSection): { metric: Metric; percent: number } | null {
  for (const metric of section.metrics) {
    if (metric.severity !== "ok" || metric.unit === "bytes" || metric.unit === "percent") continue;
    const percent = percentOf(metric.value, metric.total);
    if (percent !== null) return { metric, percent: Math.min(100, Math.max(0, percent)) };
  }
  return null;
}

export interface SectionParts {
  readonly coverage: { metric: Metric; percent: number } | null;
  /** Scalar rows, coverage metric excluded. */
  readonly rows: readonly Metric[];
  /** Metrics that carry a breakdown, drawn as bars or a ranked list. */
  readonly breakdowns: readonly Metric[];
}

export function sectionParts(section: MetricSection): SectionParts {
  const coverage = coverageMetric(section);
  const rest = section.metrics.filter((m) => m !== coverage?.metric);
  return {
    coverage,
    rows: rest.filter((m) => !m.breakdown || m.breakdown.length === 0),
    breakdowns: rest.filter((m) => m.breakdown && m.breakdown.length > 0),
  };
}

// ---------- portal links ----------

export interface PortalLink {
  readonly href: string;
  readonly label: string;
}

/**
 * Where an admin acts on a metric, or null when the portal has no list for it
 * yet. Delegates the routing to {@link adminMetricHref} (which refuses to
 * link an unshipped tab); this only names the destination.
 */
export function portalLinkFor(metricKey: string): PortalLink | null {
  const href = adminMetricHref(metricKey);
  if (!href) return null;
  const path = href.split("?")[0];
  const tab = ADMIN_TABS.find((t) => t.href === path);
  return { href, label: `Review in ${tab?.label ?? "the portal"}` };
}

/**
 * Sections whose metrics name a drill-down the portal cannot show yet
 * (archive and Zarr dataset lists, website#195). Said on the card so an admin
 * is not left hunting for a list that does not exist.
 */
export function hasUnlinkedDrilldown(section: MetricSection): boolean {
  return section.metrics.some((m) => m.drilldown !== undefined && portalLinkFor(m.key) === null);
}

// ---------- attention summary ----------

/** The snapshot is recomputed hourly; three missed runs is worth saying. */
export const STALE_AFTER_MINUTES = 180;

export interface AttentionItem {
  readonly kind: "metric" | "section_error" | "stale";
  readonly tone: "warn" | "error";
  readonly key: string;
  readonly label: string;
  readonly sectionKey: string;
  readonly sectionLabel: string;
  /** The metric's value as printed ("66", "8.6 TB"), empty for a non-metric item. */
  readonly value: string;
  /** "1.2% of 668", the section error text, or the staleness sentence. */
  readonly detail: string | null;
  /** A portal list when one exists; otherwise the section card on this page. */
  readonly link: PortalLink;
  readonly inPortal: boolean;
}

export interface AttentionSummary {
  readonly items: readonly AttentionItem[];
  readonly errorCount: number;
  readonly warnCount: number;
  /** Distinct sections with at least one item. */
  readonly sectionCount: number;
  readonly tone: StatusTone;
  /** Minutes since `generated_at`, or null when the timestamp is unreadable. */
  readonly ageMinutes: number | null;
  readonly stale: boolean;
}

export function snapshotAgeMinutes(snapshot: MetricSnapshot, now: Date): number | null {
  const at = Date.parse(snapshot.generated_at);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now.getTime() - at) / 60_000));
}

function ageText(minutes: number): string {
  if (minutes < 120) return plural(minutes, "minute", "minutes");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hour", "hours");
  return plural(Math.round(hours / 24), "day", "days");
}

export function deriveAttention(
  snapshot: MetricSnapshot,
  now: Date = new Date(),
): AttentionSummary {
  const items: AttentionItem[] = [];

  for (const error of snapshot.section_errors) {
    const label = sectionLabel(error.key, snapshot);
    items.push({
      kind: "section_error",
      tone: "error",
      key: error.key,
      label: `${label} did not compute`,
      sectionKey: error.key,
      sectionLabel: label,
      value: "",
      detail: error.error,
      link: { href: "#section-errors", label: "See the error" },
      inPortal: false,
    });
  }

  for (const section of snapshot.sections) {
    for (const metric of section.metrics) {
      if (metric.severity !== "error" && metric.severity !== "warn") continue;
      const portal = portalLinkFor(metric.key);
      items.push({
        kind: "metric",
        tone: metric.severity,
        key: metric.key,
        label: metric.label,
        sectionKey: section.key,
        sectionLabel: section.label,
        value: formatMetricValue(metric),
        detail: shareText(metric),
        link: portal ?? {
          href: `#${sectionAnchor(section.key)}`,
          label: `See ${section.label}`,
        },
        inPortal: portal !== null,
      });
    }
  }

  const ageMinutes = snapshotAgeMinutes(snapshot, now);
  const stale = ageMinutes !== null && ageMinutes > STALE_AFTER_MINUTES;
  if (stale && ageMinutes !== null) {
    items.push({
      kind: "stale",
      tone: "warn",
      key: "snapshot.stale",
      label: "Snapshot is out of date",
      sectionKey: "snapshot",
      sectionLabel: "Observability",
      value: "",
      detail: `Generated ${ageText(ageMinutes)} ago; it normally refreshes every hour, so every figure below may be behind.`,
      link: { href: "#snapshot-meta", label: "See snapshot time" },
      inPortal: false,
    });
  }

  // Errors first; insertion order (section errors, then snapshot order,
  // then staleness) holds within a tone because the sort is stable.
  items.sort((a, b) => severityRank(b.tone) - severityRank(a.tone));

  const errorCount = items.filter((i) => i.tone === "error").length;
  const warnCount = items.filter((i) => i.tone === "warn").length;
  return {
    items,
    errorCount,
    warnCount,
    sectionCount: new Set(items.map((i) => i.sectionKey)).size,
    tone: errorCount > 0 ? "error" : warnCount > 0 ? "warn" : "ok",
    ageMinutes,
    stale,
  };
}

// ---------- history: deltas and sparklines ----------

export type DeltaDirection = "up" | "down" | "flat" | "none";

export interface Delta {
  readonly direction: DeltaDirection;
  readonly text: string;
}

/**
 * Change from the first to the last point of a history window, worded like
 * the dashboard's ("+3 in 7 days", "No change in 7 days"). `noun` names what
 * moved when the card's headline is a different figure ("−109 missing in 7
 * days" under an archive coverage percentage). Null when there is no span.
 */
export function historyDelta(
  points: readonly MetricPoint[] | undefined,
  format: (value: number) => string,
  noun = "",
): Delta | null {
  if (!points || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const diff = last.value - first.value;
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(diff)) return null;
  const span =
    hours < 36
      ? ` in ${plural(Math.round(hours), "hour", "hours")}`
      : ` in ${plural(Math.round(hours / 24), "day", "days")}`;
  if (diff === 0) return { direction: "flat", text: `No change${span}` };
  const what = noun ? ` ${noun}` : "";
  return {
    direction: diff > 0 ? "up" : "down",
    // U+2212 MINUS SIGN, as the dashboard prints it.
    text: `${diff > 0 ? "+" : "−"}${format(Math.abs(diff))}${what}${span}`,
  };
}

export interface SparkGeometry {
  /** Path `d` for the line. */
  readonly line: string;
  /** Path `d` for the filled area under the line. */
  readonly area: string;
  /** The last point, where the dot goes. */
  readonly end: { readonly x: number; readonly y: number };
  readonly first: number;
  readonly last: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

/**
 * Line and area geometry for a compact sparkline in a `width` x `height`
 * box. The y domain hugs the data with a margin (the dashboard's compact
 * rule), and a floor of 1% of the value keeps a tiny wobble from reading as a
 * cliff. Null below two finite values: one point is not a trend.
 */
export function sparkGeometry(
  values: readonly number[],
  width: number,
  height: number,
  pad = 3,
): SparkGeometry | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const margin = Math.max((hi - lo) * 0.18, Math.abs(hi) * 0.01, 1e-9);
  const yMin = lo - margin;
  const yMax = hi + margin;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;
  const x = (i: number) => pad + (i / (finite.length - 1)) * plotW;
  const y = (v: number) => pad + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const round = (n: number) => Math.round(n * 100) / 100;
  const coords = finite.map((v, i) => [round(x(i)), round(y(v))] as const);
  const line = coords.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join(" ");
  const base = round(height - pad);
  const area = `M${coords[0][0]} ${base} ${coords.map(([px, py]) => `L${px} ${py}`).join(" ")} L${coords[coords.length - 1][0]} ${base} Z`;
  const [ex, ey] = coords[coords.length - 1];
  return {
    line,
    area,
    end: { x: ex, y: ey },
    first: finite[0],
    last: finite[finite.length - 1],
    min: lo,
    max: hi,
    count: finite.length,
  };
}

// ---------- KPI cards ----------

export interface KpiSpark {
  readonly label: string;
  readonly points: readonly MetricPoint[];
  readonly format: "count" | "bytes";
}

export interface KpiSpec {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Rendered dimmed: the figure is unknown, which is not zero. */
  readonly muted: boolean;
  readonly delta: Delta | null;
  readonly context: readonly string[];
  readonly spark: KpiSpark | null;
  /** Section card this figure summarizes. */
  readonly anchor: string | null;
}

export type HistoryMap = Readonly<
  Record<string, { readonly points: readonly MetricPoint[] } | null>
>;

/** The history keys the KPI cards read. The page fetches exactly these. */
export const KPI_HISTORY_KEYS = [
  "datasets.public",
  "datasets.bytes",
  "archive.missing",
  "zarr.failed",
] as const;

function metricIndex(snapshot: MetricSnapshot): Map<string, Metric> {
  const index = new Map<string, Metric>();
  for (const section of snapshot.sections) {
    for (const metric of section.metrics) index.set(metric.key, metric);
  }
  return index;
}

const UNKNOWN_CONTEXT = "Not in the latest snapshot. Unknown is not zero.";
const HISTORY_UNAVAILABLE: Delta = { direction: "none", text: "Recent change unavailable" };

function deltaFrom(
  history: HistoryMap,
  key: string,
  format: (v: number) => string,
  noun = "",
): Delta {
  return historyDelta(history[key]?.points, format, noun) ?? HISTORY_UNAVAILABLE;
}

function sparkFrom(
  history: HistoryMap,
  key: string,
  label: string,
  format: KpiSpark["format"],
): KpiSpark | null {
  const points = history[key]?.points;
  return points && points.length >= 2 ? { label, points, format } : null;
}

function unknownKpi(key: string, label: string): KpiSpec {
  return {
    key,
    label,
    value: "Unavailable",
    muted: true,
    delta: null,
    context: [UNKNOWN_CONTEXT],
    spark: null,
    anchor: null,
  };
}

/**
 * The four headline cards: catalog size, data volume, and the two coverage
 * figures an operator steers by (archives and Zarr). Each missing metric
 * renders as "Unavailable" rather than disappearing or reading as zero.
 */
export function kpiSpecs(snapshot: MetricSnapshot, history: HistoryMap): KpiSpec[] {
  const index = metricIndex(snapshot);
  const specs: KpiSpec[] = [];

  const pub = index.get("datasets.public");
  if (pub) {
    const priv = index.get("datasets.private");
    const doi = index.get("datasets.with_doi");
    const doiShare = doi ? percentOf(doi.value, doi.total) : null;
    specs.push({
      key: pub.key,
      label: "Public datasets",
      value: formatExactCount(pub.value),
      muted: false,
      delta: deltaFrom(history, "datasets.public", formatExactCount),
      context: [
        [
          priv ? `${formatExactCount(priv.value)} private` : "",
          doiShare !== null ? `${doiShare}% with a DOI` : "",
        ]
          .filter(Boolean)
          .join(", "),
      ].filter(Boolean),
      spark: sparkFrom(history, "datasets.public", "Public datasets", "count"),
      anchor: null,
    });
  } else {
    specs.push(unknownKpi("datasets.public", "Public datasets"));
  }

  const bytes = index.get("datasets.bytes");
  if (bytes) {
    specs.push({
      key: bytes.key,
      label: "Public data",
      value: formatSiBytes(bytes.value),
      muted: false,
      delta: deltaFrom(history, "datasets.bytes", formatSiBytes),
      context: [
        pub
          ? `Across ${plural(pub.value, "public dataset", "public datasets")}`
          : "Across public datasets",
      ],
      spark: sparkFrom(history, "datasets.bytes", "Public data", "bytes"),
      anchor: null,
    });
  } else {
    specs.push(unknownKpi("datasets.bytes", "Public data"));
  }

  const archive = index.get("archive.ready");
  const archivePct = archive ? percentOf(archive.value, archive.total) : null;
  if (archive && archivePct !== null && archive.total !== undefined) {
    const missing = index.get("archive.missing");
    const skipped = index.get("archive.skipped");
    specs.push({
      key: archive.key,
      label: "Archive coverage",
      value: `${archivePct}%`,
      muted: false,
      delta: deltaFrom(history, "archive.missing", formatExactCount, "missing"),
      context: [
        `${formatExactCount(archive.value)} of ${formatExactCount(archive.total)} eligible datasets`,
        [
          missing ? `${formatExactCount(missing.value)} missing` : "",
          skipped ? `${formatExactCount(skipped.value)} skipped as too large` : "",
        ]
          .filter(Boolean)
          .join(", "),
      ].filter(Boolean),
      spark: sparkFrom(history, "archive.missing", "Missing archives", "count"),
      anchor: sectionAnchor("archive"),
    });
  } else {
    specs.push(unknownKpi("archive.ready", "Archive coverage"));
  }

  const zarr = index.get("zarr.ready");
  const zarrPct = zarr ? percentOf(zarr.value, zarr.total) : null;
  if (zarr && zarrPct !== null && zarr.total !== undefined) {
    const failed = index.get("zarr.failed");
    const pending = index.get("zarr.pending");
    specs.push({
      key: zarr.key,
      label: "Zarr coverage",
      value: `${zarrPct}%`,
      muted: false,
      delta: deltaFrom(history, "zarr.failed", formatExactCount, "failed"),
      context: [
        `${formatExactCount(zarr.value)} of ${formatExactCount(zarr.total)} public datasets`,
        [
          failed ? `${formatExactCount(failed.value)} failed` : "",
          pending ? `${formatExactCount(pending.value)} processing` : "",
        ]
          .filter(Boolean)
          .join(", "),
      ].filter(Boolean),
      spark: sparkFrom(history, "zarr.failed", "Failed conversions", "count"),
      anchor: sectionAnchor("zarr"),
    });
  } else {
    specs.push(unknownKpi("zarr.ready", "Zarr coverage"));
  }

  return specs;
}

// ---------- breakdowns ----------

const MODALITY_NAMES: Readonly<Record<string, string>> = {
  eeg: "EEG",
  meg: "MEG",
  ieeg: "iEEG",
  anat: "Anatomical MRI",
  func: "Functional MRI",
  beh: "Behavioral",
  nirs: "fNIRS",
  fmap: "MRI field maps",
  emg: "EMG",
  dwi: "Diffusion MRI",
  motion: "Motion capture",
  perf: "Perfusion MRI",
  pet: "PET",
  micr: "Microscopy",
};

const LICENSE_NAMES: Readonly<Record<string, string>> = {
  public: "Public domain",
  attribution: "Attribution",
  sharealike: "Share-alike",
  noncommercial: "Noncommercial",
  noderiv: "No derivatives",
  unknown: "Not specified",
};

let regionNames: Intl.DisplayNames | null | undefined;

function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** A breakdown label in words: modality and license ids, country codes. */
export function breakdownLabel(metric: Metric, label: string): string {
  if (metric.key === "datasets.by_modality" && Object.hasOwn(MODALITY_NAMES, label)) {
    return MODALITY_NAMES[label];
  }
  if (metric.key === "datasets.by_license" && Object.hasOwn(LICENSE_NAMES, label)) {
    return LICENSE_NAMES[label];
  }
  if (metric.key === "cf.by_country") return countryName(label);
  return label;
}

/** Breakdowns whose labels are dataset ids, so each row links to the dataset page. */
const DATASET_LIST_KEYS: readonly string[] = ["access.top", "sizes.largest"];

export interface BreakdownRow {
  readonly label: string;
  readonly value: string;
  /** Bar length relative to the largest entry, 0 to 100. */
  readonly widthPct: number;
  /** "79%" of the whole, when the breakdown is a share of something. */
  readonly share: string | null;
  readonly href: string | null;
}

export interface BreakdownView {
  readonly style: "bars" | "ranked";
  readonly visible: readonly BreakdownRow[];
  readonly hidden: readonly BreakdownRow[];
}

function shareLabel(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * Rows for a breakdown. Bars are scaled to the largest entry. A ranked list
 * prints each value against the metric's total instead: a bar there would
 * restate the number, and one dominant entry would flatten the rest into
 * identical stubs. Dataset shares apply only when the breakdown counts the
 * same datasets as the tile (modality, license), as on the dashboard.
 */
export function breakdownView(metric: Metric, visibleCount = 6): BreakdownView {
  const entries: readonly MetricBreakdownEntry[] = metric.breakdown ?? [];
  const unit = metric.breakdown_unit ?? metric.unit;
  const format = unit === "bytes" ? formatSiBytes : formatExactCount;
  const ranked = metric.breakdown_style === "ranked" || metric.key === "access.top";
  const max = entries.reduce((m, e) => Math.max(m, e.value), 0) || 1;
  const datasetShare = metric.unit === "datasets" && unit === "datasets" ? metric.value : 0;
  const links = DATASET_LIST_KEYS.includes(metric.key);
  const rows = entries.map((e): BreakdownRow => {
    const pct = ranked
      ? metric.total
        ? percentOf(e.value, metric.total)
        : null
      : datasetShare
        ? percentOf(e.value, datasetShare)
        : null;
    return {
      label: breakdownLabel(metric, e.label),
      value: format(e.value),
      widthPct: e.value > 0 ? Math.max(1.5, (e.value / max) * 100) : 0,
      share: ranked ? (pct === null ? null : `${pct.toFixed(1)}%`) : shareLabel(pct),
      href: links ? `/dataset/${encodeURIComponent(e.label)}` : null,
    };
  });
  return {
    style: ranked ? "ranked" : "bars",
    visible: rows.slice(0, visibleCount),
    hidden: rows.slice(visibleCount),
  };
}

export interface HistogramBin {
  /** Tick label with the upstream's cutoff marker removed ("100 GB"). */
  readonly tick: string;
  /** "10 GB to 20 GB", "Under 1 MB", "10 TB and larger". */
  readonly range: string;
  readonly count: number;
  /** Column height relative to the tallest bin, 0 to 100. */
  readonly heightPct: number;
  /** At or above the archive size cutoff. */
  readonly pastCutoff: boolean;
}

/**
 * Bins for the size histogram. The upstream marks the archive cutoff bin by
 * suffixing its label ("100 GB ─ cutoff"); every bin from there up is too
 * large for a downloadable archive.
 */
export function histogramBins(metric: Metric): { bins: HistogramBin[]; cutoff: string | null } {
  const entries = metric.breakdown ?? [];
  const cutoffIndex = entries.findIndex((e) => /cutoff/i.test(e.label));
  const ticks = entries.map((e) =>
    e.label
      .replace(/\s*[^\w<>.\s]+\s*cutoff\s*$/i, "")
      .replace(/\s*cutoff\s*$/i, "")
      .trim(),
  );
  const max = entries.reduce((m, e) => Math.max(m, e.value), 0) || 1;
  const bins = entries.map((e, i): HistogramBin => {
    const low = ticks[i];
    const range = low.startsWith("<")
      ? `Under ${low.replace(/^<\s*/, "")}`
      : i === ticks.length - 1
        ? `${low} and larger`
        : `${low} to ${ticks[i + 1]}`;
    return {
      tick: low,
      range,
      count: e.value,
      heightPct: e.value > 0 ? Math.max(2, (e.value / max) * 100) : 0,
      pastCutoff: cutoffIndex >= 0 && i >= cutoffIndex,
    };
  });
  return { bins, cutoff: cutoffIndex >= 0 ? ticks[cutoffIndex] : null };
}
