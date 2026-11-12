import { describe, expect, it } from "vitest";
import { continuationForPrompt } from "./mobile-continue";
import type { MeshJob, SessionSummary } from "./types";

const session = (id: string, title: string): SessionSummary => ({
  id, title, project: "luban", workspace: "/tmp/w", model: "m", mode: "edits",
  updatedAt: "2026-11-10T13:00:00.000Z", createdAt: "2026-11-10T13:00:00.000Z", messages: 4, edits: 0,
});

const job = (fields: Partial<MeshJob>): MeshJob => ({
  id: "job-1", source: "local", target: "node", kind: "task", project_id: "luban", workspace: "/tmp/w",
  instruction: "看看构建", title: "看看构建", status: "done", progress: 100, logs: [], result: "", error: "",
  created_at: 1, updated_at: 1, done_at: 2, ...fields,
});

describe("continuationForPrompt", () => {
  it("appends the next instruction to the session the reader opened", () => {
    expect(continuationForPrompt({ picked: session("s1", "修复构建"), sessions: [] })).toMatchObject({ id: "s1", title: "修复构建" });
  });

  it("keeps a follow-up in the session the job on screen belongs to", () => {
    const running = job({ session_id: "s1" });
    expect(continuationForPrompt({ job: running, sessions: [session("s1", "修复构建")] })).toMatchObject({ id: "s1", title: "修复构建" });
  });

  it("starts a new conversation only when no session is in play", () => {
    expect(continuationForPrompt({ job: job({}), sessions: [session("s1", "修复构建")] })).toBeUndefined();
    expect(continuationForPrompt({ sessions: [session("s1", "修复构建")] })).toBeUndefined();
  });

  it("names a session the list has not refreshed to yet after the job title", () => {
    expect(continuationForPrompt({ job: job({ session_id: "fresh" }), sessions: [] })).toMatchObject({ id: "fresh", title: "看看构建" });
  });

  it("carries the job's project so the node can find the saved conversation", () => {
    expect(continuationForPrompt({ job: job({ session_id: "s1", project_id: "other" }), sessions: [] }))
      .toMatchObject({ id: "s1", project: "other" });
  });

  // The phone can be pointed at another workspace than the session it opened.
  // Inheriting the phone's project ran the follow-up in the wrong directory
  // while appending it to the conversation on screen.
  it("carries the opened session's own project, not the phone's workspace", () => {
    expect(continuationForPrompt({ picked: session("s1", "别的项目"), sessions: [] }))
      .toMatchObject({ id: "s1", project: "luban" });
    expect(continuationForPrompt({ picked: { id: "s1", title: "t" }, sessions: [] })).not.toHaveProperty("project");
  });
});
