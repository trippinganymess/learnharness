import { loadModelCatalog } from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Serve the
 * restored catalog immediately; upstream API-key discovery runs asynchronously.
 */
export async function GET() {
	return Response.json(await loadModelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
