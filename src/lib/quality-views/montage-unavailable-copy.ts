/**
 * A montage file that could not be loaded (the page is offline, or was deployed again since it
 * loaded): the sensors are not placed, and no map is drawn. The site's word, `montage_unavailable`;
 * no specification word says it.
 *
 * The one copy of its word and sentence. It is a module of its own, apart from
 * `sensor-labels-copy.ts`, because the quality views show it when a montage or a lazy chunk could
 * not be loaded, so it is on the page before them (`render/words.ts`); `sensor-labels-copy.ts`
 * re-exports both for the signal viewer.
 */

export const MONTAGE_UNAVAILABLE = "montage_unavailable";
export const MONTAGE_UNAVAILABLE_SENTENCE =
  "The montage for these sensors could not be loaded; reload the page to try again.";
