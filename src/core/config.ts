import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ConflictPolicy, LubanConfig, McpServerSettings, MeshContact, ModelRef, SyncMode } from "./types.js";
import { consoleAccessToken } from "./opencode-console.js";
import { readProviderKeys } from "./provider-auth.js";
import { ensureStarterConfig } from "./default-config.js";
import { DEFAULT_RELAY_URL } from "./service-defaults.js";
import { ABSOLUTE_MAX_OUTPUT_TOKENS } from "./openai.js";

type JsonObject = Record<string, unknown>;

export function stripJsonComments(source: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function readJson(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function codexEffort(value: unknown): ModelRef["reasoningEffort"] {
  return ["low", "medium", "high", "xhigh", "max", "ultra"].includes(value as string)
    ? value as ModelRef["reasoningEffort"] : undefined;
}

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function flexible(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringList(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [...fallback];
}

function contacts(value: unknown, fallbackPort: number): MeshContact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    const name = text(item.name);
    const host = text(item.host);
    if (!name || !host) return [];
    return [{
      name,
      host,
      port: integer(item.port, fallbackPort),
      udpPort: integer(item.udp_port ?? item.udpPort, 0),
      note: text(item.note),
    }];
  });
}

function lspServers(value: unknown): Record<string, import("./types.js").LspServerSettings> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([name, raw]) => {
    const item = record(raw);
    const command = text(item.command);
    if (!command) return [];
    const languages = stringList(item.languages ?? item.language);
    return [[name, {
      command,
      args: stringList(item.args),
      languages,
      enabled: item.enabled !== false && item.disabled !== true,
    }]];
  }));
}

/**
 * Normalise one `mcpServers`/`mcp.servers` block. Names without a `command` or
 * `url` are dropped rather than failing the whole config, and `disabled`/
 * `trust` are accepted as aliases so a hand-written entry still works.
 */
export function normalizeMcpServers(value: unknown): Record<string, McpServerSettings> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([name, raw]) => {
    const item = record(raw);
    const command = text(item.command);
    const url = text(item.url);
    if (!command && !url) return [];
    const env = Object.fromEntries(Object.entries(record(item.env)).map(([key, val]) => [key, String(val)]));
    const headers = Object.fromEntries(Object.entries(record(item.headers)).map(([key, val]) => [key, String(val)]));
    return [[name, {
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      args: stringList(item.args),
      env,
      headers,
      ...(text(item.cwd) ? { cwd: text(item.cwd) } : {}),
      enabled: item.enabled !== false && item.disabled !== true,
      trusted: item.trusted === true || item.trust === true,
    } satisfies McpServerSettings]];
  }));
}

function defaultCapabilities(): string[] {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return ["shell", "files", "agent", platform, "nodejs", ...(platform === "linux" && existsSync("/run/user") ? ["audio"] : [])];
}

function providerModels(provider: JsonObject): Array<{ id: string; name: string }> {
  const models = provider.models;
  if (Array.isArray(models)) return models.map((id) => ({ id: String(id), name: String(id) }));
  if (!models || typeof models !== "object") return [];
  return Object.entries(models as JsonObject).map(([id, value]) => ({
    id,
    name: text(record(value).name, id),
  }));
}

function envKey(provider: string): string {
  return provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

/**
 * OpenCode's Go subscription reuses the CLI's own credential, so luban reads it
 * instead of asking for a second copy. `OPENCODE_AUTH_CONTENT` is the override
 * OpenCode exposes for hosts without a writable data directory; otherwise the
 * key lives in `auth.json` (or the older `account.json`) under the OpenCode
 * data directory.
 */
function opencodeAuthKey(service: "opencode" | "opencode-go" = "opencode-go"): string {
  const inline = process.env.OPENCODE_AUTH_CONTENT;
  if (inline) {
    try {
      const value = text(record((JSON.parse(inline) as JsonObject)[service]).key);
      if (value) return value;
    } catch {
      // Malformed content falls through to the files.
    }
  }
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  for (const file of ["auth.json", "account.json"]) {
    const data = readJson(join(dataHome, "opencode", file));
    const direct = text(record(data[service]).key);
    if (direct) return direct;
    for (const value of Object.values(record(data.accounts))) {
      const entry = record(value);
      if (text(entry.serviceID, entry.serviceId) === service) {
        const key = text(record(entry.credential).key);
        if (key) return key;
      }
    }
  }
  return "";
}

/**
 * Prefer an available Console session on Zen, otherwise use the configured
 * or saved Zen API key. An explicit key from either OpenCode provider block is
 * shared, while environment variables and OpenCode's saved credentials keep
 * their per-service meaning.
 */
function resolveKey(providerName: string, provider: JsonObject, fallback: JsonObject, session = "", shared = ""): string {
  const options = record(provider.options);
  const keyEnv = text(provider.api_key_env, provider.apiKeyEnv);
  if (providerName === "opencode-zen") return text(
    session, provider.api_key, provider.apiKey, options.api_key, options.apiKey,
    keyEnv ? process.env[keyEnv] : "", process.env.OPENCODE_ZEN_API_KEY,
    shared, opencodeAuthKey("opencode"),
  );
  if (["codex", "opendesign", "opencode-go", "deepseek", "dashscope", "qwen-local", "strata-local"].includes(providerName)) return text(
    provider.api_key, provider.apiKey, options.api_key, options.apiKey,
    keyEnv ? process.env[keyEnv] : "", process.env[`${envKey(providerName)}_API_KEY`],
    ...(providerName === "opencode-go" ? [process.env.OPENCODE_API_KEY, shared, opencodeAuthKey()] : []),
  );
  const opencode = providerName === "opencode-go";
  return text(
    provider.api_key,
    provider.apiKey,
    options.api_key,
    options.apiKey,
    keyEnv ? process.env[keyEnv] : "",
    process.env[`${envKey(providerName)}_API_KEY`],
    ...(opencode ? [shared] : []),
    opencode ? opencodeAuthKey() : "",
    fallback.api_key,
    fallback.apiKey,
    process.env.OPENAI_API_KEY,
    process.env.DEEPSEEK_API_KEY,
  );
}

/**
 * OpenCode plans share one credential now: the same key answers both the
 * subscription and metered endpoints. Read it once from whichever provider
 * block the user wrote, so Go and Zen no longer need duplicate keys.
 */
function sharedOpenCodeKey(providers: JsonObject): string {
  const from = (name: string): string => {
    const provider = record(providers[name]);
    const options = record(provider.options);
    return text(provider.api_key, provider.apiKey, options.api_key, options.apiKey);
  };
  return text(from("opencode-zen"), from("opencode-go"));
}

/**
 * The Go subscription serves every model through one base URL but splits them
 * across three protocols. This mirrors the routing OpenCode itself uses from
 * models.dev: Anthropic-served models speak Messages, OpenAI-served models
 * speak Responses, and everything else is OpenAI-compatible chat.
 */
const OPENCODE_GO_MODELS: Record<string, { name: string; api: "openai" | "anthropic" | "responses"; vision: boolean; temperature?: boolean }> = {
  "kimi-k3": { name: "Kimi K3", api: "openai", vision: true },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code", api: "openai", vision: true },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", api: "openai", vision: false },
  "deepseek-v4-flash": { name: "DeepSeek V4 Flash", api: "openai", vision: false },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", api: "openai", vision: true },
  "deepseek-v4-flash-vision-exp": { name: "DeepSeek V4 Flash Vision Exp", api: "openai", vision: true },
  "glm-5.3": { name: "GLM-5.3", api: "openai", vision: false },
  "glm-5.3-flash": { name: "GLM-5.3-Flash", api: "openai", vision: true },
  "glm-5.2": { name: "GLM-5.2", api: "openai", vision: false },
  "hy3": { name: "Hy3", api: "openai", vision: false },
  "hy4-preview": { name: "Hy4 preview", api: "openai", vision: false },
  "longcat-2.0": { name: "LongCat-2.0", api: "openai", vision: false },
  // The Go endpoint also offers free models with its own subscription key.
  "longcat-2.5-preview-free": { name: "LongCat 2.5 Preview · Free", api: "openai", vision: true },
  "step-5-preview-free": { name: "Step 5 Preview · Free", api: "openai", vision: true },
  "cat-jam-free": { name: "Cat Jam · Free", api: "openai", vision: false },
  "beam-free": { name: "Beam · Free", api: "openai", vision: false },
  "minimax-m3.1-flash-free": { name: "MiniMax M3.1 Flash · Free", api: "openai", vision: true },
  "mimo-v2.6-pro": { name: "MiMo-V2.6-Pro", api: "openai", vision: true },
  "mimo-v2.6-flash": { name: "MiMo-V2.6-Flash", api: "openai", vision: true },
  "mimo-v2.5": { name: "MiMo V2.5", api: "openai", vision: true },
  "mimo-v2.5-pro": { name: "MiMo V2.5 Pro", api: "openai", vision: false },
  "qwen3.8-max": { name: "Qwen3.8 Max", api: "openai", vision: true },
  "qwen3.7-plus": { name: "Qwen3.7 Plus", api: "openai", vision: true },
  "space-bunny": { name: "Space Bunny", api: "openai", vision: false },
  "qwen3.8-flash": { name: "Qwen3.8 Flash", api: "anthropic", vision: true },
  "minimax-m3": { name: "MiniMax-M3", api: "anthropic", vision: true },
  "minimax-m2.7": { name: "MiniMax-M2.7", api: "anthropic", vision: false },
  "gpt-6-luna": { name: "GPT-6 Luna", api: "responses", vision: true, temperature: false },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", api: "responses", vision: true, temperature: false },
  "grok-4.7": { name: "Grok 4.7", api: "responses", vision: true },
  "grok-4.6": { name: "Grok 4.6", api: "responses", vision: true },
  "muse-spark-1.3-contributor": { name: "Muse Spark 1.3 Contributor", api: "responses", vision: true },
  "muse-spark-1.2-contributor": { name: "Muse Spark 1.2 Contributor", api: "responses", vision: true },
};

/**
 * Zen paid models. The free catalog below is also always available for
 * selection; credentials are resolved separately from catalog visibility.
 */
const OPENCODE_ZEN_MODELS: Record<string, { name: string; api: "openai" | "responses" | "anthropic"; vision: boolean; temperature?: boolean }> = {
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", api: "openai", vision: true },
  "glm-5.3-flash": { name: "GLM-5.3-Flash", api: "openai", vision: true },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code", api: "openai", vision: true, temperature: false },
  "claude-haiku-5-5": { name: "Claude Haiku 5.5", api: "anthropic", vision: true },
  "qwen3.8-flash": { name: "Qwen3.8 Flash", api: "anthropic", vision: true },
  "claude-sonnet-5": { name: "Claude Sonnet 5", api: "anthropic", vision: true },
  "claude-opus-5": { name: "Claude Opus 5", api: "anthropic", vision: true },
  "gpt-6-luna": { name: "GPT-6 Luna", api: "responses", vision: true, temperature: false },
  "gpt-5.6-luna": { name: "GPT-5.6 Luna", api: "responses", vision: true, temperature: false },
  "grok-4.7": { name: "Grok 4.7", api: "responses", vision: true },
};

/**
 * Zen free chat models remain visible regardless of local login state.
 * OpenCode Console credentials are read through opencode-console.ts when
 * available. Jev uses /systemone and is not a chat model.
 */
const OPENCODE_ZEN_FREE_MODELS: Record<string, { name: string; api: "openai" | "responses"; vision?: boolean; temperature?: boolean }> = {
  "big-pickle": { name: "Big Pickle · Free", api: "openai" },
  "space-bunny-free": { name: "Space Bunny · Free", api: "openai" },
  "longcat-2.5-preview-free": { name: "LongCat 2.5 Preview · Free", api: "openai" },
  "exo-free": { name: "Exo · Free", api: "openai" },
  "fledge-alpha-free": { name: "Fledge Alpha · Free", api: "openai" },
  "ling-3.1-flash-free": { name: "Ling 3.1 Flash · Free", api: "openai" },
  "ling-3.0-flash-fin-free": { name: "Ling 3.0 Flash Fin · Free", api: "openai" },
  "mimo-v2.6-flash-free": { name: "MiMo V2.6 Flash · Free", api: "openai" },
  "mimo-v2.5-free": { name: "MiMo V2.5 · Free", api: "openai" },
  "nemotron-3-ultra-free": { name: "Nemotron 3 Ultra · Free", api: "openai" },
  "nemotron-3.5-lightning-free": { name: "Nemotron 3.5 Lightning · Free", api: "openai" },
  "muse-spark-1.3-contributor-free": { name: "Muse Spark 1.3 Contributor · Free", api: "responses" },
  "deepseek-v4.1-flash-free": { name: "DeepSeek V4.1 Flash · Free", api: "openai", vision: true },
  "glm-5.3-flash-free": { name: "GLM-5.3-Flash · Free", api: "openai", vision: true },
  "minimax-m3.1-flash-free": { name: "MiniMax M3.1 Flash · Free", api: "openai", vision: true },
  "beam-free": { name: "Beam · Free", api: "openai" },
  "nemotron-3.5-super-vl-free": { name: "Nemotron 3.5 Super VL · Free", api: "openai", vision: true },
};

/**
 * Codex CLI keeps its current model catalog in `models_cache.json`. Read it so
 * newly released models show up without a luban release, and keep a static
 * fallback for a fresh machine where the CLI has not fetched it yet.
 */
const CODEX_FALLBACK_MODELS = [
  "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  "gpt-6.1-sol", "gpt-6.1-terra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

/**
 * Open Design's AMR gateway publishes every model on three protocols that share
 * one `/v1` base URL: Chat Completions, the Responses API used by Codex, and the
 * Anthropic Messages API used by Claude Code. The catalog mirrors the gateway's
 * `/v1/models` (it marks `deepseek-v4.1-flash` as its default) and routes Claude
 * through Messages. The endpoint belongs to whoever operates that gateway, so
 * none ships here: `providers.opendesign.base_url` is empty and the catalog only
 * appears once you point it somewhere. `OPEN_DESIGN_API_KEY` or
 * `providers.opendesign.api_key` supplies the credential.
 */
const OPEN_DESIGN_MODELS: Record<string, { name: string; vision: boolean; api?: "openai" | "anthropic"; temperature?: boolean }> = {
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", vision: true },
  "deepseek-v4-flash": { name: "DeepSeek V4 Flash", vision: false },
  "deepseek-v4-flash-vision-exp": { name: "DeepSeek V4 Flash Vision Exp", vision: true },
  "deepseek-v4-pro": { name: "DeepSeek V4 Pro", vision: false },
  // Claude is native on the Messages API that Claude Code speaks.
  "claude-haiku-5.5": { name: "Claude Haiku 5.5", vision: true, api: "anthropic" },
  "glm-5.3-flash": { name: "GLM-5.3-Flash", vision: true },
  "glm-5.3-flashx": { name: "GLM-5.3-FlashX", vision: true },
  // The gateway rejects an explicit temperature for GPT reasoning models.
  "gpt-6-luna": { name: "GPT-6 Luna", vision: true, temperature: false },
  "hy4-preview": { name: "Hy4 preview", vision: false },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code", vision: true },
  "mimo-v2.6-flash": { name: "MiMo V2.6 Flash", vision: true },
  "mimo-v2.6-pro": { name: "MiMo V2.6 Pro", vision: true },
  "minimax-m3.1-flash": { name: "MiniMax M3.1 Flash", vision: true },
};

interface CodexCatalogEntry {
  id: string;
  name: string;
  vision: boolean;
}

/** Parsed cache keyed by file identity, so polling the catalog stays cheap. */
let codexCacheKey = "";
let codexCacheEntries: CodexCatalogEntry[] | undefined;

/**
 * The catalog the installed Codex CLI knows about, newest first: the CLI writes
 * `models_cache.json`; its `priority` ranks the models it wants shown on top.
 * A static fallback covers a fresh machine before the CLI has fetched anything.
 */
function codexCatalogEntries(): CodexCatalogEntry[] {
  const codexHome = text(process.env.CODEX_HOME, join(homedir(), ".codex"));
  const file = join(codexHome, "models_cache.json");
  const info = statSync(file, { throwIfNoEntry: false });
  const key = info ? `${file}\0${info.mtimeMs}\0${info.size}` : file;
  if (codexCacheEntries && codexCacheKey === key) return codexCacheEntries;
  const cached = readJson(file);
  const discovered = (Array.isArray(cached.models) ? cached.models : []).flatMap((value) => {
    const item = record(value);
    const id = text(item.slug);
    if (!id || item.visibility === "hide" || item.supported_in_api === false) return [];
    const modalities = stringList(item.input_modalities);
    return [{ id, name: text(item.display_name, id), priority: integer(item.priority, Number.MAX_SAFE_INTEGER),
      vision: !modalities.length || modalities.includes("image") }];
  }).sort((left, right) => left.priority - right.priority);
  const entries: CodexCatalogEntry[] = [{ id: "default", name: "Codex (CLI default)", vision: true }];
  const seen = new Set(["default"]);
  for (const model of discovered) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    entries.push({ id: model.id, name: model.name, vision: model.vision });
  }
  for (const id of CODEX_FALLBACK_MODELS) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, name: id, vision: true });
  }
  codexCacheKey = key;
  codexCacheEntries = entries;
  return entries;
}

function codexModelCatalog(): Record<string, JsonObject> {
  return Object.fromEntries(codexCatalogEntries().map(entry => [entry.id, {
    name: entry.name,
    capabilities: { vision: entry.vision, thinking: true, tools: true },
  }]));
}

/**
 * Merge the current Codex cache into an already-loaded config. The catalog is
 * read once at startup, so a luban process that stays open while the CLI
 * refreshes `models_cache.json` would otherwise never show a newly released
 * model. Existing entries keep their credentials and reasoning effort, and the
 * Codex block stays where the loaded config had it so other providers never
 * shift under the user's cursor.
 */
export function refreshCodexModels(config: LubanConfig): ModelRef[] {
  const codex = config.models.filter(model => model.provider === "codex");
  const template = codex.find(model => model.model === "default") ?? codex[0];
  if (!template) return config.models;
  const known = new Map(codex.map(model => [model.model, model]));
  const entries = codexCatalogEntries();
  const listed = new Set(entries.map(entry => entry.id));
  const refreshed: ModelRef[] = [
    ...entries.map(entry => {
      const existing = known.get(entry.id);
      // Keep the credential, effort and headers of a model we already listed and
      // only follow the CLI's label and modality, so a renamed model keeps its
      // saved reasoning effort.
      return existing
        ? { ...existing, name: entry.name, capabilities: { ...existing.capabilities, vision: entry.vision } }
        : { ...template, id: `codex/${entry.id}`.toLowerCase(), model: entry.id, name: entry.name,
          capabilities: { ...template.capabilities, vision: entry.vision } };
    }),
    // Models the user configured by hand stay listed even when the CLI does not
    // publish them.
    ...codex.filter(model => !listed.has(model.model)),
  ];
  const models = config.models.filter(model => model.provider !== "codex");
  models.splice(config.models.findIndex(model => model.provider === "codex"), 0, ...refreshed);
  // Callers compare identity to decide whether to re-render, so an unchanged
  // catalog must not allocate a new list.
  const unchanged = models.length === config.models.length && models.every((model, index) => {
    const before = config.models[index]!;
    return before.id === model.id && before.name === model.name
      && before.capabilities.vision === model.capabilities.vision;
  });
  return unchanged ? config.models : models;
}

/**
 * Catalog visibility is independent of credentials, including on fresh installs.
 */
function builtinProviders(session = "", shared = ""): Record<string, JsonObject> {
  const zenKey = text(session, process.env.OPENCODE_ZEN_API_KEY, opencodeAuthKey("opencode"), shared);
  // Keep model visibility independent of whether a Console login was found.
  const zenCatalog = {
    ...OPENCODE_ZEN_MODELS,
    ...OPENCODE_ZEN_FREE_MODELS,
  };
  return {
    codex: {
      api: "codex",
      models: codexModelCatalog(),
    },
    "opencode-go": {
      api_key_env: "OPENCODE_API_KEY",
      base_url: "https://opencode.ai/zen/go/v1",
      headers: { "x-opencode-client": "luban" },
      models: Object.fromEntries(Object.entries(OPENCODE_GO_MODELS).map(([id, model]) => [id, {
        name: model.name,
        api: model.api,
        capabilities: {
          vision: model.vision,
          thinking: true,
          ...(model.temperature === false ? { temperature: false } : {}),
        },
      }])),
    },
    "opencode-zen": {
      api_key: zenKey,
      base_url: "https://opencode.ai/zen/v1",
      models: Object.fromEntries(Object.entries(zenCatalog).map(([id, model]) => [id, {
        name: model.name,
        api: model.api,
        capabilities: {
          vision: "vision" in model ? model.vision : false,
          thinking: true,
          tools: true,
          ...(model.temperature === false ? { temperature: false } : {}),
        },
      }])),
    },
    opendesign: {
      api_key_env: "OPEN_DESIGN_API_KEY",
      // No endpoint ships with the source: this catalog only means anything
      // against an operator's own gateway, and a model without a base URL must
      // never quietly fall back to api.openai.com.
      base_url: "",
      requires_base_url: true,
      models: Object.fromEntries(Object.entries(OPEN_DESIGN_MODELS).map(([id, model]) => [id, {
        name: model.name,
        api: model.api ?? "openai",
        capabilities: {
          vision: model.vision,
          thinking: true,
          tools: true,
          ...(model.temperature === false ? { temperature: false } : {}),
        },
      }])),
    },
    deepseek: {
      api_key_env: "DEEPSEEK_API_KEY",
      base_url: "https://api.deepseek.com/chat/completions",
      models: ["deepseek-flash", "deepseek-v4-pro"],
    },
    dashscope: {
      api_key_env: "DASHSCOPE_API_KEY",
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["deepseek-v4-flash-0731", "deepseek-v4.1-flash", "qwen3.8-flash", "qwen3.8-max", "glm5.3-flash"],
    },
    "qwen-local": {
      api_key_env: "QWEN_LOCAL_API_KEY",
      base_url: "http://127.0.0.1:8000/v1",
      models: ["qwen3.8-flash-next"],
    },
    "strata-local": {
      api_key_env: "STRATA_LOCAL_API_KEY",
      base_url: "http://127.0.0.1:8080/v1",
      models: ["qwen3.8-flash-next-iq2_xs"],
    },
  };
}

/**
 * Overlay a user's provider block on a built-in one. Scalars from the user win
 * so an explicit endpoint or key is never rewritten, and model tables are
 * unioned so listing a couple of models no longer hides the built-in catalog.
 */
function mergeModelCatalog(explicit: JsonObject, builtin: JsonObject): JsonObject {
  const builtinModels = record(builtin.models);
  const merged: JsonObject = { ...builtin, ...explicit };
  // An explicit array is an intentional override; an object or a missing
  // table unions with the built-in catalog instead of hiding it.
  const models = Array.isArray(explicit.models) ? explicit.models : { ...builtinModels, ...record(explicit.models) };
  return Object.keys(builtinModels).length ? { ...merged, models } : merged;
}

function headerMap(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, val]) =>
    typeof val === "string" && val.trim() ? [[key, val.trim()]] : []));
}

function resolveBaseUrl(provider: JsonObject, fallback: JsonObject): string {
  const options = record(provider.options);
  return text(
    provider.base_url,
    provider.baseURL,
    options.base_url,
    options.baseURL,
    fallback.base_url,
    fallback.baseURL,
    process.env.OPENAI_BASE_URL,
  );
}

function collectModels(raw: JsonObject, session = "", shared = ""): ModelRef[] {
  const providers = record(raw.providers);
  const modelConfig = record(raw.model);
  const result: ModelRef[] = [];
  for (const [providerName, value] of Object.entries(providers)) {
    const provider = record(value);
    const baseUrl = resolveBaseUrl(provider, modelConfig);
    // A catalog that ships without its own endpoint belongs to somebody else's
    // service; listing it would send the operator's key to api.openai.com.
    if (!baseUrl && provider.requires_base_url === true) continue;
    const apiKey = resolveKey(providerName, provider, modelConfig, session,
      providerName === "opencode-go" || providerName === "opencode-zen" ? shared : "");
    const providerApi = text(provider.api, provider.type, providerName === "anthropic" ? "anthropic" : "openai").toLowerCase();
    const providerHeaders = headerMap(provider.headers);
    for (const model of providerModels(provider)) {
      const perModel = record((record(provider.models as JsonObject)[model.id] ?? {}) as unknown);
      const caps = record(perModel.capabilities ?? provider.capabilities ?? modelConfig.capabilities);
      const apiRaw = text(perModel.api, perModel.type, providerApi).toLowerCase();
      const api = apiRaw === "anthropic" ? "anthropic" : apiRaw === "responses" ? "responses" : apiRaw === "codex" ? "codex" : "openai";
      const headers = { ...providerHeaders, ...headerMap(perModel.headers) };
      const thinkingControl = text(perModel.thinking_control, perModel.thinkingControl, provider.thinking_control, provider.thinkingControl);
      const modelId = `${providerName}/${model.id}`.toLowerCase();
      const visionDefault = /vision|gpt-4o|gpt-4\.1|claude.*(sonnet|opus)|gemini.*(pro|flash)|qwen.*vl/i.test(`${providerName} ${model.id}`);
      result.push({
        id: `${providerName}/${model.id}`,
        provider: providerName,
        model: model.id,
        name: model.name,
        baseUrl,
        apiKey,
        api,
        ...(["qwen", "thinking", "reasoning-effort", "adaptive", "budget", "none"].includes(thinkingControl)
          ? { thinkingControl: thinkingControl as ModelRef["thinkingControl"] } : {}),
        ...(codexEffort(perModel.reasoning_effort ?? provider.reasoning_effort)
          ? { reasoningEffort: codexEffort(perModel.reasoning_effort ?? provider.reasoning_effort) } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
        capabilities: {
          vision: caps.vision !== undefined ? caps.vision === true : visionDefault,
          thinking: caps.thinking !== undefined ? caps.thinking === true : /qwen|deepseek-reasoner|claude|o1|o3/i.test(modelId),
          tools: caps.tools !== undefined ? caps.tools === true : true,
          responses: caps.responses !== undefined ? caps.responses === true : api === "responses",
          temperature: caps.temperature !== undefined ? caps.temperature === true : true,
          ...(maxOutputCap(caps) ? { maxOutputTokens: maxOutputCap(caps) } : {}),
        },
      });
    }
  }
  if (!result.length) {
    const model = text(modelConfig.model, process.env.LUBAN_MODEL, "gpt-4.1-mini");
    result.push({
      id: model,
      provider: "openai-compatible",
      model,
      name: model,
      baseUrl: resolveBaseUrl({}, modelConfig) || "https://api.openai.com/v1",
      apiKey: resolveKey("openai", {}, modelConfig),
      api: "openai",
      capabilities: { vision: /vision|gpt-4o|gpt-4\.1/i.test(model), thinking: false, tools: true, responses: false },
    });
  }
  return result;
}

export interface LoadConfigOptions {
  workspace?: string;
  model?: string;
  backendUrl?: string;
  allow?: boolean;
  mesh?: boolean;
  meshName?: string;
  meshPort?: number;
  /** off | auto | always — how much planning the prompt asks for. */
  planning?: string;
  /** Terminal color scheme id or alias; overrides config and preferences. */
  theme?: string;
  /**
   * Write the portable starter config when this home has none. Only real entry
   * points opt in; library and test callers keep their home untouched.
   */
  seedDefaults?: boolean;
  /** on | off | auto — override the config's native thinking switch for this run. */
  thinking?: string;
}

/**
 * The product was named dagent until v1.14; its data directory was ~/.dagent.
 * The first run under the new name moves that directory whole - sessions,
 * config, history, mesh contacts - so an upgrade never starts from empty.
 * Only the default location migrates: an explicit LUBAN_HOME is respected
 * as-is, and an existing ~/.luban is never overwritten.
 */
function migrateLegacyHome(defaultHome: string): void {
  if (existsSync(defaultHome)) return;
  const legacy = join(homedir(), ".dagent");
  if (!existsSync(legacy)) return;
  try {
    renameSync(legacy, defaultHome);
  } catch {
    // A cross-device or permissions failure leaves the old directory intact;
    // running with a fresh home is better than refusing to start.
  }
}

/** "on" | "off" | "auto" from a flag; anything else (including "auto") stays unset. */
function parseThinkingOption(value: string | undefined): boolean | undefined {
  const mode = text(value, "").toLowerCase();
  if (mode === "on" || mode === "true" || mode === "1" || mode === "always") return true;
  if (mode === "off" || mode === "false" || mode === "0" || mode === "never") return false;
  return undefined;
}

/** Provider-declared output limit for one response, when the config names one. */
function maxOutputCap(caps: JsonObject): number | undefined {
  const value = integer(caps.max_output_tokens ?? caps.max_output ?? caps.maxOutputTokens, 0);
  return value > 0 ? value : undefined;
}

export function loadConfig(options: LoadConfigOptions = {}): LubanConfig {
  const defaultHome = join(homedir(), ".luban");
  const home = resolve(process.env.LUBAN_HOME || defaultHome);
  if (home === defaultHome) migrateLegacyHome(defaultHome);
  if (options.seedDefaults) ensureStarterConfig(home);
  const savedProviderKeys = readProviderKeys(home);
  const workspace = resolve(options.workspace || process.cwd());
  const globalConfig = readJson(join(home, "config.json"));
  // A project configured before v1.14 keeps its settings in .dagent/config.json;
  // read that when the new directory is absent so the rename does not silently
  // drop an existing project's config, skills or mesh settings.
  const projectDir = join(workspace, ".luban");
  const projectConfig = existsSync(projectDir)
    ? readJson(join(projectDir, "config.json"))
    : readJson(join(workspace, ".dagent", "config.json"));
  const raw = { ...globalConfig, ...projectConfig };
  const globalProviders = record(globalConfig.providers);
  const projectProviders = record(projectConfig.providers);
  const explicitProviders = { ...globalProviders, ...projectProviders };
  const mergedModel = { ...record(globalConfig.model), ...record(projectConfig.model) };
  const preferences = readJson(join(home, "node-preferences.json"));
  const requestedModel = text(options.model, process.env.LUBAN_MODEL, preferences.model, mergedModel.active, mergedModel.model);
  const singleModel = text(mergedModel.model, mergedModel.base_url, mergedModel.baseURL);
  const hasExplicitProviders = Object.keys(explicitProviders).length > 0;
  const codexModelId = [options.model, process.env.LUBAN_MODEL, preferences.model, mergedModel.active]
    .find((value) => typeof value === "string" && value.toLowerCase().startsWith("codex/")) as string | undefined;
  const codexEnabled = preferences.codexEnabled === true || Boolean(codexModelId);
  // Read the Console session once: a refresh can cost a network round trip.
  const consoleSession = consoleAccessToken();
  const sharedOpenCode = sharedOpenCodeKey(explicitProviders);
  const builtins = builtinProviders(consoleSession, sharedOpenCode);
  // User providers stay first (and win) so defaults and ordering do not shift;
  // built-ins are appended only when the user has not defined that provider.
  const providers: JsonObject = { ...explicitProviders };
  for (const [name, definition] of Object.entries(builtins)) {
    // A hand-written OpenCode or Open Design block usually pins the endpoint and
    // a couple of models (for example to switch one model to the Responses API),
    // which used to hide the rest of the catalog. Merge the built-in model table
    // in instead of dropping it; explicit entries win. An explicit model array
    // remains a full override.
    if (name in explicitProviders && (name === "opencode-zen" || name === "opencode-go" || name === "opendesign")) {
      providers[name] = mergeModelCatalog(record(explicitProviders[name]), definition);
      continue;
    }
    if (!(name in explicitProviders)) providers[name] = definition;
  }
  if (codexModelId) {
    const codex = record(providers.codex);
    const requestedName = codexModelId.slice("codex/".length);
    if (text(codex.api) === "codex" && requestedName && !providerModels(codex).some((model) => model.id === requestedName)) {
      providers.codex = {
        ...codex,
        models: { ...Object.fromEntries(providerModels(codex).map((model) => [model.id,
          Array.isArray(codex.models) ? { name: model.name } : record(codex.models)[model.id]])), [requestedName]: {
          name: requestedName, capabilities: { vision: true, thinking: true, tools: true },
        } },
      };
    }
  }
  raw.providers = providers;
  raw.model = mergedModel;
  raw.node = { ...record(globalConfig.node), ...record(projectConfig.node) };
  raw.mesh = { ...record(globalConfig.mesh), ...record(projectConfig.mesh) };
  raw.remote = { ...record(globalConfig.remote), ...record(projectConfig.remote) };
  raw.sync = { ...record(globalConfig.sync), ...record(projectConfig.sync) };
  raw.projects = { ...record(globalConfig.projects), ...record(projectConfig.projects) };
  raw.permission = { ...record(globalConfig.permission), ...record(projectConfig.permission) };
  raw.mcpServers = {
    ...record(record(globalConfig.mcp).servers), ...record(globalConfig.mcpServers ?? globalConfig.mcp_servers),
    ...record(record(projectConfig.mcp).servers), ...record(projectConfig.mcpServers ?? projectConfig.mcp_servers),
  };
  raw.lspServers = {
    ...record(record(globalConfig.lsp).servers), ...record(globalConfig.lspServers ?? globalConfig.lsp_servers),
    ...record(record(projectConfig.lsp).servers), ...record(projectConfig.lspServers ?? projectConfig.lsp_servers),
  };

  const modelConfig = record(raw.model);
  const storedEfforts = { ...record(preferences.codexEfforts), ...record(preferences.modelEfforts) };
  const forcedEffort = codexEffort(process.env.LUBAN_CODEX_EFFORT);
  const configuredEffort = codexEffort(text(modelConfig.reasoning_effort, modelConfig.reasoningEffort));
  // Preserve historical defaults independently of catalog visibility.
  const goConnected = Boolean(text(process.env.OPENCODE_GO_API_KEY, process.env.OPENCODE_API_KEY, opencodeAuthKey(), sharedOpenCode));
  const zenConnected = Boolean(text(record(builtins["opencode-zen"]).api_key));
  const fallbackModels = !hasExplicitProviders && (singleModel || (!codexEnabled && !goConnected && !zenConnected))
    ? collectModels({ model: mergedModel }, consoleSession, sharedOpenCode) : [];
  const catalog = collectModels(raw, consoleSession, sharedOpenCode);
  const defaultModel = fallbackModels[0] ?? (hasExplicitProviders ? catalog.find(model => model.provider in explicitProviders) : undefined)
    ?? catalog.find(model => model.provider === (codexEnabled ? "codex" : goConnected ? "opencode-go" : "opencode-zen"))
    ?? catalog[0]!;
  const models = [...fallbackModels, ...catalog].map((model) => {
    const stored = storedEfforts[model.id];
    const effort = (model.api === "codex" ? forcedEffort : undefined)
      ?? (stored === "" ? undefined : codexEffort(stored) ?? model.reasoningEffort ?? configuredEffort);
    // Apply last so saved user keys beat project/global config, env and OAuth,
    // including the legacy single-model (openai-compatible) fallback.
    const apiKey = Object.hasOwn(savedProviderKeys, model.provider) ? savedProviderKeys[model.provider]! : model.apiKey;
    return { ...model, apiKey, reasoningEffort: effort };
  });
  const requested = requestedModel;
  const active = models.find((item) => item.id === requested || item.model === requested)
    ?? models.find(item => item.id === defaultModel.id)!;
  const nodeConfig = record(raw.node);
  const nodeFrontend = record(raw.node_frontend);
  const meshConfig = record(raw.mesh);
  const syncConfig = record(raw.sync);
  const permissionConfig = record(raw.permission);
  const outputConfig = record(raw.output);
  // 极简模式 (`/concise` in the TUI, the 极简 button in the desktop app): the
  // transcript keeps the question and the final answer, the process streams
  // past in the live one-line status. `true` also accepts the older wording
  // (`output.concise`, `verbosity: "concise"`) so a hand-written config works.
  const conciseSetting = raw.concise ?? raw.minimal_transcript ?? raw.minimalTranscript
    ?? outputConfig.concise ?? outputConfig.minimal;
  const conciseEnv = process.env.LUBAN_CONCISE?.trim();
  const concise = conciseEnv
    ? /^(1|on|true|yes)$/iu.test(conciseEnv)
    : typeof conciseSetting === "boolean"
      ? conciseSetting
      : ["concise", "minimal", "brief"].includes(text(raw.verbosity).toLowerCase());
  const nodePort = options.meshPort ?? integer(process.env.LUBAN_PORT, integer(nodeConfig.port, 7891));
  const tokenEnv = text(meshConfig.token_env, meshConfig.tokenEnv, "LUBAN_MESH_TOKEN");
  const syncMode = text(syncConfig.mode, "auto") as SyncMode;
  const conflictPolicy = text(syncConfig.conflict_policy, syncConfig.conflictPolicy, "auto") as ConflictPolicy;
  const projectPaths = Object.fromEntries(Object.entries(record(raw.projects)).map(([name, path]) => [name, String(path)]));
  const themeSetting = raw.theme;
  const themeObject = record(themeSetting);
  const themeName = text(
    options.theme,
    process.env.LUBAN_THEME,
    // The last `/theme` choice in the TUI beats the static config file, the same
    // way the last `/models` choice beats `model.active`.
    preferences.theme,
    typeof themeSetting === "string" ? themeSetting : text(themeObject.id, themeObject.name),
    "midnight",
  );
  const themeColors = Object.fromEntries(Object.entries(record(themeObject.colors ?? themeObject.palette))
    .flatMap(([key, value]) => typeof value === "string" && value.trim() ? [[key, value.trim()]] : []));
  const thinkingSetting = modelConfig.thinking ?? modelConfig.enable_thinking ?? modelConfig.enableThinking;
  // Default to the client ceiling: a smaller default is what made reasoning
  // models burn the whole budget and fail the task instead of answering.
  const maxTokens = Math.max(256, integer(modelConfig.max_tokens, ABSOLUTE_MAX_OUTPUT_TOKENS));
  const defaultContextWindow = /qwen/iu.test(`${active.provider}/${active.model}`)
    ? 262_144 : Math.max(128_000, maxTokens + 64_000);
  const sandboxRaw = record(raw.sandbox);
  const sandboxModeRaw = text(sandboxRaw.mode, "soft").toLowerCase();
  const sandboxBackendRaw = text(sandboxRaw.backend, "none").toLowerCase();
  const toolOutputRaw = record(raw.tool_output ?? raw.toolOutput);
  const mcpRaw = record(raw.mcp);
  const kevRaw = record(raw.kev);
  const historyRaw = record(raw.history);
  const usageStatsRaw = record(raw.usage_stats ?? raw.usageStats);
  const updatesRaw = record(raw.updates);
  const pluginsRaw = record(raw.plugins);
  const codeIntelRaw = record(raw.code_intelligence ?? raw.codeIntel);
  const remoteRaw = record(raw.remote);
  return {
    home,
    // Desktop permission belongs to the trusted global config, never a project.
    computerEnabled: record(globalConfig.computer).enabled !== false,
    workspace,
    project: basename(workspace) || text(nodeConfig.name, hostname()),
    theme: themeName.toLowerCase(),
    themeColors,
    model: active,
    models,
    maxTokens,
    temperature: Number(modelConfig.temperature ?? 0.2),
    timeoutMs: Number(modelConfig.timeout || 300) * 1000,
    thinkingTimeoutMs: Number(modelConfig.thinking_timeout ?? modelConfig.thinkingTimeout ?? 600) * 1000,
    // An absent setting (or "auto") lets the runner choose per user request; a
    // command-line value wins over the config block.
    enableThinking: parseThinkingOption(options.thinking) ?? (typeof thinkingSetting === "boolean" ? thinkingSetting : undefined),
    // Complex coding tasks commonly need dozens of tool rounds. Keep a generous
    // default while retaining a finite upper bound for runaway sessions.
    maxSteps: Math.max(1, Math.min(2000, integer(raw.max_steps, 200))),
    contextWindow: Math.max(4_096, integer(modelConfig.context_window ?? modelConfig.contextWindow, defaultContextWindow)),
    contextReserve: Math.max(1_024, integer(modelConfig.context_reserve ?? modelConfig.contextReserve, 16_384)),
    semanticCompaction: modelConfig.semantic_compaction !== false && modelConfig.semanticCompaction !== false,
    maxHistoryMessages: Math.max(20, Math.min(500, integer(modelConfig.max_history_messages ?? modelConfig.maxHistoryMessages, 80))),
    maxRetries: Math.max(0, Math.min(10, integer(modelConfig.max_retries ?? modelConfig.maxRetries, 5))),
    modelReconnect: modelConfig.reconnect !== false,
    modelReconnectMaxDelayMs: Math.max(2, Math.min(300, integer(modelConfig.reconnect_max_delay, 60))) * 1000,
    mcpServers: normalizeMcpServers(raw.mcpServers),
    codeIntelWorker: codeIntelRaw.worker === true || codeIntelRaw.isolated === true,
    lspServers: lspServers(raw.lspServers),
    backendUrl: text(options.backendUrl, process.env.LUBAN_BACKEND_URL, nodeFrontend.backend_url),
    // Default to "edits": in-workspace file edits (already confined by
    // resolveInside) no longer interrupt every turn, while shell and network
    // tools still ask. "ask" made the most common operation the noisiest one.
    permissionMode: options.allow || process.env.LUBAN_ALLOW_TOOLS === "1" ? "allow"
      : (["ask", "edits", "allow"].includes(text(permissionConfig.mode)) ? text(permissionConfig.mode) : "edits") as "ask" | "edits" | "allow",
    approvalTimeoutSeconds: Math.max(0, integer(permissionConfig.approval_timeout_seconds ?? permissionConfig.approvalTimeoutSeconds, 600)),
    planning: (["off", "auto", "always"].includes(text(options.planning, raw.planning, process.env.LUBAN_PLANNING))
      ? text(options.planning, raw.planning, process.env.LUBAN_PLANNING)
      : "auto") as "off" | "auto" | "always",
    concise,
    permissions: {
      allow: stringList(permissionConfig.allow),
      deny: stringList(permissionConfig.deny),
    },
    // A local Kev/System One decision server is opt-in: `mode` picks the
    // engine ("model" keeps the original chat model deciding), and with no URL
    // the kev_decide tool is not registered at all, so the prompt is unchanged.
    kev: (() => {
      const mode = text(kevRaw.mode, kevRaw.decision_engine, kevRaw.decisionEngine, process.env.LUBAN_KEV_MODE).toLowerCase();
      const url = text(kevRaw.url, kevRaw.base_url, kevRaw.baseUrl, process.env.LUBAN_KEV_URL);
      // "kev" without a server URL would silently do nothing; fall back to the
      // model engine and say so instead of pretending the advisor is active.
      const requested = mode === "kev" || mode === "jev" ? "kev" : "model";
      const effective = requested === "kev" && !url.trim() ? "model" : requested;
      if (requested === "kev" && !url.trim()) {
        process.stderr.write("luban: kev.mode is \"kev\" but kev.url is empty; falling back to the model decision engine\n");
      }
      return {
        mode: effective,
        url,
        apiKey: text(kevRaw.api_key, kevRaw.apiKey, process.env.LUBAN_KEV_API_KEY, process.env.KEV_API_KEY),
        model: text(kevRaw.model, process.env.LUBAN_KEV_MODEL, "kev-latest"),
        timeoutSeconds: Math.max(1, Math.min(3600, integer(kevRaw.timeout ?? kevRaw.timeout_seconds ?? kevRaw.timeoutSeconds, 120))),
      };
    })(),
    sandbox: {
      mode: sandboxModeRaw === "strict" ? "strict" : sandboxModeRaw === "off" ? "off" : "soft",
      allowNetwork: sandboxRaw.allow_network !== false && sandboxRaw.allowNetwork !== false,
      allowOutsideWorkspace: sandboxRaw.allow_outside_workspace === true || sandboxRaw.allowOutsideWorkspace === true,
      backend: sandboxBackendRaw === "bwrap" || sandboxBackendRaw === "docker" || sandboxBackendRaw === "auto" ? sandboxBackendRaw : "none",
      dockerImage: text(sandboxRaw.docker_image ?? sandboxRaw.dockerImage, ""),
      denyPatterns: stringList(sandboxRaw.deny ?? sandboxRaw.deny_patterns ?? sandboxRaw.denyPatterns),
    },
    toolOutputRetentionDays: Math.max(1, Math.min(90, integer(toolOutputRaw.retention_days ?? toolOutputRaw.retentionDays, 7))),
    toolOutputMaxBytes: Math.max(1024 * 1024, integer(toolOutputRaw.max_bytes ?? toolOutputRaw.maxBytes, 500 * 1024 * 1024)),
    mcpMaxTools: Math.max(4, Math.min(256, integer(mcpRaw.max_tools ?? mcpRaw.maxTools, 128))),
    mcpLazy: mcpRaw.lazy === true || mcpRaw.lazy === "true",
    interactionLog: { enabled: record(raw.interaction_log).enabled === true },
    history: {
      enabled: historyRaw.enabled === true || historyRaw.enabled === "true" || process.env.LUBAN_HISTORY === "1",
      directory: text(historyRaw.directory, ""),
      maxMessagesPerSession: Math.max(0, integer(historyRaw.max_messages_per_session ?? historyRaw.maxMessagesPerSession, 0)),
    },
    usageStats: {
      enabled: !/^(0|off|false|no)$/i.test(String(process.env.LUBAN_USAGE_STATS ?? ""))
        && usageStatsRaw.enabled !== false && usageStatsRaw.enabled !== "false" && usageStatsRaw.enabled !== 0,
      url: text(usageStatsRaw.url, process.env.LUBAN_USAGE_STATS_URL, ""),
      // Fractions are the point: 0.25 keeps the dashboard within 15 minutes of
      // reality, and an idle install uploads nothing at all.
      intervalHours: Math.max(1 / 60, Math.min(24 * 7, flexible(usageStatsRaw.interval_hours ?? usageStatsRaw.intervalHours, 0.25))),
    },
    updates: {
      // Same escape hatch as usage stats: LUBAN_UPDATES=off silences every check.
      check: !/^(0|off|false|no)$/iu.test(String(process.env.LUBAN_UPDATES ?? ""))
        && updatesRaw.check !== false && updatesRaw.check !== "false" && updatesRaw.check !== 0,
      url: text(updatesRaw.url, process.env.LUBAN_UPDATES_URL, ""),
      skippedVersion: text(updatesRaw.skipped_version ?? updatesRaw.skippedVersion, ""),
    },
    plugins: {
      registry: text(pluginsRaw.registry, process.env.LUBAN_PLUGIN_REGISTRY, ""),
    },
    mesh: {
      enabled: options.mesh ?? true,
      nodeName: text(options.meshName, process.env.LUBAN_NAME, nodeConfig.name, hostname()),
      host: text(process.env.LUBAN_HOST, nodeConfig.host, "0.0.0.0"),
      port: nodePort,
      udpPort: integer(process.env.LUBAN_UDP_PORT, integer(nodeConfig.udp_port ?? nodeConfig.udpPort, 7891)),
      capabilities: stringList(nodeConfig.capabilities, defaultCapabilities()),
      contacts: contacts(raw.contacts, nodePort || 7891),
      token: text(meshConfig.token, tokenEnv ? process.env[tokenEnv] : ""),
      syncMode: ["auto", "git", "chunk"].includes(syncMode) ? syncMode : "auto",
      chunkSize: Math.max(1024, integer(syncConfig.chunk_size ?? syncConfig.chunkSize, 65_536)),
      syncIgnore: stringList(syncConfig.ignore, [
        ".git", ".luban", ".dagent", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
        ".venv", "venv", "node_modules", "target", "*.pyc", "*.pyo", ".DS_Store", "*.log",
      ]),
      conflictPolicy: ["auto", "both", "source_wins", "dest_wins"].includes(conflictPolicy)
        ? conflictPolicy : "auto",
      jobsDir: resolve(text(raw.jobs_dir, join(home, "jobs"))),
      workspacesDir: resolve(text(raw.workspaces_dir, join(home, "workspaces"))),
      projects: projectPaths,
      maxWorkers: Math.max(1, integer(raw.max_workers, 2)),
      jobTimeoutSeconds: Math.max(30, integer(raw.job_timeout_seconds, 600)),
      queueTimeoutSeconds: Math.max(30, integer(raw.queue_timeout_seconds, 300)),
    },
    remote: {
      enabled: remoteRaw.enabled === true || remoteRaw.enabled === "true",
      host: text(remoteRaw.host, "127.0.0.1"),
      port: Math.max(0, Math.min(65_535, integer(remoteRaw.port, 0))),
      // config.json wins, then the environment, then the shipped tunnel address.
      relayUrl: text(remoteRaw.relay_url, remoteRaw.relayUrl, process.env.LUBAN_RELAY_PUBLIC_URL, DEFAULT_RELAY_URL),
      nodeTokenEnv: text(remoteRaw.node_token_env, remoteRaw.nodeTokenEnv, "LUBAN_RELAY_NODE_TOKEN"),
      nodeTokenFile: resolve(text(remoteRaw.node_token_file, remoteRaw.nodeTokenFile, join(homedir(), ".config/luban/relay.env"))),
      deviceTokenEnv: text(remoteRaw.device_token_env, remoteRaw.deviceTokenEnv, "LUBAN_RELAY_DEVICE_TOKEN"),
      relayCa: text(remoteRaw.relay_ca, remoteRaw.relayCa),
    },
  };
}

/**
 * `node-preferences.json` holds the choices a user made interactively - the
 * active model and the terminal theme. Both writers patch the file instead of
 * replacing it, so switching a theme never forgets the model and vice versa.
 */
async function savePreferences(home: string, patch: JsonObject): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = join(home, "node-preferences.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...readJson(path), ...patch }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function savePreferredModel(home: string, model: string, effort?: ModelRef["reasoningEffort"] | null): Promise<void> {
  await savePreferences(home, {
    model,
    ...(model.startsWith("codex/") ? { codexEnabled: true } : {}),
    ...(effort !== undefined ? {
      modelEfforts: { ...record(readJson(join(home, "node-preferences.json")).modelEfforts), [model]: effort ?? "" },
    } : {}),
  });
}

/** Persists the palette chosen with `/theme`, applied on the next start. */
export async function saveTheme(home: string, theme: string): Promise<void> {
  await savePreferences(home, { theme });
}

/**
 * Persist 极简模式: `/concise` in the terminal, the 极简 button in the desktop
 * app. It only changes how a transcript is drawn, so the running session, the
 * prompt and the saved history keep every step.
 */
export async function saveConciseMode(home: string, enabled: boolean): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = join(home, "config.json");
  const config = readJson(path);
  const temporary = `${path}.${process.pid}.tmp`;
  // Temp file plus rename: a concurrent reader must never see half a config.
  await writeFile(temporary, `${JSON.stringify({ ...config, concise: enabled }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/**
 * Write one `updates` setting (the terminal's `/update` toggle, the desktop
 * menu and the phone's switch all end up here).
 *
 * Only the keys passed are touched: turning checking back on must not erase the
 * version the user asked to skip.
 */
export async function saveUpdateSettings(home: string, patch: { check?: boolean; skippedVersion?: string; url?: string }): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = join(home, "config.json");
  const config = readJson(path);
  const current = record(config.updates);
  const next = {
    check: patch.check ?? (current.check !== false),
    url: patch.url ?? (typeof current.url === "string" ? current.url : ""),
    skipped_version: patch.skippedVersion ?? (typeof current.skipped_version === "string" ? current.skipped_version : ""),
  };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...config, updates: next }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export async function savePermissionMode(home: string, mode: "ask" | "edits" | "allow"): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = join(home, "config.json");
  const config = readJson(path);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...config, permission: { ...record(config.permission), mode } }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Register a workspace path so it survives a node restart and appears in the phone project list. */
export async function saveProject(home: string, name: string, workspace: string): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = join(home, "config.json");
  const config = readJson(path);
  const projects = { ...record(config.projects), [name]: workspace };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...config, projects }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Registered workspaces exactly as stored, without judging whether they exist. */
export async function readProjects(home: string): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(record(readJson(join(home, "config.json")).projects))
    .map(([name, path]) => [name, String(path)]));
}

/**
 * Drop registrations from config.json.
 *
 * Deleting a workspace's folder is not a thing luban does; forgetting an entry
 * only stops it being advertised, so a stale `/home/someone/dev/myapp` left by
 * another machine stops reappearing on the phone.
 */
export async function forgetProjects(home: string, names: string[]): Promise<string[]> {
  const path = join(home, "config.json");
  const config = readJson(path);
  const projects = record(config.projects);
  const removed = names.filter((name) => Object.hasOwn(projects, name));
  if (!removed.length) return [];
  for (const name of removed) delete projects[name];
  await mkdir(home, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...config, projects }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return removed;
}

export async function saveMeshContact(home: string, contact: MeshContact): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = join(home, "config.json");
  const config = readJson(path);
  const existing = contacts(config.contacts, contact.port);
  const next = [...existing.filter((item) => item.name !== contact.name), contact].map((item) => ({
    name: item.name,
    host: item.host,
    port: item.port,
    ...(item.udpPort ? { udp_port: item.udpPort } : {}),
    ...(item.note ? { note: item.note } : {}),
  }));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...config, contacts: next }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
