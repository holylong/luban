import { describe, expect, it } from "vitest";
import { QuestionBroker } from "./question.js";

const question = { question: "Choose", options: [{ label: "A" }, { label: "B" }] };

describe("QuestionBroker", () => {
  it("resolves a browser choice and rejects duplicate answers", async () => {
    const broker = new QuestionBroker();
    const waiting = broker.request("job-1", question, new AbortController().signal);
    const pending = broker.pending("job-1");
    expect(pending).toHaveLength(1);
    expect(broker.answer(pending[0]!.id, "B")).toBe(true);
    expect(await waiting).toBe("B");
    expect(broker.answer(pending[0]!.id, "A")).toBe(false);
  });

  it("releases a pending question on cancellation", async () => {
    const broker = new QuestionBroker();
    const controller = new AbortController();
    const waiting = broker.request("job-2", question, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
    expect(broker.pending()).toEqual([]);
  });
});

describe("QuestionBroker published by its owner", () => {
  it("shows a terminal question to the browser and resolves the terminal from it", async () => {
    const broker = new QuestionBroker();
    const published = broker.open("session-1", question);
    const pending = broker.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ job_id: "session-1", question: "Choose" });
    expect(broker.answer(pending[0]!.id, "A")).toBe(true);
    expect(await published.answer).toBe("A");
    expect(broker.pending()).toEqual([]);
  });

  it("withdraws the browser copy when the owner answers first", async () => {
    const broker = new QuestionBroker();
    const published = broker.open("session-2", question);
    published.close();
    await expect(published.answer).rejects.toThrow("closed by its owner");
    expect(broker.pending()).toEqual([]);
    // A late browser answer for a withdrawn question is refused, not applied.
    expect(broker.answer(published.id, "B")).toBe(false);
  });

  it("drops a published question when its run is aborted", async () => {
    const broker = new QuestionBroker();
    const controller = new AbortController();
    const published = broker.open("session-3", question, controller.signal);
    controller.abort();
    await expect(published.answer).rejects.toThrow("aborted");
    expect(broker.pending()).toEqual([]);
  });
});
