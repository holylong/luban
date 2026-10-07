import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "./agent.js";
import { parseUserQuestion } from "./question.js";
import type { ChatMessage, LubanConfig } from "./types.js";

function config(workspace: string): LubanConfig {
  const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "", api: "openai" as const,
    capabilities: { vision: false, thinking: false, tools: true, responses: false } };
  return { home: workspace, workspace, project: "test", theme: "default", themeColors: {}, model, models: [model],
    maxTokens: 1000, temperature: 0, timeoutMs: 1000, maxSteps: 10, backendUrl: "", permissionMode: "ask" } as LubanConfig;
}

describe("ask_user", () => {
  it("validates concrete, unique choices", () => {
    expect(() => parseUserQuestion({ question: "Choose", options: [{ label: "A" }, { label: "A" }] })).toThrow("unique");
    expect(() => parseUserQuestion({ question: "Choose", options: [{ label: "A" }] })).toThrow("2–4");
  });

  it("pauses for the human answer and returns it to the model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-question-"));
    let calls = 0;
    let answerQuestion: ((answer: string) => void) | undefined;
    const runner = new AgentRunner(config(workspace), {
      async complete(messages: ChatMessage[], tools: unknown[]) {
        expect((tools as Array<{ function: { name: string } }>).some(tool => tool.function.name === "ask_user")).toBe(true);
        if (++calls === 1) return { content: "", usage: { input: 1, output: 1 }, toolCalls: [{
          id: "ask-1", type: "function" as const,
          function: { name: "ask_user", arguments: JSON.stringify({ question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }) },
        }] };
        expect(messages.find(message => message.tool_call_id === "ask-1")?.content).toContain('"answer":"Postgres"');
        return { content: "Using Postgres", toolCalls: [], usage: { input: 1, output: 1 } };
      },
    });
    try {
      const running = runner.run([...initialMessages(workspace), { role: "user", content: "Build it" }],
        "agent", new AbortController().signal, () => undefined, async () => "once", async () => undefined, undefined,
        () => new Promise<string>(resolve => { answerQuestion = resolve; }));
      for (let i = 0; i < 50 && !answerQuestion; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(answerQuestion).toBeDefined();
      expect(calls).toBe(1);
      answerQuestion!("Postgres");
      const result = await running;
      expect(result.ok).toBe(true);
      expect(result.text).toBe("Using Postgres");
    } finally { runner.close(); }
  });
});
