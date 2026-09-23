import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { scopedInstructions } from "./instructions.js";
import { AgentRunner, initialMessages } from "./agent.js";
import type { LubanConfig, ChatMessage, ToolCall } from "./types.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luban-instructions-")); roots.push(root);
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await writeFile(join(root, "src", "AGENTS.md"), "Use the compatibility API.");
  await writeFile(join(root, "src", "deep", "AGENTS.md"), "Keep the stable export name.");
  await writeFile(join(root, "src", "deep", "a.ts"), "export const value = 1;\n");
  return root;
}
const call = (id: string, name: string, args: unknown): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (toolCalls: ToolCall[] = []) => ({ content: toolCalls.length ? "checking" : "done", toolCalls, usage: { input: 1, output: 1 } });
it("loads ancestor-to-descendant scopes, detects removal, and rejects external symlink rules", async () => {
  const root = await fixture();
  const rules = await scopedInstructions(root, ["src/deep/a.ts"]);
  expect(rules.map((rule) => rule.content)).toEqual([expect.stringContaining("compatibility API"), expect.stringContaining("stable export")]);
  expect(await scopedInstructions(root, ["elsewhere.ts"])).toEqual([]);
  await rm(join(root, "src", "deep", "AGENTS.md"));
  expect((await scopedInstructions(root, ["src/deep/a.ts"], rules)).at(-1)?.content).toContain("no longer exists");
  const outside = await mkdtemp(join(tmpdir(), "luban-outside-")); roots.push(outside);
  await writeFile(join(outside, "rules.md"), "external rules");
  await symlink(join(outside, "rules.md"), join(root, "src", "deep", "AGENTS.md"));
  await expect(scopedInstructions(root, ["src/deep/a.ts"])).rejects.toThrow("escapes");
});
it("defers a write until the model has seen scoped instructions, even after a read in the same batch", async () => {
  const root = await fixture();
  const config = { workspace: root, home: root, project: "test", model: { name: "test" }, maxSteps: 5, maxTokens: 1000, permissionMode: "allow", semanticCompaction: false } as LubanConfig;
  const messages: ChatMessage[] = [...initialMessages(root), { role: "user", content: "update a.ts" }];
  let turn = 0;
  const args = { path: "src/deep/a.ts", content: "export const value = 2;\n" };
  const runner = new AgentRunner(config, { async complete(history) {
    turn++;
    if (turn === 1) return completion([call("r", "read_file", { path: args.path }), call("w", "write_file", args)]);
    if (turn === 2) {
      expect(await readFile(join(root, args.path), "utf8")).toContain("value = 1");
      expect(history.at(-1)?.content).toContain("Not executed");
      expect(history.some((message) => message.role === "system" && message.content?.includes("stable export"))).toBe(true);
      // Change a rule after the model saw it: the second write must be deferred too.
      await writeFile(join(root, "src", "AGENTS.md"), "Use updated API.");
      return completion([call("w2", "write_file", args)]);
    }
    if (turn === 3) {
      expect(history.at(-1)?.content).toContain("Not executed");
      return completion([call("w3", "write_file", args)]);
    }
    expect(await readFile(join(root, args.path), "utf8")).toContain("value = 2");
    return completion();
  } });
  try { expect((await runner.run(messages, "agent", new AbortController().signal, () => {}, async () => "always")).ok).toBe(true); }
  finally { runner.close(); }
});
it("loads instructions for every file in a patch before running git apply", async () => {
  const root = await fixture();
  const config = { workspace: root, home: root, project: "test", model: { name: "test" }, maxSteps: 2, maxTokens: 1000, permissionMode: "allow" } as LubanConfig;
  let turn = 0;
  const runner = new AgentRunner(config, { async complete(history) {
    if (++turn === 1) return completion([call("p", "apply_patch", { patch: "--- a/src/deep/a.ts\n+++ b/src/deep/a.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n" })]);
    expect(history.at(-1)?.content).toContain("Not executed");
    return completion();
  } });
  try {
    await runner.run([...initialMessages(root), { role: "user", content: "apply patch" }], "agent", new AbortController().signal, () => {}, async () => "always");
    expect(await readFile(join(root, "src", "deep", "a.ts"), "utf8")).toContain("value = 1");
  } finally { runner.close(); }
});
it("refuses dangling symlinks instead of allowing a later write to follow them", async () => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "luban-dangling-")); roots.push(outside);
  await symlink(join(outside, "missing.ts"), join(root, "src", "link.ts"));
  await expect(scopedInstructions(root, ["src/link.ts"])).rejects.toThrow("unresolved symlink");
});
