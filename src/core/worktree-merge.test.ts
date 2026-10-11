import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoMergeWorktree, checkDiffApplies, createWorktree, disposeWorktree } from "./worktree.js";

const roots: string[] = [], worktrees: Array<{ root: string; path: string }> = [];
afterEach(async () => {
  for (const worktree of worktrees.splice(0)) await disposeWorktree(worktree.root, worktree.path, new AbortController().signal);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "luban-merge-regression-")); roots.push(root);
  const signal = new AbortController().signal;
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@test"]);
  await git(root, ["config", "user.name", "test"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "base.txt"), "base\n");
  await writeFile(join(root, "data.bin"), Buffer.from([0, 255, 1]));
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "init"]);
  const worktree = await createWorktree(root, signal); worktrees.push({ root, path: worktree });
  return { root, worktree, signal };
}

function git(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolve()));
  });
}

async function gitAvailable(): Promise<boolean> {
  try {
    await git(tmpdir(), ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe("worktree auto-merge", () => {
  it("merges a task containing only new files and recursively enumerates new directories", async () => {
    const { root, worktree, signal } = await fixture();
    await mkdir(join(worktree, "new", "deep"), { recursive: true });
    await writeFile(join(worktree, "new", "deep", "file.txt"), "valuable\n");
    await writeFile(join(worktree, "only-new.txt"), "new\n");
    const result = await autoMergeWorktree(root, worktree, signal);
    expect(result).toContain("2 applied, 0 conflicted");
    expect(await readFile(join(root, "new", "deep", "file.txt"), "utf8")).toBe("valuable\n");
    expect(await readFile(join(root, "only-new.txt"), "utf8")).toBe("new\n");
    expect(result).toContain("Edited new/deep/file.txt (+1 -0)");
  });
  it("preserves binary bytes in both tracked changes and new files", async () => {
    const { root, worktree, signal } = await fixture();
    const binary = Buffer.from([0, 128, 255, 3, 0, 250]);
    await writeFile(join(worktree, "data.bin"), binary);
    await writeFile(join(worktree, "new.bin"), binary);
    expect(await autoMergeWorktree(root, worktree, signal)).toContain("2 applied, 0 conflicted");
    expect(await readFile(join(root, "data.bin"))).toEqual(binary);
    expect(await readFile(join(root, "new.bin"))).toEqual(binary);
  });
  it("includes staged edits, additions and deletions in the merge", async () => {
    const { root, worktree, signal } = await fixture();
    await writeFile(join(worktree, "base.txt"), "staged change\n");
    await writeFile(join(worktree, "staged.txt"), "staged addition\n");
    await rm(join(worktree, "data.bin"));
    await git(worktree, ["add", "-A"]);
    expect(await autoMergeWorktree(root, worktree, signal)).toContain("3 applied, 0 conflicted");
    expect(await readFile(join(root, "base.txt"), "utf8")).toBe("staged change\n");
    expect(await readFile(join(root, "staged.txt"), "utf8")).toBe("staged addition\n");
    await expect(readFile(join(root, "data.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not mistake an existing empty file for a missing file", async () => {
    const { root, worktree, signal } = await fixture();
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(worktree, "empty.txt"), "child content");
    expect(await autoMergeWorktree(root, worktree, signal)).toContain("0 applied, 1 conflicted");
    expect(await readFile(join(root, "empty.txt"), "utf8")).toBe("");
    expect(await readFile(join(root, ".luban", "conflicts", "empty.txt.worktree"), "utf8")).toBe("child content");
  });
  it("handles Unicode and whitespace filenames without parsing git warnings as paths", async () => {
    const { root, worktree, signal } = await fixture();
    await git(root, ["config", "core.autocrlf", "true"]);
    await writeFile(join(worktree, "base.txt"), "changed\n");
    const file = " 中文 file .txt";
    await writeFile(join(worktree, file), "unicode\n");
    const result = await autoMergeWorktree(root, worktree, signal);
    expect(result).toContain("2 applied, 0 conflicted");
    expect(result).not.toContain("warning:");
    expect(await readFile(join(root, file), "utf8")).toBe("unicode\n");
    expect((await readdir(root)).some(file => file.includes("warning"))).toBe(false);
  });
  it("refuses a pre-cancelled merge without modifying the parent", async () => {
    const { root, worktree } = await fixture();
    await writeFile(join(worktree, "base.txt"), "should not merge\n");
    const cancelled = new AbortController(); cancelled.abort(new Error("cancelled"));
    await expect(autoMergeWorktree(root, worktree, cancelled.signal)).rejects.toThrow("cancelled");
    expect(await readFile(join(root, "base.txt"), "utf8")).toBe("base\n");
  });
  it("reports new-only worktrees accurately when checking whether they can be merged", async () => {
    const { root, worktree, signal } = await fixture();
    await writeFile(join(worktree, "new.txt"), "child\n");
    expect(await checkDiffApplies(root, worktree, signal)).toContain("1 untracked file");
    await writeFile(join(root, "new.txt"), "");
    await expect(checkDiffApplies(root, worktree, signal)).rejects.toThrow("conflicts with workspace");
  });
  it("refuses cleanup of a directory that is not an allocated worktree", async () => {
    const { root, signal } = await fixture();
    await expect(disposeWorktree(root, root, signal)).rejects.toThrow("refusing to remove");
    expect(await readFile(join(root, "base.txt"), "utf8")).toBe("base\n");
  });
  it("applies clean diffs and saves conflict copies", async () => {
    if (!await gitAvailable()) return;
    const root = await mkdtemp(join(tmpdir(), "luban-merge-"));
    roots.push(root);
    const signal = new AbortController().signal;
    await git(root, ["init", "-q"]);
    await git(root, ["config", "user.email", "test@test"]);
    await git(root, ["config", "user.name", "test"]);
    await writeFile(join(root, "a.txt"), "one\n");
    await writeFile(join(root, "b.txt"), "base\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "init"]);
    const worktree = await createWorktree(root, signal);
    try {
      // Clean change (edit + new file) merges; diverged b.txt conflicts.
      await writeFile(join(worktree, "a.txt"), "one-subtask\n");
      await writeFile(join(worktree, "c.txt"), "fresh\n");
      await writeFile(join(worktree, "b.txt"), "worktree-side\n");
      await writeFile(join(root, "b.txt"), "parent-side\n");
      const conflicted = await autoMergeWorktree(root, worktree, signal);
      expect(conflicted).toContain("2 applied, 1 conflicted");
      expect(conflicted).toContain(".luban/conflicts/");
      expect(await readFile(join(root, ".luban", "conflicts", "b.txt.parent"), "utf8")).toBe("parent-side\n");
      expect(await readFile(join(root, ".luban", "conflicts", "b.txt.worktree"), "utf8")).toBe("worktree-side\n");
      // The workspace keeps its own side on conflict.
      expect(await readFile(join(root, "b.txt"), "utf8")).toBe("parent-side\n");
    } finally {
      await disposeWorktree(root, worktree, signal).catch(() => undefined);
    }
  });
});
