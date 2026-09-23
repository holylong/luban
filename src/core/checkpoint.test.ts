import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CheckpointStore } from "./checkpoint.js";
import type { LubanConfig } from "./types.js";

const exec = promisify(execFile);

describe("CheckpointStore", () => {
  it("restores tracked changes and untracked files without changing HEAD", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "luban-checkpoint-work-"));
    const home = await mkdtemp(join(tmpdir(), "luban-checkpoint-home-"));
    await exec("git", ["init", "-q"], { cwd: workspace });
    await exec("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    await exec("git", ["config", "user.name", "Test"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "base\n");
    await exec("git", ["add", "tracked.txt"], { cwd: workspace });
    await exec("git", ["commit", "-qm", "base"], { cwd: workspace });
    await writeFile(join(workspace, "tracked.txt"), "checkpoint\n");
    await mkdir(join(workspace, "new"));
    await writeFile(join(workspace, "new", "file.txt"), "saved\n");
    const store = new CheckpointStore({ home, workspace, project: "test" } as LubanConfig);
    const id = await store.create();
    const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim();
    await writeFile(join(workspace, "tracked.txt"), "later\n");
    await writeFile(join(workspace, "new", "file.txt"), "later-new\n");
    await writeFile(join(workspace, "extra.txt"), "remove me\n");
    await store.restore(id);
    expect(await readFile(join(workspace, "tracked.txt"), "utf8")).toBe("checkpoint\n");
    expect(await readFile(join(workspace, "new", "file.txt"), "utf8")).toBe("saved\n");
    await expect(readFile(join(workspace, "extra.txt"), "utf8")).rejects.toThrow();
    expect((await exec("git", ["rev-parse", "HEAD"], { cwd: workspace })).stdout.trim()).toBe(headBefore);
  });
});
