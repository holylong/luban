import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTlsMaterial } from "./tls.js";
import { LubanRelayServer } from "./relay.js";
import { TunnelClient } from "./tunnel.js";
import { VERSION } from "../version.js";
import { FRAME_CHUNK, FRAME_END, FRAME_HEAD, encodeFrame, encodeJsonFrame } from "./tunnel-frames.js";

/**
 * End-to-end tunnel test.
 *
 * Three real servers talk to each other over real sockets: the "phone" (fetch),
 * the relay, and a fake node whose local API stands in for LubanWebServer. That
 * is the only way to cover the parts that matter here — chunked forwarding,
 * long-poll wakeups and the SSE path — because they are all about timing.
 */

const ACCESS_TOKEN = "phone-token";
const NODE_TOKEN = "node-token";

interface FakeNode {
  server: Server;
  port: number;
  /** Set by a test to make the next local call fail. */
  closed: boolean;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** Local API stand-in: JSON, an echo endpoint, a slow SSE stream and a 500. */
async function startFakeNode(): Promise<FakeNode> {
  const state = { closed: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://node.local");
    if (state.closed) { req.socket.destroy(); return; }
    if (url.pathname === "/api/node") {
      const body = Buffer.from(JSON.stringify({ ok: true, name: "fake-node", version: VERSION, workspace: "/tmp/ws" }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
      res.end(body);
      return;
    }
    if (url.pathname === "/api/echo" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = Buffer.from(JSON.stringify({ ok: true, received: Buffer.concat(chunks).toString("utf8"), header: String(req.headers["x-custom"] ?? "") }));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
        res.end(body);
      });
      return;
    }
    if (url.pathname === "/api/slow") {
      // Two events, spaced out: a buffered proxy would deliver both at the end.
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" });
      res.write("data: one\n\n");
      const timer = setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 120);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (url.pathname === "/api/boom") {
      const body = Buffer.from("kaboom");
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "content-length": body.length });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  const port = await listen(server);
  return { server, port, get closed() { return state.closed; }, set closed(value: boolean) { state.closed = value; } };
}

describe("relay tunnel", () => {
  let relay: LubanRelayServer;
  let relayUrl: string;
  let node: FakeNode;
  let tunnel: TunnelClient;

  const phone = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${relayUrl}${path}`, { ...init, headers: { ...init.headers }, redirect: "manual" });

  beforeEach(async () => {
    relay = new LubanRelayServer({ host: "127.0.0.1", port: 0, token: ACCESS_TOKEN, nodeToken: NODE_TOKEN });
    relayUrl = await relay.start();
    node = await startFakeNode();
    tunnel = new TunnelClient({
      relayUrl,
      nodeToken: NODE_TOKEN,
      localPort: node.port,
      name: "fake-node",
      version: VERSION,
      workspace: "/tmp/ws",
    });
    await tunnel.start();
    // Wait for registration: the relay only answers 200 once a node is online.
    await waitFor(async () => (await phone(`/relay/health`)).status === 200);
    await waitFor(async () => {
      const reply = await phone(`/relay/nodes?token=${ACCESS_TOKEN}`);
      const body = await reply.json() as { nodes?: Array<{ online: boolean }> };
      return Boolean(body.nodes?.length && body.nodes[0]!.online);
    });
  });

  afterEach(async () => {
    tunnel.stop();
    await new Promise<void>(resolve => node.server.close(() => resolve()));
    await relay.stop();
  });

  it("keeps the phone out until it presents the access token", async () => {
    const health = await phone("/relay/health");
    expect(await health.json()).toEqual({ ok: true, service: "luban-relay", version: VERSION });
    const api = await phone("/api/node");
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ ok: false, auth_required: true });

    const page = await phone("/m/");
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("luban 控制台");
  });

  it("exchanges a link token for a cookie and redirects to the phone console", async () => {
    const response = await phone(`/login?token=${ACCESS_TOKEN}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/m/");
    const cookie = response.headers.get("set-cookie") || "";
    expect(cookie).toContain("luban_token=");
    expect(cookie).toContain("HttpOnly");
  });

  it("never lets a node token be used as a phone token", async () => {
    const response = await phone(`/api/node?token=${NODE_TOKEN}`);
    expect(response.status).toBe(401);
  });

  it("forwards a proxied request to the node and streams the answer back", async () => {
    const response = await phone(`/api/node?token=${ACCESS_TOKEN}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "fake-node", workspace: "/tmp/ws" });
  });

  it("forwards method, body and headers", async () => {
    const response = await phone(`/api/echo?token=${ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-custom": "kept" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await response.json()).toMatchObject({ received: '{"hello":"world"}', header: "kept" });
  });

  it("preserves the upstream status and body", async () => {
    const response = await phone(`/api/boom?token=${ACCESS_TOKEN}`);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("kaboom");
  });

  it("delivers SSE chunks while the stream is still open", async () => {
    const response = await phone(`/api/slow?token=${ACCESS_TOKEN}`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("data: one");
    // Waiting for the second read is the assertion: if the relay buffered the
    // whole response, the first read would already contain both events.
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain("data: two");
    await reader.cancel().catch(() => undefined);
  });

  it("answers 503 while no node is connected, and recovers when one registers", async () => {
    tunnel.stop();
    // The relay learns the node is gone when its long poll drops, which is a
    // round trip; wait for that instead of racing it with a request.
    await waitFor(async () => {
      const reply = await phone(`/relay/nodes?token=${ACCESS_TOKEN}`);
      const body = await reply.json() as { nodes?: Array<{ online: boolean }> };
      return body.nodes?.[0]?.online === false;
    });
    const offline = await phone(`/api/node?token=${ACCESS_TOKEN}`);
    expect(offline.status).toBe(503);
    expect(await offline.json()).toMatchObject({ ok: false });

    const replacement = new TunnelClient({
      relayUrl, nodeToken: NODE_TOKEN, localPort: node.port, name: "fake-node-2", version: VERSION, workspace: "/tmp/ws",
    });
    await replacement.start();
    try {
      await waitFor(async () => (await phone(`/api/node?token=${ACCESS_TOKEN}`)).status === 200);
      expect((await phone(`/api/node?token=${ACCESS_TOKEN}`)).status).toBe(200);
    } finally {
      replacement.stop();
    }
  });

  it("stops reporting a node that went away without dying", async () => {
    // Registered but silent: the relay must not run its requests into the void.
    const registered = await phone(`/relay/nodes?token=${ACCESS_TOKEN}`);
    expect((await registered.json() as { nodes: unknown[] }).nodes).toHaveLength(1);
    tunnel.stop();
    await waitFor(async () => {
      const reply = await phone(`/relay/nodes?token=${ACCESS_TOKEN}`);
      const body = await reply.json() as { nodes?: Array<{ online: boolean }> };
      return body.nodes?.[0]?.online === false;
    });
    const reply = await phone(`/api/node?token=${ACCESS_TOKEN}`);
    expect(reply.status).toBe(503);
    expect(await reply.json()).toMatchObject({ ok: false });
  });

  it("serves the mobile shell and its assets", async () => {
    const shell = await phone(`/m/?token=${ACCESS_TOKEN}`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(await shell.text()).toContain("luban");

    const index = await phone(`/m?token=${ACCESS_TOKEN}`);
    expect(index.status).toBe(302);
    expect(index.headers.get("location")).toBe("/m/");
  });

  it("rejects a node that presents the wrong node token", async () => {
    const response = await fetch(`${relayUrl}/tunnel/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-luban-node-token": "wrong" },
      body: JSON.stringify({ name: "impostor" }),
    });
    expect(response.status).toBe(401);
  });

  it("hands the node a ready-to-open phone link", async () => {
    const link = relay.mobileLink();
    expect(link).toContain("/login?token=");
    const response = await phone(new URL(link).pathname + new URL(link).search);
    expect(response.status).toBe(302);
  });

  it("delivers a request after the node's poll idled out", async () => {
    // Regression: an idle poll that times out used to leave its waiter in the
    // node's list. `deliver` hands work to the first waiter it finds, so the
    // next request was handed to the dead waiter and silently dropped — the
    // phone then waited out the head timeout with nothing reaching the node.
    // A short poll window makes one idle cycle cheap to reproduce.
    tunnel.stop();
    await new Promise<void>(resolve => node.server.close(() => resolve()));
    await relay.stop();

    const fastRelay = new LubanRelayServer({ host: "127.0.0.1", port: 0, token: ACCESS_TOKEN, nodeToken: NODE_TOKEN, pollWaitMs: 300 });
    const fastUrl = await fastRelay.start();
    const fastNode = await startFakeNode();
    const fastTunnel = new TunnelClient({ relayUrl: fastUrl, nodeToken: NODE_TOKEN, localPort: fastNode.port, name: "fake-node", version: VERSION, workspace: "/tmp/ws" });
    await fastTunnel.start();
    try {
      await waitFor(async () => {
        const reply = await fetch(`${fastUrl}/relay/nodes?token=${ACCESS_TOKEN}`);
        const body = await reply.json() as { nodes?: Array<{ online: boolean }> };
        return Boolean(body.nodes?.length && body.nodes[0]!.online);
      });
      // The relay clamps a poll window to at least 1s, so wait past one full
      // idle cycle: that timeout is what used to leave a dead waiter behind.
      await new Promise(resolve => setTimeout(resolve, 1_300));
      const started = Date.now();
      const reply = await fetch(`${fastUrl}/api/node?token=${ACCESS_TOKEN}`);
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ name: "fake-node" });
      // The bug surfaced as a full head timeout, so bound the wait explicitly.
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      fastTunnel.stop();
      await new Promise<void>(resolve => fastNode.server.close(() => resolve()));
      await fastRelay.stop();
      // Re-open the fixtures the outer afterEach expects to clean up.
      relay = new LubanRelayServer({ host: "127.0.0.1", port: 0, token: ACCESS_TOKEN, nodeToken: NODE_TOKEN });
      relayUrl = await relay.start();
      node = await startFakeNode();
      tunnel = new TunnelClient({ relayUrl, nodeToken: NODE_TOKEN, localPort: node.port, name: "fake-node", version: VERSION, workspace: "/tmp/ws" });
      await tunnel.start();
    }
  });

  it("tells a node to stop when the phone goes away", async () => {
    const started = Date.now();
    const controller = new AbortController();
    const pending = fetch(`${relayUrl}/api/slow?token=${ACCESS_TOKEN}`, { signal: controller.signal }).catch(() => undefined);
    await waitFor(async () => relay.inFlightCount() === 1);
    controller.abort();
    await pending;
    await waitFor(async () => relay.inFlightCount() === 0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/** Poll a condition instead of sleeping a fixed amount: keeps the suite fast. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe("frame helpers used by the relay", () => {
  it("writes a head frame the relay can parse", () => {
    const frame = encodeJsonFrame(FRAME_HEAD, { status: 204, headers: {} });
    expect(frame.readUInt8(0)).toBe(FRAME_HEAD);
    expect(encodeFrame(FRAME_CHUNK, "x").length).toBe(6);
    expect(encodeFrame(FRAME_END).length).toBe(5);
  });
});

describe("relay over HTTPS", () => {
  // A phone only installs the console as an app when the relay is a secure
  // context, so the whole tunnel has to work over TLS with a generated cert.
  let httpsRelay: LubanRelayServer;
  let httpsRelayUrl: string;
  let ca: string;
  let httpsNode: FakeNode;
  let httpsTunnel: TunnelClient;

  beforeEach(async () => {
    const material = generateTlsMaterial({ hosts: ["127.0.0.1", "localhost"], dir: mkdtempSync(join(tmpdir(), "luban-tls-test-")) });
    ca = material.ca;
    httpsRelay = new LubanRelayServer({ host: "127.0.0.1", port: 0, token: ACCESS_TOKEN, nodeToken: NODE_TOKEN, tls: { key: material.key, cert: material.cert } });
    httpsRelayUrl = await httpsRelay.start();
    httpsNode = await startFakeNode();
    httpsTunnel = new TunnelClient({ relayUrl: httpsRelayUrl, nodeToken: NODE_TOKEN, localPort: httpsNode.port, name: "fake-node", version: VERSION, workspace: "/tmp/ws", relayCa: ca });
    await httpsTunnel.start();
    await waitFor(async () => (await httpsGet("/relay/health")).status === 200);
    await waitFor(async () => {
      const body = await httpsJson(`/relay/nodes?token=${ACCESS_TOKEN}`) as { nodes?: Array<{ online: boolean }> };
      return Boolean(body.nodes?.length && body.nodes[0]!.online);
    });
  });

  afterEach(async () => {
    httpsTunnel.stop();
    await new Promise<void>(resolve => httpsNode.server.close(() => resolve()));
    await httpsRelay.stop();
  });

  it("serves the phone console and forwards a proxied request over TLS", async () => {
    expect(httpsRelayUrl.startsWith("https://")).toBe(true);
    // The shell is reachable over TLS (the auth gate answers it), and the
    // node's API then answers through the tunnel once the token is presented.
    const page = await httpsGet("/m/");
    expect(page.status).toBe(401);
    expect(page.text).toContain("luban 控制台");
    const api = await httpsJson(`/api/node?token=${ACCESS_TOKEN}`) as { ok?: boolean; name?: string };
    expect(api).toMatchObject({ ok: true, name: "fake-node" });
  });

  it("keeps the phone out until it presents the access token, over TLS", async () => {
    const api = await httpsJson("/api/node");
    expect(api).toMatchObject({ ok: false, auth_required: true });
  });

  /** GET through https trusting the generated CA; returns status + text/json. */
  async function httpsGet(path: string): Promise<{ status: number; text: string }> {
    return await new Promise((resolve, reject) => {
      const url = new URL(httpsRelayUrl + path);
      const req = httpsRequest({ hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET", ca }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  async function httpsJson(path: string): Promise<unknown> {
    const { text } = await httpsGet(path);
    return text ? JSON.parse(text) : {};
  }
});
