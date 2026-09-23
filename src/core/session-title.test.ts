import { describe, expect, it } from "vitest";
import { cleanTitle, fallbackTitle, hasNameableContent, MAX_TITLE_LENGTH, titlePrompt, titleTranscript } from "./session-title.js";
import type { ChatMessage } from "./types.js";

describe("fallbackTitle", () => {
  it("uses the first line of the opening user message", () => {
    expect(fallbackTitle([{ role: "user", content: "fix the parser\nand the lexer too" }])).toBe("fix the parser");
  });

  it("skips system and empty messages and falls back to a placeholder", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "   " },
    ];
    expect(fallbackTitle(messages)).toBe("New session");
    expect(fallbackTitle([])).toBe("New session");
  });

  it("clips to the length the list is laid out for", () => {
    expect(fallbackTitle([{ role: "user", content: "x".repeat(200) }])).toHaveLength(MAX_TITLE_LENGTH);
  });
});

describe("cleanTitle", () => {
  it("keeps a plain name", () => {
    expect(cleanTitle("Fix the parser")).toBe("Fix the parser");
    expect(cleanTitle("修复解析器内存泄漏")).toBe("修复解析器内存泄漏");
  });

  it("strips the decoration models add", () => {
    expect(cleanTitle('"Fix the parser"')).toBe("Fix the parser");
    expect(cleanTitle("**Fix the parser**")).toBe("Fix the parser");
    expect(cleanTitle("`Fix the parser`.")).toBe("Fix the parser");
    expect(cleanTitle("「修复解析器」")).toBe("修复解析器");
  });

  it("keeps the value of a labelled answer and drops the label", () => {
    expect(cleanTitle("Title: Fix the parser")).toBe("Fix the parser");
    expect(cleanTitle("标题：修复解析器")).toBe("修复解析器");
  });

  it("keeps only the first line and collapses whitespace", () => {
    expect(cleanTitle("Fix the parser\n\nThis is because the grammar is ambiguous.")).toBe("Fix the parser");
    expect(cleanTitle("  Fix   the    parser  ")).toBe("Fix the parser");
  });

  it("rejects an answer that is not a name", () => {
    // A paragraph: the opening user line is a better title than a truncation.
    expect(cleanTitle("Sure! I looked at the parser and found that the grammar handles operator precedence incorrectly, which causes the shift/reduce conflict you are seeing in the build logs.")).toBeUndefined();
    expect(cleanTitle("")).toBeUndefined();
    expect(cleanTitle("   ")).toBeUndefined();
    expect(cleanTitle("Untitled")).toBeUndefined();
    expect(cleanTitle("新会话")).toBeUndefined();
    expect(cleanTitle(undefined)).toBeUndefined();
    expect(cleanTitle(42)).toBeUndefined();
    expect(cleanTitle("x".repeat(MAX_TITLE_LENGTH + 1))).toBeUndefined();
  });

  it("accepts a name right at the length limit", () => {
    const boundary = "x".repeat(MAX_TITLE_LENGTH);
    expect(cleanTitle(boundary)).toBe(boundary);
  });
});

describe("titleTranscript", () => {
  it("shows the exchange with tool calls named but not their output", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "继续" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", name: "read_file", tool_call_id: "c1", content: "one\n two\n three" },
      { role: "assistant", content: "已修复解析器。" },
    ];
    const transcript = titleTranscript(messages);
    expect(transcript).toContain("User: 继续");
    expect(transcript).toContain("(called read_file)");
    expect(transcript).toContain("Assistant: 已修复解析器。");
    expect(transcript).not.toContain("sys");
  });

  it("bounds what a single pasted message can contribute", () => {
    const transcript = titleTranscript([{ role: "user", content: "y".repeat(5_000) }]);
    expect(transcript.length).toBeLessThan(700);
    expect(transcript).toContain("…");
  });
});

describe("titlePrompt", () => {
  it("asks for a name and carries the exchange", () => {
    const prompt = titlePrompt([{ role: "user", content: "why is the build slow" }, { role: "assistant", content: "checking" }]);
    expect(prompt).toHaveLength(2);
    expect(prompt[0]!.role).toBe("system");
    expect(String(prompt[0]!.content)).toContain("Reply with the title only");
    expect(String(prompt[1]!.content)).toContain("User: why is the build slow");
    expect(String(prompt[1]!.content)).toContain("Assistant: checking");
  });
});

describe("hasNameableContent", () => {
  it("needs a user message with something in it", () => {
    expect(hasNameableContent([{ role: "system", content: "sys" }])).toBe(false);
    expect(hasNameableContent([{ role: "user", content: "hi" }])).toBe(false);
    expect(hasNameableContent([{ role: "user", content: "rename the session title" }])).toBe(true);
  });
});
