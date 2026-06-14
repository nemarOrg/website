import type { APIRoute } from "astro";
import { datasetOgSvgResponse } from "../../../lib/dataset-og-response";

export const GET: APIRoute = ({ params }) => datasetOgSvgResponse(params.id);
