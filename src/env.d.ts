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
         * `wrangler.toml` / `wrangler.test.toml`. Absent on previews and on any project
         * not wired yet. Under `astro dev` the platform proxy supplies a stub that answers
         * 503, which the middleware ignores. Server calls to the API go over the public
         * network wherever it is absent or ignored.
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
