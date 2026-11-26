/**
 * The sentence a page shows for each word a view can be refused or annotated with (neuroschema
 * 0.6.0 `docs/views/generic-kinds.md`, Words, and `docs/views/sensor-field.md`, Refusals; website
 * ADR 0035 decision 4). A word this table does not hold is shown as the word itself, never hidden.
 *
 * The digest words say the file does not match "the digest NEMAR recorded" and claim nothing more:
 * the same backend serves the files and their digests (nemar-cli ADR 0137 decision 6).
 *
 * `nemar.sensor-labels.v1`'s refusals are not in these tables: they load with the scalp map that
 * needs them (`mapSentences`), so a panel's first screen carries none of them.
 */

import { MONTAGE_UNAVAILABLE, MONTAGE_UNAVAILABLE_SENTENCE } from "../montage-unavailable-copy";

export const VIEW_SENTENCES: Readonly<Record<string, string>> = {
  declaration_invalid: "This view's declaration does not meet the view schema, so it is not drawn.",
  file_missing: "A file this view reads is not there, so it is not drawn.",
  file_size_mismatch:
    "A file this view reads does not have the size NEMAR recorded, so it is not drawn.",
  file_digest_mismatch:
    "A file this view reads does not match the digest NEMAR recorded, so it is not drawn.",
  view_digest_mismatch:
    "This view's declaration does not match the digest NEMAR recorded, so it is not drawn.",
  cap_exceeded: "The data exceed the size limits for a drawn view.",
  tsv_encoding: "A table file is not plain UTF-8 text.",
  tsv_line_endings: "A table file has carriage returns or no final line ending.",
  tsv_header_repeated: "A table file names one column twice.",
  tsv_ragged: "A row of a table file has a different number of cells than its header.",
  column_repeated: "The view declares one column twice.",
  column_missing: "A column the view declares is not in its file.",
  coords_unresolved: "The view's labels point at a column or file it does not declare.",
  coords_mismatch: "A label column's type or unit differs from what the view declares.",
  coords_length: "A label file does not have one label per row or column.",
  sensors_mismatch:
    "The sensor names in the layout are not the names of the value columns, in order.",
  value_type: "A value column is not numeric.",
  value_units_differ: "The value columns have different units.",
  empty: "The file has no data row or no value column.",
  cell_not_number: "A cell that should hold a number does not.",
  cell_not_finite: "A cell holds a number too large to draw.",
  cell_not_integer: "A cell that should hold a whole number does not.",
  x_not_increasing: "The x values do not strictly increase.",
  json_invalid: "A JSON file is not valid Internet JSON.",
  content_invalid: "A JSON file does not have the content the view declares.",
  edges_not_increasing: "The histogram's bin edges do not strictly increase.",
  counts_length: "The histogram does not have one count per bin.",
};

export const MAP_SENTENCES: Readonly<Record<string, string>> = {
  too_few_sensors:
    "Fewer than 8 sensors have a value and a place inside the map, and a map needs 8.",
  head_outside_grid: "A sensor lies so far outside the head that the map has no point inside it.",
  interpolation_failed: "The values could not be interpolated into finite numbers.",
  frame_not_scalp:
    "The sensors' positions are in a coordinate system of intracranial recordings, so no scalp map is drawn from them.",
  no_eeg_sensors: "No sensor says it is EEG, and a scalp map draws EEG sensors only.",
  montage_unknown: "The sensors' template layout names a montage this site does not hold.",
  template_name_unknown:
    "A sensor's name is not an electrode of the montage its template positions name.",
  frame_unknown: "The positions name a coordinate system whose orientation is not known.",
  positions_flat: "The measured positions are too flat, or too few, to locate the head's center.",
  positions_partial: "The measured positions cover too little of the head to locate its center.",
  // A montage or the chunk placing sensors by name could not be loaded: never loaded lazily itself.
  [MONTAGE_UNAVAILABLE]: MONTAGE_UNAVAILABLE_SENTENCE,
  worker: "The map could not be drawn on this page.",
};

/**
 * The sentences for a scalp map whose placement word is `word`: `MAP_SENTENCES`, with
 * `nemar.sensor-labels.v1`'s refusals (`sensor-labels-copy.ts`) when `word` is one it does not hold.
 * Those load only for a map placed by name and refused; if they cannot be loaded, the word is shown
 * as itself, as for any word a table does not hold. Never rejects.
 */
export async function mapSentences(word: string | null): Promise<Readonly<Record<string, string>>> {
  if (word === null || Object.hasOwn(MAP_SENTENCES, word)) return MAP_SENTENCES;
  try {
    const { LABELS_SENTENCES } = await import("../sensor-labels-copy");
    return { ...MAP_SENTENCES, ...LABELS_SENTENCES };
  } catch (error) {
    console.error("[quality-views] the sentences of a map placed by name did not load:", error);
    return MAP_SENTENCES;
  }
}

/** Why positions were not used, when the sensors were placed by name instead. */
export const UNUSED_POSITIONS_SENTENCES: Readonly<Record<string, string>> = {
  frame_unknown:
    "The view's positions name a coordinate system whose orientation is not known, so the sensors are placed by name.",
  positions_flat:
    "The view's measured positions are too flat, or too few, to locate the head's center, so the sensors are placed by name.",
  positions_partial:
    "The view's measured positions cover too little of the head, so the sensors are placed by name.",
};

export const sentence = (table: Readonly<Record<string, string>>, word: string): string =>
  table[word] ?? word;
