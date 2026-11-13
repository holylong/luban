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

/** A question published by an owner that answers it itself (the terminal). */
export interface OpenQuestion {
  id: string;
  /** Resolves with the browser's answer; rejects when the owner closes it. */
  answer: Promise<string>;
  /** Withdraw the question, e.g. because the terminal was answered instead. */
  close(): void;
}

/**
 * Keeps a pending question until answered or its job is cancelled.
 *
 * Two callers publish here: a web job whose question the browser owns
 * (`request`), and a terminal run that keeps its own dialog but lets a phone
 * watching the same session answer first (`open`). Whichever side settles the
 * waiter removes it, so the other side's prompt closes.
 */
export class QuestionBroker {
  private readonly waiters = new Map<string, Waiter>();

  open(jobId: string, question: UserQuestion, signal: AbortSignal = new AbortController().signal): OpenQuestion {
    const id = `question-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const view = { ...question, id, job_id: jobId, created_at: Date.now() / 1000 };
    let settleAnswer: (answer: string) => void = () => undefined;
    let settleError: (error: Error) => void = () => undefined;
    const answer = new Promise<string>((resolve, reject) => {
      settleAnswer = resolve;
      settleError = reject;
    });
    const self = this;
    const abort = (): void => { self.cancel(id); };
    const detach = (): void => signal.removeEventListener("abort", abort);
    const waiter: Waiter = {
      view,
      resolve: (value: string) => { this.waiters.delete(id); detach(); settleAnswer(value); },
      reject: (error: Error) => { this.waiters.delete(id); detach(); settleError(error); },
      abort,
      signal,
    };
    this.waiters.set(id, waiter);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return {
      id,
      answer,
      close: () => { waiter.reject(new Error("question closed by its owner")); },
    };
  }

  request(jobId: string, question: UserQuestion, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new Error("question aborted"));
    return this.open(jobId, question, signal).answer;
  }

  pending(jobId?: string): QuestionRequestView[] {
    return [...this.waiters.values()].map(waiter => waiter.view)
      .filter(view => !jobId || view.job_id === jobId)
      .sort((left, right) => left.created_at - right.created_at);
  }

  answer(id: string, answer: string): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter || !answer.trim() || answer.length > 2000) return false;
    waiter.resolve(answer.trim());
    return true;
  }

  cancelAll(jobId?: string): void {
    for (const view of this.pending(jobId)) this.cancel(view.id);
  }

  private cancel(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    const settle = waiter.reject;
    settle(new Error("question aborted"));
  }
}
