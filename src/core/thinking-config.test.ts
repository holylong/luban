import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { AgentRunner, initialMessages, shouldThink } from "./agent.js";
import { OpenAiClient } from "./openai.js";
import type { ChatMessage } from "./types.js";

let server: Server | undefined;
const originalHome = process.env.LUBAN_HOME;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
});

describe("self-hosted model output controls", () => {
  it("honors thinking=false and sends Qwen's chat-template switch", async () => {
    let body: Record<string, unknown> = {};
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: {} }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test address");
    const home = await mkdtemp(join(tmpdir(), "luban-thinking-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    await writeFile(join(home, "config.json"), JSON.stringify({ model: {
      model: "qwen3.8-27b", base_url: `http://127.0.0.1:${address.port}/v1`, thinking: false,
    } }));
    process.env.LUBAN_HOME = home;
    const config = loadConfig({ workspace });
    expect(config.enableThinking).toBe(false);
    expect(config.maxHistoryMessages).toBe(80);
    expect(config.contextWindow).toBe(262_144);
    await new OpenAiClient(config).complete([{ role: "user", content: "hi" }], [], new AbortController().signal);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    config.enableThinking = true;
    const client = new OpenAiClient(config);
    await client.complete([{ role: "user", content: "publish" }], [], new AbortController().signal,
      undefined, undefined, { enableThinking: false, maxTokens: 16_384 });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.max_tokens).toBe(16_384);
    await client.complete([{ role: "user", content: "solve a hard problem" }], [], new AbortController().signal);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it("chooses per request only when thinking is unset or auto", async () => {
    const cases = [
      { setting: undefined, prompt: "提交代码到服务器", thinking: false, fast: true },
      { setting: "auto", prompt: "查看 git status", thinking: false, fast: true },
      { setting: undefined, prompt: "分析这个项目的架构并设计改进方案", thinking: true, fast: false },
      { setting: true, prompt: "提交代码到服务器", thinking: true, fast: false },
      { setting: false, prompt: "分析这个项目的架构并设计改进方案", thinking: false, fast: false },
    ] as const;
    for (const item of cases) {
      const home = await mkdtemp(join(tmpdir(), "luban-auto-thinking-"));
      const workspace = join(home, "project");
      await mkdir(workspace);
      await writeFile(join(home, "config.json"), JSON.stringify({ model: { model: "qwen3.8-27b", ...(item.setting === undefined ? {} : { thinking: item.setting }) } }));
      process.env.LUBAN_HOME = home;
      const config = loadConfig({ workspace });
      const options: Array<{ enableThinking?: boolean; maxTokens?: number }> = [];
      const runner = new AgentRunner(config, {
        async complete(_messages, _tools, _signal, _onDelta, _onNotice, requestOptions) {
          options.push(requestOptions ?? {});
          return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
        },
      });
      const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: item.prompt }];
      try {
        await runner.run(messages, "agent", new AbortController().signal, () => undefined, async () => "once");
      } finally { runner.close(); }
      expect(options).toHaveLength(1);
      expect(options[0]?.enableThinking).toBe(item.thinking);
      expect(options[0]?.maxTokens === 8_192).toBe(item.fast);
    }
    expect(shouldThink("把 README.md 中的标题改成 新标题")).toBe(false);
    expect(shouldThink("如何证明这个算法的正确性？")).toBe(true);
  });

  it("turns thinking on after a tool fails during an otherwise simple request", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-thinking-recovery-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    const config = loadConfig({ workspace });
    const modes: boolean[] = [];
    const runner = new AgentRunner(config, {
      async complete(_messages, _tools, _signal, _onDelta, _onNotice, options) {
        modes.push(options?.enableThinking ?? true);
        return modes.length === 1
          ? { content: "", toolCalls: [{ id: "fail", type: "function" as const, function: { name: "failing_read", arguments: "{}" } }], usage: { input: 1, output: 1 } }
          : { content: "The tool failed; I need to diagnose it.", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    runner.tools.set("failing_read", { name: "failing_read", description: "test failure", risk: "read", parameters: {}, async execute() { throw new Error("temporary failure"); } });
    try {
      await runner.run([...initialMessages(workspace), { role: "user", content: "提交代码到服务器" }],
        "agent", new AbortController().signal, () => undefined, async () => "once");
      expect(modes).toEqual([false, true]);
    } finally { runner.close(); }
  });
});
