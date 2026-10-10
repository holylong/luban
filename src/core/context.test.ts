import { describe, expect, it } from "vitest";
import { compactForRequest, compactMessages, estimateMessagesTokens } from "./context.js";
import type { ChatMessage } from "./types.js";

describe("context management", () => {
  it("does not summarize small tool rounds just because the retained-tail limit is reached", () => {
    let messages: ChatMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "work" }];
    for (let index = 0; index < 50; index++) {
      messages.push({ role: "assistant", content: "", tool_calls: [{ id: String(index), type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: String(index), content: "small observation".repeat(40) });
      const result = compactForRequest(messages, 229_376, 60);
      expect(result.messages).toBe(messages);
      messages = result.messages;
    }
    expect(messages).toHaveLength(102);
  });

  it("leaves headroom after token pressure and retains complete tool batches", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "work" }];
    for (let index = 0; index < 10; index++) {
      messages.push({ role: "assistant", content: "", tool_calls: [{ id: String(index), type: "function", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: String(index), content: "x".repeat(2000) });
    }
    const result = compactForRequest(messages, 6000, 60);
    expect(result.removed).toBeGreaterThan(0);
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(3600);
    const calls = new Set(result.messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []));
    expect(result.messages.filter(message => message.role === "tool").every(message => calls.has(message.tool_call_id!))).toBe(true);
    expect(compactForRequest(result.messages, 6000, 60).messages).toBe(result.messages);
  });
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
