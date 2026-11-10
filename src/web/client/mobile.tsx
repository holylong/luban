import type { RelayDeviceStatus } from "./mobile-device";
import { MobileDeviceCard } from "./mobile-device-card";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, setNodeScope } from "./api";
import type { ApprovalView, JobStreamRecord, MeshJob, NodeInfo, QuestionView, ReasoningEffort, SessionDetail, SessionSummary, ToolRun } from "./types";
import { MobileSessionHistory } from "./mobile-session";
import { clearNativeInsets, hasNativeMenu, openNativeMenu, reportNativeConnected, reportNativeStatus } from "./mobile-native";
import { followTranscript } from "./transcript-scroll";
import { mobileProject, mobileProjects } from "./mobile-project";
import {
  appearanceOf, applyAppearance, loadAppearance, saveAppearance, systemDark,
  THEME_OPTIONS, type Appearance, type ThemeMode,
} from "./mobile-theme";
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
  status?: RelayDeviceStatus;
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
const DRAFT_KEY = "luban.mobile.draft";
const PENDING_KEY = "luban.mobile.submission-pending";

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
  // Inside the Android shell the native ⋮ owns the top-right corner and the
  // shell menu is one row away in 设置; a plain browser shows neither.
  const [nativeShell, setNativeShell] = useState(false);
  useEffect(() => {
    if (!hasNativeMenu()) return;
    setNativeShell(true);
    document.documentElement.dataset.shell = "android";
  }, []);
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
  const [modelBusy, setModelBusy] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [draft, setDraft] = useState(() => localStorage.getItem(DRAFT_KEY) || "");
  const [submissionPending, setSubmissionPending] = useState(() => Boolean(localStorage.getItem(PENDING_KEY)));
  const submittingRef = useRef(false);
  useEffect(() => { localStorage.setItem(DRAFT_KEY, draft); }, [draft]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  const [clock, setClock] = useState(() => Date.now() / 1000);
  const toastId = useRef(0);
  const selectedRef = useRef<string | undefined>(selectedId);
  selectedRef.current = selectedId;
  const ready = auth.state === "account" || auth.state === "legacy";
  // An account sign-in happens inside this page, so the Android shell learns
  // from here that the console is usable and can drop its connection notice.
  const nativeConnected = ready && Boolean(node);
  useEffect(() => {
    if (!nativeShell) return;
    clearNativeInsets();
    reportNativeConnected(nativeConnected);
  }, [nativeShell, nativeConnected]);
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

  // Model choice lives on the computer: switching here applies to the next
  // task, and every refresh replaces the catalog so a model added on the
  // desktop appears without reinstalling the app.
  const switchModel = useCallback(async (id: string, effort?: ReasoningEffort | null) => {
    if (modelBusy) return;
    setModelBusy(true);
    try {
      await api.setModel(id, effort);
      await refresh();
      notify(`模型已切换为 ${id}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally { setModelBusy(false); }
  }, [modelBusy, refresh, notify]);

  const addWorkspace = useCallback(async (kind: "new" | "existing") => {
    const answer = window.prompt(kind === "new"
      ? "新工作区名称（将在电脑默认工作区目录下创建）"
      : "电脑上已有目录的绝对路径（例如 /home/me/project）");
    const value = answer?.trim();
    if (!value) return;
    setWorkspaceBusy(true);
    try {
      const reply = await api.addProject(kind === "new" ? { name: value } : { path: value });
      await refresh();
      selectedRef.current = undefined;
      setSelectedId(undefined);
      setJob(undefined);
      setEvents([]);
      setContinueSession(undefined);
      setSessionDetail(undefined);
      setSessionError(undefined);
      setSessionListError(undefined);
      setSessions([]);
      setProject(reply.project);
      localStorage.removeItem(JOB_KEY);
      setTab("live");
      notify(`工作区已${reply.created ? "创建" : "添加"}：${reply.project}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally { setWorkspaceBusy(false); }
  }, [refresh, notify]);

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

  /** Drop a device that is gone: an abandoned backend would otherwise stay in the list forever. */
  const removeDevice = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/account/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `移除失败 (${response.status})`);
      }
      notify("已移除该设备");
      await refreshRelayNodes();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    }
  }, [refreshRelayNodes, notify]);

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
      if (id) await loadJob(id).catch(() => undefined); // Offline is not a deleted task.
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
    const sync = (): void => {
      void refresh();
      void refreshApprovals();
      const id = selectedRef.current;
      if (id) void loadJob(id).catch(() => undefined);
      if (relayMode) void refreshRelayNodes();
    };
    const visible = (): void => { if (!document.hidden) sync(); };
    const timer = setInterval(sync, 4000);
    window.addEventListener("online", sync);
    window.addEventListener("pageshow", sync);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", sync);
      window.removeEventListener("pageshow", sync);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ready, refresh, refreshApprovals, refreshRelayNodes, relayMode, loadJob]);

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
        if (!stopped && id) void loadJob(id).catch(() => undefined);
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
    // Reconnection reloads authoritative detail, never a captured event cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, scope, loadJob, notify]);

  // The docked strip has to cover both modes: a job's own stream, and a session
  // that the desktop TUI is still driving.
  const running = Boolean(job && ACTIVE_STATUS.has(job.status));
  const sessionLive = continueSession && sessionDetail?.live?.running ? sessionDetail.live : undefined;
  const ticking = running || Boolean(sessionLive);
  const progress = useMemo(() => {
    if (running) return liveProgress(events, clock);
    if (sessionLive) return liveProgress(sessionLive.events, clock);
    return null;
  }, [running, events, clock, sessionLive]);

  // One-second clock, only while something is running, for the live elapsed time.
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setClock(Date.now() / 1000), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // A phone that keeps its thumb still should still see the newest line: the
  // transcript follows the tail unless the reader has scrolled up.
  // Attach through state, not `useRef`: the console mounts before sign-in and
  // the scroller only exists afterwards, so a one-shot effect would leave the
  // page without a follower for the whole session.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const follower = useRef<ReturnType<typeof followTranscript> | null>(null);
  useEffect(() => {
    if (!scroller || !content) return;
    const handle = followTranscript(scroller, content);
    follower.current = handle;
    return () => { handle.dispose(); follower.current = null; };
  }, [scroller, content]);
  const pinToBottom = useCallback(() => { follower.current?.pin(); }, []);
  // Opening a saved session or a running job lands on its newest line, and a
  // task that keeps writing stays there until the reader scrolls away.
  useEffect(() => { pinToBottom(); }, [job?.id, continueSession?.id, pinToBottom]);

  // The WebView shell draws the native strip, so the page has to tell it when
  // work starts, ticks and ends; a plain browser simply has no bridge.
  const liveLabel = progress?.label ?? "";
  const liveDetail = progress ? (progress.stalled ? `已 ${progress.silentSeconds}s 无输出` : progress.detail) : "";
  const liveSeconds = progress?.seconds ?? 0;
  const liveStalled = progress?.stalled ?? false;
  useEffect(() => {
    reportNativeStatus(liveLabel
      ? { working: true, label: liveLabel, detail: liveDetail, seconds: liveSeconds, stalled: liveStalled }
      : { working: false });
  }, [liveLabel, liveDetail, liveSeconds, liveStalled]);
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
    pinToBottom();
  }, [loadJob, notify, pinToBottom]);

  const submit = useCallback(async () => {
    if (submittingRef.current || localStorage.getItem(PENDING_KEY)) {
      notify("上次提交结果未知，请先核对任务列表，勿重复派活", true);
      return;
    }
    const instruction = draft.trim();
    if (!instruction) return;
    if (continueSession && (!sessionDetail || sessionError || sessionDetail.live?.running)) {
      notify("请等待会话同步和电脑当前执行结束后再接续", true);
      return;
    }
    localStorage.setItem(PENDING_KEY, JSON.stringify({ instruction, node: scope, project }));
    submittingRef.current = true;
    setSubmissionPending(true);
    setBusy(true);
    try {
      const reply = await api.submit({
        instruction, project_id: project, mode, interaction: "on",
        ...(continueSession ? { session_id: continueSession.id } : {}),
      });
      localStorage.setItem(JOB_KEY, reply.job_id);
      localStorage.removeItem(PENDING_KEY);
      localStorage.removeItem(DRAFT_KEY);
      setSubmissionPending(false);
      setDraft("");
      setContinueSession(undefined);
      await refresh();
      selectJob(reply.job_id);
      if (!reply.interactive) notify("服务器未启用交互审批：本任务按自动放行执行");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally { submittingRef.current = false; setBusy(false); }
  }, [draft, project, mode, scope, continueSession, sessionDetail, sessionError, refresh, selectJob, notify]);

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
  const modelCatalog = node?.models ?? [];
  const activeModel = modelCatalog.find(item => item.id === node?.model_id);
  const effortChoices: Array<ReasoningEffort | null> = [null, ...(activeModel?.reasoning_efforts ?? [])];

  if (auth.state === "loading") {
    return <div className="m-app"><div className="m-empty"><h2>正在连接…</h2><p>检查这台手机与中继的登录状态。</p></div></div>;
  }
  if (auth.state === "anonymous") {
    return <AuthScreen emailVerification={auth.emailVerification}
      onAuthenticated={next => { setAuth({ state: "account", account: next }); setRelayMode(true); }} />;
  }

  return (
    <div className={`m-app ${tab === "live" ? "m-app-compose" : ""}`}>
      {/* One line of orientation, nothing more: the transcript is the page. */}
      <header className="m-head">
        <button type="button" className="m-head-bar" onClick={() => setTab("settings")} title={nodeLabel}>
          <span className={`m-dot ${dotClass}`} />
          <span className="m-head-name">{node?.name || (connectionError ? "未连接" : "连接中")}</span>
          {node?.model && <span className="m-head-model">{node.model}</span>}
          {activeJobs > 0 && <span className="m-chip working">{activeJobs} 个进行中</span>}
        </button>
      </header>

      <main className="m-main" ref={setScroller}>
        <div className="m-main-inner" ref={setContent}>
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
                <div className="m-banner m-session-bar">
                  <span className="m-session-tag">接续</span>
                  <span className="m-session-title" title={continueSession.title}>{continueSession.title}</span>
                  <button className="m-session-new" onClick={() => setContinueSession(undefined)}>＋ 新会话</button>
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
              {relayNodes.map(device => (
                <MobileDeviceCard key={device.id} device={device} current={device.id === scope}
                  onOpen={() => openDevice(device.id)}
                  onJobs={() => { chooseNode(device.id); setTab("jobs"); }}
                  onRemove={() => void removeDevice(device.id)} />
              ))}
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
              {nativeShell && (
                <div className="m-card">
                  <h3>App</h3>
                  <p className="m-note">连接状态、外观、刷新页面和连接记录在 App 菜单里；右上角 ⋮ 也是同一个菜单。</p>
                  <div className="m-row" style={{ marginBottom: 0 }}>
                    <button type="button" className="m-btn" onClick={() => openNativeMenu()}>打开 App 菜单</button>
                  </div>
                </div>
              )}
              <div className="m-card">
                <h3>派活</h3>
                <label className="m-field">
                  <span>会话</span>
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
                </label>
                <label className="m-field">
                  <span>项目</span>
                  <select value={project} onChange={event => { setProject(event.target.value); setContinueSession(undefined); setSessionDetail(undefined); }} aria-label="项目">
                    {Object.keys(mobileProjects(node)).length === 0 && <option value="">电脑当前工作区</option>}
                    {Object.entries(mobileProjects(node)).map(([name, path]) => <option key={name} value={name}>{name} · {path}</option>)}
                  </select>
                </label>
                <label className="m-field">
                  <span>权限</span>
                  <select value={mode} onChange={event => setMode(event.target.value as TaskMode)} aria-label="权限">
                    {(Object.keys(MODE_LABELS) as TaskMode[]).map(key => <option key={key} value={key}>{MODE_LABELS[key]}</option>)}
                  </select>
                </label>
                <p className="m-note">{node?.interactive ? "电脑端可审批：写入与命令会先问你。" : "电脑端自动放行：任务直接执行。"}</p>
                <div className="m-workspace-actions">
                  <button type="button" className="m-btn" disabled={workspaceBusy} onClick={() => void addWorkspace("new")}>＋ 新建工作区</button>
                  <button type="button" className="m-btn" disabled={workspaceBusy} onClick={() => void addWorkspace("existing")}>＋ 添加已有目录</button>
                </div>
              </div>
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
                {relayMode && relayNodes.length > 1 && (
                  <label className="m-field">
                    <span>电脑</span>
                    <select value={scope ?? ""} onChange={event => chooseNode(event.target.value)} aria-label="选择 luban 实例">
                      {relayNodes.map(item => (
                        <option key={item.id} value={item.id}>{item.online ? "● " : "○ "}{item.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <dl className="m-kv">
                  <dt>模式</dt><dd>{relayMode ? `中继 · ${location.host || "公网"}` : "直连（局域网）"}</dd>
                  <dt>节点</dt><dd>{node?.name || "—"}</dd>
                  <dt>工作区</dt><dd>{node?.workspace || "—"}</dd>
                  <dt>模型</dt><dd>{node?.model ? `${node.model}${node.provider ? ` · ${node.provider}` : ""}` : "—"}</dd>
                  <dt>版本</dt><dd>v{node?.version || "—"}</dd>
                  <dt>实时流</dt><dd>{live ? "已连接" : "断开"}</dd>
                </dl>
              </div>
              <div className="m-card">
                <h3>模型</h3>
                <p className="m-note">切换的是电脑端下一任务使用的模型；电脑端新增或切换模型后，这里会自动同步。</p>
                {modelCatalog.length === 0
                  ? <p className="m-note" style={{ marginBottom: 0 }}>电脑端还没有报告可用模型，请确认 luban 正在运行。</p>
                  : <div className="m-model-list" role="listbox" aria-label="模型">
                    {modelCatalog.map(item => (
                      <button key={item.id} type="button" role="option" aria-selected={item.id === node?.model_id}
                        className={`m-model ${item.id === node?.model_id ? "active" : ""}`}
                        disabled={modelBusy || item.id === node?.model_id}
                        onClick={() => void switchModel(item.id)}>
                        <span className="m-model-main">
                          <strong>{item.name}</strong>
                          <span>{item.provider}{item.reasoning_effort ? ` · ${item.reasoning_effort}` : ""}</span>
                        </span>
                        {item.id === node?.model_id && <span className="m-chip done">当前</span>}
                      </button>
                    ))}
                  </div>}
                {(activeModel?.reasoning_efforts?.length ?? 0) > 0 && (
                  <>
                    <p className="m-note" style={{ margin: "12px 0 6px" }}>推理强度</p>
                    <div className="m-choices" role="group" aria-label="推理强度">
                      {effortChoices.map(level => (
                        <button key={level ?? "default"} type="button" disabled={modelBusy}
                          className={`m-choice ${(node?.reasoning_effort ?? null) === level ? "active" : ""}`}
                          aria-pressed={(node?.reasoning_effort ?? null) === level}
                          onClick={() => void switchModel(activeModel?.id ?? "", level)}>{level ?? "默认"}</button>
                      ))}
                    </div>
                  </>
                )}
                {modelBusy && <p className="m-note" style={{ marginBottom: 0 }}>正在切换模型…</p>}
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
        </div>
      </main>

      {/* Docked, not in the transcript: on a phone the top of the session is
          scrolled away within seconds, and the composer is where the thumb is. */}
      {progress && (
        <div className="m-live-dock" role="status" aria-live="polite">
          <div className={`m-live ${progress.stalled ? "stalled" : ""}`}>
            <span className="m-spin" />
            <span className="label">{progress.label}</span>
            <span className="detail">{liveDetail}</span>
            <span className="clock">{progress.seconds}s</span>
          </div>
        </div>
      )}

      <div className="m-compose" hidden={tab !== "live"}>
        {submissionPending && !busy && <p className="m-note" role="alert">
          上次提交结果未知，电脑可能已在执行。请先查看任务列表，不会自动重新派活。
          <button className="m-btn" onClick={() => {
            if (!window.confirm("已核对任务列表，确认允许再次提交？重复指令可能产生重复任务。")) return;
            localStorage.removeItem(PENDING_KEY);
            setSubmissionPending(false);
          }}>已核对，解除提交保护</button>
        </p>}
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
          <button className="m-send" disabled={busy || submissionPending || !draft.trim() || !node || Boolean(continueSession && (!sessionDetail || sessionError || sessionDetail.live?.running))} onClick={() => void submit()} aria-label="发送">↑</button>
        </div>
        {/* Everything that shapes a request lives in 设置; this line is the way there. */}
        <button type="button" className="m-compose-summary" onClick={() => setTab("settings")}>
          <span className="m-compose-summary-main">
            {continueSession ? `接续 · ${continueSession.title}` : "新会话"}
            {" · "}{project || "当前工作区"}{" · "}{MODE_LABELS[mode]}
          </span>
          <span className="m-compose-summary-link">派活设置 ›</span>
        </button>
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
