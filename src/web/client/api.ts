import type {
  ApprovalView, DiffPayload, FileContent, FileEntry, FileVersions, InboxMessage, JobStatus,
  MeshJob, NodeInfo, PeerView, SessionDetail, SessionSummary,
} from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let nodeScope: string | undefined;

/**
 * Relay mode: pin every API call to one connected node.
 *
 * The relay can hold several laptops at once, so the phone's console has to say
 * which one it means. The token is carried by a cookie, which every request
 * (including the SSE stream) already sends.
 */
export function setNodeScope(node?: string): void {
  nodeScope = node?.trim() || undefined;
}

function scoped(path: string): string {
  if (!nodeScope) return path;
  return `${path}${path.includes("?") ? "&" : "?"}node=${encodeURIComponent(nodeScope)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const requestScope = nodeScope;
  // Every endpoint here reports live state (jobs, files, sessions); a cached
  // reply would make the file tree and job list lag behind disk.
  const response = await fetch(scoped(path), { ...init, cache: init?.cache ?? "no-store" });
  const text = await response.text();
  if (requestScope !== nodeScope) throw new ApiError(409, "设备已切换，忽略旧设备响应");
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text.slice(0, 400) }; }
  const payload = body as { ok?: boolean; error?: string };
  if (!response.ok || payload?.ok === false) {
    throw new ApiError(response.status, payload?.error || `HTTP ${response.status}`);
  }
  return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const api = {
  codexQuota: () => request<import("../codex-quota-types").CodexQuota>("/api/codex/quota"),
  codexReset: (input: { creditId?: string; requestId: string }) =>
    post<{ ok: boolean; outcome: string; message: string; quota: import("../codex-quota-types").CodexQuota }>(
      "/api/codex/quota/reset", { credit_id: input.creditId, request_id: input.requestId }),
  themes: () => request<import("./desktop-theme").ThemeCatalog>("/api/themes"),
  setTheme: (id: string) => post<{ active: import("./desktop-theme").DesktopTheme }>("/api/theme", { id }),
  setModel: (model: string, effort?: import("./types").ReasoningEffort | null) =>
    post<{ ok: boolean }>("/api/model", { model, reasoning_effort: effort }),
  node: () => request<NodeInfo>("/api/node"),
  computer: () => request<import("./types").ComputerStatus>("/api/computer"),
  setComputer: (input: { enabled?: boolean; stop?: boolean }) =>
    post<{ ok: boolean; enabled: boolean; stopped?: boolean }>("/api/computer", input),
  peers: () => request<PeerView[]>("/api/peers"),
  inbox: (limit = 20) => request<InboxMessage[]>(`/api/inbox${query({ limit })}`),
  jobs: (project?: string) => request<MeshJob[]>(`/api/jobs${query({ project })}`),
  job: (id: string) => request<MeshJob>(`/api/jobs/${encodeURIComponent(id)}`),
  jobStream: (id: string, since = 0) => request<{
    ok: boolean; job_id: string; next: number; complete: boolean;
    events: Array<{ seq: number; at: number; event: import("./types").JobStreamEvent }>;
  }>(`/api/jobs/${encodeURIComponent(id)}/stream${query({ since })}`),
  submit: (input: { instruction: string; project_id: string; mode: string; interaction: string; session_id?: string }) =>
    post<{ ok: boolean; job_id: string; status: JobStatus; interactive: boolean }>("/api/jobs", input),
  cancel: (id: string) => post<{ ok: boolean; status: string }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}),
  resume: (id: string) => post<{ ok: boolean; job_id: string; status: JobStatus }>(`/api/jobs/${encodeURIComponent(id)}/resume`, {}),
  approvals: (job?: string) => request<ApprovalView[]>(`/api/approvals${query({ job })}`),
  decide: (id: string, decision: "once" | "tool" | "always" | "deny") => post<{ ok: boolean }>("/api/approvals", { id, decision }),
  questions: (job?: string) => request<import("./types").QuestionView[]>(`/api/questions${query({ job })}`),
  answerQuestion: (id: string, answer: string) => post<{ ok: boolean }>("/api/questions", { id, answer }),
  workspace: (project: string, sub = "") => request<{ project: string; root: string; tree: FileEntry[] }>(`/api/workspace${query({ project, sub })}`),
  file: (project: string, path: string) => request<FileContent>(`/api/file${query({ project, path })}`),
  fileVersions: (project: string, path: string) => request<FileVersions>(`/api/file-versions${query({ project, path })}`),
  diff: (project: string) => request<DiffPayload>(`/api/diff${query({ project })}`),
  addProject: (input: { name?: string; path?: string }) =>
    post<{ ok: boolean; project: string; workspace: string; created: boolean }>("/api/projects", input),
  sessions: (project: string, limit = 60) => request<SessionSummary[]>(`/api/sessions${query({ project, limit })}`),
  session: (id: string, project: string) => request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}${query({ project })}`),
  sync: (input: { peer: string; direction: "push" | "pull"; project_id: string; mode: string }) =>
    post<{ ok: boolean; output: string }>("/api/sync", input),
  chat: (peer: string, message: string) => post<{ ok: boolean; output: string }>("/api/chat", { peer, message }),
  addContact: (input: { name: string; host: string; port: number; udp_port: number; note?: string }) =>
    post<{ ok: boolean }>("/api/contacts", input),
  ping: (peer: string) => post<{ ok: boolean; output: string }>("/api/ping", { peer }),
  handoff: (input: { peer: string; instruction: string; project_id: string }) =>
    post<{ ok: boolean; output: string }>("/api/handoff", input),
};
