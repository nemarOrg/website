/**
 * Small formatting helpers used across the site. Kept dependency-free
 * because Cloudflare Workers + Astro SSR want a tiny bundle.
 */

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Human-readable byte size. SI-ish (1024 base) to match the legacy
 * file_size_formatted output ("1.2 GB").
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const i = Math.min(SIZE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  const precision = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${SIZE_UNITS[i]}`;
}

/**
 * Compact count for hero stats: 1234 -> "1,234"; 1_234_567 -> "1.2M".
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/**
 * Recording channel count with the electrode system (montage) appended when
 * known, for the dataset card + detail rail: `formatChannels(30, "10-10")`
 * -> `"30 (10-10)"`, `formatChannels(30, null)` -> `"30"`. Returns null when
 * there's no positive count, so callers can do
 * `const c = formatChannels(...); if (c) ...`. What populates
 * `n_channels`/`electrode_system` (EEG-derived today) is documented on
 * `Dataset` in `types.ts`.
 */
export function formatChannels(
  nChannels: number | null | undefined,
  electrodeSystem: string | null | undefined,
): string | null {
  if (typeof nChannels !== "number" || !Number.isFinite(nChannels) || nChannels <= 0) {
    return null;
  }
  return electrodeSystem ? `${nChannels} (${electrodeSystem})` : String(nChannels);
}

/**
 * Split a comma-separated modalities string from the API into a clean
 * uppercase list. Filters out empty entries and dedupes.
 */
export function splitModalities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(",")) {
    const code = part.trim().toUpperCase();
    if (!code) continue;
    // Preserve common BIDS casing.
    const normalized =
      code === "IEEG" ? "iEEG" : code === "ECOG" ? "ECoG" : code === "FMRI" ? "fMRI" : code;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

// Comma-split assumes the catalog ships names in display order ("First Last");
// a "Last, First" value would mis-split into two authors.
export function formatAuthorByline(raw: string | null | undefined): string {
  if (!raw) return "";
  const names = raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names[0]} et al.`;
}

/**
 * Sanitize a search `snippet()` for safe rendering with `set:html`. The
 * backend wraps lexical matches in `<mark>…</mark>`, but the surrounding text
 * is raw README/metadata content that may contain HTML-special characters.
 * We escape everything, then restore ONLY the `<mark>` highlight tags, so no
 * other markup (including any `<mark>` attributes) can ride through. Returns
 * "" for nullish input.
 */
export function safeSnippet(raw: string | null | undefined): string {
  if (!raw) return "";
  const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/&lt;mark&gt;/g, "<mark>").replace(/&lt;\/mark&gt;/g, "</mark>");
}

const RELATIVE_RANGES: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60 * 60, "minute"],
  [60 * 60 * 24, "hour"],
  [60 * 60 * 24 * 30, "day"],
  [60 * 60 * 24 * 365, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

/**
 * Relative time vs. now ("3 days ago", "in 2 hours"). Accepts ISO string,
 * Date, or nullish. Catalog-only rows (ds*) ship with `updated_at: null`,
 * so the null branch is hit often; returning "" lets the caller's
 * `if (updated) push(...)` cleanly skip the row.
 */
export function formatRelativeTime(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  if (value == null) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let prevDivisor = 1;
  for (const [boundary, unit] of RELATIVE_RANGES) {
    if (absSeconds < boundary) {
      const divisor = boundary === Number.POSITIVE_INFINITY ? prevDivisor : prevDivisor;
      return rtf.format(Math.round(diffSeconds / divisor), unit);
    }
    prevDivisor = boundary;
  }
  return rtf.format(0, "year");
}

/**
 * Absolute date display ("2025-10-09" -> "Oct 9, 2025"). Nullish input
 * returns empty string so callers can `if (formatDate(x)) ...` skip rows
 * cleanly. Catalog rows for ds* datasets ship with null timestamps.
 */
export function formatDate(value: string | Date | null | undefined): string {
  if (value == null) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Funding entries worth rendering, with their display name resolved.
 *
 * Drops entries with no usable funder name so the rail can never emit an
 * empty chip — the #204 symptom, where a wrong field name rendered two
 * blank `<span>`s on every nm000103 page rather than failing visibly.
 */
export function displayableFunding<T extends { funder_name?: string | null }>(
  entries: readonly T[] | null | undefined,
): Array<T & { funderName: string }> {
  if (!entries) return [];
  const out: Array<T & { funderName: string }> = [];
  for (const entry of entries) {
    const funderName = entry.funder_name?.trim();
    if (funderName) out.push({ ...entry, funderName });
  }
  return out;
}
