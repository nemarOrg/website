import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ params, request }) => {
  const datasetId = params.id?.trim();
  if (!datasetId) {
    return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const target = new URL(
    `/og/dataset-card/${encodeURIComponent(datasetId)}.png`,
    request.url,
  ).toString();

  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      "Cache-Control": "public, max-age=300",
    },
  });
};
