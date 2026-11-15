import React, { useEffect, useState } from "react";
import type { NodeInfo, SessionSummary } from "./types";
import { mobileProjects } from "./mobile-project";
import { MobileCollapse } from "./mobile-collapse";

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

/** An explicit node on every request: browsing another device must never change
 * the console's global API scope, even when several cards load concurrently. */
export async function loadDeviceWorkspaces(node: string | undefined, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<WorkspaceEntry[]> {
  const read = async <T,>(path: string, params: Record<string, string> = {}): Promise<T> => {
    const query = new URLSearchParams({ ...params, ...(node ? { node } : {}) });
    const response = await fetcher(`${path}?${query}`, { signal, cache: "no-store" });
    const body = await response.json();
    if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
    return body as T;
  };
  const info = await read<NodeInfo>("/api/node");
  return Promise.all(Object.entries(mobileProjects(info)).map(async ([project, path]) => {
    try {
      const sessions = await read<SessionSummary[]>("/api/sessions", { project, limit: "200", includeEmpty: "1" });
      return { project, path, sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
    } catch (error) {
      if (signal.aborted) throw error;
      return { project, path, sessions: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

export function MobileWorkspaces({ nodeId, online, selectedProject, selectedSession, onOpen, onAdd }: {
  nodeId?: string;
  online: boolean;
  selectedProject?: string;
  selectedSession?: string;
  onOpen(project: string, session?: SessionSummary): void;
  onAdd(kind: "new" | "existing"): void;
}): React.ReactElement {
  const [entries, setEntries] = useState<WorkspaceEntry[]>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [deleting, setDeleting] = useState<string>();
  const remove = async (session: SessionSummary): Promise<void> => {
    if (deleting) return;
    setDeleting(session.id);
    try {
      if (await deleteMobileSession(nodeId, session)) {
        setEntries(previous => previous?.map(entry => ({ ...entry, sessions: entry.sessions.filter(item => item.id !== session.id || item.project !== session.project) })));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setDeleting(undefined); }
  };
  useEffect(() => {
    setEntries(undefined);
    setError("");
    if (!online) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const next = await loadDeviceWorkspaces(nodeId, controller.signal);
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
  }, [nodeId, online, retry]);

  return <section className="m-workspaces" aria-label="工作区与会话">
    <div className="m-workspaces-heading"><strong>工作区与会话</strong>
      <button className="m-btn" disabled={!online} onClick={() => onAdd("new")}>＋ 新建工作区</button>
    </div>
    {!online ? <p className="m-note">电脑离线，连接后可查看工作区和会话。</p> : <>
      {error && <div role="alert" className="m-note">读取失败：{error} <button className="m-btn" onClick={() => setRetry(value => value + 1)}>重试</button></div>}
      {!entries && !error && <p className="m-note" role="status">正在读取工作区和会话…</p>}
      {entries?.length === 0 && <p className="m-note">还没有工作区，可以新建或添加电脑上的已有目录。</p>}
      {entries?.map(entry => <div className="m-workspace" key={entry.project}>
        <div className="m-workspaces-heading"><strong>{entry.project}</strong>
          <button className="m-btn" onClick={() => onOpen(entry.project)}>＋ 新会话</button>
        </div>
        <div className="m-device-path">{entry.path}</div>
        <MobileCollapse label="会话" summary={entry.error ? "读取失败" : `${entry.sessions.length} 个`} ariaLabel={`${entry.project} 的会话`}>
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
      </div>)}
      <MobileCollapse label="更多工作区操作"><button className="m-btn" onClick={() => onAdd("existing")}>＋ 添加已有目录</button></MobileCollapse>
    </>}
  </section>;
}
