/**
 * The one copy of the sentences a page shows when `nemar.sensor-labels.v1` refuses to place a
 * recording's sensors by name (neuroschema 0.6.0 `docs/views/sensor-labels.md`, Choosing a
 * montage). The quality views (`render/words.ts`) show a sentence as it is; the signal viewer's map
 * (`eeg-viewer/scalp-map.ts`) shows it after "No scalp map:" through `asClause`.
 *
 * Every sentence starts with a word whose capital is only the sentence's, so `asClause` may lower it.
 */

import type { LabelsReason } from "./sensor-labels";

export const LABELS_SENTENCES: Readonly<Record<LabelsReason, string>> = {
  too_few_channels:
    "Fewer than 8 channels could be EEG electrodes, and placing sensors by their names needs 8.",
  bipolar_labels:
    "Most channel names that match no electrode name a pair of electrodes (such as Fp1-F7), which has no single position.",
  labels_unrecognized: "No channel name matches an electrode of a standard montage.",
  share_too_low: "Fewer than 80% of the channel names match one standard montage.",
  too_few_matched: "Fewer than 8 channel names match one standard montage.",
  cap_model_unknown:
    "The channel names number the electrodes of an Electrical Geodesics (EGI) net, and the recording's cap model does not name the HydroCel net they point to; older EGI nets put the same numbers in other places.",
  duplicate_label: "Two channels name the same electrode.",
  montage_ambiguous:
    "The channel names fit two standard montages that put the electrodes in different places.",
  net_coverage_low:
    "The channel names match fewer than 90% of the electrodes of the net they point to, so they may come from another cap with the same numbering.",
};

/** A sentence to follow a colon: its first letter lowered, and its final period kept. */
export const asClause = (sentence: string): string =>
  sentence.charAt(0).toLowerCase() + sentence.slice(1);
