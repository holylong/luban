import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProviderKeys, saveProviderKey } from "./provider-auth.js";
import { loadConfig } from "./config.js";

vi.mock("./opencode-console.js", () => ({ consoleAccessToken: () => "console-session" }));

let root: string;
let home: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "luban-provider-auth-"));
  home = join(root, "user-home");
  workspace = join(root, "workspace");
  await mkdir(workspace);
  vi.stubEnv("LUBAN_HOME", home);
  vi.stubEnv("CODEX_HOME", join(root, "codex"));
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("OPENCODE_AUTH_CONTENT", "{}");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("provider credentials", () => {
  it("persists custom providers outside the workspace with private permissions", async () => {
    expect(readProviderKeys(home)).toEqual({});
    await saveProviderKey(home, "custom-provider", "sk-test");
    expect(readProviderKeys(home)).toEqual({ "custom-provider": "sk-test" });
    expect(JSON.parse(await readFile(join(home, "provider-auth.json"), "utf8"))).toEqual({ "custom-provider": "sk-test" });
    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(home)).toEqual(["provider-auth.json"]);
    if (process.platform !== "win32") {
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, "provider-auth.json"))).mode & 0o777).toBe(0o600);
    }
    await saveProviderKey(home, "custom-provider", "replacement");
    expect(readProviderKeys(home)["custom-provider"]).toBe("replacement");
  });

  it.each(["", "  ", "secret\nvalue", "secret\rvalue", "secret\tvalue", "secret\u0000value", "secret\u007fvalue", "secret\u0085value", "secret\u2028value"])("rejects invalid key %j", async key => {
    await expect(saveProviderKey(home, "custom-provider", key)).rejects.toThrow("Invalid provider API key.");
    expect(readProviderKeys(home)).toEqual({});
  });

  it.each(["", "../escape", "a/b", "a\\b", "a.b", "a b", "a\n", "__proto__", "constructor", "prototype"])("rejects unsafe provider %j", async provider => {
    await expect(saveProviderKey(home, provider, "secret")).rejects.toThrow("Invalid provider name.");
  });

  it.each(["{secret-broken", "null", "[]", "{\"custom\":42}", "{\"../escape\":\"secret\"}", "{\"custom\":\"bad\\nsecret\"}"])("refuses malformed stores without overwriting or exposing contents", async source => {
    await mkdir(home);
    await writeFile(join(home, "provider-auth.json"), source);
    expect(() => readProviderKeys(home)).toThrow("Invalid provider credential file.");
    await expect(saveProviderKey(home, "custom", "replacement")).rejects.toThrow("Invalid provider credential file.");
    await expect(saveProviderKey(home, "custom", null)).rejects.toThrow("Invalid provider credential file.");
    expect(await readFile(join(home, "provider-auth.json"), "utf8")).toBe(source);
    // A failed write must not poison the per-home queue.
    await writeFile(join(home, "provider-auth.json"), "{}");
    await saveProviderKey(home, "custom", "recovered");
    expect(readProviderKeys(home)).toEqual({ custom: "recovered" });
  });

  it("serializes concurrent writes and removals without losing unrelated providers", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => saveProviderKey(home, `provider-${index}`, `key-${index}`)));
    expect(Object.keys(readProviderKeys(home))).toHaveLength(20);
    await Promise.all([saveProviderKey(home, "provider-0", "updated"), saveProviderKey(home, "provider-1", null), saveProviderKey(home, "provider-2", "first"), saveProviderKey(home, "provider-2", "last")]);
    const keys = readProviderKeys(home);
    expect(Object.keys(keys)).toHaveLength(19);
    expect(keys["provider-0"]).toBe("updated");
    expect(keys["provider-1"]).toBeUndefined();
    expect(keys["provider-2"]).toBe("last");
    expect(await readdir(home)).toEqual(["provider-auth.json"]);
  });

  it("overrides every provider model, project config, environment and Console credentials", async () => {
    await mkdir(home);
    await mkdir(join(workspace, ".luban"));
    vi.stubEnv("CUSTOM_PROVIDER_API_KEY", "environment");
    vi.stubEnv("OPENCODE_ZEN_API_KEY", "environment-zen");
    await writeFile(join(home, "config.json"), JSON.stringify({ providers: { "custom-provider": { api_key: "global", models: ["one", "two"] } } }));
    await writeFile(join(workspace, ".luban", "config.json"), JSON.stringify({ providers: { "custom-provider": { api_key: "project", models: ["one", "two"] } } }));
    await saveProviderKey(home, "custom-provider", "saved-custom");
    await saveProviderKey(home, "opencode-zen", "saved-zen");
    const config = loadConfig({ workspace, model: "custom-provider/two" });
    expect(config.model.apiKey).toBe("saved-custom");
    expect(config.models.filter(model => model.provider === "custom-provider").map(model => model.apiKey)).toEqual(["saved-custom", "saved-custom"]);
    expect(config.models.filter(model => model.provider === "opencode-zen").every(model => model.apiKey === "saved-zen")).toBe(true);
    await saveProviderKey(home, "custom-provider", null);
    await saveProviderKey(home, "opencode-zen", null);
    const restored = loadConfig({ workspace, model: "custom-provider/two" });
    expect(restored.model.apiKey).toBe("project");
    expect(restored.models.find(model => model.provider === "opencode-zen")?.apiKey).toBe("console-session");
  });

  it("overrides the single-model fallback and restores its environment key on removal", async () => {
    await mkdir(home);
    vi.stubEnv("OPENAI_API_KEY", "environment-key");
    await writeFile(join(home, "config.json"), JSON.stringify({ model: { model: "legacy-model" } }));
    await saveProviderKey(home, "openai-compatible", "saved-fallback");
    expect(loadConfig({ workspace }).model).toMatchObject({ provider: "openai-compatible", apiKey: "saved-fallback" });
    await saveProviderKey(home, "openai-compatible", null);
    expect(loadConfig({ workspace }).model.apiKey).toBe("environment-key");
  });

  it("ignores a workspace credential file", async () => {
    await mkdir(join(workspace, ".luban"));
    await writeFile(join(workspace, ".luban", "provider-auth.json"), "{broken-workspace-secret");
    expect(() => loadConfig({ workspace })).not.toThrow();
  });
});
