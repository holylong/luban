import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoMergeWorktree, createWorktree, disposeWorktree } from "./worktree.js";

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
  it("applies clean diffs and saves conflict copies", async () => {
    if (!await gitAvailable()) return;
    const root = await mkdtemp(join(tmpdir(), "luban-merge-"));
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
