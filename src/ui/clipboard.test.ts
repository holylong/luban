import { describe, expect, it } from "vitest";
import { buildCopyText, clipboardWriters, lastAssistantText, osc52CopySequence, powershellClipboardArgs } from "./clipboard.js";

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

  it("writes the clipboard through the helper of each platform", () => {
    expect(clipboardWriters("linux").map((writer) => writer.command)).toEqual(["wl-copy", "xclip", "xsel"]);
    expect(clipboardWriters("darwin").map((writer) => writer.command)).toEqual(["pbcopy"]);
    // Windows needs a real helper: OSC 52 is ignored by Windows Terminal, which
    // used to leave a drag-copy selection on the floor.
    expect(clipboardWriters("win32").map((writer) => writer.command)).toEqual(["powershell.exe", "clip"]);
    expect(clipboardWriters("darwin")[0]!.stdin!("选中内容")).toBe("选中内容");
    expect(clipboardWriters("linux")[1]!.args("x")).toEqual(["-selection", "clipboard"]);
  });

  it("passes Windows text as base64 so CJK survives the console code page", () => {
    const args = powershellClipboardArgs("中文选中")!;
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    const payload = /FromBase64String\('([^']+)'\)/u.exec(args[3]!)![1]!;
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("中文选中");
    // Too large for a command line: the writer declines and the next one runs.
    expect(powershellClipboardArgs("x".repeat(20000))).toBeNull();
  });
});
