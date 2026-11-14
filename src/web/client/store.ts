import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { nextFollowableLocalJob } from "./desktop-conversation";
import type {
  ApprovalView, DiffPayload, FileContent, FileEntry, InboxMessage, JobStreamRecord, MeshJob,
  NodeInfo, PeerView, QuestionView, SessionDetail, SessionSummary,
} from "./types";

export type TaskMode = "edits" | "agent" | "read";
export type SideTab = "runs" | "sessions";
export type PreviewTab = "files" | "diff" | "session";

/** Statuses that mean the selected job still owns its session. */
const RUNNING = ["queued", "pending", "working"];

export interface Toast { id: number; text: string; error?: boolean }

function mergeEvents(existing: JobStreamRecord[], incoming: JobStreamRecord[]): JobStreamRecord[] {
  if (!incoming.length) return existing;
  const bySeq = new Map(existing.map(record => [record.seq, record]));
  for (const record of incoming) bySeq.set(record.seq, record);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export interface WorkbenchStore {
  node?: NodeInfo;
  connected: boolean;
  connectionError?: string;
  live: boolean;
  jobs: MeshJob[];
  peers: PeerView[];
  inbox: InboxMessage[];
  sessions: SessionSummary[];
  selectedId?: string;
  /** Saved conversation the next submission continues, if any. */
  activeSessionId?: string;
  job?: MeshJob;
  events: JobStreamRecord[];
  approvals: ApprovalView[];
  questions: QuestionView[];
  toasts: Toast[];
  project: string;
  mode: TaskMode;
  sideTab: SideTab;
  previewTab: PreviewTab;
  tree: FileEntry[];
  treePath: string;
  file?: FileContent;
  fileError?: string;
  diff?: DiffPayload;
  session?: SessionDetail;
  busy: boolean;
  /** Instructions waiting for the running job to settle, in submission order. */
  queued: string[];
  clearQueue: () => void;
  notify: (text: string, error?: boolean) => void;
  dismiss: (id: number) => void;
  selectJob: (id: string) => void;
  startNew: () => void;
  submit: (instruction: string) => Promise<void>;
  cancel: () => Promise<void>;
  resume: () => Promise<void>;
  decide: (id: string, decision: "once" | "tool" | "always" | "deny") => Promise<void>;
  answerQuestion: (id: string, answer: string) => Promise<void>;
  setProject: (project: string) => void;
  /** Switches the active model for subsequent tasks; the server persists it. */
  setModel: (id: string, effort?: import("./types").ReasoningEffort | null) => Promise<void>;
  setMode: (mode: TaskMode) => void;
  setSideTab: (tab: SideTab) => void;
  setPreviewTab: (tab: PreviewTab) => void;
  browse: (sub: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openSession: (id: string) => Promise<void>;
  leaveSession: () => void;
  refreshDiff: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  syncPeer: (direction: "push" | "pull") => Promise<void>;
  messagePeer: (peer: string, text: string) => Promise<void>;
  addContact: (input: { name: string; host: string; port: number; udp_port: number }) => Promise<void>;
}

export function useWorkbench(): WorkbenchStore {
  const [node, setNode] = useState<NodeInfo>();
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [live, setLive] = useState(false);
  const [jobs, setJobs] = useState<MeshJob[]>([]);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [job, setJob] = useState<MeshJob>();
  const [events, setEvents] = useState<JobStreamRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [questions, setQuestions] = useState<QuestionView[]>([]);
  const answeredQuestions = useRef(new Set<string>());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [project, setProjectState] = useState("");
  const [mode, setMode] = useState<TaskMode>("edits");
  const [sideTab, setSideTab] = useState<SideTab>("runs");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("files");
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [treePath, setTreePath] = useState("");
  const [file, setFile] = useState<FileContent>();
  const [fileError, setFileError] = useState<string>();
  const [diff, setDiff] = useState<DiffPayload>();
  const [session, setSession] = useState<SessionDetail>();
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<string[]>([]);
  const toastId = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  selectedRef.current = selectedId;
  const followedLocalJobs = useRef(new Set<string>());
  // Mirrors `queued` so callbacks always read the freshest list.
  const queueRef = useRef<string[]>([]);
  const setQueue = useCallback((next: string[]) => {
    queueRef.current = next;
    setQueued(next);
  }, []);

  const notify = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, error }]);
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), error ? 6000 : 3200);
  }, []);
  const dismiss = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);

  const loadJob = useCallback(async (id: string) => {
    const detail = await api.job(id);
    if (selectedRef.current !== id) return detail;
    setJob(detail);
    setEvents(current => (selectedRef.current === id ? mergeEvents(current, detail.events ?? []) : (detail.events ?? [])));
    setApprovals(detail.approvals ?? []);
    setQuestions((detail.questions ?? []).filter(item => !answeredQuestions.current.has(item.id)));
    return detail;
  }, []);

  const selectJob = useCallback((id: string) => {
    selectedRef.current = id;
    setSelectedId(id);
    setQuestions([]);
    setEvents([]);
    setApprovals([]);
    setJob(undefined);
    void loadJob(id).catch(error => notify(error instanceof Error ? error.message : String(error), true));
  }, [loadJob, notify]);

  const startNew = useCallback(() => {
    selectedRef.current = undefined;
    setSelectedId(undefined);
    setJob(undefined);
    setEvents([]);
    setApprovals([]);
    setSession(undefined);
    setActiveSessionId(undefined);
    queueRef.current = [];
    setQueued([]);
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      // Node/model availability must not depend on peers, jobs or inbox. Each
      // request updates independently, so a slow/failed sidebar cannot disable
      // a perfectly healthy model selector (or hide its actual connection error).
      const [info, , jobList] = await Promise.all([
        api.node().then(info => {
          setNode(info);
          setConnected(true);
          setConnectionError(undefined);
          if (!project) setProjectState(info.project && info.projects?.[info.project] ? info.project : Object.keys(info.projects ?? {})[0] ?? "");
          return info;
        }).catch(error => {
          setConnected(false);
          setConnectionError(error instanceof Error ? error.message : String(error));
          return undefined;
        }),
        api.peers().then(setPeers).catch(() => undefined),
        api.jobs().then(list => { setJobs(list); return list; }).catch(() => undefined),
        api.inbox(20).then(setInbox).catch(() => undefined),
      ]);
      return info ? jobList : undefined;
    } catch (error) {
      setConnected(false);
      setConnectionError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }, [project]);

  const setModel = useCallback(async (id: string, effort?: import("./types").ReasoningEffort | null) => {
    try {
      await api.setModel(id, effort);
      await refreshOverview();
      notify(`模型设置已保存（下一轮生效）`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [notify, refreshOverview]);

  const refreshSessions = useCallback(async () => {
    if (!project) return;
    try { setSessions(await api.sessions(project)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [project, notify]);

  /**
   * Open a run that arrived from the phone or another browser. Selecting the
   * job is not enough: the right column reads the saved session for history, so
   * the session pointer must follow the job too or a later round would sit next
   * to the wrong conversation.
   */
  const followJob = useCallback((next: MeshJob) => {
    selectJob(next.id);
    if (!next.session_id) {
      setSession(undefined);
      setActiveSessionId(undefined);
      return;
    }
    setActiveSessionId(next.session_id);
    const sessionProject = next.project_id || project;
    if (!sessionProject) return;
    void api.session(next.session_id, sessionProject)
      .then(detail => {
        if (selectedRef.current !== next.id) return;
        setSession(detail);
        void refreshSessions();
      })
      .catch(() => undefined);
  }, [project, refreshSessions, selectJob]);

  const browse = useCallback(async (sub: string) => {
    if (!project) return;
    try {
      const reply = await api.workspace(project, sub);
      setTree(reply.tree);
      setTreePath(sub);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [project, notify]);

  const openFile = useCallback(async (path: string) => {
    if (!project) return;
    setPreviewTab("files");
    setFileError(undefined);
    try { setFile(await api.file(project, path)); }
    catch (error) {
      setFile(undefined);
      setFileError(error instanceof Error ? error.message : String(error));
    }
  }, [project]);

  const openSession = useCallback(async (id: string) => {
    if (!project) return;
    setPreviewTab("session");
    try {
      const detail = await api.session(id, project);
      setSession(detail);
      setActiveSessionId(detail.id);
      const related = jobs.filter(item => item.session_id === detail.id).sort((a, b) => b.created_at - a.created_at)[0];
      if (related) selectJob(related.id);
      else { selectedRef.current = undefined; setSelectedId(undefined); setJob(undefined); setEvents([]); setApprovals([]); setQuestions([]); }
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [project, notify, jobs, selectJob]);

  const leaveSession = startNew;

  const refreshDiff = useCallback(async () => {
    if (!project) return;
    setPreviewTab("diff");
    try { setDiff(await api.diff(project)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [project, notify]);

  const dispatch = useCallback(async (instruction: string) => {
    setBusy(true);
    try {
      const reply = await api.submit({
        instruction, project_id: project, mode, interaction: "on",
        ...(activeSessionId ? { session_id: activeSessionId } : {}),
      });
      // This window opens its own submission explicitly; do not let the
      // follow effect mistake it for a phone run and clear the session pointer.
      followedLocalJobs.current.add(reply.job_id);
      if (!reply.interactive) notify("服务器未启用交互审批：本任务按自动放行执行");
      await refreshOverview();
      selectJob(reply.job_id);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  }, [project, mode, activeSessionId, notify, refreshOverview, selectJob]);

  const submit = useCallback(async (instruction: string) => {
    const text = instruction.trim();
    if (!text) return;
    // A running job owns the session; keep the instruction instead of dropping it.
    if (job && RUNNING.includes(job.status)) {
      setQueue([...queueRef.current, text]);
      notify(`已排入队列（${queueRef.current.length + 1} 条），本轮结束后自动继续`);
      return;
    }
    await dispatch(text);
  }, [job, dispatch, notify, setQueue]);

  const clearQueue = useCallback(() => setQueue([]), [setQueue]);

  const cancel = useCallback(async () => {
    if (!selectedId) return;
    try { await api.cancel(selectedId); notify("已请求取消任务"); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [selectedId, notify]);

  const resume = useCallback(async () => {
    if (!selectedId) return;
    try { await api.resume(selectedId); notify("任务已重新排队"); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [selectedId, notify]);

  const decide = useCallback(async (id: string, decision: "once" | "tool" | "always" | "deny") => {
    try {
      await api.decide(id, decision);
      setApprovals(current => current.filter(item => item.id !== id));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [notify]);

  const answerQuestion = useCallback(async (id: string, answer: string) => {
    try {
      await api.answerQuestion(id, answer);
      answeredQuestions.current.add(id);
      setQuestions(current => current.filter(item => item.id !== id));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [notify]);

  const setProject = useCallback((next: string) => {
    setProjectState(next);
    setFile(undefined);
    setDiff(undefined);
    setSession(undefined);
    setActiveSessionId(undefined);
    setTree([]);
    setTreePath("");
  }, []);

  const syncPeer = useCallback(async (direction: "push" | "pull") => {
    const peer = peers[0]?.name;
    if (!peer) { notify("没有可用的 mesh 节点", true); return; }
    try {
      const reply = await api.sync({ peer, direction, project_id: project, mode: "auto" });
      notify(reply.output || `${direction} 完成`);
      await refreshDiff();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [peers, project, notify, refreshDiff]);

  const messagePeer = useCallback(async (peer: string, text: string) => {
    if (!peer) { notify("请选择节点", true); return; }
    try {
      const reply = await api.chat(peer, text);
      notify(reply.output || "消息已送达");
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [notify]);

  const addContact = useCallback(async (input: { name: string; host: string; port: number; udp_port: number }) => {
    try {
      await api.addContact(input);
      notify("联系人已保存");
      await refreshOverview();
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [notify, refreshOverview]);

  // Initial load.
  useEffect(() => { void refreshOverview(); }, [refreshOverview]);
  useEffect(() => { if (project) void browse(""); }, [project, browse]);
  useEffect(() => { if (project && sideTab === "sessions") void refreshSessions(); }, [project, sideTab, refreshSessions]);

  // A phone or another browser can start a run in the conversation this window
  // has open. Follow that local run once, unless the operator is already busy
  // with one in this window.
  useEffect(() => {
    if (!project) return;
    const next = nextFollowableLocalJob(jobs, node?.name, job, followedLocalJobs.current, project);
    if (!next) return;
    followedLocalJobs.current.add(next.id);
    followJob(next);
  }, [jobs, node?.name, job?.id, job?.status, project, followJob]);

  // Periodic reconciliation: the stream carries the live detail, polling is the
  // safety net for missed frames and for peers/jobs that changed elsewhere.
  useEffect(() => {
    const timer = setInterval(() => {
      void refreshOverview().then(list => {
        const active = list?.find(item => item.id === selectedRef.current);
        if (active && selectedRef.current) {
          const known = job?.updated_at ?? 0;
          if (active.updated_at !== known) void loadJob(selectedRef.current);
        }
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [refreshOverview, loadJob, job?.updated_at]);

  // Live event stream, with the per-job stream as the replay path on reconnect.
  useEffect(() => {
    let source: EventSource | undefined;
    let stopped = false;
    const handleJobEvent = (data: { id: string; seq: number; event: JobStreamRecord["event"] }) => {
      if (data.id !== selectedRef.current) return;
      setEvents(current => mergeEvents(current, [{ seq: data.seq, at: Date.now() / 1000, event: data.event }]));
    };
    const handleJob = (next: MeshJob) => {
      setJobs(current => {
        const index = current.findIndex(item => item.id === next.id);
        if (index < 0) return [next, ...current];
        const copy = [...current];
        copy[index] = next;
        return copy;
      });
      if (next.id === selectedRef.current) {
        setJob(current => ({ ...(current ?? next), ...next }));
        if (!["queued", "pending", "working"].includes(next.status)) {
          void loadJob(next.id).catch(() => undefined);
        }
      }
    };
    const connect = (): void => {
      if (stopped) return;
      source = new EventSource("/api/events");
      source.onopen = () => {
        setLive(true);
        const id = selectedRef.current;
        if (id) void api.jobStream(id, events.at(-1)?.seq ?? 0)
          .then(reply => setEvents(current => mergeEvents(current, reply.events)))
          .catch(() => undefined);
      };
      source.onerror = () => { setLive(false); };
      source.addEventListener("job-event", message => {
        try { handleJobEvent(JSON.parse((message as MessageEvent).data)); } catch { /* ignore malformed frame */ }
      });
      source.addEventListener("job", message => {
        try { handleJob(JSON.parse((message as MessageEvent).data) as MeshJob); } catch { /* ignore */ }
      });
      source.addEventListener("chat", message => {
        try {
          const payload = JSON.parse((message as MessageEvent).data) as { message: InboxMessage };
          setInbox(current => [payload.message, ...current].slice(0, 50));
          notify(`📨 ${payload.message.from}: ${payload.message.text}`);
        } catch { /* ignore */ }
      });
      source.addEventListener("peer", () => { void refreshOverview(); });
    };
    connect();
    return () => { stopped = true; source?.close(); setLive(false); };
    // Reconnecting only depends on the selected job; `events` is read through a
    // ref-like closure at connect time and must not retrigger the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadJob, notify, refreshOverview]);

  // A continuation job writes into the same transcript; mirror it once it settles.
  useEffect(() => {
    if (!project) return;
    if (!activeSessionId && job?.session_id) { setActiveSessionId(job.session_id); return; }
    if (!activeSessionId) return;
    if (job && ["queued", "pending", "working"].includes(job.status) && session) return;
    if (job?.session_id && job.session_id !== activeSessionId) return;
    let active = true;
    api.session(activeSessionId, project)
      .then(next => { if (active) { setSession(next); void refreshSessions(); } })
      .catch(() => undefined);
    return () => { active = false; };
  }, [activeSessionId, project, job?.status, job?.updated_at, job?.session_id, refreshSessions]);

  // Queued instructions run once the current job settles; only a status change
  // triggers a dispatch so a draft added mid-run is not sent concurrently.
  const settled = useRef<string | undefined>(undefined);
  useEffect(() => {
    const state = job ? `${job.id}:${job.status}` : "none";
    if (state === settled.current) return;
    settled.current = state;
    if (job && RUNNING.includes(job.status)) return;
    const next = queueRef.current[0];
    if (!next) return;
    setQueue(queueRef.current.slice(1));
    void dispatch(next);
  }, [job?.id, job?.status, dispatch, setQueue]);

  // A job names its session a moment after it settles (the model writes the
  // title), so the list is refreshed once more than the immediate sync would.
  useEffect(() => {
    if (!job || RUNNING.includes(job.status)) return;
    if (sideTab !== "sessions") return;
    const timer = setTimeout(() => { void refreshSessions(); }, 4000);
    return () => clearTimeout(timer);
  }, [job?.id, job?.status, sideTab, refreshSessions]);

  // Approval prompts refresh alongside the stream, since they arrive out of band.
  useEffect(() => {
    if (!selectedId) { setApprovals([]); setQuestions([]); return; }
    let active = true;
    const tick = async (): Promise<void> => {
      try {
        const [list, pendingQuestions] = await Promise.all([api.approvals(selectedId), api.questions(selectedId)]);
        if (active && selectedRef.current === selectedId) {
          setApprovals(list);
          setQuestions(pendingQuestions.filter(item => !answeredQuestions.current.has(item.id)));
        }
      } catch { /* transient */ }
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [selectedId]);

  return useMemo<WorkbenchStore>(() => ({
    node, connected, connectionError, live, jobs, peers, inbox, sessions, selectedId, activeSessionId, job, events, approvals, questions, toasts,
    project, mode, sideTab, previewTab, tree, treePath, file, fileError, diff, session, busy, queued,
    notify, dismiss, selectJob, startNew, submit, clearQueue, cancel, resume, decide, answerQuestion,
    setProject, setModel, setMode, setSideTab, setPreviewTab, browse, openFile, openSession, leaveSession,
    refreshDiff, refreshSessions, syncPeer, messagePeer, addContact,
  }), [
    node, connected, connectionError, live, jobs, peers, inbox, sessions, selectedId, activeSessionId, job, events, approvals, questions, toasts,
    project, mode, sideTab, previewTab, tree, treePath, file, fileError, diff, session, busy, queued,
    notify, dismiss, selectJob, startNew, submit, clearQueue, cancel, resume, decide, answerQuestion,
    setProject, setModel, browse, openFile, openSession, leaveSession, refreshDiff, refreshSessions, syncPeer, messagePeer, addContact,
  ]);
}

export { ApiError };
