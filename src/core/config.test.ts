import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, savePermissionMode, stripJsonComments } from "./config.js";

const originalHome = process.env.LUBAN_HOME;
const originalUserHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.LUBAN_HOME;
  else process.env.LUBAN_HOME = originalHome;
  if (originalUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalUserHome;
});

describe("config", () => {
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
});
