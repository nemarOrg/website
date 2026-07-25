// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

/**
 * Short commit ref for the current build, or `"dev"` when there isn't one.
 *
 * Read through `globalThis` rather than a bare `process.env` on purpose: this
 * file is `@ts-check`ed and the project intentionally ships no
 * `@types/node`. A bare `process` typechecks locally — something in the
 * dependency tree supplies the global — but fails `astro check` on a clean
 * CI install with "Cannot find name 'process'". Going through a cast keeps
 * it green in both.
 *
 * @returns {string}
 */
function buildRef() {
  const env = /** @type {{ process?: { env?: Record<string, string | undefined> } }} */ (
    globalThis
  ).process?.env;
  const sha = env?.CF_PAGES_COMMIT_SHA ?? env?.GITHUB_SHA;
  return sha ? sha.slice(0, 8) : "dev";
}

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: cloudflare({
    // 'passthrough' keeps sharp out of the worker entirely. We don't use
    // Astro's <Image> component — all hero/logo assets are static SVG/JPG in
    // /public served as-is. 'compile' still pulled sharp into the SSR bundle
    // (deploy failure: `process.report.getReport is not implemented` in the
    // Workers runtime).
    imageService: "passthrough",
  }),
  // We don't use <Image> / astro:assets anywhere — all images are plain <img>
  // referencing /public/*.{svg,jpg,png}. The default image service still ships
  // sharp into the SSR bundle, which the Cloudflare Workers runtime can't
  // execute (sharp needs native bindings + node:process internals). The noop
  // service is a Workers-safe replacement.
  image: {
    service: { entrypoint: "astro/assets/services/noop" },
  },
  // Where the marketing build is actually served. Keep in lockstep with
  // `MARKETING_BASE_URL` in `src/lib/host.ts` — both flip to `https://nemar.org`
  // at apex DNS cutover. Used by Astro for sitemap/RSS-style absolute URLs;
  // per-page `<link rel="canonical">` and `og:url` are derived from the request
  // hostname in `src/layouts/Base.astro` so app-host pages get the right origin.
  site: "https://ww2.nemar.org",
  trailingSlash: "ignore",
  experimental: {
    clientPrerender: true,
  },
  vite: {
    define: {
      // Edge-cache namespace, fixed at build time (website#188).
      //
      // `src/middleware.ts` caches marketing HTML in `caches.default`. The
      // cached artifact is the page HTML, which carries component markup and
      // the hashed asset URLs — so without a per-build namespace every
      // deploy stays invisible on the marketing surface until the entry
      // expires, which is up to 12 h on the landing page and 24 h on dataset
      // detail. Deriving the name from the commit means a deploy invalidates
      // by construction rather than by someone remembering to bump a
      // constant.
      //
      // `CF_PAGES_COMMIT_SHA` is set by Cloudflare Pages builds and
      // `GITHUB_SHA` by Actions; local `astro dev` has neither and gets a
      // stable "dev" so repeated local runs share one namespace.
      __EDGE_CACHE_NAMESPACE__: JSON.stringify(`nemar-edge-${buildRef()}`),
    },
    resolve: {
      // Workaround for Cloudflare Workers' lack of `Buffer` etc.
      alias: import.meta.env?.PROD
        ? { "react-dom/server": "react-dom/server.edge" }
        : undefined,
    },
  },
});
