import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const exec = promisify(execFile);

export interface WorkspaceDiff {
  files: Array<{ status: string; path: string }>;
  patch: string;
  available: boolean;
}

export async function workspaceDiff(root: string): Promise<WorkspaceDiff> {
  try {
    const [{ stdout: patch }, { stdout: names }] = await Promise.all([
      exec("git", ["-C", root, "--no-pager", "diff", "--no-ext-diff", "--unified=80", "HEAD", "--", "."], { maxBuffer: 4 * 1024 * 1024 }),
      exec("git", ["-C", root, "diff", "--name-status", "HEAD", "--", "."], { maxBuffer: 512 * 1024 }),
    ]);
    return { available: true, patch, files: names.trim().split("\n").filter(Boolean).map(line => { const [status, ...path] = line.split("\t"); return { status, path: path.join("\t") }; }) };
  } catch { return { available: false, files: [], patch: "" }; }
}

export async function fileVersions(root: string, path: string): Promise<{ path: string; original: string; current: string }> {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("file path escapes workspace");
  const current = await readFile(target, "utf8");
  let original = "";
  try { ({ stdout: original } = await exec("git", ["-C", root, "show", `HEAD:${rel.split(sep).join("/")}`])); } catch { /* untracked */ }
  return { path: rel.split(sep).join("/"), original, current };
}
