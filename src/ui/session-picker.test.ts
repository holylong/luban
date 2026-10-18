import { describe, expect, it } from "vitest";
import { sessionChoices } from "./session-picker.js";
import type { SessionRecord } from "../core/types.js";

function session(id: string, changes: Partial<SessionRecord> = {}): SessionRecord {
  return { id, title: id, project: "demo", workspace: "/workspace", mode: "auto", model: "test",
    createdAt: "2026-10-18T01:00:00Z", updatedAt: "2026-10-18T01:00:00Z", messages: [], ...changes };
}

describe("session picker", () => {
  it("hides the current session, command-only drafts, system prompts and whitespace", () => {
    const records = [session("current", { messages: [{ role: "user", content: "working" }] }),
      session("commands", { inputHistory: ["/sessions", "/models"] }),
      session("system", { messages: [{ role: "system", content: "instructions" }] }),
      session("blank", { messages: [{ role: "user", content: " \n" }, { role: "assistant", content: null }] }),
      session("history", { messages: [{ role: "user", content: "continue this task" }] })];
    expect(sessionChoices(records, "current").map(record => record.id)).toEqual(["history"]);
    expect(sessionChoices(records, "history").map(record => record.id)).toEqual(["current"]);
  });

  it("keeps attachments, pending work, tool calls and saved edit records", () => {
    const records = [
      session("image", { messages: [{ role: "user", content: "", images: [{ path: "x.png", mime: "image/png" }] }] }),
      session("queued", { pendingInputs: [{ id: "q", content: "finish this", delivery: "queue", createdAt: "now" }] }),
      session("tool", { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "bash", arguments: "{}" } }] }] }),
      session("edits", { edits: [{ id: "e", name: "edit_file", preview: "Edited file (+1 -1)" }] }),
    ];
    expect(sessionChoices(records, "current")).toEqual(records);
  });

  it("uses the same date, title and project matching for displayed rows and selection", () => {
    const records = [session("old", { messages: [{ role: "user", content: "task" }], updatedAt: "2026-10-17T02:00:00Z" }),
      session("new", { messages: [{ role: "user", content: "task" }], title: "Parser repair" })];
    expect(sessionChoices(records, "current", "2026-10-18").map(record => record.id)).toEqual(["new"]);
    expect(sessionChoices(records, "current", "PARSER").map(record => record.id)).toEqual(["new"]);
    expect(sessionChoices(records, "current", "demo")).toEqual(records);
  });
});
