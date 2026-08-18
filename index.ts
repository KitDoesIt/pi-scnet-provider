/**
 * SCNet provider extension for pi.
 *
 * Registers the "scnet" provider against the OpenAI-compatible endpoint
 * https://api.scnet.cn/api/llm/v1 using a static model list (models.json)
 * generated from models.dev's scnet-token-plan vendor — the models SCNet
 * token plans actually serve. No /models fetch, no catalog lookup, no
 * network at startup.
 *
 * Compat settings are baked from verified SCNet gateway behavior:
 *   - deepseek / kimi / glm models accept deepseek-style thinking params
 *     (thinking: { type: "enabled" } + reasoning_effort)
 *   - minimax / mimo models get no thinking format — reasoning_effort only
 *     (MiniMax rejects the thinking param; plain reasoning_effort works)
 *
 * Override anything via ~/.pi/agent/models.json (pi composes those
 * overrides above registered providers).
 *
 * API key resolution order:
 *   1. SCNET_API_KEY environment variable
 *   2. auth.json entry "scnet" (via /login scnet)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import models from "./models.json" with { type: "json" };

const BASE_URL = "https://api.scnet.cn/api/llm/v1";
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

// =============================================================================
// API key resolution
// =============================================================================

function resolveApiKey(): string | undefined {
  if (process.env.SCNET_API_KEY) return process.env.SCNET_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    const cred = auth?.scnet;
    if (cred?.type === "api_key" && typeof cred.key === "string") return cred.key;
  } catch {
    // no auth.json yet
  }
  return undefined;
}

// =============================================================================
// Registration
// =============================================================================

export default function (pi: ExtensionAPI) {
  const apiKey = resolveApiKey();
  pi.registerProvider("scnet", {
    name: "SCNet",
    baseUrl: BASE_URL,
    apiKey,
    api: "openai-completions",
    models: (models as { models: ProviderModelConfig[] }).models,
  });
}
