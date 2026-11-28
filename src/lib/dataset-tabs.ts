/**
 * The dataset page's summary tabs (`DatasetTabs.astro`): the WAI-ARIA tabs pattern (a click, or
 * left and right with wrap, Home and End) and the deep link a tab answers for.
 *
 * A tab that owns a deep link names its hash prefix (`data-hash-prefix`; the Recording quality tab
 * owns `#quality`, the panel's `HASH_PREFIX`). The tab list opens that tab itself when the page
 * loads with such a hash, so a fresh load of `#quality/<recording>/<view>` shows the panel whichever
 * script runs first: the panel's own `showTab` clicks the tab, which does nothing before
 * `bindTablist` has bound the click.
 */

/** Whether `hash` is `prefix` itself or a path under it (`#quality`, `#quality/...`). */
export function hashMatches(prefix: string, hash: string): boolean {
  return prefix !== "" && (hash === prefix || hash.startsWith(`${prefix}/`));
}

/** The index of the first tab whose hash prefix `hash` matches, or -1. */
export function tabForHash(prefixes: readonly (string | null | undefined)[], hash: string): number {
  return prefixes.findIndex((prefix) => prefix != null && hashMatches(prefix, hash));
}

/** Activate the tab at `index` within `tabs`, deactivating the others; `focus` moves focus with
 *  the selection (keyboard navigation, per the ARIA tabs pattern's automatic activation). */
export function activateTab(
  tabs: readonly HTMLButtonElement[],
  index: number,
  focus: boolean,
): void {
  tabs.forEach((tab, i) => {
    const active = i === index;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    const panelId = tab.getAttribute("aria-controls");
    const panel = panelId ? document.getElementById(panelId) : null;
    if (panel) {
      if (active) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    }
  });
  if (focus) tabs[index]?.focus();
}

/** Bind one tab list's click and keys, then open the tab the page's hash names, if any. */
export function bindTablist(list: HTMLElement, hash: string = location.hash): void {
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  if (tabs.length === 0) return;

  list.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLButtonElement>('[role="tab"]');
    if (!tab) return;
    const idx = tabs.indexOf(tab);
    if (idx >= 0) activateTab(tabs, idx, false);
  });

  list.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const current = tabs.indexOf(active as HTMLButtonElement);
    if (current < 0) return;
    let next = current;
    switch (event.key) {
      case "ArrowRight":
        next = (current + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = (current - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    activateTab(tabs, next, true);
  });

  const linked = tabForHash(
    tabs.map((tab) => tab.dataset.hashPrefix),
    hash,
  );
  if (linked >= 0) activateTab(tabs, linked, false);
}
