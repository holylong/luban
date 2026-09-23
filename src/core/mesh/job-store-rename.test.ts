import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeshJobStore } from "./job-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  let renameFailures = 0;
  let writeFailures = 0;
  function errnoError(code: string, syscall: string): NodeJS.ErrnoException {
    const error = new Error(`${code}: operation not permitted, ${syscall} (simulated)`) as NodeJS.ErrnoException;
    error.code = code;
    error.syscall = syscall;
    return error;
  }
  return {
    ...actual,
    __failRenameNext: (count: number) => { renameFailures = count; },
    __failWriteNext: (count: number) => { writeFailures = count; },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameFailures > 0) {
        renameFailures -= 1;
        throw errnoError("EPERM", "rename");
      }
      return actual.rename(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (writeFailures > 0) {
        writeFailures -= 1;
        throw errnoError("EPERM", "writeFile");
      }
      return actual.writeFile(...args);
    },
  };
});

import * as fsPromises from "node:fs/promises";
const fsControl = fsPromises as unknown as { __failRenameNext: (count: number) => void; __failWriteNext: (count: number) => void };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "luban-jobstore-"));
});

afterEach(async () => {
  fsControl.__failRenameNext(0);
  fsControl.__failWriteNext(0);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
});

describe("MeshJobStore under Windows-style file locks", () => {
  it("retries a transient EPERM rename before persisting the job", async () => {
    fsControl.__failRenameNext(2);
    const store = new MeshJobStore(join(root, "jobs"));
    const job = await store.create({ source: "alpha", target: "beta", instruction: "retry the rename" });
    expect((await store.get(job.id))?.instruction).toBe("retry the rename");
    expect((await store.get(job.id))?.status).toBe("queued");
  });

  it("falls back to a direct write when the rename stays blocked", async () => {
    fsControl.__failRenameNext(999);
    const store = new MeshJobStore(join(root, "jobs"));
    const job = await store.create({ source: "alpha", target: "beta", instruction: "direct write" });
    expect((await store.get(job.id))?.instruction).toBe("direct write");
    const updated = await store.update(job.id, { status: "working" });
    expect(updated?.status).toBe("working");
  }, 10_000);

  it("never rejects from log when every write is blocked", async () => {
    const store = new MeshJobStore(join(root, "jobs"));
    const job = await store.create({ source: "alpha", target: "beta", instruction: "log storm" });
    fsControl.__failRenameNext(999);
    fsControl.__failWriteNext(999);
    await expect(store.log(job.id, "info", "this must not crash the node")).resolves.toBeUndefined();
    await expect(store.log(job.id, "error", "neither does this")).resolves.toBeUndefined();
  }, 10_000);
});
