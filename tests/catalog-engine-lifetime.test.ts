import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { InMemoryModelsStore, normalizeContext } from "@earendil-works/pi-ai";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-catalog-lifetime-"));
const previous = process.env;
process.env = { NODE_ENV: "test", HOME: directory, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), OPENAI_API_KEY: "synthetic-lifetime-key" };
const { piModels, piEngineForSpec, configureCatalogSource } = await import("../src/agent/models.ts");
const { catalogReady } = await import("../src/server/stores.ts");
after(() => { process.env = previous; fs.rmSync(directory, { recursive: true, force: true }); });

test("catalog reconfiguration preserves existing engines' native provider collection", async () => {
	await catalogReady;
	const original = piModels();
	const engine = piEngineForSpec({ provider: "openai", id: "gpt-4o-mini" });
	configureCatalogSource({ modelsStore: new InMemoryModelsStore(), provider: (native) => native });
	assert.notEqual(piModels(), original);
	assert.ok(original.getProvider("openai"));
	const result = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "Offline lifetime proof", timestamp: 0 }] }), {
		onPayload() { throw new Error("CATALOG_LIFETIME_SENTINEL"); },
	}).result();
	assert.equal(result.errorMessage, "CATALOG_LIFETIME_SENTINEL", "old engine must reach native serialization, not fail Unknown provider");
});
