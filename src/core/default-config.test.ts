import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { STARTER_CONFIG, ensureStarterConfig, starterConfigSource } from "./default-config.js";

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
      "contacts", "projects", "relay", "token", "sk-",
      "192.168.", "10.0.", "172.16.", "39.105.", "184.32.",
    ]) expect(source).not.toContain(forbidden);
    const secretKeys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (/api_?key|token|secret|password|cookie/i.test(key)) secretKeys.push(key);
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
