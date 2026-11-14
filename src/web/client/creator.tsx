import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DriveEvent } from "../../core/drive-events";
import { clock, dayClock, nextRunLabel, scheduleLabel } from "./creator-schedule";
import { Markdown } from "./markdown";
import "./creator.css";

/* 造物主 — 说一句话，AI 就替你操作电脑。
 *
 * This window is two things on one rail, in that order of importance:
 *
 *  操控 (default)  a conversation with a model that can see the screen and click.
 *                 Every action it takes is announced as a line ("点击 720,430"),
 *                 anything that changes the screen waits for 允许/拒绝, and 停止
 *                 kills the child process mid-turn.
 *  任务记录       the durable queue in ~/.luban/bot: scheduled scans, reminders,
 *                 nightly reports, and what each run concluded. Unattended,
 *                 deny-by-default, survives restarts. It is called 任务记录 and
 *                 not 后台 because 「后台」 read as a hidden process rather than a
 *                 list a person can open, read and re-run.
 *
 * They are deliberately separate processes: a job that scans GitLab every hour
 * must not be able to click, and a click must not need a queue task to exist. */

export interface CreatorTask {
  id: string;
  prompt: string;
  workspace: string;
  model?: string;
  at: number;
  every?: number;
  /** `notify` tasks only show a desktop notification; they never call a model. */
  kind?: "agent" | "notify";
  timeout: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "paused";
  nextAt?: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  usage?: { input: number; output: number; calls: number };
  /** Finished executions recorded in runs.jsonl. */
  runs?: number;
}

/** One row of runs.jsonl, written by the worker in src/core/bot.ts. */
export interface CreatorRun {
  from: number;
  to: number;
  status: CreatorTask["status"];
  nextAt: number;
  usage?: { input: number; output: number; calls: number };
  result?: string;
}

export interface CreatorSnapshot {
  home: string;
  policy: string;
  data: string;
  now: number;
  worker: { running: boolean; pid?: number; task?: { prompt: string; startedAt: number }; heartbeat?: number; stalled?: boolean; launchAgent?: boolean };
  tasks: CreatorTask[];
  requests: Array<{ id: string; taskId: string; workspace: string; tool: string; args: Record<string, unknown>; reason: string; createdAt: string }>;
}

/** One project's memory, as `luban memory --json` reports it. */
export interface CreatorMemory {
  project: string;
  workspace: string;
  file: string;
  facts: Array<{ at: number; text: string }>;
  runs: Array<{ at: number; text: string }>;
}

export interface DriveComputer {
  supported?: boolean;
  enabled?: boolean;
  accessibility?: boolean;
  postEvent?: boolean;
  screenRecording?: boolean;
  note?: string;
}

/**
 * The switch to show on open. The child reports `enabled:false` until it is
 * started, so while it is not ready the human's persisted choice wins — a merge
 * that put `enabled` first read as "操控 lost" after every relaunch.
 */
export function restoredComputer(state: { ready?: boolean; computer?: DriveComputer; settings?: CreatorSettings }): DriveComputer {
  const child = state.computer ?? {};
  if (state.ready) return child;
  return { ...child, enabled: state.settings?.computer === true };
}

/** creator.json in the app's home: the 操控 switch and the standing 允许 list. */
export interface CreatorSettings {
  computer: boolean;
  allowed: string[];
}

/** A finished action, plus the inlined thumbnail the main process adds. */
export interface ToolResultFrame {
  type: "tool-result";
  id: string;
  name: string;
  ok: boolean;
  elapsedMs: number;
  preview: string;
  screenshot?: string;
  image?: string;
}

/** Events the control child sends us: DriveEvent, with the two local variants. */
export type DriveFrame =
  | Exclude<DriveEvent, { type: "tool-result" }>
  | ToolResultFrame
  | { type: "exit"; code?: number | null; signal?: string };

interface CreatorBridge {
  snapshot(): Promise<CreatorSnapshot>;
  add(input: { prompt: string; workspace?: string; at?: number; every?: number; remind?: boolean }): Promise<{ id?: string; snapshot: CreatorSnapshot }>;
  cancel(id: string): Promise<CreatorSnapshot>;
  runs(id: string, limit?: number): Promise<CreatorRun[]>;
  startWorker(): Promise<{ started: boolean; reason: string; snapshot: CreatorSnapshot }>;
  pickWorkspace(): Promise<string | undefined>;
  openPolicy(): Promise<{ ok: boolean }>;
  openData(): Promise<{ ok: boolean }>;
  hide(): Promise<{ ok: boolean }>;
  settings(): Promise<CreatorSettings>;
  drive(): Promise<{ running: boolean; ready: boolean; computer: DriveComputer; events: DriveFrame[]; error: string; settings: CreatorSettings; log: string }>;
  driveStart(input: { workspace?: string; computer?: boolean; model?: string }): Promise<{ running: boolean; ready: boolean; computer: DriveComputer; events: DriveFrame[]; error: string }>;
  driveStop(): Promise<unknown>;
  driveSay(text: string): Promise<{ sent: boolean }>;
  driveApprove(id: string, allow: boolean): Promise<boolean>;
  setComputer(on: boolean): Promise<CreatorSettings>;
  forgetApprovals(): Promise<CreatorSettings>;
  memory(): Promise<CreatorMemory[]>;
  clearMemory(workspace: string): Promise<CreatorMemory[]>;
  onSettings(handler: (settings: CreatorSettings) => void): () => void;
  onDrive(handler: (event: DriveFrame) => void): () => void;
  onDriveLog(handler: (line: string) => void): () => void;
}

declare global {
  interface Window { creator?: CreatorBridge }
}

const STATUS_LABEL: Record<CreatorTask["status"], string> = {
  queued: "排队中", running: "执行中", completed: "已完成", failed: "失败",
  cancelled: "已取消", interrupted: "被中断", paused: "已暂停",
};

/** Quick prompts for the control mode: each one is something a computer can do. */
const QUICK = [
  "打开计算器并截图",
  "把屏幕上的这段文字复制到备忘录",
  "帮我点开浏览器，搜索今天的天气",
  "整理桌面上的截图到一个文件夹",
];

/** Suggestion pills under the composer: longer, concrete jobs. */
const SUGGESTIONS = [
  "打开计算器，输入 12×34，把结果截图给我",
  "在系统设置里把深色模式关掉",
  "打开 Finder，把下载目录里超过 30 天的文件列出来",
  "截一张当前屏幕，告诉我这个窗口是什么应用",
];

const MINUTE = 60_000;
/** How many journal lines the drawer shows per project; the file keeps 40. */
const MEMORY_RUNS_SHOWN = 5;

function ago(at?: number, now = Date.now()): string {
  if (!at) return "";
  const delta = Math.max(0, Math.round((now - at) / 1000));
  if (delta < 60) return `${delta} 秒前`;
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86_400)} 天前`;
}

/** Third column of a row. The schedule itself is scheduleLabel's job, so this never
 * repeats the interval — "每天 23:00" beside "每 24 小时" read as two bookings. */
function meta(task: CreatorTask, now: number): string {
  if (task.status === "running") return `开始于 ${clock(task.startedAt)}`;
  if (task.status === "completed" || task.status === "failed") return `${ago(task.finishedAt, now)}完成`;
  if (task.status === "queued") return task.at > now ? `${dayClock(task.at)} 执行` : "马上执行";
  if (task.status === "interrupted") return "worker 中断了这次执行，副作用需要人工确认";
  return STATUS_LABEL[task.status];
}

/* The transcript -------------------------------------------------------- */

export type Item =
  | { kind: "you"; text: string; at: number }
  | { kind: "reply"; text: string; at: number; open?: boolean }
  | { kind: "action"; id: string; label: string; name: string; ok?: boolean; elapsedMs?: number; preview?: string; image?: string; at: number }
  | { kind: "ask"; id: string; label: string; reason: string; settled?: boolean; allow?: boolean; at: number }
  | { kind: "note"; text: string; tone: "status" | "error"; at: number };

/**
 * Fold the event stream into the timeline a person reads: what they said, what
 * the model answered, and — between those — every action it took, in order.
 * Pure and cheap enough to recompute per frame; no incremental bookkeeping to
 * get out of step with the stream.
 */
export function timeline(frames: DriveFrame[], fallback = Date.now()): Item[] {
  const items: Item[] = [];
  const actions = new Map<string, Extract<Item, { kind: "action" }>>();
  const asks = new Map<string, Extract<Item, { kind: "ask" }>>();
  let reply: Extract<Item, { kind: "reply" }> | undefined;
  for (const frame of frames) {
    if (frame.type === "turn-start") {
      items.push({ kind: "you", text: frame.text, at: fallback });
      reply = { kind: "reply", text: "", at: fallback, open: true };
      items.push(reply);
      continue;
    }
    if (frame.type === "text") {
      if (!reply) { reply = { kind: "reply", text: "", at: fallback, open: true }; items.push(reply); }
      reply.text += frame.text;
      continue;
    }
    if (frame.type === "turn-end") {
      if (reply) {
        reply.open = false;
        if (!reply.text.trim() && frame.text.trim()) reply.text = frame.text;
      } else if (frame.text.trim()) {
        items.push({ kind: "reply", text: frame.text, at: fallback });
      }
      if (!frame.ok) items.push({ kind: "note", text: frame.stopReason === "max_steps" ? "达到步数上限，先停在这里" : "这一轮没有正常结束", tone: "error", at: fallback });
      reply = undefined;
      continue;
    }
    if (frame.type === "tool") {
      const item: Extract<Item, { kind: "action" }> = { kind: "action", id: frame.id, label: frame.label, name: frame.name, at: fallback };
      actions.set(frame.id, item);
      items.push(item);
      continue;
    }
    if (frame.type === "tool-result") {
      const item = actions.get(frame.id);
      if (item) {
        item.ok = frame.ok;
        item.elapsedMs = frame.elapsedMs;
        item.preview = frame.preview;
        item.image = frame.image;
      } else {
        items.push({ kind: "action", id: frame.id, name: frame.name, label: frame.name, ok: frame.ok, elapsedMs: frame.elapsedMs, preview: frame.preview, image: frame.image, at: fallback });
      }
      continue;
    }
    if (frame.type === "approval") {
      const item: Extract<Item, { kind: "ask" }> = { kind: "ask", id: frame.id, label: frame.label, reason: frame.reason, at: fallback };
      asks.set(frame.id, item);
      items.push(item);
      continue;
    }
    if (frame.type === "approval-settled") {
      const item = asks.get(frame.id);
      if (item) { item.settled = true; item.allow = frame.allow; }
      continue;
    }
    if (frame.type === "error") { items.push({ kind: "note", text: frame.text, tone: "error", at: fallback }); continue; }
    if (frame.type === "status") { items.push({ kind: "note", text: frame.text, tone: "status", at: fallback }); continue; }
    if (frame.type === "exit") items.push({ kind: "note", text: "操控会话已结束", tone: "status", at: fallback });
  }
  return items;
}

function ActionRow({ item }: { item: Extract<Item, { kind: "action" }> }): React.ReactElement {
  const state = item.ok === undefined ? "running" : item.ok ? "ok" : "fail";
  const isScreen = item.name === "computer";
  return (
    <div className={`act ${state}`}>
      <span className="act-mark" aria-hidden="true">{isScreen ? "▣" : "◇"}</span>
      <div className="act-main">
        <p className="act-label">
          {item.label}
          {item.elapsedMs ? <em>{item.elapsedMs < 1000 ? `${item.elapsedMs}ms` : `${(item.elapsedMs / 1000).toFixed(1)}s`}</em> : null}
        </p>
        {item.image ? <img className="act-shot" src={item.image} alt="这一步看到的屏幕" /> : null}
        {!item.image && item.ok === false && item.preview ? <pre className="act-fail">{item.preview.slice(0, 300)}</pre> : null}
      </div>
    </div>
  );
}

/** The 授权 tab's standing memory: what will not ask again, and how to forget it. */
export function RememberedApprovals({ allowed, onForget }: { allowed: string[]; onForget: () => void }): React.ReactElement | null {
  if (!allowed.length) return null;
  return (
    <article className="request" aria-label="已记住的授权">
      <p className="request-tool">已记住的授权</p>
      <p className="request-reason">{allowed.join("、")} 不再每次询问；想重新确认时清空即可。</p>
      <button className="wide" onClick={onForget}>清空已记住的授权</button>
    </article>
  );
}

function AskCard({ item, onAnswer }: { item: Extract<Item, { kind: "ask" }>; onAnswer: (allow: boolean) => void }): React.ReactElement {
  if (item.settled) {
    return (
      <div className={`ask settled ${item.allow ? "allowed" : "denied"}`}>
        <span className="ask-dot" />
        <p>{item.label} · {item.allow ? "已允许" : "已拒绝"}</p>
      </div>
    );
  }
  return (
    <div className="ask">
      <p className="ask-title">要执行：{item.label}</p>
      <p className="ask-reason">{item.reason}</p>
      <div className="ask-actions">
        <button className="allow" onClick={() => onAnswer(true)}>允许</button>
        <button className="deny" onClick={() => onAnswer(false)}>拒绝</button>
      </div>
    </div>
  );
}

function DrivePane({
  items, computer, running, ready, model, workspace, onSay, onStop, onToggleComputer, onPickWorkspace, onOpenPolicy, onAnswer, error,
}: {
  items: Item[]; computer: DriveComputer; running: boolean; ready: boolean; model: string; workspace: string;
  onSay: (text: string) => void; onStop: () => void; onToggleComputer: (on: boolean) => void;
  onPickWorkspace: () => void; onOpenPolicy: () => void; onAnswer: (id: string, allow: boolean) => void;
  error?: string;
}): React.ReactElement {
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);

  // Follow the newest line, the way a chat does: the point of this pane is
  // watching what happens next.
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [items.length]);

  const submit = (): void => {
    const value = text.trim();
    if (!value || running) return;
    setText("");
    onSay(value);
  };

  const empty = items.length === 0;
  const permissionNote = computer.supported === false
    ? "这台机器不支持电脑操控（只有 macOS）"
    : computer.enabled
      ? (computer.accessibility && computer.screenRecording ? "可以截屏、点击、输入" : "权限不全：系统设置 › 隐私与安全性 里打开「辅助功能」与「屏幕录制」")
      : "还没打开电脑操控：现在只能聊天和读写文件";

  return (
    <div className="drive">
      <header className="drive-head">
        <div className="drive-title">
          <h1>操控电脑</h1>
          <span className={`pill ${computer.enabled ? "on" : "off"}`}><span className="dot" />{computer.enabled ? "电脑操控已开启" : "电脑操控已关闭"}</span>
          {model ? <span className="pill mute">{model}</span> : null}
        </div>
        <div className="drive-tools">
          <button className="workspace" onClick={onPickWorkspace}><FolderGlyph />{workspace ? workspace.split("/").slice(-1)[0] : "选择工作空间"}<i>⌄</i></button>
          <button className={`switch ${computer.enabled ? "on" : ""}`} onClick={() => onToggleComputer(!computer.enabled)} title="允许它动你的鼠标、键盘和屏幕">
            <span className="knob" />{computer.enabled ? "开关已开" : "打开操控"}
          </button>
          {running ? <button className="stop" onClick={onStop}>停止 <em>⌘.</em></button> : null}
        </div>
      </header>

      <div className="drive-log" ref={log}>
        {empty ? (
          <div className="drive-hero">
            <h2>说一句话，我来动手</h2>
            <p>{permissionNote}</p>
            <div className="drive-quick">
              {QUICK.map(example => (
                <button key={example} onClick={() => setText(example)}>{example}</button>
              ))}
            </div>
          </div>
        ) : null}
        {items.map((item, index) => {
          if (item.kind === "you") return <div className="you" key={`you-${index}`}><span>{item.text}</span></div>;
          if (item.kind === "reply") {
            return item.text
              ? <div className={`reply${item.open ? " open" : ""}`} key={`reply-${index}`}><Markdown text={item.text} /></div>
              : null;
          }
          if (item.kind === "action") return <ActionRow item={item} key={`act-${item.id}-${index}`} />;
          if (item.kind === "ask") return <AskCard item={item} key={`ask-${item.id}`} onAnswer={allow => onAnswer(item.id, allow)} />;
          return <p className={`note ${item.tone}`} key={`note-${index}`}>{item.text}</p>;
        })}
      </div>

      <div className="drive-composer">
        {error ? <p className="error">{error}</p> : null}
        <textarea
          value={text}
          rows={2}
          placeholder={running ? "它正在操作，先停止或等这一轮结束…" : "说一句话，例如「打开计算器，把结果截图给我」"}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
            if (event.key === "." && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onStop(); }
          }}
        />
        <div className="drive-row">
          <button className="ghost-chip" onClick={onOpenPolicy}><ShieldGlyph />权限策略</button>
          {!ready ? <span className="starting">正在启动会话…</span> : null}
          <span className="spacer" />
          {running ? <button className="send stop-round" title="停止" onClick={onStop}>■</button> : <button className="send" disabled={!text.trim()} onClick={submit}><ArrowGlyph /></button>}
        </div>
      </div>
    </div>
  );
}

export function TaskRow({ task, now, onCancel }: { task: CreatorTask; now: number; onCancel: (id: string) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const active = task.status === "queued" || task.status === "running";
  const canOpen = Boolean(task.result);
  return (
    <article className={`task ${task.status}${open ? " open" : ""}`}>
      <header onClick={() => canOpen && setOpen(value => !value)}>
        <span className={`dot ${task.status}`} />
        <div className="task-main">
          <p className="task-prompt">{task.prompt}</p>
          <p className="task-meta">
            <span>{STATUS_LABEL[task.status]}</span>
            <span>{scheduleLabel(task)}</span>
            <span>{meta(task, now)}</span>
            {task.kind === "notify" ? <span className="kind">提醒</span> : null}
            {task.runs ? <span>{task.runs} 次执行</span> : null}
          </p>
        </div>
        {active ? <button className="ghost" onClick={event => { event.stopPropagation(); onCancel(task.id); }}>取消</button> : null}
        {canOpen ? <span className="chev">{open ? "▴" : "▾"}</span> : null}
      </header>
      {open && task.result ? <div className="task-result"><Markdown text={task.result} /></div> : null}
    </article>
  );
}

/** Every finished execution of one task, newest first, loaded when the row is opened. */
function RunList({ task, bridge }: { task: CreatorTask; bridge: CreatorBridge }): React.ReactElement {
  const [runs, setRuns] = useState<CreatorRun[] | undefined>();
  const [openIndex, setOpenIndex] = useState<number | undefined>();
  useEffect(() => {
    let live = true;
    void bridge.runs(task.id, 30).then(rows => { if (live) setRuns(rows); }).catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [bridge, task.id, task.runs]);

  if (!runs) return <p className="run-empty">读取执行记录…</p>;
  if (!runs.length) return <p className="run-empty">还没有执行记录。第一次执行跑完后这里会逐条列出。</p>;
  return (
    <ol className="runs">
      {[...runs].reverse().map((run, index) => (
        <li key={`${run.from}-${index}`} className={run.status}>
          <button onClick={() => setOpenIndex(openIndex === index ? undefined : index)}>
            <span className={`dot ${run.status}`} />
            <span className="run-time">{dayClock(run.from)} – {clock(run.to)}</span>
            <span className="run-status">{STATUS_LABEL[run.status] ?? run.status}</span>
            {run.usage ? <span className="run-usage">{run.usage.calls} 次调用 · {run.usage.input + run.usage.output} tokens</span> : null}
          </button>
          {run.result ? (
            openIndex === index
              ? <div className="run-body"><Markdown text={run.result} /></div>
              : <p className="run-excerpt">{run.result.replace(/\s+/gu, " ").slice(0, 96)}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** The 计划 drawer: every background job, its schedule, its next fire, its history. */
function Plans({ tasks, now, bridge, onClose, onCancel }: {
  tasks: CreatorTask[]; now: number; bridge: CreatorBridge; onClose: () => void; onCancel: (id: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState<string | undefined>();
  const repeating = tasks.filter(task => task.every);
  const once = tasks.filter(task => !task.every);
  const running = tasks.filter(task => task.status === "running").length;
  const upcoming = tasks.filter(task => task.status === "queued" && (task.nextAt ?? task.at) > now).length;

  const row = (task: CreatorTask): React.ReactElement => (
    <li key={task.id} className={`plan ${task.status}`}>
      <button className="plan-head" onClick={() => setExpanded(expanded === task.id ? undefined : task.id)}>
        <span className={`dot ${task.status}`} />
        <span className="plan-main">
          <span className="plan-prompt">{task.prompt}</span>
          <span className="plan-meta">
            <b>{scheduleLabel(task)}</b>
            <span>{nextRunLabel(task, now)}</span>
            <span>{task.runs ?? 0} 次执行</span>
          </span>
        </span>
        <span className="chev">{expanded === task.id ? "▴" : "▾"}</span>
      </button>
      {expanded === task.id ? (
        <div className="plan-body">
          <p className="plan-facts">
            <span>工作区 {task.workspace}</span>
            <span>超时 {Math.round(task.timeout / MINUTE)} 分钟</span>
            {task.every ? <span>间隔 {nextRunLabel(task, now)}</span> : null}
          </p>
          {(task.status === "queued" || task.status === "running") ? (
            <button className="wide" onClick={() => onCancel(task.id)}>取消这个任务</button>
          ) : null}
          <RunList task={task} bridge={bridge} />
        </div>
      ) : null}
    </li>
  );

  return (
    <div className="drawer-wrap">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <header>
          <div>
            <h2>全部计划</h2>
            <p>{tasks.length} 条 · 循环 {repeating.length} · 一次 {once.length} · 正在跑 {running} · 待触发 {upcoming}</p>
          </div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </header>
        <div className="drawer-body">
          <div className="drawer-section">循环任务（{repeating.length}）</div>
          {repeating.length ? <ol className="plans">{repeating.map(row)}</ol> : <p className="hint">还没有循环任务。说「每天 6 点提醒我」这样一句话就会建一个。</p>}
          <div className="drawer-section">一次任务（{once.length}）</div>
          {once.length ? <ol className="plans">{once.map(row)}</ol> : <p className="hint">还没有一次性任务。说「5 分钟后提醒我下班」这样一句话就会建一个。</p>}
        </div>
      </aside>
    </div>
  );
}

/**
 * The 记忆 drawer: what a project carries from one run to the next.
 *
 * Facts are what the model chose to keep; 记录 is the automatic journal of
 * finished runs. Both are the same Markdown file, so this view never invents a
 * second store — clearing here deletes the file, and the next run starts fresh.
 */
export function Memory({ rows, onClose, onClear }: {
  rows: CreatorMemory[]; onClose: () => void; onClear: (workspace: string) => void;
}): React.ReactElement {
  const facts = rows.reduce((sum, row) => sum + row.facts.length, 0);
  const runs = rows.reduce((sum, row) => sum + row.runs.length, 0);
  return (
    <div className="drawer-wrap">
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer memory">
        <header>
          <div>
            <h2>项目记忆</h2>
            <p>{rows.length} 个项目 · 事实 {facts} · 记录 {runs}</p>
          </div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </header>
        <div className="drawer-body">
          {rows.length ? rows.map(row => (
            <article className="memory-project" key={row.workspace}>
              <p className="memory-title">{row.project}<span>{row.workspace}</span></p>
              {row.facts.length ? (
                <>
                  <div className="drawer-section">事实</div>
                  <ul className="memory-list">
                    {row.facts.map(fact => <li key={`${fact.at}-${fact.text}`}><b>{dayClock(fact.at)}</b>{fact.text}</li>)}
                  </ul>
                </>
              ) : null}
              {row.runs.length ? (
                <>
                  <div className="drawer-section">记录（最近 {Math.min(row.runs.length, MEMORY_RUNS_SHOWN)} 条）</div>
                  <ul className="memory-list">
                    {row.runs.slice(-MEMORY_RUNS_SHOWN).map(run => <li key={`${run.at}-${run.text}`}><b>{dayClock(run.at)}</b>{run.text}</li>)}
                  </ul>
                </>
              ) : null}
              {!row.facts.length && !row.runs.length ? <p className="hint">这个项目还没有记忆。</p> : null}
              <button className="wide" onClick={() => onClear(row.workspace)}>清除这个项目的记忆</button>
            </article>
          )) : <p className="hint">还没有任何记忆。任务里说「记住…」，或让它调用 remember 工具；下一次执行就会带上。</p>}
        </div>
      </aside>
    </div>
  );
}

function App(): React.ReactElement {
  const bridge = window.creator;
  const [snapshot, setSnapshot] = useState<CreatorSnapshot | undefined>();
  const [view, setView] = useState<"drive" | "queue">("drive");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState<string>("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"active" | "done" | "approvals">("active");
  const [plans, setPlans] = useState(false);
  const [memoryRows, setMemoryRows] = useState<CreatorMemory[] | undefined>();
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Control session
  const [frames, setFrames] = useState<DriveFrame[]>([]);
  const [computer, setComputer] = useState<DriveComputer>({});
  const [allowed, setAllowed] = useState<string[]>([]);
  const [driving, setDriving] = useState(false);
  const [model, setModel] = useState("");
  const [sayError, setSayError] = useState("");
  const started = useRef(false);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try { setSnapshot(await bridge.snapshot()); }
    catch (cause) { setError(String((cause as Error).message || cause)); }
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Seed the transcript from whatever the child already produced, then follow it live.
  useEffect(() => {
    if (!bridge) return;
    void bridge.drive().then(state => {
      setFrames(state.events ?? []);
      setComputer(restoredComputer(state));
      setAllowed(state.settings?.allowed ?? []);
      setDriving(state.running);
    }).catch(() => undefined);
    void bridge.settings().then(state => { setAllowed(state.allowed ?? []); }).catch(() => undefined);
    const offSettings = bridge.onSettings(state => setAllowed(state.allowed ?? []));
    const off = bridge.onDrive(event => {
      setDriving(true);
      if (event.type === "ready") {
        setComputer((event as { computer?: DriveComputer }).computer ?? {});
        setModel((event as { model?: string }).model ?? "");
      }
      if (event.type === "exit") setDriving(false);
      setFrames(previous => [...previous, event].slice(-400));
    });
    const offLog = bridge.onDriveLog(line => { if (line.startsWith("error:")) setSayError(line.slice(6).trim()); });
    return () => { off(); offLog(); offSettings(); };
  }, [bridge]);

  useEffect(() => {
    if (snapshot && !workspace) setWorkspace(snapshot.tasks[0]?.workspace || snapshot.home);
  }, [snapshot, workspace]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const tasks = snapshot?.tasks ?? [];
  const active = useMemo(() => tasks.filter(task => ["queued", "running", "paused"].includes(task.status)), [tasks]);
  const done = useMemo(() => tasks.filter(task => !["queued", "running", "paused"].includes(task.status)), [tasks]);
  const blank = tasks.length === 0;
  const items = useMemo(() => timeline(frames), [frames]);
  const running = driving && !frames.slice().reverse().some(frame => frame.type === "turn-end" || frame.type === "exit");

  const ensureSession = async (): Promise<void> => {
    if (!bridge) return;
    if (started.current) return;
    started.current = true;
    const state = await bridge.driveStart({ workspace: workspace || undefined, computer: computer.enabled === true });
    setDriving(state.running);
    if (state.computer) setComputer(state.computer);
    if (state.events?.length) setFrames(state.events);
  };

  const say = async (text: string): Promise<void> => {
    if (!bridge) return;
    setSayError("");
    try {
      await ensureSession();
      await bridge.driveSay(text);
    } catch (cause) { setSayError(String((cause as Error).message || cause)); }
  };

  const stop = async (): Promise<void> => {
    if (!bridge) return;
    await bridge.driveStop();
    started.current = false;
    setDriving(false);
    const ended: DriveFrame = { type: "exit", signal: "SIGTERM" };
    setFrames(previous => [...previous, ended].slice(-400));
  };

  const toggleComputer = async (on: boolean): Promise<void> => {
    if (!bridge) return;
    const next = await bridge.setComputer(on);
    setComputer(previous => ({ ...previous, enabled: next.computer }));
    // A switch that only applies "next time" is a lie: restart the session now.
    if (started.current) {
      await bridge.driveStop();
      started.current = false;
      setDriving(false);
      if (on) { await ensureSession(); }
    }
  };

  const forgetApprovals = async (): Promise<void> => {
    if (!bridge) return;
    const next = await bridge.forgetApprovals();
    setAllowed(next.allowed ?? []);
    // The main process stopped the session to make the reset real.
    started.current = false;
    setDriving(false);
  };

  /** Open the drawer and load what is on disk right now, not a cached list. */
  const openMemory = async (): Promise<void> => {
    if (!bridge) return;
    try { setMemoryRows(await bridge.memory()); }
    catch (cause) { setError(String((cause as Error).message || cause)); setMemoryRows([]); }
  };

  const clearMemory = async (workspace: string): Promise<void> => {
    if (!bridge) return;
    try { setMemoryRows(await bridge.clearMemory(workspace)); setNotice("已清除这个项目的记忆"); }
    catch (cause) { setError(String((cause as Error).message || cause)); }
  };

  const submit = async (): Promise<void> => {
    if (!bridge || busy || !prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      // One sentence, no form. Whether this is a reminder, a scan or a one-off
      // chore is the agent's reading of the sentence — the queue is only where
      // its `schedule` calls land, not a shape the person has to fill in first.
      const input: { prompt: string; workspace?: string } = { prompt: prompt.trim() };
      if (workspace.trim()) input.workspace = workspace.trim();
      const result = await bridge.add(input);
      setSnapshot(result.snapshot);
      const booked = result.snapshot.tasks.find(task => task.id === result.id);
      if (booked) setNotice(`已排入：${scheduleLabel(booked)} · ${nextRunLabel(booked, Date.now())}`);
      else setNotice("已排入");
      setPrompt("");
      setTab("active");
      textarea.current?.focus();
    } catch (cause) {
      setError(String((cause as Error).message || cause));
    } finally { setBusy(false); }
  };

  const startWorker = async (): Promise<void> => {
    if (!bridge) return;
    try {
      const result = await bridge.startWorker();
      setSnapshot(result.snapshot);
      if (!result.started && result.reason === "launch-agent") setError("执行器由 LaunchAgent 托管，无需手动启动");
    } catch (cause) { setError(String((cause as Error).message || cause)); }
  };

  if (!bridge) {
    return (
      <div className="creator empty-bridge">
        <h1>Creator</h1>
        <p>这是桌面端的界面。用 <code>npm run creator</code> 打开它。</p>
      </div>
    );
  }

  const count = { active: active.length, done: done.length, approvals: snapshot?.requests.length ?? 0 };
  const worker = snapshot?.worker;
  const shown = tab === "active" ? active : tab === "done" ? done : [];
  const now = snapshot?.now ?? Date.now();

  return (
    <div className="creator">
      {/* Left rail: brand, the two modes, then the queue and worker state. */}
      <aside className="side">
        <div className="side-top">
          <div className="brand">
            <img src="./creator-icon.png" alt="" />
            <span>Creator</span>
          </div>
          <button className="discover" onClick={() => { void bridge.openData(); }}>发现应用<i>⌄</i></button>
        </div>

        <button className="new-task" onClick={() => { setView("drive"); }}>
          <PlusGlyph />新建任务
        </button>

        <nav className="side-nav">
          <button data-view="drive" className={view === "drive" ? "on" : ""} onClick={() => setView("drive")}>
            <CursorGlyph />操控电脑{computer.enabled ? <b className="live">●</b> : null}
          </button>
          <button data-view="queue" className={view === "queue" ? "on" : ""} onClick={() => setView("queue")}>
            <ClockGlyph />任务记录{count.active ? <b>{count.active}</b> : null}
          </button>
          <button data-view="plans" className={plans ? "on" : ""} onClick={() => setPlans(value => !value)}>
            <ListGlyph />计划{tasks.length ? <b>{tasks.length}</b> : null}
          </button>
          <button data-view="policy" onClick={() => { void bridge.openPolicy(); }}>
            <FileGlyph />权限策略
          </button>
          <button data-view="memory" className={memoryRows ? "on" : ""} onClick={() => { void openMemory(); }}>
            <ListGlyph />记忆
          </button>
        </nav>

        <div className="side-label">最近任务（{tasks.length}）</div>
        <div className="side-list">
          {tasks.length ? tasks.map(task => (
            <button key={task.id} className={`side-task ${task.status}`} onClick={() => { setView("queue"); setTab(["queued", "running", "paused"].includes(task.status) ? "active" : "done"); }}>
              <span className={`dot ${task.status}`} />
              <span className="title">{task.prompt}</span>
              <span className="when">{task.every ? clock(task.at) : dayClock(task.at)}</span>
            </button>
          )) : <p className="side-empty">还没有任务</p>}
        </div>

        <div className="side-label">空间</div>
        <div className="side-space" onClick={async () => { const picked = await bridge.pickWorkspace(); if (picked) setWorkspace(picked); }}>
          <FolderGlyph />
          <span>{workspace ? workspace.split("/").slice(-1)[0] : "选择工作空间"}</span>
        </div>

        <div className="side-foot">
          <button className={`worker ${computer.enabled ? "busy" : worker?.running ? "idle" : "off"}`} onClick={() => { void toggleComputer(!computer.enabled); }}>
            <span className="dot" />
            {computer.enabled ? "电脑操控已开启" : "电脑操控未开启"}
          </button>
          <div className="side-user">
            <span className="avatar">造</span>
            <span className="name">luban</span>
            <button className="ghost-icon" title="收起窗口" onClick={() => { void bridge.hide(); }}>⌄</button>
          </div>
        </div>
      </aside>

      <main className={`main${view === "drive" ? " locked" : ""}`}>
        {view === "drive" ? (
          <DrivePane
            items={items}
            computer={computer}
            running={running}
            ready={driving}
            model={model}
            workspace={workspace}
            onSay={text => { void say(text); }}
            onStop={() => { void stop(); }}
            onToggleComputer={on => { void toggleComputer(on); }}
            onPickWorkspace={async () => { const picked = await bridge.pickWorkspace(); if (picked) setWorkspace(picked); }}
            onOpenPolicy={() => { void bridge.openPolicy(); }}
            onAnswer={(id, allow) => { void bridge.driveApprove(id, allow); }}
            error={sayError}
          />
        ) : (
          <div className={`pane${blank ? "" : " compact"}`}>
            {blank ? (
              <header className="hero">
                <h1>交给它，自己跑完</h1>
                <p className="hero-sub">定时扫描、日报、提醒都记在这里：排好后没人盯着也会跑，关掉窗口也不影响。</p>
              </header>
            ) : null}

            {blank ? (
              <div className="quick">
                {["每晚 23:00 汇总改动写日报", "每 6 小时扫一次 buglist", "每天早上 9 点提醒我今天的会", "5 分钟后提醒我下班"].map(text => (
                  <button key={text} onClick={() => { setPrompt(text); textarea.current?.focus(); }}>{text}</button>
                ))}
              </div>
            ) : null}

            <section className="composer">
              <textarea
                ref={textarea}
                value={prompt}
                rows={blank ? 3 : 2}
                placeholder="说一句话，它自己决定要做什么、什么时候做"
                onChange={event => setPrompt(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
                }}
              />
              <div className="composer-row">
                <button className="round" title="选择工作区" onClick={async () => { const picked = await bridge.pickWorkspace(); if (picked) setWorkspace(picked); }}><PlusGlyph /></button>
                <span className="spacer" />
                {prompt.trim() ? <span className="enter-hint">⏎</span> : null}
                <button className="send" disabled={busy || !prompt.trim()} title="派发（Enter）" onClick={() => { void submit(); }}>
                  {busy ? "…" : <ArrowGlyph />}
                </button>
              </div>
            </section>

            <div className="composer-meta">
              <button onClick={async () => { const picked = await bridge.pickWorkspace(); if (picked) setWorkspace(picked); }}>
                <FolderGlyph />{workspace ? workspace.split("/").slice(-1)[0] : "选择工作空间"}<i>⌄</i>
              </button>
              <button onClick={() => { void bridge.openPolicy(); }}><ShieldGlyph />默认权限<i>⌄</i></button>
              <button onClick={() => setPlans(true)}><ClockGlyph />计划 {tasks.length}</button>
            </div>

            {error ? <p className="error">{error}</p> : null}
            {notice ? <p className="notice">{notice}</p> : null}

            {blank ? (
              <div className="suggest">
                {SUGGESTIONS.map(text => (
                  <button key={text} onClick={() => { setPrompt(text); textarea.current?.focus(); }}>{text}<span>↗</span></button>
                ))}
              </div>
            ) : null}

            {/* A standing 允许 is memory the human must be able to see and undo, so
                the queue head (and its 授权 tab) stays even on the empty landing
                page once something has been remembered. */}
            {!blank || allowed.length ? (
              <section className="queue">
                <div className="queue-head">
                  <span>{tab === "active" ? "进行中" : tab === "done" ? "已完成" : "授权"}</span>
                  <span className="count">{tab === "approvals" ? count.approvals : shown.length || "0"}</span>
                  <span className="segmented small">
                    {([["active", "进行中"], ["done", "已完成"], ["approvals", "授权"]] as Array<["active" | "done" | "approvals", string]>).map(([key, label]) => (
                      <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>{label}</button>
                    ))}
                  </span>
                </div>
                {tab === "approvals" ? (
                  <>
                    <RememberedApprovals allowed={allowed} onForget={() => { void forgetApprovals(); }} />
                    {snapshot?.requests.length ? (
                      <>
                        {snapshot.requests.map(request => (
                          <article className="request" key={request.id}>
                            <p className="request-tool">{request.tool}</p>
                            <p className="request-reason">{request.reason}</p>
                            <pre>{JSON.stringify(request.args, null, 2)}</pre>
                            <p className="request-meta">{request.workspace} · {request.createdAt}</p>
                          </article>
                        ))}
                        <button className="wide" onClick={() => { void bridge.openPolicy(); }}>打开 permissions.json</button>
                      </>
                    ) : <p className="hint">没有待授权的调用。</p>}
                  </>
                ) : shown.length ? (
                  shown.map(task => (
                    <TaskRow key={task.id} task={task} now={now}
                      onCancel={id => { if (bridge) void bridge.cancel(id).then(setSnapshot); }} />
                  ))
                ) : (
                  <p className="hint">{tab === "active" ? "没有正在执行的任务。说一句，它会自己排好时间跑。" : "还没有完成的记录。任务跑完会把结论留在这里。"}</p>
                )}
              </section>
            ) : null}

            {!blank ? <button className="worker-inline" onClick={() => { void startWorker(); }}>
              <span className={`dot ${worker?.running ? (worker.task ? "busy" : "idle") : "off"}`} />
              {worker?.running ? (worker.task ? "执行器正在执行" : "执行器待命") : worker?.launchAgent ? "执行器由系统托管" : "执行器未启动，点这里启动"}
            </button> : null}

            <p className="disclaimer">内容由 AI 生成，请核实重要信息</p>
          </div>
        )}
      </main>

      {memoryRows ? (
        <Memory
          rows={memoryRows}
          onClose={() => setMemoryRows(undefined)}
          onClear={workspace => { void clearMemory(workspace); }}
        />
      ) : null}

      {plans ? (
        <Plans
          tasks={tasks}
          now={now}
          bridge={bridge}
          onClose={() => setPlans(false)}
          onCancel={id => { if (bridge) void bridge.cancel(id).then(setSnapshot); }}
        />
      ) : null}
    </div>
  );
}

/* Inline glyphs: 1.2px strokes at 14px keep the rail crisp without an icon font. */
function PlusGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
function ShieldGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 2.4l4.6 1.7v4.1c0 2.6-1.9 4.4-4.6 5.4-2.7-1-4.6-2.8-4.6-5.4V4.1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}
function FileGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 2.6h5l3 3v7.8H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M9 2.8v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
}
function FolderGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.9 4.4c0-.5.4-.9.9-.9h3c.3 0 .6.1.8.35l.6.75h5.9c.5 0 .9.4.9.9v6.2c0 .5-.4.9-.9.9H2.8c-.5 0-.9-.4-.9-.9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}
function ClockGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 4.8V8l2.2 1.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}
function ListGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.4h10M3 8h10M3 11.6h6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}
function CursorGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.2 2.6l6.4 6.1-3.3.5L9 12.9l-1.5.8-1.6-3.6-2.5 2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>;
}
function ArrowGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 12.4V4M4.3 7.4L8 3.7l3.7 3.7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const root = typeof document === "undefined" ? null : document.getElementById("root");
if (root) createRoot(root).render(<App />);
