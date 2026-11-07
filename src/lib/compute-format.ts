/**
 * Pure formatters for the `/compute` page (website ADR 0030 phase E2 addendum).
 *
 * Money is whole thousandths of a service unit (milli-SU) end to end. Nothing here divides by 1000 as a
 * float, so the digits on the page are the digits `nemar compute balance` prints (`suFixed` there).
 * A helper that is handed something that is not an amount THROWS `RangeError`: a wrong figure must never
 * print as zero. The client guards (`./compute-api.ts`) reject such a body as a `shape` error first, and
 * the view models run inside each panel's own `try/catch`, so a throw costs that panel, not the page
 * (Astro drops a component whose render throws, so nothing in a template calls these directly).
 */

function assertAmount(milli: number): void {
  if (!Number.isSafeInteger(milli)) throw new RangeError("an amount is a whole number of milli-SU");
}

/** Whole milli-SU as SU with exactly three decimals: 12500 is `12.500`, -500 is `-0.500`. Integer math only. */
export function formatSu(milli: number): string {
  assertAmount(milli);
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const fraction = String(abs % 1000).padStart(3, "0");
  return `${milli < 0 ? "-" : ""}${whole}.${fraction}`;
}

/**
 * The shortest exact decimal of whole milli-SU, for axis ticks: 2500 is `2.5`, 10000 is `10`, -500 is
 * `-0.5`. Valid for a tick because every tick is an exact multiple of the step.
 */
export function formatSuShort(milli: number): string {
  assertAmount(milli);
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const fraction = String(abs % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return `${milli < 0 ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** The sum of whole amounts; throws when a value, or the running sum, leaves the safe integer range. */
export function sumMilli(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertAmount(value);
    total += value;
    if (!Number.isSafeInteger(total)) throw new RangeError("a sum of amounts left the safe range");
  }
  return total;
}

/** Whole seconds as `38s`, `4m 12s`, `1h 5m` (the CLI's `durationText`). `0` is `0s`, a real value. */
export function formatDuration(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError("a duration is a non-negative whole number of seconds");
  }
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const DB_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The backend's database time (`YYYY-MM-DD HH:MM:SS`, UTC, no zone marker) as epoch milliseconds, or
 * null when it is not that shape or not a real instant. Parsed field by field with `Date.UTC`: the bare
 * string is read as LOCAL time by some engines, which would move every time by the viewer's offset.
 */
export function parseDbTime(text: string): number | null {
  const m = DB_TIME_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  ) {
    return null;
  }
  return ms;
}

/** The ISO 8601 instant (`2026-11-05T12:00:00Z`) for a database time, or null when it does not parse. */
export function dbTimeToIso(text: string): string | null {
  const ms = parseDbTime(text);
  return ms === null ? null : `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * A database time as `YYYY-MM-DD HH:MM UTC`. A value that does not parse is returned as it came, so a
 * strange time shows as text instead of as a wrong time (the caller renders it as a text node).
 */
export function formatUtcMinute(text: string): string {
  const ms = parseDbTime(text);
  return ms === null ? text : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A database time as `YYYY-MM-DD HH:MM:SS UTC`, for a tooltip; the original text when it does not parse. */
export function formatUtcSecond(text: string): string {
  const ms = parseDbTime(text);
  return ms === null ? text : `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The epoch day (days since 1970-01-01) of a `YYYY-MM-DD` day, or null when it is not a real day. */
export function epochDay(day: string): number | null {
  const m = DAY_RE.exec(day);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms / 86_400_000;
}

/** The `YYYY-MM-DD` day for an epoch day. */
export function dayFromEpoch(epoch: number): string {
  return new Date(epoch * 86_400_000).toISOString().slice(0, 10);
}

/** `2026-11-03` as `Nov 3`, locale-free so the server and the browser agree; the input when it is not a day. */
export function formatDayShort(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m || epochDay(day) === null) return day;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/** A database time as `Oct 20, 2026` (the UTC date), locale-free; the original text when it does not parse. */
export function formatUtcDate(text: string): string {
  const ms = parseDbTime(text);
  if (ms === null) return text;
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
