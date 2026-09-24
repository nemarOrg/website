/**
 * Tells the Open Science Assistant (OSA) widget which color scheme the reader chose on this site
 * (OpenScience-Collective/osa#469).
 *
 * This site's theme is the `data-theme` attribute on `<html>`: `"light"` or `"dark"` when the
 * reader picked one (the theme button, or Settings > Appearance), absent when the site follows
 * the device. The widget's `setColorScheme` takes the same three choices as `'light'`, `'dark'`
 * and `'auto'`. Without it the widget follows only the device (NEMAR's community config sets
 * `color_scheme: auto`), so a reader who picked light on a dark device would get a dark assistant
 * on a light page.
 *
 * Two halves, so the widget has the reader's choice whichever of its `<script>` and this module
 * runs first:
 *
 * - `renderOsaWidgetScript`'s generated `onload` handler (`./osa-widget.ts`) reads `data-theme`
 *   itself and passes {@link osaColorSchemeFor}'s answer to `setColorScheme` before `.init()`, so
 *   the panel opens in the reader's scheme. The attribute is set by the theme bootstrap in
 *   `Base.astro`'s `<head>`, before either script, so it is already current then.
 * - {@link followThemeForOsa}, run from `Base.astro`, forwards every later change of the attribute.
 *
 * Unlike `./osa-dataset.ts`, nothing is recorded on `window`: the attribute itself is the record,
 * and the `onload` handler reads it directly.
 *
 * Both halves feature-detect `setColorScheme` (a widget pinned before osa#472 has none) and never
 * let an exception from it escape: a widget bug must not break the theme switch.
 */

export type OsaColorScheme = "light" | "dark" | "auto";

/** The widget's color scheme for a value of this site's `data-theme` attribute: the reader's
 *  explicit choice, or `'auto'` (follow the device) when there is none. */
export function osaColorSchemeFor(dataTheme: string | null | undefined): OsaColorScheme {
  return dataTheme === "light" || dataTheme === "dark" ? dataTheme : "auto";
}

/** What {@link forwardOsaColorScheme} needs of `window`: the widget's global, when it has loaded. */
export interface OsaThemeWindow {
  OSAChatWidget?: { setColorScheme?: unknown };
}

/**
 * Passes `scheme` to the widget when it has loaded and has `setColorScheme`; otherwise does
 * nothing, since the `onload` handler reads the current theme itself when the widget does load.
 * Returns whether the widget was told.
 */
export function forwardOsaColorScheme(win: OsaThemeWindow, scheme: OsaColorScheme): boolean {
  const widget = win.OSAChatWidget;
  if (!widget || typeof widget.setColorScheme !== "function") return false;
  try {
    (widget as { setColorScheme: (value: OsaColorScheme) => void }).setColorScheme(scheme);
    return true;
  } catch (err) {
    console.warn("[osa-theme] widget's setColorScheme threw:", err);
    return false;
  }
}

/**
 * Forwards every later change of `data-theme` on `root` to the widget. Not the initial value: the
 * widget's `onload` handler reads that itself, and forwarding it here too would only repeat it.
 */
export function followThemeForOsa(root: HTMLElement = document.documentElement): void {
  new MutationObserver(() => {
    forwardOsaColorScheme(
      window as OsaThemeWindow,
      osaColorSchemeFor(root.getAttribute("data-theme")),
    );
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}
