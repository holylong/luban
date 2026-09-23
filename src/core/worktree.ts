import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runGit(workspace: string, args: string[], signal: AbortSignal, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: workspace, env: process.env, windowsHide: true });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`git ${args[0]} timed out`));
      }
    }, timeoutMs);
    const abort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(signal.reason ?? new Error("aborted"));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code) reject(new Error(`git ${args.join(" ")} failed: ${output.slice(0, 2000)}`));
      else resolvePromise(output);
    });
  });
}

export async function isGitRepo(workspace: string, signal: AbortSignal): Promise<boolean> {
  try {
    await runGit(workspace, ["rev-parse", "--is-inside-work-tree"], signal, 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Create a detached worktree at HEAD for isolated subtasks. Caller must dispose. */
export async function createWorktree(workspace: string, signal: AbortSignal): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "luban-worktree-"));
  // mkdtemp leaves an empty dir; git worktree needs a missing path.
  await rm(dir, { recursive: true, force: true });
  await runGit(workspace, ["worktree", "add", "--detach", dir, "HEAD"], signal);
  return dir;
}

export async function worktreeDiff(worktree: string, signal: AbortSignal): Promise<string> {
  try {
    const status = await runGit(worktree, ["status", "--short"], signal);
    const diff = await runGit(worktree, ["diff", "--no-ext-diff", "--stat", "--patch", "--", "."], signal);
    return `STATUS\n${status.trim() || "(clean)"}\n\nDIFF\n${diff.trim() || "(no diff)"}`.slice(0, 60_000);
  } catch (error) {
    return `worktree diff unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Verify a worktree diff still applies cleanly onto the parent workspace. */
export async function checkDiffApplies(workspace: string, worktree: string, signal: AbortSignal): Promise<string> {
  const patch = await runGit(worktree, ["diff", "--no-ext-diff", "--patch", "--", "."], signal);
  if (!patch.trim()) return "clean: no changes to merge";
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["apply", "--check", "--whitespace=nowarn", "-"], { cwd: workspace, env: process.env, windowsHide: true });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) reject(new Error(`worktree changes conflict with workspace: ${output.slice(0, 2000) || `exit ${code}`}`));
      else resolvePromise("applies cleanly: use apply_patch or git apply to merge the worktree diff");
    });
    child.stdin.end(patch);
  });
}

export async function disposeWorktree(workspace: string, worktree: string, signal: AbortSignal): Promise<void> {
  try {
    await runGit(workspace, ["worktree", "remove", "--force", worktree], signal);
  } catch {
    await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
    await runGit(workspace, ["worktree", "prune"], signal).catch(() => undefined);
  }
}

async function readOptional(root: string, file: string): Promise<string> {
  try {
    return await readFile(join(root, file), "utf8");
  } catch {
    return "";
  }
}

function applyPatch(workspace: string, patch: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", "-"], { cwd: workspace, env: process.env, windowsHide: true });
    const abort = () => {
      child.kill("SIGTERM");
      resolvePromise(false);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => {
      signal.removeEventListener("abort", abort);
      resolvePromise(false);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      resolvePromise(code === 0);
    });
    child.stdin.end(patch);
  });
}

/** Auto-merge a worktree back into its parent workspace.
 * Clean files apply with `git apply`; conflicting files are preserved as
 * `.luban/conflicts/<path>.parent` / `.worktree` copies and reported.
 * Never commits. */
export async function autoMergeWorktree(workspace: string, worktree: string, signal: AbortSignal): Promise<string> {
  const patch = await runGit(worktree, ["diff", "--no-ext-diff", "--patch", "--", "."], signal);
  if (!patch.trim()) return "merge: worktree is clean, nothing to apply";
  const changed = (await runGit(worktree, ["diff", "--no-ext-diff", "--name-only", "--", "."], signal))
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const applied: string[] = [];
  const conflicted: string[] = [];
  // git diff omits untracked files; merge those by copy with the same policy.
  const untracked = (await runGit(worktree, ["status", "--porcelain", "--", "."], signal))
    .split("\n").map((line) => line.trim()).filter((line) => line.startsWith("??"))
    .map((line) => line.slice(2).trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const { dirname } = await import("node:path");
  for (const file of untracked) {
    signal.throwIfAborted();
    if (file.includes("/")) await mkdir(join(workspace, dirname(file)), { recursive: true });
    const [parentContent, worktreeContent] = await Promise.all([
      readOptional(workspace, file),
      readOptional(worktree, file),
    ]);
    if (!parentContent) {
      await writeFile(join(workspace, file), worktreeContent);
      applied.push(`${file} (new)`);
      continue;
    }
    if (parentContent === worktreeContent) {
      applied.push(`${file} (identical)`);
      continue;
    }
    conflicted.push(file);
    const conflictsDir = join(workspace, ".luban", "conflicts");
    await mkdir(conflictsDir, { recursive: true });
    const safe = file.replace(/[/\\]/g, "__");
    await writeFile(join(conflictsDir, `${safe}.parent`), parentContent);
    await writeFile(join(conflictsDir, `${safe}.worktree`), worktreeContent);
  }
  for (const file of changed) {
    signal.throwIfAborted();
    const filePatch = await runGit(worktree, ["diff", "--no-ext-diff", "--patch", "--", file], signal);
    if (filePatch.trim() && await applyPatch(workspace, filePatch, signal)) {
      applied.push(file);
      continue;
    }
    conflicted.push(file);
    const conflictsDir = join(workspace, ".luban", "conflicts");
    await mkdir(conflictsDir, { recursive: true });
    const safe = file.replace(/[/\\]/g, "__");
    const [parentContent, worktreeContent] = await Promise.all([
      readOptional(workspace, file),
      readOptional(worktree, file),
    ]);
    await writeFile(join(conflictsDir, `${safe}.parent`), parentContent);
    await writeFile(join(conflictsDir, `${safe}.worktree`), worktreeContent);
  }
  const summary = [`merge: ${applied.length} applied, ${conflicted.length} conflicted`];
  if (applied.length) summary.push(`applied: ${applied.join(", ")}`);
  if (conflicted.length) summary.push(`conflicts saved under .luban/conflicts/ (*.parent = workspace, *.worktree = subtask): ${conflicted.join(", ")}`);
  return summary.join("\n");
}
