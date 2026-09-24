import http from "node:http";
import https from "node:https";
import {
  encodeFrame, encodeJsonFrame, filterForwardedHeaders, filterResponseHeaders,
  FRAME_CHUNK, FRAME_END, FRAME_FAIL, FRAME_HEAD,
  type FailPayload, type ResponseHead, type TunnelMessage, type TunnelRequestMessage,
} from "./tunnel-frames.js";

/**
 * Node side of the relay tunnel.
 *
 * The agent usually runs on a laptop behind NAT, and the phone is on mobile
 * data. Nothing can connect *in* to the laptop, so this connector dials *out*
 * to the relay and keeps one long poll open; the relay hands it the HTTP
 * requests that the phone's console produced, and the connector replays them
 * against the local web server.
 *
 * Nothing about the agent changes: the connector is a proxy, so the phone sees
 * exactly the API the browser console uses, including the SSE stream.
 */

export type TunnelState = "connecting" | "online" | "offline";

export interface TunnelClientOptions {
  /** Relay base URL, e.g. `http://relay.example.com:5000`. */
  relayUrl: string;
  /** Shared secret the relay requires from nodes. */
  nodeToken: string;
  /** Per-process phone credential; when supplied the relay pins its link to this node. */
  accessToken?: string;
  /** Address of the local web server this connector proxies to. */
  localHost?: string;
  localPort: number;
  /**
   * Access token of the local web server, injected into every forwarded
   * request. The relay authenticates the phone, so the loopback hop must not
   * ask for the same credential a second time.
   */
  localToken?: string;
  name: string;
  version: string;
  workspace: string;
  projects?: Record<string, string>;
  /** Long-poll window; the relay may cap it. */
  pollWaitMs?: number;
  /**
   * PEM CA for a relay that serves HTTPS with a self-signed certificate. When
   * the relay URL is https and this is set, the node trusts that CA instead of
   * the system store, so a LAN relay with a generated cert still connects.
   */
  relayCa?: string;
  log?: (message: string) => void;
  onState?: (state: TunnelState) => void;
}

interface Registration {
  node_id: string;
  poll_wait_ms?: number;
  public_url?: string;
  /** Ready-to-open phone link, including the access token. */
  access_url?: string;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Poll must outlive its own wait window, or every idle period costs a retry. */
const POLL_RESPONSE_GRACE_MS = 20_000;

export function normalizeRelayUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//iu.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

export class TunnelClient {
  private running = false;
  private registration?: Registration;
  private state: TunnelState = "connecting";
  private retryMs = RETRY_MIN_MS;
  private controller?: AbortController;
  private readonly inFlight = new Map<string, http.ClientRequest>();
  /** Agent + module for the relay hop: https when the relay URL is https. */
  private readonly relayAgent: http.Agent | https.Agent;
  private readonly relayModule: typeof http | typeof https;
  private readonly relayDefaultPort: number;

  constructor(private readonly options: TunnelClientOptions) {
    const secure = normalizeRelayUrl(options.relayUrl).startsWith("https:");
    this.relayModule = secure ? https : http;
    this.relayDefaultPort = secure ? 443 : 80;
    const agentOptions: http.AgentOptions & { ca?: string } = { keepAlive: true, maxSockets: 16 };
    if (secure && options.relayCa) agentOptions.ca = options.relayCa;
    this.relayAgent = secure
      ? new https.Agent(agentOptions)
      : new http.Agent(agentOptions);
  }

  get currentState(): TunnelState {
    return this.state;
  }

  get nodeId(): string | undefined {
    return this.registration?.node_id;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private setState(next: TunnelState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onState?.(next);
  }

  /** Start connecting. Resolves once the first registration attempt settles. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = undefined;
    for (const request of this.inFlight.values()) request.destroy();
    this.inFlight.clear();
    this.relayAgent.destroy();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.registration) {
          this.setState("connecting");
          this.registration = await this.register();
          this.log(`relay connected as ${this.registration.node_id}`);
        }
        this.setState("online");
        this.retryMs = RETRY_MIN_MS;
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        // A rejected node token will never fix itself by retrying, but the
        // relay may still be starting up; keep retrying at the slow interval.
        this.registration = undefined;
        this.setState("offline");
        const message = error instanceof Error ? error.message : String(error);
        this.log(`relay unavailable (${message}); retrying in ${Math.round(this.retryMs / 1000)}s`);
        await delay(this.retryMs, this.controller?.signal);
        this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
      }
    }
  }

  private async register(): Promise<Registration> {
    const reply = await this.call("/tunnel/register", {
      name: this.options.name,
      version: this.options.version,
      workspace: this.options.workspace,
      projects: this.options.projects ?? {},
      access_token: this.options.accessToken,
    });
    const parsed = reply as Partial<Registration>;
    if (!parsed?.node_id) throw new Error("relay did not return a node id");
    return { node_id: parsed.node_id, poll_wait_ms: parsed.poll_wait_ms, public_url: parsed.public_url, access_url: parsed.access_url };
  }

  private async pollOnce(): Promise<void> {
    const registration = this.registration;
    if (!registration) return;
    const waitMs = registration.poll_wait_ms ?? this.options.pollWaitMs ?? 25_000;
    const reply = await this.call("/tunnel/poll", { node_id: registration.node_id, wait_ms: waitMs }, waitMs + POLL_RESPONSE_GRACE_MS);
    const messages = (reply as { messages?: TunnelMessage[] }).messages ?? [];
    for (const message of messages) {
      if (message.type === "request") void this.proxy(message);
      else if (message.type === "abort") this.abort(message.id);
    }
  }

  private abort(id: string): void {
    const request = this.inFlight.get(id);
    if (!request) return;
    this.inFlight.delete(id);
    request.destroy(new Error("client disconnected"));
  }

  /**
   * Replay one phone request against the local server and stream the answer
   * back. The reply POST is opened before the local request completes so that
   * `head` can be written the moment the local server answers.
   */
  private async proxy(message: TunnelRequestMessage): Promise<void> {
    const { localHost = "127.0.0.1", localPort } = this.options;
    const controller = this.controller;

    const replyUrl = new URL(this.options.relayUrl);
    const replyRequest = this.relayModule.request({
      hostname: replyUrl.hostname,
      port: Number(replyUrl.port || this.relayDefaultPort),
      path: `/tunnel/reply/${encodeURIComponent(message.id)}`,
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-luban-node-token": this.options.nodeToken,
        "x-luban-node-id": this.registration?.node_id ?? "",
        "transfer-encoding": "chunked",
      },
      agent: this.relayAgent,
      signal: controller?.signal,
    });
    replyRequest.on("error", () => { /* the phone hung up; the local request is dropped below */ });
    // Flush the headers, but keep the body open: the frames are written as the
    // local response streams, and ending here would truncate every reply.
    replyRequest.flushHeaders();

    let finished = false;
    const finish = (frame?: Buffer): void => {
      if (finished) return;
      finished = true;
      if (frame) replyRequest.write(frame);
      replyRequest.end();
    };

    const headers = filterForwardedHeaders(message.headers);
    if (this.options.localToken) headers["x-luban-token"] = this.options.localToken;
    const local = http.request({
      hostname: localHost,
      port: localPort,
      path: message.path,
      method: message.method,
      headers,
    });
    this.inFlight.set(message.id, local);

    local.on("response", (response) => {
      const head: ResponseHead = { status: response.statusCode ?? 502, headers: filterResponseHeaders(response.headers) };
      replyRequest.write(encodeJsonFrame(FRAME_HEAD, head));
      response.on("data", (chunk: Buffer) => {
        if (finished) return;
        try { replyRequest.write(encodeFrame(FRAME_CHUNK, chunk)); }
        catch (error) { finish(encodeJsonFrame(FRAME_FAIL, { message: error instanceof Error ? error.message : String(error) })); }
      });
      response.on("end", () => {
        this.inFlight.delete(message.id);
        finish(encodeJsonFrame(FRAME_END, {}));
      });
      response.on("error", (error: Error) => {
        this.inFlight.delete(message.id);
        finish(encodeJsonFrame(FRAME_FAIL, { message: error.message } satisfies FailPayload));
      });
    });
    local.on("error", (error: Error) => {
      this.inFlight.delete(message.id);
      // A failed request still needs a reply, otherwise the phone waits forever.
      replyRequest.write(encodeJsonFrame(FRAME_HEAD, { status: 502, headers: { "content-type": "application/json; charset=utf-8" } } satisfies ResponseHead));
      finish(encodeJsonFrame(FRAME_FAIL, { message: `local server unreachable: ${error.message}` } satisfies FailPayload));
    });
    if (message.body) local.write(Buffer.from(message.body, "base64"));
    local.end();
  }

  /** One authenticated JSON call against the relay. */
  private async call(path: string, body: unknown, timeoutMs = 15_000): Promise<unknown> {
    const url = new URL(path, `${normalizeRelayUrl(this.options.relayUrl)}/`);
    const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
    return await new Promise<unknown>((resolve, reject) => {
      const request = this.relayModule.request({
        hostname: url.hostname,
        port: Number(url.port || this.relayDefaultPort),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          "x-luban-node-token": this.options.nodeToken,
          "x-luban-node-id": this.registration?.node_id ?? "",
        },
        agent: this.relayAgent,
        signal: this.controller?.signal,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try { parsed = text ? JSON.parse(text) : {}; }
          catch { parsed = { error: text.slice(0, 300) }; }
          const record = parsed as { ok?: boolean; error?: string };
          if (response.statusCode !== 200 || record?.ok === false) {
            reject(new Error(record?.error || `HTTP ${response.statusCode}`));
            return;
          }
          resolve(record);
        });
      });
      // Long polls need the full window plus a grace period; a shorter socket
      // timeout would abort an idle poll and turn it into a reconnect storm.
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`relay timed out after ${timeoutMs}ms`)));
      request.on("error", (error: Error) => reject(error));
      request.end(payload);
    });
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
