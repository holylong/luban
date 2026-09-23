import React from "react";
import type { WorkbenchStore } from "./store";
import { relativeTime, STATUS_LABELS } from "./timeline";

export function Sidebar({ store }: { store: WorkbenchStore }): React.ReactElement {
  const { node, connected, jobs, sessions, selectedId, sideTab } = store;
  return (
    <aside className="side">
      <div className="brand">
        <span className="mark">◈</span>
        <strong>luban</strong>
        <span className="version">{node ? `v${node.version}` : "…"}</span>
      </div>
      <button className="new" onClick={store.startNew}>＋ 新任务</button>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={sideTab === "runs"} className={`tab ${sideTab === "runs" ? "active" : ""}`} onClick={() => store.setSideTab("runs")}>
          任务 {jobs.length ? `· ${jobs.length}` : ""}
        </button>
        <button role="tab" aria-selected={sideTab === "sessions"} className={`tab ${sideTab === "sessions" ? "active" : ""}`} onClick={() => store.setSideTab("sessions")}>
          会话 {sessions.length ? `· ${sessions.length}` : ""}
        </button>
      </div>
      <div className="side-scroll">
        {sideTab === "runs" ? (
          <>
            <div className="section">最近任务</div>
            <div className="runs">
              {jobs.length === 0 && <div className="empty-list muted">还没有任务</div>}
              {jobs.map(item => (
                <button key={item.id} className={`run ${item.id === selectedId ? "active" : ""}`} onClick={() => store.selectJob(item.id)}>
                  <div className="run-title">{item.title || item.instruction || item.id}</div>
                  <div className="meta">
                    <span className={`dot ${item.status}`} />
                    <span>{STATUS_LABELS[item.status] ?? item.status}</span>
                    <span className="grow">· {item.project_id}</span>
                    <span className="spacer">{relativeTime(item.created_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="section">已保存会话</div>
            <div className="runs">
              {sessions.length === 0 && <div className="empty-list muted">没有匹配的会话记录</div>}
              {sessions.map(item => (
                <button key={item.id} className="run" onClick={() => void store.openSession(item.id)}>
                  <div className="run-title">{item.title}</div>
                  <div className="meta">
                    <span>{item.model}</span>
                    <span className="grow">· {item.messages} 条消息</span>
                    <span className="spacer">{relativeTime(Date.parse(item.updatedAt) / 1000)}</span>
                  </div>
                  {item.edits > 0 && <div className="meta"><span>编辑记录 {item.edits}</span></div>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="foot">
        <span className={`dot ${connected ? "online" : "offline"}`} />
        <span>{node ? node.name : "连接中"}</span>
        <a className="spacer" href="/docs/">文档</a>
        <a href="/diff">变更</a>
      </div>
    </aside>
  );
}
