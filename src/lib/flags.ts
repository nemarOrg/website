/**
 * Feature flags for staged rollout. Flip a flag to enable the feature at launch.
 */

import { DEFAULT_API_BASE, apiBase } from "./api-base";

/**
 * Passwordless web sign-in (the /login page). Planned launch: July 2026.
 * While `false`, the login page shows a "coming soon" state and users
 * authenticate with the CLI instead. The web and CLI share one backend account,
 * so flipping this to `true` is the only change needed at launch.
 */
export const WEB_SIGNIN_ENABLED = false;

/**
 * Build-aware email-code availability (#159). The launch flag gates the
 * production build; any build pointed at a non-production backend (the
 * test.nemar.org build bakes `PUBLIC_API_BASE_URL=https://api-test.nemar.org`)
 * and local `astro dev` always get the form, because those backends return
 * `dev_code` on /auth/code/request so QA can sign in without an inbox.
 * Pages previews of the production build bake the production apiBase, so
 * they stay gated like production.
 */
export function webSigninEnabled(): boolean {
  if (WEB_SIGNIN_ENABLED) return true;
  if (import.meta.env.DEV) return true;
  return apiBase() !== DEFAULT_API_BASE;
}

/** Human-facing launch estimate shown in the "coming soon" UI. */
export const WEB_SIGNIN_ETA = "July 2026";

/**
 * ORCID SSO sign-in (website#128 / nemar-cli#832). When true, the login page
 * shows "Sign in with ORCID" and the `/auth/orcid/*` routes are live. ORCID is
 * the primary method, so this can be enabled independently of (and ahead of)
 * the email-code flag. If the backend `ORCID_CLIENT_ID`/`ORCID_CLIENT_SECRET`
 * secrets are unset, the start route degrades to `?error=orcid_unavailable`
 * rather than breaking, so enabling this before the secrets land is safe.
 */
export const ORCID_SIGNIN_ENABLED = true;
