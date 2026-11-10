import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer, Toasts, TopBar } from "./app";
import { api } from "./api";
import { Approvals, Questions } from "./inspector";
import { DesktopEditor } from "./desktop-editor";
import { DesktopConsole } from "./desktop-console";
import { SessionView } from "./preview";
import { useWorkbench, type WorkbenchStore } from "./store";
import { buildTimeline, Transcript } from "./transcript";
import type { FileEntry, SessionDetail, TimelineItem } from "./types";
import { latestDesktopPlan } from "./desktop-plan";
import { conversationEntries, historyBeforeRun } from "./desktop-conversation";
import { DesktopChanges, currentDesktopEdit } from "./desktop-changes";

import { DesktopThemePicker } from "./desktop-theme-picker";
import { clampAgent, clampConsole, clampExplorer, fitLayout, loadLayout, saveLayout, type DesktopLayout } from "./desktop-layout";
import { PaneSplitter } from "./desktop-panes";
import { reloadPaths, sameTree } from "./desktop-tree";
import { DesktopFileIcon } from "./desktop-file-icon";
import { DesktopCodexQuota } from "./desktop-codex-quota";

type ExplorerTab = "files" | "sessions";

/**
 * Desktop mode pins the backend to the folder it was launched with, so the
 * project list cannot switch anything there: the folder picker (same path as
 * 文件 → 打开项目文件夹) is the only honest control. The browser workbench keeps
 * the dropdown because its server really does multiplex projects.
 */
export function ProjectSwitcher({ store }: { store: WorkbenchStore }): React.ReactElement {
  const bridge = typeof window === "undefined" ? undefined : window.lubanDesktop;
  const [error, setError] = useState("");
  const path = store.node?.projects?.[store.project];
  if (bridge?.openWorkspace) {
    return (
      <div className="desktop-project">
        <label htmlFor="desktop-open-workspace">项目</label>
        <button
          id="desktop-open-workspace"
          className="desktop-open-workspace"
          title="选择文件夹；桌面端会问你在新窗口打开还是替换当前窗口的项目"
          onClick={() => {
            void bridge.openWorkspace!().then(reply => { if (!reply.canceled) setError(""); })
              .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
          }}
        >打开文件夹…<small>Ctrl+O</small></button>
        {bridge.openWorkspaceWindow && (
          <button
            className="desktop-open-workspace"
            title="换个文件夹并用新窗口打开，当前窗口的项目继续运行"
            onClick={() => {
              void bridge.openWorkspaceWindow!().then(reply => { if (!reply.canceled) setError(""); })
                .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
          >新窗口…</button>
        )}
        <span className="desktop-workspace-path" title={path ?? store.project}>{path ?? store.project}</span>
        {error && <span className="desktop-error" role="alert">{error}</span>}
      </div>
    );
  }
  return (
    <div className="desktop-project">
      <label htmlFor="desktop-project">项目</label>
      <select id="desktop-project" value={store.project} onChange={event => store.setProject(event.target.value)}>
        {Object.keys(store.node?.projects ?? {}).length === 0 && <option value="">当前工作区</option>}
        {Object.entries(store.node?.projects ?? {}).map(([name, folder]) => <option key={name} value={name}>{name} · {folder}</option>)}
      </select>
    </div>
  );
}

function Explorer({ store }: { store: WorkbenchStore }): React.ReactElement {
  const [tab, setTab] = useState<ExplorerTab>("files");
  const [folders, setFolders] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState("");
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const polling = useRef(false);

  // One listing per folder is cached for rendering, so every reload has to name
  // the folders it refreshes: refreshing only the root kept stale subfolders on
  // screen, which is why a new file needed an app restart to appear.
  const load = useCallback(async (paths: string[], quiet = false): Promise<void> => {
    if (!store.project || !paths.length) return;
    if (!quiet) setLoading(paths[0]);
    try {
      const results = await Promise.allSettled(paths.map(async path => [path, (await api.workspace(store.project, path)).tree] as const));
      const trees = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      if (trees.length) setFolders(current => {
        let next: Record<string, FileEntry[]> | undefined;
        for (const [path, tree] of trees) {
          if (sameTree((next ?? current)[path], tree)) continue;
          next = { ...(next ?? current), [path]: tree };
        }
        return next ?? current;
      });
      const failed = results.find(result => result.status === "rejected");
      if (failed) { if (!quiet) setError(failed.status === "rejected" ? failed.reason instanceof Error ? failed.reason.message : String(failed.reason) : ""); }
      else setError("");
    } finally { if (!quiet) setLoading(undefined); }
  }, [store.project]);

  useEffect(() => {
    setFolders({});
    setExpanded({});
    expandedRef.current = {};
    if (store.project) void load([""]);
  }, [store.project, load]);

  // The folder can change on disk while luban runs (a build writes dist/, a
  // formatter adds a file). Poll the root and every expanded folder so the tree
  // stays live without an fs watcher in the sandboxed renderer.
  useEffect(() => {
    if (!store.project || typeof window === "undefined") return;
    const tick = (): void => {
      if (polling.current || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      polling.current = true;
      void load(reloadPaths(expandedRef.current), true).finally(() => { polling.current = false; });
    };
    const timer = window.setInterval(tick, 2500);
    return () => window.clearInterval(timer);
  }, [store.project, load]);

  const toggle = (entry: FileEntry): void => {
    if (entry.type === "file") { void store.openFile(entry.path); return; }
    const next = !expanded[entry.path];
    setExpanded(current => ({ ...current, [entry.path]: next }));
    // Re-read on every expand: an expanded folder is where a new file lands.
    if (next) void load([entry.path]);
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
        <DesktopFileIcon path={entry.name} directory={entry.type === "dir"} expanded={Boolean(expanded[entry.path])} />
        <span className="desktop-file-name">{entry.name}</span>
      </button>
      {entry.type === "dir" && expanded[entry.path] && folders[entry.path] ? draw(folders[entry.path], depth + 1) : null}
    </React.Fragment>
  ));

  return (
    <aside className="desktop-explorer">
      <div className="desktop-brand"><span className="desktop-mark">L</span><b>luban</b><span className="desktop-version">v{store.node?.version ?? "…"}</span></div>
      <ProjectSwitcher store={store} />
      <DesktopThemePicker notify={store.notify} />
      <div className="desktop-explorer-tabs">
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>文件</button>
        <button className={tab === "sessions" ? "active" : ""} onClick={() => { setTab("sessions"); store.setSideTab("sessions"); }}>会话</button>
      </div>
      {tab === "files" && <>
        <div className="desktop-section">
          <span>EXPLORER</span>
          <button title="刷新文件树（含已展开的目录）" aria-label="刷新文件树" onClick={() => void load(reloadPaths(expandedRef.current))}>↻</button>
        </div>
        <div className="desktop-explorer-scroll">
          {error && <div className="desktop-error">{error}</div>}
          {loading === "" && !folders[""] ? <div className="desktop-muted">读取项目文件…</div> : null}
          {folders[""]?.length === 0 && <div className="desktop-muted">项目文件夹为空</div>}
          {draw(folders[""] ?? [])}
        </div>
      </>}
      {tab === "sessions" && <div className="desktop-explorer-scroll">
        <button className="desktop-new" onClick={store.startNew}>＋ 新会话</button>
        {conversationEntries(store.sessions, store.jobs, store.project).map(entry => <button key={entry.id} className={`desktop-list-row${store.activeSessionId === entry.id || store.selectedId === entry.job?.id ? " active" : ""}`} onClick={() => entry.sessionId ? void store.openSession(entry.sessionId) : entry.job && store.selectJob(entry.job.id)}>
          <span>{entry.title}</span><small>{entry.job ? `最近一轮 · ${entry.job.status}` : "历史会话"}</small>
        </button>)}
        {!store.sessions.length && !store.jobs.length && <div className="desktop-muted">还没有会话</div>}
      </div>}
    </aside>
  );
}

/** Saved transcript shown in the agent column, with the composer wired to continue it. */
export function DesktopSessionHistory({ session }: { session: SessionDetail }): React.ReactElement {
  const count = session.messages.filter(message => message.role !== "system").length;
  return <div className="desktop-session-panel">
    <div className="desktop-session-note">下面的输入框会继续这段会话：已带上此前 {count} 条消息与工具结果，不另开新会话。</div>
    <SessionView session={session} />
  </div>;
}

/**
 * Right column. Picking a saved session puts its transcript here and points the
 * shared composer at it, so the click continues the conversation instead of
 * opening a read-only page in the code area.
 */
export function DesktopQuestions({ store }: { store: WorkbenchStore }): React.ReactElement | null {
  const dialog = React.useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (store.questions.length && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [store.questions.length]);
  if (!store.questions.length) return null;
  return <dialog ref={dialog} className="desktop-question-dialog" aria-label="Agent 等待你的选择"
    onCancel={event => event.preventDefault()}>
    <Questions store={store} />
    <p className="desktop-muted">选择一个选项或输入自己的答案，Agent 将收到回答并继续。</p>
    <button className="action" onClick={() => void store.cancel()}>取消当前任务</button>
  </dialog>;
}

export function AgentPanel({ store, timeline }: { store: WorkbenchStore; timeline: TimelineItem[] }): React.ReactElement {
  const history = store.session ? historyBeforeRun(store.session, store.job) : undefined;
  const plan = latestDesktopPlan(timeline);
  return <>
    <TopBar store={store} />
    <DesktopCodexQuota provider={store.node?.provider} modelId={store.node?.model_id} />
    {store.session && <div className="desktop-agent-tabs"><span>{store.session.title}</span><button onClick={store.startNew}>＋ 新会话</button></div>}
    {store.approvals.length > 0 && <div className="desktop-approvals"><Approvals store={store} /></div>}
    <DesktopQuestions store={store} />
    {plan.length > 0 && <details className="desktop-task-plan" open><summary>本轮计划</summary><ol>{plan.map((item, index) => <li key={index} className={item.status}><span>{item.status === "completed" ? "✓" : item.status === "in_progress" ? "◉" : "○"}</span>{item.step}</li>)}</ol></details>}
    <Transcript job={store.job} events={timeline}
      history={history && <DesktopSessionHistory session={history} />}
      onCancel={() => void store.cancel()} onResume={() => void store.resume()} />
    <Composer store={store} />
  </>;
}

export function DesktopCodeArea({ store, timeline }: { store: WorkbenchStore; timeline: TimelineItem[] }): React.ReactElement {
  const [tab, setTab] = useState<"code" | "changes">("code");
  const latest = currentDesktopEdit(timeline);
  useEffect(() => { if (latest) setTab("changes"); }, [latest?.id, latest?.preview]);
  useEffect(() => { if (store.file?.path) setTab("code"); }, [store.file?.path]);
  useEffect(() => { setTab("code"); }, [store.project]);
  return <div className="desktop-code-area">
    <div className="desktop-code-tabs" role="tablist" aria-label="代码工作区">
      <button role="tab" aria-selected={tab === "code"} onClick={() => setTab("code")}>代码</button>
      <button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>当前修改</button>
    </div>
    <div className="desktop-code-pane" role="tabpanel" aria-label="代码" hidden={tab !== "code"}>
      <DesktopEditor store={store} activeView={tab === "code"} />
    </div>
    <div className="desktop-code-pane" role="tabpanel" aria-label="修改对比" hidden={tab !== "changes"}>
      <DesktopChanges timeline={timeline} />
      {!latest && <div className="desktop-muted">暂无当前修改，完整编辑记录请在 Agent 中查看</div>}
    </div>
  </div>;
}

const viewportWidth = (): number => typeof window === "undefined" ? 1440 : window.innerWidth;
const viewportHeight = (): number => typeof window === "undefined" ? 900 : window.innerHeight;

/**
 * The Creator window is a floating always-on-top overlay: handy while working,
 * in the way in every other moment. This is the visible switch that hides and
 * restores it; the tray and View menu mirror the same state.
 */
export function PetToggle(): React.ReactElement | null {
  const bridge = typeof window === "undefined" ? undefined : window.lubanDesktop;
  const [visible, setVisible] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!bridge?.petVisible) return;
    void bridge.petVisible().then(setVisible).catch(() => setVisible(undefined));
    return bridge.onPetVisibility?.(setVisible);
  }, [bridge]);
  if (!bridge?.togglePet) return null;
  return <button
    className={`desktop-pet-toggle${visible ? " on" : ""}`}
    aria-pressed={visible === true}
    title={visible ? "隐藏造物主悬浮窗（也可从托盘菜单恢复）" : "显示造物主悬浮窗"}
    onClick={() => void bridge.togglePet!().then(setVisible).catch(() => setVisible(undefined))}
  >{visible ? "◍ 造物主 · 显示中" : "◌ 造物主 · 已隐藏"}</button>;
}

export function DesktopApp(): React.ReactElement {
  const store = useWorkbench();
  const [layout, setLayout] = useState<DesktopLayout>(() => loadLayout(viewportWidth()));
  useEffect(() => { saveLayout(layout); }, [layout]);
  useEffect(() => {
    const fit = (): void => setLayout(current => fitLayout(current, viewportWidth()));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const resize = (key: keyof DesktopLayout, value: number): void => setLayout(current => ({ ...current, [key]: value }));
  useEffect(() => window.lubanDesktop?.onPetJob?.(id => store.selectJob(id)), [store.selectJob]);
  const timeline = useMemo(() => buildTimeline(store.job, store.events), [store.job, store.events]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); store.startNew(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
  // Dragging writes pixel widths; the CSS variables keep the three columns and
  // the split handles in one grid so the borders line up.
  const paneStyle = {
    "--explorer-width": `${layout.explorer}px`,
    "--agent-width": `${layout.agent}px`,
  } as unknown as React.CSSProperties;

  return <div className="desktop-app" style={paneStyle}>
    <Explorer store={store} />
    <PaneSplitter orientation="vertical" label="调整文件树宽度"
      onDelta={delta => resize("explorer", clampExplorer(layout.explorer + delta, viewportWidth(), layout.agent))} />
    <main className="desktop-editor">
      <DesktopCodeArea store={store} timeline={timeline} />
      <DesktopConsole store={store} height={layout.console} onHeight={value => resize("console", clampConsole(value, viewportHeight()))} />
    </main>
    <PaneSplitter orientation="vertical" label="调整 Agent 栏宽度"
      onDelta={delta => resize("agent", clampAgent(layout.agent - delta, viewportWidth(), layout.explorer))} />
    <aside className="desktop-agent">
      <AgentPanel store={store} timeline={timeline} />
    </aside>
    <footer className="desktop-status"><span className={`dot ${store.connected ? "online" : "offline"}`} />{store.connected ? "本地 Agent 已连接" : "正在连接本地 Agent"}<PetToggle /><span>{store.project || store.node?.workspace || ""}</span><span>{store.file ? `${store.file.lines ?? 0} 行 · ${store.file.language}` : ""}</span></footer>
    <Toasts store={store} />
  </div>;
}
