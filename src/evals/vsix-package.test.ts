import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "editors", "vscode");

/** Entry names from a zip central directory without extra dependencies. */
function zipNames(data: Buffer): string[] {
  if (data.subarray(0, 2).toString("binary") !== "PK") throw new Error("not a zip archive");
  const end = data.lastIndexOf("PK\u0005\u0006");
  if (end < 0) throw new Error("zip end-of-central-directory not found");
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (data.subarray(offset, offset + 4).toString("binary") !== "PK\u0001\u0002") break;
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    names.push(data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

describe("vscode .vsix packaging", () => {
  it("builds an installable archive with manifest and bridge", async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const vsix = join(ROOT, `luban-${manifest.version}.vsix`);
    await rm(vsix, { force: true });
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, ["scripts/package-vscode.mjs"], { cwd: join(ROOT, "..", "..") }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    try {
      const names = zipNames(await readFile(vsix));
      expect(names).toEqual(expect.arrayContaining([
        "package.json", "extension.js", "README.md", "[Content_Types].xml", "extension.vsixmanifest",
      ]));
    } finally {
      await rm(vsix, { force: true });
    }
  });
});
