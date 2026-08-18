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

## Model defaults

Models are registered with conservative defaults:

| Field | Default |
|---|---|
| `reasoning` | `false` — no thinking params are sent (some models reject them), but SCNet models emit `reasoning_content` natively and pi displays it as thinking |
| `input` | `["text"]` |
| `contextWindow` | 128000 |
| `maxTokens` | 16384 |
| `cost` | 0 (usage tracking disabled) |

Override any model in `~/.pi/agent/models.json` if you want different settings (e.g. per-model thinking control).

## Development

The extension is a single self-contained file: [`index.ts`](index.ts). No build step, no dependencies.

```bash
pi -e ./index.ts --list-models | grep scnet
```
