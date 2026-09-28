/**
 * Lookups behind the admin portal's status pills (user, import, and notice
 * badges). Each pill maps a value the backend sent onto a label, a tone, and
 * an icon. The website and the API deploy independently, so a value this
 * build has no entry for is a normal state of affairs, not a bug: production
 * still serves the legacy notice level `info`, and a new lifecycle status can
 * ship on the API first. Every lookup here therefore has a defined answer for
 * an unknown value (a neutral pill carrying the raw text) instead of the
 * `undefined` that used to reach `StatusIcon` and fail the whole render.
 */
import { type NoticeLevel, presentationLevel } from "./notices-api";
import type { IconName } from "./status-icons";

export type BadgeTone = "neutral" | "info" | "warning" | "success" | "danger";

/** The icon that says each tone in shape, so a pill never rests on its tint. */
export const BADGE_TONE_ICONS: Readonly<Record<BadgeTone, IconName>> = {
  neutral: "neutral",
  info: "progress",
  warning: "warn",
  success: "ok",
  danger: "error",
};

/**
 * The words for a status: this build's label when it has one, else the raw
 * value, so an admin still sees exactly what the backend sent.
 */
export function badgeLabel(status: string, labels: Readonly<Record<string, string>>): string {
  if (Object.hasOwn(labels, status)) return labels[status];
  return status.trim() || "Unknown";
}

/** The tone for a status, or neutral for one this build does not know. */
export function badgeTone<T extends BadgeTone>(
  status: string,
  tones: Readonly<Record<string, T>>,
): T | "neutral" {
  return Object.hasOwn(tones, status) ? tones[status] : "neutral";
}

/** The icon for a tone; neutral for anything else. */
export function badgeIcon(tone: string): IconName {
  return Object.hasOwn(BADGE_TONE_ICONS, tone) ? BADGE_TONE_ICONS[tone as BadgeTone] : "neutral";
}

/** A notice level's icon, so a level never rests on its tint alone. */
const NOTICE_LEVEL_ICONS: Readonly<Record<NoticeLevel, IconName>> = {
  critical: "error",
  warning: "warn",
  maintenance: "progress",
  announcement: "ok",
  tip: "info",
};

/**
 * How the admin notice list draws a level: the level it is rendered as (the
 * same mapping the public banner uses, so legacy `info` reads as `tip`) and
 * its icon. The raw value stays the pill's text.
 */
export function noticeLevelBadge(level: string): {
  readonly level: NoticeLevel;
  readonly icon: IconName;
} {
  const shown = presentationLevel(level);
  return { level: shown, icon: NOTICE_LEVEL_ICONS[shown] };
}
