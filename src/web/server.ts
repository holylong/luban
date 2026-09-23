import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { JobStreamRecord, MeshEvent, MeshRuntime } from "../core/mesh/runtime.js";
import { SessionStore } from "../core/session-store.js";
import type { LubanConfig, SyncMode } from "../core/types.js";
import { VERSION } from "../version.js";
import { DASHBOARD_HTML, DOCS_HTML, webAssetPath, WEB_CONTENT_TYPES } from "./assets.js";
import { ApprovalBroker, type ApprovalDecision } from "./approval.js";

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
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
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
}

export class LubanWebServer {
  private server?: Server;
  private readonly listeners = new Set<ServerResponse>();
  private readonly interactiveJobs = new Set<string>();
  private readonly jobModes = new Map<string, "edits" | "agent" | "read">();
  private heartbeat?: NodeJS.Timeout;
  private detach?: () => void;
  host: string;
  port: number;
  readonly approvals?: ApprovalBroker;

  constructor(readonly config: LubanConfig, readonly mesh: MeshRuntime, options: LubanWebServerOptions = {}) {
    this.host = options.host || "127.0.0.1";
    this.port = options.port ?? 0;
    if (options.approvals) this.approvals = options.approvals;
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
        host: this.config.mesh.host,
        port: this.config.mesh.port,
        udp_port: this.config.mesh.udpPort,
        capabilities: this.config.mesh.capabilities,
        projects: this.mesh.projectMap(),
        serving: this.mesh.isServing(),
        model: this.config.model.model,
        provider: this.config.model.provider,
        models: this.config.models.map(model => ({ id: model.id, name: model.name, provider: model.provider })),
        version: VERSION,
        runtime: "nodejs",
        interactive: Boolean(this.approvals),
        web: { host: this.host, port: this.port },
      });
    }
    if (url.pathname === "/api/peers") {
      return json(res, this.mesh.peers().map((peer) => ({
        name: peer.name,
        host: peer.host,
        port: peer.port,
        udp_port: peer.udpPort,
        capabilities: peer.capabilities,
        last_seen: peer.lastSeen,
        note: peer.note,
        online: peer.online,
      })));
    }
    if (url.pathname === "/api/inbox") return json(res, await this.mesh.inbox(Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)))));
    if (url.pathname === "/api/jobs") return json(res, await this.mesh.jobs(MAX_JOBS));
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
      });
    }
    if (url.pathname === "/api/approvals") {
      if (!this.approvals) return json(res, []);
      const job = url.searchParams.get("job") || undefined;
      return json(res, this.approvals.pending(job));
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
      const store = new SessionStore(this.config.home);
      const sessions = (await store.list(project)).slice(0, limit).map(session => ({
        id: session.id,
        title: session.title,
        project: session.project,
        workspace: session.workspace,
        model: session.model,
        mode: session.mode,
        updatedAt: session.updatedAt,
        createdAt: session.createdAt,
        messages: session.messages.length,
        edits: (session.edits || []).length,
      }));
      return json(res, sessions);
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/u.exec(url.pathname);
    if (sessionMatch) {
      const store = new SessionStore(this.config.home);
      const project = url.searchParams.get("project") || this.config.project;
      const session = await store.load(decodeURIComponent(sessionMatch[1]!), project);
      if (!session) throw new HttpError(404, "unknown session");
      // Tool payloads can be megabytes; the transcript only needs a bounded tail.
      const messages = session.messages.map((message) => {
        const content = message.content ?? "";
        return {
          ...message,
          content: content.length > 20_000 ? `${content.slice(0, 20_000)}\n… (${content.length - 20_000} more characters)` : content,
        };
      });
      return json(res, { ...session, messages });
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
    if (url.pathname === "/api/jobs") {
      const interaction = String(body.interaction || "auto");
      const job = await this.mesh.submitLocalJob({
        instruction: String(body.instruction || ""),
        project: String(body.project_id || this.config.project),
        title: String(body.title || ""),
        kind: String(body.kind || "task"),
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
