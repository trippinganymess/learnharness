import assert from "node:assert/strict";
import React, { act } from "react";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
function Reader() { useModelCatalog(); return null; }

test("multiple picker readers share one GET per catalog notification and reconnect", async () => {
	const originalFetch = globalThis.fetch;
	const callbacks = new Map<string, (raw: string) => void>();
	let open = () => {};
	let gets = 0;
	globalThis.fetch = async (input) => {
		assert.equal(input, "/api/models");
		gets++;
		return Response.json({ models: [], providers: [], defaults: null, rolePins: {}, slots: {} });
	};
	const connect = (): NotifySource => ({ close() {}, onOpen(callback) { open = callback; }, onEvent(name, callback) { callbacks.set(name, callback); } });
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<ServerEventsProvider connect={connect}><Reader /><Reader /><Reader /></ServerEventsProvider>));
		const before = gets;
		await act(async () => callbacks.get("catalog-changed")!("{}"));
		assert.equal(gets - before, 1);
		await act(async () => open());
		assert.equal(gets - before, 2);
	} finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; }
});
