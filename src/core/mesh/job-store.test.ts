import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MeshJobStore } from "./job-store.js";

describe("MeshJobStore", () => {
  it("persists Python-compatible job records and logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luban-jobs-"));
    const store = new MeshJobStore(directory);
    const job = await store.create({ id: "job-test", source: "a", target: "b", instruction: "work" });
    await Promise.all([store.log(job.id, "tool", "read"), store.log(job.id, "info", "done")]);
    await store.finish(job.id, "done", "ok");
    const saved = await store.get(job.id);
    expect(saved?.status).toBe("done");
    expect(saved?.result).toBe("ok");
    expect(saved?.logs.map((line) => line.msg)).toEqual(["read", "done"]);
  });
});
