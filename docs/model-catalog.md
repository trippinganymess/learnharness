# Runtime model catalogs

The harness uses `@earendil-works/pi-ai@1.4.0`'s existing `Models.refresh()`,
`Provider.refreshModels()`, and `ModelsStore`. There is no parallel model
registry, publication queue, or persistence protocol.

## First milestone: OpenRouter and native Radius

- `src/server/stores.ts` injects `createFileModelsStore()` into the process-wide
  Pi collection and installs the OpenRouter discovery adapter.
- `src/store/model-catalog.ts` implements Pi's `ModelsStore`. Cache files live in
  `LH_DATA_DIR/model-catalog/`, use atomic replacement, and contain no API keys.
- Startup restores catalogs with `refresh({ allowNetwork: false })`.
- `GET /api/models` serves restored/bundled data without awaiting upstream
  API-key discovery. Its background trigger calls Pi's `refresh()`.
- `POST /api/models/refresh` forces a background refresh. Effective key changes
  also trigger refresh; environment-owned keys retain their existing precedence.
- Successful publication emits `catalog-changed` through the existing SSE bus.
  The shared client catalog coalesces notifications across readers and refetches
  once on notification or reconnect.
- Server entry points hide cache-readiness ordering; transport routes do not
  import the startup promise directly.
- The existing turn composition root injects the key-change refresh trigger.
  The key module does not import catalog assembly or its storage composition.
- Reconfiguring catalog wiring uses Pi to supersede old refreshes without
  deleting providers from collections held by existing engines.
- Picker DTOs, settings validation, context limits, pricing, and
  `piEngineForSpec()` all read the same Pi provider lists synchronously.

### OpenRouter

`src/server/provider-catalog/openrouter.ts` adds `refreshModels()` to the native
provider, retaining its authentication and streaming methods. It follows
Radius's authoritative-catalog pattern rather than `createProvider.fetchModels`,
whose additive baseline merge cannot remove unavailable bundled models.

The adapter fetches authenticated `/api/v1/models/user`, validates every page,
restricts pagination to the original origin/path, bounds response sizes, and
publishes only a complete catalog through `context.publish({ persist, update })`.
Pi owns generation checks, cancellation, and persistence-before-update.

A successful live catalog controls chat availability. Before any successful
fetch, bundled data is the fallback. Failed requests retain the current key's
last-known-good snapshot. The cache carries a one-way fingerprint of key and
catalog base URL; changing the effective key makes that snapshot ineligible.
The provider skips fresh checks for one hour unless `force` is set.

Exact bundled matches retain their API route, thinking map, and compatibility
metadata. New IDs require text input/output, tool support, positive token
limits, and explicit token/cache prices. Unknown reasoning models are currently
excluded because their precise thinking metadata is not established. Negative
router-alias prices are not represented as free. Dedicated native image and
classifier operations are preserved, but not exposed as chat picker rows.

Pricing conversion and supported prompt-length tiers reuse Pi's
`openRouterCost()`. Time-dependent pricing cannot be represented by Pi's
`ModelCost`; its existing converter uses the reported current base prices.

## Built-in audit

Audited all 42 factories returned by `builtinProviders()` in pinned 1.4.0:

| Classification | Providers | Treatment |
| --- | --- | --- |
| Native live discovery | Radius | Reuse `refreshModels()` unchanged; fetches `/v1/config`, accepts new IDs, restores and replaces through Pi publication. |
| Existing-ID-only helper, not wired | OpenRouter | `personalizeOpenRouterCatalog()` fetches `/models/user` but only maps supplied IDs. The harness adapter adds genuine discovery using the same refresh contract. |
| No runtime discovery | The 40 below | Remain bundled in this milestone. Add documented provider adapters through `refreshModels()` in subsequent work. |

Static providers:

```text
amazon-bedrock, ant-ling, anthropic, azure, baseten, cerebras,
cloudflare-ai-gateway, cloudflare-workers-ai, deepseek, fireworks,
github-copilot, google, google-vertex, groq, huggingface, kimi-coding,
meta, minimax, minimax-cn, mistral, moonshotai, moonshotai-cn, nvidia,
openai, openai-codex, opencode, opencode-go, qwen-token-plan,
qwen-token-plan-cn, qwen-token-plan-individual, together, typesafe,
vercel-ai-gateway, xai, xiaomi, xiaomi-token-plan-ams,
xiaomi-token-plan-cn, xiaomi-token-plan-sgp, zai, zai-coding-cn
```

Subscriptions, Claude Code, and custom-endpoint discovery remain unchanged.
Radius is reused as supplied by Pi, including its own freshness and credential
policies; OpenRouter's one-hour freshness and key fingerprint are not imposed
on the native Radius implementation.

## Proof and regression tests

- `tests/openrouter-live-catalog.test.ts`: an ID absent from the bundle is
  discovered through `Models.refresh()`, accepted by the settings route,
  resolved by `piEngineForSpec()`, and completes a successful native tool-call
  round trip against a closed mocked SSE transport. Also covers cache restore,
  failure retention, key changes, pagination, and authoritative removal.
- `tests/openrouter-live-picker.test.tsx`: the real picker renders and selects a
  newly discovered ID.
- `tests/catalog-refresh-wiring.test.ts`: upstream fetch does not block catalog
  GET; publication notifies clients; native Radius discovery and durable
  restoration use the unchanged provider through Pi's store contract.

- `tests/catalog-engine-lifetime.test.ts`: catalog rewiring preserves engines
  created against the previous native collection.
- `tests/catalog-notification-coalescing.test.tsx`: several readers share one
  catalog request per SSE notification or reconnect.

These are offline transport proofs, not claims that a real account was billed or
that inference against a live provider has been exercised.

## Sources

- Installed package: `node_modules/@earendil-works/pi-ai/dist/models.{js,d.ts}`,
  `models-store.d.ts`, `providers/radius.js`, `providers/openrouter.js`, and
  `providers/all.js`.
- [OpenRouter model schema, pagination, capabilities and pricing](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter model-list reference](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
