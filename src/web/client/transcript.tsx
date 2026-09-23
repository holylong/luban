import React, { useEffect, useMemo, useRef } from "react";
import { Markdown } from "./markdown";
import { ToolCard } from "./tool-card";
import { deriveTimeline, formatClock, withOutcome } from "./timeline";
import type { MeshJob, TimelineItem } from "./types";

function Avatar({ kind }: { kind: "user" | "agent" | "err" }): React.ReactElement {
  return <div className={`avatar ${kind}`}>{kind === "user" ? "Y" : kind === "err" ? "!" : "◈"}</div>;
}

function ItemView({ item }: { item: TimelineItem }): React.ReactElement | null {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg">
          <Avatar kind="user" />
          <div>
            <div className="head">
              <span>你</span>
              {item.mode && <span className="tag">{item.mode}</span>}
              <span className="tag">{formatClock(item.at)}</span>
            </div>
            <div className="body"><Markdown text={item.text} /></div>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="msg">
          <Avatar kind="agent" />
          <div>
            <div className="head"><span>luban</span><span className="tag">{formatClock(item.at)}</span></div>
            <div className="body"><Markdown text={item.text} /></div>
          </div>
        </div>
      );
    case "thinking":
      return <div className="note thinking"><span className="bullet">✳</span><span>{item.text}</span></div>;
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
}

export function Transcript({ job, events, onCancel, onResume }: {
  job?: MeshJob;
  events: TimelineItem[];
  onCancel: () => void;
  onResume: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = (): void => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [events, job?.status]);

  const active = job ? ["queued", "pending", "working"].includes(job.status) : false;

  return (
    <section className="thread" ref={ref}>
      <div className="thread-inner">
        {!job && (
          <div className="empty">
            <div className="big">◈</div>
            <h1>今天想完成什么？</h1>
            <p>提交任务后由本机 Node Agent 独立执行，工具调用与文件编辑会实时出现在这里。</p>
            <p style={{ marginTop: 10 }}><kbd>Enter</kbd> 执行 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · <kbd>Ctrl</kbd>+<kbd>K</kbd> 新任务</p>
          </div>
        )}
        {job && events.map(item => <ItemView key={item.id} item={item} />)}
        {active && (
          <div className="runbar">
            <span className="spin" />
            <span>Agent 正在执行</span>
            {job?.progress ? <span>· {job.progress}%</span> : null}
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
