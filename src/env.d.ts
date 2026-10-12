/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    runtime?: {
      env?: {
        /**
         * Analytics Engine dataset that counts embed calls (ADR 0024), bound in
         * `wrangler.toml` / `wrangler.test.toml`. Absent under `astro dev` and on
         * any deploy without the binding, and the count is skipped then.
         */
        EMBED_ANALYTICS?: import("./lib/embed-analytics").AnalyticsBinding;
        /**
         * Service binding to the API Worker (`src/lib/api-fetch.ts`), declared in
         * `wrangler.toml` / `wrangler.test.toml`. Absent under `astro dev`, on previews
         * and on any project not wired yet, and server calls to the API go over the
         * public network then.
         */
        API?: import("./lib/request-context").ApiBinding;
        [name: string]: unknown;
      };
      ctx?: { waitUntil?: (p: Promise<unknown>) => void };
      caches?: CacheStorage;
    };
    session: import("./lib/auth").AuthSession | null;
  }
}
