import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type MeshJobStatus = "queued" | "pending" | "working" | "paused" | "done" | "failed" | "cancelled";

export interface MeshJobLog {
  t: number;
  level: string;
  msg: string;
}

export interface MeshJob {
  id: string;
  source: string;
  target: string;
  kind: string;
  project_id: string;
  workspace: string;
  instruction: string;
  title: string;
  status: MeshJobStatus;
  progress: number;
  logs: MeshJobLog[];
  result: string;
  error: string;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  log_offset: number;
  lease_seconds?: number;
  lease_deadline?: number;
  runtime?: string;
  instance_id?: string;
  session_id?: string;
  resume_count?: number;
  queued_at?: number;
}

export class MeshJobStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  path(id: string): string {
    if (!/^[a-zA-Z0-9._-]+$/u.test(id)) throw new Error(`invalid job id: ${id}`);
    return join(this.directory, `${id}.json`);
  }

  async create(fields: Partial<MeshJob> & Pick<MeshJob, "source" | "target" | "instruction">): Promise<MeshJob> {
    const now = Date.now() / 1000;
    const job: MeshJob = {
      id: fields.id || `job-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      source: fields.source,
      target: fields.target,
      kind: fields.kind || "task",
      project_id: fields.project_id || "",
      workspace: fields.workspace || "",
      instruction: fields.instruction,
      title: fields.title || fields.instruction.slice(0, 60) || fields.kind || "task",
      status: fields.status || "queued",
      progress: fields.progress || 0,
      logs: fields.logs || [],
      result: fields.result || "",
      error: fields.error || "",
      created_at: fields.created_at || now,
      updated_at: fields.updated_at || now,
      done_at: fields.done_at ?? null,
      log_offset: fields.log_offset || 0,
      ...(fields.lease_seconds ? { lease_seconds: fields.lease_seconds } : {}),
      ...(fields.lease_deadline ? { lease_deadline: fields.lease_deadline } : {}),
      ...(fields.runtime ? { runtime: fields.runtime } : {}),
      ...(fields.instance_id ? { instance_id: fields.instance_id } : {}),
    };
    await this.put(job);
    return job;
  }

  async get(id: string): Promise<MeshJob | undefined> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as MeshJob;
    } catch {
      return undefined;
    }
  }

  async list(limit = 50): Promise<MeshJob[]> {
    await this.initialize();
    const entries = await readdir(this.directory);
    const rows = await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const path = join(this.directory, name);
        const [info, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
        return { mtime: info.mtimeMs, job: JSON.parse(content) as MeshJob };
      } catch {
        return undefined;
      }
    }));
    return rows.filter((row): row is { mtime: number; job: MeshJob } => Boolean(row))
      .sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((row) => row.job);
  }

  async put(job: MeshJob): Promise<void> {
    await this.serial(async () => {
      await this.atomicWrite(this.path(job.id), `${JSON.stringify(job, null, 1)}\n`);
    });
  }

  async update(id: string, fields: Partial<MeshJob>): Promise<MeshJob | undefined> {
    let updated: MeshJob | undefined;
    await this.serial(async () => {
      const job = await this.get(id);
      if (!job) return;
      updated = { ...job, ...fields, updated_at: Date.now() / 1000 };
      await this.writeUnlocked(updated);
    });
    return updated;
  }

  async log(id: string, level: string, message: string): Promise<void> {
    try {
      await this.serial(async () => {
        const job = await this.get(id);
        if (!job) return;
        job.logs = [...(job.logs || []), { t: Date.now() / 1000, level, msg: String(message).slice(0, 2000) }].slice(-1000);
        job.updated_at = Date.now() / 1000;
        await this.writeUnlocked(job);
      });
    } catch {
      // Job log lines are best-effort; a blocked write must never take down the node.
    }
  }

  async transition(id: string, expected: MeshJobStatus, fields: Partial<MeshJob>): Promise<MeshJob | undefined> {
    let updated: MeshJob | undefined;
    await this.serial(async () => {
      const job = await this.get(id);
      if (!job || job.status !== expected) return;
      updated = { ...job, ...fields, updated_at: Date.now() / 1000 };
      await this.writeUnlocked(updated);
    });
    return updated;
  }

  async finish(id: string, status: MeshJobStatus, result = "", error = ""): Promise<void> {
    await this.update(id, { status, result, error, done_at: Date.now() / 1000 });
  }

  private async writeUnlocked(job: MeshJob): Promise<void> {
    await this.atomicWrite(this.path(job.id), `${JSON.stringify(job, null, 1)}\n`);
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await this.initialize();
    const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, content, "utf8");
    try {
      await this.renameWithRetry(temporary, path);
    } catch {
      await unlink(temporary).catch(() => undefined);
      // Fall back to an in-place overwrite when the atomic rename is blocked
      // by a transient Windows file lock or real-time antivirus scan.
      await writeFile(path, content, "utf8");
    }
  }

  private async renameWithRetry(temporary: string, path: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
        if (!["EPERM", "EBUSY", "EACCES"].includes(code) || attempt >= 15) throw error;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 20 * (attempt + 1)));
      }
    }
  }

  private async serial(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.then(operation, operation);
    this.writes = next.catch(() => undefined);
    await next;
  }
}
