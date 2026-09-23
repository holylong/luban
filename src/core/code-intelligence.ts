import { realpathSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import fg from "fast-glob";
import type { ToolDefinition } from "./types.js";
import { resolveInside } from "./paths.js";
import { LspManager, languageOfPath } from "./lsp.js";
import { runCodeIntelInChild } from "./code-intel-worker.js";
import type { LubanConfig } from "./types.js";

const GENERIC_SYMBOL_PATTERNS: Array<{ language: RegExp; patterns: RegExp[] }> = [
  { language: /\.(py|pyi)$/i, patterns: [/^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/] },
  { language: /\.(go)$/i, patterns: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/, /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)/] },
  { language: /\.(rs)$/i, patterns: [/^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/] },
  { language: /\.(java|kt|scala)$/i, patterns: [/^\s*(?:public|private|protected|static|final|abstract|\s)*(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/, /^\s*(?:public|private|protected|static|final|\s)*[A-Za-z_<>\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/] },
  { language: /\.(c|h|cpp|hpp|cc|cxx)$/i, patterns: [/^\s*(?:[A-Za-z_][A-Za-z0-9_:<>*&\s]+\s+)?([A-Za-z_][A-Za-z0-9_:]*)\s*\([^;]*\)\s*(?:\{|;|$)/, /^\s*(?:class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/] },
  { language: /\.(rb|php|swift|js|jsx|ts|tsx|mjs|cjs)$/i, patterns: [/^\s*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)|(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=)/, /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/] },
];

function genericSymbols(file: string, text: string): Array<{ name: string; kind: string; line: number; column: number; length: number }> {
  const entry = GENERIC_SYMBOL_PATTERNS.find((item) => item.language.test(file));
  const patterns = entry?.patterns ?? [/^\s*(?:function|class|def|fn|func|type|struct|enum|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/];
  const results: Array<{ name: string; kind: string; line: number; column: number; length: number }> = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      const name = match?.slice(1).find((group) => group);
      if (name) {
        results.push({ name, kind: "symbol", line: index + 1, column: line.indexOf(name) + 1, length: name.length });
        break;
      }
    }
  });
  return results;
}

async function genericSearch(
  workspace: string,
  operation: string,
  relPath: string,
  line: number | undefined,
  column: number | undefined,
  maxResults: number,
  scopeGlob: string | undefined,
  signal: AbortSignal,
): Promise<unknown[]> {
  const abs = await resolveInside(workspace, relPath);
  let target = "";
  try {
    const info = await stat(abs);
    if (info.size > 2_000_000) throw new Error("file is too large (2 MB limit)");
    target = await readFile(abs, "utf8");
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (operation === "symbols") {
    return genericSymbols(relPath, target).slice(0, maxResults).map((symbol) => ({ path: relPath, ...symbol }));
  }
  if (operation === "diagnostics") {
    // Regex fallback cannot typecheck; report that explicitly instead of silence.
    return [{ path: relPath, code: "GENERIC_FALLBACK", category: "suggestion",
      message: "No language server for this file type; symbols/definitions use text matching and diagnostics require the project's own toolchain (e.g. pytest, go vet, cargo check)." }];
  }
  if (typeof line !== "number" || typeof column !== "number") throw new Error("definitions/references require 1-based line and column");
  const lines = target.split("\n");
  if (line < 1 || line > lines.length) throw new Error("position is outside the file");
  const current = lines[line - 1]!;
  const left = current.slice(0, column - 1).match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const right = current.slice(column - 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  const symbol = `${left?.[0] ?? ""}${right?.[0] ?? ""}`.trim();
  if (!symbol) throw new Error("no symbol at the requested position");
  const expression = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const pattern = scopeGlob || "**/*";
  const files = await fg(pattern, { cwd: workspace, onlyFiles: true, dot: false,
    ignore: ["**/.git/**", "**/node_modules/**", "**/.luban/**", "**/dist/**", "**/target/**", "**/__pycache__/**", "**/*.lock"] });
  const results: unknown[] = [];
  for (const file of files.slice(0, 2000)) {
    signal.throwIfAborted();
    if (results.length >= maxResults) break;
    if (!/\.(py|go|rs|java|kt|c|h|cpp|hpp|rb|php|swift|toml|yaml|yml|json|md|sh)$/i.test(file) && !expression.test(file)) {
      // Still scan small text files; skip obvious binaries by extension.
      if (/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|wasm|exe|dll|so|dylib)$/i.test(file)) continue;
    }
    let content: string;
    try {
      const path = await resolveInside(workspace, file);
      const info = await stat(path);
      if (info.size > 1_000_000) continue;
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    content.split("\n").forEach((text, index) => {
      if (results.length >= maxResults) return;
      if (expression.test(text)) results.push({ path: file, line: index + 1, column: text.indexOf(symbol) + 1, length: symbol.length });
    });
  }
  return results;
}

function uriToWorkspaceRelative(uri: string, workspace: string): string | null {
  try {
    const url = new URL(String(uri));
    if (url.protocol !== "file:") return null;
    const root = resolve(workspace);
    const abs = decodeURIComponent(url.pathname);
    // Windows file URIs arrive as /C:/...; resolveInside-style relativization:
    const rel = relative(root, abs).split(sep).join("/");
    if (!rel || rel === ".." || rel.startsWith("../")) return null;
    return rel;
  } catch {
    return null;
  }
}

function flattenDocumentSymbols(items: unknown[], out: Array<{ name: string; kind: string; line: number; column: number; length: number; path: string }>, relOf: (uri: string) => string | null, fallbackPath: string): void {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const node = item as Record<string, unknown>;
    const name = typeof node.name === "string" ? node.name : "";
    const loc = node.location as { uri?: unknown; range?: unknown } | undefined;
    const range = (node.range ?? loc?.range ?? node.selectionRange) as { start?: { line?: number; character?: number }; end?: { character?: number } } | undefined;
    const path = (loc && typeof loc.uri === "string" ? relOf(loc.uri) : null) ?? fallbackPath;
    const startLine = Number(range?.start?.line ?? 0);
    const startChar = Number(range?.start?.character ?? 0);
    const endChar = Number(range?.end?.character ?? startChar + (name ? name.length : 1));
    if (name) out.push({ name, kind: typeof node.kind === "number" ? `kind-${node.kind}` : String(node.kind ?? "symbol"), path,
      line: startLine + 1, column: startChar + 1, length: Math.max(1, endChar - startChar) });
    const children = (node.children ?? node.children) as unknown;
    if (Array.isArray(children)) flattenDocumentSymbols(children, out, relOf, fallbackPath);
  }
}

function toDiagnosticItems(raw: unknown[], relOf: (uri: string) => string | null, fallbackPath: string): unknown[] {
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const diag = item as Record<string, unknown>;
    const range = diag.range as { start?: { line?: number; character?: number }; end?: { character?: number } } | undefined;
    const startLine = Number(range?.start?.line ?? 0);
    const startChar = Number(range?.start?.character ?? 0);
    const endChar = Number(range?.end?.character ?? startChar + 1);
    const severity = Number((diag as Record<string, unknown>).severity ?? 1);
    return [{
      path: fallbackPath,
      line: startLine + 1,
      column: startChar + 1,
      length: Math.max(1, endChar - startChar),
      code: (diag as Record<string, unknown>).code ?? "LSP",
      category: severity === 1 ? "error" : severity === 2 ? "warning" : "suggestion",
      message: String((diag as Record<string, unknown>).message ?? ""),
    }];
  });
}

async function queryLspDiagnostics(
  workspace: string,
  lsp: LspManager,
  relPath: string,
  maxResults: number,
  budgetMs: number,
  signal: AbortSignal,
): Promise<{ engine: string; server: string; results: unknown[] } | undefined> {
  const language = languageOfPath(relPath);
  if (!language) return undefined;
  const found = lsp.serverFor(language);
  if (!found) return undefined;
  const abs = await resolveInside(workspace, relPath);
  const client = await lsp.client(found.name, found.settings, signal);
  const uri = await client.openDocument(abs, signal);
  const relOf = (value: string) => uriToWorkspaceRelative(value, workspace);
  void relOf;
  const pulled = await client.pullDiagnostics(uri, signal).catch(() => undefined);
  if (pulled) return { engine: `lsp:${found.name}`, server: found.name, results: toDiagnosticItems(pulled, relOf, relPath).slice(0, maxResults) };
  // Push-model servers publish after didOpen; wait briefly within budget.
  const deadline = Date.now() + Math.max(200, Math.min(3000, budgetMs));
  for (;;) {
    signal.throwIfAborted();
    const published = client.publishedDiagnostics(uri);
    if (published.length || Date.now() >= deadline) {
      if (!published.length) return undefined;
      return { engine: `lsp:${found.name}`, server: found.name, results: toDiagnosticItems(published, relOf, relPath).slice(0, maxResults) };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function queryLsp(
  workspace: string,
  lsp: LspManager,
  relPath: string,
  operation: string,
  line: number | undefined,
  column: number | undefined,
  maxResults: number,
  scopeGlob: string | undefined,
  signal: AbortSignal,
): Promise<{ engine: string; server: string; results: unknown[] } | undefined> {
  const language = languageOfPath(relPath);
  if (!language) return undefined;
  const found = lsp.serverFor(language);
  if (!found) return undefined;
  const abs = await resolveInside(workspace, relPath);
  const client = await lsp.client(found.name, found.settings, signal);
  const uri = await client.openDocument(abs, signal);
  const relOf = (value: string) => uriToWorkspaceRelative(value, workspace);
  const keep = (path: string | null): boolean => {
    if (!path) return false;
    if (!scopeGlob) return true;
    try {
      const fgMod = (fg as unknown as { isMatch?: (a: string, b: string) => boolean });
      return fgMod.isMatch ? fgMod.isMatch(path, scopeGlob) : true;
    } catch {
      return true;
    }
  };
  if (operation === "symbols") {
    const raw = await client.request("textDocument/documentSymbol", { textDocument: { uri } }, signal) as unknown;
    const out: Array<{ name: string; kind: string; line: number; column: number; length: number; path: string }> = [];
    flattenDocumentSymbols(Array.isArray(raw) ? raw : [], out, relOf, relPath);
    return { engine: `lsp:${found.name}`, server: found.name, results: out.filter((item) => keep(item.path)).slice(0, maxResults) };
  }
  if (typeof line !== "number" || typeof column !== "number") throw new Error("definitions/references require 1-based line and column");
  const position = { line: line - 1, character: column - 1 };
  const method = operation === "definitions" ? "textDocument/definition" : "textDocument/references";
  const params = operation === "definitions"
    ? { textDocument: { uri }, position }
    : { textDocument: { uri }, position, context: { includeDeclaration: true } };
  const raw = await client.request(method, params, signal) as unknown;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const results: unknown[] = [];
  for (const item of items) {
    if (results.length >= maxResults) break;
    if (!item || typeof item !== "object") continue;
    const node = item as Record<string, unknown>;
    const target = (node.targetUri ?? node.uri) as unknown;
    const range = (node.targetRange ?? node.targetSelectionRange ?? node.range) as { start?: { line?: number; character?: number }; end?: { character?: number } } | undefined;
    if (typeof target !== "string" || !range?.start) continue;
    const path = relOf(target);
    if (!keep(path)) continue;
    const startLine = Number(range.start.line ?? 0);
    const startChar = Number(range.start.character ?? 0);
    const endChar = Number(range.end?.character ?? startChar + 1);
    results.push({ path, line: startLine + 1, column: startChar + 1, length: Math.max(1, endChar - startChar) });
  }
  return { engine: `lsp:${found.name}`, server: found.name, results };
}

/** Code intelligence: TS/JS language service, configured LSP servers, then text fallback. */
export function codeIntelligenceTool(workspace: string, config?: LubanConfig): ToolDefinition {
  const lsp = config ? new LspManager(config) : undefined;
  return {
    name: "code_intelligence",
    description: "Query definitions, references, symbols, or diagnostics. TypeScript/JavaScript use the TS language service; configured LSP servers (pyright/gopls/rust-analyzer/…) answer other languages; otherwise keyword matching applies. Positions are 1-based lines and UTF-16 columns. Use scope_glob to narrow monorepos. Use diagnostics after edits.",
    risk: "read",
    close: () => lsp?.close(),
    parameters: {
      type: "object", additionalProperties: false, required: ["path", "operation"],
      properties: {
        path: { type: "string" }, operation: { type: "string", enum: ["definitions", "references", "symbols", "diagnostics"] },
        line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, description: "Query time budget, default 30000" },
        max_results: { type: "integer", minimum: 1, maximum: 500, description: "Cap returned locations, default 200" },
        scope_glob: { type: "string", description: "Narrow reference search, e.g. packages/api/**" },
      },
    },
    async execute(args, signal) {
      signal.throwIfAborted();
      const started = Date.now();
      const timeoutMs = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms)
        ? Math.max(1000, Math.min(120000, Math.trunc(args.timeout_ms))) : 30_000;
      const maxResults = typeof args.max_results === "number" && Number.isFinite(args.max_results)
        ? Math.max(1, Math.min(500, Math.trunc(args.max_results))) : 200;
      // Isolated worker: a hung language service can be killed without
      // disturbing the agent. Unavailable builds fall back in-process; a
      // worker timeout is a real timeout and is reported as such.
      if (config?.codeIntelWorker === true) {
        try {
          return await runCodeIntelInChild(workspace, config.lspServers, args as Record<string, unknown>, signal, timeoutMs);
        } catch (error) {
          if (error instanceof Error && /unavailable/.test(error.message)) {
            // Fall through to in-process execution below.
          } else throw error;
        }
      }
      const timer = setTimeout(() => signal.throwIfAborted(), Math.max(1, timeoutMs));
      // Note: AbortSignal.timeout is avoided so callers can distinguish a query
      // budget from an explicit user cancel via signal.reason.
      try {
        if (typeof args.path !== "string") throw new Error("path must be a string");
        if (!["definitions", "references", "symbols", "diagnostics"].includes(String(args.operation))) throw new Error("invalid code intelligence operation");
        const file = await resolveInside(workspace, args.path);
        if (Date.now() - started > timeoutMs) throw new Error(`code intelligence timed out after ${timeoutMs}ms`);
        const scopeGlob = typeof args.scope_glob === "string" && args.scope_glob.trim() ? args.scope_glob.trim() : undefined;
        if (!/\.[cm]?[jt]sx?$/i.test(file)) {
          const rel = relative(resolve(workspace), file).split(sep).join("/");
          const line = typeof args.line === "number" ? args.line : undefined;
          const column = typeof args.column === "number" ? args.column : undefined;
          try {
            if (lsp && String(args.operation) === "diagnostics") {
              const remaining = Math.max(0, timeoutMs - (Date.now() - started));
              const viaLsp = await queryLspDiagnostics(workspace, lsp, rel, maxResults, remaining, signal).catch(() => undefined);
              if (viaLsp) return JSON.stringify({ operation: args.operation, engine: viaLsp.engine, config: viaLsp.server,
                total: viaLsp.results.length, truncated: viaLsp.results.length >= maxResults, results: viaLsp.results.slice(0, maxResults) });
            }
            if (lsp && String(args.operation) !== "diagnostics") {
              const viaLsp = await queryLsp(workspace, lsp, rel, String(args.operation), line, column, maxResults, scopeGlob, signal).catch(() => undefined);
              if (viaLsp) return JSON.stringify({ operation: args.operation, engine: viaLsp.engine, config: viaLsp.server,
                total: viaLsp.results.length, truncated: viaLsp.results.length >= maxResults, results: viaLsp.results.slice(0, maxResults) });
            }
            const results = await genericSearch(workspace, String(args.operation), rel, line, column, maxResults, scopeGlob, signal);
            return JSON.stringify({ operation: args.operation, engine: "text-fallback", config: null,
              total: results.length, truncated: results.length >= maxResults, results: results.slice(0, maxResults) });
          } finally {
            clearTimeout(timer);
          }
        }
      const ts = await import("typescript");
      const root = realpathSync(workspace);
      const libRoot = realpathSync(dirname(ts.getDefaultLibFilePath({})));
      const inside = (parent: string, path: string) => { const rel = relative(parent, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith("\\\\"); };
      const allowed = (path: string) => {
        try { const real = realpathSync(path); return inside(root, real) || inside(libRoot, real); } catch { return false; }
      };
      const read = (path: string) => {
        if (!allowed(path)) return undefined;
        try { if (statSync(path).size > 2_000_000) return undefined; } catch { return undefined; }
        return ts.sys.readFile(path);
      };
      const host: import("typescript").ParseConfigHost = {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        fileExists: (path) => allowed(path) && ts.sys.fileExists(path), readFile: read,
        readDirectory: (path, extensions, excludes, includes, depth) => allowed(path)
          ? ts.sys.readDirectory(path, extensions, excludes, includes, depth).filter(allowed) : [],
      };
      let configFile: string | undefined;
      let directory = dirname(file);
      for (;;) {
        configFile = [join(directory, "tsconfig.json"), join(directory, "jsconfig.json")].find(host.fileExists);
        if (configFile || resolve(directory) === resolve(workspace)) break;
        directory = dirname(directory);
      }
      const defaults: import("typescript").CompilerOptions = { allowJs: true, checkJs: true, noEmit: true,
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
      const parsed = configFile ? ts.readConfigFile(configFile, read) : undefined;
      if (parsed?.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
      const project = ts.parseJsonConfigFileContent(parsed?.config ?? { include: ["**/*"], exclude: ["node_modules", "dist", ".git"] }, host,
        configFile ? dirname(configFile) : resolve(workspace), undefined, configFile);
      // Config options take precedence over defaults, except emit is always disabled.
      const options = { ...defaults, ...project.options, noEmit: true };
      // Follow composite project references one level so cross-package
      // definitions resolve instead of silently returning empty results.
      const referencedFiles: string[] = [];
      try {
        const refs = (parsed?.config as { references?: Array<{ path: string }> } | undefined)?.references;
        if (Array.isArray(refs)) {
          for (const ref of refs.slice(0, 20)) {
            signal.throwIfAborted();
            if (!ref || typeof ref.path !== "string") continue;
            const refDir = resolve(configFile ? dirname(configFile) : resolve(workspace), ref.path);
            const refConfig = [join(refDir, "tsconfig.json"), join(refDir, "jsconfig.json")].find(host.fileExists);
            if (!refConfig) continue;
            const refParsed = ts.readConfigFile(refConfig, read);
            if (refParsed.error) continue;
            const refProject = ts.parseJsonConfigFileContent(refParsed.config ?? {}, host, dirname(refConfig), undefined, refConfig);
            referencedFiles.push(...refProject.fileNames.filter(allowed).slice(0, 500));
          }
        }
      } catch {
        // Reference expansion is best-effort; the primary project still answers.
      }
      const files = [...new Set([...project.fileNames.filter(allowed), ...referencedFiles, file])];
      if (files.length > 2000) throw new Error("code intelligence project exceeds 2000 source files; use a narrower tsconfig");
      let loadedBytes = 0;
      const snapshots = new Map<string, import("typescript").IScriptSnapshot | undefined>();
      const service = ts.createLanguageService({
        getCompilationSettings: () => options, getScriptFileNames: () => files, getScriptVersion: () => "0",
        getScriptSnapshot(path) {
          if (snapshots.has(path)) return snapshots.get(path);
          const text = read(path);
          loadedBytes += text?.length ?? 0;
          if (loadedBytes > 32_000_000) throw new Error("code intelligence source budget exceeds 32 MB");
          const snapshot = text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
          snapshots.set(path, snapshot);
          return snapshot;
        },
        getCurrentDirectory: () => resolve(workspace), getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: host.fileExists, readFile: read, readDirectory: (path, extensions, excludes, includes, depth) => [...host.readDirectory(path, extensions ?? [], excludes, includes ?? ["**/*"], depth)],
        directoryExists: (path) => allowed(path) && ts.sys.directoryExists(path),
        getDirectories: (path) => allowed(path) ? ts.sys.getDirectories(path).filter((name) => allowed(join(path, name))) : [],
        getCancellationToken: () => ({ isCancellationRequested: () => signal.aborted, throwIfCancellationRequested: () => signal.throwIfAborted() }),
      });
      try {
        const source = service.getProgram()?.getSourceFile(file);
        if (!source) throw new Error("file could not be loaded (missing, outside workspace, or exceeds 2 MB)");
        const location = (path: string, span: import("typescript").TextSpan) => {
          const source = service.getProgram()?.getSourceFile(path);
          const pos = source?.getLineAndCharacterOfPosition(span.start);
          return { path: relative(resolve(workspace), path).split(sep).join("/"), line: (pos?.line ?? 0) + 1,
            column: (pos?.character ?? 0) + 1, length: span.length };
        };
        let results: unknown[];
        if (args.operation === "diagnostics") {
          signal.throwIfAborted();
          if (Date.now() - started > timeoutMs) throw new Error(`code intelligence timed out after ${timeoutMs}ms`);
          results = [...project.errors, ...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map((diagnostic) => ({
            ...(diagnostic.file ? location(diagnostic.file.fileName, { start: diagnostic.start ?? 0, length: diagnostic.length ?? 0 }) : {}),
            code: diagnostic.code, category: ts.DiagnosticCategory[diagnostic.category], message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
          }));
        } else if (args.operation === "symbols") {
          results = [];
          const visit = (node: import("typescript").NavigationTree) => {
            if (node.kind !== "script") for (const span of node.spans) results.push({ name: node.text, kind: node.kind, ...location(file, span) });
            node.childItems?.forEach(visit);
          };
          visit(service.getNavigationTree(file));
        } else {
          const line = args.line, column = args.column;
          if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || typeof column !== "number" || !Number.isInteger(column) || column < 1) throw new Error("definitions/references require 1-based line and column");
          const starts = source.getLineStarts();
          if (line > starts.length || starts[line - 1]! + column - 1 > (starts[line] ?? source.text.length)) throw new Error("position is outside the file");
          const position = starts[line - 1]! + column - 1;
          const spans = args.operation === "definitions" ? service.getDefinitionAtPosition(file, position) ?? []
            : service.findReferences(file, position)?.flatMap((symbol) => symbol.references) ?? [];
          results = spans.filter((span) => allowed(span.fileName)).map((span) => location(span.fileName, span.textSpan));
        }
        if (Date.now() - started > timeoutMs) throw new Error(`code intelligence timed out after ${timeoutMs}ms`);
        return JSON.stringify({ operation: args.operation, engine: "typescript", config: configFile ? relative(resolve(workspace), configFile) : null,
          total: results.length, truncated: results.length > maxResults, results: results.slice(0, maxResults) });
      } finally { service.dispose(); clearTimeout(timer); }
      } catch (error) {
        clearTimeout(timer);
        throw error;
      }
    },
  };
}
