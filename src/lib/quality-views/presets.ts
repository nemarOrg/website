/**
 * What the panel draws of a preset beyond its base, and the checks it runs first (neuroschema 0.6.0
 * `docs/views/presets.md`; `neuroschema.views.presets` is the Python reference, and
 * `views/vectors/preset-checks.v1.json` and the `nemar.spectrum` cases of `kinds-models.v1.json`
 * hold this file to it):
 *
 * - `nemar.spectrum`: the lines of its base, and scalp maps of the sensors' values at frequency
 *   rows (`spectrumMaps`), after the layout's names are found to be the sensor columns
 *   (`sensors_mismatch`, shown as the fallback's tables);
 * - `nemar.ic-maps`: the maps of its base, and a text row per component from the components
 *   table, once that table names the values' components in order (`components_mismatch` and the
 *   table's own words draw the maps without rows);
 * - `nemar.ic-classes`: the histogram of its base, with each class's count and summed variance as
 *   stored, once the content meets `content.nemar.ic-classes.v1` (`content_invalid`,
 *   `variance_length`, `components_total` draw the histogram alone);
 * - `nemar.signal-window`: `signal-window.ts`, loaded with the Signal tab.
 *
 * Each preset's code is a module of its own (`preset-spectrum.ts`, `preset-components.ts`,
 * `signal-window.ts`), so a tab loads only its own; `checkPreset` (the vectors' entry) loads them.
 *
 * The base model is the one `buildModel` builds (a registered preset with no builder of its own is
 * drawn by its base there); a file that is not the one recorded raises `ViewRefused` and nothing is
 * drawn.
 */

import {
  type FileSource,
  type ModelOptions,
  type ViewDecl,
  ViewRefused,
  buildModel,
} from "./model";

export { IC_CLASSES_CONTENT, PresetRefused } from "./preset-refused";
import { PresetRefused } from "./preset-refused";

/** A signal window's store, as the serving copy holds it (`signal-window.ts`). */
export interface SignalStore {
  readonly labels: readonly (string | null)[];
  readonly samples: number;
  readonly rate: number;
  /** The digest the serving copy publishes for the store, or null when it publishes none. */
  readonly published_sha256: string | null;
}

export type PresetOutcome =
  | ({ readonly word: null } & Record<string, unknown>)
  | { readonly word: string; readonly outcome: "base" | "fallback" | "nothing" };

/** `check_preset`: the outcome of a preset's own checks, as the vectors state it. */
export async function checkPreset(
  view: unknown,
  source: FileSource,
  options: ModelOptions,
  store?: SignalStore,
): Promise<PresetOutcome> {
  try {
    const check = await options.checks.view(view);
    if (!check.valid) throw new PresetRefused("declaration_invalid", "nothing");
    const decl = view as ViewDecl;
    if (decl.kind === "nemar.signal-window") {
      const { checkSignalWindow } = await import("./signal-window");
      return { word: null, ...(await checkSignalWindow(decl, source, store!, options)) };
    }
    if (["nemar.spectrum", "nemar.ic-maps", "nemar.ic-classes"].includes(decl.kind)) {
      const base = await buildModel(decl, source, options);
      if (base.refused !== null) return { word: base.refused.word, outcome: "fallback" };
      if (decl.kind === "nemar.spectrum") {
        await (await import("./preset-spectrum")).checkSpectrum(decl, source, options);
      } else {
        const own = await import("./preset-components");
        if (decl.kind === "nemar.ic-maps") await own.icMapsRows(decl, source, options);
        else await own.icClassesContent(decl, source, options);
      }
    }
  } catch (error) {
    if (error instanceof PresetRefused) return { word: error.word, outcome: error.outcome };
    if (error instanceof ViewRefused) return { word: error.word, outcome: "nothing" };
    throw error;
  }
  return { word: null };
}
