import { describe, expect, it } from "vitest";
import { compactMessages, estimateMessagesTokens } from "./context.js";
import type { ChatMessage } from "./types.js";

describe("context management", () => {
  it("summarizes old observations while preserving system instructions and the latest turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "important workspace rules" },
      { role: "user", content: "old request " + "x".repeat(5_000) },
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", name: "read_file", tool_call_id: "1", content: "old output " + "y".repeat(5_000) },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "latest request" },
      { role: "assistant", content: "latest answer" },
    ];
    const result = compactMessages(messages, 800);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.messages[0]?.content).toBe("important workspace rules");
    expect(result.messages.some((message) => String(message.content).startsWith("[luban context summary]"))).toBe(true);
    expect(result.messages.at(-2)?.content).toBe("latest request");
    expect(result.messages.at(-1)?.content).toBe("latest answer");
    expect(estimateMessagesTokens(result.messages)).toBeLessThan(estimateMessagesTokens(messages));
  });

  it("compacts a chatty history even when its text still fits the token budget", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "rules" }];
    for (let index = 0; index < 60; index += 1) {
      messages.push({ role: "user", content: `request ${index}` }, { role: "assistant", content: `answer ${index}` });
    }
    const result = compactMessages(messages, 100_000, 40);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThanOrEqual(40);
    expect(result.messages.at(-2)?.content).toBe("request 59");
    expect(result.messages.at(-1)?.content).toBe("answer 59");
    expect(result.messages.some((message) => String(message.content).startsWith("[luban context summary]"))).toBe(true);
  });
});
