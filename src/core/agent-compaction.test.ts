import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner, initialMessages } from "./agent.js";
import type { AgentEvent, ChatMessage, LubanConfig } from "./types.js";

function config(workspace: string): LubanConfig {
  const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "" };
  return {
    home: workspace, workspace, project: "test", model, models: [model], maxTokens: 1000,
    temperature: 0, timeoutMs: 1000, maxSteps: 10, backendUrl: "", permissionMode: "ask",
  };
}

/**
 * A run that reads one 4 KB file per step. That is enough to put the request
 * back over the context ceiling every step, so the run compacts again and again
 * - the steady state the notices have to survive.
 *
 * Argument paths differ per call: identical calls would trip the repeated
 * tool-loop guard long before the interesting bit.
 */
function readingClient(): { client: { complete: () => Promise<{ content: string; toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; usage: { input: number; output: number } }> }; calls: () => number; stopAfter: (steps: number) => void } {
  let calls = 0;
  let limit = Number.POSITIVE_INFINITY;
  return {
    calls: () => calls,
    stopAfter: (steps) => { limit = calls + steps; },
    client: {
      async complete() {
        calls += 1;
        if (calls > limit) return { content: "done", toolCalls: [], usage: { input: 1, output: 1 } };
        return {
          content: "",
          toolCalls: [{ id: `r${calls}`, type: "function" as const, function: { name: "read_file", arguments: `{"path":"f${calls}.txt"}` } }],
          usage: { input: 1, output: 1 },
        };
      },
    },
  };
}

function runnerFor(workspace: string, client: unknown): AgentRunner {
  const runnerConfig = config(workspace);
  runnerConfig.contextWindow = 8_192;
  runnerConfig.contextReserve = 2_048;
  runnerConfig.semanticCompaction = false;
  const runner = new AgentRunner(runnerConfig, client as never);
  runner.tools.set("read_file", { name: "read_file", description: "r", risk: "read", parameters: {}, async execute() { return "x".repeat(4_000); } });
  return runner;
}

const notices = (events: AgentEvent[]): string[] =>
  events.flatMap((event) => event.type === "status" && !event.progress ? [event.text] : []);
const liveLabels = (events: AgentEvent[]): string[] =>
  events.flatMap((event) => event.type === "status" && event.progress ? [event.text] : []);

describe("compaction notices", () => {
  it("announces a run's first drop once and keeps later totals on the working line", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-compaction-"));
    const source = readingClient();
    source.stopAfter(6);
    const runner = runnerFor(workspace, source.client);
    const events: AgentEvent[] = [];
    const result = await runner.run(
      [...initialMessages(workspace), { role: "user", content: "work" }],
      "agent", new AbortController().signal, (event) => events.push(event), async () => "once",
    );

    expect(result.ok).toBe(true);
    // One durable line for the whole run, not one per step.
    expect(notices(events).filter((text) => text.startsWith("Compacted"))).toEqual(["Compacted 2 older messages"]);
    // Later drops still reach the working line, with a running total.
    const live = liveLabels(events).filter((text) => text.startsWith("Compacted"));
    expect(live.length).toBeGreaterThan(1);
    expect(Number(live.at(-1)!.match(/\d+/u)![0])).toBeGreaterThan(2);
    runner.close();
  }, 30_000);

  it("records a fresh notice for a later turn that compacts again", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-compaction-turn-"));
    const source = readingClient();
    const runner = runnerFor(workspace, source.client);
    const messages: ChatMessage[] = [...initialMessages(workspace), { role: "user", content: "work" }];
    const turn = async (): Promise<string[]> => {
      const events: AgentEvent[] = [];
      await runner.run(messages, "agent", new AbortController().signal, (event) => events.push(event), async () => "once");
      return notices(events).filter((text) => text.startsWith("Compacted"));
    };

    source.stopAfter(4);
    expect(await turn()).toEqual(["Compacted 2 older messages"]);
    messages.push({ role: "user", content: "继续" });
    // A second user turn starts a new run, so its compaction is news again
    // rather than another step of the first one, even though the mark now sits
    // higher because the transcript kept growing.
    source.stopAfter(4);
    const second = await turn();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatch(/^Compacted \d+ older messages$/u);
    expect(second[0]).not.toBe("Compacted 2 older messages");
    runner.close();
  }, 30_000);
});
