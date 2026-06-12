import type { APIRoute } from "astro";
import { datasetOgResponse } from "../../../lib/dataset-og-response";

export const GET: APIRoute = ({ params }) => datasetOgResponse(params.id);
