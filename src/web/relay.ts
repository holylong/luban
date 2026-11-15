import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer, type Server as HttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { networkInterfaces } from "node:os";
import { webAssetPath, WEB_CONTENT_TYPES } from "./assets.js";
import { AuthGate, clearCookie, generateToken, parseCookie, rejectAuth, tokenCookie, tokenMatches } from "./auth.js";
import {
  ACCOUNT_COOKIE, AccountError, AuthThrottle, RelayAccountStore, accountCookie, normalizeEmail,
  clearAccountCookie, type RelayAccountView, type RelayStoredDevice,
} from "./accounts.js";
import type { RelayDeviceStatus } from "./device-status.js";
import { VerificationCodes } from "./verification.js";
import {
  createFrameDecoder, filterForwardedHeaders, FRAME_CHUNK, FRAME_END, FRAME_FAIL, FRAME_HEAD,
  parseJson, type EndPayload, type FailPayload, type ResponseHead, type TunnelMessage,
} from "./tunnel-frames.js";
import { durableProjects } from "../core/project-registry.js";
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
   * Enables relay accounts (register/login, account-owned devices). Omitting it
   * keeps the single-token behaviour used by tests and embedded deployments;
   * `luban relay` always supplies a path.
   */
  accountsPath?: string;
  /** Injectable store, for tests and embedders. */
  accounts?: RelayAccountStore;
  /**
   * Registration-code delivery. When present, creating an account requires a
   * code sent to the address; when absent, accounts still work for local or
   * trusted deployments that do not expose registration.
   */
  email?: RelayEmailSender;
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

export interface RelayEmailSender {
  sendVerificationCode(to: string, code: string): Promise<void>;
}

interface RelayNode {
  id: string;
  name: string;
  version: string;
  workspace: string;
  projects: Record<string, string>;
  accessToken: string;
  accountId?: string;
  deviceId?: string;
  status?: RelayDeviceStatus;
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
  private readonly accounts?: RelayAccountStore;
  private readonly verification = new VerificationCodes();
  private readonly authThrottle = new AuthThrottle();
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
    this.accounts = options.accounts ?? (options.accountsPath ? new RelayAccountStore(options.accountsPath) : undefined);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  async start(): Promise<string> {
    if (this.server) return this.url();
    await this.accounts?.initialize();
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
      device_id: node.deviceId,
      name: node.name,
      version: node.version,
      workspace: node.workspace,
      projects: node.projects,
      online: Date.now() - node.lastSeenAt < NODE_OFFLINE_MS,
      last_seen: node.lastSeenAt / 1000,
      connected_at: node.connectedAt / 1000,
      status: node.status,
    };
  }

  private nodeForAccessToken(token: string | undefined): RelayNode | undefined {
    if (!token || tokenMatches(this.accessToken, token)) return undefined;
    return [...this.nodes.values()]
      .filter(node => tokenMatches(node.accessToken, token))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.connectedAt - left.connectedAt)[0];
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

      if (!this.accounts) return await this.legacyRoute(req, res, url);
      return await this.accountEnabledRoute(req, res, url);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof AccountError ? error.status : 500;
      json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, status);
    }
  }

  /** Single-token behaviour, kept for embedded relays and older deployments. */
  private async legacyRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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
  }

  /**
   * Multi-account behaviour: the phone logs in, the relay maps each node to the
   * account that enrolled it, and every API call is scoped to that account.
   * The legacy token is still accepted so an operator can keep an existing
   * phone link during the transition.
   */
  private async accountEnabledRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const accounts = this.accounts!;
    const isApi = url.pathname.startsWith("/api/");
    const cookieToken = parseCookie(req.headers.cookie, ACCOUNT_COOKIE);
    const account = await accounts.session(cookieToken);
    const redirect = (location: string, headers: OutgoingHttpHeaders = {}): void => {
      res.writeHead(302, { location, ...headers });
      res.end();
    };

    if (isApi && (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/account/"))) {
      return await this.accountRoute(req, res, url, account);
    }

    if (url.pathname === "/logout") {
      await accounts.logout(cookieToken);
      return redirect("/m/", {
        "set-cookie": [
          clearAccountCookie(Boolean(this.options.tls)),
          clearCookie("luban_token", Boolean(this.options.tls)),
          clearCookie(NODE_COOKIE, Boolean(this.options.tls)),
        ],
      });
    }

    // Legacy one-tap links still work; an account login is the normal path.
    if (url.pathname === "/login" || url.pathname === "/login/") {
      const presented = url.searchParams.get("token");
      if (presented) {
        const decision = this.gate.check(req, url, [...this.nodes.values()].map(node => node.accessToken));
        if (!decision.ok) return rejectAuth(res, decision, false);
        const tokenNode = this.nodeForAccessToken(decision.token);
        const location = tokenNode ? `/m/?node=${encodeURIComponent(tokenNode.id)}` : "/m/";
        return redirect(location, {
          "set-cookie": [
            tokenCookie(decision.token!, undefined, Boolean(this.options.tls)),
            ...(tokenNode ? [`${NODE_COOKIE}=${encodeURIComponent(tokenNode.id)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${this.options.tls ? "; Secure" : ""}`] : []),
          ],
        });
      }
      return redirect("/m/");
    }

    if (url.pathname === "/") return redirect("/m/");

    // The shell and its assets are public: they hold the login form and no
    // workspace data. Every API call behind them still requires a session.
    if (req.method === "GET" && (url.pathname === "/m" || url.pathname === "/m/" || url.pathname === "/m/index.html")) {
      return await this.mobileShell(res, url, {});
    }
    if (req.method === "GET" && url.pathname.startsWith("/m/")) {
      return await this.mobileAsset(url.pathname.slice("/m/".length), res);
    }
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (account) {
      if (url.pathname === "/api/offline" || url.pathname === "/relay/nodes") {
        return json(res, { ok: true, account: true, nodes: await this.accountDevices(account.id) });
      }
      if (url.pathname.startsWith("/api/")) return await this.proxy(req, res, url, undefined, account.id);
      throw new HttpError(404, "not found: the relay serves the mobile console at /m/");
    }

    // No account: either a legacy token request or a login challenge.
    const decision = this.gate.check(req, url, [...this.nodes.values()].map(node => node.accessToken));
    if (!decision.ok) return rejectAuth(res, decision, isApi);
    const tokenNode = this.nodeForAccessToken(decision.token);
    const tokenHeader: OutgoingHttpHeaders = decision.source === "query" && decision.token ? {
      "set-cookie": [
        tokenCookie(decision.token, undefined, Boolean(this.options.tls)),
        ...(tokenNode ? [`${NODE_COOKIE}=${encodeURIComponent(tokenNode.id)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${this.options.tls ? "; Secure" : ""}`] : []),
      ],
    } : {};
    if (url.pathname === "/api/offline" || url.pathname === "/relay/nodes") {
      return json(res, this.nodeList(tokenNode?.id), 200, tokenHeader);
    }
    if (url.pathname.startsWith("/api/")) return await this.proxy(req, res, url, tokenNode?.id);
    throw new HttpError(404, "not found: the relay serves the mobile console at /m/");
  }

  // --------------------------------------------------------------- accounts

  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).host;
      const allowed = new Set([req.headers.host, new URL(this.publicBaseUrl()).host].filter(Boolean));
      return allowed.has(host);
    } catch {
      return false;
    }
  }

  private async jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    try {
      return record(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid JSON body");
    }
  }

  private requireAccount(account: RelayAccountView | undefined): RelayAccountView {
    if (!account) throw new HttpError(401, "请先登录");
    return account;
  }

  private async accountRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    account: RelayAccountView | undefined,
  ): Promise<void> {
    const accounts = this.accounts!;
    const secure = Boolean(this.options.tls);

    if (url.pathname === "/api/auth/me") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      if (!account) {
        return json(res, {
          ok: false,
          error: "请先登录",
          auth_required: true,
          email_verification: Boolean(this.options.email),
        }, 401);
      }
      return json(res, { ok: true, account });
    }

    if (url.pathname === "/api/auth/logout") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      await accounts.logout(parseCookie(req.headers.cookie, ACCOUNT_COOKIE));
      return json(res, { ok: true }, 200, { "set-cookie": [clearAccountCookie(secure)] });
    }

    if (url.pathname === "/api/auth/send-code") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      if (!this.sameOrigin(req)) throw new HttpError(403, "跨站请求被拒绝");
      const key = req.socket.remoteAddress || "unknown";
      if (!this.authThrottle.check(key)) throw new HttpError(429, "尝试次数过多，请稍后再试");
      const body = await this.jsonBody(req);
      const email = normalizeEmail(typeof body.email === "string" ? body.email : "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new HttpError(400, "请输入有效邮箱");
      if (!this.options.email) throw new HttpError(503, "该中继未配置邮箱验证码，请联系管理员");
      // Do not reveal whether an address already has an account. A registered
      // address simply receives nothing; its owner can use the login form.
      if (await accounts.hasAccount(email)) return json(res, { ok: true });
      const code = this.verification.issue(email);
      try {
        await this.options.email.sendVerificationCode(email, code);
      } catch (error) {
        this.log(`注册验证码邮件发送失败 (${email}): ${error instanceof Error ? error.message : String(error)}`);
        throw new HttpError(502, "验证码邮件发送失败，请稍后再试");
      }
      return json(res, { ok: true });
    }

    if (url.pathname === "/api/auth/register" || url.pathname === "/api/auth/login") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      if (!this.sameOrigin(req)) throw new HttpError(403, "跨站请求被拒绝");
      const key = req.socket.remoteAddress || "unknown";
      if (!this.authThrottle.check(key)) throw new HttpError(429, "尝试次数过多，请稍后再试");
      const body = await this.jsonBody(req);
      const email = typeof body.email === "string" ? body.email : "";
      const password = typeof body.password === "string" ? body.password : "";
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (url.pathname === "/api/auth/register") {
        if (this.options.email) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new HttpError(400, "请输入有效邮箱");
          if (password.length < 8) throw new HttpError(400, "密码至少 8 位");
          if (!this.verification.verify(normalizeEmail(email), code)) {
            throw new HttpError(400, "验证码错误或已过期，请重新获取");
          }
        }
        await accounts.register(email, password);
      }
      const session = await accounts.login(email, password);
      this.authThrottle.reset(key);
      return json(res, { ok: true, account: session.account }, 200, {
        "set-cookie": [accountCookie(session.token, undefined, secure)],
      });
    }

    if (url.pathname === "/api/account/devices") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      const current = this.requireAccount(account);
      return json(res, { ok: true, devices: await this.accountDevices(current.id) });
    }

    if (url.pathname === "/api/account/device-token") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed");
      if (!this.sameOrigin(req)) throw new HttpError(403, "跨站请求被拒绝");
      const current = this.requireAccount(account);
      const token = await accounts.createDeviceToken(current.id);
      return json(res, {
        ok: true,
        token,
        relay_url: this.publicBaseUrl(),
        command: `luban web <项目路径> --relay ${this.publicBaseUrl()} --relay-device-token ${token}`,
      });
    }

    const deviceMatch = /^\/api\/account\/devices\/([^/]+)$/u.exec(url.pathname);
    if (deviceMatch) {
      if (req.method !== "DELETE") throw new HttpError(405, "method not allowed");
      if (!this.sameOrigin(req)) throw new HttpError(403, "跨站请求被拒绝");
      const current = this.requireAccount(account);
      const deviceId = decodeURIComponent(deviceMatch[1]!);
      for (const [id, node] of [...this.nodes]) {
        if (node.accountId !== current.id || node.deviceId !== deviceId) continue;
        this.nodes.delete(id);
        this.failInFlightFor(node, `设备 ${node.name} 已被移出账户`);
        for (const waiter of node.waiters.splice(0)) waiter([]);
      }
      const removed = await accounts.removeDevice(current.id, deviceId);
      return json(res, { ok: true, removed });
    }

    throw new HttpError(404, "unknown account endpoint");
  }

  private deviceView(device: RelayStoredDevice | undefined, node: RelayNode | undefined): Record<string, unknown> {
    const id = node?.deviceId || device?.id || node?.id || "";
    const lastSeen = node?.lastSeenAt || device?.last_seen_at || 0;
    return {
      id,
      device_id: id,
      node_id: node?.id,
      name: node?.name || device?.name || "luban",
      version: node?.version || "",
      workspace: node?.workspace || device?.workspace || "",
      // A stored snapshot can predate the scratch filter; never replay it.
      projects: durableProjects(node?.projects || device?.projects || {}),
      online: Boolean(node && Date.now() - node.lastSeenAt < NODE_OFFLINE_MS),
      last_seen: lastSeen / 1000,
      connected_at: (node?.connectedAt || device?.created_at || 0) / 1000,
      status: node?.status ?? { updated_at: 0, jobs: [] },
    };
  }

  private async accountDevices(accountId: string): Promise<Record<string, unknown>[]> {
    const stored = await this.accounts!.devices(accountId);
    const live = [...this.nodes.values()].filter(node => node.accountId === accountId);
    const byDevice = new Map<string, RelayNode>();
    for (const node of live) if (node.deviceId) byDevice.set(node.deviceId, node);
    const result = stored.map(device => this.deviceView(device, byDevice.get(device.id)));
    const known = new Set(stored.map(device => device.id));
    for (const node of live) {
      if (node.deviceId && !known.has(node.deviceId)) result.push(this.deviceView(undefined, node));
    }
    return result.sort((left, right) =>
      Number(right.online) - Number(left.online) || String(left.name).localeCompare(String(right.name)));
  }

  // ---------------------------------------------------------------- node side

  private nodeAuth(req: IncomingMessage): boolean {
    const header = req.headers["x-luban-node-token"];
    const presented = Array.isArray(header) ? header[0] : header;
    return Boolean(presented) && presented === this.nodeToken;
  }

  private async tunnel(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "POST") throw new HttpError(405, "tunnel endpoints are POST-only");
    // A node normally presents the shared node token. In account mode the
    // per-account device token is enough: it is what binds the machine to an
    // owner, and forcing every phone user to learn the relay's operator secret
    // would make enrollment impossible without leaking it.
    const deviceAccount = this.accounts ? await this.deviceAccount(req) : undefined;
    if (!this.nodeAuth(req) && !deviceAccount) {
      this.gate.recordFailure(req);
      throw new HttpError(401, "invalid node token");
    }
    if (url.pathname === "/tunnel/register") return await this.register(req, res, deviceAccount);
    const replyMatch = /^\/tunnel\/reply\/([^/]+)$/u.exec(url.pathname);
    if (replyMatch) return await this.reply(decodeURIComponent(replyMatch[1]!), req, res, deviceAccount);
    if (url.pathname === "/tunnel/poll") return await this.poll(req, res, deviceAccount);
    throw new HttpError(404, "unknown tunnel endpoint");
  }

  private async deviceAccount(req: IncomingMessage): Promise<RelayAccountView | undefined> {
    if (!this.accounts) return undefined;
    const header = req.headers["x-luban-device-token"];
    const presented = Array.isArray(header) ? header[0] : header;
    return presented ? await this.accounts.accountForDeviceToken(presented) : undefined;
  }

  private async register(req: IncomingMessage, res: ServerResponse, account: RelayAccountView | undefined): Promise<void> {
    const body = record(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"));
    // Existing nodes authenticate with the shared node token and keep working
    // after accounts are enabled. New machines enroll with a device token; an
    // account-less registration is still a legacy node, just not listed under
    // any account. This keeps a live relay upgrade from disconnecting everyone.
    const suppliedId = typeof body.device_id === "string" ? body.device_id.trim() : "";
    const deviceId = /^[A-Za-z0-9_-]{6,80}$/u.test(suppliedId)
      ? suppliedId
      : `dev-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const id = `n-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const name = String(body.name || "luban");
    const workspace = String(body.workspace || "");
    const projects = durableProjects(record(body.projects) as Record<string, string>);
    // One live connection per machine: a reconnecting node must replace its old
    // registration instead of leaving a ghost that still claims the device.
    if (account) {
      for (const [oldId, old] of [...this.nodes]) {
        if (old.accountId !== account.id || old.deviceId !== deviceId || oldId === id) continue;
        this.nodes.delete(oldId);
        this.failInFlightFor(old, `设备 ${old.name} 已重新连接`);
        for (const waiter of old.waiters.splice(0)) waiter([]);
      }
      await this.accounts!.upsertDevice(account.id, { id: deviceId, name, workspace, projects });
    }
    const node: RelayNode = {
      id,
      name,
      version: String(body.version || ""),
      workspace,
      projects,
      accessToken: String(body.access_token || this.accessToken),
      ...(account ? { accountId: account.id } : {}),
      deviceId,
      ...(body.status && typeof body.status === "object" ? { status: body.status as RelayDeviceStatus } : {}),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      queue: [],
      waiters: [],
    };
    this.nodes.set(id, node);
    this.log(`node registered: ${node.name} (${id}) workspace=${node.workspace || "-"}${account ? ` account=${account.email}` : ""}`);
    json(res, {
      ok: true,
      node_id: id,
      poll_wait_ms: this.options.pollWaitMs ?? 25_000,
      public_url: `${this.publicBaseUrl()}/m/`,
      // The legacy link hands over a credential. Account nodes must not receive
      // one: their phone authenticates with the account session instead.
      ...(account ? {} : { access_url: this.mobileLink(node.accessToken) }),
    });
  }

  private async poll(req: IncomingMessage, res: ServerResponse, account?: RelayAccountView): Promise<void> {
    const body = record(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"));
    const node = this.nodes.get(String(body.node_id || ""));
    if (!node) throw new HttpError(404, "unknown node; register again");
    if (this.accounts && (!account || node.accountId !== account.id)) throw new HttpError(403, "device belongs to a different account");
    node.lastSeenAt = Date.now();
    if (body.status && typeof body.status === "object") node.status = body.status as RelayDeviceStatus;
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
  private resolveNode(req: IncomingMessage, url: URL, pinnedNodeId?: string, accountId?: string): RelayNode | undefined {
    const candidates = accountId ? [...this.nodes.values()].filter(node => node.accountId === accountId) : [...this.nodes.values()];
    if (pinnedNodeId) return candidates.find(node => node.id === pinnedNodeId || node.deviceId === pinnedNodeId);
    const explicit = url.searchParams.get("node") || parseCookie(req.headers.cookie, NODE_COOKIE);
    if (explicit) {
      const node = candidates.find(item => item.id === explicit || item.deviceId === explicit);
      if (node) return node;
    }
    return candidates.sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0];
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, url: URL, pinnedNodeId?: string, accountId?: string): Promise<void> {
    const node = this.resolveNode(req, url, pinnedNodeId, accountId);
    if (!node) {
      throw new HttpError(503, accountId
        ? "该账户下没有在线的 luban：请在电脑上运行 luban web --relay <中继地址> --relay-device-token <设备令牌>"
        : "没有已连接的本机 luban 节点：请在本机运行 luban web --relay <中继地址>");
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
      // Close only this HTTP proxy request. Accepted mesh jobs are owned by
      // the computer and keep running after the phone disconnects.
      this.deliver(node, { type: "abort", id });
    });

    if (!this.deliver(node, message)) {
      entry.settled = true;
      if (entry.headTimer) clearTimeout(entry.headTimer);
      this.inFlight.delete(id);
      throw new HttpError(503, `节点 ${node.name} 的待处理请求已满，请稍后重试`);
    }
  }

  private async reply(id: string, req: IncomingMessage, res: ServerResponse, account?: RelayAccountView): Promise<void> {
    const entry = this.inFlight.get(id);
    if (!entry || entry.settled) {
      // Consume the body so the node's stream is not left half-read, then tell
      // it to stop: the phone is gone.
      await readBody(req).catch(() => Buffer.alloc(0));
      return json(res, { ok: false, error: "request is no longer pending" }, 410);
    }
    if (this.accounts) {
      const node = this.nodes.get(entry.nodeId);
      if (!account || !node || node.accountId !== account.id) {
        await readBody(req).catch(() => Buffer.alloc(0));
        if (entry.headTimer) clearTimeout(entry.headTimer);
        entry.settled = true;
        this.inFlight.delete(id);
        if (entry.response.headersSent) entry.response.end();
        else json(entry.response, { ok: false, error: "device belongs to a different account" }, 403);
        return;
      }
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
