import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scheduledMessages } from "./bot-command.js";
import { noteRun, readProjectMemory, rememberFact, stripMemory } from "./memory.js";
import type { ChatMessage, LubanConfig } from "./types.js";

/**
 * A scheduled run is where memory matters most and is hardest to observe: no
 * human is watching, so a nightly scan that starts blank silently re-does last
 * night's work. These cases pin the transcript shape the worker builds.
 */
const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "" };

function config(workspace: string): LubanConfig {
  return {
    home: workspace, workspace, project: "test", model, models: [model], maxTokens: 1000,
    temperature: 0, timeoutMs: 1000, maxSteps: 10, backendUrl: "", permissionMode: "ask",
  } as LubanConfig;
}

const MEMORY = "## 项目记忆（";

describe("scheduled task memory", () => {
  it("puts the project's memory immediately before the task prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-bot-memory-"));
    await rememberFact(workspace, workspace, "禅道 bug 项目的 id 是 42");
    const record = await readProjectMemory(workspace, workspace);

    const messages: ChatMessage[] = scheduledMessages(config(workspace), "再扫一下本周 bug", record);
    const block = messages.findIndex(message => message.role === "system" && String(message.content).startsWith(MEMORY));

    expect(block).toBeGreaterThan(0);
    expect(String(messages[block]!.content)).toContain("禅道 bug 项目的 id 是 42");
    expect(messages[block + 1]?.role).toBe("user");
    expect(String(messages[block + 1]?.content)).toBe("再扫一下本周 bug");
    // The identity prompt still leads, so the soul keeps its name.
    expect(String(messages[0]!.content)).toContain("造物主");
  });

  it("costs nothing when the project has no memory yet", () => {
    const messages = scheduledMessages(config("/tmp/luban-bot-no-memory"), "整理一下 README");
    expect(messages.some(message => message.role === "system" && String(message.content).startsWith(MEMORY))).toBe(false);
    expect(String(messages.at(-1)?.content)).toBe("整理一下 README");
  });

  it("feeds last night's journal line into tonight's task, without leaving it in the session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-bot-journal-"));
    await noteRun(workspace, workspace, "扫了本周新增 bug，找到 3 个。");

    const next = scheduledMessages(config(workspace), "再扫一下本周 bug", await readProjectMemory(workspace, workspace));
    const block = next.find(message => message.role === "system" && String(message.content).startsWith(MEMORY));
    expect(String(block?.content)).toContain("扫了本周新增 bug，找到 3 个。");

    // What gets saved keeps the plain transcript: the block is rebuilt each run,
    // so a fact the human deletes really is gone from the next prompt.
    expect(stripMemory(next).some(message => String(message.content).startsWith(MEMORY))).toBe(false);
    expect(String(stripMemory(next).at(-1)?.content)).toBe("再扫一下本周 bug");
  });
});
