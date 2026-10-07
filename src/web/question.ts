import { randomUUID } from "node:crypto";
import type { UserQuestion } from "../core/question.js";

export interface QuestionRequestView extends UserQuestion {
  id: string;
  job_id: string;
  created_at: number;
}

interface Waiter {
  view: QuestionRequestView;
  resolve(answer: string): void;
  reject(error: Error): void;
  abort(): void;
  signal: AbortSignal;
}

/** Keeps a browser question pending until answered or its job is cancelled. */
export class QuestionBroker {
  private readonly waiters = new Map<string, Waiter>();

  request(jobId: string, question: UserQuestion, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new Error("question aborted"));
    return new Promise<string>((resolve, reject) => {
      const id = `question-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const view = { ...question, id, job_id: jobId, created_at: Date.now() / 1000 };
      const abort = () => this.cancel(id);
      const waiter: Waiter = { view, resolve, reject, abort, signal };
      this.waiters.set(id, waiter);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  pending(jobId?: string): QuestionRequestView[] {
    return [...this.waiters.values()].map(waiter => waiter.view)
      .filter(view => !jobId || view.job_id === jobId)
      .sort((left, right) => left.created_at - right.created_at);
  }

  answer(id: string, answer: string): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter || !answer.trim() || answer.length > 2000) return false;
    this.waiters.delete(id);
    waiter.signal.removeEventListener("abort", waiter.abort);
    waiter.resolve(answer.trim());
    return true;
  }

  cancelAll(jobId?: string): void {
    for (const view of this.pending(jobId)) this.cancel(view.id);
  }

  private cancel(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.signal.removeEventListener("abort", waiter.abort);
    waiter.reject(new Error("question aborted"));
  }
}
