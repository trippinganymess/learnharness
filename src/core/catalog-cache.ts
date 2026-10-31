import { z } from "zod";

const finite = z.number().finite().nonnegative();
const rates = z.object({ input: finite, output: finite, cacheRead: finite, cacheWrite: finite });
const cost = rates.extend({ tiers: z.array(rates.extend({ inputTokensAbove: finite })).optional() });
/** Durable catalogs are untrusted input, just like the upstream response. */
export const cachedModelSchema = z.object({
	id: z.string().min(1), name: z.string().min(1), provider: z.string().min(1),
	api: z.string().min(1), baseUrl: z.url().refine((value) => /^https?:\/\//.test(value)), input: z.array(z.enum(["text", "image"])), cost,
	thinkingLevelMap: z.partialRecord(z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]), z.string().nullable()).optional(),
	type: z.enum(["chat", "image", "classifier"]).optional(),
	reasoning: z.boolean().optional(), contextWindow: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional(),
}).passthrough().superRefine((model, ctx) => {
	if ((!model.type || model.type === "chat") && (model.reasoning === undefined || model.contextWindow === undefined || model.maxTokens === undefined)) {
		ctx.addIssue({ code: "custom", message: "Chat models require reasoning and token limits" });
	}
});
export const cachedCatalogSchema = z.object({
	models: z.array(cachedModelSchema).max(10000), checkedAt: finite.optional(), lastModified: finite.optional(), etag: z.string().optional(),
}).passthrough();
