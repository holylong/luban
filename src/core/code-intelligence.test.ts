import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { codeIntelligenceTool } from "./code-intelligence.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luban-code-")); roots.push(root);
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noLib: true }, include: ["*.ts"] }));
  await writeFile(join(root, "lib.ts"), 'export function greet(name: string): string { return name; }\n');
  await writeFile(join(root, "main.ts"), 'import { greet } from "./lib";\nconst answer: number = greet("world");\n');
  return root;
}
it("resolves cross-file definitions and references and refreshes diagnostics after edits", async () => {
  const root = await fixture();
  const tool = codeIntelligenceTool(root), signal = new AbortController().signal;
  const run = async (operation: string, rest = {}) => JSON.parse(await tool.execute({ path: "main.ts", operation, ...rest }, signal));
  const definitions = await run("definitions", { line: 2, column: 24 });
  expect(definitions.results.some((item: {path:string}) => item.path === "lib.ts")).toBe(true);
  const references = await run("references", { line: 2, column: 24 });
  expect(new Set(references.results.map((item: {path:string}) => item.path))).toEqual(new Set(["main.ts", "lib.ts"]));
  expect((await run("diagnostics")).results.some((item: {code:number}) => item.code === 2322)).toBe(true);
  await writeFile(join(root, "main.ts"), 'import { greet } from "./lib";\nconst answer: string = greet("world");\n');
  expect((await run("diagnostics")).results.some((item: {code:number}) => item.code === 2322)).toBe(false);
  expect((await run("symbols")).results.some((item: {name:string}) => item.name === "answer")).toBe(true);
});
it("honors nested tsconfig and rejects external paths, symlinks, and invalid positions", async () => {
  const root = await fixture();
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "tsconfig.json"), '{"compilerOptions":{"strict":true,"noLib":true}}');
  await writeFile(join(root, "nested", "a.ts"), 'export const x = 1;');
  const tool = codeIntelligenceTool(root), signal = new AbortController().signal;
  expect(JSON.parse(await tool.execute({ path: "nested/a.ts", operation: "symbols" }, signal)).config).toBe("nested/tsconfig.json");
  await expect(tool.execute({ path: "../outside.ts", operation: "symbols" }, signal)).rejects.toThrow("escapes");
  const outside = await mkdtemp(join(tmpdir(), "luban-outside-")); roots.push(outside);
  await writeFile(join(outside, "secret.ts"), "const secret = 42;");
  await symlink(join(outside, "secret.ts"), join(root, "alias.ts"));
  await expect(tool.execute({ path: "alias.ts", operation: "symbols" }, signal)).rejects.toThrow("escapes");
  await expect(tool.execute({ path: "main.ts", operation: "definitions", line: 999, column: 1 }, signal)).rejects.toThrow("position");
});
it("falls back to text matching for Python and honours result budgets", async () => {
  const root = await fixture();
  await writeFile(join(root, "app.py"), 'def hello(name):\n    return name\n\nclass Greeter:\n    pass\n');
  await writeFile(join(root, "use.py"), 'from app import hello\nprint(hello("w"))\n');
  const tool = codeIntelligenceTool(root), signal = new AbortController().signal;
  const symbols = JSON.parse(await tool.execute({ path: "app.py", operation: "symbols" }, signal));
  expect(symbols.engine).toBe("text-fallback");
  expect(symbols.results.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(["hello", "Greeter"]));
  const refs = JSON.parse(await tool.execute({ path: "use.py", operation: "references", line: 2, column: 8, max_results: 5 }, signal));
  expect(refs.results.length).toBeLessThanOrEqual(5);
  const diag = JSON.parse(await tool.execute({ path: "app.py", operation: "diagnostics" }, signal));
  expect(diag.results[0].code).toBe("GENERIC_FALLBACK");
});

it("prefers LSP pull diagnostics and falls back without them", async () => {
  const root = await mkdtemp(join(tmpdir(), "luban-ci-diag-")); roots.push(root);
  const fixture = new URL("./test-fixtures/mock-lsp-diag.mjs", import.meta.url);
  const { pathname: serverPath } = fixture;
  await writeFile(join(root, "app.py"), "def hello(:\n    pass\n");
  const { codeIntelligenceTool: makeTool } = await import("./code-intelligence.js");
  const signal = new AbortController().signal;
  const withLsp = makeTool(root, { workspace: root, lspServers: { mock: { command: process.execPath, args: [serverPath], languages: ["python"], enabled: true } } });
  try {
    const diag = JSON.parse(await withLsp.execute({ path: "app.py", operation: "diagnostics" }, signal));
    expect(diag.engine).toBe("lsp:mock");
    expect(diag.results[0]).toMatchObject({ line: 2, code: "E999", category: "error" });
  } finally {
    withLsp.close?.();
  }
  const withoutLsp = makeTool(root, { workspace: root, lspServers: {} });
  try {
    const diag = JSON.parse(await withoutLsp.execute({ path: "app.py", operation: "diagnostics" }, signal));
    expect(diag.engine).toBe("text-fallback");
    expect(diag.results[0].code).toBe("GENERIC_FALLBACK");
  } finally {
    withoutLsp.close?.();
  }
});
