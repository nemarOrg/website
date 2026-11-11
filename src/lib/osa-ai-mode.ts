/**
 * The "AI Mode" pill on the dataset page (website#517, board C1 of the NEMAR AI plan).
 *
 * The pill opens the Open Science Assistant (OSA) widget as its centre-stage dialog,
 * `OSAChatWidget.open({ mode: "center" })` (OSA #701). Everything the pill decides lives here,
 * pure and with no Astro import, so a unit test can drive it with plain objects standing in for
 * `window`, `document` and `Storage`: Astro files have no render harness in this repo.
 *
 * Three things are decided here.
 *
 * 1. **Whether the pill shows at all.** Only when the widget is on the page AND has an `open`
 *    function. Production pins an older widget that has none, so the check is on the method, never
 *    on a version string ({@link aiModeAvailable}). A widget that did not load (jsDelivr, the CSP
 *    or the integrity check blocked it) leaves `window.OSAChatWidget` undefined, and the pill
 *    stays hidden.
 * 2. **When that is decided.** The ActionBar's script is a deferred module script that sits before
 *    the widget's deferred classic script in the document, so it runs first and sees no widget
 *    yet. Deferred scripts all run before `DOMContentLoaded`, so the pill is revealed then, or at
 *    once when the document is no longer loading ({@link whenDocumentReady},
 *    {@link revealAiModePill}).
 * 3. **The one-time hint** under the pill ({@link shouldShowAiModeHint}, {@link dismissAiModeHint}):
 *    remembered in `localStorage`, with every read and write guarded, so a store that is blocked
 *    or full means "show once per page load" and never an error.
 */

/** The `localStorage` key that remembers the hint was dismissed. Versioned so a reworded hint can
 *  be shown again by bumping it. */
export const AI_MODE_HINT_STORAGE_KEY = "nemar:ai-mode-hint:v1";

/** What is stored under {@link AI_MODE_HINT_STORAGE_KEY} once the hint is dismissed. */
const HINT_DISMISSED = "dismissed";

/** The part of `window` this module reads: the widget global, whose members are `unknown` because
 *  a widget older than OSA #701 has no `open`. */
export interface AiModeWindow {
  OSAChatWidget?: { open?: unknown } | null;
}

/** The part of `Storage` this module uses (the real interface, so a `Storage` fits). */
export interface AiModeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The part of `document` the reveal needs. */
export interface AiModeDocument {
  readyState: string;
  addEventListener(
    type: "DOMContentLoaded",
    listener: () => void,
    options?: { once: boolean },
  ): void;
}

/** Whether the widget is on the page and can be opened from the host. A widget pinned before OSA
 *  #701 (production, today) has no `open`, so the pill stays hidden there. */
export function aiModeAvailable(win: AiModeWindow): boolean {
  return typeof win.OSAChatWidget?.open === "function";
}

/**
 * Opens the widget as the centre-stage dialog. Returns whether it did: `false` when there is no
 * usable widget or when the widget threw. A throw is caught and warned, as `announceOsaDataset`
 * does for `setDataset`, because the widget is a third party's code and a bug in it must not turn
 * a click into an unhandled error on the dataset page.
 */
export function openAiMode(win: AiModeWindow): boolean {
  const widget = win.OSAChatWidget;
  if (!widget || typeof widget.open !== "function") return false;
  try {
    (widget.open as (options: { mode: "center" }) => void).call(widget, { mode: "center" });
    return true;
  } catch (err) {
    console.warn("[osa-ai-mode] widget's open threw:", err);
    return false;
  }
}

/** Runs `callback` once the document has been parsed and its deferred scripts have run: at once
 *  when `readyState` is not `loading`, else on `DOMContentLoaded`. */
export function whenDocumentReady(doc: AiModeDocument, callback: () => void): void {
  if (doc.readyState !== "loading") {
    callback();
    return;
  }
  doc.addEventListener("DOMContentLoaded", callback, { once: true });
}

/** The part of an element the reveal toggles (`hidden` is wider than a boolean in lib.dom). */
export interface Hideable {
  hidden: boolean | "until-found";
}

/**
 * Reveals `pill` once the document is ready, but only if the widget can be opened by then, and
 * calls `onRevealed` when it did (the caller shows the hint from there). The pill is expected to
 * ship `hidden`; it is never hidden again here.
 */
export function revealAiModePill(
  win: AiModeWindow,
  doc: AiModeDocument,
  pill: Hideable,
  onRevealed?: () => void,
): void {
  whenDocumentReady(doc, () => {
    if (!aiModeAvailable(win)) return;
    pill.hidden = false;
    onRevealed?.();
  });
}

/** Whether the hint is still to be shown: nothing stored says it was dismissed. A store that
 *  throws, or is absent, reads as "not dismissed", which is "show once per page load". */
export function shouldShowAiModeHint(store: AiModeStore | null | undefined): boolean {
  try {
    return store?.getItem(AI_MODE_HINT_STORAGE_KEY) !== HINT_DISMISSED;
  } catch {
    return true;
  }
}

/** Remembers that the hint was dismissed. A store that throws is ignored: the hint is then shown
 *  again on the next page load, never an error. */
export function dismissAiModeHint(store: AiModeStore | null | undefined): void {
  try {
    store?.setItem(AI_MODE_HINT_STORAGE_KEY, HINT_DISMISSED);
  } catch {
    // Blocked or full storage: the dismissal lasts for this page load only.
  }
}

/** The browser's `localStorage`, or `null` when reading the property itself throws (it does, with
 *  site data blocked). */
export function browserStore(win: { localStorage?: AiModeStore }): AiModeStore | null {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Where the hint panel goes, as offsets of its own box, so it stays on screen at any width. */
export interface HintPlacement {
  /** Shift of the panel's inline start from the pill's, in px (negative to move it toward the start). */
  shift: number;
  /** Inline offset of the caret from the panel's start, in px: under the pill's centre. */
  caretOffset: number;
}

/**
 * Places the hint under the pill. The panel starts at the pill's inline start and is moved toward
 * the start just far enough to fit inside the viewport with `gutter` px to spare, which matters
 * when the actions row wraps and the pill sits far from the left edge (the board's fixed
 * `left: 118px` only fits the unwrapped row). The caret stays under the pill's centre, kept clear
 * of the panel's rounded corners.
 */
export function placeAiModeHint(input: {
  pillLeft: number;
  pillWidth: number;
  hintWidth: number;
  viewportWidth: number;
  gutter?: number;
  /** Space kept between the caret and either end of the panel (default 16). */
  caretInset?: number;
}): HintPlacement {
  const { pillLeft, pillWidth, hintWidth, viewportWidth } = input;
  const gutter = input.gutter ?? 16;
  const caretInset = input.caretInset ?? 16;
  // Move toward the start until the panel's end clears the right gutter, but never past the left
  // gutter: when the panel is wider than the viewport allows, the left edge wins.
  const fitEnd = Math.min(0, viewportWidth - gutter - hintWidth - pillLeft);
  const shift = Math.max(fitEnd, gutter - pillLeft);
  const caretCentre = -shift + pillWidth / 2;
  const caretOffset = Math.min(Math.max(caretCentre, caretInset), hintWidth - caretInset);
  return { shift, caretOffset };
}
