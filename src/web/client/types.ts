export type JobStatus = "queued" | "pending" | "working" | "paused" | "done" | "failed" | "cancelled";

export type JobStreamEvent =
  | { kind: "status"; text: string; progress?: boolean }
  /** A model round trip started; lets the console show which one is in flight. */
  | { kind: "model-call"; index: number }
  | { kind: "delta"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool-start"; callId: string; name: string; args: Record<string, unknown>; summary: string }
  | { kind: "tool-end"; callId: string; name: string; ok: boolean; elapsedMs: number; preview: string; editPreview?: string }
  | { kind: "usage"; input: number; output: number }
  | { kind: "error"; text: string };

export interface JobStreamRecord {
  seq: number;
  at: number;
  event: JobStreamEvent;
}

export interface JobLog {
  t: number;
  level: string;
  msg: string;
}

export interface MeshJob {
  id: string;
  source: string;
  target: string;
  kind: string;
  project_id: string;
  workspace: string;
  instruction: string;
  title: string;
  status: JobStatus;
  progress: number;
  logs: JobLog[];
  result: string;
  error: string;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  session_id?: string;
  resume_count?: number;
  /** Permission mode requested when the job was submitted from the browser. */
  mode?: string;
  runtime?: string;
  events?: JobStreamRecord[];
  event_next?: number;
  interactive?: boolean;
  approvals?: ApprovalView[];
  questions?: QuestionView[];
}

export interface ApprovalView {
  id: string;
  job_id: string;
  tool: string;
  description: string;
  risk: string;
  args: Record<string, unknown>;
  created_at: number;
}

export interface QuestionView {
  id: string;
  job_id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  created_at: number;
}

export interface PeerView {
  name: string;
  host: string;
  port: number;
  udp_port: number;
  capabilities: string[];
  last_seen: number;
  note: string;
  online: boolean;
  /** Peer luban version; "unknown" until the peer answers nodeInfo. */
  version: string;
}

export interface InboxMessage {
  id: string;
  from: string;
  to?: string;
  text: string;
  received_at: number;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  children?: FileEntry[];
}

export interface NodeInfo {
  name: string;
  /** Workspace this node runs in; shown when a phone picks between nodes. */
  workspace?: string;
  project?: string;
  host: string;
  port: number;
  udp_port: number;
  capabilities: string[];
  projects: Record<string, string>;
  serving: boolean;
  model: string;
  provider: string;
  models: Array<{ id: string; name: string; provider: string }>;
  version: string;
  runtime: string;
  interactive: boolean;
  /** True when the endpoint requires an access token. */
  auth_required?: boolean;
  web: { host: string; port: number };
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
  language: string;
  lines?: number;
}

export interface FileVersions {
  path: string;
  original: string;
  current: string;
}

export interface DiffPayload {
  project: string;
  available: boolean;
  files: Array<{ status: string; path: string }>;
  patch: string;
  error?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  project: string;
  workspace: string;
  model: string;
  mode: string;
  updatedAt: string;
  createdAt: string;
  messages: number;
  edits: number;
}

export interface SessionMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  editPreview?: string;
}

export interface SessionDetail extends Omit<SessionSummary, "messages" | "edits"> {
  messages: SessionMessage[];
  edits?: Array<{ id: string; name: string; preview: string }>;
  pendingInputs?: Array<{ id: string; text: string }>;
}

/** A tool invocation assembled from the structured event stream. */
export interface ToolRun {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  status: "running" | "done" | "failed";
  elapsedMs?: number;
  preview?: string;
  editPreview?: string;
  seq: number;
}

/** One rendered row of the transcript, rebuilt from the event stream. */
export type TimelineItem =
  | { kind: "user"; id: string; text: string; at: number; jobId?: string; mode?: string }
  | { kind: "status"; id: string; text: string; at: number }
  | { kind: "thinking"; id: string; text: string; at: number }
  | { kind: "assistant"; id: string; text: string; at: number; streaming?: boolean }
  | { kind: "tool"; id: string; run: ToolRun; at: number }
  | { kind: "error"; id: string; text: string; at: number }
  | { kind: "result"; id: string; text: string; at: number; status: JobStatus };
