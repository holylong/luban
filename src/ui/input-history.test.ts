import { describe, expect, it } from "vitest";
import { historyFromMessages, pushInputHistory, recallDown, recallUp } from "./input-history.js";

describe("input history recall", () => {
  it("pushes trimmed inputs and drops empties and consecutive duplicates", () => {
    expect(pushInputHistory([], "  ")).toEqual([]);
    expect(pushInputHistory([], "  fix it  ")).toEqual(["fix it"]);
    expect(pushInputHistory(["fix it"], "fix it")).toEqual(["fix it"]);
    expect(pushInputHistory(["a"], "b")).toEqual(["a", "b"]);
  });

  it("walks up then down, restoring the stashed draft", () => {
    const history = ["first", "second", "third"];
    let state = recallUp(history, null, "drafting", "");
    expect(state).toEqual({ index: 2, input: "third", draft: "drafting" });
    state = recallUp(history, state.index, state.input, state.draft);
    expect(state.input).toBe("second");
    state = recallUp(history, state.index, state.input, state.draft);
    expect(state.input).toBe("first");
    // Clamped at the oldest entry.
    state = recallUp(history, state.index, state.input, state.draft);
    expect(state).toMatchObject({ index: 0, input: "first", draft: "drafting" });
    state = recallDown(history, state.index, state.draft);
    expect(state).toMatchObject({ index: 1, input: "second" });
    state = recallDown(history, state.index, state.draft);
    expect(state).toMatchObject({ index: 2, input: "third" });
    state = recallDown(history, state.index, state.draft);
    expect(state).toEqual({ index: null, input: "drafting", draft: "drafting" });
  });

  it("seeds history from user messages for resumed sessions", () => {
    const seeded = historyFromMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "first task" },
      { role: "assistant", content: "done" },
      { role: "user", content: "  second task  " },
      { role: "user", content: "" },
    ]);
    expect(seeded).toEqual(["first task", "second task"]);
  });
});
