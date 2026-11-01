import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeMcpServers, stripJsonComments } from "./config.js";
import type { McpServerSettings } from "./types.js";

type JsonObject = Record<string, unknown>;

/** Which config file an entry lives in: `~/.luban` or the project `.luban`. */
export type McpScope = "global" | "project";
export type McpTransport = "stdio" | "http";
/** The two accepted spellings of the server map inside one config file. */
export type McpKey = "mcp.servers" | "mcpServers";

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  trusted: boolean;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  cwd?: string;
  scope: McpScope;
  /** Where the entry is written back, so a message can name the file honestly. */
  key: McpKey;
}

export interface McpPaths {
  home: string;
  workspace: string;
}

export interface McpTarget {
  name: string;
  scope: McpScope;
  key: McpKey;
  path: string;
}

/** Values accepted by `add`, from the CLI or the `/mcp` dialog. */
export interface McpServerInput {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
  trusted?: boolean;
  enabled?: boolean;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u;

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readJson(path: string): JsonObject {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as JsonObject;
  } catch {
    return {};
  }
}

/** The project config file, honouring the pre-v1.14 `.dagent` directory. */
export function projectConfigPath(workspace: string): string {
  const modern = join(resolve(workspace), ".luban", "config.json");
  if (existsSync(join(resolve(workspace), ".luban"))) return modern;
  const legacy = join(resolve(workspace), ".dagent", "config.json");
  return existsSync(legacy) ? legacy : modern;
}

export function mcpConfigPath(paths: McpPaths, scope: McpScope): string {
  return scope === "global" ? join(resolve(paths.home), "config.json") : projectConfigPath(paths.workspace);
}

function bucket(raw: JsonObject, key: McpKey): JsonObject {
  if (key === "mcpServers") return record(raw.mcpServers ?? raw.mcp_servers);
  return record(record(raw.mcp).servers);
}

function storeBucket(raw: JsonObject, key: McpKey, servers: JsonObject): void {
  if (key === "mcpServers") {
    // Writing back to the spelling the file already uses keeps a hand-edited
    // config recognisable instead of duplicating the block under a second name.
    if (raw.mcpServers === undefined && raw.mcp_servers !== undefined) raw.mcp_servers = servers;
    else raw.mcpServers = servers;
    return;
  }
  raw.mcp = { ...record(raw.mcp), servers };
}

/** The keys a name is written to, in the order the loader merges them. */
const KEYS: McpKey[] = ["mcp.servers", "mcpServers"];

function existingKey(raw: JsonObject, name: string): McpKey | undefined {
  return KEYS.find((key) => Object.hasOwn(bucket(raw, key), name));
}

/** A new entry joins the convention the file already follows. */
function preferredKey(raw: JsonObject): McpKey {
  if (raw.mcpServers !== undefined || raw.mcp_servers !== undefined) return "mcpServers";
  if (record(raw.mcp).servers !== undefined) return "mcp.servers";
  return "mcpServers";
}

function toEntry(name: string, settings: McpServerSettings, scope: McpScope, key: McpKey): McpServerEntry {
  return {
    name,
    transport: settings.url ? "http" : "stdio",
    enabled: settings.enabled,
    trusted: settings.trusted,
    ...(settings.command ? { command: settings.command } : {}),
    args: settings.args,
    env: settings.env,
    ...(settings.url ? { url: settings.url } : {}),
    headers: settings.headers,
    ...(settings.cwd ? { cwd: settings.cwd } : {}),
    scope,
    key,
  };
}

function entriesInFile(path: string, scope: McpScope): McpServerEntry[] {
  const raw = readJson(path);
  const out = new Map<string, McpServerEntry>();
  for (const key of KEYS) {
    for (const [name, settings] of Object.entries(normalizeMcpServers(bucket(raw, key)))) {
      out.set(name, toEntry(name, settings, scope, key));
    }
  }
  return [...out.values()];
}

/**
 * Every configured server, project entries overriding global ones by name.
 *
 * Reads the files instead of the loaded config because the management commands
 * have to know which file to write back to, and the loaded config flattens that
 * fact away.
 */
export function mcpServerEntries(paths: McpPaths): McpServerEntry[] {
  const merged = new Map<string, McpServerEntry>();
  for (const scope of ["global", "project"] as const) {
    for (const entry of entriesInFile(mcpConfigPath(paths, scope), scope)) merged.set(entry.name, entry);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findMcpServer(paths: McpPaths, name: string): McpServerEntry | undefined {
  return mcpServerEntries(paths).find((entry) => entry.name === name);
}

export function assertMcpName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`invalid MCP server name ${JSON.stringify(name)}: use letters, digits, '.', '_' or '-' (1-40 characters)`);
  }
}

/** Turn user input into the settings shape the runtime expects. */
export function buildMcpSettings(input: McpServerInput): McpServerSettings {
  const command = text(input.command);
  const url = text(input.url);
  if (!command && !url) throw new Error("an MCP server needs a command (stdio) or a url (Streamable HTTP)");
  if (command && url) throw new Error("give either a command or a url, not both");
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
    } catch {
      throw new Error(`invalid MCP server url: ${url}`);
    }
  }
  return {
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    args: [...(input.args ?? [])],
    env: { ...(input.env ?? {}) },
    headers: { ...(input.headers ?? {}) },
    ...(text(input.cwd) ? { cwd: text(input.cwd) } : {}),
    enabled: input.enabled !== false,
    trusted: input.trusted === true,
  };
}

async function mutate(path: string, change: (raw: JsonObject) => void): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const raw = readJson(path);
  change(raw);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/** Add a server, or replace the one of the same name in the chosen file. */
export async function upsertMcpServer(paths: McpPaths, scope: McpScope, name: string, input: McpServerInput): Promise<McpTarget> {
  assertMcpName(name);
  const settings = buildMcpSettings(input);
  const path = mcpConfigPath(paths, scope);
  let key: McpKey = "mcpServers";
  await mutate(path, (raw) => {
    key = existingKey(raw, name) ?? preferredKey(raw);
    storeBucket(raw, key, { ...bucket(raw, key), [name]: settings });
  });
  return { name, scope, key, path };
}

/**
 * Flip `enabled`/`trusted` on the file that actually holds the entry.
 *
 * A project entry shadows a global one, so the write has to follow the entry
 * rather than always landing in `~/.luban/config.json`.
 */
export async function patchMcpServer(paths: McpPaths, name: string, patch: { enabled?: boolean; trusted?: boolean }): Promise<McpTarget> {
  const entry = findMcpServer(paths, name);
  if (!entry) throw new Error(`unknown MCP server ${JSON.stringify(name)}`);
  const path = mcpConfigPath(paths, entry.scope);
  await mutate(path, (raw) => {
    const servers = bucket(raw, entry.key);
    const next: JsonObject = {
      ...record(servers[name]),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.trusted === undefined ? {} : { trusted: patch.trusted }),
    };
    // Drop the alias a hand-written entry may have used, or it would keep
    // winning over the flag just written (both are read as `!== false` / `=== true`).
    if (patch.enabled !== undefined) delete next.disabled;
    if (patch.trusted !== undefined) delete next.trust;
    servers[name] = next;
    storeBucket(raw, entry.key, servers);
  });
  return { name, scope: entry.scope, key: entry.key, path };
}

export async function removeMcpServer(paths: McpPaths, name: string): Promise<McpTarget> {
  const entry = findMcpServer(paths, name);
  if (!entry) throw new Error(`unknown MCP server ${JSON.stringify(name)}`);
  const path = mcpConfigPath(paths, entry.scope);
  await mutate(path, (raw) => {
    const servers = bucket(raw, entry.key);
    delete servers[name];
    storeBucket(raw, entry.key, servers);
  });
  return { name, scope: entry.scope, key: entry.key, path };
}

/** One line describing how the server is reached, for lists and dialogs. */
export function describeMcpTransport(entry: McpServerEntry): string {
  if (entry.transport === "http") return entry.url ?? "";
  return [entry.command, ...entry.args].filter(Boolean).join(" ");
}

export function describeMcpFlags(entry: McpServerEntry): string {
  const state = entry.enabled ? "启用" : "停用";
  return `${state} · ${entry.trusted ? "trusted（工具直接注册）" : "需批准后调用"}`;
}
