import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LubanRelayServer } from "./relay.js";
import { TunnelClient } from "./tunnel.js";
import { VERSION } from "../version.js";

/** Accounts are the multi-device path: one phone login, many enrolled laptops. */

const NODE_TOKEN = "node-token";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function startFakeNode(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://node.local");
    if (url.pathname === "/api/echo" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = Buffer.from(JSON.stringify({ ok: true, received: Buffer.concat(chunks).toString("utf8") }));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
        res.end(body);
      });
      return;
    }
    const body = Buffer.from(JSON.stringify({ ok: true, name: "fake-node", version: VERSION, workspace: "/tmp/ws" }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
    res.end(body);
  });
  return { server, port: await listen(server) };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

function sessionCookie(response: Response): string {
  const getSetCookie = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const all = getSetCookie ? getSetCookie.call(response.headers) : [response.headers.get("set-cookie") || ""];
  const value = all.map(item => item.split(";")[0]!).find(item => item.startsWith("luban_account="));
  if (!value) throw new Error(`no account cookie: ${all.join(" | ")}`);
  return value;
}

describe("relay accounts", () => {
  let relay: LubanRelayServer;
  let relayUrl: string;
  let node: { server: Server; port: number };
  let root: string;
  let tunnel: TunnelClient | undefined;

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${relayUrl}${path}`, { ...init, headers: { ...init.headers }, redirect: "manual" });

  async function register(email: string): Promise<string> {
    const response = await call("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-1" }),
    });
    expect(response.status).toBe(200);
    return sessionCookie(response);
  }

  async function enroll(cookie: string): Promise<string> {
    const response = await call("/api/account/device-token", { method: "POST", headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { token: string };
    return body.token;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "luban-relay-accounts-"));
    relay = new LubanRelayServer({
      host: "127.0.0.1", port: 0, nodeToken: NODE_TOKEN,
      accountsPath: join(root, "accounts.json"),
    });
    relayUrl = await relay.start();
    node = await startFakeNode();
  });

  afterEach(async () => {
    tunnel?.stop();
    tunnel = undefined;
    await new Promise<void>(resolve => node.server.close(() => resolve()));
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the phone console public but gates account APIs", async () => {
    const page = await call("/m/");
    expect(page.status).toBe(200);
    const me = await call("/api/auth/me");
    expect(me.status).toBe(401);
    const nodes = await call("/relay/nodes");
    expect(nodes.status).toBe(401);
  });

  it("registers, stores the session cookie and logs out", async () => {
    const cookie = await register("owner@example.com");
    const me = await call("/api/auth/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ ok: true, account: { email: "owner@example.com" } });

    const logout = await call("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect(logout.status).toBe(200);
    expect((await call("/api/auth/me", { headers: { cookie } })).status).toBe(401);
  });

  it("shows an enrolled device with its live job status and scopes it to the account", async () => {
    const cookie = await register("owner@example.com");
    await enroll(cookie);
    const token = await enroll(cookie);
    tunnel = new TunnelClient({
      relayUrl,
      nodeToken: NODE_TOKEN,
      deviceToken: token,
      deviceId: "dev-aaaaaaaaaaaaaaaa",
      localPort: node.port,
      name: "laptop",
      version: VERSION,
      workspace: "/tmp/ws",
      status: () => ({
        updated_at: Date.now() / 1000,
        model: "test/model",
        jobs: [{
          id: "job-1", title: "Fix the build", instruction: "fix it", status: "working",
          progress: 42, updated_at: Date.now() / 1000, session_id: "session-1",
        }],
      }),
    });
    await tunnel.start();
    await waitFor(async () => {
      const reply = await call("/relay/nodes", { headers: { cookie } });
      const body = await reply.json() as { nodes?: Array<{ id: string; online: boolean; status?: { jobs?: unknown[] } }> };
      return Boolean(body.nodes?.some(item => item.id === "dev-aaaaaaaaaaaaaaaa" && item.online && item.status?.jobs?.length));
    });

    const nodes = await call("/relay/nodes", { headers: { cookie } });
    const body = await nodes.json() as { nodes: Array<{ id: string; name: string; status: { model: string; jobs: Array<{ id: string; session_id: string }> } }> };
    expect(body.nodes[0]).toMatchObject({
      id: "dev-aaaaaaaaaaaaaaaa",
      name: "laptop",
      status: { model: "test/model", jobs: [{ id: "job-1", session_id: "session-1" }] },
    });

    const proxied = await call("/api/echo?node=dev-aaaaaaaaaaaaaaaa", {
      method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "hello",
    });
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toMatchObject({ ok: true, received: "hello" });

    // A different account sees no devices and cannot address the first account's device.
    const other = await register("other@example.com");
    const otherNodes = await call("/relay/nodes", { headers: { cookie: other } });
    expect((await otherNodes.json() as { nodes: unknown[] }).nodes).toEqual([]);
    const denied = await call("/api/echo?node=dev-aaaaaaaaaaaaaaaa", {
      method: "POST", headers: { cookie: other, "content-type": "text/plain" }, body: "hello",
    });
    expect(denied.status).toBe(503);
  });

  it("persists devices after they go offline and removes them", async () => {
    const cookie = await register("owner@example.com");
    const token = await enroll(cookie);
    tunnel = new TunnelClient({
      relayUrl, nodeToken: "", deviceToken: token, deviceId: "dev-bbbbbbbbbbbbbbbb",
      localPort: node.port, name: "desktop", version: VERSION, workspace: "/tmp/ws",
    });
    await tunnel.start();
    await waitFor(async () => {
      const body = await (await call("/api/account/devices", { headers: { cookie } })).json() as { devices?: unknown[] };
      return Boolean(body.devices?.length);
    });
    tunnel.stop();
    await waitFor(async () => {
      const body = await (await call("/api/account/devices", { headers: { cookie } })).json() as { devices?: Array<{ online: boolean }> };
      return body.devices?.[0]?.online === false;
    });
    const remove = await call("/api/account/devices/dev-bbbbbbbbbbbbbbbb", { method: "DELETE", headers: { cookie } });
    expect(remove.status).toBe(200);
    expect((await (await call("/api/account/devices", { headers: { cookie } })).json() as { devices: unknown[] }).devices).toEqual([]);
  });

  it("rejects an unenrolled device token", async () => {
    tunnel = new TunnelClient({
      relayUrl, nodeToken: "", deviceToken: "not-a-device-token", deviceId: "dev-cccccccccccccccc",
      localPort: node.port, name: "intruder", version: VERSION, workspace: "/tmp/ws",
    });
    await tunnel.start();
    await new Promise(resolve => setTimeout(resolve, 350));
    const cookie = await register("owner@example.com");
    const body = await (await call("/relay/nodes", { headers: { cookie } })).json() as { nodes: unknown[] };
    expect(body.nodes).toEqual([]);
  });
});
