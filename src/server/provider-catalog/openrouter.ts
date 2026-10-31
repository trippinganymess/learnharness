import { createHash } from "node:crypto";
import { z } from "zod";
import { isModelType, type Api, type Model, type ModelsStoreEntry, type Provider, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { openRouterCost } from "@earendil-works/pi-ai/providers/openrouter-api";
import { cachedCatalogSchema } from "../../core/catalog-cache.ts";
import { readBoundedJson } from "../custom-provider-body.ts";

const positive = z.number().int().positive();
const tokenPrice = z.string().regex(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/).refine((value) => Number.isFinite(Number(value) * 1000000));
const priceRates = z.object({ prompt: tokenPrice, completion: tokenPrice, input_cache_read: tokenPrice.optional(), input_cache_write: tokenPrice.optional() });
const prices = priceRates.extend({ overrides: z.array(priceRates.partial().extend({
	min_prompt_tokens: positive.optional(), utc_start: z.number().int().optional(), utc_end: z.number().int().optional(), utc_days: z.array(z.string()).optional(),
}).passthrough()).optional() }).passthrough();
const effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const reasoningSchema = z.object({ supported_efforts: z.array(effort).nullable().optional(), mandatory: z.boolean().optional() });
const rowSchema = z.object({
	id: z.string().min(1), name: z.string().min(1), context_length: positive.nullish(),
	architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
	supported_parameters: z.array(z.string()),
	top_provider: z.object({ context_length: positive.nullish(), max_completion_tokens: positive.nullish() }).nullish(),
	pricing: prices,
	reasoning: reasoningSchema.nullish(),
});
const pageSchema = z.object({ data: z.array(rowSchema).max(10000), links: z.object({ next: z.string().nullable() }).optional(), total_count: z.number().int().nonnegative().optional() });
const scopeFor = (key: string, baseUrl: string) => createHash("sha256").update(JSON.stringify([key, baseUrl])).digest("hex");

/** Radius-style authoritative catalog, using Pi's auth, refresh and publication. */
export function withOpenRouterDiscovery(native: Provider, readKey: () => string | undefined): Provider {
	const baseUrl = native.baseUrl ?? "https://openrouter.ai/api/v1";
	let snapshot: readonly Model<Api>[] | undefined;
	let scope: string | undefined;
	let checkedAt = 0;
	const baseline = native.getModels();
	const currentScope = () => { const key = readKey(); return key ? scopeFor(key, baseUrl) : undefined; };
	const current = () => scope && scope === currentScope() && snapshot ? snapshot : baseline;
	return {
		...native,
		getModels: current,
		// Dedicated image/classifier operations stay native, never become chat picker entries.
		getAllModels: () => [...(native.getAllModels?.() ?? []).filter((model) => !isModelType(model, "chat")), ...current()],
		async refreshModels(context) {
			const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			const expected = key ? scopeFor(key, baseUrl) : currentScope();
			const stored = cachedCatalogSchema.safeParse(context.stored);
			const storedModelValid = (model: z.infer<typeof cachedCatalogSchema>["models"][number]) => {
				const donor = baseline.find((entry) => entry.id === model.id);
				return model.provider === native.id && (!model.type || model.type === "chat") &&
					model.api === (donor?.api ?? "openai-completions") && model.baseUrl === (donor?.baseUrl ?? baseUrl);
			};
			if (stored.success && stored.data.scope === expected && stored.data.models.every(storedModelValid)) {
				const models = stored.data.models as Model<Api>[];
				if (!(await context.publish({ update: () => { snapshot = models; scope = expected; checkedAt = stored.data.checkedAt ?? 0; } }))) return;
			}
			if (!context.allowNetwork || !key || context.signal.aborted) return;
			if (!context.force && scope === expected && Date.now() - checkedAt < 60 * 60 * 1000) return;
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15000)]);
			const first = new URL(`${baseUrl.replace(/\/+$/, "")}/models/user`);
			let next: URL | undefined = first;
			const visited = new Set<string>();
			const byId = new Map<string, Model<Api>>();
			let rows = 0;
			while (next) {
				if (next.origin !== first.origin || next.pathname !== first.pathname || visited.has(next.href) || visited.size >= 100) throw new Error("Invalid OpenRouter catalog pagination");
				visited.add(next.href);
				const response = await fetch(next, { headers: { accept: "application/json", authorization: `Bearer ${key}` }, signal, redirect: "manual" });
				if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenRouter catalog returned HTTP ${response.status}`); }
				const page = pageSchema.parse(await readBoundedJson(response, 8 * 1024 * 1024));
				rows += page.data.length;
				if (rows > 10000) throw new Error("OpenRouter catalog exceeds 10000 models");
				if (page.total_count !== undefined && !page.links?.next && rows !== page.total_count) throw new Error("Incomplete OpenRouter catalog");
				for (const row of page.data) {
					// Router aliases advertise -1 when their eventual model determines price.
					// Do not turn unknown rates into a misleading zero-price runnable entry.
					if (Object.values(row.pricing).some((value) => typeof value === "string" && Number(value) < 0)) continue;
					if (!row.supported_parameters.includes("tools") || !row.architecture.output_modalities.includes("text") || !row.architecture.input_modalities.includes("text")) continue;
					const donor = baseline.find((model) => model.id === row.id);
					const contextWindow = row.top_provider?.context_length ?? row.context_length ?? donor?.contextWindow;
					const maxTokens = row.top_provider?.max_completion_tokens ?? donor?.maxTokens;
					const reasoning = row.supported_parameters.includes("reasoning");
					let thinkingLevelMap = donor?.thinkingLevelMap;
					if (reasoning && !donor) {
						const supported = row.reasoning?.supported_efforts;
						if (supported === undefined) continue;
						const allowed = supported ?? effort.options;
						thinkingLevelMap = Object.fromEntries(effort.options.map((level) => [
							level === "none" ? "off" : level,
							allowed.includes(level) && !(level === "none" && row.reasoning?.mandatory) ? level : null,
						])) as ThinkingLevelMap;
					}
					if (!contextWindow || !maxTokens) continue;
					if (byId.has(row.id)) throw new Error("Duplicate OpenRouter model ID");
					const cost = openRouterCost({ ...row.pricing,
						overrides: row.pricing.overrides?.filter((override) => Object.keys(override).every((field) => ["prompt", "completion", "input_cache_read", "input_cache_write", "min_prompt_tokens", "utc_start", "utc_end", "utc_days"].includes(field))),
						input_cache_read: row.pricing.input_cache_read ?? (donor ? String(donor.cost.cacheRead / 1000000) : undefined),
						input_cache_write: row.pricing.input_cache_write ?? (donor ? String(donor.cost.cacheWrite / 1000000) : undefined),
					});
					byId.set(row.id, {
						...donor, id: row.id, name: row.name, provider: native.id,
						api: donor?.api ?? "openai-completions", baseUrl: donor?.baseUrl ?? baseUrl,
						type: "chat", reasoning: donor?.reasoning ?? reasoning,
						...(thinkingLevelMap ? { thinkingLevelMap } : {}),
						input: row.architecture.input_modalities.includes("image") ? ["text", "image"] : ["text"],
						contextWindow, maxTokens,
						cost,
					});
				}
				next = page.links?.next ? new URL(page.links.next, first) : undefined;
			}
			signal.throwIfAborted();
			if (currentScope() !== expected) return;
			const models = [...byId.values()];
			const entry: ModelsStoreEntry & { scope: string | undefined } = { models, checkedAt: Date.now(), scope: expected };
			await context.publish({ persist: entry, update: () => {
				if (currentScope() === expected) { snapshot = models; scope = expected; checkedAt = Date.now(); }
			} });
		},
	};
}
