/** The presets' shared word: a preset's own check that failed (presets.md), apart from `checkPreset`
 *  (`presets.ts`), so a tab's extras load only their own preset. */

export const IC_CLASSES_CONTENT = "content.nemar.ic-classes.v1.schema.json";

/** A preset's own check failed: drawn by its base with the word, shown as the fallback's tables,
 *  or nothing drawn. */
export class PresetRefused extends Error {
  constructor(
    readonly word: string,
    readonly outcome: "base" | "fallback" | "nothing",
  ) {
    super(word);
    this.name = "PresetRefused";
  }
}
