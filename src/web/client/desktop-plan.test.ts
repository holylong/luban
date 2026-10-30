import { expect, it } from "vitest";
import { latestDesktopPlan } from "./desktop-plan";
import type { TimelineItem } from "./types";
const event = (plan: unknown, status: "done" | "failed" = "done"): TimelineItem => ({ kind: "tool", id: "plan", at: 0, run: { callId: "plan", name: "update_plan", summary: "Plan", status, seq: 1, args: { plan } } });
it("shows the latest valid plan without accepting failed or malformed updates", () => {
  const first = [{ step: "Inspect", status: "completed" }];
  const latest = [{ step: "Verify", status: "in_progress" }];
  expect(latestDesktopPlan([event(first), event(latest), event([null]), event([{ step: "bad", status: "invalid" }]), event([], "failed")])).toEqual(latest);
});
it("supports clearing a plan", () => {
  expect(latestDesktopPlan([event([{ step: "Inspect", status: "pending" }]), event([])])).toEqual([]);
});
