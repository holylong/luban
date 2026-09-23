import { describe, expect, it } from "vitest";
import { toJobStreamEvent } from "./agent-runner.js";

describe("toJobStreamEvent", () => {
  it("carries the progress mark so a remote surface does not record a phase label", () => {
    // The tool loop re-announces this once per step. Without the mark crossing
    // the transport, the remote terminal and the browser console rebuilt the
    // same wall of duplicate rows a local run used to show.
    expect(toJobStreamEvent({ type: "status", text: "Reviewing tool results", progress: true }))
      .toEqual({ kind: "status", text: "Reviewing tool results", progress: true });
  });

  it("leaves a real notice unmarked so it stays in the record", () => {
    expect(toJobStreamEvent({ type: "status", text: "Compacted 12 older messages" }))
      .toEqual({ kind: "status", text: "Compacted 12 older messages" });
  });
});
