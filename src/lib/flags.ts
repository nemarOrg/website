/**
 * Feature flags for staged rollout. Flip a flag to enable the feature at launch.
 */

/**
 * Passwordless web sign-in (the /login page). Planned launch: July 2026.
 * While `false`, the login page shows a "coming soon" state and users
 * authenticate with the CLI instead. The web and CLI share one backend account,
 * so flipping this to `true` is the only change needed at launch.
 */
export const WEB_SIGNIN_ENABLED = false;

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
