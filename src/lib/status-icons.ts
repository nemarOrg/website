/**
 * Path data for the admin portal's small stroke icons (`StatusIcon.astro`),
 * drawn on the public observability dashboard's 16-unit grid. Kept here, out
 * of the component, so the lookup that guards a render is unit-tested.
 */

export type IconName =
  | "ok"
  | "warn"
  | "error"
  | "info"
  | "neutral"
  | "progress"
  | "up"
  | "down"
  | "flat"
  | "external"
  | "chevron";

const CIRCLE = "M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z";

const ICON_PATHS: Readonly<Record<IconName, readonly string[]>> = {
  ok: [CIRCLE, "M5.4 8.2l1.8 1.8 3.5-3.9"],
  warn: ["M8 2.1L14.4 13.4H1.6Z", "M8 6.4v3.1", "M8 11.4v.05"],
  error: [CIRCLE, "M5.9 5.9l4.2 4.2", "M10.1 5.9l-4.2 4.2"],
  info: [CIRCLE, "M8 7.3v3.7", "M8 5v.05"],
  neutral: [CIRCLE, "M5.5 8h5"],
  progress: [CIRCLE, "M8 4.6V8l2.3 1.5"],
  up: ["M8 12.5v-9", "M4.5 7L8 3.5 11.5 7"],
  down: ["M8 3.5v9", "M4.5 9L8 12.5 11.5 9"],
  flat: ["M3.5 8h9"],
  external: ["M6.5 3.5h6v6", "M12.5 3.5L4 12"],
  chevron: ["M6 3.5L10.5 8 6 12.5"],
};

/**
 * The paths for an icon. A name this module does not know draws nothing
 * rather than throwing: the icon is always decorative (words beside it say
 * the same thing), so a value the backend sent that no map anticipated must
 * cost the page an icon, never the page.
 */
export function iconPaths(name: string): readonly string[] {
  return Object.hasOwn(ICON_PATHS, name) ? ICON_PATHS[name as IconName] : [];
}
