import { mkdir, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** Only remove the dead owner's exact marker; never recursively delete a lock. */
async function reap(lock: string): Promise<void> {
  try {
    const names = await readdir(lock);
    if (!names.length) {
      if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rmdir(lock);
      return;
    }
    if (names.length !== 1) return;
    const owner = names[0]!;
    const match = /^(\d+)-[a-f0-9-]+$/u.exec(owner);
    if (!match) return;
    try { process.kill(Number(match[1]), 0); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
    }
    // A competing reaper that already removed this marker owns the cleanup.
    await unlink(join(lock, owner));
    await rmdir(lock);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Serialize compare-and-replace across TUI, SSH and daemon processes. */
export async function withSessionLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const owner = join(lock, `${process.pid}-${randomUUID()}`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reap(lock);
      if (Date.now() >= deadline) throw new Error("会话正在由另一进程保存，请稍后重试。");
      await delay(20);
    }
  }
  try {
    await writeFile(owner, "", { flag: "wx", mode: 0o600 });
    return await action();
  } finally {
    await unlink(owner).catch(error => { if (!missing(error)) throw error; });
    await rmdir(lock).catch(error => { if (!missing(error)) throw error; });
  }
}
