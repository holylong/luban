import type { TimelineItem } from "./types";

export interface DesktopPlanStep { step: string; status: "pending" | "in_progress" | "completed" }
export function latestDesktopPlan(timeline: TimelineItem[]): DesktopPlanStep[] {
  let plan: DesktopPlanStep[] = [];
  for (const item of timeline) {
    if (item.kind !== "tool" || item.run.name !== "update_plan" || item.run.status === "failed") continue;
    const value = item.run.args.plan;
    if (!Array.isArray(value)) continue;
    const parsed = value.filter((entry): entry is DesktopPlanStep => Boolean(entry) && typeof entry.step === "string" && ["pending", "in_progress", "completed"].includes(entry.status));
    if (parsed.length === value.length) plan = parsed;
  }
  return plan;
}
