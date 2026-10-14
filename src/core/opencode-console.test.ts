import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleAccessToken } from "./opencode-console.js";

const originalHome = process.env.LUBAN_HOME;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT;
const servers: ChildProcess[] = [];
const sqliteAvailable = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e",
  'await import("node:sqlite")']).status === 0;

// consoleAccessToken uses spawnSync; a server in this process cannot respond
// while that call blocks the event loop. Keep the fixture in another process.
async function refreshServer(status = 200, response: unknown = {
  access_token: "renewed-access", refresh_token: "rotated-refresh", expires_in: 3600,
}): Promise<{ url: string; log: string }> {
  const log = join(process.env.LUBAN_HOME!, "requests.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "node:http";
    import { writeFileSync } from "node:fs";
    const requests = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, method: req.method, body: JSON.parse(body) });
      writeFileSync(process.argv[1], JSON.stringify(requests));
      res.writeHead(Number(process.argv[2]), { "content-type": "application/json" });
      res.end(process.argv[3]);
    });
    server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
  `, log, String(status), JSON.stringify(response)], { stdio: ["ignore", "pipe", "pipe"] });
  servers.push(child);
  const [port] = await once(child.stdout!, "data");
  return { url: `http://127.0.0.1:${String(port)}/`, log };
}

async function expiredLogin(server: string): Promise<string> {
  const file = join(await dataHome(), "auth.json");
  await writeFile(file, JSON.stringify({ opencode: {
    type: "oauth", access: "expired-access", refresh: "original-refresh",
    expires: Date.now() - 1000, metadata: { server },
  } }));
  return file;
}

async function dataHome(): Promise<string> {
  const root = join(process.env.XDG_DATA_HOME!, "opencode");
  await mkdir(root, { recursive: true });
  return root;
}

beforeEach(async () => {
  process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "luban-console-xdg-"));
  process.env.LUBAN_HOME = await mkdtemp(join(tmpdir(), "luban-console-home-"));
  delete process.env.OPENCODE_AUTH_CONTENT;
});

afterEach(async () => {
  for (const child of servers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  await rm(process.env.XDG_DATA_HOME!, { recursive: true, force: true });
  await rm(process.env.LUBAN_HOME!, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
  else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent;
});

describe("OpenCode Console credential", () => {
  it("reads the OAuth pair out of auth.json", async () => {
    const data = await dataHome();
    await writeFile(join(data, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "access-1", refresh: "refresh-1", expires: Date.now() + 600_000 },
    }));
    expect(consoleAccessToken()).toBe("access-1");
  });

  it("reads the older account.json layout", async () => {
    const data = await dataHome();
    await writeFile(join(data, "account.json"), JSON.stringify({
      version: 1,
      accounts: {
        a: { id: "a", serviceID: "opencode", credential: { type: "oauth", access: "access-2", refresh: "r", expires: Date.now() + 600_000 } },
        b: { id: "b", serviceID: "deepseek", credential: { type: "api", key: "sk-other" } },
      },
    }));
    expect(consoleAccessToken()).toBe("access-2");
  });

  it("does not mistake a Console API key for a session", async () => {
    const data = await dataHome();
    await writeFile(join(data, "auth.json"), JSON.stringify({ opencode: { type: "api", key: "oc_sk_pay" } }));
    expect(consoleAccessToken()).toBe("");
  });

  it("falls back to the exported credential content", async () => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
      opencode: { type: "oauth", access: "access-3", refresh: "r", expires: Date.now() + 600_000 },
    });
    expect(consoleAccessToken()).toBe("access-3");
  });

  it("returns nothing rather than failing when no OpenCode login exists", async () => {
    expect(consoleAccessToken()).toBe("");
  });

  it("refreshes an expired session and reuses the private cache without changing OpenCode's store", async () => {
    const { url, log } = await refreshServer();
    const source = await expiredLogin(url);
    const before = await readFile(source, "utf8");
    expect(consoleAccessToken()).toBe("renewed-access");
    const cache = join(process.env.LUBAN_HOME!, "opencode-console.json");
    const cached = JSON.parse(await readFile(cache, "utf8"));
    expect(cached).toMatchObject({ access: "renewed-access", refresh: "rotated-refresh", server: url });
    expect(cached.expires).toBeGreaterThan(Date.now() + 3500_000);
    if (process.platform !== "win32") expect((await stat(cache)).mode & 0o777).toBe(0o600);
    expect(consoleAccessToken()).toBe("renewed-access");
    expect(JSON.parse(await readFile(log, "utf8"))).toEqual([{
      path: "/auth/device/token", method: "POST",
      body: { grant_type: "refresh_token", refresh_token: "original-refresh", client_id: "opencode-cli" },
    }]);
    expect(await readFile(source, "utf8")).toBe(before);
  });

  it("uses the rotated refresh token when the cache expires", async () => {
    const { url, log } = await refreshServer();
    await expiredLogin(url);
    expect(consoleAccessToken()).toBe("renewed-access");
    const cache = join(process.env.LUBAN_HOME!, "opencode-console.json");
    const cached = JSON.parse(await readFile(cache, "utf8"));
    await writeFile(cache, JSON.stringify({ ...cached, expires: Date.now() - 1000 }));
    expect(consoleAccessToken()).toBe("renewed-access");
    const requests = JSON.parse(await readFile(log, "utf8"));
    expect(requests).toHaveLength(2);
    expect(requests[1].body.refresh_token).toBe("rotated-refresh");
  });

  it.each([
    [401, { error: "invalid_grant" }],
    [200, { refresh_token: "missing-access" }],
  ])("returns no token after an invalid refresh response (%s)", async (status, response) => {
    const { url } = await refreshServer(status, response);
    await expiredLogin(url);
    expect(consoleAccessToken()).toBe("");
    await expect(stat(join(process.env.LUBAN_HOME!, "opencode-console.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(!sqliteAvailable)("reads the active SQLite credential rather than a different saved account", async () => {
    const file = join(await dataHome(), "opencode.db");
    const result = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)");
      const insert = db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)");
      for (const [id, active, created] of [["old", 0, 2], ["selected", 1, 1]]) {
        insert.run(id, "opencode", JSON.stringify({ type: "oauth", access: id, refresh: "r", expires: Date.now() + 600000 }), active, created);
      }
      db.close();
    `, file], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(consoleAccessToken()).toBe("selected");
  });
});
