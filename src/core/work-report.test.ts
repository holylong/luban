import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { collectWorkReport, exportWorkReport, renderWorkReport, reportRange, type ReportOptions } from "./work-report.js";
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luban-report-")); cleanup.push(root);
  const options: ReportOptions = { period: "daily", date: "2026-10-20", lubanHome: join(root, "luban"), codexHome: join(root, "codex"), claudeHome: join(root, "claude"), opencodeHome: join(root, "opencode") };
  const put = async (p: string, v: unknown) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, typeof v === "string" ? v : JSON.stringify(v)); };
  return { root, options, put, at: +new Date("2026-10-20T12:00:00") };
}
it("uses calendar periods and rejects invalid input", () => {
  expect(reportRange("weekly", "2026-10-25").start.getDate()).toBe(19);
  expect(reportRange("weekly", "2026-10-25").end.getDate()).toBe(26);
  expect(reportRange("monthly", "2024-02-29").end.getMonth()).toBe(2);
  expect(reportRange("yearly", "2026-10-20").end.getFullYear()).toBe(2027);
  expect(() => reportRange("daily", "2026-02-30")).toThrow();
  expect(() => reportRange("bad" as any)).toThrow();
});
it("collects all projects, filters timestamps, deduplicates archives and tolerates broken lines", async () => {
  const { options, put, at } = await fixture();
  for (const project of ["one", "two"]) await put(join(options.lubanHome, "sessions-node", project, "s.json"), { id: project, title: project, workspace: project, updatedAt: new Date(at).toISOString(), messages: [{ role: "user", content: "legacy task" }, { role: "system", content: "SECRET" }] });
  const rows = [{ type: "session_meta", payload: { id: "cx", cwd: "/project" } }, ...[at - 86400000, at, +reportRange("daily", options.date).end].map((t, i) => ({ timestamp: new Date(t).toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `task-${i}` }] } }))];
  const body = rows.map(r => JSON.stringify(r)).join("\n") + "\n{unfinished";
  await put(join(options.codexHome!, "sessions", "s.jsonl"), body);
  await put(join(options.codexHome!, "archived_sessions", "s.jsonl"), body);
  await put(join(options.claudeHome!, "projects", "p", "s.jsonl"), JSON.stringify({ type: "assistant", sessionId: "cl", cwd: "/other", timestamp: new Date(at).toISOString(), message: { content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "fixed parser" }] } }));
  const r = await collectWorkReport(options);
  expect(r.sessions).toHaveLength(4);
  expect(r.sessions.find(s => s.source === "codex")?.messages.map(m => m.text)).toEqual(["task-1"]);
  expect(r.warnings.some(w => w.includes("时间戳"))).toBe(true);
  expect(r.warnings.some(w => w.includes("损坏"))).toBe(true);
  expect(renderWorkReport(r)).toContain("fixed parser");
  expect(JSON.stringify(r)).not.toContain("SECRET");
});
it("reads OpenCode JSON and SQLite and merges migration duplicates", async () => {
  const { options, put, at } = await fixture(); options.sources = ["opencode"];
  const storage = join(options.opencodeHome!, "storage");
  await put(join(storage, "session", "p", "s.json"), { id: "oc", title: "work", directory: "/work" });
  await put(join(storage, "message", "oc", "m.json"), { id: "m", role: "user", time: { created: at } });
  await put(join(storage, "part", "m", "p.json"), { id: "p", type: "text", text: "implement feature" });
  expect((await collectWorkReport(options)).sessions[0].messages[0].text).toBe("implement feature");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(join(options.opencodeHome!, "opencode.db"));
  db.exec("CREATE TABLE session(id TEXT,title TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,time_created INTEGER,data TEXT)");
  db.prepare("INSERT INTO session VALUES(?,?,?)").run("oc", "work", "/work");
  db.prepare("INSERT INTO message VALUES(?,?,?,?)").run("m", "oc", at, JSON.stringify({ role: "user" }));
  db.prepare("INSERT INTO part VALUES(?,?,?,?)").run("p", "m", at, JSON.stringify({ type: "text", text: "implement feature" }));
  db.close();
  const r = await collectWorkReport(options);
  expect(r.warnings).toEqual([]); expect(r.sessions).toHaveLength(1); expect(r.sessions[0].messages).toHaveLength(1);
});
it("exports JSON, reports missing sources and refuses overwrites", async () => {
  const { root, options } = await fixture(); const output = join(root, "report.json");
  const result = await exportWorkReport({ ...options, output, format: "json" });
  expect(JSON.parse(await readFile(output, "utf8")).sessions).toEqual([]);
  expect(result.report.coverage).toHaveLength(4); expect(result.report.warnings.length).toBeGreaterThan(0);
  await expect(exportWorkReport({ ...options, output })).rejects.toThrow();
  await expect(collectWorkReport({ ...options, sources: ["bad" as any] })).rejects.toThrow();
});
