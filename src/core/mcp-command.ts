import { loadConfig } from "./config.js";
import { probeMcpServer } from "./mcp.js";
import {
  describeMcpFlags,
  describeMcpTransport,
  findMcpServer,
  mcpServerEntries,
  patchMcpServer,
  removeMcpServer,
  upsertMcpServer,
  type McpPaths,
  type McpScope,
  type McpServerEntry,
  type McpServerInput,
} from "./mcp-settings.js";
import { VERSION } from "../version.js";

const USAGE = `luban mcp — manage MCP servers (~/.luban/config.json, or the project .luban/config.json)

  luban mcp list [--json]
  luban mcp add <name> [--url <url>] [-- <command> [args...]]
                       [--env K=V]... [--header K=V]... [--cwd <dir>]
                       [--trusted] [--disabled] [--project]
  luban mcp remove <name>
  luban mcp enable <name> | disable <name>
  luban mcp trust <name> | untrust <name>
  luban mcp test <name> [--timeout <seconds>]

  --project writes to the workspace .luban/config.json instead of the global one.
  trusted servers stay connected and register <server>_<tool> directly; the rest
  are reachable through mcp_list_tools / mcp_call after approval.
  Changes apply on the next luban start.`;

interface Parsed {
  action?: string;
  positional: string[];
  command: string[] | undefined;
  options: Record<string, string | boolean | string[]>;
}

/** Hand-rolled parser: `add -- npx -y pkg` needs a literal `--` boundary. */
function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};
  // A repeated `--env`/`--header` accumulates instead of overwriting the last.
  const set = (name: string, value: string | boolean): void => {
    const previous = options[name];
    options[name] = previous === undefined ? value : [...[previous].flat().map(String), String(value)];
  };
  let command: string[] | undefined;
  const valued = new Set(["url", "env", "header", "cwd", "timeout", "scope"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") { command = argv.slice(index + 1); break; }
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const name = token.slice(2);
    const equals = name.indexOf("=");
    if (equals > 0) { set(name.slice(0, equals), name.slice(equals + 1)); continue; }
    if (valued.has(name)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${token} needs a value`);
      set(name, value);
      index += 1;
      continue;
    }
    set(name, true);
  }
  const [action, ...rest] = positional;
  return { action, positional: rest, command, options };
}

function pairs(list: string[]): Record<string, string> {
  return Object.fromEntries(list.map((item) => {
    const text = item;
    const equals = text.indexOf("=");
    if (equals <= 0) throw new Error(`expected KEY=VALUE, got ${JSON.stringify(text)}`);
    return [text.slice(0, equals), text.slice(equals + 1)];
  }));
}

type Options = Record<string, string | boolean | string[]>;

function scopeOf(options: Options): McpScope {
  if (options.project) return "project";
  const scope = typeof options.scope === "string" ? options.scope.trim().toLowerCase() : "";
  if (!scope || scope === "global") return "global";
  if (scope === "project" || scope === "local") return "project";
  throw new Error(`unknown scope ${JSON.stringify(scope)}: use global or project`);
}

function collect(options: Options, name: string): string[] {
  const raw = options[name];
  if (raw === undefined) return [];
  return [...[raw].flat().map(String)];
}

function requireName(parsed: Parsed): string {
  const name = parsed.positional[0];
  if (!name) throw new Error(`missing server name; run luban mcp without arguments for usage`);
  return name;
}

function line(entry: McpServerEntry): string {
  const where = entry.scope === "project" ? "project" : "global";
  return `${entry.enabled ? "●" : "○"} ${entry.name}  [${entry.transport} · ${where}]  ${describeMcpFlags(entry)}\n    ${describeMcpTransport(entry)}`;
}

export async function runMcp(argv: string[], paths?: McpPaths): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const action = parsed.action ?? "list";
  if (action === "help" || action === "--help") { process.stdout.write(`${USAGE}\n`); return 0; }
  if (action === "version" || action === "--version") { process.stdout.write(`${VERSION}\n`); return 0; }
  let config: ReturnType<typeof loadConfig> | undefined;
  const resolvedPaths = (): McpPaths => {
    if (paths) return paths;
    config ??= loadConfig({ workspace: process.cwd(), seedDefaults: true });
    return { home: config.home, workspace: config.workspace };
  };
  try {
    switch (action) {
      case "list": {
        const entries = mcpServerEntries(resolvedPaths());
        if (parsed.options.json) { process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`); return 0; }
        if (!entries.length) { process.stdout.write("no MCP servers configured; add one with: luban mcp add <name> -- <command>\n"); return 0; }
        process.stdout.write(`${entries.map(line).join("\n")}\n`);
        return 0;
      }
      case "add": {
        const name = requireName(parsed);
        const input: McpServerInput = {
          ...(parsed.command?.length
            ? { command: parsed.command[0], args: parsed.command.slice(1) }
            : typeof parsed.options.url === "string" ? { url: parsed.options.url } : {}),
          env: pairs(collect(parsed.options, "env")),
          headers: pairs(collect(parsed.options, "header")),
          ...(typeof parsed.options.cwd === "string" ? { cwd: parsed.options.cwd } : {}),
          trusted: parsed.options.trusted === true,
          enabled: parsed.options.disabled !== true,
        };
        const target = await upsertMcpServer(resolvedPaths(), scopeOf(parsed.options), name, input);
        process.stdout.write(`已写入 ${target.path}（${target.key}.${target.name}）· 下次启动 luban 生效\n`);
        if (!input.trusted) process.stdout.write("提示：未加 --trusted 时工具不会直接注册给模型，模型需通过 mcp_call 并按批准调用。\n");
        return 0;
      }
      case "remove":
      case "rm": {
        const target = await removeMcpServer(resolvedPaths(), requireName(parsed));
        process.stdout.write(`已删除 ${target.name}（${target.path}）\n`);
        return 0;
      }
      case "enable":
      case "disable": {
        const target = await patchMcpServer(resolvedPaths(), requireName(parsed), { enabled: action === "enable" });
        process.stdout.write(`${target.name} ${action === "enable" ? "已启用" : "已停用"}（${target.path}）· 下次启动生效\n`);
        return 0;
      }
      case "trust":
      case "untrust": {
        const target = await patchMcpServer(resolvedPaths(), requireName(parsed), { trusted: action === "trust" });
        process.stdout.write(`${target.name} ${action === "trust" ? "已信任（工具直接注册）" : "改为需批准调用"}（${target.path}）· 下次启动生效\n`);
        return 0;
      }
      case "test": {
        const pathsForTest = resolvedPaths();
        const name = requireName(parsed);
        const entry = findMcpServer(pathsForTest, name);
        if (!entry) throw new Error(`unknown MCP server ${JSON.stringify(name)}`);
        if (!entry.enabled) throw new Error(`${name} is disabled; run luban mcp enable ${name} first`);
        config ??= loadConfig({ workspace: pathsForTest.workspace });
        const settings = config.mcpServers[name];
        if (!settings) throw new Error(`${name} is not loadable from the config; check the file for a typo`);
        const seconds = Math.max(1, Math.min(120, Number(parsed.options.timeout ?? 20) || 20));
        const started = Date.now();
        const tools = await probeMcpServer(settings, pathsForTest.workspace, AbortSignal.timeout(seconds * 1000));
        process.stdout.write(`${name} 连接成功 · ${tools.length} 个工具 · ${Date.now() - started}ms\n`);
        for (const tool of tools) process.stdout.write(`  ${tool.name}${tool.description ? ` — ${tool.description.slice(0, 80)}` : ""}\n`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command ${JSON.stringify(action)}\n${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
