import { describe, expect, it } from "vitest";
import { splitPrompt } from "./wire.js";
import type { ChatMessage } from "./types.js";

const base: ChatMessage[] = [
  { role: "system", content: "base prompt" },
  { role: "system", content: "[luban task plan]\n{\"plan\":[]}" },
  { role: "system", content: "AGENTS.md for src/core" },
  { role: "user", content: "fix the test" },
  { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "1", name: "read_file", content: "contents" },
];

describe("splitPrompt", () => {
  it("keeps static instructions in the head and moves volatile records to the tail", () => {
    const { head, conversation, runtime } = splitPrompt(base);
    // The head is what a prompt cache keys on: base prompt plus scoped rules,
    // never the plan record that `update_plan` rewrites in place.
    expect(head).toBe("base prompt\n\nAGENTS.md for src/core");
    expect(conversation.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(runtime).toEqual(["[luban task plan]\n{\"plan\":[]}"]);
  });

  it("defers a verification record appended after the transcript", () => {
    const messages: ChatMessage[] = [...base, { role: "system", content: "[luban verification]\n{\"status\":\"passed\"}" }];
    const { head, runtime } = splitPrompt(messages);
    expect(head).toBe("base prompt\n\nAGENTS.md for src/core");
    expect(runtime.at(-1)).toBe("[luban verification]\n{\"status\":\"passed\"}");
  });

  it("keeps an unknown late system record out of the head", () => {
    // Any future `[luban …]` record that arrives mid-run lands after the
    // conversation started; folding it into the head would drop the cache.
    const messages: ChatMessage[] = [...base, { role: "system", content: "[luban runtime] steer" }];
    const { head, runtime } = splitPrompt(messages);
    expect(head).not.toContain("[luban runtime]");
    expect(runtime).toContain("[luban runtime] steer");
  });

  it("leaves the cacheable prefix untouched as a run grows", () => {
    // The invariant that makes the cache work: every later request starts with
    // exactly the bytes of the earlier one.
    const grown: ChatMessage[] = [
      ...base.slice(0, 2),
      { role: "system", content: "[luban task plan]\n{\"plan\":[{\"step\":\"edit\",\"status\":\"in_progress\"}]}" },
      ...base.slice(2),
      { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "edit_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "2", name: "edit_file", content: "ok" },
      { role: "system", content: "[luban verification]\n{\"status\":\"passed\"}" },
    ];
    expect(splitPrompt(grown).head).toBe(splitPrompt(base).head);
    const before = JSON.stringify(splitPrompt(base).conversation);
    const after = JSON.stringify(splitPrompt(grown).conversation);
    expect(after.startsWith(before.slice(0, -1))).toBe(true);
  });
});
