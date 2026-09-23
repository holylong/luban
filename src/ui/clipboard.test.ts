import { describe, expect, it } from "vitest";
import { buildCopyText, lastAssistantText, osc52CopySequence } from "./clipboard.js";

describe("clipboard copy", () => {
  it("encodes OSC52 with base64 payload", () => {
    const seq = osc52CopySequence("hi");
    expect(seq.startsWith("\x1b]52;c;")).toBe(true);
    expect(seq.endsWith("\x07")).toBe(true);
    expect(Buffer.from(seq.slice("\x1b]52;c;".length, -1), "base64").toString("utf8")).toBe("hi");
  });

  it("picks the last non-tool assistant message", () => {
    expect(lastAssistantText([
      { role: "user", content: "q" },
      { role: "assistant", content: "thinking", tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "assistant", content: "final answer" },
    ])).toBe("final answer");
  });

  it("bundles answer, tool previews and pending steering", () => {
    const text = buildCopyText(
      [{ role: "assistant", content: "done" }],
      [{ name: "bash", detail: "npm test", status: "failed", preview: "FAIL foo" }],
      [{ id: "p1", content: "also check bar", delivery: "steer", createdAt: new Date().toISOString() }],
      "failed",
    );
    expect(text).toContain("done");
    expect(text).toContain("FAIL foo");
    expect(text).toContain("also check bar");
  });
});
