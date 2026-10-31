import { requestApiKeyCatalogRefresh } from "@/src/server";

/** Force a background Pi refresh; the SSE notification prompts a fresh GET. */
export async function POST() {
	requestApiKeyCatalogRefresh(undefined, true);
	return Response.json({ refreshing: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
