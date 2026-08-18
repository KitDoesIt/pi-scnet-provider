/**
 * SCNet provider extension for pi.
 *
 * Registers the "scnet" provider against the OpenAI-compatible endpoint
 * https://api.scnet.cn/api/llm/v1. The model list is fetched dynamically
 * from /models, but startup never stalls on the network when a cache exists:
 *
 *   - Cache hit: the cached model list is registered immediately, and a
 *     background refresh always fetches the latest /models and live-updates
 *     the registered models when it changes.
 *   - Cold start (no cache): the factory does one bounded fetch (10s timeout)
 *     so the very first run also gets models, then persists the cache.
 *   - A 10-minute fetch lock (persisted with the cache) prevents hammering
 *     the /models endpoint across restarts and reloads.
 *
 *
 * Note: models are registered with `reasoning: false` for maximum
 * compatibility — thinking params are not sent, but all SCNet models emit
 * `reasoning_content` natively and pi displays it. Override per model in
 * models.json if you want explicit thinking control.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.scnet.cn/api/llm/v1";
const MODELS_URL = `${BASE_URL}/models`;

/** Don't hit /models more than once per 10 minutes. */
const FETCH_LOCK_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const CACHE_FILE = join(homedir(), ".pi", "agent", "scnet-models.json");


interface ModelCache {
  fetchedAt: number;
  models: ProviderModelConfig[];
}

let fetchInFlight: Promise<ProviderModelConfig[] | undefined> | null = null;

// =============================================================================
// API key resolution
// =============================================================================

function resolveApiKey(): string | undefined {
  if (process.env.SCNET_API_KEY) return process.env.SCNET_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const cred = auth?.scnet;
    if (cred?.type === "api_key" && typeof cred.key === "string") return cred.key;
  } catch {
    // no auth.json yet
  }
  return undefined;
}

// =============================================================================
// Cache
// =============================================================================

function readCache(): ModelCache | undefined {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

function writeCache(cache: ModelCache) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.error(`[scnet] failed to write model cache: ${String(err)}`);
  }
}

// =============================================================================
// Model list
// =============================================================================

function toModelConfigs(ids: string[]): ProviderModelConfig[] {
  return ids.map((id) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }));
}

async function fetchModelIds(apiKey: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const payload = (await res.json()) as { data?: Array<{ id?: string }> };
    return (payload.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch, persist the cache, and live-update the registered models. */
async function fetchAndRegister(
  pi: ExtensionAPI,
  apiKey: string,
): Promise<ProviderModelConfig[] | undefined> {
  try {
    const ids = await fetchModelIds(apiKey);
    if (ids.length === 0) {
      console.error("[scnet] /models returned an empty list; keeping current models");
      return undefined;
    }
    const models = toModelConfigs(ids);
    const previous = readCache()?.models ?? [];
    writeCache({ fetchedAt: Date.now(), models });
    if (JSON.stringify(models) !== JSON.stringify(previous)) {
      register(pi, apiKey, models);
      console.error(`[scnet] registered ${models.length} models`);
    }
    return models;
  } catch (err) {
    console.error(
      `[scnet] model refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Fetch the latest model list and live-update the provider registration.
 * Respects the 10-minute lock (persisted `fetchedAt` + in-process guard).
 * Resolves with the fetched models, or undefined when skipped/failed.
 */
function refreshModels(
  pi: ExtensionAPI,
  apiKey: string,
  lastFetchedAt: number,
): Promise<ProviderModelConfig[] | undefined> {
  if (Date.now() - lastFetchedAt < FETCH_LOCK_MS) return Promise.resolve(undefined); // lock held
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = fetchAndRegister(pi, apiKey).finally(() => {
    fetchInFlight = null;
  });
  return fetchInFlight;
}

// =============================================================================
// Registration
// =============================================================================

function register(pi: ExtensionAPI, apiKey: string, models: ProviderModelConfig[]) {
  pi.registerProvider("scnet", {
    name: "SCNet",
    baseUrl: BASE_URL,
    apiKey,
    api: "openai-completions",
    models,
  });
}

export default async function (pi: ExtensionAPI) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      "[scnet] no API key found. Set SCNET_API_KEY or store one with /login scnet.",
    );
  }
  // Start with the cached list — no network on the startup path.
  const cached = readCache();
  register(pi, apiKey, cached?.models ?? []);

  if (cached) {
    // Cache exists: return immediately; refresh in the background (10-min lock).
    refreshModels(pi, apiKey, cached.fetchedAt);
  } else {
    // Cold start, no cache: one bounded fetch so the first run has models too.
    await refreshModels(pi, apiKey, 0);
  }
}
