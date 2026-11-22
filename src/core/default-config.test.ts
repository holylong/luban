import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { STARTER_CONFIG, ensureStarterConfig, starterConfigSource } from "./default-config.js";
import { DEFAULT_RELAY_URL } from "./service-defaults.js";

let root: string;
let home: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "luban-starter-"));
  home = join(root, "home");
  workspace = join(root, "workspace");
  await mkdir(workspace);
  vi.stubEnv("LUBAN_HOME", home);
  vi.stubEnv("HOME", join(root, "user-home"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  for (const name of ["OPENAI_API_KEY", "OPENCODE_API_KEY", "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_AUTH_CONTENT"]) {
    vi.stubEnv(name, "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("starter configuration", () => {
  it("creates a private config exactly once and never overwrites user edits", async () => {
    expect(ensureStarterConfig(home)).toBe("created");
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(starterConfigSource());
    if (process.platform !== "win32") {
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, "config.json"))).mode & 0o777).toBe(0o600);
    }
    await writeFile(join(home, "config.json"), "{\"model\":{\"active\":\"custom/model\"}}\n");
    expect(ensureStarterConfig(home)).toBe("exists");
    expect(await readFile(join(home, "config.json"), "utf8")).toBe("{\"model\":{\"active\":\"custom/model\"}}\n");
  });

  it("ships no credentials, private endpoints, peers or relay settings", async () => {
    const source = starterConfigSource();
    for (const forbidden of [
      "api_key", "apiKey", "OPEN_DESIGN_API_KEY", "OPENCODE_ZEN_API_KEY",
      "sk-", // max_tokens is a budget, not a credential; empty maps contain no private data.
    ]) expect(source).not.toContain(forbidden);
    // Only wildcard or loopback literals may appear: every other dotted quad
    // would point at somebody's server.
    for (const quad of source.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu) ?? []) {
      expect(["0.0.0.0", "127.0.0.1"]).toContain(quad);
    }
    const secretKeys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (/api_?key|(?:^|_)token(?:$|_)|secret|password|cookie/i.test(key)) secretKeys.push(key);
        walk(entry);
      }
    };
    walk(STARTER_CONFIG);
    expect(secretKeys).toEqual([]);
    expect(JSON.parse(source)).toMatchObject({ permission: { mode: "edits" } });
  });

  it("applies the starter settings and a credential-free free model on first run", async () => {
    const config = loadConfig({ workspace, seedDefaults: true });
    expect(config.model).toMatchObject({
      id: "opencode-zen/deepseek-v4.1-flash-free",
      provider: "opencode-zen",
      apiKey: "",
    });
    expect(config.sandbox).toMatchObject({ mode: "soft", allowOutsideWorkspace: true });
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toMatchObject({
      sandbox: { mode: "soft", allow_outside_workspace: true },
    });
    expect(config.permissionMode).toBe("edits");
    expect(config.temperature).toBe(0.2);
    expect(config.mesh.maxWorkers).toBe(12);
    expect(config.maxSteps).toBe(1000);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(starterConfigSource());
  });

  it("loads portable additions without configuring private services or platform capabilities", async () => {
    for (const name of ["LUBAN_KEV_MODE", "LUBAN_KEV_URL", "LUBAN_RELAY_PUBLIC_URL"]) vi.stubEnv(name, "");
    const config = loadConfig({ workspace, seedDefaults: true });
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(raw.model.max_tokens).toBe(128000);
    expect(config.maxTokens).toBe(128000);
    expect(raw.remote).toEqual({ enabled: false, host: "127.0.0.1", port: 0 });
    // The seeded file stays free of private services; only the resolved value
    // falls back to the shipped tunnel address.
    expect(config.remote).toMatchObject({ enabled: false, host: "127.0.0.1", port: 0, relayUrl: DEFAULT_RELAY_URL });
    expect(raw.kev).toEqual({ mode: "model", url: "", timeout_seconds: 120 });
    expect(config.kev).toMatchObject({ mode: "model", url: "", timeoutSeconds: 120 });
    expect(raw.contacts).toEqual([]);
    expect(raw.projects).toEqual({});
    expect(config.mesh.contacts).toEqual([]);
    expect(config.mesh.projects).toEqual({});
    expect(raw.node).not.toHaveProperty("capabilities");
    expect(config.mesh.capabilities).toContain(process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux");
    for (const key of ["providers", "web", "mcp", "mcpServers", "workspace", "token"]) expect(raw).not.toHaveProperty(key);
  });

  it("keeps an existing configuration and its preferences untouched", async () => {
    await mkdir(home);
    const existing = JSON.stringify({ model: { active: "deepseek/deepseek-flash" }, max_steps: 42 });
    await writeFile(join(home, "config.json"), existing);
    const config = loadConfig({ workspace, seedDefaults: true });
    expect(config.model.id).toBe("deepseek/deepseek-flash");
    expect(config.maxSteps).toBe(42);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(existing);
  });

  it("preserves an existing explicit outside-workspace restriction", async () => {
    await mkdir(home);
    const existing = JSON.stringify({ sandbox: { mode: "soft", allow_outside_workspace: false } });
    await writeFile(join(home, "config.json"), existing);
    const config = loadConfig({ workspace, seedDefaults: true });
    expect(config.sandbox.allowOutsideWorkspace).toBe(false);
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(existing);
  });

  it("leaves the home untouched for library and test callers", async () => {
    const config = loadConfig({ workspace });
    expect(config.model.id).toBe("gpt-4.1-mini");
    await expect(stat(join(home, "config.json"))).rejects.toThrow();
  });

  it("returns failed instead of throwing when the home cannot be written", async () => {
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    expect(ensureStarterConfig(blocked)).toBe("failed");
  });
});
