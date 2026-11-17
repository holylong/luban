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
import { FileMenu, joinPath, nameProblem, parentPath, type FileMenuAction, type FileMenuTarget } from "./desktop-file-menu";
import { desktopErrorText } from "./desktop-bridge";
import { followEdit, type EditView } from "./desktop-edit-view";
import { openConversationLink } from "./conversation-links";
import { DesktopCodexQuota } from "./desktop-codex-quota";

type ExplorerTab = "files" | "sessions";

/**
 * The last segment of a workspace path, which is what the user names the
 * project by. Keeping it a pure function lets the button label be tested
 * without a renderer.
 */
export function folderLabel(path: string | undefined): string {
  const text = (path ?? "").trim();
  if (!text) return "";
  const parts = text.split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) ?? "";
}

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
  // With a folder already open the button is a label as much as a control, so
  // it names the project instead of repeating the instruction on every window.
  const opened = folderLabel(path) || folderLabel(store.project);
  if (bridge?.openWorkspace) {
    return (
      <div className="desktop-project">
        <label htmlFor="desktop-open-workspace">项目</label>
        <button
          id="desktop-open-workspace"
          className={`desktop-open-workspace ${opened ? "opened" : ""}`}
          aria-label={opened ? `当前项目 ${opened}，点击更换文件夹` : "打开文件夹"}
          title={opened
            ? `${path ?? store.project} · 点击更换文件夹（Ctrl+O）`
            : "选择文件夹；桌面端会问你在新窗口打开还是替换当前窗口的项目"}
          onClick={() => {
            void bridge.openWorkspace!().then(reply => { if (!reply.canceled) setError(""); })
              .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
          }}
        ><span className="desktop-open-workspace-name">{opened || "打开文件夹…"}</span><small>Ctrl+O</small></button>
        {bridge.createWorkspace && (
          <button className="desktop-open-workspace" title="创建新文件夹作为工作区" onClick={() => {
            void bridge.createWorkspace!().then(reply => { if (!reply.canceled) setError(""); })
              .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
          }}>新建工作区…</button>
        )}
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
  // Right-click menu, and the inline row that names a new or renamed entry.
  const [menu, setMenu] = useState<{ x: number; y: number; target?: FileMenuTarget } | undefined>();
  const [edit, setEdit] = useState<{ mode: "new-file" | "new-folder" | "rename"; dir: string; path?: string; value: string } | undefined>();
  const bridge = typeof window === "undefined" ? undefined : window.lubanDesktop;
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

  const refreshAfter = (dir: string): void => {
    void load([...new Set([dir, ...reloadPaths(expandedRef.current)])]);
  };

  const commitEdit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!edit) return;
    const problem = nameProblem(edit.value);
    if (problem) { store.notify(problem, true); return; }
    const name = edit.value.trim();
    try {
      if (edit.mode === "rename" && edit.path) {
        await bridge?.renameEntry?.({ from: edit.path, to: joinPath(edit.dir, name) });
        store.notify(`已重命名：${name}`);
      } else {
        await bridge?.createEntry?.({ path: joinPath(edit.dir, name), kind: edit.mode === "new-folder" ? "dir" : "file" });
        store.notify(`${edit.mode === "new-folder" ? "已新建文件夹" : "已新建文件"}：${name}`);
      }
      const dir = edit.dir;
      setEdit(undefined);
      refreshAfter(dir);
    } catch (cause) { store.notify(desktopErrorText(cause, name), true); }
  };

  const runMenu = async (action: FileMenuAction, target?: FileMenuTarget): Promise<void> => {
    const path = target?.path ?? "";
    try {
      if (action === "open") {
        if (!target) return;
        toggle({ path: target.path, name: target.path.split("/").pop() ?? target.path, type: target.type });
        return;
      }
      if (action === "reveal") { await bridge?.revealPath?.(path); return; }
      if (action === "copy") {
        const result = await bridge?.copyPath?.(path);
        store.notify(result?.path ? `已复制路径：${result.path}` : "已复制路径");
        return;
      }
      if (action === "new-file" || action === "new-folder") {
        const dir = target ? (target.type === "dir" ? target.path : parentPath(target.path)) : "";
        if (dir) {
          setExpanded(current => ({ ...current, [dir]: true }));
          void load([dir]);
        }
        setEdit({ mode: action, dir, value: "" });
        return;
      }
      if (action === "rename" && target) {
        setEdit({ mode: "rename", dir: parentPath(target.path), path: target.path, value: target.path.split("/").pop() ?? "" });
        return;
      }
      if (action === "trash" && target) {
        const result = await bridge?.trashEntry?.(target.path);
        if (result?.ok) {
          store.notify(`已移到废纸篓：${target.path}`);
          refreshAfter(parentPath(target.path));
        }
        return;
      }
    } catch (cause) { store.notify(desktopErrorText(cause, path), true); }
  };

  const nameRow = (depth: number): React.ReactElement => (
    <form className="desktop-file-edit" style={{ paddingLeft: 12 + depth * 16 }} onSubmit={event => void commitEdit(event)}>
      <input
        autoFocus
        aria-label="文件名"
        value={edit?.value ?? ""}
        placeholder={edit?.mode === "new-folder" ? "文件夹名" : edit?.mode === "rename" ? "新名字" : "文件名"}
        onChange={event => setEdit(current => current ? { ...current, value: event.target.value } : current)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setEdit(undefined); } }}
      />
    </form>
  );

  const toggle = (entry: FileEntry): void => {
    if (entry.type === "file") { void store.openFile(entry.path); return; }
    const next = !expanded[entry.path];
    setExpanded(current => ({ ...current, [entry.path]: next }));
    // Re-read on every expand: an expanded folder is where a new file lands.
    if (next) void load([entry.path]);
  };

  const draw = (entries: FileEntry[], depth = 0): React.ReactNode => entries.map(entry => {
    const renaming = edit?.mode === "rename" && edit.path === entry.path;
    const creatingHere = edit && edit.mode !== "rename" && edit.dir === entry.path;
    return (
      <React.Fragment key={entry.path}>
        {renaming ? nameRow(depth) : (
          <button
            className={`desktop-file${store.file?.path === entry.path ? " active" : ""}`}
            style={{ paddingLeft: 12 + depth * 16 }}
            onClick={() => toggle(entry)}
            onContextMenu={event => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, target: { path: entry.path, type: entry.type } });
            }}
            title={entry.path}
          >
            <span className="desktop-chevron">{entry.type === "dir" ? expanded[entry.path] ? "⌄" : "›" : ""}</span>
            <DesktopFileIcon path={entry.name} directory={entry.type === "dir"} expanded={Boolean(expanded[entry.path])} />
            <span className="desktop-file-name">{entry.name}</span>
          </button>
        )}
        {entry.type === "dir" && expanded[entry.path] ? <>
          {creatingHere ? nameRow(depth + 1) : null}
          {folders[entry.path] ? draw(folders[entry.path], depth + 1) : null}
        </> : null}
      </React.Fragment>
    );
  });

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
        <div
          className="desktop-explorer-scroll"
          onContextMenu={event => {
            if ((event.target as HTMLElement).closest(".desktop-file, .desktop-file-edit")) return;
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {error && <div className="desktop-error">{error}</div>}
          {loading === "" && !folders[""] ? <div className="desktop-muted">读取项目文件…</div> : null}
          {folders[""]?.length === 0 && <div className="desktop-muted">项目文件夹为空</div>}
          {edit && edit.mode !== "rename" && edit.dir === "" ? nameRow(0) : null}
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
      {menu && <FileMenu
        x={menu.x}
        y={menu.y}
        target={menu.target}
        bridge={bridge}
        onAction={(action, target) => void runMenu(action, target)}
        onClose={() => setMenu(undefined)}
      />}
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
  return <div style={{ display: "contents" }} onClick={event => { void openConversationLink(event, store); }}>
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
  </div>;
}

export function DesktopCodeArea({ store, timeline }: { store: WorkbenchStore; timeline: TimelineItem[] }): React.ReactElement {
  const [view, setView] = useState<EditView>({ tab: "code" });
  const tab = view.tab;
  const setTab = (tab: EditView["tab"]): void => setView(current => ({ tab, seen: current.seen }));
  const latest = currentDesktopEdit(timeline);
  useEffect(() => { setView({ tab: "code" }); }, [store.project]);
  useEffect(() => {
    setView(current => followEdit(current, store.job?.id ?? "", store.job?.status, latest ? `${latest.id}:${latest.preview}` : undefined));
  }, [store.project, store.job?.id, store.job?.status, latest?.id, latest?.preview]);
  useEffect(() => { if (store.file?.path) setTab("code"); }, [store.file?.path]);
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
    title={visible ? "隐藏 Creator 悬浮窗（也可从托盘菜单恢复）" : "显示 Creator 悬浮窗"}
    onClick={() => void bridge.togglePet!().then(setVisible).catch(() => setVisible(undefined))}
  >{visible ? "◍ Creator · 显示中" : "◌ Creator · 已隐藏"}</button>;
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
    <PaneSplitter orientation="vertical" label="调整文件树宽度" value={layout.explorer}
      onResize={next => resize("explorer", clampExplorer(next, viewportWidth(), layout.agent))} />
    <main className="desktop-editor">
      <DesktopCodeArea store={store} timeline={timeline} />
      <DesktopConsole store={store} height={layout.console} onHeight={value => resize("console", clampConsole(value, viewportHeight()))} />
    </main>
    <PaneSplitter orientation="vertical" label="调整 Agent 栏宽度" value={layout.agent} sign={-1}
      onResize={next => resize("agent", clampAgent(next, viewportWidth(), layout.explorer))} />
    <aside className="desktop-agent">
      <AgentPanel store={store} timeline={timeline} />
    </aside>
    <footer className="desktop-status"><span className={`dot ${store.connected ? "online" : "offline"}`} />{store.connected ? "本地 Agent 已连接" : "正在连接本地 Agent"}<PetToggle /><span>{store.project || store.node?.workspace || ""}</span><span>{store.file ? `${store.file.lines ?? 0} 行 · ${store.file.language}` : ""}</span></footer>
    <Toasts store={store} />
  </div>;
}
