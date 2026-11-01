import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMcp } from "./mcp-command.js";

async function fixture(servers: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "luban-mcp-command-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(join(workspace, ".luban"), { recursive: true });
  const configPath = join(home, "config.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2));
  return {
    paths: { home, workspace },
    configPath,
    saved: async () => JSON.parse(await readFile(configPath, "utf8")) as { mcpServers?: Record<string, { enabled?: boolean; trusted?: boolean; url?: string; args?: string[] }> },
  };
}

/** Run one subcommand with stdout/stderr captured instead of printed. */
async function run(argv: string[], paths: { home: string; workspace: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; });
  try {
    const code = await runMcp(argv, paths);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("luban mcp", () => {
  it("adds a stdio server from everything after --", async () => {
    const fx = await fixture();
    const result = await run(["add", "fs", "--trusted", "--env", "FOO=bar", "--", "npx", "-y", "pkg", "/tmp"], fx.paths);
    expect(result.code).toBe(0);
    const saved = await fx.saved();
    expect(saved.mcpServers!.fs).toMatchObject({ command: "npx", args: ["-y", "pkg", "/tmp"], trusted: true, enabled: true });
    expect((saved.mcpServers!.fs as { env: Record<string, string> }).env).toEqual({ FOO: "bar" });
  });

  it("adds an http server and lists it with its transport", async () => {
    const fx = await fixture();
    expect((await run(["add", "remote", "--url", "https://tools.example.com/mcp"], fx.paths)).code).toBe(0);
    const list = await run(["list"], fx.paths);
    expect(list.code).toBe(0);
    expect(list.out).toContain("remote");
    expect(list.out).toContain("[http · global]");
    expect(list.out).toContain("需批准后调用");
    // --json keeps the scriptable shape.
    const json = await run(["list", "--json"], fx.paths);
    expect(JSON.parse(json.out)[0]).toMatchObject({ name: "remote", transport: "http", scope: "global" });
  });

  it("flips flags, removes a server, and reports unknown names", async () => {
    const fx = await fixture({ keep: { command: "node" } });
    expect((await run(["disable", "keep"], fx.paths)).code).toBe(0);
    expect((await fx.saved()).mcpServers!.keep.enabled).toBe(false);
    expect((await run(["enable", "keep"], fx.paths)).code).toBe(0);
    expect((await fx.saved()).mcpServers!.keep.enabled).toBe(true);
    const missing = await run(["trust", "nope"], fx.paths);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("unknown MCP server");
    expect((await run(["remove", "keep"], fx.paths)).code).toBe(0);
    expect((await fx.saved()).mcpServers ?? {}).toEqual({});
  });

  it("rejects a bad url and explains a missing value", async () => {
    const fx = await fixture();
    const bad = await run(["add", "x", "--url", "ftp://nope"], fx.paths);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid MCP server url");
    const noValue = await run(["add", "x", "--url"], fx.paths);
    expect(noValue.code).toBe(1);
    expect(noValue.err).toContain("needs a value");
    const unknown = await run(["frobnicate"], fx.paths);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown command");
  });

  it("prints usage and stays side-effect free on an empty list", async () => {
    const fx = await fixture();
    const help = await run(["help"], fx.paths);
    expect(help.code).toBe(0);
    expect(help.out).toContain("luban mcp — manage MCP servers");
    const empty = await run(["list"], fx.paths);
    expect(empty.code).toBe(0);
    expect(empty.out).toContain("no MCP servers configured");
  });
});
