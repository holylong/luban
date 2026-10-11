import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { resolveInside } from "./paths.js";
import { terminateProcessTree } from "./process-tree.js";
import { editPreview } from "./edit-preview.js";

function runGit(workspace: string, args: string[], signal: AbortSignal, timeoutMs = 30_000, input = ""): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["--no-pager", ...args], { cwd: workspace, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolvePromise(Buffer.concat(stdout).toString("utf8"));
    };
    const abort = () => { terminateProcessTree(child); finish(signal.reason ?? new Error("aborted")); };
    const timer = setTimeout(() => { terminateProcessTree(child); finish(new Error(`git ${args[0]} timed out`)); }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    const capture = (sink: Buffer[], chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        terminateProcessTree(child);
        finish(new Error("git output exceeds 32 MB; worktree must be preserved"));
      } else sink.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", finish);
    child.on("close", (code, killedBy) => finish(code !== 0 || killedBy
      ? new Error(`git ${args[0]} failed (${killedBy ?? code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`)
      : undefined));
    child.stdin.on("error", error => { if (input) finish(error); });
    child.stdin.end(input);
    if (signal.aborted) abort();
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
  try {
    await runGit(workspace, ["worktree", "add", "--detach", dir, "HEAD"], signal);
  } catch (error) {
    // Only remove an empty failed allocation. A partially populated worktree
    // stays available for recovery, and is identified in the error.
    await rmdir(dir).catch(() => undefined);
    throw new Error(`Could not create worktree at ${dir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return dir;
}

export async function worktreeDiff(worktree: string, signal: AbortSignal): Promise<string> {
  try {
    const status = await runGit(worktree, ["status", "--short"], signal);
    const diff = await runGit(worktree, ["diff", "--no-ext-diff", "--binary", "--stat", "HEAD", "--", "."], signal);
    return `STATUS\n${status.trim() || "(clean)"}\n\nDIFF\n${diff.trim() || "(no diff)"}`.slice(0, 60_000);
  } catch (error) {
    return `worktree diff unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Verify a worktree diff still applies cleanly onto the parent workspace. */
export async function checkDiffApplies(workspace: string, worktree: string, signal: AbortSignal): Promise<string> {
  const patch = await runGit(worktree, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", "."], signal);
  const untracked = (await runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], signal)).split("\0").filter(Boolean);
  if (!patch.trim() && !untracked.length) return "clean: no changes to merge";
  if (patch.trim()) await runGit(workspace, ["apply", "--check", "--whitespace=nowarn", "-"], signal, 30_000, patch);
  for (const file of untracked) {
    const [parent, child] = await Promise.all([readOptional(workspace, file), readOptional(worktree, file)]);
    if (parent && !parent.equals(child ?? Buffer.alloc(0))) throw new Error(`new worktree file conflicts with workspace: ${file}`);
  }
  return `applies cleanly: tracked changes can use git apply; ${untracked.length} untracked file(s) remain in the worktree and require copying separately`;
}

export async function disposeWorktree(workspace: string, worktree: string, signal: AbortSignal): Promise<void> {
  const target = resolve(worktree);
  const temporaryName = relative(resolve(tmpdir()), target);
  if (!/^luban-worktree-[^/\\]+$/u.test(temporaryName)) throw new Error(`refusing to remove a worktree not created by luban: ${worktree}`);
  try {
    await runGit(workspace, ["worktree", "remove", "--force", target], signal);
  } catch {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    await runGit(workspace, ["worktree", "prune"], signal).catch(() => undefined);
  }
}

async function readOptional(root: string, file: string): Promise<Buffer | undefined> {
  try {
    const path = await resolveInside(root, file);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`merge requires a regular file: ${file}`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function applyPatch(workspace: string, patch: string, signal: AbortSignal): Promise<boolean> {
  try {
    await runGit(workspace, ["apply", "--whitespace=nowarn", "-"], signal, 30_000, patch);
    return true;
  } catch (error) {
    signal.throwIfAborted();
    // Only an actual patch conflict is recoverable. Missing git, timeouts and
    // IO errors must retain the entire worktree rather than claiming a merge.
    if (error instanceof Error && /git apply failed \(1\)/u.test(error.message)) return false;
    throw error;
  }
}

/** Auto-merge a worktree back into its parent workspace.
 * Clean files apply with `git apply`; conflicting files are preserved as
 * `.luban/conflicts/<path>.parent` / `.worktree` copies and reported.
 * Never commits. */
export async function autoMergeWorktree(workspace: string, worktree: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const changed = (await runGit(worktree, ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--", "."], signal)).split("\0").filter(Boolean);
  const applied: string[] = [];
  const conflicted: string[] = [];
  const previews: string[] = [];
  const untracked = (await runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], signal)).split("\0").filter(Boolean);
  const record = (file: string, before?: Buffer, after?: Buffer) => {
    if (before?.includes(0) || after?.includes(0)) previews.push(`Changed binary file ${file} (${before?.length ?? 0} → ${after?.length ?? 0} bytes)`);
    else previews.push(editPreview(file, before?.toString("utf8") ?? "", after?.toString("utf8") ?? ""));
  };
  const saveConflict = async (file: string, parent?: Buffer, child?: Buffer) => {
    conflicted.push(file);
    const safe = /^[\w.-]{1,80}$/u.test(file) ? file : `${basename(file).replace(/[^\w.-]/gu, "_").slice(0, 60)}-${createHash("sha256").update(file).digest("hex").slice(0, 16)}`;
    for (const [suffix, content] of [["parent", parent], ["worktree", child]] as const) {
      const path = await resolveInside(workspace, join(".luban", "conflicts", `${safe}.${suffix}`));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content ?? Buffer.alloc(0));
    }
  };
  for (const file of untracked) {
    signal.throwIfAborted();
    const [parentContent, worktreeContent] = await Promise.all([
      readOptional(workspace, file),
      readOptional(worktree, file),
    ]);
    if (worktreeContent === undefined) throw new Error(`worktree file disappeared during merge: ${file}`);
    if (parentContent === undefined) {
      const target = await resolveInside(workspace, file);
      await mkdir(dirname(target), { recursive: true });
      const info = await lstat(await resolveInside(worktree, file));
      await writeFile(target, worktreeContent, { flag: "wx", mode: info.mode & 0o777 });
      applied.push(`${file} (new)`);
      record(file, undefined, worktreeContent);
      continue;
    }
    if (parentContent.equals(worktreeContent)) {
      applied.push(`${file} (identical)`);
      continue;
    }
    await saveConflict(file, parentContent, worktreeContent);
  }
  for (const file of changed) {
    signal.throwIfAborted();
    const [parentContent, worktreeContent] = await Promise.all([readOptional(workspace, file), readOptional(worktree, file)]);
    const filePatch = await runGit(worktree, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", file], signal);
    if (filePatch.trim() && await applyPatch(workspace, filePatch, signal)) {
      applied.push(file);
      record(file, parentContent, await readOptional(workspace, file));
      continue;
    }
    await saveConflict(file, parentContent, worktreeContent);
  }
  const summary = [`merge: ${applied.length} applied, ${conflicted.length} conflicted`];
  if (applied.length) summary.push(`applied: ${applied.join(", ")}`);
  if (conflicted.length) summary.push(`conflicts saved under .luban/conflicts/ (*.parent = workspace, *.worktree = subtask): ${conflicted.join(", ")}`);
  return [...summary, ...previews].join("\n\n");
}
