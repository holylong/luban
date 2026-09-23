import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner, initialMessages, isRoutineGitPublishRequest, systemPrompt } from "./agent.js";
import { createTools } from "./tools.js";
import type { ChatMessage, LubanConfig } from "./types.js";

function git(directory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luban-publish-"));
  const remote = join(root, "remote.git");
  const workspace = join(root, "work");
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", workspace);
  git(workspace, "config", "user.name", "Luban Test");
  git(workspace, "config", "user.email", "luban@example.test");
  git(workspace, "remote", "add", "origin", remote);
  await writeFile(join(workspace, "app.txt"), "before\n");
  git(workspace, "add", "app.txt");
  git(workspace, "commit", "-m", "initial");
  git(workspace, "push", "-u", "origin", "main");
  await writeFile(join(workspace, "app.txt"), "after\n");
  const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "" };
  const config = {
    home: root, workspace, project: "test", model, models: [model], maxTokens: 2000,
    temperature: 0, timeoutMs: 1000, maxSteps: 5, backendUrl: "", permissionMode: "edits",
  } as LubanConfig;
  return { root, remote, workspace, config };
}

describe("git_publish", () => {
  it("commits and pushes in one approved tool call and two model calls", async () => {
    const { remote, workspace, config } = await fixture();
    let modelCalls = 0;
    let approvals = 0;
    const thinking: Array<boolean | undefined> = [];
    const runner = new AgentRunner(config, {
      async complete(_messages, _tools, _signal, _onDelta, _onNotice, options) {
        thinking.push(options?.enableThinking);
        modelCalls += 1;
        return modelCalls === 1
          ? { content: "", toolCalls: [{ id: "publish", type: "function" as const, function: { name: "git_publish", arguments: '{"message":"Update app"}' } }], usage: { input: 1, output: 1 } }
          : { content: "Committed and pushed.", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "提交代码到服务器" }];
    try {
      const result = await runner.run(messages, "agent", new AbortController().signal, () => undefined,
        async () => { approvals += 1; return "once"; });
      expect(result.ok).toBe(true);
      expect(result.modelCalls).toBe(2);
      expect(modelCalls).toBe(2);
      expect(approvals).toBe(1);
      expect(thinking).toEqual([false, false]);
      expect(git(workspace, "status", "--porcelain")).toBe("");
      expect(git(workspace, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "refs/heads/main"));
      expect(git(workspace, "log", "-1", "--format=%s")).toBe("Update app");
      expect(await readFile(join(workspace, "app.txt"), "utf8")).toBe("after\n");
    } finally { runner.close(); }
  });

  it("does not stage files when no upstream is configured", async () => {
    const { workspace, config } = await fixture();
    git(workspace, "branch", "--unset-upstream");
    const tool = createTools(config).get("git_publish")!;
    await expect(tool.execute({ message: "Update app" }, new AbortController().signal)).rejects.toThrow("upstream");
    expect(git(workspace, "diff", "--cached", "--name-only")).toBe("");
  });

  it("keeps thinking enabled for a request that includes coding work", async () => {
    const { workspace, config } = await fixture();
    config.enableThinking = true;
    const received: Array<boolean | undefined> = [];
    const runner = new AgentRunner(config, {
      async complete(_messages, _tools, _signal, _onDelta, _onNotice, options) {
        received.push(options?.enableThinking);
        return { content: "Ready.", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    try {
      await runner.run([...initialMessages(workspace), { role: "user", content: "先修复错误并运行测试，然后提交代码到服务器" }],
        "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(received).toEqual([true]);
    } finally { runner.close(); }
  });

  it("keeps routine publish requests out of the planning path", () => {
    expect(systemPrompt("auto")).toContain("call git_publish directly");
    expect(systemPrompt("auto")).toContain("Do not create a plan");
    expect(isRoutineGitPublishRequest("提交代码到服务器")).toBe(true);
    expect(isRoutineGitPublishRequest("请把这个临时仓库的代码提交并推送到已配置的 Git 上游，提交说明为 Update demo。不要修改文件，也不用创建计划。")).toBe(true);
    expect(isRoutineGitPublishRequest("先修复错误并运行测试，然后提交代码到服务器")).toBe(false);
    expect(isRoutineGitPublishRequest("分析 Git 推送为何失败")).toBe(false);
  });
});
