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
