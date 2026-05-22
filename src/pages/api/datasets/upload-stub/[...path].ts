import type { APIRoute } from "astro";

// MOCK: removed in Phase 5 cutover. In production the presigned URLs returned
// by /api/datasets/create point at real S3; here they point back at this
// route so the upload queue exercises the full XHR PUT codepath in dev.
//
// We cancel the request body rather than reading it: for multi-GB dev PUTs,
// consuming the stream into memory would OOM the local dev server. Cancel
// signals "discard the rest" while still letting the runtime flush the 200.
export const PUT: APIRoute = async ({ request, params }) => {
  if (!import.meta.env.DEV) {
    return new Response("not_implemented", { status: 501 });
  }

  try {
    await request.body?.cancel();
  } catch (err) {
    // Cancel can throw if the stream is already errored; non-fatal.
    console.warn(`[datasets/mock] stub PUT body cancel failed for ${params.path}`, err);
  }
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store", "Content-Length": "0" },
  });
};
