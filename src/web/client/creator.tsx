import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "./markdown";
import "./creator.css";

/* 造物主 — a resident assistant, not a workbench.
 *
 * The window only renders one durable queue and can enqueue, cancel and read it.
 * Everything else (running the agent, approving tools, session history) belongs
 * to the worker process and `luban bot`, so this page can be reloaded at any time
 * without disturbing a running task. */

export interface CreatorTask {
  id: string;
  prompt: string;
  workspace: string;
  model?: string;
  at: number;
  every?: number;
  timeout: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "paused";
  nextAt?: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  usage?: { input: number; output: number; calls: number };
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

interface CreatorBridge {
  snapshot(): Promise<CreatorSnapshot>;
  add(input: { prompt: string; workspace?: string; at?: number; every?: number }): Promise<{ id?: string; snapshot: CreatorSnapshot }>;
  cancel(id: string): Promise<CreatorSnapshot>;
  startWorker(): Promise<{ started: boolean; reason: string; snapshot: CreatorSnapshot }>;
  pickWorkspace(): Promise<string | undefined>;
  openPolicy(): Promise<{ ok: boolean }>;
  openData(): Promise<{ ok: boolean }>;
  hide(): Promise<{ ok: boolean }>;
}

declare global {
  interface Window { creator?: CreatorBridge }
}

const STATUS_LABEL: Record<CreatorTask["status"], string> = {
  queued: "排队中", running: "执行中", completed: "已完成", failed: "失败",
  cancelled: "已取消", interrupted: "被中断", paused: "已暂停",
};

function clock(at?: number): string {
  if (!at) return "";
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayClock(at?: number): string {
  if (!at) return "";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? `今天 ${clock(at)}` : `${date.getMonth() + 1}/${date.getDate()} ${clock(at)}`;
}

function ago(at?: number, now = Date.now()): string {
  if (!at) return "";
  const delta = Math.max(0, Math.round((now - at) / 1000));
  if (delta < 60) return `${delta} 秒前`;
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86_400)} 天前`;
}

function everyLabel(ms?: number): string {
  if (!ms) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function meta(task: CreatorTask, now: number): string {
  const repeat = everyLabel(task.every);
  if (task.status === "running") return `${repeat ? `${repeat} · ` : ""}开始于 ${clock(task.startedAt)}`;
  if (task.status === "completed" || task.status === "failed") return `${repeat ? `${repeat} · ` : ""}${ago(task.finishedAt, now)}完成`;
  if (task.status === "queued") return `${repeat ? `${repeat} · ` : ""}${task.at > now ? `${dayClock(task.at)} 执行` : "马上执行"}`;
  if (task.status === "interrupted") return "worker 中断了这次执行，副作用需要人工确认";
  return STATUS_LABEL[task.status];
}

function Pill({ snapshot, onStart }: { snapshot: CreatorSnapshot; onStart: () => void }): React.ReactElement {
  const { worker } = snapshot;
  const busy = Boolean(worker.task);
  const label = worker.running ? (busy ? "后台忙" : "后台待命") : worker.launchAgent ? "后台由系统托管" : "后台未启动";
  return (
    <button className={`worker-pill ${worker.running ? (busy ? "busy" : "idle") : "off"}`} onClick={onStart} title={worker.running ? `worker PID ${worker.pid ?? "?"}` : "点击启动后台 worker"}>
      <span className="dot" />
      <span>{label}</span>
      {worker.stalled ? <span className="warn">心跳停了</span> : null}
    </button>
  );
}

function TaskRow({ task, now, onCancel }: { task: CreatorTask; now: number; onCancel: (id: string) => void }): React.ReactElement {
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
            <span>{meta(task, now)}</span>
            <span className="path">{task.workspace.split("/").slice(-1)[0]}</span>
          </p>
        </div>
        {active ? <button className="ghost" onClick={event => { event.stopPropagation(); onCancel(task.id); }}>取消</button> : null}
        {canOpen ? <span className="chev">{open ? "▾" : "▸"}</span> : null}
      </header>
      {open && task.result ? <div className="task-result"><Markdown text={task.result} /></div> : null}
    </article>
  );
}

function App(): React.ReactElement {
  const bridge = window.creator;
  const [snapshot, setSnapshot] = useState<CreatorSnapshot | undefined>();
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState<string>("");
  const [when, setWhen] = useState<"now" | "at" | "every">("now");
  const [at, setAt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"active" | "done" | "approvals">("active");
  const textarea = useRef<HTMLTextAreaElement>(null);

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
  useEffect(() => {
    if (snapshot && !workspace) setWorkspace(snapshot.tasks[0]?.workspace || "");
  }, [snapshot, workspace]);

  const tasks = snapshot?.tasks ?? [];
  const active = useMemo(() => tasks.filter(task => task.status === "queued" || task.status === "running" || task.status === "paused"), [tasks]);
  const done = useMemo(() => tasks.filter(task => !["queued", "running", "paused"].includes(task.status)), [tasks]);

  const submit = async (): Promise<void> => {
    if (!bridge || busy || !prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const input: { prompt: string; workspace?: string; at?: number; every?: number } = { prompt: prompt.trim() };
      if (workspace.trim()) input.workspace = workspace.trim();
      if (when === "at") {
        const at_ = Date.parse(at);
        if (!Number.isFinite(at_)) throw new Error("先选一个执行时间");
        input.at = at_;
      }
      if (when === "every") {
        const value = Number(minutes);
        if (!Number.isFinite(value) || value < 1) throw new Error("间隔至少 1 分钟");
        input.every = Math.max(60, Math.round(value * 60));
      }
      const result = await bridge.add(input);
      setSnapshot(result.snapshot);
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
      if (!result.started && result.reason === "launch-agent") setError("后台由 LaunchAgent 托管，无需手动启动");
    } catch (cause) { setError(String((cause as Error).message || cause)); }
  };

  if (!bridge) {
    return (
      <div className="creator empty-bridge">
        <h1>造物主</h1>
        <p>这是桌面端的界面。用 <code>npm run creator</code> 打开它。</p>
      </div>
    );
  }

  return (
    <div className="creator">
      <header className="bar">
        <div className="brand">造物主</div>
        {snapshot ? <Pill snapshot={snapshot} onStart={() => { void startWorker(); }} /> : null}
        <span className="spacer" />
        <button className="icon" title="打开任务数据目录" onClick={() => { void bridge.openData(); }}>⌂</button>
      </header>

      <section className="compose">
        <textarea
          ref={textarea}
          value={prompt}
          rows={3}
          placeholder="让造物主做什么？（Enter 派发 · Shift+Enter 换行）"
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
          }}
        />
        <div className="compose-row">
          <button className="chip path" title={workspace || "默认用户目录"} onClick={async () => { const picked = await bridge.pickWorkspace(); if (picked) setWorkspace(picked); }}>
            {workspace ? workspace.split("/").slice(-1)[0] : "选择工作区"}
          </button>
          <select value={when} onChange={event => setWhen(event.target.value as "now" | "at" | "every")}>
            <option value="now">现在</option>
            <option value="at">定时</option>
            <option value="every">每隔</option>
          </select>
          {when === "at" ? <input type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /> : null}
          {when === "every" ? (
            <>
              <input className="num" type="number" min={1} value={minutes} onChange={event => setMinutes(event.target.value)} />
              <span className="unit">分钟</span>
            </>
          ) : null}
          <span className="spacer" />
          <button className="send" disabled={busy || !prompt.trim()} onClick={() => { void submit(); }}>{busy ? "派发中" : "派发"}</button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </section>

      <nav className="tabs">
        <button className={tab === "active" ? "on" : ""} onClick={() => setTab("active")}>进行中 {active.length ? <b>{active.length}</b> : null}</button>
        <button className={tab === "done" ? "on" : ""} onClick={() => setTab("done")}>结果 {done.length ? <b>{done.length}</b> : null}</button>
        <button className={tab === "approvals" ? "on" : ""} onClick={() => setTab("approvals")}>授权 {snapshot?.requests.length ? <b className="warn">{snapshot.requests.length}</b> : null}</button>
      </nav>

      <main className="list">
        {tab === "active" ? (active.length
          ? active.map(task => <TaskRow key={task.id} task={task} now={snapshot?.now ?? Date.now()} onCancel={id => { void bridge.cancel(id).then(setSnapshot); }} />)
          : <p className="hint">没有在跑的任务。写下要它做的事，派发后它会在后台执行。</p>) : null}
        {tab === "done" ? (done.length
          ? done.map(task => <TaskRow key={task.id} task={task} now={snapshot?.now ?? Date.now()} onCancel={() => undefined} />)
          : <p className="hint">还没有结果。</p>) : null}
        {tab === "approvals" ? (
          snapshot?.requests.length ? (
            <>
              <p className="hint">无人值守时不会自动放行任何工具。需要授权的调用会记在这里，授权要你手动写进 permissions.json。</p>
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
          ) : <p className="hint">没有待授权的调用。</p>
        ) : null}
      </main>

      <footer className="foot">
        <span>{snapshot ? `队列 ${snapshot.home}/bot` : "读取中…"}</span>
        <button className="link" onClick={() => { void bridge.hide(); }}>收起</button>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
