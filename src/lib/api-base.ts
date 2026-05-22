/**
 * Resolves the api.nemar.org base URL at call time. Public env var
 * `PUBLIC_API_BASE_URL` overrides the default (set in `wrangler.toml` for
 * production and preview deploys; can also be overridden via .env for
 * local dev that wants to hit a non-prod backend).
 */
const DEFAULT_API_BASE = "https://api.nemar.org";

export function apiBase(envOverride?: string): string {
  if (envOverride) return envOverride.replace(/\/$/, "");
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_API_BASE_URL) || null;
  return (fromEnv ?? DEFAULT_API_BASE).replace(/\/$/, "");
}
