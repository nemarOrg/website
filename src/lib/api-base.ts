/**
 * Resolves the api.nemar.org base URL at call time. `PUBLIC_API_BASE_URL`
 * overrides the default; set in `wrangler.toml` for production and preview
 * deploys, and overridable via .env for local dev that wants to hit a
 * non-prod backend.
 */
const DEFAULT_API_BASE = "https://api.nemar.org";

export function apiBase(): string {
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_API_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_API_BASE).replace(/\/$/, "");
}
