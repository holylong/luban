import { describe, expect, it } from "vitest";
import type { MeshRuntime } from "../core/mesh/runtime.js";
import type { LubanConfig } from "../core/types.js";
import { liveSessions } from "../core/live-session.js";
import { readDeviceStatus } from "./device-status.js";

const config = { model: { model: "deepseek-v4.1-flash" } } as unknown as LubanConfig;

const session = (fields: Record<string, unknown> = {}) => ({
  id: "session-1", title: "整理右键菜单", project: "luban", workspace: "/tmp/w",
  model: "deepseek-v4.1-flash", mode: "edits", messages: [],
  createdAt: "2026-11-10T12:00:00.000Z", updatedAt: "2026-11-10T13:00:00.000Z",
  ...fields,
}) as never;

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

  it("reports a session the terminal is running as live work", async () => {
    // A TUI turn never becomes a mesh job, so `jobs` stays empty; without the
    // session snapshot the phone showed "空闲" for a busy laptop.
    const home = "/tmp/luban-status-test-a";
    liveSessions.start(home, session());
    const status = await readDeviceStatus({ ...config, home } as unknown as LubanConfig, undefined);
    expect(status.jobs).toEqual([]);
    expect(status.sessions).toEqual([{
      id: "session-1", project: "luban", title: "整理右键菜单",
      updated_at: Math.round(Date.parse("2026-11-10T13:00:00.000Z") / 1000),
    }]);
    liveSessions.finish(home, session());
  });

  it("stops reporting a session once the terminal is done with it", async () => {
    const home = "/tmp/luban-status-test-b";
    liveSessions.start(home, session());
    liveSessions.finish(home, session({ updatedAt: "2026-11-10T13:05:00.000Z" }));
    const status = await readDeviceStatus({ ...config, home } as unknown as LubanConfig, undefined);
    expect(status.sessions).toEqual([]);
  });

  it("does not report a job twice when the job owns the session", async () => {
    // Workbench turns run through agent-runner, which registers the same
    // session with its job id: the job list already shows it.
    const home = "/tmp/luban-status-test-c";
    liveSessions.start(home, session(), "job-1");
    const status = await readDeviceStatus({ ...config, home } as unknown as LubanConfig, fakeMesh([job({ id: "job-1" })]));
    expect(status.jobs.map(item => item.id)).toEqual(["job-1"]);
    expect(status.sessions).toEqual([]);
    liveSessions.finish(home, session());
  });

  it("keeps sessions from another luban home out of this device", async () => {
    liveSessions.start("/tmp/luban-status-test-other", session());
    const status = await readDeviceStatus({ ...config, home: "/tmp/luban-status-test-mine" } as unknown as LubanConfig, undefined);
    expect(status.sessions).toEqual([]);
  });

  it("trims a long session title", async () => {
    const home = "/tmp/luban-status-test-long";
    liveSessions.start(home, session({ title: "标题".repeat(200) }));
    const status = await readDeviceStatus({ ...config, home } as unknown as LubanConfig, undefined);
    expect(status.sessions[0]!.title.length).toBeLessThanOrEqual(240);
    expect(status.sessions[0]!.title.endsWith("…")).toBe(true);
    liveSessions.finish(home, session());
  });
});
