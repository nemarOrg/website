import logoSvg from "../assets/nemar-logo.svg?raw";
import { getDataset, isManagedDatasetId } from "./api";
import { getLandingOutcome, getMetadataOutcome, outcomeValue } from "./data-api";
import type { DatasetOgModel } from "./og-image";
import { buildDatasetOgModel, renderDatasetOgSvg } from "./og-image";
import { fetchParticipants } from "./participants";
import type { Dataset } from "./types";

export async function datasetOgSvgResponse(id: string | undefined): Promise<Response> {
  const model = await getDatasetOgModel(id);
  if (model instanceof Response) return model;

  return new Response(renderDatasetOgSvg(model, logoSvg), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": ogCacheControl(),
    },
  });
}

export async function getDatasetOgModel(
  id: string | undefined,
): Promise<DatasetOgModel | Response> {
  const datasetId = id?.trim();
  if (!datasetId) {
    return new Response(null, { status: 400, headers: noStoreHeaders() });
  }

  const [metadataOut, catalog] = await Promise.all([
    getMetadataOutcome(datasetId),
    getCatalog(datasetId),
  ]);
  const metadata = outcomeValue(metadataOut);

  if (!metadata && !catalog) {
    const status = metadataOut.kind === "not_found" ? 404 : 503;
    return new Response(null, { status, headers: noStoreHeaders() });
  }

  const model = buildDatasetOgModel({ id: datasetId, metadata, catalog });
  if (model.subjects === "Unavailable") {
    const participantCount = await getParticipantCount(datasetId);
    if (participantCount != null) {
      model.subjects = participantCount.toLocaleString("en-US");
    }
  }

  return model;
}

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

export function ogCacheControl(): string {
  return "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800";
}
