import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, setNodeScope } from "./api";
import type { ApprovalView, JobStreamRecord, MeshJob, NodeInfo, QuestionView, ToolRun } from "./types";
import {
  deriveTimeline, editRecordStats, formatDuration, liveProgress, parseEditRecord,
  relativeTime, STATUS_LABELS, toolLabel, withOutcome,
} from "./timeline";

/**
 * Phone console.
 *
 * It talks to the same HTTP API as the desktop workbench, so "multi-device"
 * means one job queue and one session store rather than a second, parallel
 * view of the work. Two callers exist: the local web server (`luban web`, LAN)
 * and the relay (`luban relay`, public) which forwards to the node over the
 * tunnel. The relay adds `/relay/nodes`; its presence is how this page knows
 * which of the two it is talking to.
 */

type Tab = "live" | "jobs" | "approvals" | "settings";
type TaskMode = "edits" | "agent" | "read";

interface RelayNode {
  id: string;
  name: string;
  version: string;
  workspace: string;
  projects: Record<string, string>;
  online: boolean;
  last_seen: number;
  connected_at: number;
}

interface Toast { id: number; text: string; error?: boolean }

const MODE_LABELS: Record<TaskMode, string> = { edits: "可改文件", agent: "可执行", read: "只读" };
const JOB_KEY = "luban.mobile.job";
const NODE_KEY = "luban.mobile.node";

function initialNodeScope(): string | undefined {
  const linkedNode = new URLSearchParams(window.location.search).get("node") || undefined;
  if (linkedNode) localStorage.setItem(NODE_KEY, linkedNode);
  return linkedNode || localStorage.getItem(NODE_KEY) || undefined;
}

function mergeEvents(existing: JobStreamRecord[], incoming: JobStreamRecord[]): JobStreamRecord[] {
  if (!incoming.length) return existing;
  const bySeq = new Map(existing.map(record => [record.seq, record]));
  for (const record of incoming) bySeq.set(record.seq, record);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function nameClass(name: string): string {
  if (name === "bash") return "bash";
  if (/^(edit_file|write_file|apply_patch)$/u.test(name)) return "edit";
  if (/^(read_file|list_dir|glob_files|grep_files|read_image)$/u.test(name)) return "read";
  return "";
}

/** Inline execution record, sized down for a phone (line numbers, no syntax colors). */
function EditLines({ preview }: { preview: string }): React.ReactElement {
  const rows = useMemo(() => parseEditRecord(preview), [preview]);
  const stats = useMemo(() => editRecordStats(rows), [rows]);
  return (
    <div>
      <div className="m-tool-head" style={{ paddingBottom: 6 }}>
        <span className="m-tool-summary" style={{ color: "var(--fg)" }}>{stats.path || "unknown file"}</span>
        <span className="m-chip done">+{stats.added}</span>
        <span className="m-chip failed">−{stats.removed}</span>
      </div>
      <div className="m-edit-lines">
        {rows.filter(row => row.kind !== "header").map((row, index) => row.kind === "meta"
          ? <div className="m-edit-line" key={index}><span className="no" /><span className="txt" style={{ color: "var(--dim)" }}>{row.text}</span></div>
          : (
            <div className={`m-edit-line ${row.kind === "add" ? "add" : row.kind === "remove" ? "del" : ""}`} key={index}>
              <span className="no">{row.line ?? ""}</span>
              <span className="txt">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}{row.text}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

function ToolCard({ run, open, onToggle }: {
  run: ToolRun;
  open: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const hasBody = Boolean(run.editPreview || run.preview);
  const label = run.status === "running" ? "执行中"
    : run.status === "failed" ? `失败${run.elapsedMs === undefined ? "" : ` · ${formatDuration(run.elapsedMs)}`}`
      : `完成${run.elapsedMs === undefined ? "" : ` · ${formatDuration(run.elapsedMs)}`}`;
  return (
    <div className={`m-tool ${run.status}`}>
      <button className="m-tool-head" style={{ width: "100%", border: 0, background: "transparent", textAlign: "left" }} onClick={onToggle} aria-expanded={open}>
        <span className={`m-tool-name ${nameClass(run.name)}`}>{toolLabel(run.name)}</span>
        <span className="m-tool-summary">{run.summary || run.name}</span>
        <span className={`m-tool-status ${run.status === "done" ? "ok" : run.status === "failed" ? "bad" : ""}`}>{label}</span>
        <span style={{ color: "var(--dim)" }}>{hasBody ? (open ? "▾" : "▸") : ""}</span>
      </button>
      {open && hasBody && (
        run.editPreview
          ? <EditLines preview={run.editPreview} />
          : <pre className="m-tool-preview">{run.name === "bash" && run.args.command ? `$ ${String(run.args.command)}\n${run.preview ?? ""}` : run.preview}</pre>
      )}
    </div>
  );
}

const ACTIVE_STATUS = new Set(["queued", "pending", "working"]);

export function MobileApp(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("live");
  const [relayMode, setRelayMode] = useState(false);
  const [relayNodes, setRelayNodes] = useState<RelayNode[]>([]);
  const [scope, setScope] = useState<string | undefined>(initialNodeScope);
  const [node, setNode] = useState<NodeInfo | undefined>();
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | undefined>();
  const [live, setLive] = useState(false);
  const [jobs, setJobs] = useState<MeshJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => localStorage.getItem(JOB_KEY) || undefined);
  const [job, setJob] = useState<MeshJob | undefined>();
  const [events, setEvents] = useState<JobStreamRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [project, setProject] = useState("");
  const [mode, setMode] = useState<TaskMode>("edits");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [clock, setClock] = useState(() => Date.now() / 1000);
  const toastId = useRef(0);
  const selectedRef = useRef<string | undefined>(selectedId);
  selectedRef.current = selectedId;

  const notify = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, error }]);
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), error ? 6000 : 3200);
  }, []);

  // Every API call, including the SSE stream, is pinned to the chosen node.
  useEffect(() => { setNodeScope(scope); }, [scope]);

  const loadJob = useCallback(async (id: string) => {
    const detail = await api.job(id);
    setJob(detail);
    setApprovals(current => {
      // Keep the approvals of other jobs so the tab badge stays truthful.
      const others = current.filter(item => item.job_id !== id);
      return [...others, ...(detail.approvals ?? [])];
    });
    setEvents(current => (selectedRef.current === id ? mergeEvents(current, detail.events ?? []) : (detail.events ?? [])));
    return detail;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [info, jobList] = await Promise.all([api.node(), api.jobs()]);
      setNode(info);
      setConnected(true);
      setConnectionError(undefined);
      setJobs(jobList);
      // The job list is polled even when the SSE connection drops. Keep the
      // selected job's status in sync so a missed completion cannot spin forever.
      const selected = jobList.find(item => item.id === selectedRef.current);
      if (selected) setJob(current => current?.id === selected.id ? { ...current, ...selected } : current);
      setProject(current => current || (info.projects && Object.keys(info.projects).length ? Object.keys(info.projects)[0]! : ""));
    } catch (error) {
      setConnected(false);
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshRelayNodes = useCallback(async () => {
    try {
      const response = await fetch("/relay/nodes");
      if (!response.ok) { setRelayMode(false); return; }
      const payload = await response.json() as { ok?: boolean; nodes?: RelayNode[] };
      if (!payload?.ok) { setRelayMode(false); return; }
      setRelayMode(true);
      setRelayNodes(payload.nodes ?? []);
    } catch {
      setRelayMode(false);
    }
  }, []);

  const refreshApprovals = useCallback(async () => {
    try {
      const [pendingApprovals, pendingQuestions] = await Promise.all([api.approvals(), api.questions()]);
      setApprovals(pendingApprovals);
      setQuestions(pendingQuestions);
    }
    catch { /* transient */ }
  }, []);

  // Initial load: relay detection first, because it decides whether a node has
  // to be selected before any other call can succeed.
  useEffect(() => {
    void (async () => {
      await refreshRelayNodes();
      await refresh();
      const id = selectedRef.current;
      if (id) await loadJob(id).catch(() => { localStorage.removeItem(JOB_KEY); setSelectedId(undefined); });
      await refreshApprovals();
    })();
  }, [refreshRelayNodes, refresh, loadJob, refreshApprovals]);

  // Keep polling: the stream carries the detail, polling is the safety net for
  // a phone that was asleep, changed networks, or lost a frame.
  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
      void refreshApprovals();
      if (relayMode) void refreshRelayNodes();
    }, 4000);
    return () => clearInterval(timer);
  }, [refresh, refreshApprovals, refreshRelayNodes, relayMode]);

  // Live stream.
  useEffect(() => {
    let source: EventSource | undefined;
    let stopped = false;
    const streamUrl = scope ? `/api/events?node=${encodeURIComponent(scope)}` : "/api/events";
    const connect = (): void => {
      if (stopped) return;
      source = new EventSource(streamUrl);
      source.onopen = () => {
        setLive(true);
        const id = selectedRef.current;
        if (id) void api.jobStream(id, events.at(-1)?.seq ?? 0).then(reply => setEvents(current => mergeEvents(current, reply.events))).catch(() => undefined);
      };
      source.onerror = () => setLive(false);
      source.addEventListener("job-event", message => {
        try {
          const data = JSON.parse((message as MessageEvent).data) as { id: string; seq: number; event: JobStreamRecord["event"] };
          if (data.id !== selectedRef.current) return;
          setEvents(current => mergeEvents(current, [{ seq: data.seq, at: Date.now() / 1000, event: data.event }]));
        } catch { /* malformed frame */ }
      });
      source.addEventListener("job", message => {
        try {
          const { job: next } = JSON.parse((message as MessageEvent).data) as { job: MeshJob };
          if (!next?.id) return;
          setJobs(current => {
            const index = current.findIndex(item => item.id === next.id);
            if (index < 0) return [next, ...current];
            const copy = [...current];
            copy[index] = next;
            return copy;
          });
          if (next.id !== selectedRef.current) return;
          setJob(current => ({ ...(current ?? next), ...next }));
          if (!ACTIVE_STATUS.has(next.status)) void loadJob(next.id).catch(() => undefined);
        } catch { /* ignore */ }
      });
      source.addEventListener("chat", message => {
        try {
          const payload = JSON.parse((message as MessageEvent).data) as { message: { from: string; text: string } };
          notify(`📨 ${payload.message.from}: ${payload.message.text}`);
        } catch { /* ignore */ }
      });
    };
    connect();
    return () => { stopped = true; source?.close(); setLive(false); };
    // Reconnecting depends only on the selected node; `events` is read at connect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, loadJob, notify]);

  // One-second clock, only while something is running, for the live elapsed time.
  const running = Boolean(job && ACTIVE_STATUS.has(job.status));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const progress = useMemo(() => (running ? liveProgress(events, clock) : null), [running, events, clock]);
  const pendingApprovals = approvals;
  const pendingQuestions = questions;
  const answerQuestion = async (id: string, answer: string): Promise<void> => {
    try {
      await api.answerQuestion(id, answer);
      setQuestions(current => current.filter(item => item.id !== id));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  };
  const items = useMemo(() => (job ? withOutcome(deriveTimeline(job, events), job) : []), [job, events]);

  // A finished task is the one thing a phone should notice without watching.
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const status = job?.status;
    if (!status || status === lastStatus.current) return;
    const previous = lastStatus.current;
    lastStatus.current = status;
    if (!previous || ACTIVE_STATUS.has(status)) return;
    if (status === "done") notify("✅ 任务已完成");
    else if (status === "failed") notify("❌ 任务失败", true);
    else if (status === "paused") notify("⏸ 任务已暂停，可继续");
    if (document.hidden) {
      navigator.vibrate?.(status === "done" ? 120 : [80, 60, 80]);
      document.title = `${status === "done" ? "✅" : status === "failed" ? "❌" : "⏸"} luban`;
    }
  }, [job?.status, notify]);

  const selectJob = useCallback((id: string) => {
    setSelectedId(id);
    localStorage.setItem(JOB_KEY, id);
    setJob(undefined);
    setEvents([]);
    void loadJob(id).catch(error => notify(error instanceof Error ? error.message : String(error), true));
    setTab("live");
  }, [loadJob, notify]);

  const submit = useCallback(async () => {
    const instruction = draft.trim();
    if (!instruction) return;
    setBusy(true);
    try {
      const reply = await api.submit({ instruction, project_id: project, mode, interaction: "on" });
      setDraft("");
      await refresh();
      selectJob(reply.job_id);
      if (!reply.interactive) notify("服务器未启用交互审批：本任务按自动放行执行");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  }, [draft, project, mode, refresh, selectJob, notify]);

  const cancel = useCallback(async () => {
    if (!selectedId) return;
    try { await api.cancel(selectedId); notify("已请求取消任务"); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [selectedId, notify]);

  const resume = useCallback(async () => {
    if (!selectedId) return;
    try { await api.resume(selectedId); notify("任务已继续"); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [selectedId, notify]);

  const decide = useCallback(async (id: string, decision: "once" | "tool" | "always" | "deny") => {
    try {
      await api.decide(id, decision);
      setApprovals(current => current.filter(item => item.id !== id));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [notify]);

  const chooseNode = useCallback((id: string) => {
    setScope(id || undefined);
    if (id) localStorage.setItem(NODE_KEY, id);
    else localStorage.removeItem(NODE_KEY);
    setJob(undefined);
    setEvents([]);
  }, []);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(132, element.scrollHeight)}px`;
  }, [draft]);

  const dotClass = !connected ? "offline" : running ? "working" : live ? "online" : "offline";
  const nodeLabel = node ? `${node.name}${node.model ? ` · ${node.model}` : ""}` : connectionError ? "未连接" : "连接中";
  const activeJobs = jobs.filter(item => ACTIVE_STATUS.has(item.status)).length;

  return (
    <div className="m-app">
      <header className="m-head">
        <div className="m-head-row">
          <span className={`m-dot ${dotClass}`} />
          <span className="m-brand">luban</span>
          <span className="m-head-meta">{nodeLabel}</span>
          {relayNodes.length > 1 && (
            <select value={scope ?? ""} onChange={event => chooseNode(event.target.value)} aria-label="选择节点">
              {relayNodes.map(item => (
                <option key={item.id} value={item.id}>{item.online ? "● " : "○ "}{item.name}</option>
              ))}
            </select>
          )}
          {relayNodes.length === 1 && <span className="m-chip done" style={{ marginLeft: "auto" }}>{relayNodes[0]!.online ? "在线" : "离线"}</span>}
        </div>
        <div className="m-head-meta">
          {job ? `${job.title || job.id} · ${STATUS_LABELS[job.status] ?? job.status}` : node?.workspace || "未选择任务"}
          {activeJobs > 1 ? ` · ${activeJobs} 个进行中` : ""}
        </div>
      </header>

      <main className="m-main">
        {relayMode && relayNodes.length === 0 && (
          <div className="m-banner warn">
            本机 luban 还没有连上中继。在电脑上运行：
            <pre style={{ margin: "8px 0 0", font: "11.5px var(--mono)", whiteSpace: "pre-wrap" }}>luban web --relay {location.origin} --token &lt;节点令牌&gt;</pre>
          </div>
        )}
        {!connected && connectionError && relayMode && relayNodes.length > 0 && (
          <div className="m-banner warn">连接失败：{connectionError}<div className="m-banner-actions"><button className="m-btn" onClick={() => void refresh()}>重试</button></div></div>
        )}

        {tab === "live" && (
          <>
            {pendingApprovals.length + pendingQuestions.length > 0 && (
              <div className="m-banner">
                ⚠️ 有 {pendingApprovals.length + pendingQuestions.length} 个问题或操作等待回应
                <div className="m-banner-actions">
                  <button className="m-btn primary" onClick={() => setTab("approvals")}>去处理</button>
                </div>
              </div>
            )}
            {progress && (
              <div className={`m-live ${progress.stalled ? "stalled" : ""}`}>
                <span className="m-spin" />
                <span className="label">{progress.label}</span>
                <span className="detail">{progress.stalled ? `已 ${progress.silentSeconds}s 无输出` : progress.detail}</span>
                <span className="clock">{progress.seconds}s</span>
              </div>
            )}
            {!job && (
              <div className="m-empty">
                <h2>手机上派活，电脑上干活</h2>
                <p>在下方输入指令，本机的 luban 会执行；这里实时显示推理、工具调用和文件改动。</p>
              </div>
            )}
            {job && (
              <>
                <div className="m-row">
                  {ACTIVE_STATUS.has(job.status) && <button className="m-btn danger" onClick={() => void cancel()}>取消任务</button>}
                  {job.status === "paused" && <button className="m-btn primary" onClick={() => void resume()}>继续任务</button>}
                  <button className="m-btn" onClick={() => { void loadJob(job.id).catch(() => undefined); }}>刷新</button>
                </div>
                <div>
                  {items.map(item => {
                    if (item.kind === "user") {
                      return (
                        <div className="m-turn" key={item.id}>
                          <div className="m-turn-head"><span>我</span><span>{relativeTime(item.at)}前</span>{item.mode && <span className="m-chip">{MODE_LABELS[item.mode as TaskMode] ?? item.mode}</span>}</div>
                          <div className="m-turn-user">{item.text}</div>
                        </div>
                      );
                    }
                    if (item.kind === "tool") {
                      return <ToolCard key={item.id} run={item.run} open={openTools[item.run.callId] ?? false} onToggle={() => setOpenTools(current => ({ ...current, [item.run.callId]: !(current[item.run.callId] ?? false) }))} />;
                    }
                    if (item.kind === "thinking") {
                      return <details className="m-turn m-thinking" key={item.id}>
                        <summary>💭 思考过程</summary>
                        <div className="m-body think">{item.text}</div>
                      </details>;
                    }
                    if (item.kind === "assistant") {
                      return <div className="m-turn" key={item.id}><div className="m-body">{item.text}</div></div>;
                    }
                    if (item.kind === "status") {
                      return <div className="m-turn" key={item.id}><div className="m-body muted">· {item.text}</div></div>;
                    }
                    if (item.kind === "error") {
                      return <div className="m-turn" key={item.id}><div className="m-body error">✗ {item.text}</div></div>;
                    }
                    return (
                      <div className="m-turn" key={item.id}>
                        <div className="m-turn-head"><span>{STATUS_LABELS[item.status] ?? item.status}</span><span>{relativeTime(item.at)}前</span></div>
                        <div className={`m-body result ${item.status === "failed" || item.status === "cancelled" ? "failed" : ""}`}>{item.text}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {tab === "jobs" && (
          <>
            {jobs.length === 0 && <div className="m-empty"><h2>还没有任务</h2><p>输入指令后，任务会出现在这里。</p></div>}
            {jobs.map(item => (
              <button className={`m-job ${item.id === selectedId ? "active" : ""}`} key={item.id} onClick={() => selectJob(item.id)}>
                <div className="m-job-title">{item.title || item.instruction || item.id}</div>
                <div className="m-job-meta">
                  <span className={`m-chip ${item.status}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
                  <span>{relativeTime(item.created_at)}前</span>
                  <span>{item.project_id}</span>
                  {(item.resume_count ?? 0) > 0 && <span>继续 {item.resume_count} 次</span>}
                </div>
              </button>
            ))}
          </>
        )}

        {tab === "approvals" && (
          <>
            {pendingApprovals.length + pendingQuestions.length === 0 && <div className="m-empty"><h2>没有待回答的请求</h2><p>Agent 需要你的决定时会在这里询问。</p></div>}
            {pendingQuestions.map(item => <div className="m-approval" key={item.id}>
              <h3>{item.question}</h3>
              <div className="risk">任务 {item.job_id}</div>
              <div className="m-approval-actions">
                {item.options.map(option => <button className="m-btn" key={option.label}
                  title={option.description} onClick={() => void answerQuestion(item.id, option.label)}>
                  {option.label}{option.description ? ` · ${option.description}` : ""}
                </button>)}
              </div>
              <div className="m-approval-actions">
                <input className="m-input" aria-label="自定义回答" placeholder="或输入自己的答案"
                  value={questionDrafts[item.id] ?? ""}
                  onChange={event => setQuestionDrafts(current => ({ ...current, [item.id]: event.target.value }))} />
                <button className="m-btn primary" disabled={!(questionDrafts[item.id] ?? "").trim()}
                  onClick={() => void answerQuestion(item.id, questionDrafts[item.id] ?? "")}>发送</button>
              </div>
            </div>)}
            {pendingApprovals.map(item => (
              <div className="m-approval" key={item.id}>
                <h3>{toolLabel(item.tool)}</h3>
                <div className="risk">风险：{item.risk} · 任务 {item.job_id}</div>
                <pre>{JSON.stringify(item.args, null, 2)}</pre>
                <div className="m-approval-actions">
                  <button className="m-btn primary" onClick={() => void decide(item.id, "once")}>允许一次</button>
                  <button className="m-btn ok" onClick={() => void decide(item.id, "always")}>本会话允许</button>
                  <button className="m-btn" onClick={() => void decide(item.id, "tool")}>该工具都允许</button>
                  <button className="m-btn danger" onClick={() => void decide(item.id, "deny")}>拒绝</button>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === "settings" && (
          <>
            <div className="m-card">
              <h3>连接</h3>
              <dl className="m-kv">
                <dt>模式</dt><dd>{relayMode ? "中继（公网）" : "直连（局域网）"}</dd>
                <dt>节点</dt><dd>{node?.name || "—"}</dd>
                <dt>工作区</dt><dd>{node?.workspace || "—"}</dd>
                <dt>模型</dt><dd>{node?.model || "—"}</dd>
                <dt>版本</dt><dd>v{node?.version || "—"}</dd>
                <dt>实时流</dt><dd>{live ? "已连接" : "断开"}</dd>
              </dl>
            </div>
            {relayMode && (
              <div className="m-card">
                <h3>中继节点</h3>
                {relayNodes.length === 0 && <p className="m-note">还没有节点连上中继。</p>}
                {relayNodes.map(item => (
                  <button key={item.id} className={`m-job ${item.id === scope ? "active" : ""}`} onClick={() => chooseNode(item.id)}>
                    <div className="m-job-title">{item.online ? "● " : "○ "}{item.name}</div>
                    <div className="m-job-meta"><span>{item.workspace || "—"}</span><span>v{item.version}</span></div>
                  </button>
                ))}
              </div>
            )}
            <div className="m-card">
              <h3>本机页面</h3>
              <p className="m-note">同一个任务队列也可以从电脑浏览器打开。</p>
              <div className="m-row" style={{ marginTop: 10, marginBottom: 0 }}>
                <a className="m-btn" style={{ textAlign: "center", textDecoration: "none" }} href="/">桌面工作台</a>
                <a className="m-btn" style={{ textAlign: "center", textDecoration: "none" }} href="/diff">代码变更</a>
              </div>
            </div>
            <div className="m-card">
              <h3>使用提示</h3>
              <p className="m-note">在浏览器菜单里选择「添加到主屏幕」，即可像 App 一样全屏打开，并保留登录状态。</p>
              <div className="m-row" style={{ marginTop: 10, marginBottom: 0 }}>
                <a className="m-btn" style={{ textAlign: "center", textDecoration: "none" }} href="/logout">退出登录</a>
              </div>
            </div>
          </>
        )}
      </main>

      <div className="m-compose">
        <div className="m-compose-box">
          <textarea
            ref={composerRef}
            value={draft}
            rows={1}
            placeholder={job && ACTIVE_STATUS.has(job.status) ? "补充指令，Agent 会在下一步执行" : "让本机 Agent 做什么？"}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
            }}
          />
          <button className="m-send" disabled={busy || !draft.trim() || !node} onClick={() => void submit()} aria-label="发送">↑</button>
        </div>
        <div className="m-compose-hint">
          <select value={project} onChange={event => setProject(event.target.value)} aria-label="项目">
            {Object.keys(node?.projects ?? {}).length === 0 && <option value="">默认工作区</option>}
            {Object.entries(node?.projects ?? {}).map(([name, path]) => <option key={name} value={name}>{name} · {String(path).split(/[\\/]/u).pop()}</option>)}
          </select>
          <select value={mode} onChange={event => setMode(event.target.value as TaskMode)} aria-label="权限">
            {(Object.keys(MODE_LABELS) as TaskMode[]).map(key => <option key={key} value={key}>{MODE_LABELS[key]}</option>)}
          </select>
          <span style={{ marginLeft: "auto" }}>{node?.interactive ? "可审批" : "自动放行"}</span>
        </div>
      </div>

      <nav className="m-tabs">
        <button className={`m-tab ${tab === "live" ? "active" : ""}`} onClick={() => setTab("live")}>
          <span className="icon">◈</span><span>状态</span>
        </button>
        <button className={`m-tab ${tab === "jobs" ? "active" : ""}`} onClick={() => setTab("jobs")}>
          <span className="icon">≡</span><span>任务</span>
          {activeJobs > 0 && <span className="m-badge">{activeJobs}</span>}
        </button>
        <button className={`m-tab ${tab === "approvals" ? "active" : ""}`} onClick={() => setTab("approvals")}>
          <span className="icon">⚠</span><span>交互</span>
          {pendingApprovals.length + pendingQuestions.length > 0 && <span className="m-badge">{pendingApprovals.length + pendingQuestions.length}</span>}
        </button>
        <button className={`m-tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}>
          <span className="icon">⚙</span><span>设置</span>
        </button>
      </nav>

      {toasts.length > 0 && (
        <div className="m-toasts">
          {toasts.map(toast => <div className={`m-toast ${toast.error ? "error" : ""}`} key={toast.id} onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}>{toast.text}</div>)}
        </div>
      )}
    </div>
  );
}
