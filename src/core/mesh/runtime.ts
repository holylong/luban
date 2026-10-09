import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, join, resolve } from "node:path";
import fg from "fast-glob";
import { saveMeshContact } from "../config.js";
import type { LubanConfig, MeshContact, SyncMode, RunResult } from "../types.js";
import { VERSION } from "../../version.js";
import { MeshJobStore, type MeshJob } from "./job-store.js";
import {
  decodeFrames,
  encodeFrame,
  envelope,
  type JsonObject,
  sendRpc,
  signObject,
  verifySignature,
} from "./protocol.js";
import {
  applyTransfer,
  buildTransfer,
  gitHead,
  planResponse,
  scanWorkspace,
  syncSummary,
} from "./sync.js";

export type { MeshJob } from "./job-store.js";

const DISCOVERY_TYPE = "luban.probe";
const ONLINE_SECONDS = 25;
const HANDOFF_LEASE_SECONDS = 60;
const MAX_POLL_LOG_LINES = 300;
/** Structured events per poll reply: bounded like the log tail, so one very chatty job cannot stall a poll. */
const MAX_POLL_EVENTS = 200;
/** Per-job structured-event replay buffer. Bounded so a long task cannot grow memory without limit. */
const MAX_JOB_STREAM_EVENTS = 4000;

export interface MeshPeer {
  name: string;
  host: string;
  port: number;
  udpPort: number;
  capabilities: string[];
  lastSeen: number;
  note: string;
  online: boolean;
}

export interface MeshChatMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  received_at: number;
  delivered_at?: number;
}

export type MeshEvent =
  | { type: "peer"; peer: MeshPeer; discovered: boolean }
  | { type: "chat"; message: MeshChatMessage; from: string; text: string }
  | { type: "job"; job: MeshJob }
  | { type: "job-log"; id: string; level: string; message: string }
  /**
   * Structured agent activity for interfaces that must not parse log text.
   * `seq` is monotonic per job so a browser can resume a stream after a
   * reconnect without replaying everything it already rendered.
   */
  | { type: "job-event"; id: string; seq: number; event: JobStreamEvent }
  | { type: "warning"; message: string };

/** One structured step of a running job, mirroring `AgentEvent` for transports. */
export type JobStreamEvent =
  /**
   * A line for the working indicator. `progress` marks a phase label that is
   * re-announced while the job continues, as opposed to a notice about
   * something that happened; only notices belong in the durable record.
   */
  | { kind: "status"; text: string; progress?: boolean }
  /** A model round trip started; lets a remote UI show which one is in flight. */
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

export type MeshJobRunner = (
  job: MeshJob,
  signal: AbortSignal,
  onLog: (level: string, message: string) => void,
  /** Third argument is optional so existing runners keep working unchanged. */
  onEvent?: (event: JobStreamEvent) => void,
) => Promise<Pick<RunResult, "ok" | "text" | "stopReason">>;

function now(): number {
  return Date.now() / 1000;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolveWait();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

/**
 * Directed broadcast address of every usable IPv4 interface.
 *
 * `255.255.255.255` is a limited broadcast: it follows the routing table and
 * leaves through the default-route interface only. On a host with docker,
 * vmnet or a VPN adapter present that can be the wrong interface, and LAN peers
 * then never see the announcement. Sending to each interface's own subnet
 * broadcast (192.168.1.255) goes out that interface regardless of the default
 * route.
 */
export function directedBroadcasts(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const address = entry.address.split(".").map(Number);
      const mask = (entry.netmask || "255.255.255.0").split(".").map(Number);
      if (address.length !== 4 || mask.length !== 4) continue;
      if (address.some((part) => !Number.isInteger(part)) || mask.some((part) => !Number.isInteger(part))) continue;
      addresses.push(address.map((part, index) => ((part & mask[index]!) | (~mask[index]! & 255))).join("."));
    }
  }
  return [...new Set(addresses)];
}

export function announceHost(configured: string): string {
  if (configured && !["0.0.0.0", "::", "::0"].includes(configured)) return configured;
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
        candidates.push({ name, address: address.address });
      }
    }
  }
  candidates.sort((a, b) => Number(/docker|veth|br-|virbr/iu.test(a.name)) - Number(/docker|veth|br-|virbr/iu.test(b.name)));
  return candidates[0]?.address || "127.0.0.1";
}

function terminal(status: string): status is "done" | "failed" | "cancelled" | "paused" {
  return ["done", "failed", "cancelled", "paused"].includes(status);
}

export class MeshRuntime {
  store: MeshJobStore;
  private readonly instanceId = randomUUID();
  private readonly peersByName = new Map<string, MeshPeer>();
  private readonly projects = new Map<string, string>();
  private readonly listeners = new Set<(event: MeshEvent) => void>();
  private readonly seenMessageIds = new Map<string, number>();
  private readonly activeJobs = new Map<string, AbortController>();
  private readonly ownedJobs = new Set<string>();
  private readonly pollLogOffsets = new Map<string, number>();
  private readonly pollEventOffsets = new Map<string, number>();
  private readonly leaseDeadlines = new Map<string, number>();
  private readonly queuedJobs: string[] = [];
  /** Bounded replay buffer so a reconnecting browser can catch up on one job. */
  private readonly jobStreams = new Map<string, JobStreamRecord[]>();
  private readonly jobStreamSeq = new Map<string, number>();
  private server?: Server;
  private discovery?: DgramSocket;
  private heartbeat?: NodeJS.Timeout;
  private maintenance?: NodeJS.Timeout;
  private startedAt = now();
  private workingJobs = 0;
  private runner?: MeshJobRunner;
  private stopping = false;
  private initialized = false;

  constructor(readonly config: LubanConfig) {
    this.store = new MeshJobStore(config.mesh.jobsDir);
    for (const contact of config.mesh.contacts) this.setContact(contact);
    for (const [project, path] of Object.entries(config.mesh.projects)) this.projects.set(project, resolve(path));
    this.registerProject(config.project, config.workspace);
  }

  setJobRunner(runner: MeshJobRunner): void {
    this.runner = runner;
  }

  onEvent(listener: (event: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Structured replay for one job. `since` is the last `seq` a client already
   * holds; the return value says whether the buffer still covers that point.
   */
  jobStream(id: string, since = 0): { events: JobStreamRecord[]; next: number; complete: boolean } {
    const events = this.jobStreams.get(id) ?? [];
    const oldest = events[0]?.seq ?? 0;
    // A client asking for seq N expects N+1 next. If the buffer starts after
    // that, history was evicted and the caller must refetch the job snapshot.
    const complete = since === 0 || oldest === 0 || oldest <= since + 1;
    const remaining = events.filter(record => record.seq > since);
    return { events: remaining, next: remaining.at(-1)?.seq ?? since, complete };
  }

  private recordJobEvent(id: string, event: JobStreamEvent): void {
    const seq = (this.jobStreamSeq.get(id) ?? 0) + 1;
    this.jobStreamSeq.set(id, seq);
    const buffer = this.jobStreams.get(id) ?? [];
    buffer.push({ seq, at: Date.now() / 1000, event });
    if (buffer.length > MAX_JOB_STREAM_EVENTS) buffer.splice(0, buffer.length - MAX_JOB_STREAM_EVENTS);
    this.jobStreams.set(id, buffer);
    this.emit({ type: "job-event", id, seq, event });
  }

  private emit(event: MeshEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  registerProject(project: string, workspace: string): void {
    if (project) this.projects.set(project, resolve(workspace));
  }

  projectMap(): Record<string, string> {
    return Object.fromEntries(this.projects);
  }

  isServing(): boolean {
    return Boolean(this.server?.listening);
  }

  async workspaceFor(project: string): Promise<string> {
    const name = project || "default";
    const existing = this.projects.get(name);
    if (existing) {
      await mkdir(existing, { recursive: true });
      return existing;
    }
    if (basename(name) !== name || [".", ".."].includes(name) || name.includes("/") || name.includes("\\")) {
      throw new Error(`invalid project id: ${name}`);
    }
    const workspace = join(this.config.mesh.workspacesDir, name);
    await mkdir(workspace, { recursive: true });
    this.projects.set(name, workspace);
    return workspace;
  }

  async start(options: { allowPortFallback?: boolean } = {}): Promise<void> {
    if (this.server) return;
    this.stopping = false;
    if (!this.config.mesh.enabled) {
      if (!this.initialized) {
        await this.store.initialize();
        await this.failStaleNodeJobs();
        this.initialized = true;
      }
      return;
    }
    this.server = createServer((socket) => this.handleSocket(socket));
    const listen = (port: number) => new Promise<void>((resolveStart, reject) => {
      const error = (reason: Error) => reject(reason);
      this.server!.once("error", error);
      this.server!.listen(port, this.config.mesh.host, () => {
        this.server!.removeListener("error", error);
        const address = this.server!.address();
        if (address && typeof address !== "string") this.config.mesh.port = address.port;
        resolveStart();
      });
    });
    try {
      try {
        await listen(this.config.mesh.port);
      } catch (error) {
        if (!options.allowPortFallback || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        // Separate identity and storage prevent two live runtimes from
        // overwriting peer advertisements or marking each other's jobs stale.
        this.server!.removeAllListeners("listening");
        await listen(0);
        this.config.mesh.nodeName += `-${this.instanceId.slice(0, 8)}`;
        this.config.mesh.jobsDir = join(this.config.mesh.jobsDir, "instances", this.instanceId);
        this.store = new MeshJobStore(this.config.mesh.jobsDir);
      }
      if (!this.initialized) {
        await this.store.initialize();
        await this.failStaleNodeJobs();
        this.initialized = true;
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.startedAt = now();
    await this.startDiscovery().catch((error) => this.emit({ type: "warning", message: `UDP discovery disabled: ${String(error)}` }));
    this.maintenance = setInterval(() => {
      void this.maintainJobs().catch((error) => this.emit({ type: "warning", message: `job maintenance failed: ${error instanceof Error ? error.message : String(error)}` }));
    }, 2_000);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.maintenance) clearInterval(this.maintenance);
    this.heartbeat = undefined;
    this.maintenance = undefined;
    for (const controller of this.activeJobs.values()) controller.abort(new Error("mesh node stopping"));
    this.activeJobs.clear();
    if (this.discovery) {
      await new Promise<void>((resolveClose) => {
        this.discovery!.once("close", resolveClose);
        this.discovery!.close();
      }).catch(() => undefined);
      this.discovery = undefined;
    }
    if (this.server) {
      await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose())).catch(() => undefined);
      this.server = undefined;
    }
  }

  private async startDiscovery(): Promise<void> {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.discovery = socket;
    socket.on("message", (data) => this.handleDiscovery(data));
    socket.on("error", (error) => this.emit({ type: "warning", message: `mesh UDP: ${error.message}` }));
    await new Promise<void>((resolveBind, reject) => {
      const error = (reason: Error) => reject(reason);
      socket.once("error", error);
      socket.bind(this.config.mesh.udpPort, "0.0.0.0", () => {
        socket.removeListener("error", error);
        const address = socket.address();
        if (typeof address !== "string") this.config.mesh.udpPort = address.port;
        try { socket.setBroadcast(true); } catch { /* platform dependent */ }
        try { socket.addMembership("224.0.0.1"); } catch { /* optional multicast */ }
        resolveBind();
      });
    });
    this.broadcast();
    this.heartbeat = setInterval(() => this.broadcast(), 5_000);
  }

  private nodeInfo(): JsonObject {
    const info: JsonObject = {
      name: this.config.mesh.nodeName,
      host: announceHost(this.config.mesh.host),
      port: this.config.mesh.port,
      udp_port: this.config.mesh.udpPort,
      capabilities: this.config.mesh.capabilities,
    };
    if (this.config.mesh.token) info.auth = signObject(info, this.config.mesh.token);
    return info;
  }

  private broadcast(): void {
    if (!this.discovery) return;
    const payload = Buffer.from(JSON.stringify({ type: DISCOVERY_TYPE, announce: this.nodeInfo() }));
    const destinations = new Map<string, number>([
      ["255.255.255.255", this.config.mesh.udpPort],
      ["224.0.0.1", this.config.mesh.udpPort],
      ...directedBroadcasts().map((address) => [address, this.config.mesh.udpPort] as [string, number]),
      ...this.peers().filter((peer) => peer.udpPort > 0).map((peer) => [peer.host, peer.udpPort] as [string, number]),
    ]);
    for (const [host, port] of destinations) this.discovery.send(payload, port, host, () => undefined);
  }

  private handleDiscovery(data: Buffer): void {
    let message: JsonObject;
    try { message = JSON.parse(data.toString("utf8")) as JsonObject; } catch { return; }
    if (message.type !== DISCOVERY_TYPE) return;
    const info = record(message.announce);
    if (!verifySignature(info, this.config.mesh.token)) return;
    const name = String(info.name || "");
    if (!name || name === this.config.mesh.nodeName) return;
    const existing = this.peersByName.get(name);
    const peer: MeshPeer = {
      name,
      host: String(info.host || existing?.host || ""),
      port: Number(info.port || existing?.port || 0),
      udpPort: Number(info.udp_port || existing?.udpPort || 0),
      capabilities: Array.isArray(info.capabilities) ? info.capabilities.map(String) : existing?.capabilities || [],
      lastSeen: now(),
      note: existing?.note || "",
      online: true,
    };
    if (!peer.host || !peer.port) return;
    this.peersByName.set(name, peer);
    this.emit({ type: "peer", peer, discovered: !existing });
  }

  private handleSocket(socket: Socket): void {
    let buffer: Buffer = Buffer.alloc(0);
    socket.setTimeout(60_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded;
      try { decoded = decodeFrames(buffer); } catch { socket.destroy(); return; }
      buffer = decoded.remaining;
      for (const message of decoded.messages) {
        void this.handleMessage(message).then((reply) => {
          if (message.expect_reply === false || socket.destroyed) return;
          reply.reply_to ??= String(message.id || "");
          socket.write(encodeFrame(reply));
        });
      }
    });
    socket.on("error", () => undefined);
  }

  private authorized(message: JsonObject): boolean {
    if (!verifySignature(message, this.config.mesh.token)) return false;
    if (!this.config.mesh.token || !message.type) return true;
    const timestamp = Number(message.ts);
    const id = String(message.id || "");
    const current = now();
    if (!id || !Number.isFinite(timestamp) || Math.abs(current - timestamp) > 300) return false;
    for (const [seenId, seenAt] of this.seenMessageIds) if (current - seenAt > 300) this.seenMessageIds.delete(seenId);
    if (this.seenMessageIds.has(id)) return false;
    this.seenMessageIds.set(id, current);
    return true;
  }

  private async handleMessage(message: JsonObject): Promise<JsonObject> {
    if (!this.authorized(message)) return { ok: false, error: "unauthorized mesh message" };
    const payload = record(message.payload);
    try {
      switch (message.type) {
        case "hello": return { ok: true, ...this.nodeInfo() };
        case "ping": return { ok: true, pong: now(), name: this.config.mesh.nodeName };
        case "node_status": return this.nodeStatus();
        case "chat": return this.receiveChat(message, payload);
        case "job_submit": return this.receiveJob(message, payload);
        case "job_poll": return this.pollJob(message, payload);
        case "job_cancel": return this.receiveCancel(message, payload);
        case "job_resume": {
          const id = String(payload.job_id || "");
          const job = await this.store.get(id);
          if (!job || job.source !== String(message.from || "")) return { ok: false, error: "only the submitting node may resume this job" };
          const resumed = await this.resumeLocalJob(id);
          return { ok: true, job_id: id, status: resumed.status };
        }
        case "sync_request": return planResponse(await this.workspaceFor(String(payload.project_id || "")), payload, this.config.mesh.syncIgnore);
        case "sync_transfer": return { ok: true, ...await applyTransfer(await this.workspaceFor(String(payload.project_id || "")), payload, this.config.mesh.conflictPolicy) };
        case "sync_pull": {
          const workspace = await this.workspaceFor(String(payload.project_id || ""));
          const plan = await planResponse(workspace, payload, this.config.mesh.syncIgnore);
          return { ok: true, ...await buildTransfer(plan, workspace, this.config.mesh.conflictPolicy, this.config.mesh.nodeName, this.config.mesh.chunkSize) };
        }
        case "sync_manifest": {
          const workspace = await this.workspaceFor(String(payload.project_id || ""));
          return { ok: true, files: await scanWorkspace(workspace, this.config.mesh.syncIgnore), head: await gitHead(workspace) || null };
        }
        case "sync_fetch": {
          const workspace = await this.workspaceFor(String(payload.project_id || ""));
          return { ok: true, ...await buildTransfer(record(payload.plan), workspace, this.config.mesh.conflictPolicy, this.config.mesh.nodeName, this.config.mesh.chunkSize) };
        }
        default: return { ok: false, error: `unknown message type: ${String(message.type || "")}` };
      }
    } catch (error) {
      return { ok: false, error: `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async nodeStatus(): Promise<JsonObject> {
    const current = now();
    const jobs = (await this.store.list(20)).filter((job) => ["queued", "working"].includes(job.status)).map((job) => ({
      id: job.id,
      status: job.status,
      kind: job.kind,
      logs: job.logs?.length || 0,
      idle_s: Math.round(Math.max(0, current - (job.updated_at || job.created_at || current)) * 10) / 10,
      stuck: current - (job.updated_at || job.created_at || current) > 60,
      instruction: job.instruction.slice(0, 120),
      result: job.result.slice(0, 120),
    }));
    return {
      ok: true,
      name: this.config.mesh.nodeName,
      version: `luban/${VERSION}`,
      uptime_s: Math.round((current - this.startedAt) * 10) / 10,
      pool_workers: this.config.mesh.maxWorkers,
      queued_jobs: jobs.filter((job) => job.status === "queued").length,
      working_jobs: jobs.filter((job) => job.status === "working").length,
      active_jobs: jobs,
      server_time: current,
    };
  }

  private async receiveChat(envelopeMessage: JsonObject, payload: JsonObject): Promise<JsonObject> {
    const from = String(envelopeMessage.from || payload.from || "?");
    const text = String(payload.text || "").trim();
    if (!text) return { ok: false, error: "empty chat message" };
    const message: MeshChatMessage = {
      id: String(payload.message_id || envelopeMessage.id || randomUUID()),
      from,
      to: this.config.mesh.nodeName,
      text,
      received_at: now(),
    };
    await mkdir(this.config.mesh.jobsDir, { recursive: true });
    await appendFile(join(this.config.mesh.jobsDir, "chat-inbox.log"), `${new Date().toISOString()} [${from}] ${text}\n`, "utf8");
    await appendFile(join(this.config.mesh.jobsDir, "chat-inbox.jsonl"), `${JSON.stringify(message)}\n`, "utf8");
    this.emit({ type: "chat", message, from, text });
    return { ok: true, message_id: message.id, received_at: message.received_at, received_by: this.config.mesh.nodeName };
  }

  async inbox(limit = 50): Promise<MeshChatMessage[]> {
    try {
      const source = await readFile(join(this.config.mesh.jobsDir, "chat-inbox.jsonl"), "utf8");
      return source.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as MeshChatMessage]; } catch { return []; }
      }).slice(-Math.max(1, Math.min(500, limit))).reverse();
    } catch { return []; }
  }

  /** Both directions in one durable timeline for terminals opened after delivery. */
  async chats(limit = 50): Promise<MeshChatMessage[]> {
    const read = async (file: string): Promise<MeshChatMessage[]> => {
      try {
        const source = await readFile(join(this.config.mesh.jobsDir, file), "utf8");
        return source.split(/\r?\n/).filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line) as MeshChatMessage]; } catch { return []; }
        });
      } catch { return []; }
    };
    const [inbound, outbound] = await Promise.all([read("chat-inbox.jsonl"), read("chat-outbox.jsonl")]);
    return [...inbound, ...outbound]
      .sort((a, b) => (b.delivered_at ?? b.received_at) - (a.delivered_at ?? a.received_at))
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  private async workspaceHasFiles(workspace: string): Promise<boolean> {
    const files = await fg("**/*", {
      cwd: workspace,
      onlyFiles: true,
      dot: true,
      // A hidden tool cache such as `.dagent/winbuild/_home/.wine/dosdevices/z:`
      // is a symlink to the filesystem root. Following it walks this "does the
      // project have context?" probe out of the workspace into root-owned
      // directories (lost+found) where scandir throws EACCES, and without
      // suppressErrors that EACCES rejects an un-awaited promise and kills the
      // mesh node. Skip symlinks and tolerate unreadable entries.
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore: [".luban/**", ".dagent/**"],
    });
    return files.length > 0;
  }

  private async receiveJob(message: JsonObject, payload: JsonObject): Promise<JsonObject> {
    if (!this.runner) return { ok: false, error: "node agent runner is not configured" };
    const instruction = String(payload.instruction || "").trim();
    if (!instruction) return { ok: false, error: "empty instruction" };
    const project = String(payload.project_id || "");
    const workspace = await this.workspaceFor(project);
    if (!await this.workspaceHasFiles(workspace)) {
      return { ok: false, error: `no context for project "${project}" (workspace empty: ${workspace}); push the project first via mesh sync before submitting jobs` };
    }
    const leaseSeconds = Math.max(0, Math.min(120, Number(payload.lease_seconds || 0)));
    const job = await this.enqueueJob({
      id: String(payload.job_id || `job-${Date.now()}`),
      source: String(message.from || payload.source || "?"),
      kind: String(payload.kind || "task"),
      project,
      workspace,
      instruction,
      title: String(payload.title || ""),
      leaseSeconds,
    });
    return { ok: true, job_id: job.id, status: "queued" };
  }

  async submitLocalJob(input: {
    instruction: string;
    project?: string;
    title?: string;
    kind?: string;
  }): Promise<MeshJob> {
    if (!this.runner) throw new Error("node agent runner is not configured");
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error("empty instruction");
    const project = input.project || this.config.project;
    return this.enqueueJob({
      source: this.config.mesh.nodeName,
      kind: input.kind || "task",
      project,
      workspace: await this.workspaceFor(project),
      instruction,
      title: input.title || instruction.slice(0, 60),
      leaseSeconds: 0,
    });
  }

  private async enqueueJob(input: {
    id?: string;
    source: string;
    kind: string;
    project: string;
    workspace: string;
    instruction: string;
    title?: string;
    leaseSeconds: number;
  }): Promise<MeshJob> {
    const job = await this.store.create({
      ...(input.id ? { id: input.id } : {}),
      source: input.source,
      target: this.config.mesh.nodeName,
      kind: input.kind,
      project_id: input.project,
      workspace: input.workspace,
      instruction: input.instruction,
      title: input.title,
      status: "queued",
      lease_seconds: input.leaseSeconds,
      lease_deadline: input.leaseSeconds ? now() + input.leaseSeconds : undefined,
      runtime: "nodejs",
      instance_id: this.instanceId,
    });
    this.ownedJobs.add(job.id);
    this.queuedJobs.push(job.id);
    this.emit({ type: "job", job });
    this.pumpJobs();
    return job;
  }

  private async failStaleNodeJobs(): Promise<void> {
    for (const job of await this.store.list(500)) {
      if (job.runtime !== "nodejs" || job.instance_id === this.instanceId || !["queued", "pending", "working"].includes(job.status)) continue;
      try {
        await this.store.finish(job.id, "failed", "", "job was still active when the Node process restarted");
        await this.store.log(job.id, "error", "job was still running when the Node process restarted");
      } catch {
        // Best-effort cleanup; a blocked write must not stop the node from starting.
      }
    }
  }

  private pumpJobs(): void {
    while (!this.stopping && this.workingJobs < this.config.mesh.maxWorkers && this.queuedJobs.length) {
      const id = this.queuedJobs.shift()!;
      this.workingJobs += 1;
      void this.runJob(id)
        .catch(async (error) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.emit({ type: "warning", message: `job ${id} aborted: ${reason}` });
          const current = await this.store.get(id);
          if (current && !terminal(current.status)) await this.store.finish(id, "failed", "", reason).catch(() => undefined);
        })
        .finally(() => {
          this.workingJobs -= 1;
          this.pumpJobs();
        });
    }
  }

  private async runJob(id: string): Promise<void> {
    const job = await this.store.get(id);
    if (!job || !["queued", "pending"].includes(job.status) || !this.runner) return;
    const controller = new AbortController();
    this.activeJobs.set(id, controller);
    const working = await this.store.update(id, { status: "working" });
    if (working) this.emit({ type: "job", job: working });
    const timeout = setTimeout(() => controller.abort(new Error(`TIMEOUT after ${this.config.mesh.jobTimeoutSeconds}s`)), this.config.mesh.jobTimeoutSeconds * 1000);
    let logWrites = Promise.resolve();
    try {
      const result = await this.runner(job, controller.signal, (level, message) => {
        logWrites = logWrites.then(() => this.store.log(id, level, message).catch(() => undefined));
        this.emit({ type: "job-log", id, level, message });
      }, (event) => {
        // Structured events are streamed live and buffered for replay, but are
        // deliberately not persisted to the job file: the log lines remain the
        // durable record and this buffer is an interaction-layer optimization.
        this.recordJobEvent(id, event);
      });
      await logWrites.catch(() => undefined);
      const current = await this.store.get(id);
      const paused = !result.ok && result.stopReason === "max_steps";
      if (current?.status !== "cancelled") await this.store.finish(id, result.ok ? "done" : paused ? "paused" : "failed", result.ok || paused ? result.text : "", result.ok || paused ? "" : result.text);
    } catch (error) {
      await logWrites.catch(() => undefined);
      const current = await this.store.get(id);
      if (current?.status !== "cancelled") await this.store.finish(id, "failed", "", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      this.activeJobs.delete(id);
      this.ownedJobs.delete(id);
      this.pollLogOffsets.delete(id);
      this.leaseDeadlines.delete(id);
      const final = await this.store.get(id);
      if (final) this.emit({ type: "job", job: final });
    }
  }

  private async pollJob(message: JsonObject, payload: JsonObject): Promise<JsonObject> {
    const job = await this.store.get(String(payload.job_id || ""));
    if (!job) return { ok: false, error: "unknown job" };
    if (job.lease_seconds && ["queued", "pending", "working"].includes(job.status) && String(message.from || "") === job.source) {
      // The in-memory deadline is authoritative for maintenance; persistence is
      // best-effort so a blocked job-store write can never delay the poll reply.
      const deadline = now() + job.lease_seconds;
      this.leaseDeadlines.set(job.id, deadline);
      void this.store.update(job.id, { lease_deadline: deadline }).catch(() => undefined);
    }
    const logCount = job.logs?.length || 0;
    const offset = Math.min(this.pollLogOffsets.get(job.id) ?? job.log_offset ?? 0, logCount);
    const pending = (job.logs || []).slice(offset);
    const skipped = Math.max(0, pending.length - MAX_POLL_LOG_LINES);
    const tail = pending.slice(skipped).map((line, index) => ({ i: offset + skipped + index, level: line.level, msg: line.msg }));
    this.pollLogOffsets.set(job.id, logCount);
    void this.store.update(job.id, { log_offset: logCount }).catch(() => undefined);
    // Structured events follow the same pull-and-advance contract as logs, so a
    // node that submitted the job can render the peer's actual work instead of
    // reconstructing it from log text.
    const streamed = this.jobStreams.get(job.id) ?? [];
    const eventOffset = this.pollEventOffsets.get(job.id) ?? 0;
    const events = streamed.filter((record) => record.seq > eventOffset).slice(0, MAX_POLL_EVENTS);
    if (events.length) this.pollEventOffsets.set(job.id, events.at(-1)!.seq);
    if (terminal(job.status)) {
      this.pollLogOffsets.delete(job.id);
      this.pollEventOffsets.delete(job.id);
      this.leaseDeadlines.delete(job.id);
    }
    return {
      ok: true,
      job_id: job.id,
      status: job.status,
      progress: job.progress || 0,
      log_next: logCount,
      log_tail: tail,
      events,
      event_next: events.at(-1)?.seq ?? eventOffset,
      result: job.result || "",
      error: job.error || "",
    };
  }

  private async receiveCancel(message: JsonObject, payload: JsonObject): Promise<JsonObject> {
    const id = String(payload.job_id || "");
    const job = await this.store.get(id);
    if (!job) return { ok: false, error: "unknown job" };
    const requester = String(message.from || "");
    if (![job.source, this.config.mesh.nodeName].includes(requester)) return { ok: false, error: "only the submitting node may cancel this job" };
    const cancelled = await this.cancelLocalJob(id, `cancelled by source node ${requester}`);
    return { ok: true, job_id: id, status: cancelled ? "cancelled" : job.status };
  }

  async cancelLocalJob(id: string, reason = "cancelled locally"): Promise<boolean> {
    const job = await this.store.get(id);
    if (!job || !["queued", "pending", "working"].includes(job.status)) return false;
    const queuedIndex = this.queuedJobs.indexOf(id);
    if (queuedIndex >= 0) this.queuedJobs.splice(queuedIndex, 1);
    this.ownedJobs.delete(id);
    await this.store.finish(id, "cancelled", "", reason);
    await this.store.log(id, "warning", `cancelled: ${reason}`);
    // Persist the terminal state before aborting the runner; otherwise its
    // rejection can race this write and incorrectly overwrite cancelled with failed.
    this.activeJobs.get(id)?.abort(new Error(reason));
    const final = await this.store.get(id);
    if (final) this.emit({ type: "job", job: final });
    return true;
  }

  async resumeLocalJob(id: string): Promise<MeshJob> {
    if (!this.runner || this.stopping) throw new Error("node agent runner is unavailable");
    const previous = await this.store.get(id);
    if (!previous || previous.target !== this.config.mesh.nodeName) throw new Error("unknown local job");
    if (!previous.session_id) throw new Error("job has no saved history; cannot resume");
    if (this.activeJobs.has(id)) throw new Error("job is still finishing; retry shortly");
    const job = await this.store.transition(id, "paused", { status: "queued", done_at: null,
      result: "", error: "", resume_count: (previous.resume_count || 0) + 1,
      instance_id: this.instanceId, lease_seconds: 0, lease_deadline: 0,
      queued_at: now() });
    if (!job) throw new Error("only a paused job can be resumed");
    this.ownedJobs.add(id);
    this.queuedJobs.push(id);
    this.emit({ type: "job", job });
    this.pumpJobs();
    return job;
  }

  async resumeRemoteJob(peer: string, id: string, signal?: AbortSignal): Promise<string> {
    const reply = await this.rpc(peer, "job_resume", { job_id: id }, 15_000, signal);
    return JSON.stringify(reply);
  }

  private async maintainJobs(): Promise<void> {
    const current = now();
    // Replay buffers outlive the run so a reconnecting client can still catch
    // up, then are released. Job files remain the durable record.
    for (const id of [...this.jobStreams.keys()]) {
      const job = await this.store.get(id);
      if (!job || (terminal(job.status) && current - (job.done_at ?? job.updated_at) > 600)) {
        this.jobStreams.delete(id);
        this.jobStreamSeq.delete(id);
      }
    }
    for (const id of [...this.ownedJobs]) {
      const job = await this.store.get(id);
      if (!job || !["queued", "pending", "working"].includes(job.status) || job.target !== this.config.mesh.nodeName) continue;
      const leaseDeadline = this.leaseDeadlines.get(id) ?? job.lease_deadline;
      if (leaseDeadline && leaseDeadline < current) await this.cancelLocalJob(id, "submitter heartbeat lease expired");
      else if (job.status === "queued" && current - (job.queued_at ?? job.created_at) > this.config.mesh.queueTimeoutSeconds) {
        await this.store.finish(id, "failed", "", `QUEUED TIMEOUT after ${this.config.mesh.queueTimeoutSeconds}s`);
        const final = await this.store.get(id);
        if (final) this.emit({ type: "job", job: final });
      }
    }
  }

  private setContact(contact: MeshContact): MeshPeer {
    const current = this.peersByName.get(contact.name);
    const peer: MeshPeer = {
      name: contact.name,
      host: contact.host,
      port: contact.port,
      udpPort: contact.udpPort,
      capabilities: current?.capabilities || [],
      lastSeen: current?.lastSeen || 0,
      note: contact.note,
      online: current?.online || false,
    };
    this.peersByName.set(contact.name, peer);
    return peer;
  }

  async addContact(contact: MeshContact): Promise<MeshPeer> {
    const peer = this.setContact(contact);
    await saveMeshContact(this.config.home, contact);
    this.broadcast();
    return peer;
  }

  peers(): MeshPeer[] {
    const current = now();
    return [...this.peersByName.values()].map((peer) => ({
      ...peer,
      online: peer.lastSeen > 0 && current - peer.lastSeen < ONLINE_SECONDS,
    })).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  peer(name: string): MeshPeer {
    const peer = this.peersByName.get(name);
    if (!peer) throw new Error(`unknown peer '${name}' (use /add-contact or wait for LAN discovery)`);
    return peer;
  }

  async rpc(peerName: string, type: string, payload: JsonObject = {}, timeoutMs = 15_000, signal?: AbortSignal): Promise<JsonObject> {
    const peer = this.peer(peerName);
    const message = envelope(type, this.config.mesh.nodeName, "", payload);
    message.expect_reply = true;
    if (this.config.mesh.token) message.auth = signObject(message, this.config.mesh.token);
    const reply = await sendRpc(peer.host, peer.port, message, timeoutMs, signal);
    if (reply.ok === false) throw new Error(String(reply.error || `${peerName} rejected ${type}`));
    peer.lastSeen = now();
    peer.online = true;
    return reply;
  }

  async ping(peer: string, signal?: AbortSignal): Promise<string> {
    const reply = await this.rpc(peer, "ping", {}, 10_000, signal);
    return `peer=${peer} reachable · ${String(reply.name || peer)}`;
  }

  async status(peer: string, signal?: AbortSignal): Promise<JsonObject> {
    return this.rpc(peer, "node_status", {}, 10_000, signal);
  }

  async message(peer: string, text: string, signal?: AbortSignal): Promise<string> {
    const value = text.trim();
    if (!value) throw new Error("empty chat message");
    const messageId = `msg-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const reply = await this.rpc(peer, "chat", { text: value, from: this.config.mesh.nodeName, message_id: messageId }, 15_000, signal);
    const receivedAt = Number(reply.received_at || now());
    await mkdir(this.config.mesh.jobsDir, { recursive: true });
    const message: MeshChatMessage = { id: messageId, from: this.config.mesh.nodeName, to: peer, text: value, received_at: receivedAt, delivered_at: receivedAt };
    await appendFile(join(this.config.mesh.jobsDir, "chat-outbox.jsonl"), `${JSON.stringify(message)}\n`, "utf8");
    this.emit({ type: "chat", message, from: message.from, text: value });
    return `Delivered to ${String(reply.received_by || peer)} · receipt ${String(reply.message_id || messageId)} · ${new Date(receivedAt * 1000).toLocaleTimeString()}`;
  }

  async handoff(
    peer: string,
    instruction: string,
    project = this.config.project,
    timeoutSeconds = 300,
    signal?: AbortSignal,
  ): Promise<string> {
    const id = `job-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    let completed = false;
    const logs: string[] = [];
    // The submitting node keeps its own record. Without one the work exists only
    // as a peer's eventual reply: nothing local can list it, stream it, or say
    // why it failed, which is what made a handed-off task a black box.
    const origin = await this.store.create({
      id,
      source: this.config.mesh.nodeName,
      target: peer,
      kind: "task",
      project_id: project,
      workspace: this.config.workspace,
      instruction,
      status: "working",
    });
    this.emit({ type: "job", job: origin });
    const deadline = Date.now() + Math.max(30, Math.min(3600, timeoutSeconds)) * 1000;
    let pollFailures = 0;
    try {
      await this.rpc(peer, "job_submit", {
        job_id: id,
        project_id: project,
        instruction,
        source: this.config.mesh.nodeName,
        lease_seconds: HANDOFF_LEASE_SECONDS,
      }, 15_000, signal);
      while (Date.now() < deadline) {
        await wait(750, signal);
        let poll: JsonObject;
        try {
          poll = await this.rpc(peer, "job_poll", { job_id: id }, 15_000, signal);
          pollFailures = 0;
        } catch (error) {
          // A slow or momentary network hiccup must not cancel a healthy remote job.
          if (signal?.aborted) throw error;
          pollFailures += 1;
          if (pollFailures >= 3) throw error;
          continue;
        }
        for (const raw of Array.isArray(poll.log_tail) ? poll.log_tail : []) {
          const line = record(raw);
          logs.push(`[${String(line.level || "info")}] ${String(line.msg || "")}`);
        }
        // Replay the peer's structured events into this node's own stream, so
        // local interfaces render the remote run the way they render a local one.
        for (const raw of Array.isArray(poll.events) ? poll.events : []) {
          const mirrored = (record(raw).event ?? undefined) as JobStreamEvent | undefined;
          if (mirrored) this.recordJobEvent(id, mirrored);
        }
        const status = String(poll.status || "working");
        if (terminal(status)) {
          completed = true;
          const result = String(poll.result || poll.error || "").trim();
          await this.finishMirroredJob(origin, status, status === "failed" ? "" : result, status === "failed" ? result : "");
          return [`remote job ${id} on ${peer}: ${status}`, "--- peer logs ---", ...logs.slice(-300), "--- remote result ---", result].join("\n");
        }
      }
      throw new Error(`remote job ${id} on ${peer} timed out after ${timeoutSeconds}s`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.finishMirroredJob(origin, "failed", "", reason);
      throw error;
    } finally {
      if (!completed) await this.rpc(peer, "job_cancel", { job_id: id }, 5_000).catch(() => undefined);
    }
  }

  /** Settle a local record for a job another node ran, unless it already ended. */
  private async finishMirroredJob(job: MeshJob, status: MeshJob["status"], result: string, error: string): Promise<void> {
    const current = await this.store.get(job.id);
    if (!current || terminal(current.status)) return;
    await this.store.finish(job.id, status, result, error).catch(() => undefined);
    const final = await this.store.get(job.id);
    if (final) this.emit({ type: "job", job: final });
  }

  async askAll(instruction: string, project = this.config.project, timeoutSeconds = 120, signal?: AbortSignal): Promise<string> {
    const peers = this.peers().map((peer) => peer.name);
    if (!peers.length) return "no known mesh peers";
    const rows = await Promise.all(peers.map(async (peer) => {
      try {
        const result = await this.handoff(peer, instruction, project, timeoutSeconds, signal);
        const final = result.split("--- remote result ---").at(-1)?.trim() || result;
        const status = result.split("\n", 1)[0]?.match(/: (done|paused|failed|cancelled)$/u)?.[1] || "unknown";
        return `  [${status}] ${peer}: ${final}`;
      } catch (error) {
        return `  [failed] ${peer}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }));
    return [`ask_all: ${peers.length} peers, broadcasted: '${instruction}'`, ...rows].join("\n");
  }

  async syncPush(peer: string, project = this.config.project, workspace = this.config.workspace, mode: SyncMode = this.config.mesh.syncMode, signal?: AbortSignal): Promise<string> {
    const files = await scanWorkspace(workspace, this.config.mesh.syncIgnore);
    const plan = await this.rpc(peer, "sync_request", { project_id: project, mode, files, head: await gitHead(workspace) || null }, 60_000, signal);
    const transfer = await buildTransfer(plan, workspace, this.config.mesh.conflictPolicy, this.config.mesh.nodeName, this.config.mesh.chunkSize);
    const result = await this.rpc(peer, "sync_transfer", { ...transfer, project_id: project }, 120_000, signal);
    return syncSummary("push", peer, result);
  }

  async syncPull(peer: string, project = this.config.project, workspace = this.config.workspace, mode: SyncMode = this.config.mesh.syncMode, signal?: AbortSignal): Promise<string> {
    const files = await scanWorkspace(workspace, this.config.mesh.syncIgnore);
    let transfer: JsonObject;
    try {
      const manifest = await this.rpc(peer, "sync_manifest", { project_id: project }, 60_000, signal);
      const plan = await planResponse(workspace, {
        mode,
        files: record(manifest.files),
        head: manifest.head || null,
      }, this.config.mesh.syncIgnore);
      transfer = await this.rpc(peer, "sync_fetch", { project_id: project, plan }, 60_000, signal);
    } catch (error) {
      if (!/unknown message type/u.test(error instanceof Error ? error.message : String(error))) throw error;
      // Python nodes predating the manifest/fetch extension use the original one-shot pull RPC.
      transfer = await this.rpc(peer, "sync_pull", { project_id: project, mode, files, head: await gitHead(workspace) || null }, 60_000, signal);
    }
    const result = await applyTransfer(workspace, transfer, this.config.mesh.conflictPolicy);
    return syncSummary("pull", peer, result);
  }

  async jobs(limit = 50): Promise<MeshJob[]> {
    return this.store.list(limit);
  }
}
