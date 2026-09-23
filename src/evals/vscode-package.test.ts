import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "editors", "vscode");

function nodeCheck(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--check", file], (error) => (error ? reject(error) : resolve()));
  });
}

describe("vscode extension package", () => {
  it("declares ACP commands and parses", async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const commands = manifest.contributes.commands.map((item: { command: string }) => item.command);
    expect(commands).toEqual(expect.arrayContaining(["luban.ask", "luban.sendSelection", "luban.sendFile", "luban.cancel"]));
    expect(manifest.main).toBe("./extension.js");
    await nodeCheck(join(ROOT, "extension.js"));
  });

  it("speaks the same ACP methods the server implements", async () => {
    const source = await readFile(join(ROOT, "extension.js"), "utf8");
    for (const method of ["initialize", "session/new", "session/prompt", "session/cancel", "session/update"]) {
      expect(source).toContain(method);
    }
  });
});
