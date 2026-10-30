import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createWorkspace, MAX_FILE_BYTES } = createRequire(import.meta.url)("../../apps/desktop/workspace.cjs");
type CommandEvent = { id: string; kind: "output" | "exit"; text: string };
let root: string;
let service: ReturnType<typeof createWorkspace>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "luban-workspace-test-"));
  service = createWorkspace(root);
});
afterEach(() => { service.dispose(); rmSync(root, { recursive: true, force: true }); });
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for command");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const nodeCommand = (script: string) => `"${process.execPath}" -e ${process.platform === "win32" ? `"${script.replaceAll('"', '\\"')}"` : `'${script.replaceAll("'", "'\\''")}'`}`;

describe("desktop workspace security", () => {
  it("reads and saves text with hash revisions and rejects stale saves", () => {
    writeFileSync(join(root, "hello.txt"), "hello 🌍\n");
    const original = service.readFile("hello.txt");
    expect(original).toMatchObject({ path: "hello.txt", content: "hello 🌍\n" });
    expect(original.revision).toMatch(/^[a-f0-9]{64}$/);
    const saved = service.saveFile({ ...original, content: "new" });
    expect(saved.revision).not.toBe(original.revision);
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("new");
    expect(() => service.saveFile({ ...original, content: "stale" })).toThrow(/conflict/i);
    writeFileSync(join(root, "hello.txt"), "external edit");
    expect(() => service.saveFile({ ...saved, content: "overwrite" })).toThrow(/conflict/i);
    expect(service.readFile("hello.txt").content).toBe("external edit");
  });
  it("rejects absolute paths, traversal, excluded paths, and symlink escapes", () => {
    writeFileSync(join(root, "text"), "safe");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "secret");
    symlinkSync(tmpdir(), join(root, "outside"), "dir");
    symlinkSync(join(root, "text"), join(root, "link"));
    for (const value of [join(root, "text"), "../text", "a/../text", "a\\text", "C:/text", ".git/config", "outside/anything", "link"]) {
      expect(() => service.readFile(value)).toThrow();
      expect(() => service.saveFile({ path: value, content: "unsafe", revision: "x" })).toThrow();
    }
    expect(readFileSync(join(root, "text"), "utf8")).toBe("safe");
  });
  it("rejects binary, invalid UTF-8, oversized files and invalid save content", () => {
    for (const [name, buffer] of [["binary", Buffer.from([0, 1])], ["invalid", Buffer.from([0xff])], ["large", Buffer.alloc(MAX_FILE_BYTES + 1, 65)]] as const) {
      writeFileSync(join(root, name), buffer);
      expect(() => service.readFile(name)).toThrow();
    }
    writeFileSync(join(root, "text"), "safe");
    const original = service.readFile("text");
    for (const content of ["\0", "\ud800", "x".repeat(MAX_FILE_BYTES + 1)]) {
      expect(() => service.saveFile({ ...original, content })).toThrow();
    }
    expect(service.readFile("text").content).toBe("safe");
  });
  it("lists bounded relative files without excluded directories or symlinks", () => {
    for (const directory of ["src", ".git", "node_modules", "dist"]) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "file"), "text");
    }
    symlinkSync(join(root, "src"), join(root, "linked"), "dir");
    expect(service.listFiles()).toEqual(["src/file"]);
  });
  it("revokes all operations when disposed", () => {
    service.dispose();
    expect(() => service.listFiles()).toThrow(/closed/);
    expect(() => service.runCommand("echo no")).toThrow(/closed/);
  });
});

describe("desktop command lifecycle", () => {
  it("runs in the workspace, streams output and emits exit", async () => {
    const events: CommandEvent[] = [];
    service.dispose();
    service = createWorkspace(root, (event: CommandEvent) => events.push(event));
    const { id } = service.runCommand(nodeCommand("console.log(process.cwd())"));
    await waitFor(() => events.some(event => event.id === id && event.kind === "exit"));
    expect(events.filter(event => event.kind === "output").map(event => event.text).join("")).toContain(root);
  });
  it("limits concurrency and stops the process group", async () => {
    const events: CommandEvent[] = [];
    service.dispose();
    service = createWorkspace(root, (event: CommandEvent) => events.push(event), { maxCommands: 1 });
    const { id } = service.runCommand(nodeCommand("console.log('ready'); setInterval(() => {}, 1000)"));
    expect(() => service.runCommand("echo too-many")).toThrow(/concurrent/);
    await waitFor(() => events.some(event => event.kind === "output"));
    service.stopCommand(id);
    await waitFor(() => events.some(event => event.id === id && event.kind === "exit"));
  });
  it("bounds output and terminates overflowing commands", async () => {
    const events: CommandEvent[] = [];
    service.dispose();
    service = createWorkspace(root, (event: CommandEvent) => events.push(event), { maxOutputBytes: 100 });
    service.runCommand(nodeCommand("setInterval(() => console.log('x'.repeat(1000)), 5)"));
    await waitFor(() => events.some(event => event.kind === "exit"));
    expect(events.filter(event => event.kind === "output").reduce((sum, event) => sum + Buffer.byteLength(event.text), 0)).toBeLessThanOrEqual(100);
  });
  it("kills commands on dispose and suppresses events to a new workspace", async () => {
    const events: CommandEvent[] = [];
    service.dispose();
    service = createWorkspace(root, (event: CommandEvent) => events.push(event));
    service.runCommand(nodeCommand("console.log('ready'); setTimeout(() => console.log('late'), 400)"));
    await waitFor(() => events.length > 0);
    service.dispose();
    const count = events.length;
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(events).toHaveLength(count);
  });
});
