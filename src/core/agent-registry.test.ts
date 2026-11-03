import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { activeAgents, finishAgent, registerAgent, updateAgentUsage } from "./agent-registry.js";

it("lists running agents oldest first with the parent ahead of its subagents", () => {
  const parent = registerAgent({ depth: 0, task: "整理\n项目结构", workspace: "/tmp/a", mode: "agent" });
  const child = registerAgent({ depth: 1, task: "读取配置", workspace: "/tmp/a", mode: "agent" });
  const [first, second] = activeAgents();
  expect(first).toMatchObject({ id: parent, depth: 0, task: "整理 项目结构", workspace: "/tmp/a" });
  expect(second).toMatchObject({ id: child, depth: 1 });
  expect(first.startedAt).toBeLessThanOrEqual(second.startedAt);
  finishAgent(child);
  expect(activeAgents().map(agent => agent.id)).toEqual([parent]);
  finishAgent(parent);
  expect(activeAgents()).toEqual([]);
});

it("publishes live agents to this process's file so another process can list them", async () => {
  const home = await mkdtemp(join(tmpdir(), "luban-agents-"));
  const path = join(home, "agents", `${process.pid}.json`);
  const id = registerAgent({ depth: 1, task: "delegate", workspace: "/tmp/c", mode: "agent", home });
  await expect.poll(async () => JSON.parse(await readFile(path, "utf8")).agents.length).toBe(1);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid, agents: [{ depth: 1, task: "delegate" }] });
  updateAgentUsage(id, { input: 500, output: 40 });
  updateAgentUsage(id, { input: 100, output: 10 });
  expect(activeAgents()[0]).toMatchObject({ inputTokens: 600, outputTokens: 50 });
  finishAgent(id);
  await expect.poll(async () => JSON.parse(await readFile(path, "utf8")).agents).toEqual([]);
  await rm(home, { recursive: true, force: true });
});

it("shortens a long task instead of dumping the prompt", () => {
  const id = registerAgent({ depth: 0, task: "x".repeat(200), workspace: "/tmp/b", mode: "read" });
  expect(activeAgents()[0].task).toHaveLength(80);
  expect(activeAgents()[0].task.endsWith("…")).toBe(true);
  finishAgent(id);
});
