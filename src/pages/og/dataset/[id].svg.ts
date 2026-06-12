import type { APIRoute } from "astro";
import logoSvg from "../../../assets/nemar-logo.svg?raw";
import { getDataset, isManagedDatasetId } from "../../../lib/api";
import { getLandingOutcome, getMetadataOutcome, outcomeValue } from "../../../lib/data-api";
import { buildDatasetOgModel, renderDatasetOgSvg } from "../../../lib/og-image";
import { fetchParticipants } from "../../../lib/participants";
import type { Dataset } from "../../../lib/types";

export const GET: APIRoute = async ({ params }) => {
  const id = params.id?.trim();
  if (!id) {
    return new Response(null, { status: 400, headers: noStoreHeaders() });
  }

  const [metadataOut, catalog] = await Promise.all([getMetadataOutcome(id), getCatalog(id)]);
  const metadata = outcomeValue(metadataOut);

  if (!metadata && !catalog) {
    const status = metadataOut.kind === "not_found" ? 404 : 503;
    return new Response(null, { status, headers: noStoreHeaders() });
  }

  const model = buildDatasetOgModel({ id, metadata, catalog });
  if (model.subjects === "Unavailable") {
    const participantCount = await getParticipantCount(id);
    if (participantCount != null) {
      model.subjects = participantCount.toLocaleString("en-US");
    }
  }
  const svg = renderDatasetOgSvg(model, logoSvg);

  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800",
    },
  });
};

async function getCatalog(id: string): Promise<Dataset | null> {
  if (!isManagedDatasetId(id)) return null;
  try {
    return await getDataset(id);
  } catch (err) {
    console.warn(`[og/dataset/${id}] catalog fetch failed`, err);
    return null;
  }
}

async function getParticipantCount(id: string): Promise<number | null> {
  const landing = outcomeValue(await getLandingOutcome(id));
  const version = landing?.latest ?? landing?.versions[0]?.version ?? null;
  if (!version) return null;

  const participants = await fetchParticipants(id, version);
  if (!participants || participants.total <= 0) return null;
  return participants.total;
}

function noStoreHeaders(): Headers {
  return new Headers({ "Cache-Control": "no-store" });
}
