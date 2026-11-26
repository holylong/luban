import React, { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "./markdown";
import { ToolCard } from "./tool-card";
import { followTranscript } from "./transcript-scroll";
import { conciseTimeline, deriveTimeline, formatClock, sameTimelineItem, withOutcome } from "./timeline";
import type { MeshJob, TimelineItem } from "./types";

function Avatar({ kind }: { kind: "user" | "agent" | "err" }): React.ReactElement {
  return <div className={`avatar ${kind}`}>{kind === "user" ? "Y" : kind === "err" ? "!" : "◈"}</div>;
}

/** Compact size hint for a collapsed reasoning block. */
export function thinkingSummary(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const lines = trimmed.split("\n").length;
  return `${lines} 行 · ${trimmed.length} 字`;
}

const ItemView = React.memo(function ItemView({ item }: { item: TimelineItem }): React.ReactElement | null {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg">
          <div className="head">
            <Avatar kind="user" />
            <span>你</span>
            {item.mode && <span className="tag">{item.mode}</span>}
            <span className="tag">{formatClock(item.at)}</span>
          </div>
          <div className="body"><Markdown text={item.text} /></div>
        </div>
      );
    case "assistant":
      return (
        <div className="msg">
          <div className="head">
            <Avatar kind="agent" />
            <span>luban</span>
            <span className="tag">{formatClock(item.at)}</span>
          </div>
          <div className="body"><Markdown text={item.text} /></div>
        </div>
      );
    case "thinking":
      return (
        <details className="thinking-block">
          <summary>
            <span className="bullet">✳</span>
            <span>思考过程</span>
            <span className="tag">{thinkingSummary(item.text)}</span>
          </summary>
          <div className="thinking-body">{item.text}</div>
        </details>
      );
    case "status":
      return <div className="note"><span className="bullet">·</span><span>{item.text}</span></div>;
    case "error":
      return <div className="note error"><span className="bullet">!</span><span>{item.text}</span></div>;
    case "tool":
      return <ToolCard run={item.run} defaultOpen />;
    case "result": {
      const label = item.status === "failed" ? "失败" : item.status === "paused" ? "已暂停" : item.status === "cancelled" ? "已取消" : "完成";
      return (
        <div className={`result ${item.status}`}>
          <div className="result-head"><span className={`dot ${item.status}`} /><span>任务{label}</span><span className="tag">{formatClock(item.at)}</span></div>
          <Markdown text={item.text} />
        </div>
      );
    }
    default:
      return null;
  }
}, (previous, next) => sameTimelineItem(previous.item, next.item));

export function Transcript({ job, events, onCancel, onResume, history, compactEdits, concise }: {
  history?: React.ReactNode;
  compactEdits?: boolean;
  /** 极简模式: tool cards, thinking and narration stay out of the transcript. */
  concise?: boolean;
  job?: MeshJob;
  events: TimelineItem[];
  onCancel: () => void;
  onResume: () => void;
}): React.ReactElement {
  const scroll = useRef<ReturnType<typeof followTranscript> | undefined>(undefined);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!scroller || !content) return;
    const controller = followTranscript(scroller, content);
    scroll.current = controller;
    return () => { controller.dispose(); scroll.current = undefined; };
  }, [scroller, content]);

  // A resumed or freshly opened job shows its newest line first.
  useEffect(() => { scroll.current?.pin(); }, [job?.id]);
  useEffect(() => { scroll.current?.follow(); }, [events, job?.status, history]);

  const active = job ? ["queued", "pending", "working"].includes(job.status) : false;
  // 极简模式 only changes what is rendered: the job keeps every event, so the
  // switch can be turned off mid-run and the full record comes back.
  const shown = useMemo(() => concise ? conciseTimeline(events) : events, [concise, events]);

  return (
    <section className="thread" ref={setScroller}>
      <div className="thread-inner" ref={setContent}>
        {history}
        {!job && !history && (
          <div className="empty">
            <div className="big">◈</div>
            <h1>今天想完成什么？</h1>
            <p>提交任务后由本机 Node Agent 独立执行，工具调用与文件编辑会实时出现在这里。</p>
            <p style={{ marginTop: 10 }}><kbd>Enter</kbd> 执行 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · <kbd>Ctrl</kbd>+<kbd>K</kbd> 新任务</p>
          </div>
        )}
        {job && shown.map(item => compactEdits && item.kind === "tool" && item.run.editPreview
          ? <div className="note" key={item.id}>{item.run.summary || item.run.name} · 修改详情见中间代码区</div>
          : <ItemView key={item.id} item={item} />)}
        {active && (
          <div className="runbar">
            <span className="spin" />
            <span>{concise ? "极简模式 · 正在执行" : "Agent 正在执行"}</span>
            {job?.progress ? <span>· {job.progress}%</span> : null}
            {concise && <span className="hint">过程不写入对话，只保留最终结论</span>}
            <button className="stop" onClick={onCancel}>停止</button>
          </div>
        )}
        {job?.status === "paused" && (
          <div className="runbar">
            <span className="dot paused" />
            <span>任务在步数上限处暂停，保存的历史可以继续</span>
            <button className="action primary" onClick={onResume}>继续任务</button>
          </div>
        )}
      </div>
    </section>
  );
}

export function buildTimeline(job: MeshJob | undefined, events: MeshJob["events"]): TimelineItem[] {
  if (!job) return [];
  const base = deriveTimeline(job, events ?? []);
  return withOutcome(base, job);
}

export function useTimeline(job: MeshJob | undefined): TimelineItem[] {
  return useMemo(() => buildTimeline(job, job?.events), [job]);
}
