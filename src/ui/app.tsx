import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, measureElement, type DOMElement } from "ink";
import fg from "fast-glob";
import { VERSION } from "../version.js";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { AgentInbox } from "../core/inbox.js";
import { planVerificationStatus, readPlan, readVerifications } from "../core/plan.js";
import { AgentRunner, initialMessages, type Approval } from "../core/agent.js";
import { estimateMessagesTokens } from "../core/context.js";
import { savePermissionMode, savePreferredModel, saveTheme } from "../core/config.js";
import type { JobStreamRecord, MeshChatMessage, MeshJob, MeshRuntime } from "../core/mesh/runtime.js";
import { jobPhase, jobPlan } from "../core/mesh/job-stream-view.js";
import { chatBlocks, jobBlocks } from "./mesh-transcript.js";
import { SessionStore } from "../core/session-store.js";
import { summarizeToolArgs } from "../core/tools.js";
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
  LubanConfig,
  ModelRef,
  PendingInput,
  SessionRecord,
  ToolDefinition,
  VerificationRecord,
} from "../core/types.js";
import { HighlightedCodeLine } from "./markdown.js";
import { activeTheme, activeThemeId, applyTheme, findTheme, THEMES, theme, themeHasOverrides, themeIds } from "./theme.js";
import { sessionColor } from "./session-color.js";
import { toolLabel } from "./tool-labels.js";
import { Spinner, ThinkingLine, type LivePhase } from "./thinking-line.js";
import { currentStreamLine } from "./transcript.js";
import { layoutInput } from "./input-layout.js";
import { transcriptLines, TranscriptLineView } from "./transcript-lines.js";
import { TextArea } from "./text-area.js";
import { DiffLine as CodeDiffLine } from "./execution-view.js";
import { listWindow, scrollPercent, scrollbarThumb } from "./scroll.js";
import { absolutePosition, ScrollBar, type LayoutNode } from "./scroll-bar.js";
import {
  MOUSE_WHEEL_DOWN,
  MOUSE_WHEEL_UP,
  cellIn,
  createMouseInputGuard,
  isLeftPress,
  isMotion,
  isWheel,
  parseMouseReports,
  screenRect,
  stripMouseReports,
  type ScreenRect,
} from "./mouse-input.js";
import { buildTranscript, estimateLines } from "./transcript-blocks.js";
import { outcomeNote, type RunOutcome } from "./run-outcome.js";
import { verificationHeadline, verificationLine, verificationSummary, visibleVerifications } from "./verification-view.js";
import { workspaceDiff } from "../core/workspace-diff.js";
import { historyFromMessages, pushInputHistory, recallDown, recallUp } from "./input-history.js";
import { toAttachedImage } from "../core/vision.js";
import { buildCopyText, osc52CopySequence, writeSystemClipboard } from "./clipboard.js";
import { buildSessionMarkdown, collectExportedEdits, defaultExportFilename, expandExportPath, summarizeEdits } from "./session-export.js";

const MODES: AgentMode[] = ["auto", "agent", "ask"];
const CODEX_EFFORTS: Array<{ value: ModelRef["reasoningEffort"]; title: string; detail: string }> = [
  { value: undefined, title: "CLI default", detail: "Use Codex config.toml" },
  { value: "low", title: "Low", detail: "low" },
  { value: "medium", title: "Medium", detail: "medium" },
  { value: "high", title: "High", detail: "high" },
  { value: "xhigh", title: "Extra high", detail: "xhigh" },
  { value: "max", title: "Max", detail: "max" },
  { value: "ultra", title: "Ultra", detail: "ultra" },
];
/** Rows per wheel notch when scrolling execution details. */
const WHEEL_ROWS = 2;
/** Bounded per-job event buffer: the stream is a view, the session is the record. */
const MAX_MESH_STREAM_EVENTS = 1200;
const ACTIVE_JOB_STATUS = new Set(["queued", "pending", "working"]);
const COMMANDS = [
  ["/new", "new session"],
  ["/branch", "fork session at [n] messages"],
  ["/sessions", "open session"],
  ["/models", "switch model"],
  ["/mode", "auto / agent / ask"],
  ["/clear", "clear conversation"],
  ["/settings", "current context"],
  ["/token", "show phone login token and link"],
  ["/permissions", "ask / edits / allow"],
  ["/peers", "LAN collaborators"],
  ["/ping", "ping <peer>"],
  ["/status", "status <peer>"],
  ["/message", "message <peer> <text>"],
  ["/handoff", "handoff <peer> <task>"],
  ["/ask-all", "ask-all <task>"],
  ["/sync", "sync push|pull <peer> [mode]"],
  ["/jobs", "jobs [<id>] 展开远程任务过程"],
  ["/inbox", "recent mesh messages"],
  ["/cancel-job", "cancel-job <id>"],
  ["/add-contact", "add-contact <name> <host> <port>"],
  ["/queue", "queue a task after the current task"],
  ["/pending", "show saved pending messages"],
  ["/copy", "copy last answer to clipboard"],
  ["/export", "export session to markdown"],
  ["/plan", "show current task plan"],
  ["/verify", "verification records"],
  ["/theme", "terminal color scheme"],
  ["/details", "expand / collapse execution details"],
  ["/diff", "review code changes"],
  ["/mesh", "switch local conversation / mesh activity"],
  ["/help", "keyboard and commands"],
  ["/exit", "save and quit"],
] as const;

/** Read-only or view commands that execute immediately during a run, like codex:
 * a status query never waits behind the active task. */
const RUN_IMMEDIATE_COMMANDS = new Set([
  "/status", "/ping", "/peers", "/jobs", "/inbox", "/cancel-job", "/add-contact",
  "/models", "/mode", "/settings", "/permissions",
  "/token",
  "/plan", "/theme", "/details", "/mesh", "/help", "/diff", "/verify",
]);

const COMMAND_USAGE: Record<string, string> = {
  "/mode": "/mode auto|agent|ask",
  "/theme": "/theme [名称] — 不带参数列出全部配色，带名称即时切换并保存",
  "/permissions": "/permissions ask|edits|allow",
  "/queue": "/queue <task> — current task finishes first",
  "/export": "/export [文件名|路径] — markdown transcript (默认 luban-export-<项目>-<sessionId>.md)",
  "/ping": "/ping <peer>",
  "/jobs": "/jobs [<job-id>] — 列出最近的 mesh 任务，给出 id 时在主流程里展开它的完整执行过程",
  "/status": "/status <peer>",
  "/message": "/message <peer> <text>",
  "/handoff": "/handoff <peer> <task>",
  "/ask-all": "/ask-all <task>",
  "/sync": "/sync push|pull <peer> [auto|git|chunk]",
  "/cancel-job": "/cancel-job <id>",
  "/add-contact": "/add-contact <name> <host> <tcp-port> [udp-port]",
};

function atToken(input: string): string | null {
  const match = input.match(/@([\w./-]*)$/u);
  return match ? (match[1] ?? "") : null;
}


const TASK_PATTERN = /(fix|build|implement|create|write|change|refactor|test|debug|deploy|修复|开发|实现|创建|编写|修改|重构|测试|调试|部署)/i;

function resolvedMode(mode: AgentMode, prompt: string): AgentMode {
  if (mode !== "auto") return mode;
  // Only an explicit ASK selection enforces read-only access. Keyword misses in
  // AUTO must not silently block legitimate tasks in other languages.
  return TASK_PATTERN.test(prompt) ? "agent" : "auto";
}

interface ToolTrace {
  id: string;
  name: string;
  detail: string;
  status: "running" | "done" | "failed";
  elapsedMs?: number;
  preview?: string;
  editPreview?: string;
}

interface ActivityEntry {
  id: string;
  text: string;
  tone?: "muted" | "accent" | "green" | "red";
  /** Messages known when it arrived; places the note inside the transcript. */
  at: number;
}

interface ApprovalRequest {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  resolve(value: Approval): void;
}

interface DialogState {
  type: "models" | "codex-effort" | "sessions" | "diff" | "verify" | "info" | "export" | "theme";
  index: number;
  modelId?: string;
  title?: string;
  content?: string;
}

export interface AppProps {
  config: LubanConfig;
  mesh?: MeshRuntime;
  resume?: string;
  initialPrompt?: string;
  mobileLink?: string;
}


function oneLine(value: string, limit = 80): string {
  const flat = value.trim().replaceAll(/\s+/gu, " ");
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** First whitespace-delimited token of a submitted line, lowercased. */
function commandOf(value: string): string {
  const boundary = value.search(/\s/u);
  return (boundary < 0 ? value : value.slice(0, boundary)).toLowerCase();
}

/** Everything after the first token of a submitted line. */
function argumentOf(value: string): string {
  const boundary = value.search(/\s/u);
  return boundary < 0 ? "" : value.slice(boundary).trim();
}

function modeColor(mode: AgentMode): string {
  if (mode === "agent") return theme.accent;
  if (mode === "ask") return theme.green;
  return theme.accent;
}

function modeLabel(mode: AgentMode): string {
  return mode[0]!.toUpperCase() + mode.slice(1);
}

function toolHistory(messages: ChatMessage[], edits: SessionRecord["edits"] = []): ToolTrace[] {
  const entries: ToolTrace[] = [];
  const byId = new Map<string, ToolTrace>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
      } catch { /* malformed arguments are represented by the tool result */ }
      const entry: ToolTrace = { id: call.id, name: call.function.name, detail: summarizeToolArgs(call.function.name, args), status: "running" };
      entries.push(entry);
      byId.set(call.id, entry);
    }
    if (message.role === "tool" && message.tool_call_id) {
      const entry = byId.get(message.tool_call_id);
      if (entry) {
        entry.status = String(message.content ?? "").startsWith("TOOL ERROR:") ? "failed" : "done";
        entry.preview = String(message.content ?? "").slice(0, 1200);
        entry.editPreview = message.editPreview || (String(message.content).startsWith("Edited ") ? String(message.content) : undefined);
      }
    }
  }
  return [...edits.filter(edit => !byId.has(edit.id)).map(edit => ({ id: edit.id, name: edit.name, detail: "", status: "done" as const, editPreview: edit.preview })), ...entries];
}

function ToolTraceView({ trace }: { trace: ToolTrace }) {
  const color = trace.status === "failed" ? theme.red : theme.muted;
  return (
    <Box paddingLeft={3} height={1} overflow="hidden">
      {trace.status === "running" ? <Spinner color={theme.accent} /> : <Text color={color}>{trace.status === "failed" ? "×" : "→"}</Text>}
      <Text color={color}> {toolLabel(trace.name)}</Text>
      <Text color={theme.dim} wrap="truncate-end">  {trace.detail}</Text>
      {trace.elapsedMs !== undefined ? <Text color={theme.dim}>  {(trace.elapsedMs / 1000).toFixed(1)}s</Text> : null}
      {trace.status === "failed" && trace.preview ? <Text color={theme.red}>  {trace.preview}</Text> : null}
    </Box>
  );
}


function DiffDialog({ diff }: { diff: Awaited<ReturnType<typeof workspaceDiff>> | null }) {
  if (!diff) return <Text color={theme.dim}>正在读取工作区变更…</Text>;
  if (!diff.files.length) return <Text color={theme.dim}>当前工作区没有检测到 Git 修改。</Text>;
  const lines = diff.patch.split("\n").slice(-Math.max(10, 500));
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} flexShrink={0}>
    <Text color={theme.accent} bold>代码变更 · {diff.files.length} 个文件 · Esc 返回</Text>
    {diff.files.map(file => <Text key={`${file.status}-${file.path}`} color={theme.muted}>{file.status} {file.path}</Text>)}
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, index) => {
        if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) return <CodeDiffLine key={`${index}-${line}`} line={line} />;
        return <Text key={`${index}-${line}`} color={theme.dim}>{line || " "}</Text>;
      })}
    </Box>
  </Box>;
}

/** /export confirmation: the target file is shown before anything is written,
 * and the name stays editable. An empty value keeps the default name. */
function ExportDialog({ value, defaultName, dest }: { value: string; defaultName: string; dest: string }) {
  return (
    <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} paddingY={1} marginX={2} flexShrink={0}>
      <Text color={theme.primary} bold>导出 Markdown · Enter 确认写入 · Esc 取消 · Ctrl+U 清空</Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>文件名 </Text>
        {value ? <Text color={theme.text} wrap="truncate-start">{value}</Text> : <Text color={theme.dim}>{defaultName}（默认 · 直接输入可改名）</Text>}
        <Text color={theme.accent}>▏</Text>
      </Box>
      <Box><Text color={theme.dim}>保存到 </Text><Text color={theme.dim} wrap="truncate-start">{dest}</Text></Box>
    </Box>
  );
}

/** Read-only command output shown in a dismissible dialog so an active run is
 * never interrupted by a status query answering mid-flight. */
function InfoDialog({ title, content }: { title: string; content: string }) {
  const lines = content.split("\n").slice(0, 200);
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} flexShrink={0}>
    <Text color={theme.accent} bold>{title} · Esc/Enter 返回</Text>
    {lines.map((line, index) => <Text key={`${index}-${line.slice(0, 24)}`} color={theme.muted} wrap="truncate-end">{line || " "}</Text>)}
  </Box>;
}

/** Swatch order for a theme row: the hues that carry status at a glance. */
const SWATCH_KEYS = ["accent", "green", "yellow", "red", "purple", "text"] as const;

/** Rows the picker shows at once; the catalog is longer than a terminal. */
const THEME_ROWS = 12;

/**
 * Slice of the catalog to draw, chosen so the highlighted row is always inside
 * it. Every row is previewed by repainting the whole workbench on arrow keys, so
 * a selected row scrolled out of view would mean choosing a scheme blind.
 */
function themeWindow(total: number, index: number): { start: number; end: number } {
  if (total <= THEME_ROWS) return { start: 0, end: total };
  const start = Math.min(Math.max(0, index - Math.floor(THEME_ROWS / 2)), total - THEME_ROWS);
  return { start, end: start + THEME_ROWS };
}

/**
 * Picker for the terminal color scheme. Every palette is previewed with its own
 * swatches, so the choice is made by looking at the colors rather than by
 * reading names - the whole point of offering several schemes. The highlighted
 * row is painted onto the workbench as it moves, which is why `index` comes
 * from the keyboard handler rather than from the palette module.
 */
function ThemeDialog({ index }: { index: number }) {
  const active = activeThemeId();
  const { start, end } = themeWindow(THEMES.length, index);
  const visible = THEMES.slice(start, end);
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} flexShrink={0}>
    <Text color={theme.accent} bold>主题 · {active} · ↑/↓ 预览 · Enter 确认 · Esc 取消</Text>
    <Text color={theme.dim} wrap="truncate-end">/theme &lt;名称&gt; 即时切换并写入 ~/.luban/node-preferences.json</Text>
    <Text color={theme.dim} wrap="truncate-end">config.json 里 theme 可写名称，或用 colors 只覆盖某几个颜色</Text>
    {start > 0 ? <Text color={theme.dim}>  ↑ 还有 {start} 个配色</Text> : null}
    {visible.map((item, offset) => {
      const row = start + offset;
      return (
        <Text key={item.id} wrap="truncate-end" backgroundColor={row === index ? theme.selected : undefined}>
          <Text color={item.id === active ? theme.green : theme.dim} bold>{row === index ? "▸ " : "  "}</Text>
          <Text color={item.id === active ? theme.green : theme.primary}>{item.id.padEnd(16)}</Text>
          {SWATCH_KEYS.map((key) => <Text key={key} color={item.palette[key]}>■</Text>)}
          <Text color={theme.muted}>  {item.mode === "light" ? "亮色" : "暗色"} · {item.description}</Text>
          {item.id === active ? <Text color={theme.green}> ·当前</Text> : null}
        </Text>
      );
    })}
    {end < THEMES.length ? <Text color={theme.dim}>  ↓ 还有 {THEMES.length - end} 个配色</Text> : null}
  </Box>;
}

/**
 * Verification records are the runtime's evidence that a command was actually
 * run. This panel shows every record for the session, not only the latest one,
 * so a failing check cannot be hidden behind a later passing one.
 */
function VerifyDialog({ records, gate }: { records: VerificationRecord[]; gate: { verified: boolean; detail: string } }) {
  const summary = verificationSummary(records, gate);
  if (!summary.total) {
    return <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} flexShrink={0}>
      <Text color={theme.accent} bold>验证记录 · Esc 返回</Text>
      <Text color={theme.dim}>本次会话还没有记录验证。Agent 需要运行测试或检查并调用 record_verification。</Text>
    </Box>;
  }
  const visible = visibleVerifications(records);
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} flexShrink={0}>
    <Text color={theme.accent} bold>验证记录 · {verificationHeadline(summary)} · Esc 返回</Text>
    <Text wrap="truncate-end">
      <Text color={summary.verified ? theme.green : theme.yellow} bold>{summary.verified ? "✓ 计划已完成步骤均有通过记录" : "○ 尚未满足验证门禁"}</Text>
      <Text color={theme.dim}>  {summary.detail}</Text>
    </Text>
    {visible.map((record) => {
      const line = verificationLine(record);
      return <Box key={record.id} flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          <Text color={record.status === "passed" ? theme.green : theme.red} bold>{line.marker} </Text>
          <Text color={theme.primary}>{line.command}</Text>
          <Text color={theme.dim}>  {line.at}</Text>
        </Text>
        {line.output ? <Text color={theme.muted} wrap="truncate-end">  {line.output}</Text> : null}
      </Box>;
    })}
    {summary.total > visible.length ? <Text color={theme.dim}>只显示最近 {visible.length} 条 · 共 {summary.total} 条</Text> : null}
  </Box>;
}

function Header({ config, mode, sessionTitle, mesh }: { config: LubanConfig; mode: AgentMode; sessionTitle: string; mesh?: MeshRuntime }) {
  const directory = basename(config.workspace);
  const online = mesh?.peers().filter((peer) => peer.online).length || 0;
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} flexShrink={0}>
      <Box justifyContent="space-between">
      <Box flexShrink={0}>
        <Text color={modeColor(mode)} bold>{modeLabel(mode)}</Text>
        <Text color={theme.primary} bold> · {directory}</Text>
        <Text color={theme.dim}> · v{VERSION}</Text>
      </Box>
      <Box marginLeft={2} flexShrink={1} overflow="hidden">
        {mesh ? <Text color={online ? theme.green : theme.dim}>mesh {online} online  ·  </Text> : null}
        <Text color={theme.dim} wrap="truncate-start">{config.model.id}</Text>
      </Box>
      </Box>
      <Text color={theme.muted} wrap="truncate-end">{sessionTitle || "New session"}</Text>
    </Box>
  );
}

function HelpPanel() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginX={1} flexShrink={0}>
      <Text color={theme.accent} bold>快捷键与命令</Text>
      <Text color={theme.muted}>Shift+Tab 模式 · Ctrl+P 模型 · Ctrl+O 会话 · Esc 取消</Text>
      <Text color={theme.muted}>↑↓ 历史 · PgUp/PgDn 翻页 · Ctrl+J 换行 · @ 文件补全</Text>
      <Text color={theme.muted}>Ctrl+Y 鼠标开关 · 关后可选中复制 · /copy 复制上次回答 · /theme 换配色</Text>
      <Text color={theme.muted}>Ctrl+C 运行中中断任务 / 空闲复制回答 · Ctrl+D 保存并退出 · /exit 退出</Text>
      <Text color={theme.muted}>运行中可继续输入补充指令，/queue 排队下一任务</Text>
      <Text color={theme.muted}>运行中只读命令即时执行：/status /peers /jobs /models /mode /settings /permissions /plan /mesh /help</Text>
      <Text color={theme.muted}>直接输入任务，!command 执行 shell，/ 命令补全（含参数用法）</Text>
      <Text color={theme.dim}>/new /sessions /models /mode /permissions /theme /plan /details /mesh /copy /export /help /exit</Text>
    </Box>
  );
}


function Welcome({ config, mesh }: { config: LubanConfig; mesh?: MeshRuntime }) {
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Text color={theme.dim}>·          ✦       ·</Text>
      <Text color={theme.primary} bold>✦     d a g e n t     ·</Text>
      <Text color={theme.dim}>     ·          ✦</Text>
      <Text color={theme.muted}>luban v{VERSION}</Text>
      <Box marginTop={1}><Text color={theme.muted}>{config.workspace}</Text></Box>
      <Text color={theme.dim}>{config.model.id}</Text>
      {mesh ? <Text color={theme.dim}>mesh · {config.mesh.nodeName} · {mesh.peers().filter((peer) => peer.online).length} online</Text> : null}
      <Box marginTop={2}><Text color={theme.muted}>Ask a question or describe a task</Text></Box>
      <Text color={theme.dim}>/ commands  ·  ! shell  ·  Shift+Tab modes</Text>
    </Box>
  );
}

export function commandMatches(input: string): typeof COMMANDS[number][] {
  if (!input.startsWith("/") || /\s/u.test(input)) return [];
  const needle = input.toLowerCase();
  const prefix = COMMANDS.filter(([name]) => name.startsWith(needle));
  const rest = needle.length > 2
    ? COMMANDS.filter(([name]) => !name.startsWith(needle) && name.includes(needle.slice(1)))
    : [];
  return [...prefix, ...rest];
}

export function argumentMatches(input: string): string[] {
  const match = /^(\/\S+)\s+(\S*)$/u.exec(input);
  if (!match) return [];
  const command = match[1]!.toLowerCase();
  const options = command === "/mode" ? MODES
    : command === "/permissions" ? ["ask", "edits", "allow"]
      : command === "/theme" ? THEMES.map((item) => item.id)
        : command === "/sync" ? ["push", "pull"] : [];
  return options.filter((option) => option.startsWith(match[2]!.toLowerCase()));
}

function CommandHints({ input, index }: { input: string; index: number }) {
  if (!input.startsWith("/")) return null;
  if (!input.includes(" ")) {
    const matches = commandMatches(input);
    if (!matches.length) return null;
    const visibleRows = 8;
    const start = Math.min(Math.max(0, index - Math.floor(visibleRows / 2)), Math.max(0, matches.length - visibleRows));
    return (
      <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} paddingY={1} marginX={1}>
        <Text color={theme.dim}>命令 · ↑↓ 选择 · Tab 补全 · {Math.min(index + 1, matches.length)}/{matches.length}</Text>
        {matches.slice(start, start + visibleRows).map(([name, description], offset) => (
          <Box key={name} backgroundColor={start + offset === index ? theme.selected : undefined}>
            <Text color={start + offset === index ? theme.accent : theme.dim}>{start + offset === index ? "› " : "  "}</Text>
            <Text color={theme.primary} bold={start + offset === index}>{name.padEnd(14)}</Text>
            <Text color={theme.muted}>{description}</Text>
          </Box>
        ))}
      </Box>
    );
  }
  const command = input.slice(0, input.search(/\s/u)).toLowerCase();
  const usage = COMMAND_USAGE[command];
  if (!usage) return null;
  const options = argumentMatches(input);
  const visibleRows = 8;
  const start = Math.min(Math.max(0, index - Math.floor(visibleRows / 2)), Math.max(0, options.length - visibleRows));
  return (
    <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} paddingY={1} marginX={1}>
      <Text><Text color={theme.dim}>用法 · </Text><Text color={theme.primary}>{usage}</Text></Text>
      {options.length ? <Text color={theme.dim}>↑↓ 选择 · Tab 补全参数 · {Math.min(index + 1, options.length)}/{options.length}</Text> : null}
      {options.slice(start, start + visibleRows).map((option, offset) => <Text key={option} backgroundColor={start + offset === index ? theme.selected : undefined} color={start + offset === index ? theme.accent : theme.muted}>{start + offset === index ? "› " : "  "}{option}</Text>)}
    </Box>
  );
}

function AtHints({ input, files }: { input: string; files: string[] }) {
  const token = atToken(input);
  if (token === null || !files.length) return null;
  const needle = token.toLowerCase();
  const matches = files.filter((file) => file.toLowerCase().includes(needle)).slice(0, 5);
  if (!matches.length) return null;
  return (
    <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} paddingY={1} marginX={1}>
      <Text color={theme.dim}>FILES · Tab 补全 @{token || "…"}（@path 会随消息发送给模型）</Text>
      {matches.map((file) => (
        <Text key={file}><Text color={theme.primary}>@{file}</Text></Text>
      ))}
    </Box>
  );
}

export function SelectDialog({
  title,
  rows,
  index,
  query,
  activeKey,
}: {
  title: string;
  rows: Array<{ key: string; title: string; detail: string; project?: string; date?: string; turns?: number; color?: string }>;
  index: number;
  query?: string;
  activeKey?: string;
}) {
  const visibleRows = 12;
  const start = Math.min(Math.max(0, index - Math.floor(visibleRows / 2)), Math.max(0, rows.length - visibleRows));
  return (
    <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} paddingY={1} marginX={2}>
      <Text color={theme.primary} bold>{title}<Text color={theme.dim}> · {rows.length} 条</Text>{query ? <Text color={theme.muted}> · filter: {query}</Text> : null}</Text>
      {start > 0 ? <Text color={theme.dim}>  ↑ 还有 {start} 条</Text> : null}
      {rows.slice(start, start + visibleRows).map((row, offset) => (
        <Box key={row.key} backgroundColor={start + offset === index ? theme.selected : undefined} paddingX={1}>
          <Text color={start + offset === index ? theme.accent : theme.dim}>{start + offset === index ? "› " : "  "}</Text>
          <Text color={row.color ?? theme.primary} bold={start + offset === index || row.key === activeKey}>{row.title}</Text>
          {row.key === activeKey ? <Text color={theme.green}> ●当前</Text> : null}
          {row.project ? <Text color={row.color ?? theme.muted}>  {row.project}</Text> : null}
          <Text color={theme.dim}>  {row.date ?? row.detail}</Text>
          {row.turns !== undefined ? <Text color={theme.yellow}>  {row.turns}轮</Text> : null}
        </Box>
      ))}
      {start + visibleRows < rows.length ? <Text color={theme.dim}>  ↓ 还有 {rows.length - start - visibleRows} 条</Text> : null}
      {!rows.length ? <Text color={theme.dim}>无匹配 · 退格修改过滤</Text> : null}
      <Box marginTop={1}><Text color={theme.dim}>↑↓ navigate · enter select · esc close · 直接输入过滤</Text></Box>
    </Box>
  );
}

export function App({ config: initialConfig, mesh, resume, initialPrompt, mobileLink }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 30 }));
  useEffect(() => {
    // Ink relayouts its existing tree on resize, but does not re-run App. A
    // reconnected VS Code terminal can therefore retain the old root height
    // and leave the composer below the visible screen until another command
    // happens to update React state.
    const onResize = (): void => setTerminalSize({ columns: stdout.columns || 80, rows: stdout.rows || 30 });
    stdout.on("resize", onResize);
    onResize();
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);
  const [config, setConfig] = useState(initialConfig);
  const [mode, setMode] = useState<AgentMode>("auto");
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialMessages(initialConfig.workspace, initialConfig.model.name, initialConfig.planning));
  const [input, setInput] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [showPlan, setShowPlan] = useState(true);
  // Reads/searches start collapsed; edits always retain their inline diffs.
  const [showDetails, setShowDetails] = useState(false);
  const [showMesh, setShowMesh] = useState(false);
  const [activeMode, setActiveMode] = useState<AgentMode>("auto");
  const [showHelp, setShowHelp] = useState(false);
  // One scroll position for the whole transcript, measured in lines from the
  // newest content: 0 is "live", larger values look further back.
  const [scrollOffset, setScrollOffset] = useState(0);
  const transcriptNode = useRef<DOMElement | null>(null);
  const [transcriptSize, setTranscriptSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!transcriptNode.current) return;
    const size = measureElement(transcriptNode.current);
    setTranscriptSize(current => current.width === size.width && current.height === size.height ? current : size);
  });
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState("");
  // Streaming text arrives one token at a time, and every state write re-renders
  // and re-lays-out the whole visible transcript (~11 ms for a screenful). At
  // 50 tokens/s that saturates the event loop and makes the session feel slow,
  // so deltas accumulate and flush on a timer instead. A frame every 80 ms is
  // still smoother than the eye needs, and it cuts renders by roughly an order
  // of magnitude. Tool boundaries flush immediately so nothing feels deferred.
  const draftRef = useRef("");
  const draftTimerRef = useRef<NodeJS.Timeout | null>(null);
  const flushDraft = useCallback((): void => {
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
    setDraft((current) => (current === draftRef.current ? current : draftRef.current));
  }, []);
  const appendDraft = useCallback((text: string): void => {
    draftRef.current += text;
    if (draftTimerRef.current) return;
    draftTimerRef.current = setTimeout(() => { draftTimerRef.current = null; flushDraft(); }, 80);
    draftTimerRef.current.unref?.();
  }, [flushDraft]);
  const resetDraft = useCallback((): void => {
    draftRef.current = "";
    flushDraft();
  }, [flushDraft]);
  useEffect(() => () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); }, []);
  const [thinkingDraft, setThinkingDraft] = useState("");
  // Reasoning is shown live on one line but never enters the transcript, so a
  // session stays a clean record of the work rather than of the model's
  // internal monologue. Updates are coalesced; a reasoning model emits these
  // far faster than a terminal needs to redraw.
  const [thinkingLine, setThinkingLine] = useState("");
  const [thinkingChars, setThinkingChars] = useState(0);
  const thinkingRawRef = useRef("");
  const thinkingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const flushThinking = useCallback((): void => {
    if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }
    const text = currentStreamLine(thinkingRawRef.current);
    setThinkingLine((current) => (current === text ? current : text));
    setThinkingChars((current) => (current === thinkingRawRef.current.length ? current : thinkingRawRef.current.length));
  }, []);
  const appendThinking = useCallback((text: string): void => {
    // Bound the buffer: only the newest line matters for display.
    thinkingRawRef.current = (thinkingRawRef.current + text).slice(-4000);
    if (thinkingTimerRef.current) return;
    thinkingTimerRef.current = setTimeout(() => { thinkingTimerRef.current = null; flushThinking(); }, 120);
    thinkingTimerRef.current.unref?.();
  }, [flushThinking]);
  const resetThinking = useCallback((): void => {
    thinkingRawRef.current = "";
    if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }
    setThinkingLine("");
    setThinkingChars(0);
  }, []);
  useEffect(() => () => { if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current); }, []);
  const [executionLog, setExecutionLog] = useState<ToolTrace[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [, setThinkingTick] = useState(0);
  const thinkingStartedRef = useRef<number | null>(null);
  const thinkingFragmentsRef = useRef(0);
  // Live position in the agent loop, so the working line can say *what* it is
  // waiting for instead of only that something is running.
  const [livePhase, setLivePhase] = useState<LivePhase | null>(null);
  const [callIndex, setCallIndex] = useState(0);
  // Wall-clock of the last output of any kind. Held in a ref to keep the
  // per-token path free of another state write; the one-second tick renders it.
  const lastOutputRef = useRef(0);
  const [notice, setNotice] = useState("Describe a goal, ask a question, or type / for commands.");
  const [runOutcome, setRunOutcome] = useState<RunOutcome | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogQuery, setDialogQuery] = useState("");
  /** Counts palette swaps: the colors live outside React, so a change needs a frame. */
  const [, setThemeRevision] = useState(0);
  /** Theme that was active when the picker opened, so Esc can put it back. */
  const themeDialogOriginRef = useRef<string | null>(null);
  /**
   * Row the picker is on, mirrored outside React state. Holding an arrow key
   * delivers several escapes in one stdin chunk, and each of those handlers
   * would otherwise read the same stale `dialog.index` and collapse the whole
   * burst into a single step.
   */
  const themeDialogIndexRef = useRef(0);
  /**
   * Counts session renames. The title lives on the session record rather than in
   * React state, so writing a model-written name needs a frame to show it.
   */
  const [, setSessionTitleRevision] = useState(0);
  /** Sessions already sent to the naming call, so a failing model is not retried per turn. */
  const namedSessionsRef = useRef(new Set<string>());
  const titleAbortRef = useRef<AbortController | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  // Mouse capture defaults on: wheel scrolling of the execution history is a
  // primary interaction, and a hidden Ctrl+Y prerequisite made it look broken.
  // Ctrl+Y releases the mouse when native text selection is needed instead.
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const draftBackupRef = useRef("");
  // Live snapshot of the stream geometry. Assigning it during render keeps one
  // long-lived stdin listener: re-subscribing on every streamed line would
  // churn, and a closed-over value would freeze mid-run counts.
  const streamMetricsRef = useRef({ totalLines: 0, viewport: 24 });
  const lastStreamTotalRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  // Where the scrollbar column sits on screen, so a press can be hit-tested
  // against the track rather than guessed from layout constants.
  const barNodeRef = useRef<LayoutNode | null>(null);
  const barGeometryRef = useRef({ x: 0, top: 0 });
  const dragRef = useRef<{ startY: number; startOffset: number; moved: boolean } | null>(null);
  // Where the composer's text sits on screen, so a click inside it can be
  // turned into a caret offset instead of a stray character.
  const inputNodeRef = useRef<LayoutNode | null>(null);
  const inputGeometryRef = useRef<ScreenRect | null>(null);
  const [caretRequest, setCaretRequest] = useState<{ row: number; column: number; nonce: number } | null>(null);
  const caretNonceRef = useRef(0);
  // Terminals that ignore ?1006 report in the older X10/rxvt encodings, whose
  // payloads Ink hands to the composers as if they were typed. The guard drops
  // them there; it learns which encoding to expect from the raw bytes here.
  const mouseGuardRef = useRef(createMouseInputGuard());
  const applyScroll = useCallback((direction: "up" | "down", lines: number) => {
    const { totalLines, viewport } = streamMetricsRef.current;
    const max = Math.max(0, totalLines - viewport);
    const delta = Math.max(1, Math.trunc(lines) || 1);
    setScrollOffset((current) => Math.min(max, Math.max(0, current + (direction === "up" ? delta : -delta))));
  }, []);
  useEffect(() => {
    const inputStream = process.stdin;
    const outputStream = stdout;
    // Mouse reporting hijacks terminal text selection; Ctrl+Y toggles it off
    // so the user can select and copy output natively. 1002 enables
    // button-event tracking, which is what makes dragging the scrollbar work.
    if (mouseEnabled) outputStream.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    const onData = (chunk: Buffer) => {
      let up = 0;
      let down = 0;
      // Every encoding, parsed from the raw bytes: a terminal that ignores
      // ?1006 answers with X10/rxvt reports whose coordinates are not text.
      for (const report of parseMouseReports(chunk)) {
        mouseGuardRef.current.observe(report);

        if (isWheel(report)) { // bit 6 marks a wheel report, low bits give direction
          if (report.code === MOUSE_WHEEL_UP) up += 1;
          else if (report.code === MOUSE_WHEEL_DOWN) down += 1;
          continue;
        }

        const { x, y } = report;
        if (isMotion(report)) { // bit 5 is set while a button is held
          const drag = dragRef.current;
          if (!drag) continue;
          const { totalLines, viewport } = streamMetricsRef.current;
          const linesPerCell = Math.max(1, totalLines / Math.max(1, viewport));
          const max = Math.max(0, totalLines - viewport);
          const moved = Math.abs(y - drag.startY);
          if (moved) drag.moved = true;
          setScrollOffset(Math.min(max, Math.max(0, Math.round(drag.startOffset + (drag.startY - y) * linesPerCell))));
          continue;
        }

        if (report.released) { // a click that never moved pages toward the click
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag || drag.moved) continue;
          const { top } = barGeometryRef.current;
          const { totalLines, viewport } = streamMetricsRef.current;
          const bar = listWindow(totalLines, viewport, drag.startOffset);
          const thumb = scrollbarThumb(bar, Math.max(1, viewport));
          if (!thumb) continue;
          const thumbTop = top + thumb.start + 1;
          if (y < thumbTop) applyScroll("up", viewport);
          else if (y >= thumbTop + thumb.size) applyScroll("down", viewport);
          continue;
        }

        if (!isLeftPress(report)) continue;

        // A left press inside the track starts a drag. Movement is applied
        // relatively, so the content follows the pointer without the thumb
        // jumping to wherever the press landed.
        const geometry = barGeometryRef.current;
        const { totalLines, viewport } = streamMetricsRef.current;
        const inTrack = Math.abs(x - geometry.x) <= 1 && y >= geometry.top + 1 && y <= geometry.top + viewport;
        if (inTrack) {
          dragRef.current = { startY: y, startOffset: scrollOffsetRef.current, moved: false };
          continue;
        }

        // Anywhere else, a press inside the composer puts the caret where the
        // pointer is. Clicking outside it does nothing at all: never text.
        const cell = cellIn(inputGeometryRef.current, report);
        if (cell) setCaretRequest({ ...cell, nonce: (caretNonceRef.current += 1) });
      }
      if (!up && !down) return;
      setShowDetails(true);
      // A trackpad or a fast wheel delivers several reports per read, so count
      // the notches and apply one clamped step instead of N independent jumps.
      applyScroll(up >= down ? "up" : "down", Math.max(up, down) * WHEEL_ROWS);
    };
    inputStream.on("data", onData);
    return () => { inputStream.off("data", onData); if (mouseEnabled) outputStream.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l"); };
  }, [stdout, mouseEnabled, applyScroll]);
  useEffect(() => {
    let cancelled = false;
    void fg(["**/*"], { cwd: config.workspace, onlyFiles: true, dot: false,
      ignore: ["**/.git/**", "**/node_modules/**", "**/.luban/**", "**/dist/**", "**/target/**"] })
      .then((files) => { if (!cancelled) setWorkspaceFiles(files.slice(0, 4000)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [config.workspace]);
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof workspaceDiff>> | null>(null);
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const [meshChats, setMeshChats] = useState<MeshChatMessage[]>([]);
  const [meshRows, setMeshRows] = useState<Array<{ job: MeshJob; lastLog: string }>>([]);
  const [, setMeshRevision] = useState(0);
  const announcedMeshJobs = useRef(new Set<string>());
  const lastJobLogUpdateRef = useRef(0);
  // Every remote job's structured stream, kept in arrival order. The terminal
  // renders the same tool rows, edit records and notes for these as for a local
  // run; before this they were streamed to the node and dropped on the floor.
  const meshStreamsRef = useRef(new Map<string, JobStreamRecord[]>());
  const [meshStreamRevision, setMeshStreamRevision] = useState(0);
  const lastJobEventUpdateRef = useRef(0);
  const jobEventRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const focusedJobIdRef = useRef<string | null>(null);
  // Job status by id, updated synchronously with the events that carry it, so
  // the auto-focus decision does not depend on a render having happened yet.
  const meshStatusRef = useRef(new Map<string, string>());
  const store = useMemo(() => new SessionStore(config.home), [config.home]);
  const [initialRunner] = useState(() => new AgentRunner(initialConfig, undefined, mesh));
  const runnerRef = useRef(initialRunner);
  const sessionRef = useRef(store.create(config.project, config.workspace, mode, config.model.id, messages));
  const [pendingInputs, setPendingInputs] = useState<PendingInput[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  // A mid-run /models or /permissions swap must not abort the active run, so
  // the previous runner is retired and reaped only once the run has ended.
  const runningRef = useRef(false);
  const retiredRunnersRef = useRef<AgentRunner[]>([]);
  const detachedQueriesRef = useRef(new Set<AbortController>());
  // Steer/queue admission binds to the inbox directly, so a runner swap
  // mid-run keeps accepting input for the task that is actually executing.
  const inboxRef = useRef<AgentInbox | null>(null);

  useEffect(() => () => {
    for (const query of detachedQueriesRef.current) query.abort(new Error("exited"));
    titleAbortRef.current?.abort(new Error("exited"));
    runnerRef.current.close();
    for (const retired of retiredRunnersRef.current) retired.close();
  }, []);

  useEffect(() => {
    runningRef.current = running;
    if (!running) {
      for (const retired of retiredRunnersRef.current) retired.close();
      retiredRunnersRef.current = [];
    }
  }, [running]);

  const swapRunner = (make: () => AgentRunner) => {
    const previous = runnerRef.current;
    runnerRef.current = make();
    if (runningRef.current) retiredRunnersRef.current.push(previous);
    else previous.close();
  };

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setThinkingTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  const save = async (nextMessages = messages) => {
    const record = sessionRef.current;
    record.messages = nextMessages;
    record.model = runnerRef.current.config.model.id;
    await store.save(record);
  };

  /**
   * Give the session a name once there is an exchange to name it after.
   *
   * The title starts as the first line of the opening user message, which is a
   * poor label for the sessions that need one most — "继续", a pasted stack
   * trace, or a one-word question. So after the first run the model is asked for
   * a name, and the record is marked as model-titled so the next save does not
   * put the raw first line back.
   *
   * Fire-and-forget: naming must never delay or fail a run. A model that cannot
   * be reached, or that answers with something that is not a title, leaves the
   * derived title in place, and the session is not asked again (a provider that
   * is down should not be charged one call per turn for the rest of the day).
   */
  const nameSession = () => {
    const record = sessionRef.current;
    if (record.titleSource === "model") return;
    if (namedSessionsRef.current.has(record.id)) return;
    namedSessionsRef.current.add(record.id);
    titleAbortRef.current?.abort(new Error("superseded"));
    const controller = new AbortController();
    titleAbortRef.current = controller;
    void runnerRef.current.suggestTitle(record.messages, controller.signal).then(async (suggestion) => {
      if (!suggestion) return;
      setUsage((current) => ({ input: current.input + suggestion.input, output: current.output + suggestion.output }));
      if (!suggestion.title) return;
      // The user may have opened another session while the call was in flight;
      // that rename belongs to the session it was written for, not to this one.
      if (controller.signal.aborted || sessionRef.current.id !== record.id) return;
      record.title = suggestion.title;
      record.titleSource = "model";
      setSessionTitleRevision((revision) => revision + 1);
      await save(record.messages);
    }).catch(() => undefined);
  };

  // Notes are stamped with the message count so the transcript can interleave
  // them where they happened; without that a retry notice would read as if it
  // belonged to the final answer.
  const addActivity = (entry: Omit<ActivityEntry, "at">) =>
    setActivity((current) => [...current, { ...entry, at: sessionRef.current.messages.length }].slice(-60));

  /**
   * Pin the remote job whose detail the stream shows. Pinning is what lets a
   * reader keep watching one job while another arrives.
   */
  const focusJob = useCallback((id: string | null): void => {
    focusedJobIdRef.current = id;
    setFocusedJobId(id);
  }, []);

  const switchModel = (model: ModelRef) => {
    const nextConfig = { ...config, model, models: config.models.map((entry) => entry.id === model.id ? model : entry) };
    setConfig(nextConfig);
    swapRunner(() => new AgentRunner(nextConfig, undefined, mesh));
    sessionRef.current.model = model.id;
    void savePreferredModel(config.home, model.id, model.api === "codex" ? model.reasoningEffort ?? null : undefined);
    setNotice(`Model switched to ${model.id}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ""}`);
  };

  const newSession = (nextMode = mode) => {
    setShowMesh(false);
    setScrollOffset(0);
    runnerRef.current.close();
    runnerRef.current = new AgentRunner(config, undefined, mesh);
    const nextMessages = initialMessages(config.workspace, config.model.name, config.planning);
    setMessages(nextMessages);
        setExecutionLog([]);
    resetDraft();
    setThinkingDraft("");
    setRunOutcome(null);
    setShowDetails(false);
    setPendingInputs([]);
    setInputHistory([]);
    setHistoryIndex(null);
    draftBackupRef.current = "";
    sessionRef.current = store.create(config.project, config.workspace, nextMode, config.model.id, nextMessages);
    setNotice("New session");
  };

  const syncPendingView = () => setPendingInputs([...(sessionRef.current.pendingInputs ?? [])]);

  const expandAtMentions = async (text: string): Promise<{ text: string; images: Array<{ path: string; mime: string }> }> => {
    const mentions = [...new Set([...text.matchAll(/@([\w./-]{1,120})/gu)].map((match) => match[1]!))].slice(0, 5);
    if (!mentions.length) return { text, images: [] };
    const chunks: string[] = [];
    const images: Array<{ path: string; mime: string }> = [];
    for (const mention of mentions) {
      const cleaned = mention.replace(/[.,;:!?]+$/u, "");
      if (!cleaned || cleaned.startsWith("/")) continue;
      const attached = toAttachedImage(cleaned);
      if (attached) {
        try {
          const info = await stat(join(config.workspace, cleaned));
          if (info.isFile() && info.size <= 8_000_000) images.push(attached);
        } catch {
          // Unknown @ target: leave the literal text for the model to interpret.
        }
        continue;
      }
      const abs = join(config.workspace, cleaned);
      try {
        const info = await stat(abs);
        if (!info.isFile() || info.size > 200_000) continue;
        const content = await readFile(abs, "utf8");
        chunks.push(`<attached file="${cleaned}">\n${content.slice(0, 12_000)}\n</attached>`);
      } catch {
        // Unknown @ target: leave the literal text for the model to interpret.
      }
    }
    return { text: chunks.length ? `${chunks.join("\n\n")}\n\n${text}` : text, images };
  };

  const copyLastToClipboard = async () => {
    const text = buildCopyText(messages, executionLog, pendingInputs, runOutcome?.text ?? "");
    if (!text.trim()) {
      setNotice("没有可复制的内容");
      return;
    }
    // OSC 52 first (xterm/iTerm2/ghostty/Windows Terminal), then a native
    // helper. GNOME Terminal's VTE ignores OSC 52 by default, so without the
    // wl-copy/xclip/xsel path a "copy" never reaches the user's Ctrl+V.
    try {
      stdout.write(osc52CopySequence(text));
    } catch { /* OSC52 unsupported: fall back to helper below */ }
    const system = await writeSystemClipboard(text);
    if (system) {
      setNotice("已复制到系统剪贴板 · Ctrl+V 粘贴");
      return;
    }
    try {
      const path = join(config.home, "last-copy.md");
      await writeFile(path, text, "utf8");
      setNotice(`OSC52 已发送（GNOME Terminal 可能忽略）· 未检测到剪贴板工具，已另存 ${path}`);
    } catch (error) {
      setNotice(`已发送 OSC52 复制 · 文件备份失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportSession = async (arg: string) => {
    const sessionId = sessionRef.current.id;
    let dest = expandExportPath(arg, config.project, sessionId);
    try {
      if ((await stat(dest)).isDirectory()) dest = join(dest, defaultExportFilename(config.project, sessionId));
    } catch { /* missing path: treat as the destination file */ }
    const record = sessionRef.current;
    const markdown = buildSessionMarkdown(record.messages, {
      project: config.project,
      workspace: config.workspace,
      nodeName: config.mesh.nodeName,
      modelId: config.model.id,
      mode: activeMode,
      running,
      sessionId,
    }, {
      pending: pendingInputs,
      edits: record.edits ?? [],
      ...(taskPlan ? { plan: taskPlan } : {}),
      verifications,
      planVerified: verificationStatus.verified,
    });
    try {
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, markdown, "utf8");
      const totals = summarizeEdits(collectExportedEdits(record.messages, record.edits ?? []));
      const changes = totals.files ? ` · ${totals.files} 个文件 +${totals.added} −${totals.removed}` : "";
      setNotice(`已导出 ${record.messages.length} 条消息${changes} → ${dest}`);
    } catch (error) {
      setNotice(`导出失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleEvent = (event: AgentEvent) => {
    if (event.type === "input") {
      resetDraft(); setThinkingDraft("");
      setMessages([...sessionRef.current.messages]);
      syncPendingView();
      setNotice(`已接收补充指令: ${event.text.slice(0, 80)}`);
    }
    if (event.type === "status") {
      setStatus(event.text);
      // Progress labels feed the working line only. Recording them made a
      // 56-step run stack 55 identical "Reviewing tool results" notes, and the
      // 60-entry window they filled is the one that has to hold the retry,
      // compaction and outcome notes a reader actually needs.
      if (!event.progress) addActivity({ id: `status-${Date.now()}`, text: event.text, tone: "accent" });
    }
    if (event.type === "model-call") {
      // A new round trip: reasoning from the previous one is stale, and the
      // silence counter restarts from the moment the request went out.
      resetThinking();
      lastOutputRef.current = Date.now();
      setCallIndex(event.index);
      setLivePhase({ kind: "waiting", detail: "", since: lastOutputRef.current });
    }
    if (event.type === "delta") {
      setThinkingDraft("");
      appendDraft(event.text);
      if (event.text) {
        lastOutputRef.current = Date.now();
        setLivePhase((current) => current?.kind === "responding" ? current : { kind: "responding", detail: "", since: Date.now() });
      }
    }
    if (event.type === "thinking-delta") {
      thinkingFragmentsRef.current += 1;
      appendThinking(event.text);
      if (event.text) {
        lastOutputRef.current = Date.now();
        setLivePhase((current) => current?.kind === "reasoning" ? current : { kind: "reasoning", detail: "", since: Date.now() });
      }
    }
    // Reasoning finished for this round trip. Keep its text as the fallback for
    // the answer that follows, but move the phase on: a bare "N 段推理" counter
    // that outlived the reasoning is exactly what made a stalled run unreadable.
    if (event.type === "thought") {
      resetDraft();
      setThinkingDraft("");
      lastOutputRef.current = Date.now();
      setLivePhase({ kind: "responding", detail: "", since: Date.now() });
    }
    if (event.type === "usage") setUsage((current) => ({ input: current.input + event.input, output: current.output + event.output }));
    if (event.type === "error") {
      setNotice(event.text);
      addActivity({ id: `error-${Date.now()}`, text: event.text, tone: "red" });
    }
    if (event.type === "tool-start") {
      resetDraft();
      setThinkingDraft("");
      const detail = summarizeToolArgs(event.name, event.args);
      lastOutputRef.current = Date.now();
      // Tools are the other long, silent stretch of a run — name the command
      // rather than leaving the line on "等待模型响应".
      setLivePhase((current) => current?.kind === "tool"
        ? { ...current, detail }
        : { kind: "tool", detail, since: Date.now() });
      const trace: ToolTrace = {
        id: event.id,
        name: event.name,
        detail: summarizeToolArgs(event.name, event.args),
        status: "running",
      };
            setExecutionLog((current) => [...current, trace]);
      // The agent appends the assistant tool-call message before running the
      // tool, so republishing the session array is what makes the transcript
      // grow live instead of only appearing once the whole run finishes.
      setMessages([...sessionRef.current.messages]);
    }
    if (event.type === "tool-end") {
      const finished = {
        status: event.ok ? "done" as const : "failed" as const,
        elapsedMs: event.elapsedMs,
        preview: event.preview,
        editPreview: event.editPreview,
      };
      setExecutionLog((current) => current.map((trace) => trace.id === event.id ? { ...trace, ...finished } : trace));
      setMessages([...sessionRef.current.messages]);
      lastOutputRef.current = Date.now();
      // The loop goes back for the next round trip; "model-call" confirms it.
      setLivePhase((current) => current?.kind === "tool" ? { kind: "waiting", detail: "正在准备下一步…", since: Date.now() } : current);
      // The inline execution record already contains status, output and edits.
      // Do not duplicate it as notices or pull a reader away from older rows.
    }
  };

  const approveTool = (tool: ToolDefinition, args: Record<string, unknown>): Promise<Approval> => new Promise((resolveApproval) => {
    // Approval always brings details forward so the user sees what is asked.
    setShowDetails(true);
    setApproval({ tool, args, resolve: resolveApproval });
  });

  const runPrompt = async (text: string, images: Array<{ path: string; mime: string }> = []) => {
    setShowMesh(false);
    const user: ChatMessage = { role: "user", content: text, ...(images.length ? { images } : {}) };
    const nextMessages = [...sessionRef.current.messages, user];
    setMessages(nextMessages);
    setScrollOffset(0);
        setActivity([]);
    resetDraft();
    setThinkingDraft("");
    setRunOutcome(null);
    setScrollOffset(0);
    setShowDetails(false);
    thinkingStartedRef.current = Date.now();
    resetThinking();
    thinkingFragmentsRef.current = 0;
    lastOutputRef.current = Date.now();
    setCallIndex(0);
    setLivePhase({ kind: "waiting", detail: "正在准备请求…", since: lastOutputRef.current });
    setRunning(true);
    const runMode = resolvedMode(sessionRef.current.mode, text);
    setStatus(runMode === "agent" ? "Agent mode" : runMode === "ask" ? "Ask mode" : "Auto mode");
    setActiveMode(runMode);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await save(nextMessages);
      const inbox = new AgentInbox(sessionRef.current, () => save(nextMessages));
      inboxRef.current = inbox;
      const result = await runnerRef.current.run(nextMessages, runMode, controller.signal, handleEvent, approveTool, () => save(nextMessages), inbox);
      setMessages([...result.messages]);
      setExecutionLog((current) => toolHistory(result.messages, sessionRef.current.edits).map((entry) => ({
        ...entry,
        ...(current.find((item) => item.id === entry.id) ?? {}),
      })));
      resetDraft();
      setThinkingDraft("");
      // Truncated output pauses with the partial answer saved, exactly like a
      // step-budget pause, so the same "继续" resumes it.
      const paused = result.stopReason === "max_steps" || result.stopReason === "truncated";
      setRunOutcome({
        status: result.ok ? "completed" : paused ? "paused" : "failed",
        text: result.text,
        steps: result.steps,
        modelCalls: result.modelCalls,
        elapsedMs: result.elapsedMs,
      });
      setNotice(result.ok
        ? `Completed in ${result.steps} step${result.steps === 1 ? "" : "s"}`
        : paused ? `已暂停（${result.steps} 步），发送“继续”恢复\n${result.text}` : result.text);
      addActivity({ id: `complete-${Date.now()}`, text: result.ok ? `完成 · ${result.steps} steps` : paused ? `已暂停 · ${result.steps} steps` : "任务结束", tone: result.ok ? "green" : paused ? "accent" : "red" });
      await save(result.messages);
      // The opening exchange now exists, so this is the first moment a name can
      // be written from it. Not awaited: the notice above must not wait on it.
      nameSession();
    } catch (error) {
      const message = controller.signal.aborted ? "Run cancelled" : (error instanceof Error ? error.message : String(error));
      setNotice(message);
      setRunOutcome({ status: controller.signal.aborted ? "cancelled" : "failed", text: message });
      setMessages([...nextMessages]);
      resetDraft();
      setThinkingDraft("");
      addActivity({ id: `cancel-${Date.now()}`, text: message, tone: "red" });
    } finally {
      abortRef.current = null;
      inboxRef.current = null;
      setApproval(null);
      setRunning(false);
      thinkingStartedRef.current = null;
      setLivePhase(null);
      flushThinking();
      setStatus("");
      setScrollOffset(0);
      syncPendingView();
    }
  };

  const directShell = async (command: string) => {
    const tool = runnerRef.current.tools.get("bash");
    if (!tool) return;
    const user: ChatMessage = { role: "user", content: `!${command}` };
    setShowMesh(false);
    setScrollOffset(0);
    const next = [...messages, user];
    setMessages(next);
    setScrollOffset(0);
    setRunning(true);
    const shellTrace: ToolTrace = { id: "direct-shell", name: "bash", detail: command, status: "running" };
    
    setExecutionLog((current) => [...current, shellTrace]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const output = await tool.execute({ command }, controller.signal);
      const finished = [...next, { role: "assistant", content: `\`\`\`text\n${output}\n\`\`\`` } as ChatMessage];
      setMessages(finished);
      
      setExecutionLog((current) => current.map((trace) => trace.id === "direct-shell" ? { ...trace, status: "done", preview: oneLine(output, 240) } : trace));
      await save(finished);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      
      setExecutionLog((current) => current.map((trace) => trace.id === "direct-shell" ? { ...trace, status: "failed", preview: message } : trace));
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const runMeshAction = async (
    raw: string,
    label: string,
    detail: string,
    action: (signal: AbortSignal) => Promise<string>,
  ) => {
    const user: ChatMessage = { role: "user", content: raw };
    setShowMesh(false);
    setScrollOffset(0);
    const next = [...messages, user];
    const traceId = `mesh-${Date.now()}`;
    setMessages(next);
    setScrollOffset(0);
    setRunning(true);
    const meshTrace: ToolTrace = { id: traceId, name: label, detail, status: "running" };
    
    setExecutionLog((current) => [...current, meshTrace]);
    const controller = new AbortController();
    abortRef.current = controller;
    await save(next);
    try {
      const output = await action(controller.signal);
      const finished = [...next, { role: "assistant", content: output || "Done." } as ChatMessage];
      setMessages(finished);
      setExecutionLog((current) => current.map((trace) => trace.id === traceId ? { ...trace, status: "done", preview: oneLine(output || "Done.", 240) } : trace));
      setNotice("Mesh command completed");
      await save(finished);
    } catch (error) {
      const message = controller.signal.aborted ? "Mesh command cancelled" : (error instanceof Error ? error.message : String(error));
      const finished = [...next, { role: "assistant", content: `Mesh error: ${message}` } as ChatMessage];
      setMessages(finished);
      setExecutionLog((current) => current.map((trace) => trace.id === traceId ? { ...trace, status: "failed", preview: message } : trace));
      setNotice(message);
      await save(finished);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  /** Mesh query answered while a run is active: it never flips `running`,
   * touches the transcript, or shares the run's abort controller. The result
   * opens in a dismissible info dialog instead. */
  const runDetachedMeshAction = async (
    raw: string,
    label: string,
    detail: string,
    action: (signal: AbortSignal) => Promise<string>,
  ) => {
    setNotice(`${label} · ${oneLine(detail, 40)} 查询中…`);
    const controller = new AbortController();
    detachedQueriesRef.current.add(controller);
    const traceId = `mesh-${Date.now()}`;
    setExecutionLog((current) => [...current, { id: traceId, name: label, detail, status: "running" as const }]);
    try {
      const output = await action(controller.signal);
      setDialog({ type: "info", index: 0, title: `${label} · ${oneLine(detail, 40)}`, content: output || "Done." });
      setNotice(`${label} completed`);
      setExecutionLog((current) => current.map((trace) => trace.id === traceId ? { ...trace, status: "done", preview: oneLine(output || "Done.", 240) } : trace));
    } catch (error) {
      const message = controller.signal.aborted ? "Mesh command cancelled" : (error instanceof Error ? error.message : String(error));
      setNotice(message);
      setExecutionLog((current) => current.map((trace) => trace.id === traceId ? { ...trace, status: "failed", preview: message } : trace));
    } finally {
      detachedQueriesRef.current.delete(controller);
    }
  };

  const requireMesh = (): MeshRuntime | undefined => {
    if (!mesh) setNotice("Native mesh is unavailable (disabled or failed to start); check the mesh ports in ~/.luban/config.json.");
    return mesh;
  };

  const openSessions = async () => {
    const entries = await store.list(undefined, config.workspace);
    setSessions(entries);
    setDialogQuery("");
    if (!entries.length) setNotice("No saved sessions");
    else setDialog({ type: "sessions", index: 0 });
  };

  const submit = async (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    const rememberInput = () => {
      setInputHistory((current) => pushInputHistory(current, value));
      setHistoryIndex(null);
      draftBackupRef.current = "";
    };
    if (value === "/pending") {
      setNotice(sessionRef.current.pendingInputs?.map((item) => `${item.delivery}: ${item.content}`).join(" · ") || "No pending messages");
      syncPendingView();
      rememberInput();
      setInput(""); return;
    }
    if (value === "/copy" || value.startsWith("/copy ")) {
      rememberInput();
      setInput("");
      await copyLastToClipboard();
      return;
    }
    if (value === "/export" || value.startsWith("/export ")) {
      // Confirm the target file first: the name is shown and editable before
      // anything is written, so an export can never land in the wrong place.
      rememberInput();
      setInput("");
      setDialogQuery(value.slice("/export".length).trim());
      setDialog({ type: "export", index: 0 });
      return;
    }
    if (value === "/plan") {
      setShowPlan((current) => !current);
      rememberInput();
      setInput(""); return;
    }
    if (value === "/verify" || value === "/verifications") {
      setDialog({ type: "verify", index: 0 });
      rememberInput();
      setInput(""); return;
    }
    if (value === "/mesh") {
      setShowMesh((current) => !current);
      setScrollOffset(0);
      rememberInput();
      setInput("");
      return;
    }
    if (running) {
      // Codex-style: read-only and view commands execute immediately mid-run;
      // only task-bearing input (plain text, /queue, !shell) waits or steers.
      if (value.startsWith("/") && !value.startsWith("/queue ")) {
        const command = commandOf(value);
        if (command === "/exit") { rememberInput(); setInput(""); await save(); runnerRef.current.close(); exit(); return; }
        if (RUN_IMMEDIATE_COMMANDS.has(command)) {
          rememberInput();
          setInput("");
          await handleSlashCommand(command, argumentOf(value), value, runDetachedMeshAction);
          return;
        }
        setNotice(`运行中仅 /queue、补充指令和只读命令（/status /peers /models 等）可用；Esc 中断当前任务。`); return;
      }
      if (value.startsWith("!")) { setNotice("运行中 !command 会排队：请用 /queue 排入下一任务，或直接输入作为补充指令。"); return; }
      const queued = value.startsWith("/queue ");
      const rawContent = queued ? value.slice(7).trim() : value;
      if (!rawContent) { setNotice("Usage: /queue <task>"); return; }
      const expanded = await expandAtMentions(rawContent);
      const content = expanded.text;
      try {
        if (!inboxRef.current) throw new Error("No agent run is accepting input");
        await inboxRef.current.enqueue(content, queued ? "queue" : "steer", expanded.images);
        setShowMesh(false);
        setScrollOffset(0);
        rememberInput();
        setInput("");
        syncPendingView();
        setNotice(queued
          ? `排队任务已保存 · 待处理 ${sessionRef.current.pendingInputs?.length ?? 0} 条 · 当前完成后执行`
          : `补充指令已保存 · 待处理 ${sessionRef.current.pendingInputs?.length ?? 0} 条 · 下一边界生效`);
      } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
      return;
    }
    // Idle: every submitted line is recallable with Up/Down.
    rememberInput();
    setInput("");
    if (value.startsWith("/queue ")) { const expanded = await expandAtMentions(value.slice(7)); return runPrompt(expanded.text, expanded.images); }
    if (value.startsWith("!")) return directShell(value.slice(1).trim());
    if (!value.startsWith("/")) { const expanded = await expandAtMentions(value); return runPrompt(expanded.text, expanded.images); }
    await handleSlashCommand(commandOf(value), argumentOf(value), value, runMeshAction);
  };

  /** Slash-command chain shared by the idle path and mid-run immediate commands.
   * `meshAction` decides whether a mesh query joins the transcript (idle) or
   * answers in a detached dialog so an active run is never disturbed. */
  const handleSlashCommand = async (command: string, argument: string, value: string, meshAction: typeof runMeshAction) => {
    if (command === "/details") { setScrollOffset(0); setShowDetails((current) => !current); return; }
    if (command === "/diff") { setDiff(null); setDialog({ type: "diff", index: 0 }); void workspaceDiff(config.workspace).then(setDiff); return; }
    if (command === "/help") { setShowHelp(true); return; }
    if (command === "/exit") { await save(); runnerRef.current.close(); exit(); return; }
    if (command === "/new" || command === "/clear") { await save(); newSession(); return; }
    if (command === "/branch") {
      const keep = argument ? Number(argument) : Number.POSITIVE_INFINITY;
      if (argument && (!Number.isFinite(keep) || keep < 1)) { setNotice("Usage: /branch [message-count]"); return; }
      await save();
      const forked = store.branch(sessionRef.current, keep);
      await store.save(forked);
      sessionRef.current = forked;
      setMessages(forked.messages);
      setShowMesh(false);
      setScrollOffset(0);
      setExecutionLog(toolHistory(forked.messages, forked.edits));
      setPendingInputs([]);
            setRunOutcome(null);
      setNotice(`Branched as ${forked.title} · ${forked.messages.length} messages`);
      return;
    }
    if (command === "/models") { setDialogQuery(""); setDialog({ type: "models", index: Math.max(0, config.models.findIndex((item) => item.id === config.model.id)) }); return; }
    if (command === "/sessions") { await openSessions(); return; }
    if (command === "/mode") {
      if (MODES.includes(argument as AgentMode)) {
        setMode(argument as AgentMode);
        setActiveMode(argument as AgentMode);
        sessionRef.current.mode = argument as AgentMode;
        setNotice(`Mode switched to ${argument.toUpperCase()}`);
      } else setNotice(`Mode: ${mode.toUpperCase()} · use /mode auto|agent|ask`);
      return;
    }
    if (command === "/settings") {
      setNotice(`${mode.toUpperCase()} · ${config.model.id}${config.model.reasoningEffort ? ` · ${config.model.reasoningEffort}` : ""} · permissions ${config.permissionMode} · theme ${activeThemeId()}${themeHasOverrides() ? "(自定义色)" : ""} · ${config.workspace}${mesh ? ` · mesh ${config.mesh.nodeName}:${config.mesh.port}` : " · mesh off"}${config.backendUrl ? ` · backend ${config.backendUrl}` : ""}`);
      return;
    }
    if (command === "/token") {
      if (mobileLink) {
        setDialog({ type: "info", index: 0, title: "本实例手机登录", content: mobileLink });
        return;
      }
      try {
        const envPath = join(homedir(), ".config/luban/relay.env");
        const envText = await readFile(envPath, "utf8");
        const values = Object.fromEntries(envText.split(/\r?\n/u).flatMap((line) => {
          const match = line.match(/^\s*(LUBAN_RELAY_ACCESS_TOKEN|LUBAN_RELAY_PUBLIC_URL)=(.*)\s*$/u);
          return match ? [[match[1]!, match[2]!.replace(/^['"]|['"]$/gu, "")]] : [];
        }));
        const token = process.env.LUBAN_RELAY_ACCESS_TOKEN?.trim() || values.LUBAN_RELAY_ACCESS_TOKEN?.trim();
        const relayUrl = process.env.LUBAN_RELAY_PUBLIC_URL?.trim() || values.LUBAN_RELAY_PUBLIC_URL?.trim();
        if (!token || !relayUrl) {
          setNotice("未找到公网令牌；请检查 ~/.config/luban/relay.env");
          return;
        }
        const parsed = new URL(relayUrl);
        if (parsed.protocol !== "https:") {
          setNotice("手机令牌地址必须使用 HTTPS");
          return;
        }
        setDialog({
          type: "info",
          index: 0,
          title: "手机登录",
          content: `令牌：${token}\n地址：${parsed.origin}/login?token=${encodeURIComponent(token)}`,
        });
      } catch (error) {
        setNotice(`读取手机令牌失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (command === "/theme") {
      const requested = argument.trim();
      if (!requested || requested.toLowerCase() === "list") {
        // Remember what was painted before the picker: Esc has to undo a
        // preview the user only scrolled past.
        themeDialogOriginRef.current = activeThemeId();
        themeDialogIndexRef.current = Math.max(0, THEMES.findIndex((item) => item.id === activeThemeId()));
        setDialogQuery("");
        setDialog({ type: "theme", index: themeDialogIndexRef.current });
        return;
      }
      const applied = findTheme(requested);
      if (!applied) { setNotice(`未知主题 ${requested} · 可用：${themeIds().join(" / ")}`); return; }
      applyTheme(applied.id, config.themeColors);
      setConfig({ ...config, theme: applied.id });
      // The palette is a module-level object read during render, so the swap
      // needs one frame of its own rather than a props change.
      setThemeRevision((revision) => revision + 1);
      void saveTheme(config.home, applied.id).catch(() => undefined);
      setNotice(`主题 ${applied.id} · ${applied.label} · ${applied.mode === "light" ? "亮色" : "暗色"} · ${applied.description} · 已保存`);
      return;
    }
    if (command === "/permissions") {
      if (!["ask", "edits", "allow"].includes(argument)) {
        setNotice(`Permissions: ${config.permissionMode} · use /permissions ask|edits|allow`);
        return;
      }
      const nextMode = argument as "ask" | "edits" | "allow";
      const nextConfig = { ...config, permissionMode: nextMode };
      setConfig(nextConfig);
      swapRunner(() => new AgentRunner(nextConfig, undefined, mesh));
      void savePermissionMode(config.home, nextMode).catch(() => undefined);
      setNotice(nextMode === "allow" ? "All tools allowed · saved to config"
        : nextMode === "edits" ? "File edits auto-run; shell & network still ask · saved to config"
          : "Every non-read tool asks before running · saved to config");
      return;
    }
    if (command === "/peers") {
      const runtime = requireMesh();
      if (!runtime) return;
      await meshAction(value, "mesh_get_peers", "known LAN peers", async () => {
        const peers = runtime.peers();
        if (!peers.length) return "No peers discovered yet. Use `/add-contact name host port` for cross-subnet peers.";
        return ["### Mesh peers", ...peers.map((peer) => `- ${peer.online ? "●" : "○"} **${peer.name}** — ${peer.host}:${peer.port}${peer.capabilities.length ? ` — ${peer.capabilities.join(", ")}` : ""}${peer.note ? ` — ${peer.note}` : ""}`)].join("\n");
      });
      return;
    }
    if (command === "/ping" || command === "/status") {
      const runtime = requireMesh();
      if (!runtime) return;
      if (!argument) { setNotice(`Usage: ${command} <peer>`); return; }
      await meshAction(value, command === "/ping" ? "mesh_ping" : "mesh_get_status", argument, async (signal) => {
        if (command === "/ping") return runtime.ping(argument, signal);
        return `\`\`\`json\n${JSON.stringify(await runtime.status(argument, signal), null, 2)}\n\`\`\``;
      });
      return;
    }
    if (command === "/message" || command === "/handoff") {
      const runtime = requireMesh();
      if (!runtime) return;
      const [peer = "", ...rest] = argument.split(/\s+/u);
      const text = rest.join(" ").trim();
      if (!peer || !text) { setNotice(`Usage: ${command} <peer> <${command === "/message" ? "message" : "task"}>`); return; }
      await meshAction(value, command === "/message" ? "mesh_message" : "mesh_handoff", `${peer} · ${text}`, (signal) => command === "/message"
        ? runtime.message(peer, text, signal)
        : runtime.handoff(peer, text, config.project, 300, signal));
      return;
    }
    if (command === "/ask-all") {
      const runtime = requireMesh();
      if (!runtime) return;
      if (!argument) { setNotice("Usage: /ask-all <task>"); return; }
      await meshAction(value, "mesh_ask_all", argument, (signal) => runtime.askAll(argument, config.project, 300, signal));
      return;
    }
    if (command === "/sync") {
      const runtime = requireMesh();
      if (!runtime) return;
      const [direction = "", peer = "", requestedMode = config.mesh.syncMode] = argument.split(/\s+/u);
      if (!["push", "pull"].includes(direction) || !peer || !["auto", "git", "chunk"].includes(requestedMode)) {
        setNotice("Usage: /sync push|pull <peer> [auto|git|chunk]");
        return;
      }
      const syncMode = requestedMode as "auto" | "git" | "chunk";
      await meshAction(value, direction === "push" ? "mesh_sync_push" : "mesh_sync_pull", `${direction} ${peer} · ${syncMode}`, (signal) => direction === "push"
        ? runtime.syncPush(peer, config.project, config.workspace, syncMode, signal)
        : runtime.syncPull(peer, config.project, config.workspace, syncMode, signal));
      return;
    }
    if (command === "/jobs") {
      const runtime = requireMesh();
      if (!runtime) return;
      const needle = argument;
      if (needle) {
        // Pinning is how a reader watches one job instead of whichever job
        // happened to report last.
        const jobs = await runtime.jobs(30);
        const match = jobs.find((job) => job.id === needle || job.id.startsWith(needle));
        if (!match) { setNotice(`No mesh job matches ${needle}`); return; }
        const { events } = runtime.jobStream(match.id);
        if (events.length) meshStreamsRef.current.set(match.id, events);
        focusJob(match.id);
        setMeshRows(jobs.map(job => ({ job, lastLog: "" })));
        setScrollOffset(0);
        setMeshRevision((revision) => revision + 1);
        setMeshStreamRevision((revision) => revision + 1);
        setShowMesh(true);
        setNotice(`Showing ${match.id} · ${match.status} · ${match.source} → ${match.target}`);
        return;
      }
      await meshAction(value, "mesh_get_jobs", "recent local jobs", async () => {
        const jobs = await runtime.jobs(30);
        if (!jobs.length) return "No mesh jobs yet.";
        return ["### Mesh jobs", ...jobs.map((job) => `- **${job.id}** · ${job.status} · ${job.source} → ${job.target} · ${job.title}`), "", "用 `/jobs <job-id>` 展开某个任务的完整过程。"].join("\n");
      });
      return;
    }
    if (command === "/inbox") {
      const runtime = requireMesh();
      if (!runtime) return;
      const inbox = await runtime.inbox(20);
      setMeshChats(inbox);
      focusJob(null);
      setScrollOffset(0);
      setShowMesh(true);
      setNotice(inbox.length ? `${inbox.length} recent mesh message${inbox.length === 1 ? "" : "s"}` : "Mesh inbox is empty");
      return;
    }
    if (command === "/cancel-job") {
      const runtime = requireMesh();
      if (!runtime) return;
      if (!argument) { setNotice("Usage: /cancel-job <job-id>"); return; }
      await meshAction(value, "mesh_cancel_job", argument, async () => await runtime.cancelLocalJob(argument) ? `Cancelled ${argument}.` : `${argument} is not active.`);
      return;
    }
    if (command === "/add-contact") {
      const runtime = requireMesh();
      if (!runtime) return;
      const [name = "", host = "", portRaw = "", udpRaw = ""] = argument.split(/\s+/u);
      const port = Number(portRaw);
      const udpPort = udpRaw ? Number(udpRaw) : config.mesh.udpPort;
      if (!name || !host || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(udpPort) || udpPort < 0 || udpPort > 65535) {
        setNotice("Usage: /add-contact <name> <host> <tcp-port> [udp-port]");
        return;
      }
      await meshAction(value, "mesh_add_contact", `${name} ${host}:${port}`, async () => {
        await runtime.addContact({ name, host, port, udpPort, note: "added from luban" });
        setMeshRevision((revision) => revision + 1);
        return `Saved contact **${name}** at ${host}:${port}.`;
      });
      return;
    }
    setNotice(`Unknown command: ${command}`);
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      if (resume) {
        const record = await store.load(resume, config.project, config.workspace);
        if (record) {
          sessionRef.current = record;
          setMessages(record.messages);
          setShowMesh(false);
          setScrollOffset(0);
          setExecutionLog(toolHistory(record.messages, record.edits));
          setMode(record.mode);
          setActiveMode(record.mode);
          setPendingInputs([...(record.pendingInputs ?? [])]);
          setInputHistory(historyFromMessages(record.messages));
          setHistoryIndex(null);
          draftBackupRef.current = "";
          const model = config.models.find((item) => item.id === record.model);
          if (model) switchModel(model);
          else { runnerRef.current.close(); runnerRef.current = new AgentRunner(config, undefined, mesh); }
          setNotice(`Resumed ${record.title}${record.pendingInputs?.length ? ` · ${record.pendingInputs.length} pending inputs; send a message to continue` : ""}`);
        } else setNotice(`Session not found: ${resume}`);
      }
      if (initialPrompt) await submit(initialPrompt);
    })();
  }, []);

  useEffect(() => {
    // Normally the CLI painted the palette before the first frame; this covers
    // the cases where <App> is mounted on its own (tests, embedders) and keeps
    // the painted scheme in step with the loaded config.
    if (activeThemeId() === config.theme) return;
    applyTheme(config.theme, config.themeColors);
    setThemeRevision((revision) => revision + 1);
  }, [config.theme]);

  useEffect(() => {
    if (!mesh) return undefined;
    void mesh.chats(50).then((chats) => setMeshChats((current) =>
      [...current, ...chats.filter((chat) => !current.some((item) => item.id === chat.id))]
        .sort((a, b) => (b.delivered_at ?? b.received_at) - (a.delivered_at ?? a.received_at)).slice(0, 50)));
    void mesh.jobs(30).then((jobs) => {
      setMeshRows((current) => [...current, ...jobs.filter((job) => !current.some((row) => row.job.id === job.id)).map((job) => ({ job, lastLog: "" }))].slice(0, 30));
      for (const job of jobs) if (!meshStatusRef.current.has(job.id)) meshStatusRef.current.set(job.id, job.status);
      // Replay what the runtime still holds, so opening a job shows its history
      // rather than only the events that arrive after the terminal started.
      for (const job of jobs) {
        const { events } = mesh.jobStream(job.id);
        if (events.length && !meshStreamsRef.current.has(job.id)) meshStreamsRef.current.set(job.id, events);
      }
      setMeshStreamRevision((revision) => revision + 1);
    });
    const off = mesh.onEvent((event) => {
      if (event.type === "job-log") {
        // Throttled: a chatty remote job must not re-render the TUI on every log line.
        const nowMs = Date.now();
        if (nowMs - lastJobLogUpdateRef.current < 500) return;
        lastJobLogUpdateRef.current = nowMs;
        setMeshRows((current) => current.map((row) => row.job.id === event.id ? { ...row, lastLog: event.message } : row));
        return;
      }
      if (event.type === "job-event") {
        const records = [...meshStreamsRef.current.get(event.id) ?? []];
        // A reconnect or a second subscription can replay an event already held.
        if (!records.some((record) => record.seq === event.seq)) {
          records.push({ seq: event.seq, at: Date.now() / 1000, event: event.event });
          if (records.length > MAX_MESH_STREAM_EVENTS) records.splice(0, records.length - MAX_MESH_STREAM_EVENTS);
          meshStreamsRef.current.set(event.id, records);
        }
        // Select the remote job inside the Mesh view without changing the
        // visible local conversation or its detail expansion.
        const focused = focusedJobIdRef.current;
        const focusedStatus = focused ? meshStatusRef.current.get(focused) : undefined;
        if (!focused || !(focusedStatus && ACTIVE_JOB_STATUS.has(focusedStatus))) focusJob(event.id);
        const nowMs = Date.now();
        if (nowMs - lastJobEventUpdateRef.current >= 200) {
          lastJobEventUpdateRef.current = nowMs;
          setMeshStreamRevision((revision) => revision + 1);
        } else if (!jobEventRefreshRef.current) {
          jobEventRefreshRef.current = setTimeout(() => {
            jobEventRefreshRef.current = null;
            lastJobEventUpdateRef.current = Date.now();
            setMeshStreamRevision((revision) => revision + 1);
          }, 200 - (nowMs - lastJobEventUpdateRef.current));
        }
        return;
      }
      setMeshRevision((revision) => revision + 1);
      if (event.type === "chat") {
        setMeshChats((current) => [event.message, ...current.filter((item) => item.id !== event.message.id)].slice(0, 50));
        setNotice(`${event.from === config.mesh.nodeName ? "📤 Message to" : "📨 Message from"} ${event.from === config.mesh.nodeName ? event.message.to : event.from}: ${event.text}`);
      }
      if (event.type === "peer" && event.discovered) setNotice(`Discovered mesh peer ${event.peer.name}`);
      if (event.type === "job") {
        setMeshRows((current) => {
          const lastLog = current.find((row) => row.job.id === event.job.id)?.lastLog ?? "";
          return [{ job: event.job, lastLog }, ...current.filter((row) => row.job.id !== event.job.id)].slice(0, 30);
        });
        meshStatusRef.current.set(event.job.id, event.job.status);
        if (event.job.source === config.mesh.nodeName) {
          setNotice(`Mesh job ${event.job.id}: ${event.job.status}`);
          if (ACTIVE_JOB_STATUS.has(event.job.status)) {
            focusJob(event.job.id);
          }
          return;
        }
        if (ACTIVE_JOB_STATUS.has(event.job.status)) {
          if (!announcedMeshJobs.current.has(event.job.id)) {
            announcedMeshJobs.current.add(event.job.id);
            setNotice(`📥 Task from ${event.job.source}: ${oneLine(event.job.instruction)}`);
          }
          // Show the work as it starts rather than only when it finishes.
          const pinned = focusedJobIdRef.current;
          const pinnedStatus = pinned ? meshStatusRef.current.get(pinned) : undefined;
          if (!pinned || !(pinnedStatus && ACTIVE_JOB_STATUS.has(pinnedStatus))) focusJob(event.job.id);
          return;
        }
        announcedMeshJobs.current.delete(event.job.id);
        if (event.job.status === "done") setNotice(`✅ Task from ${event.job.source} done: ${oneLine(event.job.result) || "no output"}`);
        else if (event.job.status === "paused") setNotice(`⏸ Task from ${event.job.source} paused: ${oneLine(event.job.result)}`);
        else if (event.job.status === "failed") setNotice(`❌ Task from ${event.job.source} failed: ${oneLine(event.job.error)}`);
        else setNotice(`⊘ Task from ${event.job.source} cancelled`);
      }
      if (event.type === "warning") setNotice(event.message);
    });
    return () => { off(); if (jobEventRefreshRef.current) clearTimeout(jobEventRefreshRef.current); jobEventRefreshRef.current = null; };
  }, [mesh]);

  useInput((character, key) => {
    if (showHelp && key.escape) {
      setShowHelp(false);
      return;
    }
    if (approval) {
      if (character.toLowerCase() === "y") { approval.resolve("once"); setApproval(null); }
      if (character.toLowerCase() === "t") { approval.resolve("tool"); setApproval(null); }
      if (character.toLowerCase() === "a") { approval.resolve("always"); setApproval(null); }
      if (character.toLowerCase() === "n" || key.escape) { approval.resolve("deny"); setApproval(null); }
      return;
    }
    if (!dialog && !approval && (key.pageUp || (key.ctrl && character.toLowerCase() === "k"))) {
      applyScroll("up", streamMetricsRef.current.viewport);
      return;
    }
    if (!dialog && !approval && key.pageDown) {
      applyScroll("down", streamMetricsRef.current.viewport);
      return;
    }
    if (dialog) {
      if (dialog.type === "export") {
        // The dialog owns the composer: Enter writes the file, Esc cancels,
        // typing edits the name, and Ctrl+U clears it back to the default.
        if (key.escape) { setDialog(null); setDialogQuery(""); }
        else if (key.return) { setDialog(null); void exportSession(dialogQuery.trim()); setDialogQuery(""); }
        else if (key.ctrl && character.toLowerCase() === "u") setDialogQuery("");
        else if (key.backspace || key.delete) setDialogQuery((current) => current.slice(0, -1));
        else if (character && !key.meta && !key.ctrl && !key.escape) {
          // Accept pasted chunks too: drop mouse reports first, then strip
          // control characters and keep the characters a file path uses.
          const clean = stripMouseReports(mouseGuardRef.current.filter(character)).replaceAll(/[^\p{L}\p{N} .,_@:/~+-]/gu, "");
          if (clean) setDialogQuery((current) => `${current}${clean}`.slice(0, 240));
        }
        return;
      }
      if (dialog.type === "theme") {
        // The picker is navigated, not just printed: colours are chosen by
        // looking at them, so every move repaints the workbench immediately.
        // Only Enter writes the choice; Esc puts the palette back as it was.
        const count = THEMES.length;
        const show = (target: string): void => {
          applyTheme(target, config.themeColors);
          setThemeRevision((revision) => revision + 1);
        };
        if (key.upArrow || key.downArrow) {
          const next = (themeDialogIndexRef.current + (key.upArrow ? -1 : 1) + count) % count;
          themeDialogIndexRef.current = next;
          show(THEMES[next]!.id);
          setDialog({ ...dialog, index: next });
          return;
        }
        if (key.escape) {
          const origin = themeDialogOriginRef.current ?? config.theme;
          show(origin);
          setNotice(`主题保持不变 · ${origin}`);
        } else if (key.return) {
          const chosen = THEMES[themeDialogIndexRef.current] ?? THEMES[0]!;
          show(chosen.id);
          setConfig({ ...config, theme: chosen.id });
          void saveTheme(config.home, chosen.id).catch(() => undefined);
          setNotice(`主题 ${chosen.id} · ${chosen.label} · ${chosen.mode === "light" ? "亮色" : "暗色"} · ${chosen.description} · 已保存`);
        } else {
          return;
        }
        themeDialogOriginRef.current = null;
        setDialog(null);
        setDialogQuery("");
        return;
      }
      if (dialog.type === "diff" || dialog.type === "verify" || dialog.type === "info") { if (key.escape || key.return) { setDialog(null); setDialogQuery(""); } return; }
      if (dialog.type === "codex-effort") {
        const model = config.models.find((item) => item.id === dialog.modelId);
        const efforts = CODEX_EFFORTS.filter((item) => item.value !== "ultra" || model?.model !== "gpt-6-luna");
        if (key.upArrow) setDialog({ ...dialog, index: (dialog.index - 1 + efforts.length) % efforts.length });
        else if (key.downArrow) setDialog({ ...dialog, index: (dialog.index + 1) % efforts.length });
        else if (key.escape) setDialog({ type: "models", index: Math.max(0, config.models.findIndex((item) => item.id === dialog.modelId)) });
        else if (key.return) {
          const selected = efforts[dialog.index];
          if (model && selected) switchModel({ ...model, reasoningEffort: selected.value });
          setDialog(null);
        }
        return;
      }
      const needle = dialogQuery.trim().toLowerCase();
      const visibleModels = needle
        ? config.models.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(needle))
        : config.models;
      const visibleSessions = needle
        ? sessions.filter((item) => `${item.title} ${item.project}`.toLowerCase().includes(needle))
        : sessions;
      const visibleCount = dialog.type === "models" ? visibleModels.length : dialog.type === "sessions" ? visibleSessions.length : 1;
      const count = Math.max(1, visibleCount);
      if (key.upArrow) setDialog({ ...dialog, index: (dialog.index - 1 + count) % count });
      else if (key.downArrow) setDialog({ ...dialog, index: (dialog.index + 1) % count });
      else if (key.escape) { setDialog(null); setDialogQuery(""); }
      else if (key.return) {
        if (dialog.type === "models") {
          const target = visibleModels[dialog.index];
          if (target?.api === "codex") {
            const efforts = CODEX_EFFORTS.filter((item) => item.value !== "ultra" || target.model !== "gpt-6-luna");
            setDialog({ type: "codex-effort", index: Math.max(0, efforts.findIndex((item) => item.value === target.reasoningEffort)), modelId: target.id });
            setDialogQuery("");
            return;
          }
          if (target) switchModel(target);
        } else {
          const record = visibleSessions[dialog.index];
          if (record) {
            sessionRef.current = record;
            setMessages(record.messages);
            setShowMesh(false);
            setScrollOffset(0);
            setExecutionLog(toolHistory(record.messages, record.edits));
            setMode(record.mode);
            setPendingInputs([...(record.pendingInputs ?? [])]);
            setInputHistory(historyFromMessages(record.messages));
            setHistoryIndex(null);
            draftBackupRef.current = "";
            const model = config.models.find((item) => item.id === record.model);
            if (model) switchModel(model);
            else { runnerRef.current.close(); runnerRef.current = new AgentRunner(config, undefined, mesh); }
            setNotice(`Opened ${record.title}${record.pendingInputs?.length ? ` · ${record.pendingInputs.length} pending` : ""}`);
            void workspaceDiff(config.workspace).then(setDiff);
          }
        }
        setDialog(null);
        setDialogQuery("");
      } else if (key.backspace || key.delete) {
        setDialogQuery((current) => current.slice(0, -1));
        setDialog({ ...dialog, index: 0 });
      } else if (character && !key.ctrl && !key.meta && character.length === 1 && /[\p{L}\p{N} _./:-]/u.test(character)) {
        setDialogQuery((current) => `${current}${character}`.slice(0, 40));
        setDialog({ ...dialog, index: 0 });
      }
      return;
    }
    if (!dialog && !approval && key.ctrl && character.toLowerCase() === "y") {
      const next = !mouseEnabled;
      setMouseEnabled(next);
      // With reporting off the terminal stops sending reports, so a literal
      // `[M` typed from now on is text again, not a swallowed X10 prefix.
      if (!next) mouseGuardRef.current.reset();
      setNotice(next
        ? "Mouse on · 滚轮滚动、拖动右侧滚动条或 PageUp/PageDown 翻阅历史 · Ctrl+Y 释放鼠标以选中复制"
        : "Mouse off · 现在可直接拖选复制文本 · /copy 复制上次回答 · Ctrl+Y 恢复滚轮");
      return;
    }
    // Ctrl+C no longer kills the process (render uses exitOnCtrlC: false):
    // running it interrupts the task like Esc, idle it copies the last answer
    // to the system clipboard. Exit is Ctrl+D or /exit.
    if (!dialog && !approval && key.ctrl && (character === "c" || character === "\u0003")) {
      if (running) {
        abortRef.current?.abort(new Error("cancelled by user"));
        return;
      }
      void copyLastToClipboard();
      return;
    }
    if (!dialog && !approval && key.ctrl && character.toLowerCase() === "d") {
      void (async () => {
        await save();
        runnerRef.current.close();
        exit();
      })();
      return;
    }
    const commandOptions = commandMatches(input);
    const argumentOptions = argumentMatches(input);
    const completionCount = commandOptions.length || argumentOptions.length;
    if (!dialog && !approval && !showHelp && completionCount && (key.upArrow || key.downArrow)
      && layoutInput(input, input.length, inputWidth, inputMaxRows).total === 1) {
      setCommandIndex((current) => (current + (key.upArrow ? -1 : 1) + completionCount) % completionCount);
      return;
    }
    if (!dialog && !approval && !showHelp && key.upArrow) {
      // A multi-line value uses the arrows to move the cursor instead.
      if (layoutInput(input, input.length, inputWidth, inputMaxRows).total > 1 || !inputHistory.length) return;
      const recalled = recallUp(inputHistory, historyIndex, input, draftBackupRef.current);
      draftBackupRef.current = recalled.draft;
      setHistoryIndex(recalled.index);
      setInput(stripMouseReports(recalled.input));
      return;
    }
    if (!dialog && !approval && !showHelp && key.downArrow) {
      if (layoutInput(input, input.length, inputWidth, inputMaxRows).total > 1 || historyIndex === null) return;
      const recalled = recallDown(inputHistory, historyIndex, draftBackupRef.current);
      if (!recalled.input && recalled.index !== null) return;
      draftBackupRef.current = recalled.draft;
      setHistoryIndex(recalled.index);
      setInput(stripMouseReports(recalled.input));
      return;
    }
    if (running && key.escape) {
      abortRef.current?.abort(new Error("cancelled by user"));
      return;
    }
    if (!running && key.tab && key.shift) {
      const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
      setMode(next);
      setActiveMode(next);
      sessionRef.current.mode = next;
      setNotice(`Mode switched to ${next.toUpperCase()}`);
      return;
    }
    if (key.ctrl && character === "p") {
      setDialogQuery("");
      setDialog({ type: "models", index: Math.max(0, config.models.findIndex((item) => item.id === config.model.id)) });
      return;
    }
    if (!running && key.ctrl && character === "o") { setDialogQuery(""); void openSessions(); return; }
    if (key.tab && !key.shift && commandOptions.length) {
      const match = commandOptions[Math.min(commandIndex, commandOptions.length - 1)];
      if (match) {
        setInput(input.toLowerCase() === match[0] && COMMAND_USAGE[match[0]] ? `${match[0]} ` : match[0]);
        setCommandIndex(0);
      }
      return;
    }
    if (key.tab && !key.shift && argumentOptions.length) {
      const option = argumentOptions[Math.min(commandIndex, argumentOptions.length - 1)];
      if (option) setInput(input.replace(/\S*$/u, option));
      setCommandIndex(0);
      return;
    }
    if (!running && key.tab && atToken(input) !== null) {
      const token = atToken(input) ?? "";
      const match = workspaceFiles.find((file) => file.toLowerCase().startsWith(token.toLowerCase()))
        ?? workspaceFiles.find((file) => file.toLowerCase().includes(token.toLowerCase()));
      if (match) setInput(input.replace(/@[\w./-]*$/u, `@${match} `));
      return;
    }
  });

  const dialogNeedle = dialogQuery.trim().toLowerCase();
  const filterDialogRows = <T extends { title: string; detail: string }>(items: T[]): T[] =>
    dialogNeedle ? items.filter((item) => `${item.title} ${item.detail}`.toLowerCase().includes(dialogNeedle)) : items;
  const sessionRows = filterDialogRows(sessions.map((record, index) => ({
    key: record.id, title: record.title, project: record.project,
    color: sessionColor(index, activeTheme().mode),
    date: record.updatedAt.slice(0, 16).replace("T", " "),
    turns: record.messages.filter((message) => message.role === "user").length,
    detail: `${record.project} · ${record.updatedAt.slice(0, 16).replace("T", " ")}`,
  })));
  const modelRows = filterDialogRows(config.models.map((model) => ({ key: model.id, title: model.name, detail: `${model.id}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ""}` })));
  const rows = terminalSize.rows;
  const narrow = terminalSize.columns < 110;
  // Each view has one ordered stream for its conversation and execution rows.
  const streamTextWidth = transcriptSize.width || Math.max(20, terminalSize.columns - (showPlan ? (narrow ? 25 : 34) : 0) - 10);
  // Remote activity has its own view. Background traffic must never displace
  // the local prompt, streaming answer, or final response.
  const focusedJob = focusedJobId ? meshRows.find((row) => row.job.id === focusedJobId)?.job : undefined;
  const focusedRecords = focusedJobId ? meshStreamsRef.current.get(focusedJobId) : undefined;
  const focusedActive = Boolean(focusedJob && ACTIVE_JOB_STATUS.has(focusedJob.status));
  const remoteBlocks = useMemo(() => {
    if (!focusedJob) return [];
    return jobBlocks(focusedJob, focusedRecords ?? [], {
      expanded: showDetails, width: streamTextWidth, localNode: config.mesh.nodeName,
    });
  }, [focusedJob, focusedRecords, meshStreamRevision, showDetails, streamTextWidth, config.mesh.nodeName]);
  const meshChatBlocks = useMemo(() => chatBlocks(meshChats, config.mesh.nodeName, streamTextWidth), [meshChats, config.mesh.nodeName, streamTextWidth]);
  const remotePhase = useMemo(() => {
    if (!focusedActive || !focusedRecords?.length) return undefined;
    return jobPhase(focusedRecords) ?? undefined;
  }, [focusedActive, focusedRecords, meshStreamRevision]);
  const streamBlocks = useMemo(() => {
    if (showMesh) return [...meshChatBlocks, ...remoteBlocks];
    const blocks = buildTranscript(messages, {
      expanded: showDetails,
      width: streamTextWidth,
      edits: sessionRef.current.edits,
      executions: executionLog,
      notes: activity.map(({ id, text, tone, at }) => ({ id, text, tone, at })),
    });
    if (pendingInputs.length) {
      for (const item of pendingInputs) {
        blocks.push({
          id: `pending-${item.id}`, kind: "note", tone: "accent", lines: 1,
          text: `${item.delivery === "queue" ? "⧉ 排队" : "→ 补充"} · ${item.content.slice(0, 200)}${running ? " · 下一边界生效" : ""}`,
        });
      }
    }
    if (draft) blocks.push({ id: "streaming", kind: "assistant", text: draft, lines: estimateLines(draft, streamTextWidth - 4) + 1 });
    if (!running && runOutcome) blocks.push(outcomeNote(runOutcome));
    return blocks;
  }, [showMesh, messages, executionLog, showDetails, streamTextWidth, pendingInputs, running, draft, runOutcome, activity, meshChatBlocks, remoteBlocks]);
  // The viewport is the pane between the app header and the composer; the
  // scrollbar and the wheel both work in this one line space.
  const scrollTrackHeight = Math.max(1, transcriptSize.height || rows - 12);
  const renderedLines = useMemo(() => transcriptLines(streamBlocks, streamTextWidth), [streamBlocks, streamTextWidth]);
  const streamView = listWindow(renderedLines.length, scrollTrackHeight, scrollOffset);
  const visibleLines = renderedLines.slice(streamView.start, streamView.end);
  const scrolledBack = streamView.offset > 0;
  streamMetricsRef.current = { totalLines: streamView.total, viewport: scrollTrackHeight };
  scrollOffsetRef.current = streamView.offset;
  // Measured after layout so the hit test follows the real rendering rather
  // than a duplicated layout constant that silently drifts.
  const barPosition = absolutePosition(barNodeRef.current);
  if (barPosition) barGeometryRef.current = { x: barPosition.left + 1, top: barPosition.top };
  // Recomputed every render from the composer's own node; a null rect (dialog
  // open, node not mounted yet) simply means a click cannot target the caret.
  inputGeometryRef.current = screenRect(inputNodeRef.current);
  // New output would otherwise push the reader's place away: while scrolled
  // back, follow the growth so the same lines stay on screen.
  useEffect(() => {
    const growth = streamView.total - lastStreamTotalRef.current;
    lastStreamTotalRef.current = streamView.total;
    if (growth <= 0) return;
    setScrollOffset((current) => current > 0 ? Math.min(streamView.maxOffset, current + growth) : 0);
  }, [streamView.total, streamView.maxOffset]);
  const taskPlan = readPlan(sessionRef.current.messages);
  const remotePlan = useMemo(() => focusedRecords?.length ? jobPlan(focusedRecords) : undefined, [focusedRecords, meshStreamRevision]);
  const remotePlanOwner = showMesh && remotePlan && focusedJob
    ? (focusedJob.source === config.mesh.nodeName ? `📤 ${focusedJob.target}` : `📥 ${focusedJob.source}`)
    : "";
  const panelPlan = showMesh ? remotePlan : taskPlan;
  const verifications = readVerifications(sessionRef.current.messages);
  const lastVerification = verifications.at(-1);
  const verificationStatus = planVerificationStatus(sessionRef.current.messages);
  const pendingCount = pendingInputs.length;
  const hasActivity = streamBlocks.length > 0 || (showMesh ? focusedActive : running);
  const meshActiveCount = meshRows.filter(({ job }) => ACTIVE_JOB_STATUS.has(job.status)).length;
  const defaultNotice = "Describe a goal, ask a question, or type / for commands.";
  const contextTokens = useMemo(() => estimateMessagesTokens(messages), [messages]);
  const contextWindow = config.contextWindow ?? 128_000;
  const contextPct = Math.max(1, Math.min(99, Math.round((contextTokens / Math.max(1, contextWindow)) * 100)));
  const inputLines = input.split("\n").length;
  // The composer owns a bounded slice of the screen: an unbounded box used to
  // push the cursor off the top of the terminal on a long paste.
  const inputMaxRows = Math.max(3, Math.min(12, Math.floor(rows / 3)));
  const inputIndent = (running ? 1 : modeLabel(mode).length) + 3;
  const inputWidth = Math.max(1, terminalSize.columns - 4 - inputIndent - (inputLines > 1 ? String(inputLines).length + 7 : 1));

  return (
    <Box flexDirection="column" height={rows} backgroundColor={theme.background}>
      <Header config={config} mode={activeMode} sessionTitle={sessionRef.current.title} mesh={mesh} />
      <Box height={1} flexShrink={0} paddingX={2} overflow="hidden">
        <Text color={showMesh ? theme.accent : theme.muted} wrap="truncate-end">
          {showMesh ? "Mesh | /mesh: Local" : "Local | /mesh: Mesh"}
          {mesh ? ` | ${meshActiveCount} active, ${meshChats.length} messages` : ""}
          {!showMesh && meshChats[0] ? ` | ${meshChats[0].from}: ${oneLine(meshChats[0].text, 60)}` : ""}
        </Text>
      </Box>
      <Box flexDirection="row" flexGrow={1} flexBasis={0} overflow="hidden">
      <Box
        flexDirection="column"
        flexGrow={1}
        flexBasis={0}
        overflow="hidden"
        paddingX={2}
        paddingBottom={1}
        justifyContent={dialog ? "flex-start" : "flex-end"}
      >
        {dialog?.type === "models" ? <SelectDialog title="Models" rows={modelRows} index={Math.min(dialog.index, Math.max(0, modelRows.length - 1))} query={dialogQuery} /> : null}
        {dialog?.type === "codex-effort" ? <SelectDialog title={`Reasoning · ${config.models.find((item) => item.id === dialog.modelId)?.name ?? "Codex"}`} rows={CODEX_EFFORTS.filter((item) => item.value !== "ultra" || config.models.find((model) => model.id === dialog.modelId)?.model !== "gpt-6-luna").map((item) => ({ key: item.value ?? "default", title: item.title, detail: item.detail }))} index={dialog.index} query="" /> : null}
        {dialog?.type === "sessions" ? <SelectDialog title="Sessions" rows={sessionRows} index={Math.min(dialog.index, Math.max(0, sessionRows.length - 1))} query={dialogQuery} activeKey={sessionRef.current.id} /> : null}
        {dialog?.type === "diff" ? <DiffDialog diff={diff} /> : null}
        {dialog?.type === "verify" ? <VerifyDialog records={verifications} gate={verificationStatus} /> : null}
        {dialog?.type === "info" ? <InfoDialog title={dialog.title ?? "结果"} content={dialog.content ?? ""} /> : null}
        {dialog?.type === "theme" ? <ThemeDialog index={dialog.index} /> : null}
        {dialog?.type === "export" ? <ExportDialog value={dialogQuery} defaultName={defaultExportFilename(config.project, sessionRef.current.id)} dest={expandExportPath(dialogQuery, config.project, sessionRef.current.id)} /> : null}
        {!dialog && !hasActivity ? showMesh
          ? <Text color={theme.dim}>No mesh activity. /mesh returns to the local conversation.</Text>
          : <Welcome config={config} mesh={mesh} /> : null}
        {/* Everything the agent produced is one chain: prose, tool calls, edits
            and notes in the order they happened, scrolled as a single list. */}
        {!dialog ? <Box ref={transcriptNode} flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden" justifyContent="flex-end">
          {visibleLines.map(line => <Box key={line.id} height={1} flexShrink={0}><TranscriptLineView line={line} /></Box>)}
        </Box> : null}
        {!dialog && !showMesh && running && livePhase ? (
          <ThinkingLine
            phase={livePhase}
            callIndex={callIndex}
            reasoning={thinkingLine}
            responding={currentStreamLine(draft)}
            status={status}
            startedAt={thinkingStartedRef.current}
            lastOutputAt={lastOutputRef.current}
            characters={thinkingChars}
          />
        ) : null}
        {/* Remote work reports the same way, so a task running on another node
            is as legible as one running here. */}
        {!dialog && showMesh && remotePhase && focusedJob ? (
          <ThinkingLine
            prefix={`${focusedJob.source === config.mesh.nodeName ? "📤" : "📥"} ${focusedJob.source === config.mesh.nodeName ? focusedJob.target : focusedJob.source}`}
            phase={{ kind: remotePhase.kind, detail: remotePhase.detail, since: Date.now() - remotePhase.stepSeconds * 1_000 }}
            callIndex={remotePhase.modelCalls}
            reasoning={remotePhase.kind === "reasoning" ? remotePhase.detail : ""}
            responding={remotePhase.kind === "responding" ? remotePhase.detail : ""}
            status={remotePhase.kind === "waiting" ? remotePhase.detail : ""}
            startedAt={focusedJob.created_at * 1_000}
            lastOutputAt={Date.now() - remotePhase.silentSeconds * 1_000}
            characters={0}
          />
        ) : null}
      </Box>
      {!dialog ? <ScrollBar window={streamView} height={scrollTrackHeight} measureRef={(node) => { barNodeRef.current = node as LayoutNode | null; }} /> : null}
      {showPlan && !dialog && (panelPlan || (showMesh ? focusedActive : running)) ? (
        <Box flexDirection="column" width={narrow ? 25 : 34} marginLeft={1} paddingX={1} borderStyle="single" borderColor={theme.border} flexShrink={0} overflow="hidden">
          <Text color={theme.accent} bold>{remotePlanOwner ? `Task plan · ${remotePlanOwner}` : "Task plan"}</Text>
          {/* A remote job's plan is rebuilt from its update_plan call, so a task
              running elsewhere shows its steps here exactly like a local one. */}
          {!panelPlan ? <Text color={theme.dim} wrap="truncate-end">Agent 正在制定计划…</Text> : null}
          {panelPlan?.plan.map((item) => <Text key={item.step} wrap="truncate-end" color={item.status === "completed" ? theme.green : item.status === "in_progress" ? theme.accent : theme.muted}>{item.status === "completed" ? "✓" : item.status === "in_progress" ? "→" : "○"} {item.step}</Text>)}
          <Text wrap="truncate-end">
            <Text color={verificationStatus.verified ? theme.green : theme.yellow} bold>{verificationStatus.verified ? "✓ 已验证" : "○ 未验证"}</Text>
            <Text color={theme.dim}>  {verifications.length} 条记录 · /verify</Text>
          </Text>
          {lastVerification
            ? <Text color={lastVerification.status === "passed" ? theme.green : theme.red} wrap="truncate-end">{lastVerification.status === "passed" ? "✓" : "✗"} {oneLine(lastVerification.command, 40)}</Text>
            : <Text color={theme.dim} wrap="truncate-end">尚无验证记录 · record_verification</Text>}
        </Box>
      ) : null}
      </Box>
      {approval ? (
        <Box flexDirection="column" backgroundColor={theme.panel} paddingX={2} paddingY={1} flexShrink={0}>
          <Text color={theme.primary} bold>Permission required · {approval.tool.risk}</Text>
          <Text><Text color={theme.accent}>{toolLabel(approval.tool.name)}</Text><Text color={theme.muted}>  {summarizeToolArgs(approval.tool.name, approval.args)}</Text></Text>
          {typeof approval.args.path === "string" ? <Text color={theme.dim} wrap="truncate-end">path · {String(approval.args.path).slice(0, 100)}</Text> : null}
          {typeof approval.args.old_text === "string" || typeof approval.args.new_text === "string" || typeof approval.args.content === "string" ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.dim}>preview · 红删绿增（最多 6 行）</Text>
              {String(approval.args.old_text ?? "").split("\n").slice(0, 3).filter(Boolean).map((line, index) => <Text key={`del-${index}`} color={theme.red} wrap="truncate-end">− {line.slice(0, 100)}</Text>)}
              {String(approval.args.new_text ?? approval.args.content ?? "").split("\n").slice(0, 3).filter(Boolean).map((line, index) => <Text key={`add-${index}`} color={theme.green} wrap="truncate-end">+ {line.slice(0, 100)}</Text>)}
            </Box>
          ) : null}
          <Text>
            <Text color={theme.primary}>y</Text><Text color={theme.muted}> 允许一次   </Text>
            <Text color={theme.primary}>t</Text><Text color={theme.muted}> 本任务信任该工具   </Text>
            <Text color={theme.primary}>a</Text><Text color={theme.accent}> 本次会话不再询问</Text><Text color={theme.muted}>   </Text>
            <Text color={theme.primary}>n</Text><Text color={theme.muted}> 拒绝</Text>
          </Text>
        </Box>
      ) : null}
      {!dialog && showHelp ? <HelpPanel /> : null}
      {!dialog && !approval && !showHelp ? <CommandHints input={input} index={commandIndex} /> : null}
      {!dialog ? <AtHints input={input} files={workspaceFiles} /> : null}
      <Box flexDirection="column" backgroundColor={theme.panel} flexShrink={0}>
        <Box backgroundColor={theme.element} paddingX={2} paddingY={1} alignItems="flex-start">
          {running ? <Spinner color={modeColor(mode)} /> : <Text color={modeColor(mode)} bold>{modeLabel(mode)}</Text>}
          <Text color={!dialog && !approval && !showHelp ? theme.accent : theme.dim}>{!dialog && !approval && !showHelp ? " ❯ " : " · "}</Text>
          <TextArea
            value={input}
            onChange={(value) => { setInput(stripMouseReports(value)); setHistoryIndex(null); setCommandIndex(0); }}
            onSubmit={(value) => { void submit(value); }}
            focus={!dialog && !approval && !showHelp}
            placeholder={running ? "补充指令 / /queue 排队 / 只读命令即时执行（/status /models…）· Esc 中断" : "Message luban…（Ctrl+J 换行 · @ 文件 · / 命令）"}
            width={inputWidth}
            maxRows={inputMaxRows}
            mouseGuard={mouseGuardRef.current}
            caret={caretRequest}
            measureRef={(node) => { inputNodeRef.current = node as LayoutNode | null; }}
          />
          {inputLines > 1 ? <Text color={theme.dim}>  ⏎ {inputLines}行</Text> : null}
        </Box>
        <Box justifyContent="space-between" paddingX={2} height={1} overflow="hidden">
          <Box flexGrow={1} overflow="hidden">
            <Text color={theme.dim} wrap="truncate-end">
              {`${config.model.name}  ${usage.input}↑ ${usage.output}↓ · ctx ${contextPct}%`}
              <Text color={theme.text}>  Enter 发送 · Ctrl+J 换行</Text>
              <Text>  {mouseEnabled ? "Ctrl+Y 释放鼠标复制" : "Ctrl+Y 恢复滚轮"}</Text>
              {pendingCount ? <Text color={theme.accent}>  {pendingCount} pending</Text> : null}
            </Text>
          </Box>
          {scrolledBack ? (
            <Text color={theme.accent} bold>历史 {scrollPercent(streamView)}% · PageDown 回最新</Text>
          ) : !narrow ? (
            <Text color={theme.dim}>{running ? "esc 中断 · /queue 排队 · 只读命令即时执行" : "shift+tab 模式 · ctrl+p 模型 · /copy 复制"}</Text>
          ) : null}
        </Box>
        {notice !== defaultNotice ? (
          /* Command feedback gets a row of its own: appended behind the tips it
             was pushed off the edge on any narrow terminal, which made a command
             like `/theme nord` look as if it had done nothing. */
          <Box paddingX={2} height={1} overflow="hidden" flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color={theme.accent} bold>▸ </Text>
              <Text color={theme.muted}>{notice}</Text>
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
