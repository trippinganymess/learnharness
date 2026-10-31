import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-wiring-"));
const env = process.env;
const fetch = globalThis.fetch;
process.env = { NODE_ENV: "test", HOME: directory, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), OPENROUTER_API_KEY: "synthetic-wiring-key" };
const { catalogReady } = await import("../src/server/stores.ts");
const { GET } = await import("../app/api/models/route.ts");
const { subscribe } = await import("../src/core/events.ts");
const { createFileModelsStore } = await import("../src/store/model-catalog.ts");
after(() => { process.env = env; globalThis.fetch = fetch; fs.rmSync(directory, { recursive: true, force: true }); });

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("GET serves the synchronous catalog before an upstream response; publication notifies the picker", async () => {
	await catalogReady;
	const started = deferred<void>();
	const upstream = deferred<Response>();
	const published = deferred<void>();
	const off = subscribe((event) => { if (event.type === "catalog-changed") published.resolve(); });
	globalThis.fetch = async (input) => {
		assert.equal(String(input), "https://openrouter.ai/api/v1/models/user");
		started.resolve();
		return upstream.promise;
	};
	try {
		const response = await GET();
		assert.equal(response.status, 200);
		const before = await response.json();
		assert.ok(!before.models.some((model: { id: string }) => model.id === "catalog-fixture/background"));
		await started.promise;
		upstream.resolve(Response.json({ data: [{
			id: "catalog-fixture/background", name: "Background discovery", context_length: 8192,
			architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"],
			top_provider: { max_completion_tokens: 1024 }, pricing: { prompt: "0", completion: "0", input_cache_read: "0", input_cache_write: "0" },
		}] }));
		await published.promise;
		const after = await (await GET()).json();
		assert.ok(after.models.some((model: { id: string }) => model.id === "catalog-fixture/background"));
	} finally { off(); }
});

test("Radius native refresh is reused unchanged and restores through the injected Pi ModelsStore", async () => {
	const modelsStore = createFileModelsStore(path.join(directory, "radius-catalog"));
	const options = { modelsStore, authContext: { env: async (name: string) => name === "RADIUS_API_KEY" ? "synthetic-radius-key" : undefined, fileExists: async () => false } };
	const models = createModels(options);
	models.setProvider(radiusProvider());
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://radius.pi.dev/v1/config");
		assert.equal(request.headers.get("authorization"), "Bearer synthetic-radius-key");
		return Response.json({ baseUrl: "https://radius.pi.dev/v1", models: [{
			id: "catalog-fixture/radius-new", name: "Radius discovery", input: ["text"], reasoning: false,
			contextWindow: 8192, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		}] });
	};
	assert.equal((await models.refresh({ providers: ["radius"] })).errors.size, 0);
	assert.equal(models.getModel("radius", "catalog-fixture/radius-new")?.api, "pi-messages");
	const restored = createModels(options); restored.setProvider(radiusProvider());
	globalThis.fetch = async () => { throw new Error("offline restore must not fetch"); };
	assert.equal((await restored.refresh({ allowNetwork: false })).errors.size, 0);
	assert.ok(restored.getModel("radius", "catalog-fixture/radius-new"));
});
