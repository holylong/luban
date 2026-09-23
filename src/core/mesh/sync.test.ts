import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTransfer, buildTransfer, planResponse, safeWorkspacePath, scanWorkspace } from "./sync.js";

describe("mesh workspace sync", () => {
  it("builds and applies Python-compatible chunk transfers", async () => {
    const source = await mkdtemp(join(tmpdir(), "luban-sync-source-"));
    const destination = await mkdtemp(join(tmpdir(), "luban-sync-dest-"));
    await mkdir(join(source, "src"));
    await writeFile(join(source, "src", "hello.txt"), "hello mesh\n");
    const files = await scanWorkspace(source);
    const plan = await planResponse(destination, { mode: "chunk", files });
    const transfer = await buildTransfer(plan, source, "auto", "source-node", 4);
    const result = await applyTransfer(destination, transfer);
    expect(result.applied).toEqual(["src/hello.txt"]);
    expect(await readFile(join(destination, "src", "hello.txt"), "utf8")).toBe("hello mesh\n");
  });

  it("rejects traversal and reserved metadata paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-sync-safe-"));
    await expect(safeWorkspacePath(root, "../secret")).rejects.toThrow(/escapes|invalid/u);
    await expect(safeWorkspacePath(root, ".luban/config.json")).rejects.toThrow(/reserved/u);
  });

  it("preserves ordinary ignored directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-sync-ignore-"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "hidden.js"), "x");
    await writeFile(join(root, "visible.js"), "y");
    expect(Object.keys(await scanWorkspace(root))).toEqual(["visible.js"]);
  });

  it("keeps both sides and conflict markers after concurrent edits", async () => {
    const source = await mkdtemp(join(tmpdir(), "luban-sync-conflict-source-"));
    const destination = await mkdtemp(join(tmpdir(), "luban-sync-conflict-dest-"));
    const sourceFile = join(source, "shared.txt");
    const destinationFile = join(destination, "shared.txt");
    await writeFile(sourceFile, "base from source\n");
    await writeFile(destinationFile, "older destination\n");

    let plan = await planResponse(destination, { mode: "chunk", files: await scanWorkspace(source) });
    await applyTransfer(destination, await buildTransfer(plan, source, "auto", "source-node", 16));
    await writeFile(sourceFile, "theirs changed\n");
    await writeFile(destinationFile, "ours changed\n");

    plan = await planResponse(destination, { mode: "chunk", files: await scanWorkspace(source) });
    const result = await applyTransfer(destination, await buildTransfer(plan, source, "auto", "source-node", 16));
    expect(result.conflicts).toEqual(["shared.txt"]);
    expect(await readFile(destinationFile, "utf8")).toContain("<<<<<<< ours");
    expect(await readFile(join(destination, "shared.txt.source-node.conflict"), "utf8")).toBe("ours changed\n");
  });
});
