import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type {
  ApprovalView, DiffPayload, FileContent, FileEntry, InboxMessage, JobStreamRecord, MeshJob,
  NodeInfo, PeerView, QuestionView, SessionDetail, SessionSummary,
} from "./types";

export type TaskMode = "edits" | "agent" | "read";
export type SideTab = "runs" | "sessions";
export type PreviewTab = "files" | "diff" | "session";

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
  live: boolean;
  jobs: MeshJob[];
  peers: PeerView[];
  inbox: InboxMessage[];
  sessions: SessionSummary[];
  selectedId?: string;
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
  setMode: (mode: TaskMode) => void;
  setSideTab: (tab: SideTab) => void;
  setPreviewTab: (tab: PreviewTab) => void;
  browse: (sub: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  openSession: (id: string) => Promise<void>;
  refreshDiff: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  syncPeer: (direction: "push" | "pull") => Promise<void>;
  messagePeer: (peer: string, text: string) => Promise<void>;
  addContact: (input: { name: string; host: string; port: number; udp_port: number }) => Promise<void>;
}

export function useWorkbench(): WorkbenchStore {
  const [node, setNode] = useState<NodeInfo>();
  const [connected, setConnected] = useState(false);
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
  const [busy, setBusy] = useState(false);
  const toastId = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  selectedRef.current = selectedId;

  const notify = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, error }]);
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), error ? 6000 : 3200);
  }, []);
  const dismiss = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);

  const loadJob = useCallback(async (id: string) => {
    const detail = await api.job(id);
    setJob(detail);
    setEvents(current => (selectedRef.current === id ? mergeEvents(current, detail.events ?? []) : (detail.events ?? [])));
    setApprovals(detail.approvals ?? []);
    setQuestions(detail.questions ?? []);
    return detail;
  }, []);

  const selectJob = useCallback((id: string) => {
    setSelectedId(id);
    setSession(undefined);
    setEvents([]);
    setApprovals([]);
    setJob(undefined);
    void loadJob(id).catch(error => notify(error instanceof Error ? error.message : String(error), true));
  }, [loadJob, notify]);

  const startNew = useCallback(() => {
    setSelectedId(undefined);
    setJob(undefined);
    setEvents([]);
    setApprovals([]);
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      const [info, peerList, jobList, inboxList] = await Promise.all([
        api.node(), api.peers(), api.jobs(), api.inbox(20),
      ]);
      setNode(info);
      setConnected(true);
      setPeers(peerList);
      setJobs(jobList);
      setInbox(inboxList);
      if (!project) setProjectState(info.project && info.projects?.[info.project] ? info.project : Object.keys(info.projects ?? {})[0] ?? "");
      return jobList;
    } catch {
      setConnected(false);
      return undefined;
    }
  }, [project]);

  const refreshSessions = useCallback(async () => {
    if (!project) return;
    try { setSessions(await api.sessions(project)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [project, notify]);

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
    try { setSession(await api.session(id, project)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [project, notify]);

  const refreshDiff = useCallback(async () => {
    if (!project) return;
    setPreviewTab("diff");
    try { setDiff(await api.diff(project)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [project, notify]);

  const submit = useCallback(async (instruction: string) => {
    if (!instruction.trim()) return;
    setBusy(true);
    try {
      const reply = await api.submit({ instruction, project_id: project, mode, interaction: "on" });
      if (!reply.interactive) notify("服务器未启用交互审批：本任务按自动放行执行");
      await refreshOverview();
      selectJob(reply.job_id);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  }, [project, mode, notify, refreshOverview, selectJob]);

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
      setQuestions(current => current.filter(item => item.id !== id));
    } catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  }, [notify]);

  const setProject = useCallback((next: string) => {
    setProjectState(next);
    setFile(undefined);
    setDiff(undefined);
    setSession(undefined);
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

  // Approval prompts refresh alongside the stream, since they arrive out of band.
  useEffect(() => {
    if (!selectedId) { setApprovals([]); setQuestions([]); return; }
    let active = true;
    const tick = async (): Promise<void> => {
      try {
        const [list, pendingQuestions] = await Promise.all([api.approvals(selectedId), api.questions(selectedId)]);
        if (active) { setApprovals(list); setQuestions(pendingQuestions); }
      } catch { /* transient */ }
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [selectedId]);

  return useMemo<WorkbenchStore>(() => ({
    node, connected, live, jobs, peers, inbox, sessions, selectedId, job, events, approvals, questions, toasts,
    project, mode, sideTab, previewTab, tree, treePath, file, fileError, diff, session, busy,
    notify, dismiss, selectJob, startNew, submit, cancel, resume, decide, answerQuestion,
    setProject, setMode, setSideTab, setPreviewTab, browse, openFile, openSession,
    refreshDiff, refreshSessions, syncPeer, messagePeer, addContact,
  }), [
    node, connected, live, jobs, peers, inbox, sessions, selectedId, job, events, approvals, questions, toasts,
    project, mode, sideTab, previewTab, tree, treePath, file, fileError, diff, session, busy,
    notify, dismiss, selectJob, startNew, submit, cancel, resume, decide, answerQuestion,
    setProject, browse, openFile, openSession, refreshDiff, refreshSessions, syncPeer, messagePeer, addContact,
  ]);
}

export { ApiError };
