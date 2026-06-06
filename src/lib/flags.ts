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
