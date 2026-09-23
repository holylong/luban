import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../core/types.js";
import { conclusionMaxLines, currentStreamLine, visibleConversationMessages } from "./transcript.js";

describe("terminal transcript", () => {
  it("always budgets visible lines for the conclusion, even with details expanded", () => {
    expect(conclusionMaxLines(false, 30)).toBe(20);
    expect(conclusionMaxLines(true, 30)).toBe(7);
    expect(conclusionMaxLines(true, 10)).toBe(6);
    expect(conclusionMaxLines(false, 10)).toBe(12);
  });

  it("replaces the displayed thinking line when a new line arrives", () => {
    expect(currentStreamLine("Checking files…\n\n  then\t running tests"))
      .toBe("then running tests");
    expect(currentStreamLine("Checking files…\n"))
      .toBe("Checking files…");
  });

  it("hides intermediate tool-call reasoning but keeps the final answer", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "I need to inspect several files first.",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-1", name: "read_file", content: "contents" },
      { role: "assistant", content: "Fixed and tested." },
    ];

    expect(visibleConversationMessages(messages).map((message) => message.content))
      .toEqual(["fix it", "Fixed and tested."]);
  });

  it("cleans leaked reasoning from assistant messages loaded from old sessions", () => {
    const messages: ChatMessage[] = [{
      role: "assistant",
      content: "The user is asking a question.\n\nAccording to the system reminder, I should answer.\n\n最终答案。",
    }];
    expect(visibleConversationMessages(messages)[0]?.content).toBe("最终答案。");
  });

  it("shows the product identity when old sessions answered with the model brand", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "你叫什么？" },
      { role: "assistant", content: "我叫千问。" },
    ];
    expect(visibleConversationMessages(messages)[1]?.content)
      .toBe("我是 luban，一个直接在你的工作区里工作的编码 Agent。");
  });
});
