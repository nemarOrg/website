/**
 * The "AI Mode" pill on the dataset page (website#517, board C1 of the NEMAR AI plan).
 *
 * The pill opens the Open Science Assistant (OSA) widget as its centre-stage dialog,
 * `OSAChatWidget.open({ mode: "center" })` (OSA #701). Everything the pill decides lives here,
 * pure and with no Astro import, so a unit test can drive it with plain objects standing in for
 * `window`, `document` and `Storage`: Astro files have no render harness in this repo.
 *
 * This module serves two features, in two halves. The first half is the dataset-page pill
 * (website#517). The second, below the "AI Mode toggle in the search fields" banner, is the AI Mode
 * toggle in the search fields of Home and Discover (website#518 and #519). They share the widget
 * check and {@link whenDocumentReady}.
 *
 * Three things are decided for the pill.
 *
 * 1. **Whether the pill shows at all.** Only when the widget is on the page AND has an `open`
 *    function. Production pins an older widget that has none, so the check is on the method, never
 *    on a version string ({@link aiModeAvailable}). A widget that did not load (jsDelivr, the CSP
 *    or the integrity check blocked it) leaves `window.OSAChatWidget` undefined, and the pill
 *    stays hidden.
 * 2. **When that is decided.** The ActionBar's script is a deferred module script that sits before
 *    the widget's deferred classic script in the document, so it runs first, with `readyState`
 *    already `interactive`, and sees no widget yet. Deferred scripts all run before
 *    `DOMContentLoaded`, so the pill is revealed then ({@link whenDocumentReady},
 *    {@link revealAiModePill}).
 * 3. **The one-time hint** under the pill ({@link shouldShowAiModeHint}, {@link dismissAiModeHint}):
 *    remembered in `localStorage`, with every read and write guarded, so a store that is blocked
 *    or full means "show once per page load" and never an error.
 *
 * Six things are decided for the search toggle, in the second half:
 *
 * 1. **Whether it is offered** ({@link aiModeSearchAvailable}): the widget can open and the overview
 *    endpoint is set.
 * 2. **Whether it starts on** ({@link initialAiModeSearch}): on by default. The address's `ai=1` or
 *    `ai=0` wins, else the remembered choice, and a reader who never chose is on.
 * 3. **How a choice is kept** ({@link setAiModeSearch}): `localStorage` and the address, each
 *    guarded.
 * 4. **How the page's own links carry it** ({@link withAiModeParam}, {@link aiLinkHref}).
 * 5. **How "Ask a follow-up" reaches the widget** ({@link askFollowUp}).
 * 6. **The line under the field** for a search of one or two words ({@link aiHintShown},
 *    {@link aiHintAnnouncement}).
 *
 * The overview panel's own states are in `./ai-overview-panel`, and its request and answer in
 * `./osa-overview`.
 */

import { AI_MODE_HINT, OVERVIEW_MIN_WORDS, countQueryWords } from "./osa-overview";

/** The `localStorage` key that remembers the hint was dismissed. Versioned so a reworded hint can
 *  be shown again by bumping it. */
export const AI_MODE_HINT_STORAGE_KEY = "nemar:ai-mode-hint:v1";

/** What is stored under {@link AI_MODE_HINT_STORAGE_KEY} once the hint is dismissed. */
const HINT_DISMISSED = "dismissed";

/** The part of `window` this module reads: the widget global, whose members are `unknown` because
 *  a widget older than OSA #701 has no `open`. */
export interface AiModeWindow {
  OSAChatWidget?: { open?: unknown; ask?: unknown } | null;
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

/** The part of `window` the fallback needs: the `load` event. */
export interface AiModeLoadTarget {
  addEventListener(type: "load", listener: () => void, options?: { once: boolean }): void;
}

/**
 * Runs `callback` once, after the document's deferred scripts have run.
 *
 * `readyState` alone cannot say that. A module script (the ActionBar's) runs while `readyState`
 * is already `interactive` but BEFORE the widget's deferred classic script, later in the
 * document, and before `DOMContentLoaded`; the widget exists only after it. So only `complete`
 * means "now". In every other state the callback waits for `DOMContentLoaded`, which follows all
 * deferred scripts (a failed or blocked one included), and for `loadTarget`'s `load` as the
 * fallback for a script that runs after `DOMContentLoaded` has already fired, when `readyState` is
 * still `interactive` and that event will not come again. Whichever is first runs the callback,
 * and the other is ignored.
 */
export function whenDocumentReady(
  doc: AiModeDocument,
  callback: () => void,
  loadTarget?: AiModeLoadTarget,
): void {
  if (doc.readyState === "complete") {
    callback();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    callback();
  };
  doc.addEventListener("DOMContentLoaded", once, { once: true });
  loadTarget?.addEventListener("load", once, { once: true });
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
  win: AiModeWindow & Partial<AiModeLoadTarget>,
  doc: AiModeDocument,
  pill: Hideable,
  onRevealed?: () => void,
): void {
  whenDocumentReady(
    doc,
    () => {
      if (!aiModeAvailable(win)) return;
      pill.hidden = false;
      onRevealed?.();
    },
    typeof win.addEventListener === "function" ? (win as AiModeLoadTarget) : undefined,
  );
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

// ---------------------------------------------------------------------------
// The AI Mode toggle in the search fields (website#518, #519)
// ---------------------------------------------------------------------------

/** The `localStorage` key that remembers whether AI Mode is on in search. Versioned so a change
 *  of meaning can start every reader from the default (on) by bumping it. */
export const AI_MODE_SEARCH_STORAGE_KEY = "nemar:ai-mode-search:v1";

/** The query parameter that carries AI Mode through the address. AI Mode is on by default, so a
 *  page without it is on: `ai=0` is the explicit off, `ai=1` the explicit on (it overrides a
 *  remembered off), and a link the page writes for an on state carries no parameter at all. */
export const AI_MODE_URL_PARAM = "ai";

/** What the reader is told at the point of use: with AI Mode on, the browser posts the search and
 *  the top results' titles and descriptions to the Open Science Assistant service, which passes
 *  them to a model provider. Shown as visible text under each search field while AI Mode is on
 *  (a `title` tooltip alone does not reach touch, keyboard or most screen readers) and, as a
 *  bonus, as the toggle's `title`. The privacy policy (docs.nemar.org) is the canonical statement
 *  (nemarOrg/website#523). */
export const AI_MODE_SEARCH_DISCLOSURE =
  "AI Mode writes an overview of your search. When it is on, your search words and the titles and descriptions of the top results are sent to the Open Science Assistant service and an AI model provider.";

const SEARCH_ON = "on";
const SEARCH_OFF = "off";

/**
 * Whether the toggle is offered: the widget is on the page with an `open` method (so "Ask a
 * follow-up" has somewhere to go) AND the overview endpoint is set. The server renders no toggle
 * without the endpoint, so the second half is a guard against a page that has the markup but
 * not the setting; the first can only be known in the browser.
 */
export function aiModeSearchAvailable(
  win: AiModeWindow,
  endpoint: string | null | undefined,
): boolean {
  return typeof endpoint === "string" && endpoint !== "" && aiModeAvailable(win);
}

/** The part of `window` the preference reads and writes. */
export interface AiModePageWindow {
  location: { pathname: string; search: string; hash: string };
  history: {
    state: unknown;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  localStorage?: AiModeStore;
}

/** The remembered choice. On unless the store holds an explicit off: AI Mode is on by default, so
 *  a store that is absent, throws, or holds anything else leaves the reader on. */
export function readAiModeSearch(store: AiModeStore | null | undefined): boolean {
  try {
    return store?.getItem(AI_MODE_SEARCH_STORAGE_KEY) !== SEARCH_OFF;
  } catch {
    return true;
  }
}

/** Remembers the choice. A store that throws is ignored: an off then lasts for the page and,
 *  through `ai=0`, for the links the reader follows. */
export function writeAiModeSearch(store: AiModeStore | null | undefined, on: boolean): void {
  try {
    store?.setItem(AI_MODE_SEARCH_STORAGE_KEY, on ? SEARCH_ON : SEARCH_OFF);
  } catch {
    // Blocked or full storage.
  }
}

/** `search` (a query string, with or without its `?`) with the choice in it. On is the default, so
 *  it is the parameter taken out; off is written as `ai=0`, so that a link, a reload or a search
 *  submitted from the page stays off. */
export function withAiModeParam(search: string, on: boolean): string {
  const params = new URLSearchParams(search);
  if (on) params.delete(AI_MODE_URL_PARAM);
  else params.set(AI_MODE_URL_PARAM, "0");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * The href a /discover link on the page gets for the reader's choice, or `null` to leave it alone:
 * the link is not a link to this site's /discover, or already says what it should. `href` is the
 * attribute as written, `base` the document's base URI, `origin` the page's own origin. The
 * server-rendered hrefs are cached at the edge for every reader, so the browser adjusts them.
 */
export function aiLinkHref(
  href: string | null,
  base: string,
  origin: string,
  on: boolean,
): string | null {
  if (href === null) return null;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== "/discover") return null;
  const search = withAiModeParam(url.search, on);
  if (search === url.search) return null;
  return `${url.pathname}${search}${url.hash}`;
}

/** Puts the choice in the address bar without a new history entry. A browser that refuses
 *  (a sandboxed frame, a stubbed history) leaves the address as it is. */
function replaceAiModeUrl(win: AiModePageWindow, on: boolean): void {
  try {
    const search = withAiModeParam(win.location.search, on);
    if (search === win.location.search) return;
    win.history.replaceState(
      win.history.state,
      "",
      `${win.location.pathname}${search}${win.location.hash}`,
    );
  } catch {
    // The address is left alone.
  }
}

/**
 * Whether AI Mode starts on for this page. It is on by default: the server renders every page, which
 * is cached at the edge for everyone, in the on state, and this lets the reader switch it off.
 *
 * 1. `ai=1` in the address is on and `ai=0` is off. Either wins over what is remembered (a shared
 *    link, a paged or filtered link) and is written back to the store, so the next page without
 *    the parameter keeps the choice.
 * 2. Otherwise the remembered choice applies. Nothing remembered is on and leaves the address
 *    alone. A remembered off puts `ai=0` in the address, so a copied link says what the page
 *    shows (a link without `ai` is on for whoever opens it).
 */
export function initialAiModeSearch(win: AiModePageWindow): boolean {
  const store = browserStore(win);
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(win.location.search).get(AI_MODE_URL_PARAM);
  } catch {
    // An address that cannot be read is an address without the parameter.
  }
  if (fromUrl === "1" || fromUrl === "0") {
    const on = fromUrl === "1";
    writeAiModeSearch(store, on);
    return on;
  }
  const remembered = readAiModeSearch(store);
  if (!remembered) replaceAiModeUrl(win, false);
  return remembered;
}

/** Records a change the reader made: remembered, and in the address (`ai=0` for off, removed for on). */
export function setAiModeSearch(win: AiModePageWindow, on: boolean): void {
  writeAiModeSearch(browserStore(win), on);
  replaceAiModeUrl(win, on);
}

/**
 * "Ask a follow-up": hands the question to the widget's centre-stage dialog. `ask(text,
 * {mode: "center"})` where the widget has it; the widget of OSA #701 does, and an older one
 * only `open`, which opens the dialog without the question. Returns whether the widget took it.
 * A throw is caught and warned, as {@link openAiMode} does.
 */
export function askFollowUp(win: AiModeWindow, text: string): boolean {
  const widget = win.OSAChatWidget;
  if (!widget) return false;
  if (typeof widget.ask !== "function") return openAiMode(win);
  try {
    const result = (widget.ask as (text: string, options: { mode: "center" }) => unknown).call(
      widget,
      text,
      { mode: "center" },
    );
    // A widget that answers with a promise may reject it later; that is as much a warning as a throw.
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch((err) => {
        console.warn("[osa-ai-mode] widget's ask rejected:", err);
      });
    }
    return true;
  } catch (err) {
    console.warn("[osa-ai-mode] widget's ask threw:", err);
    return false;
  }
}

/**
 * Whether the line under the search field ({@link AI_MODE_HINT}) is shown: AI Mode is on and the
 * search has one or two words (`countQueryWords`, the way OSA counts them). `query` is the field's
 * live value, so it follows typing; an empty field has nothing to explain. `refused` is a 422 from
 * the endpoint for the search just made: the server counted differently, so the line is shown for
 * a field that has words at all.
 */
export function aiHintShown(on: boolean, query: string, refused = false): boolean {
  if (!on) return false;
  const words = countQueryWords(query);
  return words >= 1 && (words < OVERVIEW_MIN_WORDS || refused);
}

/**
 * What the polite live region is set to when the line's state changes, or `null` for no change.
 * The region is set on the transition only, never per keystroke: the line's words when it appears
 * (one announcement per appearance), an empty string when it goes (so the same words are announced
 * again the next time).
 */
export function aiHintAnnouncement(wasShown: boolean, shown: boolean): string | null {
  if (shown === wasShown) return null;
  return shown ? AI_MODE_HINT : "";
}
