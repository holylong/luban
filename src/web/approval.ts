import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../core/types.js";

export type ApprovalDecision = "once" | "tool" | "always" | "deny";

export interface ApprovalRequestView {
  id: string;
  job_id: string;
  tool: string;
  description: string;
  risk: string;
  args: Record<string, unknown>;
  created_at: number;
}

interface Waiter {
  view: ApprovalRequestView;
  timer: NodeJS.Timeout;
  resolve: (decision: ApprovalDecision) => void;
}

/**
 * Bridges a running agent's approval callback to a browser round trip.
 *
 * The agent loop runs tools sequentially inside one job, so one pending
 * request per job is the expected shape; extra requests queue in order.
 */
export class ApprovalBroker {
  private readonly waiters = new Map<string, Waiter>();
  private readonly byJob = new Map<string, string[]>();

  constructor(private readonly timeoutMs = 300_000) {}

  request(jobId: string, tool: ToolDefinition, args: Record<string, unknown>): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const id = `ask-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const view: ApprovalRequestView = {
        id, job_id: jobId, tool: tool.name,
        description: tool.description || tool.name,
        risk: tool.risk, args,
        created_at: Date.now() / 1000,
      };
      const timer = setTimeout(() => this.settle(id, "deny"), this.timeoutMs);
      timer.unref?.();
      this.waiters.set(id, { view, timer, resolve });
      const queue = this.byJob.get(jobId) ?? [];
      queue.push(id);
      this.byJob.set(jobId, queue);
    });
  }

  pending(jobId?: string): ApprovalRequestView[] {
    return [...this.waiters.values()]
      .map(waiter => waiter.view)
      .filter(view => !jobId || view.job_id === jobId)
      .sort((left, right) => left.created_at - right.created_at);
  }

  /** Resolve one request. Returns false for an unknown or already settled id. */
  decide(id: string, decision: ApprovalDecision): boolean {
    if (!this.waiters.has(id)) return false;
    this.settle(id, decision);
    return true;
  }

  /** Deny everything still pending, e.g. when a job is cancelled or the server stops. */
  denyAll(jobId?: string): void {
    for (const waiter of [...this.waiters.values()]) {
      if (!jobId || waiter.view.job_id === jobId) this.settle(waiter.view.id, "deny");
    }
  }

  private settle(id: string, decision: ApprovalDecision): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    clearTimeout(waiter.timer);
    const queue = this.byJob.get(waiter.view.job_id);
    if (queue) {
      const index = queue.indexOf(id);
      if (index >= 0) queue.splice(index, 1);
      if (!queue.length) this.byJob.delete(waiter.view.job_id);
    }
    waiter.resolve(decision);
  }
}
