import React from "react";
import type { SessionDetail, TimelineItem, ToolRun } from "./types";
import { deriveTimeline, liveProgress } from "./timeline";

/** Durable transcript first, followed by the current TUI turn's event replay. */
export function sessionTimeline(session: SessionDetail): TimelineItem[] {
  const at = Date.parse(session.updatedAt) / 1000;
  const items: TimelineItem[] = [];
  const results = new Map(session.messages.filter(message => message.role === "tool").map(message => [message.tool_call_id, message]));
  session.messages.forEach((message, index) => {
    const id = `${session.id}-${index}`;
    if (message.role === "user" && message.content) items.push({ kind: "user", id, text: message.content, at });
    if (message.role === "assistant") {
      if (message.content) items.push({ kind: "assistant", id, text: message.content, at });
      for (const call of message.tool_calls ?? []) {
        const result = results.get(call.id);
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments); } catch { /* Legacy malformed arguments still have a readable tool name. */ }
        items.push({ kind: "tool", id: `tool-${call.id}`, at, run: {
          callId: call.id, name: call.function.name, args, summary: call.function.name,
          status: result ? "done" : session.live?.running ? "running" : "failed",
          preview: result?.content,
          editPreview: result?.editPreview ?? session.edits?.find(edit => edit.id === call.id)?.preview,
          seq: index,
        } });
      }
    }
  });
  if (session.live?.running) {
    const live = deriveTimeline({ id: session.id, instruction: "", created_at: at }, session.live.events).slice(1);
    items.push(...live.map(item => ({ ...item, id: `live-${item.id}` })));
  }
  return items;
}

export function MobileSessionHistory({ session, renderTool }: {
  session: SessionDetail;
  renderTool: (run: ToolRun) => React.ReactNode;
}): React.ReactElement {
  const progress = session.live?.running ? liveProgress(session.live.events, Date.now() / 1000) : null;
  const items = sessionTimeline(session);
  return <section aria-label="会话交互记录">
    <h3>{session.title}</h3>
    <p className="m-note">{session.live?.running ? "电脑正在执行 · 每秒同步" : "会话记录 · 自动同步"}</p>
    {progress && <div className="m-live"><span className="m-spin" /><span className="label">{progress.label}</span><span className="detail">{progress.detail}</span><span className="clock">{progress.seconds}s</span></div>}
    {items.length === 0 && <p className="m-note">此会话还没有可显示的交互记录，请选择其他历史会话。</p>}
    {items.map(item => {
      if (item.kind === "tool") return <React.Fragment key={item.id}>{renderTool(item.run)}</React.Fragment>;
      if (item.kind === "thinking") return <details className="m-turn m-thinking" key={item.id}><summary>思考过程</summary><div className="m-body think">{item.text}</div></details>;
      if (!("text" in item)) return null;
      return <div className="m-turn" key={item.id}>
        {item.kind === "user" && <div className="m-turn-head">我</div>}
        <div className={item.kind === "user" ? "m-turn-user" : `m-body${item.kind === "error" ? " error" : ""}`}>{item.text}</div>
      </div>;
    })}
  </section>;
}
