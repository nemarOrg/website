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

const RELATIVE_RANGES: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, "second"],
  [60 * 60, "minute"],
  [60 * 60 * 24, "hour"],
  [60 * 60 * 24 * 30, "day"],
  [60 * 60 * 24 * 365, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

/**
 * Relative time vs. now ("3 days ago", "in 2 hours"). Accepts ISO string
 * or a Date.
 */
export function formatRelativeTime(value: string | Date, now: Date = new Date()): string {
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
 * Absolute date display ("2025-10-09" -> "Oct 9, 2025").
 */
export function formatDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}
