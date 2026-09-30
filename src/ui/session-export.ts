import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { editRecordStats, editRecordTitle, parseEditRecord } from "../core/edit-preview.js";
import { summarizeToolArgs } from "../core/tools.js";
import type { ChatMessage, PendingInput, VerificationRecord } from "../core/types.js";

/** Session state that lives beside the transcript and used to be dropped on export. */
export interface SessionExportState {
  pending?: PendingInput[];
  /** Durable edit records; compaction can outlive the tool messages that made them. */
  edits?: ExportedEdit[];
  plan?: { explanation: string; plan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> };
  verifications?: VerificationRecord[];
  /** Whether every completed plan step has a passing check. */
  planVerified?: boolean;
}

export interface SessionExportMeta {
  project: string;
  workspace: string;
  nodeName: string;
  modelId: string;
  mode: string;
  running: boolean;
  /** Session id; rendered in the header and used for the default filename. */
  sessionId?: string;
}

/** One file mutation, either persisted on the session or read back from a tool message. */
export interface ExportedEdit {
  id: string;
  name: string;
  preview: string;
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return cleaned || "default";
}

/**
 * Default export name. The session id keeps repeated exports of the same
 * project apart; without it every `/export` overwrote the previous file.
 */
export function defaultExportFilename(project: string, sessionId?: string): string {
  const id = sessionId ? `-${safeName(sessionId)}` : "";
  return `luban-export-${safeName(project)}${id}.md`;
}

/**
 * Expand `~` and resolve relative paths against the current working directory (lexical only).
 *
 * A user-supplied name without an extension gets `.md`, so `/export my-notes`
 * still produces a readable transcript instead of an extension-less file.
 */
export function expandExportPath(arg: string, project: string, sessionId?: string): string {
  const trimmed = arg.trim();
  if (!trimmed) return join(process.cwd(), defaultExportFilename(project, sessionId));
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? join(homedir(), trimmed.slice(1))
    : trimmed;
  const resolved = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  return extname(resolved) ? resolved : `${resolved}.md`;
}

/**
 * Every file mutation a session performed, in the order it happened.
 *
 * The session record is the durable source: compaction can drop tool messages
 * while the edit record survives, so records are loaded first and then
 * refreshed from any live message that still carries its preview.
 */
export function collectExportedEdits(
  messages: ChatMessage[],
  persisted: ExportedEdit[] = [],
): ExportedEdit[] {
  const byId = new Map<string, ExportedEdit>();
  for (const record of persisted) if (record.preview) byId.set(record.id, { ...record });
  messages.forEach((message, index) => {
    if (!message.editPreview) return;
    const id = message.tool_call_id || `edit-${index}`;
    byId.set(id, { id, name: message.name || "edit_file", preview: message.editPreview });
  });
  return [...byId.values()];
}

interface EditTotals {
  files: number;
  added: number;
  removed: number;
}

export function summarizeEdits(edits: ExportedEdit[]): EditTotals {
  const paths = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    const stats = editRecordStats(parseEditRecord(edit.preview));
    paths.add(stats.path || edit.id);
    added += stats.added;
    removed += stats.removed;
  }
  return { files: paths.size, added, removed };
}

/** Fenced, line-numbered rendering of one record, excluding its own header line. */
function renderEditBlock(preview: string): string[] {
  const out = ["```diff"];
  for (const row of parseEditRecord(preview)) {
    if (row.kind === "header") continue;
    if (row.kind === "meta") { out.push(`# ${row.text}`); continue; }
    const number = row.line === undefined ? "" : String(row.line).padStart(6);
    const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    out.push(`${number} ${sign}${row.text}`);
  }
  out.push("```");
  return out;
}

/** A failed tool result is the one tool output worth keeping in a readable log. */
function failedToolNote(content: string): string | null {
  if (!/^TOOL ERROR:/u.test(content.trim())) return null;
  const [first = "", ...rest] = content.trim().split("\n");
  const omitted = rest.length > 10 ? `\n> … 还有 ${rest.length - 10} 行` : "";
  return `> ⚠️ ${first}${rest.length ? `\n> ${rest.slice(0, 10).join("\n> ")}` : ""}${omitted}`;
}

function callArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Render the calls an assistant turn made, including what they were asked to do.
 *
 * Only the tool name used to be exported, so a reader could see that `bash` ran
 * but not the command, or that `write_file` ran but not the path. A shell
 * command keeps its full text in a fenced block; other tools show the same
 * one-line argument summary the TUI uses, so the export is a complete record.
 */
function renderToolCalls(calls: NonNullable<ChatMessage["tool_calls"]>): string[] {
  const out = ["**调用工具**", ""];
  for (const call of calls) {
    const name = call.function.name || "?";
    const args = callArguments(call.function.arguments);
    if (name === "bash" && typeof args.command === "string" && args.command.trim()) {
      out.push("- `bash`", "", "  ```sh", ...args.command.replace(/\n$/u, "").split("\n").map(line => `  ${line}`), "  ```", "");
      continue;
    }
    const detail = summarizeToolArgs(name, args);
    const shown = detail === "{}" ? "" : detail;
    out.push(`- \`${name}\`${shown ? ` · ${shown}` : ""}`);
  }
  out.push("");
  return out;
}

/** Render the current session as readable Markdown (Python `luban chat /export` style). */
export function buildSessionMarkdown(
  messages: ChatMessage[],
  meta: SessionExportMeta,
  state: SessionExportState = {},
): string {
  const project = meta.project || "default";
  const { pending = [], plan, verifications = [] } = state;
  const edits = collectExportedEdits(messages, state.edits ?? []);
  const totals = summarizeEdits(edits);
  const byId = new Map(edits.map(edit => [edit.id, edit]));
  const lines = [
    `# luban 会话记录 — ${project}`,
    "",
    `- 节点: \`${meta.nodeName}\``,
    ...(meta.sessionId ? [`- 会话: \`${meta.sessionId}\``] : []),
    `- 工作区: \`${meta.workspace}\``,
    `- 模型: \`${meta.modelId}\``,
    `- 模式: \`${meta.mode}\``,
    `- 消息数: ${messages.length}`,
    `- 任务状态: ${meta.running ? "进行中" : "无"}`,
    `- 文件修改: ${totals.files} 个文件 · +${totals.added} −${totals.removed}`,
    `- 导出时间: ${new Date().toISOString()}`,
    "",
  ];

  // A change summary up front: the conversation below can be long, and the set
  // of touched files is the part people look for first. Diffs that still have
  // their tool message are rendered inline where they happened, so only the
  // records that compaction orphaned are expanded here.
  if (edits.length) {
    const rows = edits.map(edit => ({ edit, stats: editRecordStats(parseEditRecord(edit.preview)) }));
    lines.push("## 修改记录", "");
    lines.push("| 文件 | 工具 | 增 | 删 | 行范围 |", "|---|---|---|---|---|");
    for (const { edit, stats } of rows) {
      const range = stats.firstLine === undefined
        ? "—"
        : stats.firstLine === stats.lastLine ? `L${stats.firstLine}` : `L${stats.firstLine}–L${stats.lastLine}`;
      lines.push(`| \`${stats.path || edit.id}\` | ${edit.name} | +${stats.added} | −${stats.removed} | ${range} |`);
    }
    lines.push("");
    const inline = new Set(messages.filter(message => message.editPreview).map((message, index) => message.tool_call_id || `edit-${index}`));
    const orphaned = rows.filter(({ edit }) => !inline.has(edit.id));
    if (orphaned.length) {
      lines.push("> 以下改动所在的工具消息已被上下文压缩，细节保留在此。", "");
      for (const { edit, stats } of orphaned) {
        lines.push(`### ✏️ ${editRecordTitle(stats.path, stats)}`, "");
        lines.push(...renderEditBlock(edit.preview), "");
      }
    }
  }

  if (plan) {
    lines.push("## 任务计划", "");
    if (plan.explanation) lines.push(`${plan.explanation}`, "");
    for (const item of plan.plan) {
      const box = item.status === "completed" ? "x" : item.status === "in_progress" ? "→" : " ";
      lines.push(`- [${box}] ${item.step}`);
    }
    lines.push("");
    lines.push(`> 验证门禁: ${state.planVerified ? "✓ 已完成步骤均有通过记录" : "○ 未满足"}`);
    lines.push("");
  }

  if (verifications.length) {
    const passed = verifications.filter(record => record.status === "passed").length;
    lines.push(`## 验证记录 (${verifications.length} 次 · ${passed} 通过 · ${verifications.length - passed} 失败)`, "");
    lines.push("| 状态 | 命令 | 时间 |", "|---|---|---|");
    for (const record of verifications) {
      const command = record.command.replaceAll("|", "\\|").replaceAll(/\s+/gu, " ").slice(0, 160);
      lines.push(`| ${record.status === "passed" ? "✓ 通过" : "✗ 失败"} | \`${command}\` | ${record.createdAt.slice(0, 19).replace("T", " ")} |`);
    }
    lines.push("");
    const failed = verifications.filter(record => record.status !== "passed" && record.output.trim());
    if (failed.length) {
      for (const record of failed.slice(-3)) {
        lines.push(`失败输出 · \`${record.command.slice(0, 120)}\``, "", "```", ...record.output.replace(/\n$/u, "").split("\n").slice(0, 20), "```", "");
      }
    }
  }

  lines.push("---", "");

  for (const message of messages) {
    if (message.role === "system") {
      const content = String(message.content ?? "");
      if (content.startsWith("[luban context summary]")) {
        lines.push("> *(较早对话已压缩为摘要)*\n");
        lines.push(`${content}\n`);
      }
      continue;
    }
    if (message.role === "user") {
      const content = String(message.content ?? "");
      if (content.startsWith("(summarized")) {
        lines.push("> *(较早对话已压缩为摘要)*\n");
        continue;
      }
      lines.push(`## 👤 用户\n\n${content}\n`);
    } else if (message.role === "assistant") {
      const content = String(message.content ?? "").trim();
      const calls = message.tool_calls ?? [];
      if (content || calls.length) {
        lines.push("## 🤖 luban", "");
        if (content) lines.push(`${content}`, "");
        if (calls.length) lines.push(...renderToolCalls(calls));
      }
    } else if (message.role === "tool") {
      // The mutation itself belongs next to the call that produced it: the
      // summary table is a directory, this is the evidence.
      const record = message.tool_call_id ? byId.get(message.tool_call_id) : undefined;
      if (record) {
        const stats = editRecordStats(parseEditRecord(record.preview));
        lines.push(`### ✏️ ${editRecordTitle(stats.path, stats)}`, "");
        lines.push(...renderEditBlock(record.preview), "");
        continue;
      }
      const failure = failedToolNote(String(message.content ?? ""));
      if (failure) lines.push(failure, "");
    }
  }
  if (pending.length) {
    lines.push("## 待处理补充指令\n");
    for (const item of pending) lines.push(`- [${item.delivery}] ${item.content}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
