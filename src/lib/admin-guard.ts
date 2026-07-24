import type { AuthSession } from "./auth";

/**
 * Route guard for every page under `/admin`. Pure function (no Astro import)
 * so it's directly unit-testable; pages call it and `Astro.redirect()` the
 * result when non-null.
 *
 * Mirrors the gate that used to be inlined in
 * `src/pages/admin/publication-requests.astro` verbatim:
 *   - No session -> send to sign-in with a `next` back to the admin page.
 *   - Signed in but not an admin -> 404, not 403, so we don't leak the
 *     existence of the admin surface to non-admin users.
 *   - Admin -> null (proceed).
 */
export function adminGate(session: AuthSession | null, pathname: string): string | null {
  if (!session) {
    return `/login?next=${encodeURIComponent(pathname)}`;
  }
  if (session.user.role !== "admin") {
    return "/404";
  }
  return null;
}
