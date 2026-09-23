import { existsSync, readFileSync, renameSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ConflictPolicy, LubanConfig, McpServerSettings, MeshContact, ModelRef, SyncMode } from "./types.js";

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

function integer(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
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

function mcpServers(value: unknown): Record<string, McpServerSettings> {
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

function resolveKey(providerName: string, provider: JsonObject, fallback: JsonObject): string {
  const options = record(provider.options);
  const keyEnv = text(provider.api_key_env, provider.apiKeyEnv);
  return text(
    provider.api_key,
    provider.apiKey,
    options.api_key,
    options.apiKey,
    keyEnv ? process.env[keyEnv] : "",
    process.env[`${envKey(providerName)}_API_KEY`],
    fallback.api_key,
    fallback.apiKey,
    process.env.OPENAI_API_KEY,
    process.env.DEEPSEEK_API_KEY,
  );
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

function collectModels(raw: JsonObject): ModelRef[] {
  const providers = record(raw.providers);
  const modelConfig = record(raw.model);
  const result: ModelRef[] = [];
  for (const [providerName, value] of Object.entries(providers)) {
    const provider = record(value);
    const baseUrl = resolveBaseUrl(provider, modelConfig);
    const apiKey = resolveKey(providerName, provider, modelConfig);
    const apiRaw = text(provider.api, provider.type, providerName === "anthropic" ? "anthropic" : "openai").toLowerCase();
    const api = apiRaw === "anthropic" ? "anthropic" : apiRaw === "responses" ? "responses" : "openai";
    for (const model of providerModels(provider)) {
      const perModel = record((record(provider.models as JsonObject)[model.id] ?? {}) as unknown);
      const caps = record(perModel.capabilities ?? provider.capabilities ?? modelConfig.capabilities);
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
        capabilities: {
          vision: caps.vision !== undefined ? caps.vision === true : visionDefault,
          thinking: caps.thinking !== undefined ? caps.thinking === true : /qwen|deepseek-reasoner|claude|o1|o3/i.test(modelId),
          tools: caps.tools !== undefined ? caps.tools === true : true,
          responses: caps.responses !== undefined ? caps.responses === true : api === "responses",
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

export function loadConfig(options: LoadConfigOptions = {}): LubanConfig {
  const defaultHome = join(homedir(), ".luban");
  const home = resolve(process.env.LUBAN_HOME || defaultHome);
  if (home === defaultHome) migrateLegacyHome(defaultHome);
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
  if (Object.keys(globalProviders).length || Object.keys(projectProviders).length) {
    raw.providers = { ...globalProviders, ...projectProviders };
  }
  raw.model = { ...record(globalConfig.model), ...record(projectConfig.model) };
  raw.node = { ...record(globalConfig.node), ...record(projectConfig.node) };
  raw.mesh = { ...record(globalConfig.mesh), ...record(projectConfig.mesh) };
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

  const models = collectModels(raw);
  const modelConfig = record(raw.model);
  const preferences = readJson(join(home, "node-preferences.json"));
  const requested = text(options.model, process.env.LUBAN_MODEL, preferences.model, modelConfig.active, modelConfig.model);
  const active = models.find((item) => item.id === requested || item.model === requested) ?? models[0]!;
  const nodeConfig = record(raw.node);
  const nodeFrontend = record(raw.node_frontend);
  const meshConfig = record(raw.mesh);
  const syncConfig = record(raw.sync);
  const permissionConfig = record(raw.permission);
  const nodePort = options.meshPort ?? integer(process.env.LUBAN_PORT, integer(nodeConfig.port, 7891));
  const tokenEnv = text(meshConfig.token_env, meshConfig.tokenEnv, "LUBAN_MESH_TOKEN");
  const syncMode = text(syncConfig.mode, "auto") as SyncMode;
  const conflictPolicy = text(syncConfig.conflict_policy, syncConfig.conflictPolicy, "auto") as ConflictPolicy;
  const projectPaths = Object.fromEntries(Object.entries(record(raw.projects)).map(([name, path]) => [name, String(path)]));
  const thinkingSetting = modelConfig.thinking ?? modelConfig.enable_thinking ?? modelConfig.enableThinking;
  const maxTokens = Math.max(256, integer(modelConfig.max_tokens, 64_000));
  const defaultContextWindow = /qwen/iu.test(`${active.provider}/${active.model}`)
    ? 262_144 : Math.max(128_000, maxTokens + 64_000);
  const sandboxRaw = record(raw.sandbox);
  const sandboxModeRaw = text(sandboxRaw.mode, "soft").toLowerCase();
  const sandboxBackendRaw = text(sandboxRaw.backend, "none").toLowerCase();
  const toolOutputRaw = record(raw.tool_output ?? raw.toolOutput);
  const mcpRaw = record(raw.mcp);
  const codeIntelRaw = record(raw.code_intelligence ?? raw.codeIntel);
  return {
    home,
    workspace,
    project: basename(workspace) || text(nodeConfig.name, hostname()),
    model: active,
    models,
    maxTokens,
    temperature: Number(modelConfig.temperature ?? 0.2),
    timeoutMs: Number(modelConfig.timeout || 120) * 1000,
    thinkingTimeoutMs: Number(modelConfig.thinking_timeout ?? modelConfig.thinkingTimeout ?? 600) * 1000,
    // An absent setting (or "auto") lets the runner choose per user request.
    enableThinking: typeof thinkingSetting === "boolean" ? thinkingSetting : undefined,
    // Complex coding tasks commonly need dozens of tool rounds. Keep a generous
    // default while retaining a finite upper bound for runaway sessions.
    maxSteps: Math.max(1, Math.min(2000, integer(raw.max_steps, 200))),
    contextWindow: Math.max(4_096, integer(modelConfig.context_window ?? modelConfig.contextWindow, defaultContextWindow)),
    contextReserve: Math.max(1_024, integer(modelConfig.context_reserve ?? modelConfig.contextReserve, 16_384)),
    semanticCompaction: modelConfig.semantic_compaction !== false && modelConfig.semanticCompaction !== false,
    maxHistoryMessages: Math.max(20, Math.min(500, integer(modelConfig.max_history_messages ?? modelConfig.maxHistoryMessages, 80))),
    maxRetries: Math.max(0, Math.min(10, integer(modelConfig.max_retries ?? modelConfig.maxRetries, 3))),
    mcpServers: mcpServers(raw.mcpServers),
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
    permissions: {
      allow: stringList(permissionConfig.allow),
      deny: stringList(permissionConfig.deny),
    },
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
    mcpMaxTools: Math.max(4, Math.min(256, integer(mcpRaw.max_tools ?? mcpRaw.maxTools, 64))),
    mcpLazy: mcpRaw.lazy === true || mcpRaw.lazy === "true",
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
  };
}

export async function savePreferredModel(home: string, model: string): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = join(home, "node-preferences.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ model }, null, 2)}\n`, "utf8");
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
