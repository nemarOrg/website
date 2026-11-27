/**
 * A montage file that could not be loaded (the page is offline, or was deployed again since it
 * loaded): the sensors are not placed, and no map is drawn. The site's word, `montage_unavailable`;
 * no specification word says it.
 *
 * The one copy of its word and sentence, read by the quality views (`render/words.ts`) and the
 * signal viewer (`eeg-viewer/scalp-map.ts`). It is a module of its own, apart from the lazy
 * `sensor-labels-copy.ts`, because it is shown when a montage or a lazy chunk could not be loaded,
 * so it must be on the page already.
 */

export const MONTAGE_UNAVAILABLE = "montage_unavailable";
export const MONTAGE_UNAVAILABLE_SENTENCE =
  "The montage for these sensors could not be loaded; reload the page to try again.";
