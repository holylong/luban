import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "./agent.js";
import type { AgentEvent, ChatMessage, LubanConfig } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function setup(maxSteps: number) {
  const workspace = await mkdtemp(join(tmpdir(), "luban-poll-guard-"));
  roots.push(workspace);
  const model = {
    id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "",
    api: "openai" as const, capabilities: { vision: false, thinking: false, tools: true, responses: false },
  };
  const config = {
    home: workspace, workspace, project: "test", model, models: [model], maxTokens: 1000,
    temperature: 0, timeoutMs: 1000, maxSteps, backendUrl: "", permissionMode: "allow",
    contextWindow: 128_000, contextReserve: 16_384, semanticCompaction: false,
  } as unknown as LubanConfig;
  return { config, workspace };
}

/** Same body for every poll: a long build prints nothing until it finishes. */
const pollResult = (status: string) => JSON.stringify({
  id: "build-1", command: "npm run build", status, exit_code: status === "done" ? 0 : null,
  started_at: "2026-01-01T00:00:00Z", output: "vite v5.4 building for production...",
}, null, 2);

/** Polls one task `polls` times, then answers without tools. */
function pollingClient(polls: number) {
  let calls = 0;
  const history: ChatMessage[][] = [];
  return {
    calls: () => calls,
    history,
    client: {
      async complete(messages: ChatMessage[]) {
        calls += 1;
        history.push(messages.map(message => ({ ...message })));
        if (calls > polls) return { content: "长任务还在后台运行，先汇报当前进度。", toolCalls: [], usage: { input: 1, output: 1 } };
        return {
          content: "",
          toolCalls: [{ id: `p${calls}`, type: "function" as const, function: { name: "get_background_task", arguments: '{"task_id":"build-1"}' } }],
          usage: { input: 1, output: 1 },
        };
      },
    },
  };
}

function runnerFor(config: LubanConfig, client: unknown, status: string): AgentRunner {
  const runner = new AgentRunner(config, client as never);
  // The guard is about the *answer* a poll returns, so a stub with the real
  // result shape isolates it from process timing.
  runner.tools.set("get_background_task", {
    name: "get_background_task", description: "poll", risk: "read", parameters: {},
    async execute() { return pollResult(status); },
  });
  return runner;
}

async function run(config: LubanConfig, workspace: string, client: unknown, status: string, events: AgentEvent[] = []) {
  const runner = runnerFor(config, client, status);
  try {
    const result = await runner.run([...initialMessages(workspace), { role: "user", content: "等构建完成再继续" }],
      "agent", new AbortController().signal, event => events.push(event), async () => "always");
    return { result, events };
  } finally { runner.close(); }
}

describe("repeated tool-call guard and background polling", () => {
  it("keeps polling a running task past the loop limit", async () => {
    const { config, workspace } = await setup(20);
    const fake = pollingClient(12);
    // Six identical "still running" answers used to stop the run at five
    // rounds, killing a healthy task in the middle of a long build.
    const { result, events } = await run(config, workspace, fake.client, "running");
    expect(result.ok).toBe(true);
    expect(result.stopReason).toBeUndefined();
    expect(fake.calls()).toBe(13);
    expect(events.some(event => event.type === "error")).toBe(false);
  });

  it("reminds the model that waiting is not progress after many unchanged polls", async () => {
    const { config, workspace } = await setup(20);
    const fake = pollingClient(10);
    await run(config, workspace, fake.client, "running");
    const nudged = fake.history.some(messages => messages.some(message =>
      String(message.content ?? "").includes("unchanged across 8 polls")));
    expect(nudged).toBe(true);
  });

  it("stops a poll loop that never changes even while the task runs, and says it keeps running", async () => {
    const { config, workspace } = await setup(60);
    const fake = pollingClient(60);
    const events: AgentEvent[] = [];
    const { result } = await run(config, workspace, fake.client, "running", events);
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("loop");
    expect(result.text).toContain("后台任务仍在运行");
    expect(events.some(event => event.type === "error" && event.text.includes("still running"))).toBe(true);
    expect(fake.calls()).toBe(30);
  });

  it("still catches polling a finished task over and over", async () => {
    const { config, workspace } = await setup(20);
    const fake = pollingClient(20);
    const { result } = await run(config, workspace, fake.client, "done");
    expect(result.ok).toBe(false);
    expect(result.stopReason).toBe("loop");
    // Five polls run, then the sixth trip is refused before executing.
    expect(fake.calls()).toBe(6);
  });
});
