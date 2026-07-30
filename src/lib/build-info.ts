/**
 * Build identity for the running deploy (website#214).
 *
 * Both values are compile-time constant substitutions from
 * `astro.config.mjs`'s `vite.define`, not module imports — same mechanism as
 * `__EDGE_CACHE_NAMESPACE__` in `src/middleware.ts`. The `typeof` guards
 * matter for consumers that compile this file without those defines in place
 * (vitest, a bare `tsc`), where a bare reference would throw a
 * ReferenceError at module load and take the whole request down with it.
 */
declare const __APP_VERSION__: string | undefined;
declare const __BUILD_REF__: string | undefined;

/**
 * Version from `package.json` at build time.
 *
 * On `staging` this always carries a `-devN` suffix; on `main` it is a clean
 * `X.Y.Z` that matches a `vX.Y.Z` git tag and GitHub Release. `"0.0.0"` means
 * the define was missing, which should only ever happen outside a real build.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/**
 * Short commit SHA for this build, or `"dev"` for a local `astro dev` run
 * (neither `CF_PAGES_COMMIT_SHA` nor `GITHUB_SHA` is set there).
 */
export const BUILD_REF: string = typeof __BUILD_REF__ === "string" ? __BUILD_REF__ : "dev";

/**
 * Single-line build identity, e.g. `1.0.0-dev3+a1b2c3d4`.
 *
 * The `+` follows semver's build-metadata separator, so the string stays a
 * valid semver even though the ref is not part of version ordering.
 */
export const BUILD_ID = `${APP_VERSION}+${BUILD_REF}`;

/** Structured form, for `/version.json`. */
export interface BuildInfo {
  version: string;
  commit: string;
  buildId: string;
}

export function buildInfo(): BuildInfo {
  return { version: APP_VERSION, commit: BUILD_REF, buildId: BUILD_ID };
}
