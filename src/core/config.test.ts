import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, savePermissionMode, savePreferredModel, saveProject, saveTheme, stripJsonComments } from "./config.js";

const originalHome = process.env.LUBAN_HOME;
const originalUserHome = process.env.HOME;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalOpencodeEnv = {
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  OPENCODE_GO_API_KEY: process.env.OPENCODE_GO_API_KEY,
  OPENCODE_ZEN_API_KEY: process.env.OPENCODE_ZEN_API_KEY,
  OPENCODE_AUTH_CONTENT: process.env.OPENCODE_AUTH_CONTENT,
};

beforeEach(async () => {
  // Keep the OpenCode credential lookup from reading the developer's real
  // files: every test starts with an empty data home and no OpenCode env.
  process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "luban-xdg-"));
  // Keep the Codex model catalog deterministic; tests opt in to a cache.
  process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "luban-codex-home-"));
  delete process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_ZEN_API_KEY;
  delete process.env.OPENCODE_AUTH_CONTENT;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
  if (originalUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalUserHome;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const [name, value] of Object.entries(originalOpencodeEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("config", () => {
  it("defaults desktop permission on and trusts only global computer config", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-computer-config-"));
    const workspace = join(home, "project");
    process.env.LUBAN_HOME = home;
    await mkdir(join(workspace, ".luban"), { recursive: true });
    expect(loadConfig({ workspace }).computerEnabled).toBe(true);
    await writeFile(join(home, "config.json"), JSON.stringify({ computer: { enabled: false } }));
    await writeFile(join(workspace, ".luban", "config.json"), JSON.stringify({ computer: { enabled: true } }));
    expect(loadConfig({ workspace }).computerEnabled).toBe(false);
    await writeFile(join(home, "config.json"), JSON.stringify({ computer: { enabled: true } }));
    await writeFile(join(workspace, ".luban", "config.json"), JSON.stringify({ computer: { enabled: false } }));
    expect(loadConfig({ workspace }).computerEnabled).toBe(true);
  });
  it("defaults to unattended reconnect and supports disabling and bounding delay", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-reconnect-config-"));
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace: home })).toMatchObject({ modelReconnect: true, modelReconnectMaxDelayMs: 60_000 });
    await writeFile(join(home, "config.json"), JSON.stringify({ model: { reconnect: false, reconnect_max_delay: 10 } }));
    expect(loadConfig({ workspace: home })).toMatchObject({ modelReconnect: false, modelReconnectMaxDelayMs: 10_000 });
    await writeFile(join(home, "config.json"), JSON.stringify({ model: { reconnect_max_delay: 9999 } }));
    expect(loadConfig({ workspace: home }).modelReconnectMaxDelayMs).toBe(300_000);
  });
  it("selects a named Codex CLI model without falling back to default", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-model-"));
    process.env.LUBAN_HOME = home;
    const chosen = loadConfig({ workspace: home, model: "codex/gpt-6-sol" });
    expect(chosen.model).toMatchObject({ id: "codex/gpt-6-sol", model: "gpt-6-sol", api: "codex" });
    expect(chosen.model.capabilities.vision).toBe(true);
    expect(loadConfig({ workspace: home, model: "codex/gpt-6.1-sol" }).model.capabilities.vision).toBe(true);
    expect(chosen.models.some((model) => model.id === "codex/gpt-6-luna")).toBe(true);
    expect(loadConfig({ workspace: home, model: "codex/custom-model" }).model.model).toBe("custom-model");
    await savePreferredModel(home, "codex/gpt-6-sol");
    await savePreferredModel(home, "openai-compatible/gpt-4.1-mini");
    expect(loadConfig({ workspace: home }).models.some((model) => model.id === "codex/gpt-6-sol")).toBe(true);
  });

  it("lists the Codex models published by the CLI model cache", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-codex-cache-"));
    process.env.LUBAN_HOME = home;
    const fallback = loadConfig({ workspace: home, model: "codex/default" });
    for (const id of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-sol",
      "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(fallback.models.some((model) => model.id === `codex/${id}`)).toBe(true);
    }
    await writeFile(join(process.env.CODEX_HOME!, "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-7-visible", display_name: "GPT-7", visibility: "list", supported_in_api: true,
          priority: 1, input_modalities: ["text", "image"] },
        { slug: "gpt-7-hidden", display_name: "GPT-7 Hidden", visibility: "hide", supported_in_api: true,
          priority: 2, input_modalities: ["text"] },
        { slug: "gpt-7-text", display_name: "GPT-7 Text", visibility: "list", supported_in_api: true,
          priority: 3, input_modalities: ["text"] },
      ],
    }));
    const cached = loadConfig({ workspace: home, model: "codex/default" });
    expect(cached.models.find((model) => model.id === "codex/gpt-7-visible")?.capabilities.vision).toBe(true);
    expect(cached.models.find((model) => model.id === "codex/gpt-7-text")?.capabilities.vision).toBe(false);
    expect(cached.models.some((model) => model.id === "codex/gpt-7-hidden")).toBe(false);
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

  it("reloads per-model native efforts, migrates legacy Codex choices, and clears configured defaults", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-model-efforts-"));
    process.env.LUBAN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { native: { models: { "gpt-5": { reasoning_effort: "medium" }, "o3": {} } } },
    }));
    await writeFile(join(home, "node-preferences.json"), JSON.stringify({ codexEfforts: { "codex/gpt-6-sol": "high" } }));
    await savePreferredModel(home, "native/gpt-5", "high");
    await savePreferredModel(home, "native/o3", "low");
    expect(loadConfig({ workspace: home, model: "native/gpt-5" }).model.reasoningEffort).toBe("high");
    expect(loadConfig({ workspace: home }).model.reasoningEffort).toBe("low");
    expect(loadConfig({ workspace: home, model: "codex/gpt-6-sol" }).model.reasoningEffort).toBe("high");
    await savePreferredModel(home, "native/gpt-5", null);
    await savePreferredModel(home, "native/gpt-5");
    expect(loadConfig({ workspace: home }).model.reasoningEffort).toBeUndefined();
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
    expect(config.models.filter(item => item.provider === "local")).toHaveLength(2);
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

  it("persists a phone-registered project without dropping other config", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-project-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    await writeFile(join(home, "config.json"), JSON.stringify({ permission: { mode: "edits" }, projects: { old: "/old" } }));
    process.env.LUBAN_HOME = home;
    await saveProject(home, "picked", "/work/picked");
    const raw = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(raw.projects).toEqual({ old: "/old", picked: "/work/picked" });
    expect(raw.permission).toEqual({ mode: "edits" });
    expect(loadConfig({ workspace }).mesh.projects).toEqual({ old: "/old", picked: "/work/picked" });
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
    expect(config.model.headers).toEqual({ "x-opencode-client": "luban" });
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

  it("shares one configured OpenCode key between Go and Zen", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-shared-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({
      model: { active: "opencode-go/deepseek-v4.1-flash" },
      providers: {
        "opencode-zen": {
          base_url: "https://opencode.ai/zen/v1",
          api_key: "oc_sk_shared",
        },
      },
    }));
    const config = loadConfig({ workspace });
    // A single key in either OpenCode block serves both endpoints.
    expect(config.model.id).toBe("opencode-go/deepseek-v4.1-flash");
    expect(config.model.apiKey).toBe("oc_sk_shared");
    expect(config.models.find(item => item.id === "opencode-zen/deepseek-v4.1-flash")?.apiKey).toBe("oc_sk_shared");
    // Go's full catalog registers from the shared credential.
    expect(config.models.some(item => item.id === "opencode-go/kimi-k3")).toBe(true);
  });

  it("lets a configured Go key serve Zen too", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-shared-go-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { "opencode-go": { api_key: "sk-go-shared" } },
    }));
    const config = loadConfig({ workspace, model: "opencode-zen/deepseek-v4.1-flash" });
    expect(config.model.id).toBe("opencode-zen/deepseek-v4.1-flash");
    expect(config.model.apiKey).toBe("sk-go-shared");
    expect(config.models.find(item => item.id === "opencode-go/kimi-k3")?.apiKey).toBe("sk-go-shared");
  });

  it("merges the built-in Go catalog into an explicit provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-go-merge-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { "opencode-go": {
        api_key: "sk-go-merge",
        models: { "deepseek-v4.1-flash": { name: "My Go Flash" } },
      } },
    }));
    const config = loadConfig({ workspace, model: "opencode-go/deepseek-v4.1-flash" });
    const go = config.models.filter((item) => item.provider === "opencode-go");
    expect(go.find((item) => item.id === "opencode-go/deepseek-v4.1-flash")?.name).toBe("My Go Flash");
    expect(go.every((item) => item.apiKey === "sk-go-merge")).toBe(true);
    expect(go.some((item) => item.id === "opencode-go/kimi-k3")).toBe(true);
    expect(go.find((item) => item.id === "opencode-go/qwen3.8-flash")?.api).toBe("anthropic");
  });

  it("registers Zen credentials while keeping Go visible", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_ZEN_API_KEY = "sk-zen-test";
    const config = loadConfig({ workspace, model: "opencode-zen/deepseek-v4.1-flash" });
    expect(config.model.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(config.model.apiKey).toBe("sk-zen-test");
    expect(config.model.api).toBe("openai");
    expect(config.models.some(item => item.provider === "opencode-go")).toBe(true);
    expect(config.models.find(item => item.provider === "opencode-go")?.apiKey).toBe("");
    expect(config.models.find(item => item.id === "opencode-zen/gpt-6-luna")?.api).toBe("responses");
    expect(config.models.some(item => item.id === "opencode-zen/ling-3.1-flash-free")).toBe(true);
  });

  it("registers the Go free models with the Go endpoint and session header", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-free-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_API_KEY = "sk-go-free";
    const config = loadConfig({ workspace, model: "opencode-go/cat-jam-free" });
    expect(config.model.id).toBe("opencode-go/cat-jam-free");
    expect(config.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(config.model.headers["x-opencode-client"]).toBe("luban");
    for (const id of ["cat-jam-free", "step-5-preview-free", "longcat-2.5-preview-free",
      "beam-free", "minimax-m3.1-flash-free"]) {
      expect(config.models.some(item => item.id === `opencode-go/${id}`)).toBe(true);
    }
    // Go lists `space-bunny`; the Zen-only `space-bunny-free` is unavailable here.
    expect(config.models.some(item => item.id === "opencode-go/space-bunny")).toBe(true);
    expect(config.models.some(item => item.id === "opencode-go/space-bunny-free")).toBe(false);
  });

  it("merges the built-in Zen catalog into an explicit provider instead of hiding it", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-merge-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_ZEN_API_KEY = "sk-zen-merge";
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { "opencode-zen": {
        base_url: "https://opencode.ai/zen/v1",
        api_key_env: "OPENCODE_ZEN_API_KEY",
        models: { "deepseek-v4.1-flash": { name: "My Flash" } },
      } },
    }));
    const config = loadConfig({ workspace });
    const zen = config.models.filter((item) => item.provider === "opencode-zen");
    // The hand-written model and endpoint survive.
    expect(zen.find((item) => item.id === "opencode-zen/deepseek-v4.1-flash")?.name).toBe("My Flash");
    expect(zen.every((item) => item.baseUrl === "https://opencode.ai/zen/v1")).toBe(true);
    expect(zen.every((item) => item.apiKey === "sk-zen-merge")).toBe(true);
    // The rest of the built-in catalog is visible again.
    expect(zen.some((item) => item.id === "opencode-zen/gpt-6-luna")).toBe(true);
    expect(zen.find((item) => item.id === "opencode-zen/claude-sonnet-5")?.api).toBe("anthropic");
    expect(zen.length).toBeGreaterThan(1);
  });

  it("uses OpenCode's Console session for the Zen free models", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-console-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    const data = join(process.env.XDG_DATA_HOME!, "opencode");
    await mkdir(data, { recursive: true });
    // `opencode auth login` stores this pair; the gateway grants the free tier to
    // it and refuses an oc_sk_ key for the same models.
    await writeFile(join(data, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "console-access", refresh: "console-refresh", expires: Date.now() + 3_600_000 },
      "opencode-go": { type: "api", key: "sk-go-file" },
    }));
    const config = loadConfig({ workspace, model: "opencode-zen/ling-3.1-flash-free" });
    expect(config.model.id).toBe("opencode-zen/ling-3.1-flash-free");
    expect(config.model.apiKey).toBe("console-access");
    expect(config.models.some(item => item.id === "opencode-zen/exo-free")).toBe(true);
    expect(config.models.find(item => item.id === "opencode-zen/muse-spark-1.3-contributor-free")?.api).toBe("responses");
    // The Go key is still read for Go, untouched by the session.
    expect(config.models.find(item => item.provider === "opencode-go")?.apiKey).toBe("sk-go-file");
  });

  it("lets the Console session win over the API key sitting beside it", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-console-key-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_ZEN_API_KEY = "oc_sk_pay";
    await writeFile(join(home, "config.json"), JSON.stringify({ providers: {} }));
    const data = join(process.env.XDG_DATA_HOME!, "opencode");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "auth.json"), JSON.stringify({
      opencode: { type: "oauth", access: "console-access", refresh: "r", expires: Date.now() + 3_600_000 },
    }));
    const config = loadConfig({ workspace, model: "opencode-zen/exo-free" });
    // The free tier only answers for the session, so the explicit key is not
    // used for Zen while a signed-in Console exists.
    expect(config.model.apiKey).toBe("console-access");
  });

  it("keeps an explicit Zen model array as a full override", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-array-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { "opencode-zen": { models: ["deepseek-v4-flash"] } },
    }));
    const config = loadConfig({ workspace });
    const zen = config.models.filter((item) => item.provider === "opencode-zen");
    expect(zen.map((item) => item.id)).toEqual(["opencode-zen/deepseek-v4-flash"]);
  });

  it("keeps configured Zen free models selectable without a Console session", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-stale-free-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_ZEN_API_KEY = "oc_sk_real";
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { "opencode-zen": {
        base_url: "https://opencode.ai/zen/v1",
        models: {
          "ling-3.1-flash-free": { name: "Ling 3.1 Flash Free", api: "openai" },
          "big-pickle": { name: "Big Pickle", api: "openai" },
          "space-bunny-free": { name: "Space Bunny Free", api: "openai" },
          "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", api: "openai" },
        },
      } },
    }));
    const config = loadConfig({ workspace, model: "opencode-zen/ling-3.1-flash-free" });
    const zen = config.models.filter((item) => item.provider === "opencode-zen");
    for (const id of ["ling-3.1-flash-free", "big-pickle", "space-bunny-free"]) {
      expect(zen.some((item) => item.model === id)).toBe(true);
    }
    expect(zen.some((item) => item.id === "opencode-zen/deepseek-v4.1-flash")).toBe(true);
    // The built-in paid catalog fills in behind the hand-written one.
    expect(zen.some((item) => item.id === "opencode-zen/gpt-6-luna")).toBe(true);
    expect(config.model.id).toBe("opencode-zen/ling-3.1-flash-free");
    expect(config.model.apiKey).toBe("oc_sk_real");
  });

  it("shows the entire Zen free catalog without credentials and preserves explicit selection", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-visible-"));
    process.env.LUBAN_HOME = home;
    const config = loadConfig({ workspace: home, model: "opencode-zen/space-bunny-free" });
    const zen = config.models.filter((item) => item.provider === "opencode-zen");
    for (const id of ["big-pickle", "space-bunny-free", "longcat-2.5-preview-free", "exo-free",
      "fledge-alpha-free", "mimo-v2.6-flash-free", "mimo-v2.5-free", "ling-3.1-flash-free",
      "ling-3.0-flash-fin-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free",
      "muse-spark-1.3-contributor-free", "deepseek-v4.1-flash-free", "glm-5.3-flash-free",
      "minimax-m3.1-flash-free", "beam-free", "nemotron-3.5-super-vl-free"]) {
      expect(zen.find((item) => item.model === id)?.apiKey).toBe("");
    }
    expect(zen.find((item) => item.model === "deepseek-v4.1-flash-free")?.capabilities.vision).toBe(true);
    expect(zen.find((item) => item.model === "minimax-m3.1-flash-free")?.api).toBe("openai");
    expect(config.model.id).toBe("opencode-zen/space-bunny-free");
    expect(zen.find((item) => item.model === "muse-spark-1.3-contributor-free")?.api).toBe("responses");
  });

  it("selects Zen from --model even when a legacy single-model config exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-select-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPENCODE_ZEN_API_KEY = "sk-zen-test";
    await writeFile(join(home, "config.json"), JSON.stringify({ model: { model: "local-default", base_url: "http://127.0.0.1:1234/v1" } }));
    const config = loadConfig({ workspace, model: "opencode-zen/gpt-6-luna" });
    expect(config.model.id).toBe("opencode-zen/gpt-6-luna");
    expect(config.model.baseUrl).toBe("https://opencode.ai/zen/v1");
  });

  it("discovers the Zen key saved by OpenCode without reusing a Go-only key", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-auth-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    const data = join(process.env.XDG_DATA_HOME!, "opencode");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "auth.json"), JSON.stringify({ opencode: { type: "api", key: "sk-zen-file" }, "opencode-go": { type: "api", key: "sk-go-file" } }));
    const config = loadConfig({ workspace });
    expect(config.models.find(item => item.provider === "opencode-zen")?.apiKey).toBe("sk-zen-file");
    expect(config.models.find(item => item.provider === "opencode-go")?.apiKey).toBe("sk-go-file");
    await writeFile(join(data, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "sk-go-file" } }));
    expect(loadConfig({ workspace }).models.find(item => item.provider === "opencode-zen")?.apiKey).toBe("");
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

  it("lists all shipped providers without credentials and preserves the legacy default", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-none-"));
    process.env.LUBAN_HOME = home;
    const config = loadConfig({ workspace: home });
    for (const provider of ["codex", "opendesign", "opencode-go", "opencode-zen", "deepseek", "dashscope", "qwen-local", "strata-local"]) {
      expect(config.models.some(item => item.provider === provider)).toBe(true);
    }
    expect(config.model.id).toBe("gpt-4.1-mini");
    expect(config.models.find(item => item.id === "codex/gpt-6.1-terra")?.api).toBe("codex");
    expect(loadConfig({ workspace: home, model: "opencode-go/gpt-6-luna" }).model.api).toBe("responses");
    expect(loadConfig({ workspace: home, model: "opencode-go/qwen3.8-flash" }).model.api).toBe("anthropic");
    await writeFile(join(home, "config.json"), JSON.stringify({ model: { model: "legacy-local", base_url: "http://localhost:1234/v1" } }));
    const legacy = loadConfig({ workspace: home });
    expect(legacy.model).toMatchObject({ id: "legacy-local", baseUrl: "http://localhost:1234/v1" });
    expect(legacy.models.some(item => item.provider === "codex")).toBe(true);
    expect(legacy.models.some(item => item.provider === "opencode-go")).toBe(true);
    expect(loadConfig({ workspace: home, model: "codex/default" }).model.api).toBe("codex");
  });

  it("lists Zen models without a key but keeps the default model and does not borrow an OpenAI key", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opencode-zen-unconnected-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    const oldOpenAI = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-not-zen";
    try {
      const config = loadConfig({ workspace });
      expect(config.model.id).toBe("gpt-4.1-mini");
      expect(config.models.some(item => item.id === "opencode-zen/gpt-6-luna")).toBe(true);
      expect(config.models.find(item => item.provider === "opencode-zen")?.apiKey).toBe("");
      for (const provider of ["opencode-go", "opendesign", "codex", "dashscope", "qwen-local", "strata-local"]) {
        expect(config.models.find(item => item.provider === provider)?.apiKey).not.toBe("sk-openai-not-zen");
      }
    } finally {
      if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAI;
    }
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
    expect(config.models.filter(item => item.provider === "opencode-go").map((item) => item.model)).toEqual(["custom"]);
    expect(config.models[0]?.baseUrl).toBe("https://example.test/v1");
  });

  it("registers the Open Design gateway without shipping a credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opendesign-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    const config = loadConfig({ workspace, model: "opendesign/deepseek-v4.1-flash" });
    expect(config.model).toMatchObject({
      id: "opendesign/deepseek-v4.1-flash",
      baseUrl: "https://amr-link.open-design.ai/v1",
      api: "openai",
      apiKey: "",
    });
    // The source carries no key; the environment supplies it.
    process.env.OPEN_DESIGN_API_KEY = "sk-design-env";
    try {
      expect(loadConfig({ workspace, model: "opendesign/deepseek-v4.1-flash" }).model.apiKey).toBe("sk-design-env");
    } finally {
      delete process.env.OPEN_DESIGN_API_KEY;
    }
    expect(config.model.capabilities).toMatchObject({ vision: true, tools: true });
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "claude-haiku-5.5", "glm-5.3-flash",
      "gpt-6-luna", "kimi-k2.7-code", "minimax-m3.1-flash"]) {
      expect(config.models.some(item => item.id === `opendesign/${id}`)).toBe(true);
    }
    // Claude rides the Anthropic Messages API that Claude Code speaks; the rest
    // keep Chat Completions.
    expect(config.models.find(item => item.id === "opendesign/claude-haiku-5.5")?.api).toBe("anthropic");
    expect(config.models.filter(item => item.provider === "opendesign" && item.model !== "claude-haiku-5.5")
      .every(item => item.api === "openai")).toBe(true);
    // The gateway rejects an explicit temperature for GPT reasoning models.
    expect(config.models.find(item => item.id === "opendesign/gpt-6-luna")?.capabilities.temperature).toBe(false);
    expect(config.models.find(item => item.id === "opendesign/deepseek-v4-pro")?.capabilities.vision).toBe(false);
  });

  it("lets the environment or an explicit block override the Open Design key", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opendesign-override-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.OPEN_DESIGN_API_KEY = "sk-env-design";
    try {
      expect(loadConfig({ workspace, model: "opendesign/deepseek-v4.1-flash" }).model.apiKey).toBe("sk-env-design");
      await writeFile(join(home, "config.json"), JSON.stringify({
        providers: { opendesign: {
          base_url: "https://gateway.example.test/v1",
          api_key: "sk-own-design",
          models: ["deepseek-v4.1-flash"],
        } },
      }));
      const custom = loadConfig({ workspace, model: "opendesign/deepseek-v4.1-flash" });
      expect(custom.model.apiKey).toBe("sk-own-design");
      expect(custom.model.baseUrl).toBe("https://gateway.example.test/v1");
    } finally {
      delete process.env.OPEN_DESIGN_API_KEY;
    }
  });

  it("routes an Open Design model through the Responses API without hiding the catalog", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-opendesign-responses-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    await writeFile(join(home, "config.json"), JSON.stringify({
      providers: { opendesign: {
        base_url: "https://amr-link.open-design.ai/v1",
        models: { "gpt-6-luna": { name: "GPT-6 Luna", api: "responses" } },
      } },
    }));
    const config = loadConfig({ workspace, model: "opendesign/gpt-6-luna" });
    expect(config.model).toMatchObject({
      id: "opendesign/gpt-6-luna",
      baseUrl: "https://amr-link.open-design.ai/v1",
      api: "responses",
    });
    expect(config.model.capabilities.responses).toBe(true);
    // One per-model override keeps the rest of the built-in gateway catalog.
    expect(config.models.some(item => item.id === "opendesign/deepseek-v4.1-flash")).toBe(true);
    expect(config.models.find(item => item.id === "opendesign/deepseek-v4.1-flash")?.api).toBe("openai");
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

  // The decision engine is a config switch: the original chat model by default,
  // or the local Jev/Kev advisor once the user opts in.
  it("defaults the decision engine to the model and honours kev.mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-kev-mode-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;

    // No kev block at all: unchanged behaviour, no tool, no prompt rule.
    expect(loadConfig({ workspace }).kev).toMatchObject({ mode: "model", url: "", model: "kev-latest" });

    await writeFile(join(home, "config.json"), JSON.stringify({
      kev: { mode: "kev", url: "http://127.0.0.1:8008", timeout_seconds: 30 },
    }));
    expect(loadConfig({ workspace }).kev).toMatchObject({
      mode: "kev", url: "http://127.0.0.1:8008", model: "kev-latest", timeoutSeconds: 30,
    });

    // "kev" with no URL cannot do anything, so it degrades to the model engine.
    await writeFile(join(home, "config.json"), JSON.stringify({ kev: { mode: "kev" } }));
    expect(loadConfig({ workspace }).kev.mode).toBe("model");

    // An explicit "model" wins even when a server is configured.
    await writeFile(join(home, "config.json"), JSON.stringify({
      kev: { mode: "model", url: "http://127.0.0.1:8008" },
    }));
    expect(loadConfig({ workspace }).kev.mode).toBe("model");

    // The env var can flip the switch without editing the config file, and
    // "jev" is accepted as the friendlier spelling of the same engine.
    await writeFile(join(home, "config.json"), JSON.stringify({ kev: { url: "http://127.0.0.1:8008" } }));
    process.env.LUBAN_KEV_MODE = "jev";
    try {
      expect(loadConfig({ workspace }).kev.mode).toBe("kev");
    } finally {
      delete process.env.LUBAN_KEV_MODE;
    }
    // An unrecognised value is not a crash: it degrades to the model engine.
    await writeFile(join(home, "config.json"), JSON.stringify({ kev: { mode: "nonsense", url: "http://127.0.0.1:8008" } }));
    expect(loadConfig({ workspace }).kev.mode).toBe("model");
  });
});

describe("usage statistics settings", () => {
  it("accepts a fractional interval and defaults to 15 minutes", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-usage-config-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    expect(loadConfig({ workspace }).usageStats.intervalHours).toBe(0.25);

    await writeFile(join(home, "config.json"), JSON.stringify({ usage_stats: { interval_hours: 0.5, url: "http://example.test/api/report" } }));
    const configured = loadConfig({ workspace }).usageStats;
    expect(configured.intervalHours).toBe(0.5);
    expect(configured.url).toBe("http://example.test/api/report");

    // Anything below a minute would just be a request storm.
    await writeFile(join(home, "config.json"), JSON.stringify({ usage_stats: { interval_hours: 0.0001 } }));
    expect(loadConfig({ workspace }).usageStats.intervalHours).toBeCloseTo(1 / 60, 6);
  });

  it("can be switched off from the environment", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-usage-off-"));
    const workspace = join(home, "project");
    await mkdir(workspace);
    process.env.LUBAN_HOME = home;
    process.env.LUBAN_USAGE_STATS = "off";
    try {
      expect(loadConfig({ workspace }).usageStats.enabled).toBe(false);
    } finally {
      delete process.env.LUBAN_USAGE_STATS;
    }
    expect(loadConfig({ workspace }).usageStats.enabled).toBe(true);
  });
});
