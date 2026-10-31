import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { withOpenRouterDiscovery } from "../src/server/provider-catalog/openrouter.ts";
import { toModelDto } from "../src/server/model-catalog.ts";
import { ModelMenuList } from "../components/settings/model-menu.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

test("the real model picker selects an OpenRouter ID discovered through Pi refresh, absent from the bundle", async () => {
	const fetch = globalThis.fetch;
	const models = createModels({ authContext: { env: async () => "synthetic-ui-key", fileExists: async () => false } });
	models.setProvider(withOpenRouterDiscovery(openrouterProvider(), () => "synthetic-ui-key"));
	const id = "catalog-fixture/ui-discovered";
	assert.equal(models.getModel("openrouter", id), undefined);
	globalThis.fetch = async () => Response.json({ data: [{
		id, name: "Discovered UI model", context_length: 8192,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"],
		top_provider: { max_completion_tokens: 1024 },
		pricing: { prompt: "0", completion: "0", input_cache_read: "0", input_cache_write: "0" },
	}] });
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		assert.equal((await models.refresh()).errors.size, 0);
		let picked: string | undefined;
		await act(async () => root.render(<ModelMenuList models={models.getModels("openrouter").map(toModelDto)} effectiveId={undefined} onPick={(model) => { picked = `${model.provider}:${model.id}`; }} />));
		const button = host.querySelector<HTMLElement>('[data-testid="model-option-catalog-fixture_ui-discovered"]');
		assert.ok(button);
		await act(async () => button.click());
		assert.equal(picked, `openrouter:${id}`);
	} finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = fetch; }
});
