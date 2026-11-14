import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FACTS, MAX_RUNS, clearProjectMemory, injectMemory, listProjectMemories, memoryFile, memoryPrompt,
  noteRun, parseMemory, readProjectMemory, rememberFact, renderMemory, relevantRuns, memoryStamp,
  runSummary, stripMemory,
} from "./memory.js";

/**
 * Creator used to run every task from a blank prompt. These cases pin the
 * replacement: one bounded Markdown file per workspace that a task reads before
 * it starts and writes one line to when it finishes.
 */

let home: string;
let workspace: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "luban-memory-home-"));
  workspace = await mkdtemp(join(tmpdir(), "luban-memory-ws-"));
});

describe("memory file placement", () => {
  it("keys memory by the resolved workspace, not its name", async () => {
    const twin = `${workspace}-copy`;
    await mkdir(twin, { recursive: true });
    expect(memoryFile(home, workspace)).toBe(memoryFile(home, workspace));
    expect(memoryFile(home, workspace)).not.toBe(memoryFile(home, twin));
    expect(memoryFile(home, workspace).startsWith(join(home, "memory"))).toBe(true);
  });

  it("starts empty without creating a file", async () => {
    const record = await readProjectMemory(home, workspace);
    expect(record.facts).toEqual([]);
    expect(record.runs).toEqual([]);
    await expect(readFile(memoryFile(home, workspace), "utf8")).rejects.toThrow();
  });
});

describe("facts", () => {
  it("keeps the newest first and refuses duplicates", async () => {
    await rememberFact(home, workspace, "用户偏好 pnpm", 1_000);
    await rememberFact(home, workspace, "不要自动提交", 2_000);
    const record = await rememberFact(home, workspace, "用户偏好 PNPM", 3_000);
    expect(record.facts.map(item => item.text)).toEqual(["用户偏好 PNPM", "不要自动提交"]);
    expect(record.facts[0]!.at).toBe(3_000);
  });

  it("flattens multi-line facts and caps the list", async () => {
    const record = await rememberFact(home, workspace, "第一行\n第二行  第三行");
    expect(record.facts[0]!.text).toBe("第一行 第二行 第三行");
    for (let index = 0; index < MAX_FACTS + 5; index += 1) await rememberFact(home, workspace, `fact ${index}`, index);
    const capped = await readProjectMemory(home, workspace);
    expect(capped.facts).toHaveLength(MAX_FACTS);
    expect(capped.facts[0]!.text).toBe(`fact ${MAX_FACTS + 4}`);
  });

  it("survives a hand edit of the Markdown", async () => {
    await mkdir(join(home, "memory"), { recursive: true });
    const path = memoryFile(home, workspace);
    await writeFile(path, [
      `# 项目记忆：x`,
      `workspace: ${workspace}`,
      "",
      "## 事实",
      "- 手动写的事实没有时间戳",
      "- 2026-11-14 23:05 · 带时间戳的事实",
      "",
      "## 别的段落",
      "- 不属于任何一层",
      "",
      "## 记录",
      "- 2026-11-14 23:00 · 扫了本周 bug",
      "",
    ].join("\n"), "utf8");
    const record = await readProjectMemory(home, workspace);
    expect(record.facts.map(item => item.text)).toEqual(["手动写的事实没有时间戳", "带时间戳的事实"]);
    expect(record.facts[0]!.at).toBe(0);
    expect(record.runs.map(item => item.text)).toEqual(["扫了本周 bug"]);
  });
});

describe("run journal", () => {
  it("keeps the newest runs and drops the oldest", async () => {
    for (let index = 0; index < MAX_RUNS + 3; index += 1) await noteRun(home, workspace, `run ${index}`, index);
    const record = await readProjectMemory(home, workspace);
    expect(record.runs).toHaveLength(MAX_RUNS);
    expect(record.runs.at(-1)!.text).toBe(`run ${MAX_RUNS + 2}`);
    expect(record.runs[0]!.text).toBe("run 3");
  });

  it("round-trips the rendered file", async () => {
    await rememberFact(home, workspace, "偏好中文回复", 1_000_000);
    await noteRun(home, workspace, "修了 build 失败", 1_062_000);
    const written = await readFile(memoryFile(home, workspace), "utf8");
    const parsed = parseMemory(written);
    expect(parsed.facts[0]!.text).toBe("偏好中文回复");
    expect(parsed.runs[0]!.text).toBe("修了 build 失败");
    expect(written).toContain(`workspace: ${workspace}`);
  });
});

describe("prompt block", () => {
  it("costs nothing until there is something to remember", async () => {
    expect(memoryPrompt(await readProjectMemory(home, workspace), "随便什么任务")).toBeUndefined();
  });

  it("injects facts plus the runs that match this task", async () => {
    await rememberFact(home, workspace, "禅道项目 id 是 42");
    await noteRun(home, workspace, "扫了本周新增 bug，找到 3 个", 1);
    await noteRun(home, workspace, "整理了文档里的过期截图", 2);
    const block = memoryPrompt(await readProjectMemory(home, workspace), "再扫一下本周 bug 有多少")!;
    expect(block).toContain("禅道项目 id 是 42");
    expect(block).toContain("扫了本周新增 bug");
    expect(block.indexOf("扫了本周新增 bug")).toBeLessThan(block.indexOf("整理了文档"));
  });

  it("picks overlapping runs and tops up with the newest ones", () => {
    const runs = Array.from({ length: 10 }, (_, index) => ({
      at: index,
      text: index === 2 ? "部署失败 railway" : `无关记录 ${index}`,
    }));
    const picked = relevantRuns(runs, "railway 部署为什么失败", 4);
    expect(picked.map(item => item.text)).toContain("部署失败 railway");
    expect(picked).toHaveLength(4);
    // Chronological order inside the block, so the newest line reads last.
    expect(picked.map(item => item.at)).toEqual([...picked.map(item => item.at)].sort((a, b) => a - b));
  });

  it("truncates instead of flooding the system prompt", async () => {
    for (let index = 0; index < MAX_FACTS; index += 1) await rememberFact(home, workspace, `${index} ${"长".repeat(240)}`, index);
    const block = memoryPrompt(await readProjectMemory(home, workspace), "任意")!;
    expect(block.length).toBeLessThanOrEqual(3000);
    expect(block).toContain("记忆已截断");
  });
});

describe("listing and clearing", () => {
  it("lists every remembered project with its workspace", async () => {
    const other = `${workspace}-other`;
    await mkdir(other, { recursive: true });
    // The Markdown keeps minutes only, so spaced-out clock times keep the
    // ordering meaningful after the round trip.
    await rememberFact(home, workspace, "第一个项目", new Date(2026, 10, 14, 9, 0).getTime());
    await rememberFact(home, other, "第二个项目", new Date(2026, 10, 14, 9, 30).getTime());
    const listed = await listProjectMemories(home);
    expect(listed.map(record => record.workspace)).toEqual([other, workspace]);
  });

  it("clears one project without touching the others", async () => {
    const other = `${workspace}-other`;
    await mkdir(other, { recursive: true });
    await rememberFact(home, workspace, "第一个项目");
    await rememberFact(home, other, "第二个项目");
    await clearProjectMemory(home, workspace);
    expect((await readProjectMemory(home, workspace)).facts).toEqual([]);
    expect((await readProjectMemory(home, other)).facts[0]!.text).toBe("第二个项目");
  });

  it("prints local timestamps people can edit", () => {
    expect(memoryStamp(new Date(2026, 10, 14, 23, 5).getTime())).toBe("2026-11-14 23:05");
    expect(renderMemory({ project: "p", workspace: "/p", facts: [], runs: [] })).toContain("（暂无）");
  });
});

describe("prompt injection", () => {
  const block = "## 项目记忆（luban）\n此前…";
  const messages = [
    { role: "system" as const, content: "identity" },
    { role: "user" as const, content: "第一句" },
    { role: "assistant" as const, content: "好的" },
    { role: "user" as const, content: "第二句" },
  ];

  it("sits immediately before the newest question", () => {
    const out = injectMemory(messages, block);
    expect(out[3]).toEqual({ role: "system", content: block });
    expect(out[4]).toEqual({ role: "user", content: "第二句" });
    expect(out).toHaveLength(messages.length + 1);
  });

  it("costs nothing when there is nothing to say", () => {
    expect(injectMemory(messages, undefined)).toBe(messages);
  });

  it("comes back out of the transcript the runner returns", () => {
    const sent = injectMemory(messages, block);
    expect(stripMemory(sent)).toEqual(messages);
  });
});

describe("run summary", () => {
  it("keeps the first sentence and labels a failure", () => {
    expect(runSummary(true, "扫了本周新增 bug，找到 3 个。另外还有 2 个待确认。")).toBe("扫了本周新增 bug，找到 3 个。");
    expect(runSummary(false, "推送失败 403")).toBe("失败 · 推送失败 403");
  });

  it("never writes an empty line", () => {
    expect(runSummary(true, "   ")).toBe("");
  });

  it("caps a long answer instead of copying it", () => {
    const summary = runSummary(true, "长".repeat(400));
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith("…")).toBe(true);
  });
});
