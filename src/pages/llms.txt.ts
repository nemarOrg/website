import type { APIRoute } from "astro";
import { llmsTxtBody } from "../lib/llms-txt";

/**
 * `/llms.txt` (website#284 phase 6, issue #289). Same body on every host --
 * see `lib/llms-txt.ts` for why, unlike `robots.txt.ts` and `sitemap.xml.ts`,
 * this route has no host gate: it does no upstream fetch, so there is
 * nothing expensive to protect and nothing host-specific to serve.
 */
export const GET: APIRoute = () => {
  return new Response(llmsTxtBody(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
