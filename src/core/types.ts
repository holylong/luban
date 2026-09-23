export type AgentMode = "auto" | "agent" | "ask";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AttachedImage {
  /** Workspace-relative path; bytes are read fresh at transport time. */
  path: string;
  mime: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  editPreview?: string;
  /** Image attachments resolved to model-native vision parts at transport. */
  images?: AttachedImage[];
}

export interface ModelRef {
  id: string;
  provider: string;
  model: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai" | "anthropic" | "responses";
  capabilities: ModelCapabilities;
}

export interface ModelCapabilities {
  vision: boolean;
  thinking: boolean;
  tools: boolean;
  responses: boolean;
}

export interface MeshContact {
  name: string;
  host: string;
  port: number;
  udpPort: number;
  note: string;
}

export type SyncMode = "auto" | "git" | "chunk";
export type ConflictPolicy = "auto" | "both" | "source_wins" | "dest_wins";

export interface MeshSettings {
  enabled: boolean;
  nodeName: string;
  host: string;
  port: number;
  udpPort: number;
  capabilities: string[];
  contacts: MeshContact[];
  token: string;
  syncMode: SyncMode;
  chunkSize: number;
  syncIgnore: string[];
  conflictPolicy: ConflictPolicy;
  jobsDir: string;
  workspacesDir: string;
  projects: Record<string, string>;
  maxWorkers: number;
  jobTimeoutSeconds: number;
  queueTimeoutSeconds: number;
}

/**
 * A terminal palette is a bag of named colors, so a config file can override
 * individual keys of a built-in theme without pinning the whole scheme.
 */
export type ThemeColors = Record<string, string>;

export interface LubanConfig {
  home: string;
  workspace: string;
  project: string;
  /** Terminal color scheme id or alias; see `src/ui/theme.ts` for the catalog. */
  theme: string;
  /** Per-key palette overrides merged over `theme`. */
  themeColors: ThemeColors;
  model: ModelRef;
  models: ModelRef[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Maximum silence allowed while consuming a streaming model response. */
  thinkingTimeoutMs?: number;
  /** Explicit thinking override; undefined asks the runner to choose per request. */
  enableThinking?: boolean;
  maxSteps: number;
  /** Approximate total context capacity of the selected model. */
  contextWindow: number;
  /** Tokens kept free for the next model response and provider overhead. */
  contextReserve: number;
  semanticCompaction: boolean;
  /** Compact old exchanges before chat-template/message overhead grows without bound. */
  maxHistoryMessages?: number;
  /** Retries for transient model transport, rate-limit, and server errors. */
  maxRetries: number;
  mcpServers: Record<string, McpServerSettings>;
  lspServers: Record<string, LspServerSettings>;
  /** Run code-intelligence queries in a disposable child process. */
  codeIntelWorker: boolean;
  backendUrl: string;
  permissionMode: "ask" | "edits" | "allow";
  /** Seconds an interactive approval may wait before it is refused. 0 waits forever. */
  approvalTimeoutSeconds?: number;
  /**
   * How much planning the prompt asks for. "always" costs an extra model
   * round-trip per task (a required update_plan call), "off" never asks for a
   * plan, "auto" only asks when the work spans several steps.
   */
  planning?: "off" | "auto" | "always";
  permissions: PermissionSettings;
  mesh: MeshSettings;
  sandbox: SandboxSettings;
  toolOutputRetentionDays: number;
  toolOutputMaxBytes: number;
  mcpMaxTools: number;
  mcpLazy: boolean;
}

export interface PermissionSettings {
  /** Rules use `tool` or `tool:glob`, for example `bash:git *`. */
  allow: string[];
  deny: string[];
}

export interface LspServerSettings {
  command: string;
  args: string[];
  languages: string[];
  enabled: boolean;
}

export interface McpServerSettings {
  command?: string;
  url?: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  /** Trusted servers may start at turn initialization and register native tools. */
  trusted: boolean;
}

export interface SandboxSettings {
  mode: "soft" | "strict" | "off";
  allowNetwork: boolean;
  allowOutsideWorkspace: boolean;
  backend: "auto" | "bwrap" | "docker" | "none";
  dockerImage: string;
  denyPatterns: string[];
}

export interface VerificationRecord {
  id: string;
  command: string;
  status: "passed" | "failed";
  output: string;
  createdAt: string;
}

export type ToolRisk = "read" | "write" | "execute" | "network";

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  /** Safe to execute alongside other calls carrying the same flag. */
  parallelSafe?: boolean;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  /** Release runtime-owned resources when the session runner is closed. */
  close?(): void;
}

export type AgentEvent =
  /**
   * A line for the working indicator.
   *
   * `progress` marks a phase label that is re-announced for as long as the run
   * continues — the tool loop reports "Reviewing tool results" after *every*
   * step — as opposed to a notice about something that happened (a retry, a
   * compaction, an idle timeout, the step budget). Only notices belong in the
   * durable record: a re-announced label left one identical line per step in
   * every transcript, job log and browser timeline, which is what buried the
   * notes that carry real information.
   */
  | { type: "status"; text: string; progress?: boolean }
  /**
   * A model round trip just started. Without it a UI cannot tell "waiting for
   * the model" apart from "thinking", and a stalled request looks like work.
   */
  | { type: "model-call"; index: number }
  | { type: "input"; id: string; text: string }
  | { type: "delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool-start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool-end"; id: string; name: string; ok: boolean; elapsedMs: number; preview: string; editPreview?: string }
  | { type: "usage"; input: number; output: number }
  | { type: "error"; text: string };

export interface RunResult {
  ok: boolean;
  text: string;
  steps: number;
  messages: ChatMessage[];
  /** Why execution stopped when it did not complete normally. */
  stopReason?: "max_steps" | "context" | "loop" | "truncated";
  /**
   * Model round-trips this run spent, including compaction and handoff calls.
   * Wall-clock time is dominated by these, so comparing two runtimes is mostly
   * a question of how many of them a task takes.
   */
  modelCalls: number;
  /** Milliseconds from the start of the run to its return. */
  elapsedMs: number;
}

export interface PendingInput {
  id: string;
  content: string;
  delivery: "steer" | "queue";
  createdAt: string;
  images?: AttachedImage[];
}

export interface SessionRecord {
  edits?: Array<{ id: string; name: string; preview: string }>;
  pendingInputs?: PendingInput[];
  id: string;
  title: string;
  project: string;
  workspace: string;
  mode: AgentMode;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}
