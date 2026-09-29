import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, savePermissionMode, savePreferredModel, saveTheme, stripJsonComments } from "./config.js";

const originalHome = process.env.LUBAN_HOME;
const originalUserHome = process.env.HOME;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalOpencodeEnv = {
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY,
  OPENCODE_AUTH_CONTENT: process.env.OPENCODE_AUTH_CONTENT,
};

beforeEach(async () => {
  // Keep the OpenCode credential lookup from reading the developer's real
  // files: every test starts with an empty data home and no OpenCode env.
  process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "luban-xdg-"));
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_AUTH_CONTENT;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
  if (originalUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalUserHome;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  for (const [name, value] of Object.entries(originalOpencodeEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("config", () => {
  it("selects a named Codex CLI model without falling back to default", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-model-"));
    process.env.LUBAN_HOME = home;
    const chosen = loadConfig({ workspace: home, model: "codex/gpt-6-sol" });
    expect(chosen.model).toMatchObject({ id: "codex/gpt-6-sol", model: "gpt-6-sol", api: "codex" });
    expect(chosen.models.some((model) => model.id === "codex/gpt-6-luna")).toBe(true);
    expect(loadConfig({ workspace: home, model: "codex/custom-model" }).model.model).toBe("custom-model");
    await savePreferredModel(home, "codex/gpt-6-sol");
    await savePreferredModel(home, "openai-compatible/gpt-4.1-mini");
    expect(loadConfig({ workspace: home }).models.some((model) => model.id === "codex/gpt-6-sol")).toBe(true);
  });

  it("keeps Codex reasoning effort per model and permits the CLI default", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-effort-"));
    process.env.LUBAN_HOME = home;
    await savePreferredModel(home, "codex/gpt-6-sol", "high");
    await savePreferredModel(home, "codex/gpt-6-luna", "low");
    expect(loadConfig({ workspace: home, model: "codex/gpt-6-sol" }).model.reasoningEffort).toBe("high");
    expect(loadConfig({ workspace: home }).model.reasoningEffort).toBe("low");
    await savePreferredModel(home, "codex/gpt-6-sol", null);
    expect(loadConfig({ workspace: home, model: "codex/gpt-6-sol" }).model.reasoningEffort).toBeUndefined();
  });

  it("uses the output budget supported by the default Qwen service", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-default-config-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).maxTokens).toBe(64_000);
  });

  it("strips JSON comments without damaging URLs", () => {
    const parsed = JSON.parse(stripJsonComments('{"url":"http://localhost/v1",/* x */"n":1// y\n}'));
    expect(parsed).toEqual({ url: "http://localhost/v1", n: 1 });
  });

  it("loads the Python luban provider format", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-config-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    await writeFile(join(home, "config.json"), JSON.stringify({
      model: { active: "local/coder", max_tokens: 1234 },
      providers: {
        local: {
          options: { baseURL: "http://127.0.0.1:9999/v1", apiKey: "sk-test" },
          models: { coder: { name: "Coder" }, chat: { name: "Chat" } },
        },
      },
      node: { name: "linux-a", host: "0.0.0.0", port: 8123, udp_port: 8124, capabilities: ["agent", "linux"] },
      contacts: [{ name: "win-b", host: "192.168.1.30", port: 9000, udp_port: 9001, note: "test" }],
      mesh: { token: "shared-secret" },
      sync: { mode: "chunk", chunk_size: 4096, conflict_policy: "both", ignore: [".git", "node_modules"] },
      projects: { demo: "/srv/demo" },
      max_workers: 3,
      permission: { allow: ["bash:git *"], deny: ["bash:rm -rf *"] },
      mcpServers: { demo: { command: "node", args: ["server.js"], env: { TOKEN: "test" }, trusted: true } },
    }));
    process.env.LUBAN_HOME = home;
    const config = loadConfig({ workspace });
    expect(config.model.id).toBe("local/coder");
    expect(config.model.baseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(config.model.apiKey).toBe("sk-test");
    expect(config.model.api).toBe("openai");
    expect(config.models).toHaveLength(2);
    expect(config.maxTokens).toBe(1234);
    expect(config.mesh).toMatchObject({
      enabled: true,
      nodeName: "linux-a",
      host: "0.0.0.0",
      port: 8123,
      udpPort: 8124,
      token: "shared-secret",
      syncMode: "chunk",
      chunkSize: 4096,
      conflictPolicy: "both",
      maxWorkers: 3,
    });
    expect(config.mesh.contacts[0]).toMatchObject({ name: "win-b", host: "192.168.1.30", port: 9000, udpPort: 9001 });
    expect(config.mesh.projects).toEqual({ demo: "/srv/demo" });
    expect(config.permissions).toEqual({ allow: ["bash:git *"], deny: ["bash:rm -rf *"] });
    expect(config.mcpServers.demo).toMatchObject({ command: "node", args: ["server.js"], env: { TOKEN: "test" }, enabled: true, trusted: true });
  });

  it("loads and persists the permission mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-perm-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    await writeFile(join(home, "config.json"), JSON.stringify({ permission: { mode: "edits", allow: [] } }));
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).permissionMode).toBe("edits");
    await savePermissionMode(home, "allow");
    expect(loadConfig({ workspace }).permissionMode).toBe("allow");
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).permission).toEqual({ allow: [], mode: "allow" });
    await savePermissionMode(home, "ask");
    process.env.LUBAN_ALLOW_TOOLS = "1";
    expect(loadConfig({ workspace }).permissionMode).toBe("allow");
    delete process.env.LUBAN_ALLOW_TOOLS;
    expect(loadConfig({ workspace }).permissionMode).toBe("ask");
  });

  it("resolves the terminal theme from flags, config, and the last choice", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-theme-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    await writeFile(join(home, "config.json"), JSON.stringify({ theme: "Nord" }));
    process.env.LUBAN_HOME = home;
    // The config file names a scheme; the flag and the environment override it.
    expect(loadConfig({ workspace }).theme).toBe("nord");
    expect(loadConfig({ workspace, theme: "Tokyo-Night" }).theme).toBe("tokyo-night");
    process.env.LUBAN_THEME = "gruvbox";
    expect(loadConfig({ workspace }).theme).toBe("gruvbox");
    delete process.env.LUBAN_THEME;
    // A `/theme` choice is remembered, and outranks the static config file.
    await saveTheme(home, "Dracula");
    expect(loadConfig({ workspace }).theme).toBe("dracula");
    // An unreadable value is passed through for the UI to resolve, not crashed on.
    await writeFile(join(home, "config.json"), JSON.stringify({ theme: "neon-disco" }));
    expect(loadConfig({ workspace }).theme).toBe("dracula");
    expect(loadConfig({ workspace: join(home, "empty"), theme: "neon-disco" }).theme).toBe("neon-disco");
  });

  it("reads per-key palette overrides from the theme object", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-theme-colors-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    await writeFile(join(home, "config.json"), JSON.stringify({
      theme: { id: "nord", colors: { accent: "#ff00ff", dim: "#123456", bogus: "#000000", blank: "  " } },
    }));
    process.env.LUBAN_HOME = home;
    const config = loadConfig({ workspace });
    expect(config.theme).toBe("nord");
    // Core keeps any string pair; the palette module is what rejects keys that
    // are not real colors, so a typo cannot silently blank the UI.
    expect(config.themeColors).toEqual({ accent: "#ff00ff", dim: "#123456", bogus: "#000000" });
    // A plain string theme has no overrides of its own.
    await writeFile(join(home, "config.json"), JSON.stringify({ theme: "nord" }));
    expect(loadConfig({ workspace }).themeColors).toEqual({});
  });

  it("saves the theme without forgetting the preferred model", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-theme-save-"));
    await savePreferredModel(home, "local/coder");
    await saveTheme(home, "catppuccin");
    expect(JSON.parse(await readFile(join(home, "node-preferences.json"), "utf8")))
      .toEqual({ model: "local/coder", theme: "catppuccin" });
    // Picking a model next does not drop the theme either.
    await savePreferredModel(home, "local/chat");
    expect(JSON.parse(await readFile(join(home, "node-preferences.json"), "utf8")))
      .toEqual({ model: "local/chat", theme: "catppuccin" });
  });

  it("moves a legacy ~/.dagent directory into ~/.luban on first run", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "luban-layout-migrate-"));
    const legacy = join(fakeHome, ".dagent");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "history.txt"), "old prompt\n");
    await writeFile(join(legacy, "config.json"), JSON.stringify({ max_steps: 7 }));
    process.env.HOME = fakeHome;
    delete process.env.LUBAN_HOME;
    const config = loadConfig({ workspace: join(fakeHome, "project") });
    expect(config.home).toBe(join(fakeHome, ".luban"));
    expect(await readFile(join(fakeHome, ".luban", "history.txt"), "utf8")).toBe("old prompt\n");
    expect(config.maxSteps).toBe(7);
    expect(existsSync(legacy)).toBe(false);
  });

  it("never overwrites an existing ~/.luban and leaves the legacy directory alone", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "luban-layout-keep-"));
    await mkdir(join(fakeHome, ".luban"), { recursive: true });
    await writeFile(join(fakeHome, ".luban", "history.txt"), "new\n");
    await mkdir(join(fakeHome, ".dagent"), { recursive: true });
    await writeFile(join(fakeHome, ".dagent", "history.txt"), "old\n");
    process.env.HOME = fakeHome;
    delete process.env.LUBAN_HOME;
    const config = loadConfig({ workspace: join(fakeHome, "project") });
    expect(config.home).toBe(join(fakeHome, ".luban"));
    expect(await readFile(join(fakeHome, ".luban", "history.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(fakeHome, ".dagent", "history.txt"))).toBe(true);
  });

  it("reads a project's pre-rename .dagent/config.json when .luban is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-project-legacy-"));
    const workspace = join(home, "project");
    await mkdir(join(workspace, ".dagent"), { recursive: true });
    await writeFile(join(workspace, ".dagent", "config.json"), JSON.stringify({ max_steps: 11 }));
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).maxSteps).toBe(11);
  });

  it("prefers .luban/config.json when a project has both directories", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-project-both-"));
    const workspace = join(home, "project");
    await mkdir(join(workspace, ".luban"), { recursive: true });
    await mkdir(join(workspace, ".dagent"), { recursive: true });
    await writeFile(join(workspace, ".luban", "config.json"), JSON.stringify({ max_steps: 3 }));
    await writeFile(join(workspace, ".dagent", "config.json"), JSON.stringify({ max_steps: 11 }));
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).maxSteps).toBe(3);
  });

  it("clamps an invalid step budget to a safe range", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-step-config-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    await writeFile(join(home, "config.json"), JSON.stringify({ max_steps: -4 }));
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).maxSteps).toBe(1);
    await writeFile(join(home, "config.json"), JSON.stringify({ max_steps: 99999 }));
    expect(loadConfig({ workspace }).maxSteps).toBe(2000);
  });

  it("auto-registers the OpenCode Go subscription from the environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-go-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_API_KEY = "sk-go-test";
    const config = loadConfig({ workspace });
    expect(config.model.id).toBe("opencode-go/kimi-k3");
    expect(config.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(config.model.apiKey).toBe("sk-go-test");
    expect(config.model.api).toBe("openai");
    expect(config.model.headers).toEqual({ "x-opencode-session": "luban" });
    // Each model is routed to the protocol the gateway expects.
    expect(config.models.find((item) => item.id === "opencode-go/qwen3.8-flash")?.api).toBe("anthropic");
    const luna = config.models.find((item) => item.id === "opencode-go/gpt-6-luna");
    expect(luna?.api).toBe("responses");
    // GPT reasoning models reject an explicit temperature.
    expect(luna?.capabilities.temperature).toBe(false);
  });

  it("discovers the OpenCode Go key from OpenCode's auth file", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-auth-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    const data = join(process.env.XDG_DATA_HOME!, "opencode");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "sk-file-test" } }));
    const model = loadConfig({ workspace }).models.find((item) => item.provider === "opencode-go");
    expect(model?.apiKey).toBe("sk-file-test");
  });

  it("adds OpenCode Go alongside configured providers without changing the default", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-alongside-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_API_KEY = "sk-go-test";
    await writeFile(join(home, "config.json"), JSON.stringify({
      model: { active: "local/coder" },
      providers: { local: { options: { baseURL: "http://127.0.0.1:9999/v1", apiKey: "sk" }, models: { coder: {} } } },
    }));
    const config = loadConfig({ workspace });
    expect(config.model.id).toBe("local/coder");
    expect(config.models.some((item) => item.provider === "opencode-go")).toBe(true);
  });

  it("does not register OpenCode Go without a credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-none-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).models.some((item) => item.provider === "opencode-go")).toBe(false);
  });

  it("lets a user provider override the built-in OpenCode Go definition", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-override-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_API_KEY = "sk-go-test";
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { "opencode-go": { base_url: "https://example.test/v1", models: ["custom"] } },
    }));
    const config = loadConfig({ workspace });
    expect(config.models.map((item) => item.model)).toEqual(["custom"]);
    expect(config.models[0]?.baseUrl).toBe("https://example.test/v1");
  });

  // The mirror writes a database, so an existing install must not start
  // writing one until the user asks for it.
  it("keeps the queryable history mirror off unless enabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-history-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).history).toEqual({ enabled: false, directory: "", maxMessagesPerSession: 0 });

    await writeFile(join(home, "config.json"), JSON.stringify({
      history: { enabled: true, directory: join(home, "archive"), max_messages_per_session: 200 },
    }));
    expect(loadConfig({ workspace }).history).toEqual({ enabled: true, directory: join(home, "archive"), maxMessagesPerSession: 200 });
  });
});
