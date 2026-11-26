/**
 * Pure view models of a run's quality (website phase W9, #588; nemar-cli ADR 0137 decision 7):
 * the run page's quality section and the drill-down page draw what these decide.
 * `test/pipeline-quality-view.test.ts` holds them.
 *
 * Two rules matter most here:
 *  - A PUBLIC LINK only for a `current` derivative of a dataset the backend calls public now
 *    (`dataset_public`, the public quality route's own gate: active, public, not concealed, first
 *    published, not withdrawn, not tombstoned). A concealed anonymous deposit (nemar-cli ADR 0065)
 *    fails that gate, so it never gets one, whatever its derivative's class.
 *  - A recording path is text derived from a dataset: it is offered only when it is a recording
 *    path the quality routes take (`isQualityRecordingPath`), and is put in a URL only encoded.
 */

import type { PipelineRunView } from "./compute-pipeline-api";
import { COMPUTE_DATASET_ID_RE, SERVING_INDEX_DEFERRED } from "./compute-pipeline-contract";
import { PIPELINE_LABELS } from "./compute-pipeline-labels";
import { d1Time, wordText } from "./compute-pipeline-view";
import { displaySafeLine } from "./mail-display";
import type { RunQuality } from "./pipeline-quality-api";
import {
  PIPELINE_QUALITY_LABELS as L,
  RECORDINGS_SENTENCES,
  RUN_QUALITY_SENTENCES,
} from "./pipeline-quality-labels";
import { isQualityRecordingPath } from "./quality-views/route-contract";

/** The sentence of a run-quality word, and whether this build knows it. */
export function runQualitySentence(word: string): { known: boolean; text: string } {
  const known = Object.hasOwn(RUN_QUALITY_SENTENCES, word);
  return known
    ? { known, text: RUN_QUALITY_SENTENCES[word] }
    : { known, text: `${L.unknownState}: ${wordText(word)}.` };
}

/** The sentence of a recordings word. */
export function recordingsSentence(word: string): string {
  return Object.hasOwn(RECORDINGS_SENTENCES, word)
    ? RECORDINGS_SENTENCES[word]
    : `${L.unknownState}: ${wordText(word)}.`;
}

/** The dataset's public page, or null: only a `current` derivative of a dataset public now. */
export function publicHref(q: Pick<RunQuality, "dataset_public" | "quality" | "dataset_id">) {
  if (!q.dataset_public || q.quality !== "current") return null;
  if (!COMPUTE_DATASET_ID_RE.test(q.dataset_id)) return null;
  return `/dataset/${q.dataset_id}`;
}

/** A deferred run (`serving_index_deferred`): when it goes ahead without the index, if served. */
export interface Deferral {
  /** `runs_without_index_after` when the answer carries it, else null. */
  readonly after: string | null;
  /** When this deferral's stamp was recorded (D1 time, UTC). */
  readonly recordedAt: string;
}

export function deferralOf(run: PipelineRunView | null | undefined): Deferral | null {
  if (!run || run.code !== SERVING_INDEX_DEFERRED) return null;
  return { after: run.runs_without_index_after, recordedAt: run.created_at };
}

/** The deferral's two sentences, as text. */
export function deferralText(d: Deferral): string {
  return d.after !== null
    ? `${L.deferredBody} ${L.deferredAfter} ${displaySafeLine(d.after)}.`
    : `${L.deferredBody} ${L.deferredUnknown} ${d1Time(d.recordedAt)}.`;
}

export interface RunQualityView {
  readonly word: string;
  readonly known: boolean;
  readonly sentence: string;
  /** The store's skip word or the derivative's failure word, said as a line, or null. */
  readonly detail: string | null;
  readonly facts: readonly (readonly [string, string])[];
  readonly notPublic: boolean;
  readonly publicHref: string | null;
}

/** What the quality section says about a run's derivative. */
export function runQualityView(q: RunQuality): RunQualityView {
  const { known, text } = runQualitySentence(q.quality);
  const der = q.derivative;
  const facts: [string, string][] = [[L.fieldState, wordText(q.quality)]];
  if (der) {
    facts.push([L.fieldRetention, wordText(der.retention)]);
    facts.push([L.fieldStored, d1Time(der.stored_at)]);
    if (der.expires_at !== null) {
      // An expired derivative says when it expired; any other with a date says when it will.
      facts.push([
        q.quality === "expired" ? L.fieldExpired : L.fieldExpires,
        d1Time(der.expires_at),
      ]);
    }
    facts.push([L.fieldKey, displaySafeLine(der.key.slice(0, 12))]);
    facts.push([
      L.fieldServingIndex,
      der.serving_index === null
        ? PIPELINE_LABELS.none
        : displaySafeLine(der.serving_index.slice(0, 12)),
    ]);
  }
  if (q.recordings.succeeded !== null) {
    facts.push([L.fieldSucceeded, String(q.recordings.succeeded)]);
  }
  let detail: string | null = null;
  if (q.skip !== null) {
    detail = q.skip === "duplicate_key" ? L.duplicateKey : `${L.skipLead}: ${wordText(q.skip)}.`;
  } else if (der?.failure) {
    detail = `${L.failureLead}: ${wordText(der.failure)}.`;
  }
  return {
    word: q.quality,
    known,
    sentence: text,
    detail,
    facts,
    notPublic: !q.dataset_public,
    publicHref: publicHref(q),
  };
}

/** The recordings of a page that the drill-down may draw: recording paths only, in order. */
export function drawableRecordings(q: RunQuality): string[] {
  return q.recordings.items.map((i) => i.path).filter(isQualityRecordingPath);
}

/** A `?recording=` or `?after=` value, or null when it is not a recording path. */
export function recordingParam(raw: string | null): string | null {
  return raw !== null && isQualityRecordingPath(raw) ? raw : null;
}

/** The recording to draw first: the one asked for when the page lists it, else the first. */
export function pickRecording(listed: readonly string[], asked: string | null): string | null {
  return asked !== null && listed.includes(asked) ? asked : (listed[0] ?? null);
}

/** The drill-down's link to the next page of recordings, or null. */
export function nextPageHref(stampId: number, q: RunQuality): string | null {
  const after = recordingParam(q.recordings.next_after);
  return after === null ? null : `${drillHref(stampId)}?${new URLSearchParams({ after })}`;
}

/** The drill-down page of a run. */
export function drillHref(stampId: number): string {
  return `/admin/pipelines/runs/${stampId}/quality`;
}

/**
 * A record's views, split: those drawn from stored data (no `inputs`), and the computed ones,
 * which read the dataset's signal (`inputs`, the registry's `nemar.ic-activity` and
 * `nemar.signal-window`) and are only listed here.
 */
export function splitViews<T extends Readonly<Record<string, unknown>>>(
  views: readonly T[],
): { stored: T[]; computed: T[] } {
  const stored: T[] = [];
  const computed: T[] = [];
  for (const view of views) (Object.hasOwn(view, "inputs") ? computed : stored).push(view);
  return { stored, computed };
}
