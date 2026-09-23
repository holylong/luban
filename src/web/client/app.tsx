import React, { useEffect, useMemo, useRef, useState } from "react";
import { Inspector } from "./inspector";
import { Sidebar } from "./sidebar";
import { buildTimeline, Transcript } from "./transcript";
import { liveProgress, STATUS_LABELS } from "./timeline";
import { useWorkbench, type TaskMode } from "./store";

const MODE_LABELS: Record<TaskMode, string> = { edits: "Edits · 自动改文件", agent: "Agent · 每次写入确认", read: "Ask · 只读" };

/** One-second clock so the live line keeps counting while nothing streams. */
function useTick(active: boolean): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => bump(value => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
}

function Composer({ store }: { store: ReturnType<typeof useWorkbench> }): React.ReactElement {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const area = useRef<HTMLTextAreaElement>(null);
  const running = Boolean(store.job && ["queued", "pending", "working"].includes(store.job.status));
  useTick(running);
  const live = useMemo(() => liveProgress(store.events), [store.events]);

  const resize = (): void => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(190, element.scrollHeight)}px`;
  };

  const send = async (): Promise<void> => {
    const text = value.trim();
    if (!text || store.busy) return;
    setHistory(current => [text, ...current].slice(0, 50));
    setCursor(-1);
    setValue("");
    requestAnimationFrame(resize);
    await store.submit(text);
  };

  const recall = (direction: 1 | -1): void => {
    if (!history.length) return;
    const next = Math.min(history.length - 1, Math.max(-1, cursor + direction));
    setCursor(next);
    setValue(next < 0 ? "" : history[next]!);
    requestAnimationFrame(resize);
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={area}
          value={value}
          placeholder={running ? "描述后续目标，提交后会排队到当前任务之后…" : "说明目标，Agent 会读取项目、调用工具并验证结果…"}
          onChange={event => { setValue(event.target.value); resize(); }}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); return; }
            if (event.key === "ArrowUp" && !value && history.length) { event.preventDefault(); recall(1); }
            if (event.key === "ArrowDown" && cursor >= 0) { event.preventDefault(); recall(-1); }
          }}
        />
        <div className="composer-row">
          <select value={store.mode} onChange={event => store.setMode(event.target.value as TaskMode)} title="权限模式">
            {(Object.keys(MODE_LABELS) as TaskMode[]).map(key => <option key={key} value={key}>{MODE_LABELS[key]}</option>)}
          </select>
          <select value={store.project} onChange={event => store.setProject(event.target.value)} title="工作区">
            {Object.keys(store.node?.projects ?? {}).length === 0 && <option value="">default workspace</option>}
            {Object.entries(store.node?.projects ?? {}).map(([name, path]) => (
              <option key={name} value={name}>{name} · {path.split(/[\\/]/u).pop()}</option>
            ))}
          </select>
          <span className="hint">Enter 执行 · Shift+Enter 换行 · ↑ 历史</span>
          {running && <button className="stop" onClick={() => void store.cancel()}>停止任务</button>}
          <button className="send" onClick={() => void send()} disabled={!value.trim() || store.busy} title="提交">↑</button>
        </div>
      </div>
      {running && (
        <div className={`queue-note${live?.stalled ? " stalled" : ""}`}>
          <span className={`dot ${live?.stalled ? "stalled" : "working"}`} />
          {live
            ? `${live.label}${live.detail ? ` · ${live.detail}` : ""} · ${live.stalled ? `已 ${live.silentSeconds}s 无输出` : `本步 ${live.seconds}s`}`
            : "当前任务执行中"}
          ，新消息会在其结束后按顺序执行
        </div>
      )}
    </div>
  );
}

function TopBar({ store }: { store: ReturnType<typeof useWorkbench> }): React.ReactElement {
  const status = store.job?.status;
  const tone = status === "failed" || status === "cancelled" ? "bad" : status === "done" ? "ok" : status === "paused" ? "warn" : "";
  return (
    <header className="top">
      <span className="title">{store.job ? (store.job.title || store.job.id) : "New agent task"}</span>
      <div className="pills">
        {status && <span className={`pill ${tone}`}>{STATUS_LABELS[status] ?? status}</span>}
        {store.job?.interactive && <span className="pill warn" title="工具审批会在此页面等待你的决定">交互审批</span>}
        <span className="pill">{store.mode}</span>
        <span className="pill">{store.node?.model ?? "model"}</span>
        <span className={`pill ${store.live ? "ok" : store.connected ? "warn" : "bad"}`} title={store.live ? "事件流已连接" : "事件流断开，使用轮询"}>
          {store.live ? "live" : store.connected ? "polling" : "offline"}
        </span>
      </div>
    </header>
  );
}

function Toasts({ store }: { store: ReturnType<typeof useWorkbench> }): React.ReactElement {
  return (
    <div className="toast">
      {store.toasts.map(toast => (
        <div key={toast.id} className={`toast-item ${toast.error ? "error" : ""}`} onClick={() => store.dismiss(toast.id)}>{toast.text}</div>
      ))}
    </div>
  );
}

export function App(): React.ReactElement {
  const store = useWorkbench();
  const timeline = useMemo(() => buildTimeline(store.job, store.events), [store.job, store.events]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); store.startNew(); }
      if (event.key === "Escape" && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  return (
    <div className="app">
      <Sidebar store={store} />
      <main className="workspace">
        <TopBar store={store} />
        <Transcript job={store.job} events={timeline} onCancel={() => void store.cancel()} onResume={() => void store.resume()} />
        <Composer store={store} />
      </main>
      <Inspector store={store} />
      <Toasts store={store} />
    </div>
  );
}
