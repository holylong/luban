import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDaemonState, clearDaemonStateIfOwner, daemonEntry, daemonInfo, daemonLogTail, daemonPaths,
  ensureDaemon, probeDaemon, readDaemonState, registerDaemonProject, stopDaemon, writeDaemonState,
  type DaemonState,
} from "./daemon.js";

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "luban-daemon-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function state(home: string, patch: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: process.pid, port: 38123, token: "t".repeat(32), workspace: join(home, "ws"),
    startedAt: Date.now(), version: "9.9.9", ...patch,
  };
}

/** A fetch that answers the two routes the daemon manager uses. */
function fakeFetch(reply: { ok?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: reply.ok ?? true, project: "proj" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("daemon state", () => {
  it("writes a private state file and reads it back", () => {
    const home = tempHome();
    const value = state(home);
    writeDaemonState(home, value);
    const mode = statSync(daemonPaths(home).state).mode & 0o777;
    // The token in this file is a bearer credential for the whole workspace.
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    expect(readDaemonState(home)).toEqual(value);
    clearDaemonState(home);
    expect(readDaemonState(home)).toBeUndefined();
  });

  it("refuses a state file it cannot trust", () => {
    const home = tempHome();
    const paths = daemonPaths(home);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.state, "not json");
    expect(readDaemonState(home)).toBeUndefined();
    writeFileSync(paths.state, JSON.stringify({ pid: 0, port: 1, token: "x".repeat(32) }));
    expect(readDaemonState(home)).toBeUndefined();
    writeFileSync(paths.state, JSON.stringify({ pid: 12, port: 0, token: "x".repeat(32) }));
    expect(readDaemonState(home)).toBeUndefined();
    writeFileSync(paths.state, JSON.stringify({ pid: 12, port: 4000, token: "short" }));
    expect(readDaemonState(home)).toBeUndefined();
  });

  it("treats a live pid with a silent server as dead", async () => {
    const home = tempHome();
    // Our own pid is alive, so only the health probe can tell the difference.
    await expect(probeDaemon(state(home), { fetchImpl: fakeFetch({ ok: false }).impl })).resolves.toBe(false);
    const failing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(probeDaemon(state(home), { fetchImpl: failing })).resolves.toBe(false);
    const { impl, calls } = fakeFetch();
    await expect(probeDaemon(state(home), { fetchImpl: impl })).resolves.toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:38123/healthz");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${"t".repeat(32)}`);
  });

  it("refuses to spawn a dev entry instead of the compiled CLI", () => {
    expect(daemonEntry("/opt/luban/dist/cli.js")).toBe("/opt/luban/dist/cli.js");
    expect(() => daemonEntry("/opt/luban/src/cli.tsx")).toThrow(/dist\/cli\.js/u);
  });
});

describe("ensureDaemon", () => {
  it("reuses a healthy daemon and registers the caller's workspace", async () => {
    const home = tempHome();
    writeDaemonState(home, state(home, { workspace: join(home, "other") }));
    const { impl, calls } = fakeFetch();
    let spawned = 0;
    const result = await ensureDaemon(home, {
      workspace: join(home, "mine"), version: "9.9.9",
      probe: () => Promise.resolve(true),
      fetchImpl: impl,
      spawnImpl: () => { spawned += 1; throw new Error("must not spawn"); },
    });
    expect(result.started).toBe(false);
    expect(spawned).toBe(0);
    // The phone lists projects, not one workspace per daemon.
    expect(calls.some(call => call.url.endsWith("/api/projects"))).toBe(true);
    expect(JSON.parse(String(calls.find(call => call.url.endsWith("/api/projects"))!.init!.body))).toMatchObject({ path: join(home, "mine") });
  });

  it("replaces a stale state file by starting a detached child", async () => {
    const home = tempHome();
    // A pid that cannot be running: the state file is a leftover, not a daemon.
    writeDaemonState(home, state(home, { pid: 2_147_483_646 }));
    const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = await ensureDaemon(home, {
      workspace: join(home, "ws"), version: "9.9.9", entry: "/opt/luban/dist/cli.js", execPath: "/usr/bin/node",
      // The stale pid is not this process, so only the freshly written one passes.
      probe: candidate => Promise.resolve(candidate.pid === process.pid),
      spawnImpl: ((command: string, args: string[], options: Record<string, unknown>) => {
        spawned.push({ command, args, options });
        // Stand in for the child writing its own state before it is probed.
        writeDaemonState(home, state(home, { workspace: join(home, "ws"), version: "9.9.9" }));
        return { pid: 4242, unref: () => undefined, kill: () => true } as never;
      }) as never,
    });
    expect(result.started).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args.slice(0, 3)).toEqual(["/opt/luban/dist/cli.js", "web", join(home, "ws")]);
    expect(spawned[0]!.args).toContain("--daemon-child");
    expect(spawned[0]!.args).toContain("--remote");
    expect(spawned[0]!.options.detached).toBe(true);
    const env = spawned[0]!.options.env as Record<string, string>;
    // The child needs the token to write the state file every other caller reads.
    expect(env.LUBAN_HOME).toBe(home);
    expect(env.LUBAN_WEB_TOKEN).toMatch(/^[A-Za-z0-9_-]{16,}$/u);
    // The lock is released even when the spawn path returns early.
    expect(existsSync(daemonPaths(home).lock)).toBe(false);
  });

  it("gives up loudly when the child never answers", async () => {
    const home = tempHome();
    let killed = false;
    await expect(ensureDaemon(home, {
      workspace: join(home, "ws"), version: "9.9.9", entry: "/opt/luban/dist/cli.js", timeoutMs: 300,
      probe: () => Promise.resolve(false),
      spawnImpl: (() => ({ pid: 4242, unref: () => undefined, kill: () => { killed = true; } }) as never) as never,
    })).rejects.toThrow(/没有在预期时间内就绪/u);
    expect(killed).toBe(true);
    expect(readFileSync(daemonPaths(home).log, "utf8")).toBe("");
  });
});

describe("stopDaemon", () => {
  it("kills the daemon it started and forgets it", async () => {
    const home = tempHome();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise(resolve => child.once("spawn", resolve));
    writeDaemonState(home, state(home, { pid: child.pid! }));
    const exited = new Promise(resolve => child.once("exit", resolve));
    await expect(stopDaemon(home)).resolves.toBe(true);
    expect(readDaemonState(home)).toBeUndefined();
    await exited;
  });

  it("is a no-op when nothing is running", async () => {
    const home = tempHome();
    await expect(stopDaemon(home)).resolves.toBe(false);
    writeDaemonState(home, state(home, { pid: 2_147_483_646 }));
    await expect(stopDaemon(home)).resolves.toBe(false);
    expect(readDaemonState(home)).toBeUndefined();
  });
});

describe("daemon extras", () => {
  it("registers a project over HTTP with the bearer token", async () => {
    const home = tempHome();
    const { impl, calls } = fakeFetch();
    await expect(registerDaemonProject(state(home), join(home, "repo"), { fetchImpl: impl })).resolves.toBe("proj");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${"t".repeat(32)}`);
  });

  it("only clears the state file it still owns", () => {
    const home = tempHome();
    writeDaemonState(home, state(home, { pid: 4242 }));
    // A daemon that was replaced must not delete its successor's address.
    expect(clearDaemonStateIfOwner(home, 999)).toBe(false);
    expect(readDaemonState(home)?.pid).toBe(4242);
    expect(clearDaemonStateIfOwner(home, 4242)).toBe(true);
    expect(readDaemonState(home)).toBeUndefined();
    expect(clearDaemonStateIfOwner(home, 4242)).toBe(false);
  });

  it("reports the projects the daemon serves", async () => {
    const home = tempHome();
    const impl = (async () => new Response(JSON.stringify({
      version: "9.9.9", model: "deepseek/v4", workspace: "/w", project: "w",
      projects: { shop: "/Users/me/shop" },
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(daemonInfo(state(home), { fetchImpl: impl })).resolves.toEqual({
      version: "9.9.9", model: "deepseek/v4", workspace: "/w", project: "w",
      projects: { shop: "/Users/me/shop" },
    });
    const broken = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(daemonInfo(state(home), { fetchImpl: broken })).resolves.toBeUndefined();
  });

  it("returns the tail of the log", () => {
    const home = tempHome();
    const paths = daemonPaths(home);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.log, ["a", "b", "c", "d"].join("\n"));
    expect(daemonLogTail(home, 2)).toBe("c\nd");
    expect(daemonLogTail(tempHome())).toBe("");
  });
});
