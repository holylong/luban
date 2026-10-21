import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWorkDiary, modelDiaryWriter } from "./work-diary.js";
import { exportWorkReport, reportRange, type WorkReport } from "./work-report.js";
import { OpenAiClient } from "./openai.js";
import type { LubanConfig } from "./types.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
function report(): WorkReport {
  const { start, end } = reportRange("daily", "2026-10-20");
  return { period: "daily", start: start.toISOString(), end: end.toISOString(), timezone: "UTC", warnings: [], coverage: [], sessions: [{ source: "luban", id: "private-session-id", title: "task", workspace: "/private/work/luban", path: "/private/session.json", messages: [{ role: "assistant", text: "已完成解析器修复，测试通过，尚未上线。", at: +start + 1000, approximate: true }] }] };
}
it("writes formal prose with date and evidence rules without session metadata", async () => {
  const writer = vi.fn(async (..._args: any[]) => "项目事实：解析器已修复并通过测试，未上线。");
  writer.mockResolvedValueOnce("项目事实：解析器已修复并通过测试，时间归属待核实。").mockResolvedValueOnce("## 工作内容与进展\n解析器修复验证已推进，具体完成日期待核实。");
  const body = await generateWorkDiary(report(), writer);
  expect(body).toContain("# 工作日记\n\n2026-10-20");
  expect(body).toContain("## 工作内容与进展");
  expect(body).not.toContain("private-session-id");
  const calls = JSON.stringify(writer.mock.calls);
  expect(calls).not.toContain("/private/");
  expect(calls).toContain("归属待核实");
  expect(calls).toContain("不能把用户要求当成完成结果");
});
it("includes the tail of escaped material in bounded batches", async () => {
  const r = report(); r.sessions[0].messages[0].text = String.fromCharCode(1).repeat(3000) + "TAIL_MARKER";
  const material: string[] = [];
  const writer = vi.fn(async (messages: any[]) => {
    if (messages[1].content.startsWith("提炼")) material.push(messages[1].content.split("仅供提炼事实：\n")[1]);
    return "已完成修复，未上线。";
  });
  await generateWorkDiary(r, writer, 2000);
  expect(material.length).toBeGreaterThan(1);
  expect(material.every(m => m.length <= 2000)).toBe(true);
  expect(material.join("")).toContain("TAIL_MARKER");
});
it("rejects empty and incomplete model output", async () => {
  await expect(generateWorkDiary(report(), async () => String())).rejects.toThrow("正文");
  const complete = vi.spyOn(OpenAiClient.prototype, "complete");
  complete.mockResolvedValue({ content: "partial", reasoning: "", toolCalls: [], usage: { input: 1, output: 1 }, truncated: true });
  const writer = modelDiaryWriter({ model: { api: "openai", provider: "test" } } as LubanConfig);
  await expect(writer([], 100)).rejects.toThrow("未完整");
  expect(complete.mock.calls[0][1]).toEqual([]);
});
it("sends a placeholder coding tool for Zen free models instead of refusing", async () => {
  const complete = vi.spyOn(OpenAiClient.prototype, "complete");
  complete.mockResolvedValue({ content: "## 工作内容与进展\n完成修复。", reasoning: "", toolCalls: [], usage: { input: 1, output: 1 } });
  const writer = modelDiaryWriter({ model: { id: "opencode-zen/exo-free", provider: "opencode-zen", model: "exo-free", api: "openai" } } as LubanConfig);
  await expect(writer([], 100)).resolves.toContain("完成修复");
  const tools = complete.mock.calls[0][1] as Array<{ function: { name: string } }>;
  expect(tools.map(tool => tool.function.name)).toEqual(["read"]);
});
it("asks weekly reports for P0/P1/P2 priorities and hard deadlines", async () => {
  const r = report(); r.period = "weekly";
  const writer = vi.fn(async () => "## P0 紧急且重要\n1. 修复解析器。");
  await generateWorkDiary(r, writer);
  const prompt = String((writer.mock.calls.at(-1) as any[])[0][1].content);
  expect(prompt).toContain("P0 紧急且重要");
  expect(prompt).toContain("P1 重要");
  expect(prompt).toContain("P2 常规跟进");
  expect(prompt).toContain("本期硬节点");
});
it("exports generated Markdown and leaves no file after generation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "luban-diary-")); roots.push(root);
  const home = join(root, "home"), dir = join(home, "sessions-node", "project");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "s.json"), JSON.stringify({ id: "s", title: "task", workspace: "/private/project", updatedAt: report().start, messages: [{ role: "assistant", content: "修复完成" }] }));
  const options = { period: "daily" as const, date: "2026-10-20", lubanHome: home, sources: ["luban" as const], output: join(root, "diary.md") };
  await exportWorkReport({ ...options, writer: async () => "## 工作内容与进展\n完成解析器修复。" });
  const output = await readFile(options.output, "utf8");
  expect(output).toContain("完成解析器修复");
  expect(output).not.toContain("/private/");
  const failed = join(root, "failed.md");
  await expect(exportWorkReport({ ...options, output: failed, writer: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
  await expect(access(failed)).rejects.toThrow();
});
