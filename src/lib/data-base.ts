/**
 * Single source of truth for the data-plane base URL.
 *
 * `PUBLIC_DATA_BASE_URL` is baked per environment at build time
 * (`data.nemar.org` on production, `data-test.nemar.org` on staging), so every
 * client-side data fetch — the file tree, the demographics panel, the QA
 * aggregates — must resolve through here rather than hardcoding the production
 * host. A hardcoded default meant staging fetched production, 404'd on the
 * exemplar ids, and rendered "File index unavailable"/"no participants".
 *
 * Falls back to production when the env var is absent (SSR without the var,
 * or a stray import path) so production behaviour is unchanged.
 */
const PROD_DATA_BASE = "https://data.nemar.org";

export function resolveDataBase(envOverride?: string): string {
  if (envOverride) return envOverride.replace(/\/$/, "");
  const fromEnv =
    (typeof import.meta.env !== "undefined" && import.meta.env.PUBLIC_DATA_BASE_URL) || null;
  return (fromEnv ?? PROD_DATA_BASE).replace(/\/$/, "");
}
