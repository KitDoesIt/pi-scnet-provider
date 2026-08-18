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
 * Model settings (reasoning, thinkingLevelMap, vision, cost, context,
 * max output, compat) are enriched at runtime from pi's own bundled
 * provider catalog — the same settings pi uses for its built-in models,
 * matched by model id. Models pi's catalog does not know get conservative
 * defaults. Enriched settings are persisted in the cache and preserved
 * across refreshes. Override anything via ~/.pi/agent/models.json (pi
 * composes those overrides above registered providers).
 *
 * API key resolution order:
 *   1. SCNET_API_KEY environment variable
 *   2. auth.json entry "scnet" (via /login scnet)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.scnet.cn/api/llm/v1";
const MODELS_URL = `${BASE_URL}/models`;

/** Don't hit /models more than once per 10 minutes. */
const FETCH_LOCK_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const CACHE_FILE = join(homedir(), ".pi", "agent", "scnet-models.json");
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");

/** Defaults for models pi's catalog does not know. */
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

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
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
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
  } catch {
    // keep current models; the refresh is retried on the next startup
  }
}

// =============================================================================
// pi's bundled provider catalog (enrichment source)
// =============================================================================

interface CatalogEntry {
  id: string;
  name?: string;
  api: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

const CATALOG_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "bedrock-converse-stream",
]);

/**
 * Candidate locations for pi-ai's bundled provider data (dist/providers/data/*.json).
 *
 * Only the bundled catalog is used — deliberately NOT ~/.pi/agent/models-store.json,
 * which is a sparse network cache of just the provider catalogs the user enabled.
 */
function findCatalogDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.PI_AI_DATA_DIR) dirs.push(process.env.PI_AI_DATA_DIR);
  try {
    // nvm-style install: pi bin -> ../../lib/node_modules/@earendil-works/...
    const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    const resolved = execFileSync("realpath", [piBin], { encoding: "utf8" }).trim();
    const pkgDir = join(resolved, "..", "..", "lib", "node_modules", "@earendil-works");
    dirs.push(join(pkgDir, "pi-ai", "dist", "providers", "data"));
    dirs.push(join(pkgDir, "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"));
  } catch {
    // which/realpath unavailable
  }
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    dirs.push(join(npmRoot, "@earendil-works", "pi-ai", "dist", "providers", "data"));
    dirs.push(join(npmRoot, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data"));
  } catch {
    // npm unavailable
  }
  return dirs;
}

function listCatalogFiles(): string[] {
  const files: string[] = [];
  for (const dir of findCatalogDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".json")) files.push(join(dir, name));
    }
  }
  return files;
}

function normalize(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strip version/date suffixes like -0731, -0813, -2507, -Instruct-2507. */
function stripVersion(id: string): string {
  return id.replace(/-(?:instruct|thinking)-?\d{3,4}$/i, "").replace(/-\d{3,4}$/i, "");
}

function isBaseVariant(id: string): boolean {
  return /-base$/i.test(id);
}

/** Prefer gateways closest to SCNet (token plans), then official labs, then resellers. */
function providerScore(provider: string): number {
  if (provider.includes("token-plan")) return 100;
  if (["deepseek", "minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "zhipuai", "alibaba", "xiaomi"].includes(provider)) return 80;
  if (provider === "opencode" || provider === "opencode-go") return 70;
  return 50;
}

function apiScore(api: string): number {
  return api === "openai-completions" ? 3 : api === "openai-responses" ? 2 : 1;
}

function pickBest(entries: CatalogEntry[]): CatalogEntry | undefined {
  if (entries.length === 0) return undefined;
  return [...entries].sort(
    (a, b) => providerScore(b.provider) + apiScore(b.api) - (providerScore(a.provider) + apiScore(a.api)),
  )[0];
}

/** Load pi's catalog into a normalized-id -> entries map. */
function loadCatalog(): Map<string, CatalogEntry[]> {
  const byNorm = new Map<string, CatalogEntry[]>();
  for (const file of listCatalogFiles()) {
    const provider = file.split("/").pop()!.replace(/\.json$/, "");
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null) continue;
    for (const [api, models] of Object.entries(data as Record<string, unknown>)) {
      if (!CATALOG_APIS.has(api) || typeof models !== "object" || models === null) continue;
      for (const entry of Object.values(models as Record<string, unknown>)) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        const id = typeof e.id === "string" ? e.id : undefined;
        if (!id) continue;
        const cat: CatalogEntry = {
          id,
          name: typeof e.name === "string" ? e.name : undefined,
          api,
          provider,
          reasoning: typeof e.reasoning === "boolean" ? e.reasoning : undefined,
          input: Array.isArray(e.input) ? e.input.filter((m): m is string => typeof m === "string") : undefined,
          cost: e.cost && typeof e.cost === "object"
            ? (e.cost as { input: number; output: number; cacheRead: number; cacheWrite: number })
            : undefined,
          contextWindow: typeof e.contextWindow === "number" ? e.contextWindow : undefined,
          maxTokens: typeof e.maxTokens === "number" ? e.maxTokens : undefined,
          thinkingLevelMap: e.thinkingLevelMap && typeof e.thinkingLevelMap === "object"
            ? (e.thinkingLevelMap as Record<string, string | null>)
            : undefined,
          compat: e.compat && typeof e.compat === "object"
            ? (e.compat as Record<string, unknown>)
            : undefined,
        };
        const norm = normalize(id);
        const list = byNorm.get(norm) ?? [];
        list.push(cat);
        byNorm.set(norm, list);
      }
    }
  }
  return byNorm;
}

/** Find the best catalog entry for a model id, or undefined. */
function findMatch(id: string, catalog: Map<string, CatalogEntry[]>): CatalogEntry | undefined {
  if (isBaseVariant(id)) return undefined; // base variants don't inherit chat settings
  const norm = normalize(id);
  // 1. exact normalized match
  const exact = catalog.get(norm);
  if (exact) return pickBest(exact);
  // 2. match after stripping version/date suffix
  const stripped = stripVersion(id);
  if (stripped !== id) {
    const s = catalog.get(normalize(stripped));
    if (s) return pickBest(s);
  }
  // 3. containment (both directions), min length to avoid false positives
  for (const [key, entries] of catalog) {
    if (key.length < 12) continue;
    if ((norm.includes(key) || key.includes(norm)) && Math.abs(key.length - norm.length) < 20) {
      return pickBest(entries);
    }
  }
  return undefined;
}

// =============================================================================
// Model configs
// =============================================================================

function defaultConfig(id: string): ProviderModelConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/** Copy pi's settings for a model, falling back to the previous cache entry or defaults. */
function buildConfig(
  id: string,
  entry: CatalogEntry | undefined,
  previous: ProviderModelConfig | undefined,
): ProviderModelConfig {
  if (!entry) return previous ?? defaultConfig(id);
  const reasoning = entry.reasoning ?? false;
  const input = entry.input?.filter((m) => m === "text" || m === "image");
  const config: ProviderModelConfig = {
    id,
    name: entry.name ?? id,
    reasoning,
    input: input && input.length > 0 ? input : ["text"],
    cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT,
    maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (reasoning && entry.thinkingLevelMap) config.thinkingLevelMap = entry.thinkingLevelMap;
  // compat only from OpenAI-compatible entries — anthropic-specific compat
  // (allowEmptySignature, forceAdaptiveThinking, ...) must not leak through
  if (entry.api === "openai-completions" && entry.compat) config.compat = entry.compat;
  return config;
}

/** Enrich fetched ids with pi's catalog settings, preserving cached entries for unmatched ids. */
function enrich(ids: string[], catalog: Map<string, CatalogEntry[]>, previous: ProviderModelConfig[]): ProviderModelConfig[] {
  const byId = new Map(previous.map((m) => [m.id, m]));
  return ids.map((id) => buildConfig(id, findMatch(id, catalog), byId.get(id)));
}

// =============================================================================
// Model list fetch
// =============================================================================

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

/** Fetch, enrich, persist the cache, and live-update the registered models. */
async function fetchAndRegister(
  pi: ExtensionAPI,
  apiKey: string,
): Promise<ProviderModelConfig[] | undefined> {
  try {
    const ids = await fetchModelIds(apiKey);
    if (ids.length === 0) return undefined;
    const previous = readCache()?.models ?? [];
    const models = enrich(ids, loadCatalog(), previous);
    writeCache({ fetchedAt: Date.now(), models });
    if (JSON.stringify(models) !== JSON.stringify(previous)) {
      register(pi, apiKey, models);
    }
    return models;
  } catch {
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
