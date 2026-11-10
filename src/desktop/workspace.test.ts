import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
describe("desktop workspace file actions", () => {
  it("creates an empty file and a folder inside the workspace", () => {
    mkdirSync(join(root, "src"));
    expect(service.createEntry({ path: "src/new.ts", kind: "file" })).toEqual({ path: "src/new.ts", kind: "file" });
    expect(readFileSync(join(root, "src/new.ts"), "utf8")).toBe("");
    expect(service.createEntry({ path: "docs", kind: "dir" })).toEqual({ path: "docs", kind: "dir" });
    expect(statSync(join(root, "docs")).isDirectory()).toBe(true);
  });
  it("refuses names that already exist, escape the workspace or are reserved", () => {
    writeFileSync(join(root, "taken.txt"), "x");
    expect(() => service.createEntry({ path: "taken.txt", kind: "file" })).toThrow(/already exists/);
    expect(() => service.createEntry({ path: "../escape.txt", kind: "file" })).toThrow(/Invalid workspace path/);
    expect(() => service.createEntry({ path: "node_modules", kind: "dir" })).toThrow(/Invalid workspace path/);
    expect(() => service.createEntry({ path: "missing/deep.txt", kind: "file" })).toThrow();
  });
  it("renames in place and keeps the contents", () => {
    writeFileSync(join(root, "old.md"), "# 标题");
    expect(service.renameEntry({ from: "old.md", to: "new.md" })).toEqual({ from: "old.md", to: "new.md" });
    expect(readFileSync(join(root, "new.md"), "utf8")).toBe("# 标题");
    expect(existsSync(join(root, "old.md"))).toBe(false);
  });
  it("refuses a rename onto an existing name or into another folder", () => {
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    mkdirSync(join(root, "sub"));
    expect(() => service.renameEntry({ from: "a.txt", to: "b.txt" })).toThrow(/already exists/);
    expect(() => service.renameEntry({ from: "a.txt", to: "sub/a.txt" })).toThrow(/same folder/);
  });
});

const waitFor = async (predicate: () => boolean, timeout = 5000) => {
  const deadline = Date.now() + timeout;
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
  it("reports the size limit in MB and names UTF-16 instead of binary", () => {
    writeFileSync(join(root, "huge.txt"), Buffer.alloc(MAX_FILE_BYTES + 1, 65));
    expect(() => service.readFile("huge.txt")).toThrow("File exceeds 4 MB limit");
    writeFileSync(join(root, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]));
    expect(() => service.readFile("utf16.txt")).toThrow(/UTF-16/);
  });
  it("exposes only media files, streamed without the text limit", () => {
    writeFileSync(join(root, "clip.mp4"), Buffer.from([0, 0, 0, 24]));
    writeFileSync(join(root, "notes.txt"), "text");
    writeFileSync(join(root, "larger.mp3"), Buffer.alloc(MAX_FILE_BYTES + 1, 1));
    expect(service.mediaFile("clip.mp4")).toMatchObject({ path: "clip.mp4", size: 4, type: "video/mp4" });
    expect(service.mediaFile("larger.mp3").type).toBe("audio/mpeg");
    expect(() => service.mediaFile("notes.txt")).toThrow(/media/i);
    expect(() => service.mediaFile("../clip.mp4")).toThrow();
    expect(() => service.mediaFile(".git/clip.mp4")).toThrow();
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

describe("desktop workspace terminal", () => {
  it("keeps one pty shell per workspace and streams its bytes", async () => {
    const events: CommandEvent[] = [];
    service.dispose();
    const terminalService = createWorkspace(root, (event: CommandEvent) => events.push(event));
    try {
      const started = terminalService.startTerminal({ cols: 88, rows: 24 });
      expect(started.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(started.cols).toBe(88);
      expect(started.rows).toBe(24);
      expect(() => terminalService.startTerminal({ cols: 80, rows: 20 })).toThrow(/already running/u);
      if (!started.pty) return; // No python3 or script on this host: the shell degrades.
      await waitFor(() => events.some(event => event.id === started.id && event.kind === "output"), 15000);
      terminalService.writeTerminal({ id: started.id, data: "echo LUBAN_TERM_OK\n" });
      await waitFor(() => events.map(event => event.text).join("").includes("LUBAN_TERM_OK"), 15000);
      // The panel can grow after the shell starts; the pty must follow it.
      const resized = terminalService.resizeTerminal({ id: started.id, cols: 100, rows: 40 });
      expect(resized.resized).toBe(true);
      terminalService.writeTerminal({ id: started.id, data: "stty size\n" });
      await waitFor(() => /40 100/u.test(events.map(event => event.text).join("")), 15000);
      expect(() => terminalService.resizeTerminal({ id: started.id, cols: 0, rows: 0 })).not.toThrow();
      expect(() => terminalService.resizeTerminal({ id: "missing", cols: 80, rows: 20 })).toThrow(/not running/u);
      terminalService.stopTerminal(started.id);
      await waitFor(() => events.some(event => event.id === started.id && event.kind === "exit"), 15000);
      expect(() => terminalService.writeTerminal({ id: started.id, data: "x" })).toThrow(/not running/u);
    } finally { terminalService.dispose(); }
  });
  it("rejects malformed terminal input", () => {
    service.dispose();
    service = createWorkspace(root);
    const started = service.startTerminal({ cols: 90, rows: 20 });
    expect(() => service.writeTerminal({ id: started.id, data: 42 as unknown as string })).toThrow(/Invalid terminal input/u);
    expect(() => service.writeTerminal({ id: "missing", data: "x" })).toThrow(/not running/u);
    service.stopTerminal(started.id);
  });
});

describe("desktop office previews", () => {
  const { zipOf, wordDocOf } = createRequire(import.meta.url)("../../scripts/test-fixtures.cjs");
  it("routes spreadsheet and document files to their parsers", () => {
    writeFileSync(join(root, "预算.xlsx"), zipOf({
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>房租</t></is></c></row></sheetData></worksheet>`,
    }));
    writeFileSync(join(root, "说明.doc"), wordDocOf("第一段\r第二段"));
    const sheet = service.readPreview("预算.xlsx");
    expect(sheet).toMatchObject({ kind: "sheet", path: "预算.xlsx" });
    expect(sheet.sheets[0].rows[0].cells[0]).toEqual({ text: "房租" });
    const word = service.readPreview("说明.doc");
    expect(word.kind).toBe("word");
    expect(word.blocks).toEqual([{ type: "paragraph", text: "第一段" }, { type: "paragraph", text: "第二段" }]);
  });

  it("reports why a document cannot be previewed", () => {
    writeFileSync(join(root, "broken.xls"), "not a workbook");
    expect(() => service.readPreview("broken.xls")).toThrow(/复合文档/);
  });
});
