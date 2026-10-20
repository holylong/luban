import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { generateWorkDiary, modelDiaryWriter, type DiaryWriter } from "./work-diary.js";
import type { LubanConfig } from "./types.js";

export const REPORT_SOURCES = ["luban", "codex", "claude", "opencode"] as const;
export type ReportSource = typeof REPORT_SOURCES[number];
export type ReportPeriod = "daily" | "weekly" | "monthly" | "yearly";
interface Message { role: string; text: string; at: number; approximate?: boolean }
interface Session { source: ReportSource; id: string; title: string; workspace: string; path: string; messages: Message[] }
export interface WorkReport { period: ReportPeriod; start: string; end: string; timezone: string; sessions: Session[]; warnings: string[]; coverage: Array<{ source: ReportSource; root: string; sessions: number }> }
export interface ReportOptions { period: ReportPeriod; date?: string; sources?: ReportSource[]; lubanHome: string; codexHome?: string; claudeHome?: string; opencodeHome?: string }
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function reportRange(period: ReportPeriod, date = day(new Date())) {
  if (!["daily", "weekly", "monthly", "yearly"].includes(period)) throw new Error("周期须为 daily、weekly、monthly 或 yearly");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期须为 YYYY-MM-DD");
  const start = new Date(`${date}T00:00:00`);
  if (!Number.isFinite(+start) || day(start) !== date) throw new Error("无效日期");
  if (period === "weekly") start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (period === "monthly" || period === "yearly") start.setDate(1);
  if (period === "yearly") start.setMonth(0);
  const end = new Date(start);
  if (period === "yearly") end.setFullYear(end.getFullYear() + 1);
  else if (period === "monthly") end.setMonth(end.getMonth() + 1);
  else end.setDate(end.getDate() + (period === "weekly" ? 7 : 1));
  return { start, end };
}
const stamp = (v: unknown): number => typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
function text(v: any): string {
  return typeof v === "string" ? v : Array.isArray(v) ? v.filter(p => ["text", "input_text", "output_text"].includes(p?.type)).map(p => p.text || "").join("\n") : "";
}
async function exists(p: string) { try { await access(p); return true; } catch { return false; } }
async function* files(root: string, suffix: string, warnings: string[]): AsyncGenerator<string> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (e: any) { if (e.code !== "ENOENT") warnings.push(`${root}: ${e.message}`); return; }
  for (const entry of entries) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) yield* files(p, suffix, warnings);
    else if (entry.isFile() && entry.name.endsWith(suffix)) yield p;
  }
}
const json = async (p: string): Promise<any> => JSON.parse(await readFile(p, "utf8"));

export async function collectWorkReport(options: ReportOptions): Promise<WorkReport> {
  const { start, end } = reportRange(options.period, options.date);
  const roots: Record<ReportSource, string> = {
    luban: join(options.lubanHome, "sessions-node"),
    codex: options.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"),
    claude: options.claudeHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    opencode: options.opencodeHome || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode"),
  };
  const report: WorkReport = { period: options.period, start: start.toISOString(), end: end.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, sessions: [], warnings: [], coverage: [] };
  const sources = options.sources ?? [...REPORT_SOURCES];
  if (!sources.length || sources.some(s => !REPORT_SOURCES.includes(s))) throw new Error("来源须为 luban,codex,claude,opencode");
  const seen = new Set<string>();
  const add = (s: Session) => {
    s.messages = s.messages.filter(m => ["user", "assistant"].includes(m.role) && m.text.trim() && m.at >= +start && m.at < +end).sort((a, b) => a.at - b.at);
    const key = `${s.source}:${s.id}`;
    if (!s.messages.length) return;
    if (!seen.has(key)) { seen.add(key); report.sessions.push(s); }
    else {
      const existing = report.sessions.find(item => `${item.source}:${item.id}` === key)!;
      const fingerprints = new Set(existing.messages.map(m => JSON.stringify([m.role, m.at, m.text])));
      for (const m of s.messages) {
        const fingerprint = JSON.stringify([m.role, m.at, m.text]);
        if (!fingerprints.has(fingerprint)) { fingerprints.add(fingerprint); existing.messages.push(m); }
      }
      existing.messages.sort((a, b) => a.at - b.at);
    }
  };
  for (const source of [...new Set(sources)]) {
    const root = roots[source], before = report.sessions.length;
    if (!await exists(root)) report.warnings.push(`${source}: 未发现目录 ${root}`);
    if (source === "luban") {
      for await (const path of files(root, ".json", report.warnings)) try {
        const r = await json(path);
        if (!r.id || !Array.isArray(r.messages)) throw new Error("不兼容的会话格式");
        add({ source, id: r.id, title: r.title || r.id, workspace: r.workspace || r.project || "未知项目", path, messages: r.messages.map((m: any) => ({ role: m.role, text: text(m.content), at: stamp(m.createdAt || m.timestamp || r.updatedAt), approximate: !m.createdAt && !m.timestamp })) });
      } catch (e) { report.warnings.push(`${path}: ${String(e)}`); }
    } else if (source === "codex" || source === "claude") {
      const dirs = source === "codex" ? [join(root, "sessions"), join(root, "archived_sessions")] : [join(root, "projects")];
      for (const dir of dirs) for await (const path of files(dir, ".jsonl", report.warnings)) {
        const s: Session = { source, id: basename(path, ".jsonl"), title: "", workspace: "未知项目", path, messages: [] };
        let broken = 0;
        try {
          const input = createReadStream(path, { encoding: "utf8" });
          const lines = createInterface({ input, crlfDelay: Infinity });
          try { for await (const line of lines) {
            if (!line.trim()) continue;
            let r: any;
            try { r = JSON.parse(line); } catch { broken++; continue; }
            if (source === "codex") {
              if (r.type === "session_meta") { s.id = r.payload?.id || r.payload?.session_id || s.id; s.workspace = r.payload?.cwd || s.workspace; }
              if (r.type === "response_item" && r.payload?.type === "message") s.messages.push({ role: r.payload.role, text: text(r.payload.content), at: stamp(r.timestamp) });
            } else {
              s.id = path.includes(`${join("subagents", "agent-")}`) ? basename(path, ".jsonl") : r.sessionId || s.id; s.workspace = r.cwd || s.workspace;
              if (["user", "assistant"].includes(r.type)) s.messages.push({ role: r.message?.role || r.type, text: text(r.message?.content), at: stamp(r.timestamp) });
            }
          } } finally { lines.close(); input.destroy(); }
          s.title = s.messages.find(m => m.role === "user" && m.text)?.text.slice(0, 100) || s.id;
          add(s);
          if (broken) report.warnings.push(`${path}: 跳过 ${broken} 条损坏或未写完的记录`);
        } catch (e) { report.warnings.push(`${path}: ${String(e)}`); }
      }
    } else await openCode(root, report.warnings, add, +start, +end);
    report.coverage.push({ source, root, sessions: report.sessions.length - before });
  }
  report.sessions.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.id.localeCompare(b.id));
  if (report.sessions.some(s => s.messages.some(m => m.approximate))) report.warnings.push("旧 luban 消息无独立时间戳：按会话最后更新时间归档，可能含此前工作，不能视为该时段精确成果。");
  return report;
}

async function openCode(root: string, warnings: string[], add: (s: Session) => void, start: number, end: number) {
  const database = join(root, "opencode.db");
  if (await exists(database)) {
    let db: import("node:sqlite").DatabaseSync | undefined;
    try {
      const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      db = new sqlite.DatabaseSync(database, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 2000");
      const rows = db.prepare("SELECT s.id, s.title, s.directory, m.id AS mid, m.time_created, m.data FROM session s JOIN message m ON m.session_id = s.id WHERE m.time_created >= ? AND m.time_created < ? ORDER BY m.time_created, m.id").all(start, end) as any[];
      const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id");
      const sessions = new Map<string, Session>();
      for (const r of rows) try {
        const data = JSON.parse(r.data);
        let s = sessions.get(r.id);
        if (!s) { s = { source: "opencode", id: r.id, title: r.title, workspace: r.directory, path: database, messages: [] }; sessions.set(r.id, s); }
        const content = parts.all(r.mid).map(p => JSON.parse(String(p.data))).filter(p => p.type === "text" && !p.synthetic && !p.ignored).map(p => p.text || "").join("\n");
        s.messages.push({ role: data.role, text: content, at: r.time_created });
      } catch (e) { warnings.push(`OpenCode ${r.mid}: ${String(e)}`); }
      for (const s of sessions.values()) add(s);
    } catch (e) { warnings.push(`OpenCode SQLite 读取失败（需要 Node 22.5+ 的 node:sqlite）: ${String(e)}`); }
    finally { db?.close(); }
  }
  const storage = join(root, "storage");
  for await (const path of files(join(storage, "session"), ".json", warnings)) try {
    const r = await json(path);
    const messages: Message[] = [];
    for await (const mp of files(join(storage, "message", r.id), ".json", warnings)) {
      const m = await json(mp), at = stamp(m.time?.created);
      if (!(at >= start && at < end)) continue;
      const parts: any[] = [];
      for await (const p of files(join(storage, "part", m.id), ".json", warnings)) parts.push(await json(p));
      parts.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      messages.push({ role: m.role, text: parts.filter(p => p.type === "text" && !p.synthetic && !p.ignored).map(p => p.text || "").join("\n"), at });
    }
    add({ source: "opencode", id: r.id, title: r.title || r.id, workspace: r.directory || "未知项目", path, messages });
  } catch (e) { warnings.push(`${path}: ${String(e)}`); }
}

const excerpt = (v: string, limit = 360) => v.replace(/\s+/g, " ").trim().slice(0, limit).replace(/[<>|`]/g, "");
export function renderWorkReport(r: WorkReport): string {
  const label = { daily: "工作日报", weekly: "工作周报", monthly: "工作月报", yearly: "工作年报" }[r.period];
  const out = [`# luban ${label}`, "", `时间：${new Date(r.start).toLocaleString()} 至 ${new Date(r.end).toLocaleString()}（结束不含，${r.timezone}，周一为每周起点）`, "", `共 ${r.sessions.length} 个会话，${new Set(r.sessions.map(s => s.workspace)).size} 个项目。`, "", "基于本机任务与回复摘要；回复属于会话自述，不代表成果已独立验证。不推算工时，不包含系统提示词或工具原始输出。", "", "## 来源覆盖", ""];
  for (const c of r.coverage) out.push(`- ${c.source}: ${c.sessions} 个匹配会话；目录：${c.root}`);
  if (!r.sessions.length) out.push("", "所选时段没有可读取的工作记录。");
  let workspace = "";
  for (const s of r.sessions) {
    if (workspace !== s.workspace) { workspace = s.workspace; out.push("", `## 项目：${excerpt(workspace)}`, ""); }
    out.push(`### ${excerpt(s.title, 100)}`, "", `来源：${s.source} · 会话：${s.id}`, `记录：${s.path}`, "");
    if (s.messages.some(m => m.approximate)) out.push("时间精度：按会话更新时间归档，可能包含此前工作。", "");
    const requests = [...new Set(s.messages.filter(m => m.role === "user").map(m => excerpt(m.text)))];
    const replies = [...new Set(s.messages.filter(m => m.role === "assistant").map(m => excerpt(m.text)))];
    out.push("任务摘要：", ...requests.slice(0, 8).map(t => `- ${t}`), "", "进展与结果（会话自述）：", ...replies.slice(-8).map(t => `- ${t}`), "", `时段内 ${s.messages.length} 条消息；每类最多展示 8 条摘要，完整文本见 JSON 导出。`, "");
  }
  if (r.warnings.length) out.push("## 覆盖与时间精度说明", "", ...r.warnings.map(w => `- ${w}`), "");
  return out.join("\n") + "\n";
}
export async function exportWorkReport(options: ReportOptions & { output?: string; format?: string; workspace?: string; config?: LubanConfig; writer?: DiaryWriter }) {
  const format = options.format || "markdown";
  if (!["markdown", "json"].includes(format)) throw new Error("格式须为 markdown 或 json");
  const report = await collectWorkReport(options);
  const filename = `luban-report-${report.period}-${day(new Date(report.start))}.${format === "json" ? "json" : "md"}`;
  const output = options.output?.replace(/^~(?=$|[\/])/, homedir());
  const path = resolve(options.workspace || process.cwd(), output || filename);
  if (await exists(path)) throw new Error(`目标文件已存在：${path}`);
  let content: string;
  if (format === "json") content = JSON.stringify(report, null, 2) + "\n";
  else {
    if (!options.writer && !options.config && report.sessions.length) throw new Error("生成工作日记需要配置模型");
    const writer = options.writer ?? (options.config && report.sessions.length ? modelDiaryWriter(options.config) : async () => "");
    content = await generateWorkDiary(report, writer, options.config ? Math.min(16000, Math.max(2000, (options.config.contextWindow - 6500) * 2)) : 16000);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { path, report };
}
