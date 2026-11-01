import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMcpSettings,
  describeMcpFlags,
  describeMcpTransport,
  findMcpServer,
  mcpServerEntries,
  patchMcpServer,
  removeMcpServer,
  upsertMcpServer,
} from "./mcp-settings.js";

/** A throwaway home + workspace pair, plus the two config files. */
async function fixture(globalConfig?: unknown, projectConfig?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "luban-mcp-settings-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(join(workspace, ".luban"), { recursive: true });
  const globalPath = join(home, "config.json");
  const projectPath = join(workspace, ".luban", "config.json");
  if (globalConfig) await writeFile(globalPath, JSON.stringify(globalConfig, null, 2));
  if (projectConfig) await writeFile(projectPath, JSON.stringify(projectConfig, null, 2));
  return { paths: { home, workspace }, globalPath, projectPath };
}

type Saved = { mcp?: { servers?: Record<string, SavedServer>; max_tools?: number }; mcpServers?: Record<string, SavedServer>; mcp_servers?: Record<string, SavedServer>; theme?: string };
type SavedServer = { command?: string; url?: string; trusted?: boolean; enabled?: boolean; disabled?: boolean; trust?: boolean };
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as Saved;

describe("mcp settings", () => {
  it("adds a stdio server to the block the file already uses", async () => {
    const { paths, globalPath } = await fixture({ mcp: { servers: { existing: { command: "node" } } } });
    const target = await upsertMcpServer(paths, "global", "extra", { command: "npx", args: ["-y", "pkg"], trusted: true });
    expect(target.key).toBe("mcp.servers");
    expect(target.path).toBe(globalPath);
    const saved = await readJson(globalPath);
    // The neighbouring settings of the `mcp` block survive the write.
    expect(Object.keys(saved.mcp!)).toEqual(["servers"]);
    expect(saved.mcp!.servers!.extra).toEqual({ command: "npx", args: ["-y", "pkg"], env: {}, headers: {}, enabled: true, trusted: true });
    expect(saved.mcpServers).toBeUndefined();
  });

  it("honours the mcp_servers spelling and the http transport", async () => {
    const { paths, globalPath } = await fixture({ mcp_servers: {} });
    await upsertMcpServer(paths, "global", "remote", { url: "https://tools.example.com/mcp", headers: { Authorization: "Bearer x" } });
    const saved = await readJson(globalPath);
    expect(saved.mcp_servers!.remote.url).toBe("https://tools.example.com/mcp");
    expect(saved.mcpServers).toBeUndefined();
    const entry = findMcpServer(paths, "remote")!;
    expect(entry.transport).toBe("http");
    expect(describeMcpTransport(entry)).toBe("https://tools.example.com/mcp");
    expect(describeMcpFlags(entry)).toContain("需批准后调用");
  });

  it("rejects an entry with neither command nor url, and unusable names", async () => {
    const { paths } = await fixture();
    await expect(upsertMcpServer(paths, "global", "empty", {})).rejects.toThrow(/command .* or a url/u);
    await expect(upsertMcpServer(paths, "global", "both", { command: "node", url: "https://x.test/mcp" })).rejects.toThrow(/not both/u);
    await expect(upsertMcpServer(paths, "global", "bad name", { command: "node" })).rejects.toThrow(/invalid MCP server name/u);
    expect(() => buildMcpSettings({ url: "ftp://x.test" })).toThrow(/invalid MCP server url/u);
  });

  it("lists project entries over global ones and writes the flag where the entry lives", async () => {
    const { paths, projectPath, globalPath } = await fixture(
      { mcpServers: { shared: { command: "global-cmd", trusted: true } } },
      { mcpServers: { shared: { command: "project-cmd" } } },
    );
    const entries = mcpServerEntries(paths);
    expect(entries.map((entry) => [entry.name, entry.command, entry.scope])).toEqual([["shared", "project-cmd", "project"]]);
    const target = await patchMcpServer(paths, "shared", { trusted: true });
    expect(target.scope).toBe("project");
    expect((await readJson(projectPath)).mcpServers!.shared).toMatchObject({ command: "project-cmd", trusted: true });
    // The shadowed global copy is left untouched.
    expect((await readJson(globalPath)).mcpServers!.shared.trusted).toBe(true);
  });

  it("switches a disabled/trust alias over to the explicit flag", async () => {
    const { paths, globalPath } = await fixture({ mcpServers: { legacy: { command: "node", disabled: true, trust: true } } });
    expect(findMcpServer(paths, "legacy")).toMatchObject({ enabled: false, trusted: true });
    await patchMcpServer(paths, "legacy", { enabled: true, trusted: false });
    const saved = await readJson(globalPath);
    expect(saved.mcpServers!.legacy).toMatchObject({ enabled: true, trusted: false });
    expect(saved.mcpServers!.legacy.disabled).toBeUndefined();
    expect(saved.mcpServers!.legacy.trust).toBeUndefined();
  });

  it("removes a server and keeps the rest of the file intact", async () => {
    const { paths, globalPath } = await fixture({
      mcp: { max_tools: 12, servers: { keep: { command: "node" }, drop: { command: "node" } } },
      theme: "nord",
    });
    await removeMcpServer(paths, "drop");
    const saved = await readJson(globalPath);
    expect(Object.keys(saved.mcp!.servers!)).toEqual(["keep"]);
    expect(saved.mcp!.max_tools).toBe(12);
    expect(saved.theme).toBe("nord");
    expect(mcpServerEntries(paths).map((entry) => entry.name)).toEqual(["keep"]);
  });

  it("reports an unknown name instead of creating a file", async () => {
    const { paths, globalPath } = await fixture();
    await expect(patchMcpServer(paths, "nope", { enabled: true })).rejects.toThrow(/unknown MCP server/u);
    await expect(removeMcpServer(paths, "nope")).rejects.toThrow(/unknown MCP server/u);
    expect(existsSync(globalPath)).toBe(false);
  });
});
