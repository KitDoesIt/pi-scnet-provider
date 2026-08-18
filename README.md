# pi-scnet-provider

A [pi](https://github.com/earendil-works/pi) coding agent extension that registers the **SCNet** provider against its OpenAI-compatible endpoint:

```
https://api.scnet.cn/api/llm/v1
```

The model list is fetched dynamically from `/models`, so new models appear automatically — no hardcoded catalog to maintain.

## Install

```bash
pi install https://github.com/KitDoesIt/pi-scnet-provider
```

or clone/copy it into `~/.pi/agent/extensions/` for auto-discovery (then use `/reload`).

## Configure

Provide your SCNet API key through one of:

1. **Environment variable** — `export SCNET_API_KEY=sk-tp-...`
2. **pi's auth file** — run `/login scnet` in pi and paste your key

Resolution order: `SCNET_API_KEY` env var → `auth.json` entry → (none).

> Some models may be unavailable on your plan — the endpoint returns `403 The current model does not support Token Plan` for those. Pick a model your plan supports.

## Usage

```bash
pi --provider scnet --model "Kimi-K2.7-Code"
pi --provider scnet --model "DeepSeek-V4-Pro"
```

Or in interactive mode: `/model`, then filter by the `scnet` provider.

## How it works

- **Startup is never blocked by the network.** The cached model list (from `~/.pi/agent/scnet-models.json`) is registered immediately.
- **Always fresh.** A background refresh fetches `/models` on every startup and live-updates the registered models when the list changes.
- **10-minute fetch lock.** The endpoint is not hammered: a persisted `fetchedAt` timestamp plus an in-process guard skip the fetch if it ran less than 10 minutes ago.
- **Cold start.** On the very first run (no cache), the factory performs one bounded fetch (10s timeout) so the model picker works immediately.
- **Fetch failures** keep the current models and log a `[scnet]` error instead of wiping the provider.

## Model settings

Every SCNet model is enriched **at runtime** with pi's own bundled provider catalog — the same settings pi uses for its built-in models, matched by model id:

- `reasoning` + `thinkingLevelMap` (thinking levels)
- `input` modalities (vision: `text` + `image` where pi knows the model supports it)
- `cost` (per-million-token pricing from pi's catalog)
- `contextWindow` and `maxTokens`
- `compat` (thinking format, token field, etc., copied from pi's OpenAI-compatible entries)

No download needed — pi ships the catalog. Models pi's catalog doesn't know (base variants, embeddings, SCNet exclusives like `SCNet-Max`) get conservative defaults: text-only, no reasoning params, 128K context, 16K max output.

Enriched settings are persisted in the cache and survive background refreshes. Override any model in `~/.pi/agent/models.json` — pi composes those overrides above registered providers.

## Development

The extension is a single self-contained file: [`index.ts`](index.ts). No build step, no dependencies.

```bash
pi -e ./index.ts --list-models | grep scnet
```
