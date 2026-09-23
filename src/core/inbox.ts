import { randomUUID } from "node:crypto";
import type { ChatMessage, PendingInput } from "./types.js";

/** Serialize admission and promotion so an input is durable before model delivery. */
export class AgentInbox {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  private admissions = 0;
  constructor(private readonly state: { pendingInputs?: PendingInput[] }, private readonly persist: () => Promise<void>) {}

  enqueue(content: string, delivery: "steer" | "queue" = "steer", images: PendingInput["images"] = []): Promise<string> {
    if (!this.accepting) return Promise.reject(new Error("Agent is finishing; send the message again when idle"));
    if (!content.trim() || content.length > 100_000) return Promise.reject(new Error("input must contain 1-100000 characters"));
    if (delivery !== "steer" && delivery !== "queue") return Promise.reject(new Error("invalid input delivery mode"));
    const input: PendingInput = { id: randomUUID(), content: content.trim(), delivery, createdAt: new Date().toISOString(), ...(images?.length ? { images: images.slice(0, 8) } : {}) };
    this.admissions += 1;
    const operation = this.tail.then(async () => {
      if ((this.state.pendingInputs?.length ?? 0) >= 50) throw new Error("pending input queue is full (50)");
      this.state.pendingInputs = [...(this.state.pendingInputs ?? []), input];
      try { await this.persist(); } catch (error) {
        this.state.pendingInputs = this.state.pendingInputs.filter((item) => item.id !== input.id);
        throw error;
      }
    }).finally(() => { this.admissions -= 1; });
    this.tail = operation.catch(() => undefined);
    return operation.then(() => input.id);
  }

  async hasSteering(): Promise<boolean> {
    await this.tail;
    return (this.state.pendingInputs ?? []).some((input) => input.delivery === "steer");
  }

  /** At idle, promote all steering inputs, or one queued task if no steering exists. */
  promote(messages: ChatMessage[], idle = false): Promise<PendingInput[]> {
    let selected: PendingInput[] = [];
    const operation = this.tail.then(async () => {
      const pending = this.state.pendingInputs ?? [];
      selected = pending.filter((input) => input.delivery === "steer");
      if (!selected.length && idle && pending.length) selected = [pending[0]!];
      if (!selected.length) return;
      const ids = new Set(selected.map((input) => input.id));
      const start = messages.length;
      messages.push(...selected.map((input): ChatMessage => ({ role: "user", content: input.content, ...(input.images?.length ? { images: input.images } : {}) })));
      this.state.pendingInputs = pending.filter((input) => !ids.has(input.id));
      try { await this.persist(); } catch (error) {
        messages.splice(start);
        this.state.pendingInputs = pending;
        throw error;
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation.then(() => selected);
  }

  async finish(): Promise<boolean> {
    await this.tail;
    if (this.admissions || this.state.pendingInputs?.length) return false;
    this.accepting = false;
    return true;
  }

  /** Admission closes synchronously, then every accepted input is flushed to disk. */
  async close(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }
}
