import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../core/types.js";
import { buildTranscript, estimateLines, transcriptHeight } from "./transcript-blocks.js";

const options = { expanded: false, width: 80 };

const call = (id: string, name: string, args: string) => ({
  id, type: "function" as const, function: { name, arguments: args },
});

describe("buildTranscript", () => {
  it("keeps prose and tool activity in the order they happened", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "", tool_calls: [call("c1", "read_file", '{"path":"a.ts"}')] },
      { role: "tool", name: "read_file", tool_call_id: "c1", content: "file body" },
      { role: "assistant", content: "", tool_calls: [call("c2", "edit_file", '{"path":"a.ts"}')] },
      { role: "tool", name: "edit_file", tool_call_id: "c2", content: "Edited a.ts (+1 -1)", editPreview: "Edited a.ts (+1 -1)\n     1 -old\n     1 +new" },
      { role: "assistant", content: "Fixed it." },
    ];
    const blocks = buildTranscript(messages, options);
    expect(blocks.map(block => block.kind)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(blocks[1]!.entry).toMatchObject({ name: "read_file", status: "done" });
    expect(blocks[2]!.entry).toMatchObject({ name: "edit_file", status: "done", editPreview: expect.stringContaining("+new") });
    expect(blocks[3]).toMatchObject({ kind: "assistant", text: "Fixed it." });
  });

  it("summarizes tool arguments instead of dumping raw JSON", () => {
    const blocks = buildTranscript([
      { role: "assistant", content: "", tool_calls: [call("c1", "bash", '{"command":"npm test"}')] },
    ], options);
    const detail = blocks[0]!.entry?.detail ?? "";
    expect(detail).toContain("npm test");
    expect(detail).not.toContain('{"command"');
  });

  it("marks a call without a result as still running", () => {
    const blocks = buildTranscript([
      { role: "assistant", content: "", tool_calls: [call("c1", "bash", '{"command":"sleep 1"}')] },
    ], options);
    expect(blocks[0]!.entry?.status).toBe("running");
  });

  it("marks a failing tool result as failed", () => {
    const blocks = buildTranscript([
      { role: "assistant", content: "", tool_calls: [call("c1", "bash", '{"command":"false"}')] },
      { role: "tool", name: "bash", tool_call_id: "c1", content: "TOOL ERROR: exit 1" },
    ], options);
    expect(blocks[0]!.entry?.status).toBe("failed");
  });

  it("renders a tool result whose call was lost to compaction", () => {
    const blocks = buildTranscript([
      { role: "tool", name: "edit_file", tool_call_id: "gone", content: "Edited b.ts (+1 -0)", editPreview: "Edited b.ts (+1 -0)\n     1 +new" },
    ], options);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("tool");
    expect(blocks[0]!.entry?.editPreview).toContain("+new");
  });

  it("does not render the same tool result twice", () => {
    const blocks = buildTranscript([
      { role: "assistant", content: "", tool_calls: [call("c1", "edit_file", '{"path":"a.ts"}')] },
      { role: "tool", name: "edit_file", tool_call_id: "c1", content: "Edited a.ts (+1 -0)", editPreview: "Edited a.ts (+1 -0)\n     1 +x" },
    ], options);
    expect(blocks).toHaveLength(1);
  });

  it("notes compaction summaries instead of dropping them silently", () => {
    const blocks = buildTranscript([
      { role: "system", content: "[luban context summary]\n- did things" },
      { role: "user", content: "next" },
    ], options);
    expect(blocks[0]).toMatchObject({ kind: "note", text: "较早对话已压缩为摘要" });
  });

  it("skips the system prompt and quiet tool results", () => {
    const blocks = buildTranscript([
      { role: "system", content: "You are luban" },
      { role: "tool", name: "read_file", tool_call_id: "x", content: "just a read" },
    ], options);
    expect(blocks).toEqual([]);
  });

  it("estimates wrapping so a long message reserves more lines than a short one", () => {
    expect(estimateLines("one line", 80)).toBe(1);
    expect(estimateLines("x".repeat(200), 80)).toBe(3);
    expect(estimateLines("a\n\nb", 80)).toBe(3);
    const long = buildTranscript([{ role: "user", content: "y".repeat(400) }], options);
    const short = buildTranscript([{ role: "user", content: "y" }], options);
    expect(transcriptHeight(long)).toBeGreaterThan(transcriptHeight(short));
  });
});

describe("runtime notes", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: "working" },
  ] as ChatMessage[];

  it("interleaves notes where they happened instead of collecting them at the end", () => {
    const blocks = buildTranscript(messages, {
      expanded: false,
      width: 80,
      notes: [
        { id: "late", text: "模型返回 HTTP 429，0.5s 后重试（第 2/4 次）", at: 2, tone: "accent" },
        { id: "early", text: "Reviewing tool results", at: 1 },
      ],
    });
    // The retry explanation must sit next to the step it retried, which is the
    // only way a reader can tell what the run was waiting for.
    expect(blocks.map(block => block.id)).toEqual(["user-0", "activity-early", "assistant-1", "activity-late"]);
    expect(blocks.find(block => block.id === "activity-late")).toMatchObject({ kind: "note", tone: "accent" });
  });

  it("keeps interruption notices in order after history compaction", () => {
    const removed = { role: "assistant", content: "old output" } as ChatMessage;
    const blocks = buildTranscript(messages, {
      expanded: false, width: 80,
      notes: [
        { id: "old-error", text: "stream interrupted", at: 50, after: removed },
        { id: "retry", text: "retrying", at: 51, after: messages[0] },
      ],
    });
    expect(blocks.map(block => block.id)).toEqual([
      "activity-old-error", "user-0", "activity-retry", "assistant-1",
    ]);
  });

  it("renders nothing extra when no notes were collected", () => {
    expect(buildTranscript(messages, { expanded: false, width: 80 }).map(block => block.id)).toEqual(["user-0", "assistant-1"]);
  });
});


it("settles live execution records before the session receives the result", () => {
  const blocks = buildTranscript([
    { role: "assistant", content: "", tool_calls: [call("live", "edit_file", '{"path":"a.ts"}')] },
  ], { ...options, executions: [{ id: "live", name: "edit_file", detail: "a.ts", status: "done", elapsedMs: 20,
    editPreview: "Edited a.ts (+1 -1)\n     1 -old\n     1 +new" }] });
  expect(blocks[0]!.entry).toMatchObject({ status: "done", elapsedMs: 20 });
  const rows = blocks[0]!.rows ?? [];
  // A wide terminal pairs the removed line with its replacement.
  expect(rows.some(row => row.kind === "edit-pair" && row.left?.text === "old" && row.right?.text === "new")).toBe(true);
  // A narrow one keeps the unified line the record stores.
  const narrow = buildTranscript([
    { role: "assistant", content: "", tool_calls: [call("live", "edit_file", '{"path":"a.ts"}')] },
  ], { ...options, width: 40, executions: [{ id: "live", name: "edit_file", detail: "a.ts", status: "done", elapsedMs: 20,
    editPreview: "Edited a.ts (+1 -1)\n     1 -old\n     1 +new" }] });
  expect(narrow[0]!.rows?.map(row => row.text)).toContain("     1 +new");
});
