/**
 * Static definition of the `/admin` section nav. `AdminLayout.astro` renders
 * one entry per tab; disabled tabs render as inert `(coming soon)` markers
 * instead of a dead link. Phase 5 flips the last `enabled` to true when
 * notices ship — nothing else about the nav needs to change.
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
  { id: "notices", label: "Notices", href: "/admin/notices", enabled: false },
];
