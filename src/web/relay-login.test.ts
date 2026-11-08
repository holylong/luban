import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loginRelayAccount, saveRelayDeviceToken } from "./relay-login.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "luban-relay-login-"));
  const oldHome = process.env.LUBAN_HOME;
  process.env.LUBAN_HOME = home;
  cleanups.push(async () => {
    if (oldHome === undefined) delete process.env.LUBAN_HOME;
    else process.env.LUBAN_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  });

  let loginBody = "";
  let cookie = "";
  const server = createServer(async (request, response) => {
    if (request.url === "/api/auth/login" && request.method === "POST") {
      loginBody = await body(request);
      json(response, 200, { ok: true, account: { email: "owner@example.com" } }, {
        "set-cookie": "luban_account=session-token; HttpOnly; Path=/",
      });
      return;
    }
    if (request.url === "/api/account/device-token" && request.method === "POST") {
      cookie = String(request.headers.cookie ?? "");
      json(response, 200, { ok: true, token: "device-token-123" });
      return;
    }
    json(response, 404, { ok: false, error: "not found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  return {
    home,
    relayUrl: `http://127.0.0.1:${address.port}`,
    loginBody: () => loginBody,
    cookie: () => cookie,
    envPath: join(home, "relay.env"),
    configPath: join(home, "config.json"),
  };
}

it("logs in, stores the device token with mode 0600, and preserves unrelated env keys", async () => {
  const test = await setup();
  await import("node:fs/promises").then(fs => fs.writeFile(test.envPath, "LUBAN_RELAY_PUBLIC_URL=https://relay.example.com\n", { mode: 0o600 }));

  const result = await loginRelayAccount({
    home: test.home,
    relayUrl: test.relayUrl,
    email: "Owner@Example.com",
    password: "password-1",
  });

  expect(JSON.parse(test.loginBody())).toEqual({ email: "Owner@Example.com", password: "password-1" });
  expect(test.cookie()).toBe("luban_account=session-token");
  expect(result).toMatchObject({
    relayUrl: test.relayUrl,
    email: "owner@example.com",
    envKey: "LUBAN_RELAY_DEVICE_TOKEN",
    envPath: test.envPath,
    configPath: test.configPath,
    wroteConfig: true,
  });
  const env = await readFile(test.envPath, "utf8");
  expect(env).toContain("LUBAN_RELAY_PUBLIC_URL=https://relay.example.com");
  expect(env).toContain("LUBAN_RELAY_DEVICE_TOKEN=device-token-123");
  expect(env).not.toContain("password-1");
  expect((await stat(test.envPath)).mode & 0o777).toBe(0o600);
  expect((await stat(test.configPath)).mode & 0o777).toBe(0o600);
  const config = JSON.parse(await readFile(test.configPath, "utf8"));
  expect(config.remote).toMatchObject({
    enabled: true,
    relay_url: test.relayUrl,
    device_token_env: "LUBAN_RELAY_DEVICE_TOKEN",
    node_token_file: test.envPath,
  });
  expect(await readFile(test.configPath, "utf8")).not.toContain("password-1");
});

it("saves an existing token without writing config when asked", async () => {
  const test = await setup();
  const result = await saveRelayDeviceToken({
    home: test.home,
    relayUrl: test.relayUrl,
    token: "existing-token",
    writeConfig: false,
  });
  expect(result.wroteConfig).toBe(false);
  expect(await readFile(test.envPath, "utf8")).toBe("LUBAN_RELAY_DEVICE_TOKEN=existing-token\n");
  await expect(readFile(test.configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects plain HTTP relays that are not loopback", async () => {
  await expect(saveRelayDeviceToken({
    home: tmpdir(),
    relayUrl: "http://relay.example.com",
    token: "token",
  })).rejects.toThrow(/HTTPS/u);
});

it("defaults a bare host to https and keeps loopback on http", async () => {
  const test = await setup();
  const remote = await saveRelayDeviceToken({
    home: test.home,
    relayUrl: "relay.example.com",
    token: "token",
    writeConfig: false,
  });
  expect(remote.relayUrl).toBe("https://relay.example.com");
  const loopback = await saveRelayDeviceToken({
    home: test.home,
    relayUrl: "127.0.0.1:8642",
    token: "token",
    writeConfig: false,
  });
  expect(loopback.relayUrl).toBe("http://127.0.0.1:8642");
});
