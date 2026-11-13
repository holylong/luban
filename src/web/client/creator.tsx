import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseSchedule } from "../../core/bot-schedule";
import { clock, dayClock, everyLabel, nextRunLabel, scheduleLabel } from "./creator-schedule";
import { Markdown } from "./markdown";
import "./creator.css";

/* 造物主 — a resident assistant, not a workbench.
 *
 * Layout follows the WorkBuddy reference: a quiet left rail that owns the queue,
 * and one centred content column (hero → quick prompts → composer → suggestions)
 * on the right. The window only renders one durable queue and can enqueue, cancel
 * and read it; everything else belongs to the worker process and `luban bot`, so
 * this page can be reloaded at any time without disturbing a running task.
 *
 * Scheduling is the point of the app: every task shows the schedule it was booked
 * with, when it will fire next, and — through the 计划 drawer — every execution it
 * has already had, because "did the 6:00 scan run and what did it find" is the
 * question this window exists to answer. */

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

interface CreatorBridge {
  snapshot(): Promise<CreatorSnapshot>;
  add(input: { prompt: string; workspace?: string; at?: number; every?: number }): Promise<{ id?: string; snapshot: CreatorSnapshot }>;
  cancel(id: string): Promise<CreatorSnapshot>;
  runs(id: string, limit?: number): Promise<CreatorRun[]>;
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

/** Quick prompts — the reference's chip row, but each one is a real dispatchable job. */
const QUICK = [
  "写今天的日报",
  "查 CI 最近的失败",
  "分析错误日志",
  "整理拖太久的待办",
];

/** Suggestion pills under the composer: longer, concrete jobs, most of them scheduled. */
const SUGGESTIONS = [
  "每晚 23:00 汇总今天的工作区改动，写成日报",
  "每 6 小时扫一次 buglist，能复现的整理成清单",
  "每天 6 点提醒我今天要做什么",
  "5 分钟后提醒我下班",
];

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
            <span>{scheduleLabel(task)}</span>
            <span>{meta(task, now)}</span>
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
            <span>超时 {Math.round(task.timeout / 60_000)} 分钟</span>
            {task.every ? <span>间隔 {everyLabel(task.every)}</span> : null}
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

function App(): React.ReactElement {
  const bridge = window.creator;
  const [snapshot, setSnapshot] = useState<CreatorSnapshot | undefined>();
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState<string>("");
  const [when, setWhen] = useState<"now" | "at" | "every">("now");
  const [at, setAt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"active" | "done" | "approvals">("active");
  const [plans, setPlans] = useState(false);
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
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const tasks = snapshot?.tasks ?? [];
  const active = useMemo(() => tasks.filter(task => ["queued", "running", "paused"].includes(task.status)), [tasks]);
  const done = useMemo(() => tasks.filter(task => !["queued", "running", "paused"].includes(task.status)), [tasks]);
  const blank = tasks.length === 0;
  /** A sentence like "每天 6 点提醒我" books itself; the chip shows the parse before dispatch. */
  const parsed = useMemo(() => (when === "now" ? parseSchedule(prompt) : null), [prompt, when]);

  const submit = async (): Promise<void> => {
    if (!bridge || busy || !prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const input: { prompt: string; workspace?: string; at?: number; every?: number } = { prompt: prompt.trim() };
      if (workspace.trim()) input.workspace = workspace.trim();
      if (when === "at") {
        const value = Date.parse(at);
        if (!Number.isFinite(value)) throw new Error("先选一个执行时间");
        input.at = value;
      }
      if (when === "every") {
        const value = Number(minutes);
        if (!Number.isFinite(value) || value < 1) throw new Error("间隔至少 1 分钟");
        input.every = Math.max(60, Math.round(value * 60));
      }
      if (when === "now" && parsed) {
        input.at = parsed.at;
        if (parsed.every) input.every = parsed.every;
      }
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

  const count = { active: active.length, done: done.length, approvals: snapshot?.requests.length ?? 0 };
  const worker = snapshot?.worker;
  const shown = tab === "active" ? active : tab === "done" ? done : [];
  const now = snapshot?.now ?? Date.now();

  return (
    <div className="creator">
      {/* Left rail: brand, the three views, the queue itself, worker state. */}
      <aside className="side">
        <div className="side-top">
          <div className="brand">
            <img src="./icon-192.png" alt="" />
            <span>造物主</span>
          </div>
          <button className="discover" onClick={() => { void bridge.openData(); }}>发现应用<i>⌄</i></button>
        </div>

        <button className="new-task" onClick={() => textarea.current?.focus()}>
          <PlusGlyph />新建任务
        </button>

        <nav className="side-nav">
          <button className={tab === "active" ? "on" : ""} onClick={() => setTab("active")}>
            <RingGlyph />进行中{count.active ? <b>{count.active}</b> : null}
          </button>
          <button className={tab === "done" ? "on" : ""} onClick={() => setTab("done")}>
            <CheckGlyph />结果{count.done ? <b>{count.done}</b> : null}
          </button>
          <button className={tab === "approvals" ? "on" : ""} onClick={() => setTab("approvals")}>
            <ShieldGlyph />授权{count.approvals ? <b className="warn">{count.approvals}</b> : null}
          </button>
          <button className={plans ? "on" : ""} onClick={() => setPlans(value => !value)}>
            <ClockGlyph />计划{tasks.length ? <b>{tasks.length}</b> : null}
          </button>
          <button onClick={() => { void bridge.openPolicy(); }}>
            <FileGlyph />权限策略
          </button>
        </nav>

        <div className="side-label">任务（{tasks.length}）</div>
        <div className="side-list">
          {tasks.length ? tasks.map(task => (
            <button key={task.id} className={`side-task ${task.status}`} onClick={() => { setTab(["queued", "running", "paused"].includes(task.status) ? "active" : "done"); }}>
              <span className={`dot ${task.status}`} />
              <span className="title">{task.prompt}</span>
              <span className="when">{task.every ? clock(task.at) : dayClock(task.at)}</span>
            </button>
          )) : <p className="side-empty">暂无任务</p>}
        </div>

        <div className="side-label">空间（{workspace ? 1 : 0}）</div>
        <div className="side-space" onClick={async () => { const picked = await bridge.pickWorkspace(); if (picked) setWorkspace(picked); }}>
          <FolderGlyph />
          <span>{workspace ? workspace.split("/").slice(-1)[0] : "选择工作空间"}</span>
        </div>

        <div className="side-foot">
          <button className={`worker ${worker?.running ? (worker.task ? "busy" : "idle") : "off"}`} onClick={() => { void startWorker(); }}>
            <span className="dot" />
            {worker?.running ? (worker.task ? "后台忙" : "后台待命") : worker?.launchAgent ? "后台由系统托管" : "后台未启动"}
          </button>
          <div className="side-user">
            <span className="avatar">造</span>
            <span className="name">luban</span>
            <button className="ghost-icon" title="收起窗口" onClick={() => { void bridge.hide(); }}>⌄</button>
          </div>
        </div>
      </aside>

      {/* Right column: one centred pane, exactly like the reference. */}
      <main className="main">
        <div className={`pane${blank ? "" : " compact"}`}>
          {blank ? (
            <header className="hero">
              <h1>造物主，我帮你</h1>
              <div className="segmented">
                {["办公", "开发", "设计"].map((label, index) => (
                  <button key={label} className={index === 0 ? "on" : ""} onClick={() => { setPrompt(SUGGESTIONS[index + 1] ?? ""); textarea.current?.focus(); }}>{label}</button>
                ))}
              </div>
            </header>
          ) : null}

          {blank ? (
            <div className="quick">
              {QUICK.map(text => (
                <button key={text} onClick={() => { setPrompt(text); textarea.current?.focus(); }}>{text}</button>
              ))}
            </div>
          ) : null}

          <section className="composer">
            <textarea
              ref={textarea}
              value={prompt}
              rows={blank ? 3 : 2}
              placeholder="今天帮你做些什么？ 说「每天 6 点提醒我」也能直接排期"
              onChange={event => setPrompt(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
              }}
            />
            <div className="composer-row">
              <button className="round" title="选择工作区" onClick={async () => { const picked = await bridge.pickWorkspace(); if (picked) setWorkspace(picked); }}><PlusGlyph /></button>
              <select className="when" value={when} onChange={event => setWhen(event.target.value as "now" | "at" | "every")}>
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
              {prompt.trim() ? <span className="enter-hint">⏎</span> : null}
              <button className="send" disabled={busy || !prompt.trim()} title="派发（Enter）" onClick={() => { void submit(); }}>
                {busy ? "…" : <ArrowGlyph />}
              </button>
            </div>
          </section>

          <div className="composer-meta">
            {parsed ? (
              <span className="parsed" title="从这句话里识别到的排期">
                <ClockGlyph />{parsed.label} · 首次 {dayClock(parsed.at)}
              </span>
            ) : null}
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

          {!blank ? (
            <section className="queue">
              <div className="queue-head">
                <span>{tab === "active" ? "进行中" : tab === "done" ? "结果" : "授权"}</span>
                <span className="count">{tab === "approvals" ? count.approvals : shown.length || "0"}</span>
              </div>
              {tab === "approvals" ? (
                snapshot?.requests.length ? (
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
                ) : <p className="hint">没有待授权的调用。</p>
              ) : shown.length ? (
                shown.map(task => (
                  <TaskRow key={task.id} task={task} now={now}
                    onCancel={id => { if (bridge) void bridge.cancel(id).then(setSnapshot); }} />
                ))
              ) : (
                <p className="hint">{tab === "active" ? "没有在跑的任务。写一句要它做的事，派发后它会在后台执行。" : "还没有结果。跑完的任务会带着结论出现在这里。"}</p>
              )}
            </section>
          ) : null}

          <p className="disclaimer">内容由 AI 生成，请核实重要信息</p>
        </div>
      </main>

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
function RingGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="1.6" fill="currentColor" /></svg>;
}
function CheckGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.4 8.6l3 3 6-6.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
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
function ArrowGlyph(): React.ReactElement {
  return <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 12.4V4M4.3 7.4L8 3.7l3.7 3.7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
