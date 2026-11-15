import React, { useEffect, useRef, useState } from "react";
import type { NodeInfo, SessionSummary } from "./types";
import { mobileProjects, scratchWorkspace } from "./mobile-project";
import type { MachineWorkspaceRoute } from "./mobile-machines";
import { MobileCollapse } from "./mobile-collapse";

const NO_ROUTES: MachineWorkspaceRoute[] = [];

export async function deleteMobileSession(node: string | undefined, session: SessionSummary,
  confirm: (message: string) => boolean = window.confirm.bind(window), fetcher: typeof fetch = fetch): Promise<boolean> {
  if (session.running || !confirm(`删除会话「${session.title || "未命名会话"}」？\n将删除会话及历史记录，无法恢复；不会删除工作区文件。`)) return false;
  const query = new URLSearchParams({ project: session.project, ...(node ? { node } : {}) });
  const response = await fetcher(`/api/sessions/${encodeURIComponent(session.id)}/delete?${query}`, { method: "POST" });
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
  return true;
}

export interface WorkspaceEntry {
  project: string;
  path: string;
  sessions: SessionSummary[];
  error?: string;
}

/**
 * What actually decides whether the device card reloads.
 *
 * The relay poll hands the card a fresh route array every few seconds, and a
 * route's owning node can move between instances of the same computer. Neither
 * changes which workspaces exist, so neither may reset the open session list.
 */
export function workspaceLoadKey(nodeId: string | undefined, retry: number, routes: MachineWorkspaceRoute[]): string {
  const workspaces = routes.map(route => `${route.project}\0${route.path}`).join("\n");
  return `${nodeId ?? ""}\0${retry}\0${workspaces}`;
}

/** An explicit node on every request: browsing another device must never change
 * the console's global API scope, even when several cards load concurrently. */
export async function loadDeviceWorkspaces(node: string | undefined, signal: AbortSignal,
  fetcher: typeof fetch = fetch, routeOverrides: MachineWorkspaceRoute[] = []): Promise<WorkspaceEntry[]> {
  const read = async <T,>(path: string, params: Record<string, string> = {}): Promise<T> => {
    const query = new URLSearchParams({ ...params, ...(node ? { node } : {}) });
    const response = await fetcher(`${path}?${query}`, { signal, cache: "no-store" });
    const body = await response.json();
    if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
    return body as T;
  };
  // The per-workspace relay nodes each carry an overlapping project snapshot.
  // Their parent device card passes an explicit union with exact owners.
  const projects = routeOverrides.length
    ? routeOverrides.map(route => [route.project, route.path, route.nodeId] as const)
    : Object.entries(mobileProjects(await read<NodeInfo>("/api/node"))).filter(([, path]) => !scratchWorkspace(path))
      .map(([project, path]) => [project, path, node] as const);
  return Promise.all(projects.map(async ([project, path, owner]) => {
    const readOwner = async <T,>(endpoint: string, params: Record<string, string> = {}): Promise<T> => {
      const query = new URLSearchParams({ ...params, ...(owner ? { node: owner } : {}) });
      const response = await fetcher(`${endpoint}?${query}`, { signal, cache: "no-store" });
      const body = await response.json();
      if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
      return body as T;
    };
    try {
      const sessions = await readOwner<SessionSummary[]>("/api/sessions", { project, limit: "200", includeEmpty: "1" });
      return { project, path, sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
    } catch (error) {
      if (signal.aborted) throw error;
      return { project, path, sessions: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

/**
 * Split workspaces into "the ones this phone is using" and the rest.
 *
 * Most recently used first; a project with no session yet is still a real place
 * to start work, but thirty equal cards are unusable, so those wait one tap
 * away under 「其他工作区」. A workspace whose sessions cannot be read stays
 * visible: hiding an error is not tidying up.
 */
export function splitWorkspaces(entries: WorkspaceEntry[], selectedProject?: string): { active: WorkspaceEntry[]; idle: WorkspaceEntry[] } {
  const newest = (entry: WorkspaceEntry): string => entry.sessions[0]?.updatedAt ?? "";
  const ordered = [...entries].sort((left, right) => newest(right).localeCompare(newest(left))
    || Number(Boolean(right.error)) - Number(Boolean(left.error))
    || left.project.localeCompare(right.project));
  const current = (entry: WorkspaceEntry): boolean => entry.sessions.length > 0 || Boolean(entry.error) || entry.project === selectedProject;
  // Session-less workspaces have no recency to sort by, and re-ordering them
  // on every 8s poll would make the folded list jump: keep them by name.
  const idle = ordered.filter(entry => !current(entry)).sort((left, right) => left.project.localeCompare(right.project));
  return { active: ordered.filter(current), idle };
}

export function MobileWorkspaces({ nodeId, online, routes, selectedProject, selectedSession, onOpen, onAdd }: {
  nodeId?: string;
  online: boolean;
  routes?: MachineWorkspaceRoute[];
  selectedProject?: string;
  selectedSession?: string;
  onOpen(project: string, session?: SessionSummary): void;
  onAdd(kind: "new" | "existing"): void;
}): React.ReactElement {
  const routeList = routes ?? NO_ROUTES;
  // The device tab rebuilds its route array on every relay poll. Keying the
  // effect on that identity restarted the load, blanked the list and folded the
  // section the user had just opened, which read as data flickering. Only a
  // different workspace set (a real device or route change) resets the view.
  const routeRef = useRef(routeList);
  routeRef.current = routeList;
  const [entries, setEntries] = useState<WorkspaceEntry[]>();
  const loadKey = useRef<string | undefined>(undefined);
  const openSections = useRef<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [retry, setRetry] = useState(0);
  const [deleting, setDeleting] = useState<string>();
  const remove = async (session: SessionSummary): Promise<void> => {
    if (deleting) return;
    setDeleting(`${session.project}\\0${session.id}`);
    setDeleteError("");
    try {
      const owner = routeList.find(route => route.project === session.project)?.nodeId ?? nodeId;
      if (await deleteMobileSession(owner, session)) {
        setEntries(previous => previous?.map(entry => ({ ...entry, sessions: entry.sessions.filter(item => item.id !== session.id || item.project !== session.project) })));
      }
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
    } finally { setDeleting(undefined); }
  };
  useEffect(() => {
    const key = workspaceLoadKey(nodeId, retry, routeRef.current);
    if (loadKey.current !== key) {
      loadKey.current = key;
      setEntries(undefined);
    }
    setError("");
    setDeleteError("");
    if (!online) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const next = await loadDeviceWorkspaces(nodeId, controller.signal, fetch, routeRef.current);
        if (!controller.signal.aborted) { setEntries(next); setError(""); }
      } catch (cause) {
        if (stopped) return;
        setError(controller.signal.aborted ? "读取超时，请重试" : cause instanceof Error ? cause.message : String(cause));
      } finally {
        clearTimeout(timeout);
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 8000);
      }
    };
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [nodeId, online, retry, routeList]);

  const { active, idle } = splitWorkspaces(entries ?? [], selectedProject);
  const card = (entry: WorkspaceEntry): React.ReactElement => <div className="m-workspace" key={entry.project}>
    <div className="m-workspaces-heading"><strong>{entry.project}</strong>
      <button className="m-btn" onClick={() => onOpen(entry.project)}>＋ 新会话</button>
    </div>
    <div className="m-device-path">{entry.path}</div>
    <MobileCollapse label="会话" summary={entry.error ? "读取失败" : `${entry.sessions.length} 个`} ariaLabel={`${entry.project} 的会话`}
      defaultOpen={openSections.current[entry.project] ?? false}
      onToggle={open => { openSections.current[entry.project] = open; }}>
      {entry.error ? <p role="alert" className="m-note">会话读取失败：{entry.error} <button className="m-btn" onClick={() => setRetry(value => value + 1)}>重试</button></p>
        : entry.sessions.length === 0 ? <p className="m-note">还没有会话，点「新会话」开始。</p>
        : <div className="m-workspace-sessions">{entry.sessions.map(session => <div className="m-session-row" key={session.id}><button type="button"
          className={`m-pick ${selectedProject === entry.project && selectedSession === session.id ? "active" : ""}`}
          onClick={() => onOpen(entry.project, session)}>
          <span className="m-pick-title">{session.title || "未命名会话"}<span aria-hidden="true"> ›</span></span>
          <span className="m-pick-meta">{session.messages} 条消息{session.running ? " · 运行中" : session.messages === 0 ? " · 尚未开始" : ""}</span>
        </button><button className="m-btn" aria-label={`删除会话 ${session.title || session.id}`} disabled={session.running || Boolean(deleting)} onClick={() => void remove(session)}>删除</button></div>)}</div>}
      {entry.sessions.length >= 200 && <p className="m-note">显示最近 200 个会话</p>}
    </MobileCollapse>
  </div>;

  return <section className="m-workspaces" aria-label="工作区与会话">
    <div className="m-workspaces-heading"><strong>工作区与会话</strong>
      <button className="m-btn" disabled={!online} onClick={() => onAdd("new")}>＋ 新建工作区</button>
    </div>
    {!online ? <p className="m-note">电脑离线，连接后可查看工作区和会话。</p> : <>
      {error && <div role="alert" className="m-note">读取失败：{error} <button className="m-btn" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {deleteError && <div role="alert" className="m-note">删除失败：{deleteError}</div>}
      {!entries && !error && <p className="m-note" role="status">正在读取工作区和会话…</p>}
      {entries?.length === 0 && <p className="m-note">还没有工作区，可以新建或添加电脑上的已有目录。</p>}
      {active.map(card)}
      {idle.length > 0 && <MobileCollapse label="其他工作区" summary={`${idle.length} 个 · 还没有会话`} ariaLabel="其他工作区">
        {idle.map(card)}
      </MobileCollapse>}
      <MobileCollapse label="更多工作区操作"><button className="m-btn" onClick={() => onAdd("existing")}>＋ 添加已有目录</button></MobileCollapse>
    </>}
  </section>;
}
