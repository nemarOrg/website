/**
 * Static definition of the `/admin` section nav. `AdminLayout.astro` renders
 * one entry per tab; disabled tabs render as inert `(coming soon)` markers
 * instead of a dead link. Every tab is enabled as of Phase 5 (epic
 * website#158 complete); the `enabled` flag stays because it's what keeps
 * {@link adminMetricHref} from ever producing a link to an unshipped tab.
 */

export type AdminTab = "overview" | "publications" | "users" | "imports" | "notices";

export interface AdminTabDef {
  readonly id: AdminTab;
  readonly label: string;
  readonly href: string;
  readonly enabled: boolean;
}

export const ADMIN_TABS: readonly AdminTabDef[] = [
  { id: "overview", label: "Overview", href: "/admin", enabled: true },
  {
    id: "publications",
    label: "Publications",
    href: "/admin/publication-requests",
    enabled: true,
  },
  { id: "users", label: "Users", href: "/admin/users", enabled: true },
  { id: "imports", label: "Imports", href: "/admin/imports", enabled: true },
  { id: "notices", label: "Notices", href: "/admin/notices", enabled: true },
];

/**
 * Maps an observability metric key prefix to the admin tab that can act on
 * that family of metrics. Used by `OverviewGrid.astro` to deep-link tiles.
 */
const TAB_FOR_METRIC_FAMILY: ReadonlyArray<readonly [string, AdminTab]> = [
  ["publication.", "publications"],
  ["users.", "users"],
  ["imports.", "imports"],
];

/**
 * Metrics that map to one filter of a tab rather than the whole tab.
 * `imports.upstream_inaccessible` is a subset of quarantined (the same
 * `last_error` match the observability Worker uses), so it shares that
 * destination.
 */
const VIEW_FOR_METRIC: Readonly<Record<string, string>> = {
  "imports.active": "/admin/imports?view=inflight",
  "imports.failed": "/admin/imports?view=failed",
  "imports.quarantined": "/admin/imports?view=quarantined",
  "imports.upstream_inaccessible": "/admin/imports?view=quarantined",
};

/**
 * Destination for an Overview metric tile, or `undefined` when the tile
 * should render as plain text.
 *
 * Gated on {@link ADMIN_TABS} `enabled` rather than a hardcoded list, so a
 * tab that hasn't shipped yet can never produce a dead link — that guard is
 * why `users.*` and `imports.*` were unlinked before Phases 3 and 4 (epic
 * website#158). Lives here rather than inline in `OverviewGrid.astro` so it
 * is unit-testable: nobody clicks every metric tile during manual QA, and
 * Astro frontmatter is outside the vitest surface.
 */
export function adminMetricHref(metricKey: string): string | undefined {
  const family = TAB_FOR_METRIC_FAMILY.find(([prefix]) => metricKey.startsWith(prefix));
  if (!family) return undefined;
  const tab = ADMIN_TABS.find((t) => t.id === family[1]);
  if (!tab?.enabled) return undefined;
  return VIEW_FOR_METRIC[metricKey] ?? tab.href;
}
