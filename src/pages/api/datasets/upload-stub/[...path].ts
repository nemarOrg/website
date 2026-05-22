import type { APIRoute } from "astro";

// MOCK: removed in Phase 5 cutover. In production the presigned URLs returned
// by /api/datasets/create point at real S3; here they point back at this
// route so the upload queue exercises the full XHR PUT codepath in dev.
// The body is read and discarded (no storage); we just confirm receipt.
export const PUT: APIRoute = async ({ request, params }) => {
  if (!import.meta.env.DEV) {
    return new Response("not_implemented", { status: 501 });
  }

  const path = params.path ?? "";
  // Read the body to completion so the XHR sees a clean "load" event with
  // 200 + Content-Length matching what was uploaded.
  const bytes = await consume(request.body);
  console.info(`[datasets/mock] stub PUT received ${bytes} bytes for ${path}`);
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store", "Content-Length": "0" },
  });
};

async function consume(body: ReadableStream<Uint8Array> | null): Promise<number> {
  if (!body) return 0;
  const reader = body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) total += value.byteLength;
  }
  return total;
}
