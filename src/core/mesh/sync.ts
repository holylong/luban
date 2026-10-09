import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { ConflictPolicy, SyncMode } from "../types.js";
import type { JsonObject } from "./protocol.js";

const runFile = promisify(execFile);
export const DEFAULT_SYNC_IGNORE = [
  ".luban", ".git", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
  ".venv", "venv", "node_modules", "target", "*.pyc", "*.pyo", ".DS_Store", "*.log",
  // `.dagent` holds cached toolchains; a wine prefix inside it links to the
  // filesystem root, and the whole cache is build output nobody wants to sync.
  ".dagent",
];

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function portableParts(input: string): string[] {
  if (!input || input.includes("\0") || isAbsolute(input) || /^[a-zA-Z]:[\\/]/u.test(input)) {
    throw new Error(`invalid workspace path: ${input}`);
  }
  const parts = input.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || [".luban", ".git"].includes(parts[0]!)) {
    throw new Error(`path escapes or is reserved: ${input}`);
  }
  return parts;
}

export async function safeWorkspacePath(root: string, input: string): Promise<string> {
  const canonicalRoot = await realpath(root).catch(async () => {
    await mkdir(root, { recursive: true });
    return realpath(root);
  });
  const parts = portableParts(input);
  const target = resolve(canonicalRoot, ...parts);
  const rel = relative(canonicalRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path escapes workspace: ${input}`);
  let probe = canonicalRoot;
  for (const part of parts) {
    probe = join(probe, part);
    try {
      if ((await lstat(probe)).isSymbolicLink()) throw new Error(`symlink is not transferable: ${input}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("symlink")) throw error;
      break;
    }
  }
  return target;
}

async function fileHash(path: string): Promise<string | undefined> {
  try {
    if (!(await stat(path)).isFile()) return undefined;
    return sha256(await readFile(path));
  } catch {
    return undefined;
  }
}

function ignoreGlobs(patterns: string[]): string[] {
  return patterns.flatMap((raw) => {
    const pattern = raw.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    if (!pattern || pattern.startsWith("!")) return [];
    if (pattern.includes("/")) return [pattern, `${pattern}/**`];
    if (/[*?\[]/u.test(pattern)) return [`**/${pattern}`];
    return [`**/${pattern}`, `**/${pattern}/**`];
  });
}

export async function scanWorkspace(root: string, ignore = DEFAULT_SYNC_IGNORE): Promise<Record<string, string>> {
  const files = await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    unique: true,
    ignore: ignoreGlobs(ignore),
  });
  const result: Record<string, string> = {};
  for (const file of files.sort()) {
    const path = await safeWorkspacePath(root, file);
    const hash = await fileHash(path);
    if (hash) result[file.replaceAll("\\", "/")] = hash;
  }
  return result;
}

interface SyncState {
  fingerprints: Record<string, string>;
}

async function loadState(root: string): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await readFile(join(root, ".luban", "sync_state.json"), "utf8")) as SyncState;
    return { fingerprints: parsed.fingerprints || {} };
  } catch {
    return { fingerprints: {} };
  }
}

async function saveState(root: string, state: SyncState): Promise<void> {
  const directory = join(root, ".luban");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "sync_state.json"), `${JSON.stringify(state, null, 1)}\n`, "utf8");
}

function basePath(root: string, hash: string): string {
  return join(root, ".luban", "base", hash);
}

async function saveBase(root: string, data: Buffer): Promise<void> {
  if (!data.length) return;
  const path = basePath(root, sha256(data));
  try { await stat(path); return; } catch { /* create below */ }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

async function getBase(root: string, hash?: string): Promise<Buffer | undefined> {
  if (!hash) return undefined;
  try { return await readFile(basePath(root, hash)); } catch { return undefined; }
}

async function git(args: string[], root: string): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  try {
    const result = await runFile("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), code: 0 };
  } catch (error) {
    const value = error as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number | string };
    return { stdout: Buffer.from(value.stdout || ""), stderr: Buffer.from(value.stderr || ""), code: Number(value.code) || 1 };
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  const result = await git(["rev-parse", "--is-inside-work-tree"], root);
  return result.code === 0 && result.stdout.toString().trim() === "true";
}

export async function gitHead(root: string): Promise<string | undefined> {
  if (!await isGitRepo(root)) return undefined;
  const result = await git(["rev-parse", "HEAD"], root);
  return result.code === 0 ? result.stdout.toString().trim() || undefined : undefined;
}

async function gitPatchBetween(base: string | undefined, root: string): Promise<string | undefined> {
  const head = await gitHead(root);
  if (!base || !head || base === head) return undefined;
  if ((await git(["merge-base", "--is-ancestor", base, head], root)).code !== 0) return undefined;
  const result = await git(["diff", "--binary", `${base}..HEAD`], root);
  return result.code === 0 && result.stdout.length ? result.stdout.toString("base64") : undefined;
}

async function gitTracked(root: string, path: string): Promise<boolean> {
  return (await git(["ls-files", "--error-unmatch", "--", path], root)).code === 0;
}

async function gitApply(root: string, patch: string): Promise<{ ok: boolean; message: string }> {
  if (!patch) return { ok: true, message: "empty patch" };
  const directory = await mkdtemp(join(tmpdir(), "luban-patch-"));
  const patchFile = join(directory, "transfer.patch");
  try {
    await writeFile(patchFile, Buffer.from(patch, "base64"));
    const result = await git(["apply", "--binary", "--3way", patchFile], root);
    return { ok: result.code === 0, message: result.code === 0 ? "applied" : result.stderr.toString("utf8").slice(0, 1500) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function resolveMode(requested: SyncMode, root: string): Promise<"git" | "chunk"> {
  if (requested === "git" || requested === "chunk") return requested;
  return await isGitRepo(root) ? "git" : "chunk";
}

export async function planResponse(
  root: string,
  request: JsonObject,
  ignore = DEFAULT_SYNC_IGNORE,
): Promise<JsonObject> {
  await mkdir(root, { recursive: true });
  const requested = String(request.mode || "auto") as SyncMode;
  const mode = await resolveMode(requested, root);
  const requestedFiles = (request.files && typeof request.files === "object" ? request.files : {}) as Record<string, string>;
  const local = await scanWorkspace(root, ignore);
  const state = await loadState(root);
  const need: string[] = [];
  const conflict: string[] = [];
  for (const [path, peerHash] of Object.entries(requestedFiles)) {
    const target = await safeWorkspacePath(root, path);
    const current = await fileHash(target);
    if (current === peerHash) {
      state.fingerprints[path] = peerHash;
      continue;
    }
    const base = state.fingerprints[path];
    if (base !== undefined && current !== base && peerHash !== base) conflict.push(path);
    need.push(path);
  }
  const deletions = Object.keys(local).filter((path) => !(path in requestedFiles) && path in state.fingerprints);
  await saveState(root, state);
  return {
    mode,
    git_ok: mode === "git" && await isGitRepo(root),
    head: await gitHead(root) || null,
    need,
    delete: deletions,
    conflict,
  };
}

export async function buildTransfer(
  plan: JsonObject,
  root: string,
  conflictPolicy: ConflictPolicy,
  nodeName: string,
  chunkSize = 65_536,
): Promise<JsonObject> {
  const mode = String(plan.mode || "chunk") as "git" | "chunk";
  const needed = Array.isArray(plan.need) ? plan.need.map(String) : [];
  let patch: string | undefined;
  let touched: string[] = [];
  if (mode === "git" && plan.git_ok) {
    patch = await gitPatchBetween(typeof plan.head === "string" ? plan.head : undefined, root);
    if (patch) {
      const tracked = await Promise.all(needed.map(async (path) => [path, await gitTracked(root, path)] as const));
      touched = tracked.filter(([, yes]) => yes).map(([path]) => path);
    }
  }
  const files: JsonObject[] = [];
  for (const path of needed) {
    if (touched.includes(path)) continue;
    let data: Buffer;
    try { data = await readFile(await safeWorkspacePath(root, path)); } catch { continue; }
    if (mode === "chunk") {
      const blocks: JsonObject[] = [];
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const block = data.subarray(offset, offset + chunkSize);
        blocks.push({ i: offset, h: sha256(block), d: block.toString("base64") });
      }
      files.push({ path, size: data.length, chunk_size: chunkSize, blocks, ...(data.length ? {} : { data_b64: "" }) });
    } else {
      files.push({ path, size: data.length, data_b64: data.toString("base64") });
    }
  }
  return {
    mode,
    patch_b64: patch || null,
    patch_touched: touched,
    files,
    delete: Array.isArray(plan.delete) ? plan.delete : [],
    conflict_list: Array.isArray(plan.conflict) ? plan.conflict : [],
    conflict_policy: conflictPolicy,
    node_name: nodeName,
  };
}

function safeNodeName(value: unknown): string {
  return String(value || "peer").replace(/[^a-zA-Z0-9._-]/gu, "_").replace(/^\.+/u, "").slice(0, 80) || "peer";
}

async function mergeThreeWay(base: Buffer, ours: Buffer, theirs: Buffer): Promise<{ clean: boolean; data: Buffer }> {
  if (base.equals(ours)) return { clean: true, data: theirs };
  if (base.equals(theirs) || ours.equals(theirs)) return { clean: true, data: ours };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(base);
    new TextDecoder("utf-8", { fatal: true }).decode(ours);
    new TextDecoder("utf-8", { fatal: true }).decode(theirs);
  } catch {
    return { clean: false, data: ours };
  }
  const directory = await mkdtemp(join(tmpdir(), "luban-merge-"));
  const baseFile = join(directory, "base");
  const oursFile = join(directory, "ours");
  const theirsFile = join(directory, "theirs");
  try {
    await Promise.all([writeFile(baseFile, base), writeFile(oursFile, ours), writeFile(theirsFile, theirs)]);
    const result = await runFile("git", ["merge-file", "-L", "ours", "-L", "base", "-L", "theirs", oursFile, baseFile, theirsFile], {
      encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
    }).then(() => ({ code: 0 })).catch((error: { code?: number }) => ({ code: Number(error.code) || 2 }));
    const data = await readFile(oursFile);
    if (result.code <= 1) return { clean: result.code === 0, data };
  } catch { /* marker fallback below */ }
  finally { await rm(directory, { recursive: true, force: true }); }
  return { clean: false, data: Buffer.concat([Buffer.from("<<<<<<< ours\n"), ours, Buffer.from("\n=======\n"), theirs, Buffer.from("\n>>>>>>> theirs\n")]) };
}

async function writeOrConflict(
  root: string,
  path: string,
  target: string,
  incoming: Buffer,
  fingerprints: Record<string, string>,
  applied: string[],
  merged: string[],
  conflicts: string[],
  policy: ConflictPolicy,
  nodeName: string,
): Promise<void> {
  let current = Buffer.alloc(0);
  let exists = false;
  try { current = await readFile(target); exists = true; } catch { /* new file */ }
  const baseHash = fingerprints[path];
  const conflict = exists && !current.equals(incoming) && baseHash !== undefined && sha256(current) !== baseHash;
  if (conflict) {
    if (policy === "dest_wins") return;
    if (policy === "auto") {
      const base = await getBase(root, baseHash);
      if (base) {
        const result = await mergeThreeWay(base, current, incoming);
        await mkdir(dirname(target), { recursive: true });
        if (result.clean) {
          await writeFile(target, result.data);
          fingerprints[path] = sha256(result.data);
          merged.push(path);
          await saveBase(root, result.data);
          return;
        }
        conflicts.push(path);
        const conflictPath = await safeWorkspacePath(root, `${path}.${safeNodeName(nodeName)}.conflict`);
        try { await stat(conflictPath); } catch {
          await mkdir(dirname(conflictPath), { recursive: true });
          await writeFile(conflictPath, current);
        }
        await writeFile(target, result.data);
        return;
      }
      conflicts.push(path);
    } else {
      conflicts.push(path);
    }
    if (policy === "both" || policy === "auto") {
      const conflictPath = await safeWorkspacePath(root, `${path}.${safeNodeName(nodeName)}.conflict`);
      try { await stat(conflictPath); } catch {
        await mkdir(dirname(conflictPath), { recursive: true });
        await writeFile(conflictPath, current);
      }
    }
  } else if (current.length) {
    await saveBase(root, current);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, incoming);
  fingerprints[path] = sha256(incoming);
  applied.push(path);
  await saveBase(root, incoming);
}

export async function applyTransfer(
  root: string,
  transfer: JsonObject,
  defaultPolicy: ConflictPolicy = "auto",
): Promise<{ applied: string[]; merged: string[]; conflicts: string[] }> {
  await mkdir(root, { recursive: true });
  const policy = String(transfer.conflict_policy || defaultPolicy) as ConflictPolicy;
  const state = await loadState(root);
  const applied: string[] = [];
  const merged: string[] = [];
  const conflicts: string[] = [];
  if (typeof transfer.patch_b64 === "string" && transfer.patch_b64) {
    const result = await gitApply(root, transfer.patch_b64);
    if (result.ok) {
      applied.push("__git_patch__");
      for (const path of Array.isArray(transfer.patch_touched) ? transfer.patch_touched.map(String) : []) {
        const hash = await fileHash(await safeWorkspacePath(root, path));
        if (hash) state.fingerprints[path] = hash;
      }
    } else conflicts.push(`git-patch: ${result.message}`);
  }
  for (const raw of Array.isArray(transfer.files) ? transfer.files : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const file = raw as JsonObject;
    const path = String(file.path || "");
    const target = await safeWorkspacePath(root, path);
    let incoming: Buffer;
    if (Array.isArray(file.blocks)) {
      const blocks: Buffer[] = [];
      let valid = true;
      for (const [index, rawBlock] of file.blocks.entries()) {
        const block = rawBlock as JsonObject;
        const data = Buffer.from(String(block.d || ""), "base64");
        if (sha256(data) !== block.h) {
          conflicts.push(`${path}:chunk-${String(block.i ?? index)}:hash-mismatch`);
          valid = false;
          break;
        }
        blocks.push(data);
      }
      if (!valid) continue;
      incoming = Buffer.concat(blocks).subarray(0, Number(file.size || 0));
    } else {
      incoming = Buffer.from(String(file.data_b64 || ""), "base64");
    }
    await writeOrConflict(root, path, target, incoming, state.fingerprints, applied, merged, conflicts, policy, String(transfer.node_name || "peer"));
  }
  for (const path of Array.isArray(transfer.delete) ? transfer.delete.map(String) : []) {
    const target = await safeWorkspacePath(root, path);
    try {
      await unlink(target);
      applied.push(path);
      delete state.fingerprints[path];
    } catch { /* already absent */ }
  }
  await saveState(root, state);
  return { applied, merged, conflicts };
}

export function syncSummary(direction: "push" | "pull", peer: string, result: { applied?: unknown; conflicts?: unknown }): string {
  const applied = Array.isArray(result.applied) ? result.applied.map(String) : [];
  const conflicts = Array.isArray(result.conflicts) ? result.conflicts.map(String) : [];
  return [
    `sync[${direction}] peer=${peer}: changed=${applied.length} conflicts=${conflicts.length}`,
    `files: ${applied.slice(0, 30).join(", ")}`,
    ...(conflicts.length ? ["conflict(s):", ...conflicts.slice(0, 50).map((item) => `  - ${item}`)] : []),
  ].join("\n");
}
