import { describe, expect, it } from "vitest";
import { pickDefaultSession } from "./mobile-session-pick";
import type { SessionSummary } from "./types";

const session = (id: string, updatedAt: string): SessionSummary => ({
  id, title: `会话 ${id}`, project: "luban", workspace: "/tmp/w", model: "m", mode: "edits",
  updatedAt, createdAt: updatedAt, messages: 4, edits: 0,
});

const newest = session("new", "2026-11-10T13:00:00.000Z");
const older = session("old", "2026-11-09T13:00:00.000Z");

describe("pickDefaultSession", () => {
  it("opens the newest session a device has", () => {
    expect(pickDefaultSession({ sessions: [newest, older], pinned: false, jobSelected: false })).toBe(newest);
  });

  it("leaves an explicitly chosen session alone", () => {
    expect(pickDefaultSession({ sessions: [newest], pinned: true, jobSelected: false })).toBeUndefined();
    expect(pickDefaultSession({ sessions: [newest], pinned: false, current: older, jobSelected: false })).toBeUndefined();
  });

  it("does not steal the live view from a running job", () => {
    expect(pickDefaultSession({ sessions: [newest], pinned: false, jobSelected: true })).toBeUndefined();
  });

  it("stays on the empty composer when the device has no sessions", () => {
    expect(pickDefaultSession({ sessions: [], pinned: false, jobSelected: false })).toBeUndefined();
  });
});
