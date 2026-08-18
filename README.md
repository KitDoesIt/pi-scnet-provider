# pi-scnet-provider

A [pi](https://github.com/earendil-works/pi) coding agent extension that registers the **SCNet** provider against its OpenAI-compatible endpoint:

```
https://api.scnet.cn/api/llm/v1
```

The model list ships statically in [`models.json`](models.json), generated from the **scnet-token-plan vendor on [models.dev](https://models.dev)** — the models SCNet token plans actually serve. No `/models` fetch, no catalog lookup, no network at startup.

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
pi --provider scnet --model "DeepSeek-V4-Flash"
```

Or in interactive mode: `/model`, then filter by the `scnet` provider.

## How it works

- **Zero network at startup.** The extension registers the static model list from [`models.json`](models.json) immediately — no `/models` fetch, no cache, no lock, nothing to go stale.
- **Settings from models.dev.** Context window, max output tokens, reasoning support, and vision (`input` modalities) come from models.dev's `scnet-token-plan` vendor, which models SCNet token plans actually serve.
- **Compat baked from verified gateway behavior:**
  - `deepseek` / `kimi` / `glm` models → `thinkingFormat: "deepseek"` (`thinking: { type: "enabled" }` + `reasoning_effort`)
  - `minimax` / `mimo` models → no thinking format; pi sends plain `reasoning_effort` only (MiniMax rejects the `thinking` param)
  - all models → `maxTokensField: "max_tokens"`, `supportsDeveloperRole: false`, `supportsStore: false`
- **Dated variants** like `DeepSeek-V4-Flash-0731` ship with the same settings as their base model.

Override any model in `~/.pi/agent/models.json` — pi composes those overrides above registered providers.

## Development

The extension is a single self-contained file: [`index.ts`](index.ts). No build step, no dependencies.

```bash
pi -e ./index.ts --list-models | grep scnet
```
