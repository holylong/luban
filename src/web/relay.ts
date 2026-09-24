import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer, type Server as HttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { networkInterfaces } from "node:os";
import { webAssetPath, WEB_CONTENT_TYPES } from "./assets.js";
import { AuthGate, clearCookie, generateToken, parseCookie, rejectAuth, tokenCookie, tokenMatches } from "./auth.js";
import {
  createFrameDecoder, filterForwardedHeaders, FRAME_CHUNK, FRAME_END, FRAME_FAIL, FRAME_HEAD,
  parseJson, type EndPayload, type FailPayload, type ResponseHead, type TunnelMessage,
} from "./tunnel-frames.js";
import { VERSION } from "../version.js";

/**
 * Public half of the phone-to-laptop link.
 *
 * The relay never touches the agent: it holds the mobile console bundle, keeps a
 * registry of nodes that dialed in, and forwards the console's HTTP requests
 * into the tunnel. Task queues, sessions and snapshots stay on the node — if the
 * relay dies, the laptop keeps working and simply reconnects.
 *
 * Two secrets, deliberately separate:
 *   node token   — what a node must present to register; never reaches a phone.
 *   access token — what the phone uses; never reaches a node's request stream.
 */

export const NODE_COOKIE = "luban_node";

export interface RelayServerOptions {
  host?: string;
  port?: number;
  /** Phone-side access token. Generated when omitted. */
  token?: string;
  /** Node-side shared secret. Generated when omitted. */
  nodeToken?: string;
  /** How long a node long-poll may wait. */
  pollWaitMs?: number;
  /** Public base URL used in the link handed back to nodes. */
  publicUrl?: string;
  /**
   * PEM key + cert. When present the relay serves HTTPS, which a phone needs to
   * install the console as a home-screen app: Chrome only treats a page as a
   * secure context — and thus installable — over HTTPS (or Tailscale).
   */
  tls?: { key: string; cert: string };
  log?: (message: string) => void;
  /** Detected from the mobile bundle; only used for the startup message. */
  mobileBundle?: boolean;
}

interface RelayNode {
  id: string;
  name: string;
  version: string;
  workspace: string;
  projects: Record<string, string>;
  accessToken: string;
  connectedAt: number;
  lastSeenAt: number;
  queue: TunnelMessage[];
  waiters: Array<(messages: TunnelMessage[]) => void>;
}

interface InFlight {
  nodeId: string;
  response: ServerResponse;
  settled: boolean;
  /** Fires when the node never answers at all, so the phone is not left hanging. */
  headTimer?: NodeJS.Timeout;
}

const MAX_BODY = 2 * 1024 * 1024;
const MAX_QUEUE = 64;
const NODE_OFFLINE_MS = 45_000;
const NODE_PRUNE_MS = 600_000;
const HEAD_TIMEOUT_MS = 60_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, value: unknown, status = 200, extraHeaders: OutgoingHttpHeaders = {}): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function html(res: ServerResponse, body: string, status = 200, extraHeaders: OutgoingHttpHeaders = {}): void {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": buffer.length,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(buffer);
}

async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk);
    size += data.length;
    if (size > limit) throw new HttpError(413, `request body too large (${size} bytes)`);
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class LubanRelayServer {
  private server?: Server | HttpsServer;
  private readonly nodes = new Map<string, RelayNode>();
  private readonly inFlight = new Map<string, InFlight>();
  private sweeper?: NodeJS.Timeout;
  readonly accessToken: string;
  readonly nodeToken: string;
  readonly gate: AuthGate;
  host: string;
  port: number;

  constructor(private readonly options: RelayServerOptions = {}) {
    this.host = options.host || "127.0.0.1";
    this.port = options.port ?? 0;
    this.accessToken = options.token?.trim() || generateToken();
    this.nodeToken = options.nodeToken?.trim() || generateToken();
    this.gate = new AuthGate(this.accessToken);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  async start(): Promise<string> {
    if (this.server) return this.url();
    const handler = (req: IncomingMessage, res: ServerResponse): void => { void this.route(req, res); };
    this.server = this.options.tls
      ? createSecureServer({ key: this.options.tls.key, cert: this.options.tls.cert }, handler)
      : createServer(handler);
    // Long polls and SSE streams both outlive the default idle timeouts.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 20_000;
    this.server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error) => reject(new Error(`relay ${this.host}:${this.port}: ${error.message}`));
      this.server!.once("error", onError);
      this.server!.listen(this.port, this.host, () => {
        this.server!.removeListener("error", onError);
        const address = this.server!.address();
        if (address && typeof address !== "string") this.port = address.port;
        resolveStart();
      });
    });
    this.sweeper = setInterval(() => this.prune(), 15_000);
    this.sweeper.unref?.();
    return this.url();
  }

  url(): string {
    const displayHost = this.displayHost();
    const scheme = this.options.tls ? "https" : "http";
    return `${scheme}://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${this.port}`;
  }

  /**
   * Host the phone should dial. A wildcard bind is not itself reachable, so
   * resolve it to the LAN address a phone on the same network can actually
   * reach; a specific bind is used verbatim. Falls back to loopback when no
   * routable interface exists (a bare container), preserving prior behaviour.
   */
  private displayHost(): string {
    if (!["0.0.0.0", "::", "::0"].includes(this.host)) return this.host;
    for (const info of Object.values(networkInterfaces())) {
      for (const entry of info || []) {
        if (entry.family === "IPv4" && !entry.internal) return entry.address;
      }
    }
    return "127.0.0.1";
  }

  /** Base URL the phone should use, as advertised to nodes. */
  publicBaseUrl(): string {
    return (this.options.publicUrl || this.url()).replace(/\/+$/u, "");
  }

  /** One-tap link: the token is exchanged for a cookie by `/login`. */
  mobileLink(token = this.accessToken): string {
    return `${this.publicBaseUrl()}/login?token=${encodeURIComponent(token)}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const entry of this.inFlight.values()) {
      if (entry.headTimer) clearTimeout(entry.headTimer);
      if (!entry.settled) entry.response.end();
    }
    this.inFlight.clear();
    for (const node of this.nodes.values()) for (const waiter of node.waiters.splice(0)) waiter([]);
    this.nodes.clear();
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolveStop) => server.close(() => resolveStop())).catch(() => undefined);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, node] of this.nodes) {
      if (now - node.lastSeenAt > NODE_PRUNE_MS) {
        this.nodes.delete(id);
        this.log(`node ${node.name} (${id}) pruned after ${Math.round((now - node.lastSeenAt) / 1000)}s of silence`);
      }
    }
  }

  private nodeView(node: RelayNode): Record<string, unknown> {
    return {
      id: node.id,
      name: node.name,
      version: node.version,
      workspace: node.workspace,
      projects: node.projects,
      online: Date.now() - node.lastSeenAt < NODE_OFFLINE_MS,
      last_seen: node.lastSeenAt / 1000,
      connected_at: node.connectedAt / 1000,
    };
  }

  private nodeForAccessToken(token: string | undefined): RelayNode | undefined {
    if (!token) return undefined;
    return [...this.nodes.values()].find(node => tokenMatches(node.accessToken, token));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || "/", "http://relay.local");
      // Node-facing tunnel endpoints authenticate with the node token, not the
      // phone token: the node must never be able to spend a phone session.
      if (url.pathname.startsWith("/tunnel/")) return await this.tunnel(req, res, url);

      if (url.pathname === "/relay/health") {
        return json(res, { ok: true, service: "luban-relay", version: VERSION });
      }

      const decision = this.gate.check(req, url, [...this.nodes.values()].map(node => node.accessToken));
      if (!decision.ok) return rejectAuth(res, decision, url.pathname.startsWith("/api/"));
      const tokenNode = this.nodeForAccessToken(decision.token);

      // A link that carries the token is exchanged for a cookie once, so the
      // SSE stream (which cannot send headers) authenticates on every reconnect.
      const wantsCookie = decision.source === "query" && Boolean(decision.token);
      const tokenHeader: OutgoingHttpHeaders = wantsCookie ? {
        "set-cookie": [
          tokenCookie(decision.token!, undefined, Boolean(this.options.tls)),
          ...(tokenNode ? [`${NODE_COOKIE}=${encodeURIComponent(tokenNode.id)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${this.options.tls ? "; Secure" : ""}`] : []),
        ],
      } : {};
      const redirect = (location: string, headers: OutgoingHttpHeaders = {}): void => {
        res.writeHead(302, { location, ...headers });
        res.end();
      };
      const mobileLocation = tokenNode ? `/m/?node=${encodeURIComponent(tokenNode.id)}` : "/m/";
      if (url.pathname === "/login" || url.pathname === "/login/") return redirect(mobileLocation, tokenHeader);
      if (url.pathname === "/logout") return redirect("/m/", { "set-cookie": [clearCookie("luban_token", Boolean(this.options.tls)), clearCookie(NODE_COOKIE, Boolean(this.options.tls))] });
      if (url.pathname === "/") return redirect(mobileLocation, tokenHeader);

      if (url.pathname === "/api/offline" || url.pathname === "/relay/nodes") {
        return json(res, this.nodeList(tokenNode?.id), 200, tokenHeader);
      }

      if (url.pathname === "/m") return redirect("/m/", tokenHeader);
      if (req.method === "GET" && url.pathname === "/m/") {
        return await this.mobileShell(res, url, tokenHeader);
      }
      if (req.method === "GET" && url.pathname.startsWith("/m/")) {
        return await this.mobileAsset(url.pathname.slice("/m/".length), res);
      }
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname.startsWith("/api/")) return await this.proxy(req, res, url, tokenNode?.id);

      throw new HttpError(404, "not found: the relay serves the mobile console at /m/");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof HttpError ? error.status : 500;
      json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, status);
    }
  }

  // ---------------------------------------------------------------- node side

  private nodeAuth(req: IncomingMessage): boolean {
    const header = req.headers["x-luban-node-token"];
    const presented = Array.isArray(header) ? header[0] : header;
    return Boolean(presented) && presented === this.nodeToken;
  }

  private async tunnel(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "POST") throw new HttpError(405, "tunnel endpoints are POST-only");
    if (!this.nodeAuth(req)) {
      this.gate.recordFailure(req);
      throw new HttpError(401, "invalid node token");
    }
    if (url.pathname === "/tunnel/register") return await this.register(req, res);
    const replyMatch = /^\/tunnel\/reply\/([^/]+)$/u.exec(url.pathname);
    if (replyMatch) return await this.reply(decodeURIComponent(replyMatch[1]!), req, res);
    if (url.pathname === "/tunnel/poll") return await this.poll(req, res);
    throw new HttpError(404, "unknown tunnel endpoint");
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = record(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"));
    const id = `n-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const node: RelayNode = {
      id,
      name: String(body.name || "luban"),
      version: String(body.version || ""),
      workspace: String(body.workspace || ""),
      projects: record(body.projects) as Record<string, string>,
      accessToken: String(body.access_token || this.accessToken),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      queue: [],
      waiters: [],
    };
    this.nodes.set(id, node);
    this.log(`node registered: ${node.name} (${id}) workspace=${node.workspace || "-"}`);
    json(res, {
      ok: true,
      node_id: id,
      poll_wait_ms: this.options.pollWaitMs ?? 25_000,
      public_url: `${this.publicBaseUrl()}/m/`,
      // Handed to the node so its terminal can print a ready-to-open link. Both
      // sides belong to the same owner, and the node already runs the agent.
      access_url: this.mobileLink(node.accessToken),
    });
  }

  private async poll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = record(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"));
    const node = this.nodes.get(String(body.node_id || ""));
    if (!node) throw new HttpError(404, "unknown node; register again");
    node.lastSeenAt = Date.now();
    const requested = Number(body.wait_ms);
    const waitMs = Math.max(1_000, Math.min(this.options.pollWaitMs ?? 25_000, Number.isFinite(requested) ? requested : 25_000));

    const queued = node.queue.splice(0, node.queue.length);
    if (queued.length) return json(res, { ok: true, messages: queued });

    await new Promise<void>((resolvePoll) => {
      let settled = false;
      const waiter = (messages: TunnelMessage[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = node.waiters.indexOf(waiter);
        if (index >= 0) node.waiters.splice(index, 1);
        json(res, { ok: true, messages });
        resolvePoll();
      };
      const timer = setTimeout(() => waiter([]), waitMs);
      timer.unref?.();
      node.waiters.push(waiter);
      res.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = node.waiters.indexOf(waiter);
        if (index >= 0) node.waiters.splice(index, 1);
        // The poll ended before this side answered: the node process is gone or
        // its network dropped. Marking it unreachable now is what turns a dead
        // laptop into a prompt 503 instead of a 60s wait on the phone, and the
        // requests already handed to it must fail too — nothing will answer them.
        node.lastSeenAt = 0;
        this.failInFlightFor(node, `${node.name} 的连接已断开`);
        resolvePoll();
      });
    });
  }

  /** Queue one message for a node, waking its outstanding poll when there is one. */
  private deliver(node: RelayNode, message: TunnelMessage): boolean {
    const waiter = node.waiters.shift();
    if (waiter) { waiter([message]); return true; }
    if (node.queue.length >= MAX_QUEUE) return false;
    node.queue.push(message);
    return true;
  }

  /** Fail every request already handed to a node that just went away. */
  private failInFlightFor(node: RelayNode, reason: string): void {
    for (const [id, entry] of [...this.inFlight]) {
      if (entry.nodeId !== node.id) continue;
      this.inFlight.delete(id);
      if (entry.headTimer) clearTimeout(entry.headTimer);
      entry.settled = true;
      if (entry.response.headersSent) entry.response.end();
      else json(entry.response, { ok: false, error: reason }, 503);
    }
  }

  private offlineReason(node: RelayNode): string {
    if (!node.lastSeenAt) return `节点 ${node.name} 的连接已断开，等待它重新连接`;
    return `节点 ${node.name} 已离线（${Math.round((Date.now() - node.lastSeenAt) / 1000)}s 无心跳）`;
  }

  private nodeList(onlyNodeId?: string): Record<string, unknown> {
    return {
      ok: true,
      nodes: [...this.nodes.values()]
        .filter(node => !onlyNodeId || node.id === onlyNodeId)
        .map(node => this.nodeView(node))
        .sort((left, right) => Number(right.online) - Number(left.online) || String(left.name).localeCompare(String(right.name))),
    };
  }

  // --------------------------------------------------------------- phone side

  private async mobileShell(res: ServerResponse, url: URL, extraHeaders: OutgoingHttpHeaders): Promise<void> {
    const bundle = await readFile(webAssetPath("mobile.html"), "utf8").catch(() => undefined);
    if (bundle) return html(res, bundle, 200, extraHeaders);
    // Without a built bundle the relay still has to answer something usable, and
    // the node list is what the phone needs to know whether to retry later.
    return html(res, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>luban relay</title><body style="background:#05070a;color:#edf0f5;font:16px system-ui;padding:28px">
<h1>luban relay</h1><p>移动端控制台资源未构建。请在仓库中运行 <code>npm run build:web</code> 后重启中继。</p>
<p><a style="color:#72a7ff" href="/relay/health">/relay/health</a></p></body>`, 200, extraHeaders);
  }

  private async mobileAsset(relativePath: string, res: ServerResponse): Promise<void> {
    if (relativePath.includes("..")) throw new HttpError(400, "invalid asset path");
    const body = await readFile(webAssetPath(relativePath)).catch(() => undefined);
    if (!body) throw new HttpError(404, "not found");
    const type = WEB_CONTENT_TYPES[extname(relativePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }

  /**
   * Pick the node a phone request should reach: explicit choice first, then the
   * most recently seen one. An offline node is still returned so `proxy` can
   * report which node went away instead of a generic "no node".
   */
  private resolveNode(req: IncomingMessage, url: URL, pinnedNodeId?: string): RelayNode | undefined {
    if (pinnedNodeId) return this.nodes.get(pinnedNodeId);
    const explicit = url.searchParams.get("node") || parseCookie(req.headers.cookie, NODE_COOKIE);
    if (explicit) {
      const node = this.nodes.get(explicit);
      if (node) return node;
    }
    return [...this.nodes.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, url: URL, pinnedNodeId?: string): Promise<void> {
    const node = this.resolveNode(req, url, pinnedNodeId);
    if (!node) {
      throw new HttpError(503, "没有已连接的本机 luban 节点：请在本机运行 luban web --relay <中继地址>");
    }
    if (Date.now() - node.lastSeenAt >= NODE_OFFLINE_MS) {
      throw new HttpError(503, this.offlineReason(node));
    }

    const id = `q-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
    const message: TunnelMessage = {
      type: "request",
      id,
      method: req.method || "GET",
      path: `${url.pathname}${url.search}`,
      headers: filterForwardedHeaders(req.headers),
      body: body.length ? body.toString("base64") : undefined,
    };

    const entry: InFlight = { nodeId: node.id, response: res, settled: false };
    this.inFlight.set(id, entry);
    entry.headTimer = setTimeout(() => {
      if (entry.settled) return;
      this.inFlight.delete(id);
      this.deliver(node, { type: "abort", id });
      if (!res.headersSent) json(res, { ok: false, error: `节点 ${node.name} 在 ${HEAD_TIMEOUT_MS / 1000}s 内没有响应` }, 504);
      else res.end();
    }, HEAD_TIMEOUT_MS);
    entry.headTimer.unref?.();

    res.on("close", () => {
      if (entry.settled) return;
      entry.settled = true;
      if (entry.headTimer) clearTimeout(entry.headTimer);
      this.inFlight.delete(id);
      // The phone navigated away or stopped the request: drop the work instead
      // of letting a long agent step keep running for nobody.
      this.deliver(node, { type: "abort", id });
    });

    if (!this.deliver(node, message)) {
      entry.settled = true;
      if (entry.headTimer) clearTimeout(entry.headTimer);
      this.inFlight.delete(id);
      throw new HttpError(503, `节点 ${node.name} 的待处理请求已满，请稍后重试`);
    }
  }

  private async reply(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry = this.inFlight.get(id);
    if (!entry || entry.settled) {
      // Consume the body so the node's stream is not left half-read, then tell
      // it to stop: the phone is gone.
      await readBody(req).catch(() => Buffer.alloc(0));
      return json(res, { ok: false, error: "request is no longer pending" }, 410);
    }
    const target = entry.response;
    const decoder = createFrameDecoder();
    let headSent = false;
    let finished = false;

    const settle = (end: boolean): void => {
      if (finished) return;
      finished = true;
      if (entry.headTimer) clearTimeout(entry.headTimer);
      entry.settled = true;
      this.inFlight.delete(id);
      if (end && !target.writableEnded) target.end();
    };

    try {
      for await (const chunk of req) {
        for (const frame of decoder(Buffer.from(chunk))) {
          if (finished) break;
          if (frame.type === FRAME_HEAD) {
            const head = parseJson<ResponseHead>(frame.payload);
            const status = Number(head?.status) || 502;
            const headers: Record<string, string> = { ...head?.headers };
            // The relay writes chunk by chunk, so an upstream content-length
            // would only be right if the node never truncates; drop it and let
            // Node frame the response itself.
            delete headers["content-length"];
            headers["x-accel-buffering"] = "no";
            headers["cache-control"] = headers["cache-control"] || "no-store";
            if (entry.headTimer) clearTimeout(entry.headTimer);
            target.writeHead(status, headers);
            headSent = true;
            // Flush immediately: for the SSE stream this is the difference
            // between live updates and a response that only arrives at the end.
            target.flushHeaders?.();
            target.socket?.setNoDelay(true);
            continue;
          }
          if (frame.type === FRAME_CHUNK) {
            if (!headSent) {
              target.writeHead(200, { "content-type": "application/octet-stream", "x-accel-buffering": "no" });
              headSent = true;
            }
            target.write(frame.payload);
            continue;
          }
          if (frame.type === FRAME_END) {
            parseJson<EndPayload>(frame.payload);
            settle(true);
            continue;
          }
          if (frame.type === FRAME_FAIL) {
            const failure = parseJson<FailPayload>(frame.payload);
            if (!headSent) {
              json(target, { ok: false, error: failure.message || "node failed to answer" }, 502);
            } else {
              target.write(`\n${JSON.stringify({ ok: false, error: failure.message || "stream failed" })}\n`);
              target.end();
            }
            settle(false);
          }
        }
      }
    } catch (error) {
      if (!headSent && !target.headersSent) {
        json(target, { ok: false, error: `tunnel stream failed: ${error instanceof Error ? error.message : String(error)}` }, 502);
        settle(false);
        return json(res, { ok: true });
      }
    }

    // The node's stream ended without an END frame: the response is truncated,
    // and finishing it silently would look like a successful short answer.
    if (!finished) {
      if (!target.writableEnded) target.end();
      settle(false);
    }
    json(res, { ok: true });
  }

  /** Exposed for tests and for `luban relay --status`. */
  nodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }
}
