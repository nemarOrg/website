// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

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
    resolve: {
      // Workaround for Cloudflare Workers' lack of `Buffer` etc.
      alias: import.meta.env?.PROD
        ? { "react-dom/server": "react-dom/server.edge" }
        : undefined,
    },
  },
});
