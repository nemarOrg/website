/**
 * The few rules the signal viewer needs about the Brain panel before the panel's own code is
 * loaded (card IS-V1): which channel groups are intracranial, where the panel sits, and how tall
 * the scope stays when it sits below. They live apart from `panel.ts` so the viewer can use them
 * without importing the panel, which is fetched only for an iEEG recording.
 */

export function isIeegModality(modality: string | undefined): boolean {
  return (modality || "").toUpperCase() === "IEEG";
}

/**
 * The viewer's width (CSS pixels) from which the panel sits beside the scope. Narrower, it goes
 * below the scope at full width, so the traces are never squeezed or hidden.
 */
export const SPATIAL_BESIDE_MIN_WIDTH = 720;

/**
 * The least height (CSS pixels) the scope keeps while the panel sits below it. A host that fits
 * the scope to its own height (the embed route) would otherwise shrink the traces to almost
 * nothing to make room for the panel; the embed's document scrolls instead. The stylesheet
 * repeats this number in `.eegv__plot--stack .eegv__scope` (a test pins the two together).
 */
export const STACKED_SCOPE_MIN_HEIGHT = 280;

export function spatialLayout(viewerWidth: number): "beside" | "below" {
  return viewerWidth >= SPATIAL_BESIDE_MIN_WIDTH ? "beside" : "below";
}

/** The scope height to apply: `height`, but never under the floor while the panel is below. */
export function stackedScopeHeight(height: number, stacked: boolean): number {
  return stacked ? Math.max(STACKED_SCOPE_MIN_HEIGHT, height) : height;
}
