import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Composer, Toasts, TopBar } from "./app";
import { api } from "./api";
import { Approvals } from "./inspector";
import { Preview } from "./preview";
import { useWorkbench, type WorkbenchStore } from "./store";
import { buildTimeline, Transcript } from "./transcript";
import type { FileEntry } from "./types";

type ExplorerTab = "files" | "tasks" | "sessions";

function Explorer({ store }: { store: WorkbenchStore }): React.ReactElement {
  const [tab, setTab] = useState<ExplorerTab>("files");
  const [folders, setFolders] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState("");
  const load = useCallback(async (path: string) => {
    if (!store.project) return;
    setLoading(path);
    try {
      const result = await api.workspace(store.project, path);
      setFolders(current => ({ ...current, [path]: result.tree }));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(undefined); }
  }, [store.project]);

  useEffect(() => {
    setFolders({});
    setExpanded({});
    if (store.project) void load("");
  }, [store.project, load]);

  const toggle = (entry: FileEntry): void => {
    if (entry.type === "file") { void store.openFile(entry.path); return; }
    const next = !expanded[entry.path];
    setExpanded(current => ({ ...current, [entry.path]: next }));
    if (next && !folders[entry.path]) void load(entry.path);
  };

  const draw = (entries: FileEntry[], depth = 0): React.ReactNode => entries.map(entry => (
    <React.Fragment key={entry.path}>
      <button
        className={`desktop-file${store.file?.path === entry.path ? " active" : ""}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => toggle(entry)}
        title={entry.path}
      >
        <span className="desktop-chevron">{entry.type === "dir" ? expanded[entry.path] ? "⌄" : "›" : ""}</span>
        <span className="desktop-file-icon">{entry.type === "dir" ? "▣" : "▤"}</span>
        <span className="desktop-file-name">{entry.name}</span>
      </button>
      {entry.type === "dir" && expanded[entry.path] && folders[entry.path] ? draw(folders[entry.path], depth + 1) : null}
    </React.Fragment>
  ));

  return (
    <aside className="desktop-explorer">
      <div className="desktop-brand"><span className="desktop-mark">L</span><b>luban</b><span className="desktop-version">v{store.node?.version ?? "…"}</span></div>
      <div className="desktop-project">
        <label htmlFor="desktop-project">项目</label>
        <select id="desktop-project" value={store.project} onChange={event => store.setProject(event.target.value)}>
          {Object.keys(store.node?.projects ?? {}).length === 0 && <option value="">当前工作区</option>}
          {Object.entries(store.node?.projects ?? {}).map(([name, path]) => <option key={name} value={name}>{name} · {path}</option>)}
        </select>
      </div>
      <div className="desktop-explorer-tabs">
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>文件</button>
        <button className={tab === "tasks" ? "active" : ""} onClick={() => { setTab("tasks"); store.setSideTab("runs"); }}>任务</button>
        <button className={tab === "sessions" ? "active" : ""} onClick={() => { setTab("sessions"); store.setSideTab("sessions"); }}>会话</button>
      </div>
      {tab === "files" && <>
        <div className="desktop-section"><span>EXPLORER</span><button title="刷新文件树" onClick={() => void load("")}>↻</button></div>
        <div className="desktop-explorer-scroll">
          {error && <div className="desktop-error">{error}</div>}
          {loading === "" && !folders[""] ? <div className="desktop-muted">读取项目文件…</div> : null}
          {folders[""]?.length === 0 && <div className="desktop-muted">项目文件夹为空</div>}
          {draw(folders[""] ?? [])}
        </div>
      </>}
      {tab === "tasks" && <div className="desktop-explorer-scroll">
        <button className="desktop-new" onClick={store.startNew}>＋ 新任务</button>
        {store.jobs.map(job => <button key={job.id} className={`desktop-list-row${store.selectedId === job.id ? " active" : ""}`} onClick={() => store.selectJob(job.id)}>
          <span>{job.title || job.instruction || job.id}</span><small>{job.status} · {job.project_id}</small>
        </button>)}
        {!store.jobs.length && <div className="desktop-muted">还没有任务</div>}
      </div>}
      {tab === "sessions" && <div className="desktop-explorer-scroll">
        {store.sessions.map(session => <button key={session.id} className="desktop-list-row" onClick={() => void store.openSession(session.id)}>
          <span>{session.title}</span><small>{session.model} · {session.messages} 条消息</small>
        </button>)}
        {!store.sessions.length && <div className="desktop-muted">还没有会话</div>}
      </div>}
    </aside>
  );
}

export function DesktopApp(): React.ReactElement {
  const store = useWorkbench();
  const timeline = useMemo(() => buildTimeline(store.job, store.events), [store.job, store.events]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); store.startNew(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  return <div className="desktop-app">
    <Explorer store={store} />
    <main className="desktop-editor">
      <div className="desktop-editor-head"><span className="desktop-editor-title">{store.file?.path || store.node?.workspace || "代码浏览"}</span><span>只读预览</span></div>
      <Preview store={store} />
    </main>
    <aside className="desktop-agent">
      <TopBar store={store} />
      {store.approvals.length > 0 && <div className="desktop-approvals"><Approvals store={store} /></div>}
      <Transcript job={store.job} events={timeline} onCancel={() => void store.cancel()} onResume={() => void store.resume()} />
      <Composer store={store} />
    </aside>
    <footer className="desktop-status"><span className={`dot ${store.connected ? "online" : "offline"}`} />{store.connected ? "本地 Agent 已连接" : "正在连接本地 Agent"}<span>{store.project || store.node?.workspace || ""}</span><span>{store.file ? `${store.file.lines ?? 0} 行 · ${store.file.language}` : ""}</span></footer>
    <Toasts store={store} />
  </div>;
}
