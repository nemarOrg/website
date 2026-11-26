/**
 * The quality panel's sentences (website phase W6): for a record it cannot show, a view or preset
 * word it adds to the renderers' own (`render/words.ts`), and a signal window's states and notes.
 * A chunk of its own, loaded the first time the panel has something to say, so the first screen of
 * a recording that draws carries none of it.
 */

import { VIEW_SENTENCES } from "./render/words";

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
};

/** A word's sentence: the panel's, else a view's, else the word itself (never hidden). */
export const sentenceOf = (word: string): string =>
  PANEL_SENTENCES[word] ?? VIEW_SENTENCES[word] ?? word;
