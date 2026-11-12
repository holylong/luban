import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { JobStreamRecord, MeshEvent, MeshRuntime } from "../core/mesh/runtime.js";
import { hasConversation, SessionStore } from "../core/session-store.js";
import { liveSessions } from "../core/live-session.js";
import { SessionHistory, sharedHistory } from "../core/session-history.js";
import type { LubanConfig, SyncMode } from "../core/types.js";
import { savePreferredModel, saveProject, saveTheme } from "../core/config.js";
import { THEMES, findTheme, resolveTheme } from "../ui/theme.js";
import { consumeCodexReset, formatCodexResetOutcome, readCodexRateLimits } from "../core/codex-account.js";
import { supportedReasoningEfforts } from "../core/model-controls.js";
import { VERSION } from "../version.js";
import { createCodexQuotaReader, codexResetRequest } from "./codex-quota.js";
import { DASHBOARD_HTML, DOCS_HTML, webAssetPath, WEB_CONTENT_TYPES } from "./assets.js";
import { ApprovalBroker, type ApprovalDecision } from "./approval.js";
import { QuestionBroker } from "./question.js";
import { AuthGate, clearCookie, rejectAuth, tokenCookie } from "./auth.js";

const MAX_BODY = 1024 * 1024;
const MAX_JOBS = 100;
const MAX_LOGS = 500;
const MAX_FILE_BYTES = 512 * 1024;
const SSE_HEARTBEAT_MS = 20_000;
const execFileAsync = promisify(execFile);

type JsonObject = Record<string, unknown>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/** A project id is also a folder name under the default workspaces directory. */
function cleanProjectName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return "";
  if (name.length > 80) throw new HttpError(400, "项目名称过长（最多 80 个字符）");
  if (name === "." || name === ".." || /[\\/\u0000-\u001f]/u.test(name)) {
    throw new HttpError(400, "项目名称不能包含路径分隔符");
  }
  if (["__proto__", "constructor", "prototype"].includes(name)) throw new HttpError(400, "项目名称不可用");
  return name;
}

function uniqueProjectName(projects: Record<string, string>, base: string, workspace: string): string {
  let name = base;
  for (let suffix = 2; projects[name] && resolve(projects[name]!) !== workspace; suffix += 1) {
    if (suffix > 99) throw new HttpError(409, "项目名称冲突，请指定一个名称");
    name = `${base}-${suffix}`;
  }
  return name;
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<JsonObject> {
  const declared = Number(req.headers["content-length"] || 0);
  if (!Number.isFinite(declared) || declared < 0) throw new HttpError(400, "invalid content-length");
  if (declared > MAX_BODY) throw new HttpError(413, `request body too large (${declared} bytes)`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY) throw new HttpError(413, `request body too large (${size} bytes)`);
    chunks.push(data);
  }
  if (!size) return {};
  try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new HttpError(400, "invalid JSON body"); }
}

/** Resolve a client-supplied path inside the workspace, rejecting traversal and symlink escapes. */
async function resolveInsideRoot(root: string, sub: string): Promise<{ root: string; target: string; rel: string }> {
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, sub || ".");
  const rel = relative(canonicalRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new HttpError(400, `path escapes workspace: ${sub}`);
  const canonicalTarget = await realpath(target);
  const canonicalRel = relative(canonicalRoot, canonicalTarget);
  if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`)) throw new HttpError(400, `symlink escapes workspace: ${sub}`);
  return { root: canonicalRoot, target: canonicalTarget, rel: canonicalRel.split(sep).join("/") };
}

async function workspaceTree(root: string, sub: string): Promise<JsonObject[]> {
  const { root: canonicalRoot, target } = await resolveInsideRoot(root, sub);
  const entries = await readdir(target, { withFileTypes: true });
  const rows: JsonObject[] = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    const path = resolve(target, entry.name);
    const itemPath = relative(canonicalRoot, path).split(sep).join("/");
    if (entry.isDirectory()) rows.push({ name: entry.name, path: itemPath, type: "dir", children: [] });
    else if (entry.isFile()) rows.push({ name: entry.name, path: itemPath, type: "file", size: (await lstat(path)).size });
  }
  return rows;
}

const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".7z", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".wasm", ".so", ".dylib", ".dll", ".exe", ".bin", ".node"]);

async function readWorkspaceFile(root: string, path: string): Promise<JsonObject> {
  const { target, rel } = await resolveInsideRoot(root, path);
  const info = await stat(target);
  if (!info.isFile()) throw new HttpError(400, "not a regular file");
  const extension = extname(target).toLowerCase();
  if (BINARY_EXTENSIONS.has(extension)) {
    return { path: rel, size: info.size, binary: true, truncated: false, content: "", language: extension.replace(/^\./u, "") };
  }
  const raw = await readFile(target);
  const truncated = raw.length > MAX_FILE_BYTES;
  const sliced = truncated ? raw.subarray(0, MAX_FILE_BYTES) : raw;
  if (sliced.includes(0)) {
    return { path: rel, size: info.size, binary: true, truncated, content: "", language: extension.replace(/^\./u, "") };
  }
  const content = sliced.toString("utf8");
  return {
    path: rel, size: info.size, binary: false, truncated, content,
    language: extension.replace(/^\./u, "") || "text",
    lines: content ? content.replace(/\n$/u, "").split("\n").length : 0,
  };
}

async function workspaceDiff(root: string): Promise<JsonObject> {
  try {
    const [{ stdout: patch }, { stdout: names }] = await Promise.all([
      execFileAsync("git", ["-C", root, "--no-pager", "diff", "--no-ext-diff", "--unified=80", "HEAD", "--", "."], { maxBuffer: 4 * 1024 * 1024 }),
      execFileAsync("git", ["-C", root, "diff", "--name-status", "HEAD", "--", "."], { maxBuffer: 512 * 1024 }),
    ]);
    return { available: true, files: names.trim().split("\n").filter(Boolean).map(line => { const [status, ...path] = line.split("\t"); return { status, path: path.join("\t") }; }), patch };
  } catch (error) {
    return { available: false, files: [], patch: "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function fileVersions(root: string, path: string): Promise<JsonObject> {
  const { rel, target } = await resolveInsideRoot(root, path);
  if (!rel) throw new HttpError(400, "file path escapes workspace");
  const current = await readFile(target, "utf8");
  let original = "";
  try { ({ stdout: original } = await execFileAsync("git", ["-C", root, "show", `HEAD:${rel}`], { maxBuffer: 2 * 1024 * 1024 })); } catch { /* untracked file */ }
  return { path: rel, original, current };
}

function diffPage(data: JsonObject): string {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const patch = escape(String(data.patch || "")).split("\n").map(line => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
    return `<span class="${cls}">${line || " "}</span>`;
  }).join("\n");
  const files = (Array.isArray(data.files) ? data.files : []).map(file => {
    const item = record(file); return `<li><b>${escape(String(item.status || "M"))}</b> ${escape(String(item.path || ""))}</li>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>代码变更 · luban</title><style>body{margin:0;background:#080a0d;color:#e8ecf2;font:14px/1.5 system-ui;padding:24px}main{max-width:1100px;margin:auto}h1{font-size:20px}.files,pre{background:#12161e;border:1px solid #28303d;border-radius:8px}.files{padding:12px 28px}.files li{padding:3px;font:12px monospace}pre{padding:14px;overflow:auto;font:12px/1.5 monospace}.add{color:#8ee6b8}.del{color:#ff9aa8}.muted{color:#8993a3}</style><main><p><a href="/" style="color:#72a7ff">← 返回控制台</a></p><h1>代码变更</h1><p class="muted">工作区修改相对于当前 Git HEAD 的对比</p><ul class="files">${files || "<li class=muted>没有检测到 Git 变更</li>"}</ul><pre>${patch || "没有可显示的差异"}</pre></main>`;
}

export interface LubanWebServerOptions {
  host?: string;
  port?: number;
  /** Installed by the CLI so browser clients can answer tool approval prompts. */
  approvals?: ApprovalBroker;
  questions?: QuestionBroker;
  /**
   * Access token for browser clients. Required as soon as the server listens
   * beyond loopback, because every route can start an agent that runs shell
   * commands in the workspace.
   */
  token?: string;
}

export class LubanWebServer {
  private server?: Server;
  private readonly codexQuota = createCodexQuotaReader();
  private codexResetting = false;
  private readonly listeners = new Set<ServerResponse>();
  private readonly interactiveJobs = new Set<string>();
  private readonly jobModes = new Map<string, "edits" | "agent" | "read">();
  private heartbeat?: NodeJS.Timeout;
  private detach?: () => void;
  host: string;
  port: number;
  readonly approvals?: ApprovalBroker;
  readonly questions?: QuestionBroker;
  readonly auth?: AuthGate;

  constructor(readonly config: LubanConfig, readonly mesh: MeshRuntime, options: LubanWebServerOptions = {}) {
    this.host = options.host || "127.0.0.1";
    this.port = options.port ?? 0;
    if (options.approvals) this.approvals = options.approvals;
    if (options.questions) this.questions = options.questions;
    if (options.token) this.auth = new AuthGate(options.token);
  }

  /** True when a token was configured, i.e. requests must carry one. */
  get requiresToken(): boolean {
    return Boolean(this.auth?.enabled);
  }

  /** True when the client asked for interactive approval on this job. */
  isInteractiveJob(id: string): boolean {
    return this.interactiveJobs.has(id);
  }

  jobMode(id: string): "edits" | "agent" | "read" {
    return this.jobModes.get(id) ?? "edits";
  }

  async start(): Promise<string> {
    if (this.server) return this.url();
    this.server = createServer((req, res) => { void this.route(req, res); });
    this.server.requestTimeout = 130_000;
    this.server.headersTimeout = 15_000;
    this.detach = this.mesh.onEvent(event => this.broadcast(event));
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error) => reject(new Error(`web ${this.host}:${this.port}: ${error.message}`));
      this.server!.once("error", onError);
      this.server!.listen(this.port, this.host, () => {
        this.server!.removeListener("error", onError);
        const address = this.server!.address();
        if (address && typeof address !== "string") this.port = address.port;
        resolveStart();
      });
    });
    this.heartbeat = setInterval(() => this.write(this.listeners, ": keep-alive\n\n"), SSE_HEARTBEAT_MS);
    this.heartbeat.unref?.();
    return this.url();
  }

  url(): string {
    const displayHost = ["0.0.0.0", "::", "::0"].includes(this.host) ? "127.0.0.1" : this.host;
    return `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${this.port}/`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.detach?.();
    this.detach = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const listener of this.listeners) listener.end();
    this.listeners.clear();
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolveStop) => server.close(() => resolveStop())).catch(() => undefined);
  }

  private write(listeners: Iterable<ServerResponse>, body: string): void {
    for (const listener of listeners) {
      try { listener.write(body); } catch { this.listeners.delete(listener); }
    }
  }

  private broadcast(event: MeshEvent): void {
    if (!this.listeners.size) return;
    if (event.type === "job-log" || event.type === "job-event") {
      // Only the job detail view needs per-line traffic; keep it scoped so a
      // busy node does not push megabytes to every open tab.
      this.write(this.listeners, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      return;
    }
    if (event.type === "peer" || event.type === "chat" || event.type === "job") {
      this.write(this.listeners, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || "/", "http://luban.local");
      const decision = this.auth ? this.auth.check(req, url) : { ok: true as const };
      if (!decision.ok) return rejectAuth(res, decision, url.pathname.startsWith("/api/"));
      // One link carrying ?token= is exchanged for a cookie, so the SSE stream
      // (EventSource cannot send headers) authenticates on every reconnect.
      if (decision.source === "query" && decision.token) res.setHeader("set-cookie", tokenCookie(decision.token));
      if (url.pathname === "/login" || url.pathname === "/login/") {
        res.writeHead(302, { location: "/m/" });
        res.end();
        return;
      }
      if (url.pathname === "/logout") {
        res.writeHead(302, { location: "/m/", "set-cookie": clearCookie("luban_token") });
        res.end();
        return;
      }
      if (req.method === "GET") return await this.get(url, res);
      if (req.method === "POST") return await this.post(url, req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204, { allow: "GET, POST, OPTIONS" });
        res.end();
        return;
      }
      throw new HttpError(405, "method not allowed");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, status);
    }
  }

  private async get(url: URL, res: ServerResponse): Promise<void> {
    if (url.pathname === "/api/events") return this.eventStream(res);
    if (["/", "/index.html"].includes(url.pathname)) {
      const bundle = await readFile(webAssetPath("index.html"), "utf8").catch(() => undefined);
      if (bundle) return send(res, 200, "text/html; charset=utf-8", bundle);
      const dashboard = DASHBOARD_HTML.replace('<a href="/docs/"', '<a href="/diff" style="margin-left:auto;color:inherit">代码变更</a><a href="/docs/"');
      return send(res, 200, "text/html; charset=utf-8", dashboard);
    }
    if (url.pathname.startsWith("/assets/")) return this.webAsset(url.pathname, res);
    // Phone console. Served under /m/ so its relative asset URLs resolve, and so
    // the desktop page and the mobile page can be bookmarked independently.
    if (url.pathname === "/m") {
      res.writeHead(302, { location: "/m/" });
      res.end();
      return;
    }
    if (url.pathname === "/m/" || url.pathname === "/m/index.html") {
      const mobile = await readFile(webAssetPath("mobile.html"), "utf8").catch(() => undefined);
      if (!mobile) throw new HttpError(404, "mobile console bundle missing; run npm run build:web");
      return send(res, 200, "text/html; charset=utf-8", mobile);
    }
    if (url.pathname.startsWith("/m/")) return this.webAsset(url.pathname.slice(2), res);
    if (url.pathname === "/diff") {
      const project = url.searchParams.get("project") || this.config.project;
      return send(res, 200, "text/html; charset=utf-8", diffPage({ project, ...(await workspaceDiff(await this.mesh.workspaceFor(project))) }));
    }
    if (["/docs", "/docs/", "/docs/index.html"].includes(url.pathname)) return send(res, 200, "text/html; charset=utf-8", DOCS_HTML);
    if (url.pathname === "/api/docs") return json(res, [{ name: "index.html", title: "luban Web API", size: Buffer.byteLength(DOCS_HTML) }]);
    if (url.pathname === "/healthz") return json(res, { ok: true, serving: this.mesh.isServing() });
    if (url.pathname === "/favicon.ico") return send(res, 204, "image/x-icon", "");
    if (url.pathname === "/api/node") {
      return json(res, {
        name: this.config.mesh.nodeName,
        workspace: this.config.workspace,
        project: this.config.project,
        host: this.config.mesh.host,
        port: this.config.mesh.port,
        udp_port: this.config.mesh.udpPort,
        capabilities: this.config.mesh.capabilities,
        projects: this.mesh.projectMap(),
        serving: this.mesh.isServing(),
        model: this.config.model.model,
        model_id: this.config.model.id,
        provider: this.config.model.provider,
        reasoning_effort: this.config.model.reasoningEffort ?? null,
        models: this.config.models.map(model => ({ id: model.id, name: model.name, provider: model.provider,
          reasoning_effort: model.reasoningEffort ?? null, reasoning_efforts: supportedReasoningEfforts(model) })),
        version: VERSION,
        runtime: "nodejs",
        interactive: Boolean(this.approvals),
        auth_required: this.requiresToken,
        web: { host: this.host, port: this.port },
      });
    }
    if (url.pathname === "/api/codex/quota") {
      if (this.config.model.provider !== "codex") throw new HttpError(409, "当前模型不是 Codex");
      return json(res, await this.codexQuota.read());
    }
    if (url.pathname === "/api/themes") {
      return json(res, { active: resolveTheme(this.config.theme || "midnight", this.config.themeColors),
        themes: THEMES.map(({ id, label, mode, description }) => ({ id, label, mode, description })) });
    }
    if (url.pathname === "/api/peers") {
      return json(res, this.mesh.peers().map((peer) => ({
        name: peer.name,
        host: peer.host,
        port: peer.port,
        udp_port: peer.udpPort,
        capabilities: peer.capabilities,
        version: peer.version || "unknown",
        last_seen: peer.lastSeen,
        note: peer.note,
        online: peer.online,
      })));
    }
    if (url.pathname === "/api/inbox") return json(res, await this.mesh.inbox(Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)))));
    if (url.pathname === "/api/jobs") {
      // The job folder is one per machine, so a console that names no project
      // still sees every workspace (the desktop console wants that). The phone
      // names the workspace it is showing: without it a session of another
      // project read like a turn of the conversation on screen.
      return json(res, await this.mesh.jobs(MAX_JOBS, url.searchParams.get("project") || undefined));
    }
    const streamMatch = /^\/api\/jobs\/([^/]+)\/stream$/u.exec(url.pathname);
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[1]!);
      if (!await this.mesh.store.get(id)) throw new HttpError(404, "unknown job");
      const since = Math.max(0, Number(url.searchParams.get("since") || 0) || 0);
      const stream = this.mesh.jobStream(id, since);
      return json(res, { ok: true, job_id: id, next: stream.next, complete: stream.complete, events: stream.events });
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(url.pathname);
    if (jobMatch) {
      const id = decodeURIComponent(jobMatch[1]!);
      const job = await this.mesh.store.get(id);
      if (!job) throw new HttpError(404, "unknown job");
      const stream = this.mesh.jobStream(id, 0);
      return json(res, {
        ...job,
        logs: (job.logs || []).slice(-MAX_LOGS),
        events: stream.events,
        event_next: stream.next,
        interactive: this.interactiveJobs.has(id),
        approvals: this.approvals?.pending(id) ?? [],
        questions: this.questions?.pending(id) ?? [],
      });
    }
    if (url.pathname === "/api/approvals") {
      if (!this.approvals) return json(res, []);
      const job = url.searchParams.get("job") || undefined;
      return json(res, this.approvals.pending(job));
    }
    if (url.pathname === "/api/questions") {
      if (!this.questions) return json(res, []);
      return json(res, this.questions.pending(url.searchParams.get("job") || undefined));
    }
    if (url.pathname === "/api/workspace") {
      const project = url.searchParams.get("project") || this.config.project;
      const root = await this.mesh.workspaceFor(project);
      return json(res, { project, root, tree: await workspaceTree(root, url.searchParams.get("sub") || "") });
    }
    if (url.pathname === "/api/file") {
      const project = url.searchParams.get("project") || this.config.project;
      return json(res, await readWorkspaceFile(await this.mesh.workspaceFor(project), url.searchParams.get("path") || ""));
    }
    if (url.pathname === "/api/file-versions") {
      const project = url.searchParams.get("project") || this.config.project;
      return json(res, await fileVersions(await this.mesh.workspaceFor(project), url.searchParams.get("path") || ""));
    }
    if (url.pathname === "/api/diff") {
      const project = url.searchParams.get("project") || this.config.project;
      return json(res, { project, ...(await workspaceDiff(await this.mesh.workspaceFor(project))) });
    }
    if (url.pathname === "/api/sessions") {
      const project = url.searchParams.get("project") || this.config.project;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 60)));
      const store = new SessionStore(this.config.home, sharedHistory(this.config.history, this.config.home));
      const overlay = new Map((await store.list(project)).map(session => [session.id, session]));
      for (const live of liveSessions.list(this.config.home, project)) {
        const saved = overlay.get(live.session.id);
        if (live.running || !saved || live.session.updatedAt >= saved.updatedAt) overlay.set(live.session.id, live.session);
      }
      const sessions = [...overlay.values()].filter(hasConversation).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(session => ({
        id: session.id,
        title: session.title,
        project: session.project,
        workspace: session.workspace,
        model: session.model,
        mode: session.mode,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        // The system prompt is harness plumbing, not a message the user sent.
        messages: session.messages.filter(message => message.role !== "system").length,
        edits: (session.edits || []).length,
      }));
      return json(res, sessions);
    }
    if (url.pathname === "/api/history") {
      const query = url.searchParams.get("q");
      const project = url.searchParams.get("project") || undefined;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 30)));
      const history = SessionHistory.openForRead(this.config.history, this.config.home);
      if (!history) return json(res, { enabled: this.config.history.enabled, sessions: [], hits: [] });
      try {
        return json(res, query
          ? { enabled: true, hits: history.search(query, limit) }
          : { enabled: true, sessions: history.sessions(project, limit) });
      } finally {
        history.close();
      }
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/u.exec(url.pathname);
    if (sessionMatch) {
      const store = new SessionStore(this.config.home, sharedHistory(this.config.history, this.config.home));
      const project = url.searchParams.get("project") || this.config.project;
      const id = decodeURIComponent(sessionMatch[1]!);
      const saved = await store.load(id, project);
      const live = liveSessions.get(this.config.home, project, id);
      const session = live && (live.running || !saved || live.session.updatedAt >= saved.updatedAt) ? live.session : saved;
      if (!session) throw new HttpError(404, "unknown session");
      // Tool payloads can be megabytes; the transcript only needs a bounded tail.
      const messages = session.messages.map((message) => {
        const content = message.content ?? "";
        return {
          ...message,
          content: content.length > 20_000 ? `${content.slice(0, 20_000)}\n… (${content.length - 20_000} more characters)` : content,
        };
      });
      return json(res, { ...session, messages, live: { running: live?.running ?? false, events: live?.running ? live.events : [] } });
    }
    throw new HttpError(404, "not found");
  }

  private eventStream(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 2000\n\n`);
    this.listeners.add(res);
    res.on("close", () => this.listeners.delete(res));
  }

  private async webAsset(pathname: string, res: ServerResponse): Promise<void> {
    const relativePath = pathname.replace(/^\/+/u, "");
    // Resolve inside dist/web only: the request path is client controlled.
    if (relativePath.includes("..")) throw new HttpError(400, "invalid asset path");
    const body = await readFile(webAssetPath(relativePath)).catch(() => undefined);
    if (!body) throw new HttpError(404, "not found");
    const type = WEB_CONTENT_TYPES[extname(relativePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.length,
      "cache-control": relativePath.includes(".") && /\.[0-9a-f]{8,}\./u.test(relativePath) ? "public, max-age=31536000, immutable" : "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }

  private async post(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (url.pathname === "/api/theme") {
      const theme = typeof body.id === "string" ? findTheme(body.id) : undefined;
      if (!theme) throw new HttpError(400, "unknown theme");
      await saveTheme(this.config.home, theme.id);
      this.config.theme = theme.id;
      return json(res, { active: resolveTheme(theme.id, this.config.themeColors) });
    }
    if (url.pathname === "/api/model") {
      const model = this.config.models.find(item => item.id === body.model);
      if (!model) throw new HttpError(400, "unknown model");
      const effort = body.reasoning_effort;
      if (effort !== undefined && effort !== null && !supportedReasoningEfforts(model).some(value => value === effort)) {
        throw new HttpError(400, "unsupported reasoning effort for this model");
      }
      const selected = effort === undefined ? model : { ...model, reasoningEffort: effort === null ? undefined : effort as typeof model.reasoningEffort };
      await savePreferredModel(this.config.home, model.id, effort as typeof model.reasoningEffort | null);
      this.config.models = this.config.models.map(item => item.id === selected.id ? selected : item);
      this.config.model = selected;
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/models/active") {
      const requested = String(body.id || body.model || "").trim();
      const found = this.config.models.find(model => model.id === requested || model.model === requested);
      if (!found) throw new HttpError(404, "unknown model");
      // Jobs snapshot config.model when they start, so switching here applies to
      // the next task without disturbing one already running.
      this.config.model = found;
      try { await savePreferredModel(this.config.home, found.id, found.reasoningEffort); }
      catch (error) { throw new HttpError(500, `could not save model choice: ${error instanceof Error ? error.message : String(error)}`); }
      return json(res, { ok: true, model_id: found.id, model: found.model, provider: found.provider, name: found.name });
    }
    if (url.pathname === "/api/codex/quota/reset") {
      if (this.config.model.provider !== "codex") throw new HttpError(409, "当前模型不是 Codex");
      const request = codexResetRequest(body);
      if (request.error) throw new HttpError(400, request.error);
      // One consume at a time: a second click must not spend a second card.
      if (this.codexResetting) throw new HttpError(409, "正在处理另一个重置请求，请稍后查看额度");
      this.codexResetting = true;
      try {
        const result = await consumeCodexReset(request.creditId, undefined, request.requestId);
        // The card is gone now, so cached window percentages are already stale.
        this.codexQuota.invalidate();
        return json(res, { ok: true, outcome: result.outcome, message: formatCodexResetOutcome(result.outcome),
          quota: await this.codexQuota.read() });
      } catch (error) {
        throw new HttpError(502, `重置结果不确定：${error instanceof Error ? error.message : String(error)}。请先刷新额度确认，再决定是否重试。`);
      } finally {
        this.codexResetting = false;
      }
    }
    if (url.pathname === "/api/projects") {
      const rawPath = typeof body.path === "string" ? body.path.trim() : "";
      const requested = cleanProjectName(body.name);
      if (!rawPath && !requested) throw new HttpError(400, "请提供工作区名称或电脑目录");
      let workspace: string;
      if (rawPath) {
        if (!isAbsolute(rawPath)) throw new HttpError(400, "请填写电脑上的绝对路径，例如 /home/me/project");
        const resolved = resolve(rawPath);
        if (parse(resolved).root === resolved) throw new HttpError(400, "不能把文件系统根目录注册为工作区");
        try { workspace = await realpath(resolved); }
        catch { throw new HttpError(400, "目录不存在或无法读取"); }
        const info = await stat(workspace).catch(() => undefined);
        if (!info?.isDirectory()) throw new HttpError(400, "路径不是目录");
      } else {
        const target = join(this.config.mesh.workspacesDir, requested);
        const configured = this.config.mesh.projects[requested];
        if (configured && resolve(configured) !== resolve(target)) {
          throw new HttpError(409, `项目“${requested}”已存在：${configured}`);
        }
        await mkdir(target, { recursive: true });
        workspace = await realpath(target);
      }
      // Registering the same directory twice should select it, not create a
      // second project id that points at the same files.
      const already = Object.entries(this.config.mesh.projects)
        .find(([, path]) => resolve(path) === workspace);
      if (already) return json(res, { ok: true, project: already[0], workspace, created: false });
      let name = requested || cleanProjectName(basename(workspace));
      if (!name) throw new HttpError(400, "无法从目录名生成项目名称，请指定名称");
      if (this.config.mesh.projects[name]) {
        if (requested) throw new HttpError(409, `项目“${name}”已被其他目录使用`);
        name = uniqueProjectName(this.config.mesh.projects, name, workspace);
      }
      await saveProject(this.config.home, name, workspace);
      this.config.mesh.projects = { ...this.config.mesh.projects, [name]: workspace };
      this.mesh.registerProject(name, workspace);
      return json(res, { ok: true, project: name, workspace, created: !rawPath });
    }
    if (url.pathname === "/api/jobs") {
      const interaction = String(body.interaction || "auto");
      const project = String(body.project_id || this.config.project);
      const requestedSession = typeof body.session_id === "string" ? body.session_id.trim() : "";
      if (requestedSession && liveSessions.get(this.config.home, project, requestedSession)?.running) {
        throw new HttpError(409, "session is running in the terminal");
      }
      // A continuation must reuse the session's own workspace, not the project
      // mapping: sessions record the directory the Agent actually worked in.
      const continued = requestedSession
        ? await new SessionStore(this.config.home, sharedHistory(this.config.history, this.config.home)).load(requestedSession, project)
        : undefined;
      if (requestedSession && !continued) throw new HttpError(404, "unknown session");
      if (requestedSession && liveSessions.get(this.config.home, project, requestedSession)?.running) {
        throw new HttpError(409, "session is running in the terminal");
      }
      const job = await this.mesh.submitLocalJob({
        instruction: String(body.instruction || ""),
        project,
        title: String(body.title || ""),
        kind: String(body.kind || "task"),
        ...(continued ? { session_id: continued.id, workspace: continued.workspace } : {}),
      });
      const mode = ["edits", "agent", "read"].includes(String(body.mode)) ? String(body.mode) as "edits" | "agent" | "read" : "edits";
      this.jobModes.set(job.id, mode);
      if (interaction !== "off" && this.approvals) this.interactiveJobs.add(job.id);
      return json(res, { ok: true, job_id: job.id, status: job.status, interactive: this.interactiveJobs.has(job.id), mode });
    }
    const cancelMatch = /^\/api\/jobs\/([^/]+)\/cancel$/u.exec(url.pathname);
    const resumeMatch = /^\/api\/jobs\/([^/]+)\/resume$/u.exec(url.pathname);
    if (resumeMatch) {
      const id = decodeURIComponent(resumeMatch[1]!);
      if (!await this.mesh.store.get(id)) throw new HttpError(404, "unknown job");
      try {
        const job = await this.mesh.resumeLocalJob(id);
        return json(res, { ok: true, job_id: job.id, status: job.status });
      } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : String(error)); }
    }
    if (cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]!);
      if (!await this.mesh.store.get(id)) throw new HttpError(404, "unknown job");
      this.approvals?.denyAll(id);
      this.questions?.cancelAll(id);
      if (!await this.mesh.cancelLocalJob(id, "cancelled from Node web workspace")) throw new HttpError(409, "job is already finished");
      return json(res, { ok: true, job_id: id, status: "cancelled" });
    }
    if (url.pathname === "/api/approvals") {
      const broker = this.approvals;
      if (!broker) throw new HttpError(409, "interactive approval is not enabled on this server");
      const id = String(body.id || "");
      const decision = String(body.decision || "deny") as ApprovalDecision;
      if (!["once", "tool", "always", "deny"].includes(decision)) throw new HttpError(400, "decision must be once|tool|always|deny");
      if (!broker.decide(id, decision)) throw new HttpError(404, "unknown or already settled approval request");
      return json(res, { ok: true, id, decision });
    }
    if (url.pathname === "/api/questions") {
      if (!this.questions) throw new HttpError(409, "interactive questions are not enabled on this server");
      const id = String(body.id || "");
      const answer = String(body.answer || "").trim();
      if (!answer || answer.length > 2000) throw new HttpError(400, "answer must be 1–2000 characters");
      if (!this.questions.answer(id, answer)) throw new HttpError(404, "unknown or already answered question");
      return json(res, { ok: true, id });
    }
    if (url.pathname === "/api/sync") {
      const peer = String(body.peer || "").trim();
      const direction = String(body.direction || "push").toLowerCase();
      const project = String(body.project_id || this.config.project);
      const mode = String(body.mode || this.config.mesh.syncMode) as SyncMode;
      if (!peer) throw new HttpError(400, "missing peer");
      if (!["push", "pull"].includes(direction)) throw new HttpError(400, "direction must be push|pull");
      if (!["auto", "git", "chunk"].includes(mode)) throw new HttpError(400, "mode must be auto|git|chunk");
      const workspace = body.workspace ? resolve(String(body.workspace)) : await this.mesh.workspaceFor(project);
      const output = direction === "push"
        ? await this.mesh.syncPush(peer, project, workspace, mode)
        : await this.mesh.syncPull(peer, project, workspace, mode);
      return json(res, { ok: true, output });
    }
    if (url.pathname === "/api/chat") {
      const output = await this.mesh.message(String(body.peer || ""), String(body.message || ""));
      return json(res, { ok: true, output });
    }
    if (url.pathname === "/api/contacts") {
      const name = String(body.name || "").trim();
      const host = String(body.host || "127.0.0.1").trim();
      const port = Number(body.port || this.config.mesh.port);
      const udpPort = Number(body.udp_port || body.udpPort || 0);
      if (!name) throw new HttpError(400, "missing name");
      if (!host) throw new HttpError(400, "missing host");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "invalid TCP port");
      if (!Number.isInteger(udpPort) || udpPort < 0 || udpPort > 65535) throw new HttpError(400, "invalid UDP port");
      await this.mesh.addContact({ name, host, port, udpPort, note: String(body.note || "") });
      return json(res, { ok: true });
    }
    if (url.pathname === "/api/ping") return json(res, { ok: true, output: await this.mesh.ping(String(body.peer || "")) });
    if (url.pathname === "/api/status") return json(res, await this.mesh.status(String(body.peer || "")));
    if (url.pathname === "/api/handoff") {
      const output = await this.mesh.handoff(
        String(body.peer || ""),
        String(body.instruction || ""),
        String(body.project_id || this.config.project),
        Math.max(30, Math.min(3600, Number(body.timeout || 300))),
      );
      return json(res, { ok: true, output });
    }
    throw new HttpError(404, "not found");
  }
}

export type { JobStreamRecord };
