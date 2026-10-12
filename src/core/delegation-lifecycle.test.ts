import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRunner, initialMessages } from "./agent.js";
import { SessionStore } from "./session-store.js";
import { OpenAiClient } from "./openai.js";
import { disposeWorktree } from "./worktree.js";
import type { ChatMessage, LubanConfig } from "./types.js";

const roots: string[] = [], worktrees: Array<{ root: string; path: string }> = [], runners: AgentRunner[] = [];
afterEach(async () => {
  runners.splice(0).forEach(runner => runner.close());
  vi.restoreAllMocks();
  for (const tree of worktrees.splice(0)) await disposeWorktree(tree.root, tree.path, new AbortController().signal);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});
async function fixture(fail = false) {
  const root = await mkdtemp(join(tmpdir(), "luban-delegation-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q"); git("config", "user.email", "test@test"); git("config", "user.name", "test"); git("config", "core.autocrlf", "false");
  await writeFile(join(root, "base.txt"), "base\n"); git("add", "."); git("commit", "-qm", "base");
  let round = 0;
  vi.spyOn(OpenAiClient.prototype, "complete").mockImplementation(async () => {
    if (++round > 1 && fail) throw new Error("child transport failed");
    return { content: round === 1 ? "" : "done", usage: { input: 1, output: 1 }, toolCalls: round === 1 ? [{ id: "write", type: "function" as const,
      function: { name: "write_file", arguments: JSON.stringify({ path: "child.txt", content: "valuable child result\n" }) } }] : [] };
  });
  const runner = new AgentRunner({ workspace: root, home: root, project: "test", model: { name: "test" }, permissionMode: "allow", maxSteps: 10, maxTokens: 1000 } as LubanConfig);
  runners.push(runner);
  return { root, runner, git };
}
it("retains the complete worktree when automatic merging is disabled", async () => {
  const { root, runner } = await fixture();
  const output = await runner.tools.get("delegate_task")!.execute({ instruction: "create a new file", use_worktree: true, auto_merge: false }, new AbortController().signal);
  const path = output.match(/\[worktree preserved: (.+); full files/u)![1]; worktrees.push({ root, path });
  expect(await readFile(join(path, "child.txt"), "utf8")).toBe("valuable child result\n");
  expect(existsSync(join(root, "child.txt"))).toBe(false);
});
it("preserves completed child edits when a later model request fails", async () => {
  const { root, runner } = await fixture(true);
  let failure = "";
  try { await runner.tools.get("delegate_task")!.execute({ instruction: "create a new file", use_worktree: true, auto_merge: true }, new AbortController().signal); }
  catch (error) { failure = (error as Error).message; }
  expect(failure).toContain("child transport failed");
  const path = failure.match(/Worktree preserved for recovery: (.+)/u)![1]; worktrees.push({ root, path });
  expect(await readFile(join(path, "child.txt"), "utf8")).toBe("valuable child result\n");
});
it("merges successful child output with an inline edit record and removes only the completed worktree", async () => {
  const { root, runner, git } = await fixture();
  const output = await runner.tools.get("delegate_task")!.execute({ instruction: "create a new file", use_worktree: true, auto_merge: true }, new AbortController().signal);
  expect(output).toContain("1 applied, 0 conflicted");
  expect(output).toContain("Edited child.txt (+1 -0)");
  expect(await readFile(join(root, "child.txt"), "utf8")).toBe("valuable child result\n");
  expect(git("worktree", "list", "--porcelain").toString().match(/^worktree /gmu)).toHaveLength(1);
});
it("refuses delegation after the parent step budget is exhausted", async () => {
  const { runner } = await fixture();
  runner.config.maxSteps = 0;
  await expect(runner.tools.get("delegate_task")!.execute({ instruction: "another task" }, new AbortController().signal)).rejects.toThrow("parent step budget exhausted");
});
it("saves merged subtask edit records in the parent session for restoration", async () => {
  const { root, runner } = await fixture();
  let round = 0;
  const parent = new AgentRunner(runner.config, { async complete() {
    return { content: ++round === 1 ? "" : "done", usage: { input: 1, output: 1 }, toolCalls: round === 1 ? [{ id: "delegate", type: "function" as const,
      function: { name: "delegate_task", arguments: JSON.stringify({ instruction: "create a new file", use_worktree: true, auto_merge: true }) } }] : [] };
  } }); runners.push(parent);
  const messages: ChatMessage[] = [...initialMessages(root), { role: "user", content: "delegate the change" }];
  const store = new SessionStore(root), record = store.create("test", root, "agent", "test", messages);
  await parent.run(messages, "agent", new AbortController().signal, () => {}, async () => "once", () => store.save(record));
  const saved = await store.load(record.id, "test");
  expect(saved?.edits?.[0]).toMatchObject({ id: "delegate", name: "delegate_task" });
  expect(saved?.edits?.[0].preview).toContain("Edited child.txt (+1 -0)");
});
