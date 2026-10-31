import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createModels, normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-openrouter-live-"));
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
process.env = { NODE_ENV: "test", HOME: directory, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), OPENROUTER_API_KEY: "synthetic-catalog-key" };
const { piModels, piEngineForSpec } = await import("../src/agent/models.ts");
const { modelCatalog } = await import("../src/server/model-catalog.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { effectiveSettings, catalogReady } = await import("../src/server/stores.ts");
const { createFileModelsStore } = await import("../src/store/model-catalog.ts");
const { withOpenRouterDiscovery } = await import("../src/server/provider-catalog/openrouter.ts");
const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");

const discoveredId = "catalog-fixture/absent-from-bundle";
const remoteModel = {
	id: discoveredId, name: "Discovered tool model", context_length: 32768,
	architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
	supported_parameters: ["tools", "tool_choice", "max_tokens"],
	top_provider: { context_length: 32768, max_completion_tokens: 4096 },
	pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0", input_cache_write: "0", request: "0" },
};
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });

function completion(tool: boolean): Response {
	const delta = tool
		? { role: "assistant", tool_calls: [{ index: 0, id: "call_catalog", type: "function", function: { name: "catalog_tool", arguments: "{}" } }] }
		: { role: "assistant", content: "Catalog model completed successfully." };
	const chunks = [
		{ id: "chatcmpl_catalog", object: "chat.completion.chunk", created: 1, model: discoveredId, choices: [{ index: 0, delta, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
	];
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

test("a new OpenRouter ID refreshed through Pi is selectable, saved, and completes a native tool-call round trip", async () => {
	await catalogReady;
	assert.equal(piModels().getModel("openrouter", discoveredId), undefined, "fixture must be absent from the bundle");
	let operations = 0;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.headers.get("authorization"), "Bearer synthetic-catalog-key");
		if (request.method === "GET") {
			assert.equal(request.url, "https://openrouter.ai/api/v1/models/user");
			return Response.json({ data: [remoteModel], links: { next: null }, total_count: 1 });
		}
		assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
		const body = await request.json();
		assert.equal(body.model, discoveredId);
		assert.match(JSON.stringify(body.tools), /catalog_tool/);
		if (operations) assert.match(JSON.stringify(body.messages), /tool completed/);
		return completion(operations++ === 0);
	};
	const result = await piModels().refresh({ providers: ["openrouter"], force: true });
	assert.equal(result.errors.size, 0);
	const listed = modelCatalog().models.find((model) => model.provider === "openrouter" && model.id === discoveredId);
	assert.ok(listed, "refresh must publish the new ID into the picker's registry");
	assert.deepEqual(listed.input, ["text", "image"]);
	assert.deepEqual(listed.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
	assert.equal(listed.contextWindow, 32768);
	const response = await PUT(new Request("http://localhost/api/settings/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ strong: { model: { provider: "openrouter", id: discoveredId } } }) }), { params: Promise.resolve({ section: "models" }) });
	assert.equal(response.status, 200, await response.text());
	const engine = piEngineForSpec(effectiveSettings().models.strong!);
	const tools = [{ name: "catalog_tool", description: "Catalog proof", parameters: Type.Object({}) }];
	const user = { role: "user" as const, content: "Use the catalog tool.", timestamp: 1 };
	const first = await engine.streamFn(engine.model, normalizeContext({ messages: [user], tools }), {}).result();
	assert.equal(first.stopReason, "toolUse");
	assert.ok(first.content.some((part) => part.type === "toolCall" && part.name === "catalog_tool"));
	const final = await engine.streamFn(engine.model, normalizeContext({ messages: [user, first, { role: "toolResult", toolCallId: "call_catalog", toolName: "catalog_tool", content: [{ type: "text", text: "tool completed" }], isError: false, timestamp: 2 }], tools }), {}).result();
	assert.equal(final.stopReason, "stop");
	assert.ok(final.content.some((part) => part.type === "text" && part.text === "Catalog model completed successfully."));
	assert.equal(operations, 2);
});


test("fresh collections restore the same account catalog offline and retain it when a refresh fails", async () => {
	const models = createModels({ modelsStore: createFileModelsStore(path.join(directory, "model-catalog")) });
	models.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	globalThis.fetch = async () => { throw new Error("offline"); };
	assert.equal((await models.refresh({ allowNetwork: false })).errors.size, 0);
	assert.ok(models.getModel("openrouter", discoveredId));
	assert.equal((await models.refresh({ force: true })).errors.has("openrouter"), true);
	assert.ok(models.getModel("openrouter", discoveredId));
	process.env.OPENROUTER_API_KEY = "synthetic-different-account";
	assert.equal(models.getModel("openrouter", discoveredId), undefined, "another key must not inherit the old live catalog");
	await models.refresh({ allowNetwork: false });
	assert.equal(models.getModel("openrouter", discoveredId), undefined);
	process.env.OPENROUTER_API_KEY = "synthetic-catalog-key";
});

test("all pages publish together, and an invalid later page cannot replace last-known-good models", async () => {
	globalThis.fetch = async (input) => {
		const url = new URL(String(input));
		if (!url.search) return Response.json({ data: [remoteModel], links: { next: "/api/v1/models/user?offset=1" } });
		return Response.json({ data: [{ ...remoteModel, id: "catalog-fixture/page-two" }], links: { next: null } });
	};
	assert.equal((await piModels().refresh({ providers: ["openrouter"], force: true })).errors.size, 0);
	assert.ok(piModels().getModel("openrouter", "catalog-fixture/page-two"));
	globalThis.fetch = async (input) => new URL(String(input)).search
		? Response.json({ data: [{ id: "broken" }] })
		: Response.json({ data: [], links: { next: "/api/v1/models/user?offset=1" } });
	assert.equal((await piModels().refresh({ providers: ["openrouter"], force: true })).errors.has("openrouter"), true);
	assert.ok(piModels().getModel("openrouter", discoveredId));
	assert.ok(piModels().getModel("openrouter", "catalog-fixture/page-two"));
});

test("successful live absence is authoritative, and unsupported/incomplete rows are never admitted", async () => {
	globalThis.fetch = async () => Response.json({ data: [
		{ ...remoteModel, id: "catalog-fixture/no-tools", supported_parameters: [] },
		{ ...remoteModel, id: "catalog-fixture/no-limits", context_length: null, top_provider: null },
		{ ...remoteModel, id: "catalog-fixture/unknown-thinking", supported_parameters: ["tools", "reasoning"] },
	] });
	assert.equal((await piModels().refresh({ providers: ["openrouter"], force: true })).errors.size, 0);
	assert.deepEqual(piModels().getModels("openrouter"), []);
	assert.throws(() => piEngineForSpec({ provider: "openrouter", id: discoveredId }), /catalog has no model/);
});

test("Particle-1's real catalog metadata is selectable with published reasoning efforts and optional cache pricing", async () => {
	const particle = JSON.parse(fs.readFileSync(new URL("./fixtures/openrouter-particle-1.json", import.meta.url), "utf8"));
	const models = createModels();
	models.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	assert.equal(models.getModel("openrouter", particle.id), undefined);
	globalThis.fetch = async () => Response.json({ data: [particle] });
	assert.equal((await models.refresh({ force: true })).errors.size, 0);
	const model = models.getModel("openrouter", particle.id);
	assert.ok(model, "Particle's advertised reasoning and optional pricing must not exclude it");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 1048576);
	assert.equal(model.maxTokens, 131072);
	assert.deepEqual(model.cost, { input: 0.05, output: 0.5, cacheRead: 0.003, cacheWrite: 0 });
	assert.deepEqual(model.thinkingLevelMap, { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
		const payload = await request.json();
		assert.equal(payload.model, particle.id);
		assert.deepEqual(payload.reasoning, { effort: "high" });
		return completion(false);
	};
	assert.equal((await models.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 0 }] }), { reasoning: "high" }).result()).stopReason, "stop");
});

test("published reasoning efforts restrict selectors, respect mandatory reasoning, and accept null as all efforts", async () => {
	const models = createModels();
	models.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	globalThis.fetch = async () => Response.json({ data: [
		{ ...remoteModel, id: "catalog-fixture/mandatory", supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["high", "none"], mandatory: true } },
		{ ...remoteModel, id: "catalog-fixture/all-efforts", supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: null, mandatory: false } },
	] });
	assert.equal((await models.refresh()).errors.size, 0);
	assert.deepEqual(models.getModel("openrouter", "catalog-fixture/mandatory")?.thinkingLevelMap, { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
	assert.deepEqual(models.getModel("openrouter", "catalog-fixture/all-efforts")?.thinkingLevelMap, { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("a superseded refresh cannot publish late data, even when its transport ignores cancellation", async () => {
	const started = deferred<void>();
	const stale = deferred<Response>();
	globalThis.fetch = async () => { started.resolve(); return stale.promise; };
	const old = piModels().refresh({ providers: ["openrouter"], force: true });
	await started.promise;
	globalThis.fetch = async () => Response.json({ data: [{ ...remoteModel, id: "catalog-fixture/newest" }] });
	assert.equal((await piModels().refresh({ providers: ["openrouter"], force: true })).errors.size, 0);
	stale.resolve(Response.json({ data: [{ ...remoteModel, id: "catalog-fixture/stale" }] }));
	await old;
	assert.ok(piModels().getModel("openrouter", "catalog-fixture/newest"));
	assert.equal(piModels().getModel("openrouter", "catalog-fixture/stale"), undefined);
	const restored = createModels({ modelsStore: createFileModelsStore(path.join(directory, "model-catalog")) });
	restored.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	await restored.refresh({ allowNetwork: false });
	assert.ok(restored.getModel("openrouter", "catalog-fixture/newest"));
	assert.equal(restored.getModel("openrouter", "catalog-fixture/stale"), undefined);
});

test("known models retain partial thinking maps through durable restoration and native routing", async () => {
	const native = openrouterProvider().getModels().find((model) => model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length < 7);
	assert.ok(native);
	globalThis.fetch = async () => Response.json({ data: [{ ...remoteModel, id: native.id, supported_parameters: ["tools", "reasoning"] }] });
	assert.equal((await piModels().refresh({ providers: ["openrouter"], force: true })).errors.size, 0);
	const refreshed = piModels().getModel("openrouter", native.id);
	assert.ok(refreshed);
	assert.equal(refreshed.api, native.api);
	assert.equal(refreshed.baseUrl, native.baseUrl);
	assert.deepEqual(refreshed.thinkingLevelMap, native.thinkingLevelMap);
	const restored = createModels({ modelsStore: createFileModelsStore(path.join(directory, "model-catalog")) });
	restored.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	await restored.refresh({ allowNetwork: false });
	assert.deepEqual(restored.getModel("openrouter", native.id)?.thinkingLevelMap, native.thinkingLevelMap);
});

test("pagination cannot send a credential to a foreign host, and redirects cannot replace the catalog", async () => {
	const before = piModels().getModels("openrouter");
	globalThis.fetch = async (input) => {
		assert.equal(new URL(String(input)).origin, "https://openrouter.ai");
		return Response.json({ data: [remoteModel], links: { next: "https://untrusted.invalid/models" } });
	};
	assert.equal((await piModels().refresh({ providers: ["openrouter"], force: true })).errors.has("openrouter"), true);
	assert.deepEqual(piModels().getModels("openrouter"), before);
	globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/models" } });
	assert.equal((await piModels().refresh({ providers: ["openrouter"], force: true })).errors.has("openrouter"), true);
	assert.deepEqual(piModels().getModels("openrouter"), before);
});

test("key rotation during discovery cannot persist or publish the previous account's response", async () => {
	const models = createModels({ modelsStore: createFileModelsStore(path.join(directory, "rotation-catalog")) });
	models.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	const started = deferred<void>();
	const upstream = deferred<Response>();
	globalThis.fetch = async () => { started.resolve(); return upstream.promise; };
	const pending = models.refresh({ force: true });
	await started.promise;
	process.env.OPENROUTER_API_KEY = "synthetic-rotated-account";
	upstream.resolve(Response.json({ data: [remoteModel] }));
	await pending;
	assert.equal(models.getModel("openrouter", discoveredId), undefined);
	process.env.OPENROUTER_API_KEY = "synthetic-catalog-key";
	const restored = createModels({ modelsStore: createFileModelsStore(path.join(directory, "rotation-catalog")) });
	restored.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	await restored.refresh({ allowNetwork: false });
	assert.equal(restored.getModel("openrouter", discoveredId), undefined, "late account response must not have reached durable storage");
});

test("reported incomplete totals retain last-known-good data and fresh catalogs skip network until forced", async () => {
	const models = createModels();
	models.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => process.env.OPENROUTER_API_KEY));
	globalThis.fetch = async () => Response.json({ data: [remoteModel], total_count: 1, links: { next: null } });
	assert.equal((await models.refresh()).errors.size, 0);
	globalThis.fetch = async () => { throw new Error("fresh catalog must not fetch"); };
	assert.equal((await models.refresh()).errors.size, 0);
	globalThis.fetch = async () => Response.json({ data: [], total_count: 2, links: { next: null } });
	assert.equal((await models.refresh({ force: true })).errors.has("openrouter"), true);
	assert.ok(models.getModel("openrouter", discoveredId));
});
