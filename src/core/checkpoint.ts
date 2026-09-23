import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { LubanConfig } from "./types.js";

interface Checkpoint {
  id: string;
  createdAt: string;
  head: string;
  patch: string;
  tracked: string[];
  untracked: Array<{ path: string; data: string }>;
}

async function git(workspace: string, args: string[], input?: string): Promise<Buffer> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: workspace, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolvePromise(Buffer.concat(stdout))
      : reject(new Error(`git ${args[0]} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`)));
    child.stdin.end(input);
  });
}

function paths(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function safeProject(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "project";
}

function inside(workspace: string, name: string): string {
  const root = resolve(workspace);
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (!name || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`unsafe checkpoint path: ${name}`);
  return target;
}

export class CheckpointStore {
  private readonly root: string;

  constructor(private readonly config: LubanConfig) {
    this.root = join(config.home, "checkpoints-node", safeProject(config.project));
  }

  async create(): Promise<string> {
    const head = (await git(this.config.workspace, ["rev-parse", "HEAD"])).toString("utf8").trim();
    const patch = (await git(this.config.workspace, ["diff", "--binary", "--no-ext-diff", "HEAD"])).toString("base64");
    const tracked = paths(await git(this.config.workspace, ["diff", "--name-only", "-z", "HEAD"]));
    const untrackedNames = paths(await git(this.config.workspace, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const untracked: Checkpoint["untracked"] = [];
    let bytes = Buffer.byteLength(patch, "base64");
    for (const name of untrackedNames) {
      const path = inside(this.config.workspace, name);
      const info = await lstat(path);
      if (!info.isFile()) continue;
      bytes += info.size;
      if (bytes > 50 * 1024 * 1024) throw new Error("checkpoint exceeds the 50 MiB safety limit");
      untracked.push({ path: name, data: (await readFile(path)).toString("base64") });
    }
    const id = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
    const checkpoint: Checkpoint = { id, createdAt: new Date().toISOString(), head, patch, tracked, untracked };
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, `${id}.json`), `${JSON.stringify(checkpoint)}\n`, { flag: "wx" });
    return id;
  }

  async restore(id: string): Promise<string> {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("invalid checkpoint id");
    const checkpoint = JSON.parse(await readFile(join(this.root, `${id}.json`), "utf8")) as Checkpoint;
    const head = (await git(this.config.workspace, ["rev-parse", "HEAD"])).toString("utf8").trim();
    if (head !== checkpoint.head) throw new Error("repository HEAD changed since checkpoint; refusing automatic restore");
    const changed = paths(await git(this.config.workspace, ["diff", "--name-only", "-z", "HEAD"]));
    const currentUntracked = paths(await git(this.config.workspace, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const trackedTargets = [...new Set([...changed, ...checkpoint.tracked])];
    if (trackedTargets.length) await git(this.config.workspace, ["restore", `--source=${head}`, "--worktree", "--", ...trackedTargets]);
    for (const name of currentUntracked) await rm(inside(this.config.workspace, name), { force: true });
    const patch = Buffer.from(checkpoint.patch, "base64").toString("utf8");
    if (patch) await git(this.config.workspace, ["apply", "--whitespace=nowarn", "-"], patch);
    for (const file of checkpoint.untracked) {
      const target = inside(this.config.workspace, file.path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, Buffer.from(file.data, "base64"));
    }
    return `restored checkpoint ${id} (${trackedTargets.length} tracked, ${checkpoint.untracked.length} untracked files)`;
  }
}
