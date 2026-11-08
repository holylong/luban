import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, setNodeScope } from "./api";
import type { ApprovalView, JobStreamRecord, MeshJob, NodeInfo, QuestionView, SessionDetail, SessionSummary, ToolRun } from "./types";
import { MobileSessionHistory } from "./mobile-session";
import { mobileProject, mobileProjects } from "./mobile-project";
import {
  appearanceOf, applyAppearance, loadAppearance, saveAppearance, systemDark,
  THEME_OPTIONS, type Appearance, type ThemeMode,
} from "./mobile-theme";
import { version as webVersion } from "../../../package.json";
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

type Tab = "live" | "devices" | "jobs" | "approvals" | "settings";
type TaskMode = "edits" | "agent" | "read";

interface RelayJob {
  id: string;
  title: string;
  instruction: string;
  status: string;
  progress: number;
  updated_at: number;
  session_id?: string;
}

interface RelayNode {
  id: string;
  device_id?: string;
  node_id?: string;
  name: string;
  version: string;
  workspace: string;
  projects: Record<string, string>;
  online: boolean;
  last_seen: number;
  connected_at: number;
  status?: { updated_at: number; model?: string; jobs: RelayJob[] };
}

interface AccountView {
  id: string;
  email: string;
  created_at: number;
  has_device_token: boolean;
}

type AuthState =
  | { state: "loading" }
  | { state: "legacy" }
  | { state: "anonymous"; emailVerification: boolean }
  | { state: "account"; account: AccountView };

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

/** Login/register screen shown by a relay with accounts enabled. */
function AuthScreen({ emailVerification, onAuthenticated }: {
  emailVerification: boolean;
  onAuthenticated: (account: AccountView) => void;
}): React.ReactElement {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const sendCode = async (): Promise<void> => {
    if (sending || cooldown > 0) return;
    setSending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/send-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setCodeSent(true);
      setCooldown(60);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSending(false);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          ...(mode === "register" && emailVerification ? { code: code.trim() } : {}),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; account?: AccountView };
      if (!response.ok || !payload.ok || !payload.account) throw new Error(payload.error || `HTTP ${response.status}`);
      onAuthenticated(payload.account);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (): void => {
    setMode(current => current === "login" ? "register" : "login");
    setError(undefined);
    setCode("");
    setCodeSent(false);
    setCooldown(0);
  };

  const needsCode = mode === "register" && emailVerification;
  return (
    <div className="m-app m-auth">
      <div className="m-auth-card">
        <div className="m-auth-brand"><span className="m-brand">luban</span><span className="m-auth-sub">手机远控</span></div>
        <h1>{mode === "login" ? "登录你的账户" : "创建账户"}</h1>
        <p className="m-note">
          {mode === "login"
            ? "登录后可以看到该账户下所有装了 luban 的电脑，并给任意一台上派活。"
            : "注册后在这台手机上登录，然后在每台电脑上生成设备令牌接入。"}
        </p>
        <form onSubmit={event => void submit(event)}>
          <label className="m-field">
            <span>邮箱</span>
            <input className="m-input" type="email" autoComplete="email" required value={email}
              onChange={event => setEmail(event.target.value)} placeholder="you@example.com" />
          </label>
          <label className="m-field">
            <span>密码</span>
            <input className="m-input" type="password" required minLength={8}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 位" />
          </label>
          {needsCode && (
            <label className="m-field">
              <span>邮箱验证码</span>
              <div className="m-auth-code-row">
                <input className="m-input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                  required value={code} onChange={event => setCode(event.target.value.replace(/\D/gu, ""))}
                  placeholder="6 位数字" />
                <button className="m-auth-code-btn" type="button" disabled={sending || cooldown > 0 || !email.trim()}
                  onClick={() => void sendCode()}>
                  {sending ? "发送中…" : cooldown > 0 ? `${cooldown}s` : codeSent ? "重新发送" : "发送验证码"}
                </button>
              </div>
              {codeSent && <span className="m-auth-hint">验证码已发送，请查收邮箱（包括垃圾箱）。</span>}
            </label>
          )}
          {error && <div className="m-auth-error">{error}</div>}
          <button className="m-send m-auth-submit" type="submit"
            disabled={busy || !email.trim() || password.length < 8 || (needsCode && code.length !== 6)}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>
        <button className="m-auth-switch" type="button" onClick={switchMode}>
          {mode === "login" ? "没有账户？注册" : "已有账户？登录"}
        </button>
      </div>
    </div>
  );
}

export function MobileApp(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("live");
  // Painted on <html> via data-luban-theme. The Android shell pins it with
  // ?theme= so the native window and the page cannot disagree.
  const [look, setLook] = useState<Appearance>(() => loadAppearance(location.search));
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  const [relayMode, setRelayMode] = useState(false);
  const [relayNodes, setRelayNodes] = useState<RelayNode[]>([]);
  const [scope, setScope] = useState<string | undefined>(initialNodeScope);
  const [node, setNode] = useState<NodeInfo | undefined>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [continueSession, setContinueSession] = useState<SessionSummary | undefined>();
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | undefined>();
  const [sessionError, setSessionError] = useState<string | undefined>();
  const [sessionListError, setSessionListError] = useState<string | undefined>();
  const [deviceSetup, setDeviceSetup] = useState<{ token: string; command: string } | undefined>();
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
  const ready = auth.state === "account" || auth.state === "legacy";
  useEffect(() => { applyAppearance(look); }, [look]);
  // Follow the OS while the page owns the choice. Inside the Android shell the
  // shell resolves "跟随系统" itself and pins the result through ?theme=.
  useEffect(() => {
    if (look.locked || look.mode !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setLook(current => current.mode === "system" && !current.locked
      ? appearanceOf("system", false, media.matches) : current);
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [look.locked, look.mode]);
  const chooseAppearance = useCallback((mode: ThemeMode) => {
    if (look.locked) return;
    saveAppearance(mode);
    setLook(appearanceOf(mode, false, systemDark()));
  }, [look.locked]);

  // Ask the relay whether it has accounts. A plain `luban web` answers 404
  // here and keeps the legacy token/LAN behaviour; a relay answers 401 until
  // the phone signs in.
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/me");
        if (stopped) return;
        if (response.status === 404) { setAuth({ state: "legacy" }); return; }
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { email_verification?: boolean };
          // Account mode still accepts a legacy one-tap token link. `/relay/nodes`
          // answers with the legacy node list even when every node is offline,
          // so this check does not depend on a laptop being awake.
          const legacy = await fetch("/relay/nodes").then(reply => reply.ok).catch(() => false);
          setAuth(legacy
            ? { state: "legacy" }
            : { state: "anonymous", emailVerification: payload.email_verification !== false });
          return;
        }
        const payload = await response.json() as { account?: AccountView };
        setAuth(payload.account
          ? { state: "account", account: payload.account }
          : { state: "anonymous", emailVerification: true });
      } catch {
        if (!stopped) setAuth({ state: "legacy" });
      }
    })();
    return () => { stopped = true; };
  }, []);

  const notify = useCallback((text: string, error = false) => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, error }]);
    setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), error ? 6000 : 3200);
  }, []);

  // Every API call, including the SSE stream, is pinned to the chosen node.
  useEffect(() => { setNodeScope(scope); }, [scope]);

  const loadJob = useCallback(async (id: string) => {
    const requestNode = localStorage.getItem(NODE_KEY);
    const detail = await api.job(id);
    if (selectedRef.current !== id || localStorage.getItem(NODE_KEY) !== requestNode) return detail;
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
    const requestNode = localStorage.getItem(NODE_KEY);
    try {
      const [info, jobList] = await Promise.all([api.node(), api.jobs()]);
      if (localStorage.getItem(NODE_KEY) !== requestNode) return;
      setNode(info);
      setConnected(true);
      setConnectionError(undefined);
      setJobs(jobList);
      // The job list is polled even when the SSE connection drops. Keep the
      // selected job's status in sync so a missed completion cannot spin forever.
      const selected = jobList.find(item => item.id === selectedRef.current);
      if (selected) setJob(current => current?.id === selected.id ? { ...current, ...selected } : current);
      setProject(current => mobileProject(info, current));
    } catch (error) {
      if (localStorage.getItem(NODE_KEY) !== requestNode) return;
      setConnected(false);
      if ((error as { status?: number }).status === 401) {
        setAuth(current => current.state === "anonymous" ? current : { state: "anonymous", emailVerification: true });
      }
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!ready || !node) return;
    const requestNode = localStorage.getItem(NODE_KEY);
    try {
      const list = await api.sessions(project || node.project || "");
      if (localStorage.getItem(NODE_KEY) === requestNode) {
        setSessions(list.filter(item => item.messages > 0));
        setSessionListError(undefined);
      }
    } catch (error) {
      if (localStorage.getItem(NODE_KEY) !== requestNode) return;
      setSessionListError(error instanceof Error ? error.message : String(error));
    }
  }, [ready, node, project]);

  const refreshRelayNodes = useCallback(async () => {
    try {
      const response = await fetch("/relay/nodes");
      if (response.status === 401) {
        setAuth(current => current.state === "anonymous" ? current : { state: "anonymous", emailVerification: true });
        setRelayMode(false);
        return;
      }
      if (!response.ok) { setRelayMode(false); return; }
      const payload = await response.json() as { ok?: boolean; nodes?: RelayNode[] };
      if (!payload?.ok) { setRelayMode(false); return; }
      setRelayMode(true);
      const nodes = payload.nodes ?? [];
      setRelayNodes(nodes);
      // The stored node may have been removed, or an older build used one
      // machine-wide id for every workspace. Pick a live replacement instead
      // of pinning every request to a node that no longer exists.
      const stored = localStorage.getItem(NODE_KEY) || undefined;
      const selected = stored ? nodes.find(item => item.id === stored || item.node_id === stored) : undefined;
      if (selected) {
        if (selected.id !== stored) {
          setNodeScope(selected.id);
          setScope(selected.id);
          localStorage.setItem(NODE_KEY, selected.id);
        }
      } else {
        const fallback = nodes.find(item => item.online) ?? nodes[0];
        if (fallback) {
          setNodeScope(fallback.id);
          setScope(fallback.id);
          localStorage.setItem(NODE_KEY, fallback.id);
          setProject("");
        } else {
          setNodeScope(undefined);
          setScope(undefined);
          localStorage.removeItem(NODE_KEY);
        }
      }
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
    if (!ready) return;
    void (async () => {
      await refreshRelayNodes();
      await refresh();
      const id = selectedRef.current;
      if (id) await loadJob(id).catch(() => { localStorage.removeItem(JOB_KEY); setSelectedId(undefined); });
      await refreshApprovals();
    })();
  }, [ready, refreshRelayNodes, refresh, loadJob, refreshApprovals]);

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      await refreshSessions();
      if (!stopped) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [ready, refreshSessions]);

  // Keep polling: the stream carries the detail, polling is the safety net for
  // a phone that was asleep, changed networks, or lost a frame.
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      void refresh();
      void refreshApprovals();
      if (relayMode) void refreshRelayNodes();
    }, 4000);
    return () => clearInterval(timer);
  }, [ready, refresh, refreshApprovals, refreshRelayNodes, relayMode]);

  // Session detail is not a mesh job. Poll it independently, including after
  // sleep/reconnect; cancel stale responses when switching sessions or nodes.
  useEffect(() => {
    setSessionDetail(undefined);
    setSessionError(undefined);
    if (!ready || !continueSession) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const detail = await api.session(continueSession.id, continueSession.project);
        if (!stopped) { setSessionDetail(detail); setSessionError(undefined); }
      } catch (error) {
        if (!stopped) setSessionError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!stopped) timer = setTimeout(() => void load(), 1000);
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [ready, scope, continueSession?.id, continueSession?.project]);

  // Live stream.
  useEffect(() => {
    if (!ready) return;
    let source: EventSource | undefined;
    let stopped = false;
    const streamUrl = scope ? `/api/events?node=${encodeURIComponent(scope)}` : "/api/events";
    const connect = (): void => {
      if (stopped) return;
      source = new EventSource(streamUrl);
      source.onopen = () => {
        setLive(true);
        const id = selectedRef.current;
        if (id) void api.jobStream(id, events.at(-1)?.seq ?? 0).then(reply => {
          if (!stopped && selectedRef.current === id) setEvents(current => mergeEvents(current, reply.events));
        }).catch(() => undefined);
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
  }, [ready, scope, loadJob, notify]);

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
    selectedRef.current = id;
    setSelectedId(id);
    localStorage.setItem(JOB_KEY, id);
    setJob(undefined);
    setEvents([]);
    setContinueSession(undefined);
    setSessionDetail(undefined);
    void loadJob(id).catch(error => notify(error instanceof Error ? error.message : String(error), true));
    setTab("live");
  }, [loadJob, notify]);

  const submit = useCallback(async () => {
    const instruction = draft.trim();
    if (!instruction) return;
    if (continueSession && (!sessionDetail || sessionError || sessionDetail.live?.running)) {
      notify("请等待会话同步和电脑当前执行结束后再接续", true);
      return;
    }
    setBusy(true);
    try {
      const reply = await api.submit({
        instruction, project_id: project, mode, interaction: "on",
        ...(continueSession ? { session_id: continueSession.id } : {}),
      });
      setDraft("");
      setContinueSession(undefined);
      await refresh();
      selectJob(reply.job_id);
      if (!reply.interactive) notify("服务器未启用交互审批：本任务按自动放行执行");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally { setBusy(false); }
  }, [draft, project, mode, continueSession, sessionDetail, sessionError, refresh, selectJob, notify]);

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

  const composerRef = useRef<HTMLTextAreaElement>(null);

  const chooseNode = useCallback((id: string) => {
    setNodeScope(id || undefined);
    setScope(id || undefined);
    if (id) localStorage.setItem(NODE_KEY, id);
    else localStorage.removeItem(NODE_KEY);
    selectedRef.current = undefined;
    setNode(undefined);
    setJobs([]);
    setJob(undefined);
    setSelectedId(undefined);
    localStorage.removeItem(JOB_KEY);
    setEvents([]);
    setSessions([]);
    setContinueSession(undefined);
    setProject("");
    void refresh();
  }, [refresh]);

  const openDevice = useCallback((id: string) => {
    chooseNode(id);
    setTab("live");
    setTimeout(() => composerRef.current?.focus(), 60);
  }, [chooseNode]);

  const requestDeviceToken = useCallback(async () => {
    try {
      const response = await fetch("/api/account/device-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; token?: string; command?: string };
      if (!response.ok || !payload.token) throw new Error(payload.error || `HTTP ${response.status}`);
      setDeviceSetup({ token: payload.token, command: payload.command || "" });
      notify("设备令牌已生成，只显示这一次");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    }
  }, [notify]);

  const logout = useCallback(async () => {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch { /* already offline */ }
    setAuth(current => ({
      state: "anonymous",
      emailVerification: current.state === "anonymous" ? current.emailVerification : true,
    }));
    setRelayNodes([]);
    setRelayMode(false);
  }, []);

  useEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(132, element.scrollHeight)}px`;
  }, [draft]);

  const dotClass = !connected ? "offline" : running ? "working" : live ? "online" : "offline";
  const nodeLabel = node ? `${node.name}${node.model ? ` · ${node.model}` : ""}` : connectionError ? "未连接" : "连接中";
  const activeJobs = jobs.filter(item => ACTIVE_STATUS.has(item.status)).length;
  const account = auth.state === "account" ? auth.account : undefined;

  if (auth.state === "loading") {
    return <div className="m-app"><div className="m-empty"><h2>正在连接…</h2><p>检查这台手机与中继的登录状态。</p></div></div>;
  }
  if (auth.state === "anonymous") {
    return <AuthScreen emailVerification={auth.emailVerification}
      onAuthenticated={next => { setAuth({ state: "account", account: next }); setRelayMode(true); }} />;
  }

  return (
    <div className={`m-app ${tab === "live" ? "m-app-compose" : ""}`}>
      <header className="m-head">
        <div className="m-head-row">
          <span className={`m-dot ${dotClass}`} />
          <span className="m-brand">luban</span>
          <small className="m-version">{webVersion}</small>
          {relayMode && relayNodes.length > 0 && (
            <select value={scope ?? ""} onChange={event => chooseNode(event.target.value)} aria-label="选择 luban 实例">
              {relayNodes.map(item => (
                <option key={item.id} value={item.id}>{item.online ? "● " : "○ "}{item.name}</option>
              ))}
            </select>
          )}
          {relayMode && relayNodes.length === 0 && <span className="m-chip failed" style={{ marginLeft: "auto" }}>无设备</span>}
        </div>
        <div className="m-head-meta" title={nodeLabel}>{nodeLabel}</div>
        <div className="m-head-context">
          {job ? `${job.title || job.id} · ${STATUS_LABELS[job.status] ?? job.status}` : node?.workspace || (relayMode ? "选择一台电脑开始" : "未选择任务")}
          {activeJobs > 1 ? ` · ${activeJobs} 个进行中` : ""}
        </div>
      </header>

      <main className="m-main">
        {sessionListError && <div className="m-banner warn">会话列表读取失败：{sessionListError}</div>}
        {relayMode && relayNodes.length === 0 && (
          <div className="m-banner warn">
            账户下还没有 luban 实例。打开「设置 → 添加电脑」生成设备令牌，然后在电脑上运行：
            <pre style={{ margin: "8px 0 0", font: "11.5px var(--mono)", whiteSpace: "pre-wrap" }}>luban web &lt;项目路径&gt; --relay {location.origin} --relay-device-token &lt;设备令牌&gt;</pre>
          </div>
        )}
        {!connected && connectionError && relayMode && relayNodes.length > 0 && (
          <div className="m-banner warn">连接失败：{connectionError}<div className="m-banner-actions"><button className="m-btn" onClick={() => void refresh()}>重试</button></div></div>
        )}

        {tab === "live" && (
          <>
            {continueSession && (
              <div className="m-banner">
                将接续会话：{continueSession.title}
                <div className="m-banner-actions">
                  <button className="m-btn" onClick={() => setContinueSession(undefined)}>改为新会话</button>
                </div>
              </div>
            )}
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
            {continueSession && <>
              {sessionError && <div className="m-banner warn">会话同步失败：{sessionError}（正在重试）</div>}
              {!sessionDetail && !sessionError && <div className="m-note">正在加载会话记录…</div>}
              {sessionDetail && <MobileSessionHistory session={sessionDetail} renderTool={run =>
                <ToolCard run={run} open={openTools[run.callId] ?? false} onToggle={() => setOpenTools(current => ({ ...current, [run.callId]: !current[run.callId] }))} />
              } />}
            </>}
            {!job && !continueSession && (
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

        {tab === "devices" && (
          <>
            {!relayMode && (
              <div className="m-empty"><h2>直连模式</h2><p>当前页面直接连接本机 luban；登录中继账户后，这里会列出账户下的所有电脑。</p></div>
            )}
            {relayMode && relayNodes.length === 0 && (
              <div className="m-empty"><h2>还没有 luban 实例</h2><p>在「设置 → 添加电脑」生成设备令牌，然后在电脑上启动 luban web 并接入中继。</p></div>
            )}
            {relayNodes.map(device => {
              const deviceJobs = device.status?.jobs ?? [];
              const active = deviceJobs.filter(item => ACTIVE_STATUS.has(item.status));
              const latest = active[0] ?? deviceJobs[0];
              return (
                <div className={`m-card m-device ${device.id === scope ? "active" : ""}`} key={device.id}>
                  <div className="m-device-row">
                    <span className={`m-dot ${device.online ? "online" : "offline"}`} />
                    <strong>{device.name}</strong>
                    <span className={`m-chip ${device.online ? "done" : "failed"}`}>{device.online ? "在线" : "离线"}</span>
                    {active.length > 1 && <span className="m-chip working">{active.length} 个进行中</span>}
                  </div>
                  <div className="m-device-path">{device.workspace || "未报告工作区"}{device.status?.model ? ` · ${device.status.model}` : ""}</div>
                  {latest ? (
                    <>
                      <div className="m-device-job">
                        <span className={`m-chip ${latest.status}`}>{STATUS_LABELS[latest.status as keyof typeof STATUS_LABELS] ?? latest.status}</span>
                        <span>{latest.title || latest.instruction || latest.id}</span>
                      </div>
                      <div className="m-note" style={{ marginTop: 5 }}>
                        {ACTIVE_STATUS.has(latest.status) ? `进度 ${Math.round(latest.progress)}%` : "最近任务"}
                        {latest.updated_at ? ` · ${relativeTime(latest.updated_at)}前更新` : ""}
                        {deviceJobs.length > 1 ? ` · 共 ${deviceJobs.length} 条记录` : ""}
                      </div>
                    </>
                  ) : <div className="m-note">{device.online ? "空闲，等待派活" : "离线"}</div>}
                  <div className="m-row" style={{ marginTop: 10, marginBottom: 0 }}>
                    <button className="m-btn primary" disabled={!device.online} onClick={() => openDevice(device.id)}>打开并派活</button>
                    <button className="m-btn" onClick={() => { chooseNode(device.id); setTab("jobs"); }}>查看任务</button>
                  </div>
                </div>
              );
            })}
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
                {item.once_only && <p>{item.description}</p>}
                <pre>{JSON.stringify(item.args, null, 2)}</pre>
                <div className="m-approval-actions">
                  <button className="m-btn primary" onClick={() => void decide(item.id, "once")}>允许一次</button>
                  {!item.once_only && <><button className="m-btn ok" onClick={() => void decide(item.id, "always")}>本会话允许</button>
                  <button className="m-btn" onClick={() => void decide(item.id, "tool")}>该工具都允许</button></>}
                  <button className="m-btn danger" onClick={() => void decide(item.id, "deny")}>拒绝</button>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === "settings" && (
          <>
            <div className="m-card">
              <h3>外观</h3>
              <div className="m-choices" role="group" aria-label="主题">
                {THEME_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    className={`m-choice ${look.mode === option.value ? "active" : ""}`}
                    aria-pressed={look.mode === option.value}
                    disabled={look.locked}
                    onClick={() => chooseAppearance(option.value)}
                  >{option.label}</button>
                ))}
              </div>
              <p className="m-note" style={{ marginBottom: 0 }}>
                {look.locked
                  ? `主题由 luban App 控制，当前为${look.theme === "dark" ? "深色" : "浅色"}；可在 App 的「外观设置」里切换。`
                  : look.mode === "system"
                    ? `跟随系统，当前${look.theme === "dark" ? "深色" : "浅色"}。`
                    : `已固定为${look.theme === "dark" ? "深色" : "浅色"}。`}
              </p>
            </div>
            {account && (
              <div className="m-card">
                <h3>账户</h3>
                <dl className="m-kv">
                  <dt>邮箱</dt><dd>{account.email}</dd>
                  <dt>实例</dt><dd>{relayNodes.length} 个</dd>
                </dl>
                <div className="m-row" style={{ marginTop: 10, marginBottom: 0 }}>
                  <button className="m-btn primary" onClick={() => void requestDeviceToken()}>添加电脑</button>
                </div>
                {deviceSetup && (
                  <div className="m-device-token">
                    <p className="m-note">令牌只显示这一次；重新生成只新增一枚，不影响其他电脑。</p>
                    <pre>{deviceSetup.command}</pre>
                  </div>
                )}
              </div>
            )}
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
                <h3>{account ? "账户实例" : "中继节点"}</h3>
                {relayNodes.length === 0 && <p className="m-note">还没有节点连上中继。</p>}
                {relayNodes.map(item => (
                  <button key={item.id} className={`m-job ${item.id === scope ? "active" : ""}`} onClick={() => chooseNode(item.id)}>
                    <div className="m-job-title">{item.online ? "● " : "○ "}{item.name}</div>
                    <div className="m-job-meta"><span>{item.workspace || "—"}</span><span>v{item.version || "—"}</span></div>
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
                {account
                  ? <button className="m-btn" onClick={() => void logout()}>退出登录</button>
                  : <a className="m-btn" style={{ textAlign: "center", textDecoration: "none" }} href="/logout">退出登录</a>}
              </div>
            </div>
          </>
        )}
      </main>

      <div className="m-compose" hidden={tab !== "live"}>
        <div className="m-compose-box">
          <textarea
            ref={composerRef}
            value={draft}
            rows={1}
            aria-label="任务指令"
            placeholder={continueSession ? "继续当前会话…" : job && ACTIVE_STATUS.has(job.status) ? "补充指令…" : "让电脑帮你做什么？"}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
            }}
          />
          <button className="m-send" disabled={busy || !draft.trim() || !node || Boolean(continueSession && (!sessionDetail || sessionError || sessionDetail.live?.running))} onClick={() => void submit()} aria-label="发送">↑</button>
        </div>
        <details className="m-compose-options">
          <summary>派活选项 <span>{continueSession ? "接续会话" : "新会话"} · {project || "当前工作区"} · {MODE_LABELS[mode]}</span></summary>
        <div className="m-compose-hint">
          {sessions.length > 0 && (
            <select
              value={continueSession?.id ?? ""}
              aria-label="继续会话"
              onChange={event => {
                const next = sessions.find(item => item.id === event.target.value);
                setContinueSession(next);
                setSessionDetail(undefined);
                setSessionError(undefined);
                selectedRef.current = undefined;
                setJob(undefined);
                setEvents([]);
                setSelectedId(undefined);
                localStorage.removeItem(JOB_KEY);
                setTab("live");
                if (next) setProject(next.project);
              }}
            >
              <option value="">新会话</option>
              {sessions.slice(0, 8).map(item => <option key={item.id} value={item.id}>继续：{item.title}</option>)}
            </select>
          )}
          <select value={project} onChange={event => { setProject(event.target.value); setContinueSession(undefined); setSessionDetail(undefined); }} aria-label="项目">
            {Object.keys(mobileProjects(node)).length === 0 && <option value="">电脑当前工作区</option>}
            {Object.entries(mobileProjects(node)).map(([name, path]) => <option key={name} value={name}>{name} · {path}</option>)}
          </select>
          <select value={mode} onChange={event => setMode(event.target.value as TaskMode)} aria-label="权限">
            {(Object.keys(MODE_LABELS) as TaskMode[]).map(key => <option key={key} value={key}>{MODE_LABELS[key]}</option>)}
          </select>
          <span style={{ marginLeft: "auto" }}>{node?.interactive ? "可审批" : "自动放行"}</span>
        </div>
        </details>
      </div>

      <nav className="m-tabs">
        <button className={`m-tab ${tab === "live" ? "active" : ""}`} onClick={() => setTab("live")}>
          <span className="icon">◈</span><span>状态</span>
        </button>
        <button className={`m-tab ${tab === "devices" ? "active" : ""}`} onClick={() => setTab("devices")}>
          <span className="icon">▣</span><span>设备</span>
          {relayMode && <span className="m-badge">{relayNodes.filter(item => item.online).length}</span>}
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
