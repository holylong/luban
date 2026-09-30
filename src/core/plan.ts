import { randomUUID } from "node:crypto";
import type { ChatMessage, ToolDefinition, VerificationRecord } from "./types.js";

export const PLAN_MARKER = "[luban task plan]";
export const VERIFICATION_MARKER = "[luban verification]";
interface PlanStep { step: string; status: "pending" | "in_progress" | "completed" }
interface TaskPlan { explanation: string; plan: PlanStep[] }

function validatePlan(args: Record<string, unknown>): TaskPlan {
  if (!Array.isArray(args.plan) || args.plan.length < 1 || args.plan.length > 20) {
    throw new Error("plan must contain 1-20 steps");
  }
  const plan = args.plan.map((item: unknown): PlanStep => {
    if (!item || typeof item !== "object") throw new Error("invalid plan step");
    const { step, status } = item as Record<string, unknown>;
    if (typeof step !== "string" || !step.trim() || step.length > 120) throw new Error("step must be 1-120 characters");
    if (status !== "pending" && status !== "in_progress" && status !== "completed") throw new Error("invalid plan status");
    return { step: step.trim(), status };
  });
  if (plan.filter((item) => item.status === "in_progress").length > 1) throw new Error("at most one step may be in_progress");
  if (new Set(plan.map((item) => item.step)).size !== plan.length) throw new Error("plan steps must be unique");
  if (args.explanation !== undefined && (typeof args.explanation !== "string" || args.explanation.length > 200)) {
    throw new Error("explanation must be a string of at most 200 characters");
  }
  return { explanation: args.explanation as string || "", plan };
}

export function readPlan(messages: ChatMessage[]): TaskPlan | undefined {
  const saved = messages.find((message) => message.role === "system" && String(message.content).startsWith(PLAN_MARKER));
  if (!saved) return undefined;
  try { return validatePlan(JSON.parse(String(saved.content).slice(PLAN_MARKER.length))); } catch { return undefined; }
}

export function readVerifications(messages: ChatMessage[]): VerificationRecord[] {
  const out: VerificationRecord[] = [];
  for (const message of messages) {
    if (message.role !== "system" || !String(message.content).startsWith(VERIFICATION_MARKER)) continue;
    try {
      const parsed = JSON.parse(String(message.content).slice(VERIFICATION_MARKER.length));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === "object" && typeof (item as Record<string, unknown>).command === "string") {
            out.push(item as VerificationRecord);
          }
        }
      } else if (parsed && typeof parsed === "object") out.push(parsed as VerificationRecord);
    } catch { /* ignore malformed verification records */ }
  }
  return out.slice(-50);
}

/** A plan counts as verified only when every completed step has a passing check. */
export function planVerificationStatus(messages: ChatMessage[]): { plan?: TaskPlan; verified: boolean; detail: string } {
  const plan = readPlan(messages);
  if (!plan) return { verified: false, detail: "no plan" };
  const completed = plan.plan.filter((item) => item.status === "completed").length;
  if (!completed) return { plan, verified: false, detail: "no completed steps yet" };
  const records = readVerifications(messages);
  const passed = records.filter((item) => item.status === "passed").length;
  if (!records.length) return { plan, verified: false, detail: `${completed} step(s) completed but no verification recorded; run tests/checks and record_verification` };
  if (passed <= 0) return { plan, verified: false, detail: "latest verification failed; do not claim success" };
  return { plan, verified: true, detail: `${passed} passing check(s) for ${completed} completed step(s)` };
}

/** Store plan state in the session transcript, outside the lossy history summary.
 * Tools close over this run's transcript, so separate sessions never share plans.
 */
export function planTools(messages: ChatMessage[]): ToolDefinition[] {
  return [{
    name: "update_plan",
    description: "Create or replace the task plan for multi-step work. Steps are short phrases (<=15 words each). Keep at most one step in progress. Include verification; mark completed only with evidence. State survives session saving and context compaction.",
    risk: "read",
    parameters: {
      type: "object", additionalProperties: false, required: ["plan"],
      properties: {
        explanation: { type: "string", maxLength: 200 },
        plan: { type: "array", minItems: 1, maxItems: 20, items: {
          type: "object", additionalProperties: false, required: ["step", "status"],
          properties: { step: { type: "string", minLength: 1, maxLength: 120 }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
        } },
      },
    },
    async execute(args) {
      const plan = validatePlan(args);
      const content = `${PLAN_MARKER}\n${JSON.stringify(plan)}`;
      const existing = messages.findIndex((message) => message.role === "system" && String(message.content).startsWith(PLAN_MARKER));
      if (existing >= 0) messages[existing] = { role: "system", content };
      else {
        const index = messages.findIndex((message) => message.role !== "system");
        messages.splice(index < 0 ? messages.length : index, 0, { role: "system", content });
      }
      return JSON.stringify(plan);
    },
  }, {
    name: "read_plan", description: "Read the current task plan and unfinished steps.", risk: "read", parallelSafe: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return JSON.stringify(readPlan(messages) ?? { explanation: "No plan yet", plan: [] }); },
  }, {
    name: "record_verification",
    description: "Record a test/check command and its outcome for the current plan. Mark passed only when the command actually succeeded. Survives saving and compaction.",
    risk: "read",
    parameters: {
      type: "object", additionalProperties: false, required: ["command", "status"],
      properties: {
        command: { type: "string", minLength: 1, maxLength: 500 },
        status: { type: "string", enum: ["passed", "failed"] },
        output: { type: "string", maxLength: 2000 },
      },
    },
    async execute(args) {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command) throw new Error("command is required");
      if (args.status !== "passed" && args.status !== "failed") throw new Error("status must be passed or failed");
      const output = typeof args.output === "string" ? args.output.slice(0, 2000) : "";
      const record: VerificationRecord = { id: randomUUID(), command, status: args.status, output, createdAt: new Date().toISOString() };
      messages.push({ role: "system", content: `${VERIFICATION_MARKER}\n${JSON.stringify(record)}` });
      const status = planVerificationStatus(messages);
      return JSON.stringify({ recorded: record, verification: status.detail, verified: status.verified });
    },
  }, {
    name: "read_verification", description: "Read recorded test/check outcomes for the current task.", risk: "read", parallelSafe: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const records = readVerifications(messages);
      const status = planVerificationStatus(messages);
      return JSON.stringify({ verified: status.verified, detail: status.detail, records });
    },
  }];
}
