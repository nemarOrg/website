/**
 * Labels, tones and icons for a compute job's state, and the words for its front door (website ADR 0030
 * phase E2 addendum). Built on `./admin-badges.ts`, whose lookups give a neutral raw-text pill for a
 * value this build has no entry for: the website and the API deploy independently, so a state the API
 * grows is a normal condition, not a bug. The raw word still goes through `displaySafeLine` so a strange
 * one cannot carry a control or direction character into the pill.
 *
 * Five tones are in use (neutral, info, success, danger, warning). Each has its own icon shape and the
 * word itself, so a state is never carried by color alone.
 */
import { type BadgeTone, badgeIcon, badgeLabel, badgeTone } from "./admin-badges";
import type { ComputeJobSource, ComputeJobState } from "./compute-contract";
import { displaySafeLine } from "./mail-display";
import type { IconName } from "./status-icons";

export const COMPUTE_STATE_LABELS: Readonly<Record<ComputeJobState, string>> = {
  created: "Created",
  uploading: "Uploading",
  submitted: "Submitted",
  queued: "Queued",
  running: "Running",
  archiving: "Archiving",
  finished: "Finished",
  failed: "Failed",
  cancelled: "Canceled",
  unreported: "Unreported",
};

export const COMPUTE_STATE_TONES: Readonly<Record<ComputeJobState, BadgeTone>> = {
  created: "neutral",
  uploading: "info",
  submitted: "info",
  queued: "info",
  running: "info",
  archiving: "info",
  finished: "success",
  failed: "danger",
  cancelled: "neutral",
  unreported: "warning",
};

export interface JobBadge {
  readonly label: string;
  readonly tone: BadgeTone;
  readonly icon: IconName;
  /** False for a state this build has no entry for: the pill then carries the raw word. */
  readonly known: boolean;
}

/** The pill for a job state; a neutral raw-text pill for a state this build does not know. */
export function jobBadge(state: string): JobBadge {
  const known = Object.hasOwn(COMPUTE_STATE_LABELS, state);
  const tone = badgeTone(state, COMPUTE_STATE_TONES);
  return {
    label: known ? badgeLabel(state, COMPUTE_STATE_LABELS) : displaySafeLine(badgeLabel(state, {})),
    tone,
    icon: badgeIcon(tone),
    known,
  };
}

export const COMPUTE_SOURCE_LABELS: Readonly<Record<ComputeJobSource, string>> = {
  cli: "Command line",
  web: "Website",
  partner: "Partner site",
  pipeline: "NEMAR pipeline",
};

/** The words for a front door; the escaped raw word for one this build does not know. */
export function sourceLabel(source: string): string {
  return Object.hasOwn(COMPUTE_SOURCE_LABELS, source)
    ? COMPUTE_SOURCE_LABELS[source as ComputeJobSource]
    : displaySafeLine(source);
}

/** Every tone the badges use, so a test can pin that each has its own icon. */
export const COMPUTE_BADGE_TONES_IN_USE: readonly BadgeTone[] = [
  ...new Set(Object.values(COMPUTE_STATE_TONES)),
];
