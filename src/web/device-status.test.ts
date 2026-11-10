import { describe, expect, it } from "vitest";
import type { MeshRuntime } from "../core/mesh/runtime.js";
import type { LubanConfig } from "../core/types.js";
import { readDeviceStatus } from "./device-status.js";

const config = { model: { model: "deepseek-v4.1-flash" } } as unknown as LubanConfig;

function fakeMesh(jobs: unknown[], nodeName = "my-mac", instance = "inst-a") {
  return {
    config: { mesh: { nodeName } },
    instance,
    jobs: async () => jobs,
  } as unknown as MeshRuntime;
}

const job = (fields: Record<string, unknown>) => ({
  id: "job-1", source: "my-mac", target: "my-mac", kind: "task", project_id: "luban",
  workspace: "/tmp/w", instruction: "为什么失败了", title: "为什么失败了", status: "done",
  progress: 0, runtime: "nodejs", created_at: 1, updated_at: 2, logs: "", result: "", error: "",
  ...fields,
});

describe("readDeviceStatus", () => {
  it("reports only the jobs this node was asked to run", async () => {
    const status = await readDeviceStatus(config, fakeMesh([
      job({ id: "a", target: "my-mac" }),
      job({ id: "b", target: "win-testbox" }),
      job({ id: "c", target: "my-mac-30903" }),
    ]));
    expect(status.jobs.map(item => item.id)).toEqual(["a"]);
  });

  it("keeps jobs this instance claimed even when the target was renamed", async () => {
    // A node that fell back to another port renames itself, so the job's target
    // no longer matches; ownership still does.
    const status = await readDeviceStatus(config, fakeMesh([
      job({ id: "a", target: "my-mac", instance_id: "inst-a" }),
      job({ id: "b", target: "my-mac", instance_id: "inst-other" }),
    ], "my-mac-8f3d1c2a"));
    expect(status.jobs.map(item => item.id)).toEqual(["a"]);
  });

  it("caps the list and trims the instruction", async () => {
    const many = Array.from({ length: 20 }, (_, index) => job({ id: `j${index}`, instruction: `任务 ${index} ${"x".repeat(400)}` }));
    const status = await readDeviceStatus(config, fakeMesh(many));
    expect(status.jobs).toHaveLength(8);
    expect(status.jobs[0]!.instruction.length).toBeLessThanOrEqual(240);
    expect(status.jobs[0]!.instruction.endsWith("…")).toBe(true);
  });

  it("still answers without a runtime", async () => {
    const status = await readDeviceStatus(config, undefined);
    expect(status.jobs).toEqual([]);
    expect(status.model).toBe("deepseek-v4.1-flash");
  });
});
