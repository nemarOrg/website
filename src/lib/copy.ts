/**
 * User-facing copy shared by more than one component, so the wording cannot
 * drift between call sites. Page-local copy stays in its page.
 */

/**
 * Tooltip on the signed-out header "Sign in" links (Nav.astro, UserMenu.astro).
 * Same message as the /login notice (website#299): an account is only needed
 * to upload data, and later to run compute; browsing is open to everyone.
 */
export const SIGN_IN_TITLE =
  "You only need an account to upload data (and, soon, to run compute). Browsing, searching, and downloading are open to everyone.";
