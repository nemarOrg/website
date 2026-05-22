/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  interface Locals {
    runtime?: {
      env?: Record<string, string | undefined>;
      ctx?: { waitUntil?: (p: Promise<unknown>) => void };
      caches?: CacheStorage;
    };
    session: import("./lib/auth").AuthSession | null;
  }
}
