/**
 * The quality panel's sentences (website phase W6): for a record it cannot show, a view or preset
 * word it adds to the renderers' own (`render/words.ts`), and a signal window's states and notes.
 * A chunk of its own, loaded the first time the panel has something to say, so the first screen of
 * a recording that draws carries none of it.
 */

import { MAP_SENTENCES, VIEW_SENTENCES } from "./render/words";

// ── Words ───────────────────────────────────────────────────────────────

/** The panel's sentences for a record it cannot show, and for a view or preset word it adds to the
 *  renderers' own (`render/words.ts`). Digest words claim no more than a match with what NEMAR
 *  recorded (nemar-cli ADR 0137 decision 6). */
export const PANEL_SENTENCES: Readonly<Record<string, string>> = {
  none: "No quality views are published for this recording.",
  unavailable: "Quality views are not available on this server yet.",
  no_recordings: "This dataset has no recording a quality view can be drawn for.",
  no_index: "The recording list could not be loaded, so no quality view is drawn.",
  network: "The quality views could not be reached. Try again later.",
  record_digest_mismatch:
    "The recording's quality record does not match the digest it was sent with, so nothing is drawn.",
  record_invalid: "The recording's quality record could not be read, so nothing is drawn.",
  record_elsewhere: "The quality record sent is not this recording's, so nothing is drawn.",
  record_checks_failed:
    "The recording's quality record credits a view or a metric to the wrong producer, so nothing is drawn.",
  record_too_large: "The recording's quality record is larger than the panel reads.",
  record_unreadable: "The server could not read this recording's quality record.",
  views_expired: "This recording's quality views have expired.",
  view_digest_mismatch:
    "This view's declaration does not match the digest NEMAR recorded, so it is not drawn.",
  components_mismatch:
    "The components table does not name the maps' components in order, so the maps are drawn without their rows.",
  content_invalid: "The class summary does not have the content its kind declares.",
  variance_length: "The class summary does not give one summed variance per class.",
  components_total: "The class counts do not add up to the number of components.",
  no_view: "This tab has no view for this recording.",
  matches: "The serving copy matches the digest NEMAR recorded.",
  not_checked: "The serving copy was not checked against a digest NEMAR recorded.",
  no_bad_segment_table: "No bad-segment table was written, so nothing is marked as a bad segment.",
  table_location_mismatch:
    "A table of the floor's decisions is not this recording's, so the window is not opened.",
  store_digest_mismatch:
    "The serving copy does not match the digest NEMAR recorded, so the window is not opened.",
  rate_invalid: "The recording's sampling rate cannot be read, so the window is not opened.",
  channel_status_unknown:
    "A channel's status in the floor's table is not good, bad or n/a, so the window is not opened.",
  duration_not_positive:
    "A bad segment in the floor's table has no length, so the window is not opened.",
  bad_channel_unknown:
    "A channel the floor marked bad is not in the recording, so the window is not opened.",
  channel_row_missing:
    "A channel of the recording has no row in the floor's table, so the window is not opened.",
  window_outside: "The window holds no sample of the recording, so it is not opened.",
  group_missing: "The recording has no channel group the view names, so the window is not opened.",
  no_viewer: "This page has no signal viewer to open the window in.",
  signal_recording_mismatch:
    "The window's store is not this recording's, so the window is not opened.",
  record_digest_missing:
    "The recording's quality record came without the digest it is checked against, so nothing is drawn.",
  recording_path_invalid: "The server did not take this recording's path, so nothing is drawn.",
  view_not_declared: "The server did not recognize a file of this recording's views.",
  view_data_missing: "A file of this recording's views is missing on the server.",
  view_data_corrupt: "The server found a file of this recording's views damaged.",
  failed: "The quality views could not be drawn. Try again later.",
  // Why a run wrote no view for a recording (neuroschema docs/views.md and nemar-process's own).
  labels_unusable: "the recording's channel labels could not be used",
  plugin_failed: "the quality plugin that writes it failed",
  step_failed: "the processing step that writes it failed",
  step_skipped: "the processing step that writes it was skipped",
  no_good_window: "the recording has no window of good samples long enough",
  frame_rotated: "the positions' coordinate system is known to be turned",
  no_serving_index: "the serving copy's index was not available to the run",
  not_in_serving_index: "the recording is not in the serving copy's index",
  serving_index_stale: "the serving copy's index was older than the recording",
  serving_index_unusable: "the serving copy's index could not be used",
  skipped_unknown: "a reason this page has no words for",
  http_4xx: "The server refused the request for this recording's quality views.",
  http_5xx: "The server could not answer for this recording's quality views. Try again later.",
};

/** The Activations tab's sentences (website W7; neuroschema `docs/views/ic-activity.md`, Words and
 *  Drawing): its captions, and its refusals where the panel's or a view's sentence would speak of
 *  another view. Asked for as `activity:<word>`; any other word falls back to `sentenceOf`. */
export const ACTIVITY_SENTENCES: Readonly<Record<string, string>> = {
  computed:
    "Computed in your browser from the serving copy with no preprocessing, so the activations approximate what the decomposition was given (its filters, line-noise removal and artifact subspace reconstruction are not redone); the axis is in arbitrary units.",
  archive:
    "The decomposition read the dataset's own files, which no digest ties to the serving copy.",
  filter: "Each trace is drawn through a {hz} Hz high-pass for display only.",
  no_shaded_rows: "The bad-segment table has no span ASR repaired, so nothing is shaded.",
  no_store: "The serving copy of this recording cannot be read here, so no activations are drawn.",
  kind_unsupported: "This page does not draw this kind of activation view.",
  table_location_mismatch:
    "A table the activations read is not this recording's, so no activations are drawn.",
  store_mismatch:
    "The view names another store than the one the decomposition read, so no activations are drawn.",
  store_digest_mismatch:
    "The serving copy does not match the digest NEMAR recorded, so no activations are drawn.",
  rate_invalid: "The recording's sampling rate cannot be read, so no activations are drawn.",
  window_outside_store: "The window lies outside the recording, so no activations are drawn.",
  window_too_long: "The window is longer than the view allows, so no activations are drawn.",
  duration_not_positive:
    "A bad segment in the floor's table has no length, so no activations are drawn.",
  label_unmatched:
    "The record says ASR repaired spans, and the bad-segment table marks none, so no activations are drawn.",
  channel_set_mismatch:
    "The serving copy does not hold each of the decomposition's channels exactly once, so no activations are drawn.",
  unit_unknown:
    "A channel's unit in the serving copy is not one the view converts, so no activations are drawn.",
  filter_out_of_range:
    "The display filter's cutoff is not below half the sampling rate, so no activations are drawn.",
  signal_recording_mismatch:
    "The view's store is not this recording's, so no activations are drawn.",
};

/** A word's sentence: the panel's, else a view's; an HTTP status by its class; any other word
 *  the generic failure sentence, so no raw word is ever shown. */
export function sentenceOf(word: string, fallback = "failed"): string {
  if (word.startsWith("activity:")) {
    const own = word.slice(9);
    return ACTIVITY_SENTENCES[own] ?? sentenceOf(own, fallback);
  }
  const known = PANEL_SENTENCES[word] ?? VIEW_SENTENCES[word] ?? MAP_SENTENCES[word];
  if (known) return known;
  const status = /^http_([1-5])\d\d$/.exec(word);
  if (status) return PANEL_SENTENCES[status[1] === "5" ? "http_5xx" : "http_4xx"];
  return PANEL_SENTENCES[fallback] ?? PANEL_SENTENCES.failed;
}
