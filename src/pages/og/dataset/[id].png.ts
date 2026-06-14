import type { APIRoute } from "astro";
import logoSvg from "../../../assets/nemar-logo.svg?raw";
import { getDatasetOgModel, ogCacheControl } from "../../../lib/dataset-og-response";
import { renderDatasetOgSvg } from "../../../lib/og-image";
import { svgToPng } from "../../../lib/svg-to-png";

export const GET: APIRoute = async ({ params, request }) => {
  const model = await getDatasetOgModel(params.id);
  if (model instanceof Response) return model;

  const svg = renderDatasetOgSvg(model, logoSvg);
  const png = await svgToPng(svg, request.url);
  const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": ogCacheControl(),
    },
  });
};
