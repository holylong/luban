import { describe, expect, it } from "vitest";
import { MAX_REMOTE_BLOCKS, chatBlocks, jobBlocks, type RemoteJobView } from "./mesh-transcript.js";
import type { JobStreamEvent, JobStreamRecord } from "../core/mesh/runtime.js";

const records = (events: JobStreamEvent[]): JobStreamRecord[] =>
  events.map((event, index) => ({ seq: index + 1, at: 1_700_000_000 + index, event }));

function job(overrides: Partial<RemoteJobView> = {}): RemoteJobView {
  return {
    id: "job-1", source: "beta", target: "alpha", status: "working",
    instruction: "run the checks", title: "checks", ...overrides,
  };
}

const options = { expanded: true, width: 100, localNode: "alpha" };

describe("remote job blocks", () => {
  it("shows a received task before its first model event", () => {
    const blocks = jobBlocks(job({ status: "queued" }), [], options);
    expect(blocks).toMatchObject([{ kind: "note", text: expect.stringContaining("📥 来自 beta") }]);
  });

  it("shows full chat text with direction on either terminal", () => {
    const chat = { id: "m1", from: "alpha", to: "beta", text: "first line\nsecond line", received_at: 1_700_000_000 };
    expect(chatBlocks([chat], "alpha", 100)).toMatchObject([
      { kind: "note", text: expect.stringContaining("📤 发给 beta") },
      { kind: "assistant", text: chat.text },
    ]);
    expect(chatBlocks([chat], "beta", 100)[0]?.text).toContain("📨 来自 alpha");
  });

  it("groups streamed answer text and keeps notes in order", () => {
    const blocks = jobBlocks(job(), records([
      { kind: "model-call", index: 1 },
      { kind: "delta", text: "I will " },
      { kind: "delta", text: "check the tests." },
      { kind: "status", text: "Reviewing tool results" },
    ]), options);
    expect(blocks.map((block) => block.kind)).toEqual(["note", "assistant", "note"]);
    expect(blocks[0]!.text).toContain("📥 来自 beta");
    expect(blocks[0]!.text).toContain("run the checks");
    expect(blocks[1]!.text).toBe("I will check the tests.");
    expect(blocks[2]!.text).toBe("Reviewing tool results");
  });

  it("keeps a running tool row in place and upgrades it with its edit record", () => {
    const blocks = jobBlocks(job(), records([
      { kind: "tool-start", callId: "c1", name: "edit_file", args: { path: "src/a.ts" }, summary: "src/a.ts" },
      { kind: "tool-end", callId: "c1", name: "edit_file", ok: true, elapsedMs: 12, preview: "applied",
        editPreview: "Edited src/a.ts (+1 -1)\n    12 -old line\n    12 +new line" },
    ]), options);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: "tool", entry: { name: "Edit", detail: "src/a.ts", status: "done", elapsedMs: 12 } });
    // The inline record (path, counts, line numbers, before/after) must survive
    // the trip from the peer, because that is the only evidence of the edit.
    expect(blocks[1]!.entry?.editPreview).toContain("Edited src/a.ts (+1 -1)");
    expect(blocks[1]!.rows?.some((row) => row.kind === "edit")).toBe(true);
  });

  it("marks work this node handed off rather than received", () => {
    const outbound = jobBlocks(job({ source: "alpha", target: "beta" }), records([
      { kind: "delta", text: "done" },
    ]), options);
    expect(outbound[0]!.text).toContain("📤 已交给 beta");
  });

  it("reports the outcome and the model round trips", () => {
    const done = jobBlocks(job({ status: "done", result: "all good" }), records([
      { kind: "model-call", index: 1 },
      { kind: "delta", text: "all good" },
      { kind: "model-call", index: 2 },
    ]), options);
    expect(done.at(-1)).toMatchObject({ kind: "note", tone: "green" });
    expect(done.at(-1)!.text).toContain("任务完成 · 2 次模型调用");

    const failed = jobBlocks(job({ status: "failed", error: "sandbox denied" }), records([
      { kind: "error", text: "sandbox denied" },
    ]), options);
    expect(failed.at(-1)).toMatchObject({ kind: "note", tone: "red" });
    expect(failed.at(-1)!.text).toContain("sandbox denied");
  });

  it("falls back to the stored result when the stream was never seen", () => {
    const blocks = jobBlocks(job({ status: "done", result: "summary from the record" }), records([
      { kind: "status", text: "Compacted 3 older messages" },
    ]), options);
    expect(blocks.some((block) => block.kind === "assistant" && block.text === "summary from the record")).toBe(true);
  });

  it("bounds how much one job may add to the stream", () => {
    const flood = records(Array.from({ length: MAX_REMOTE_BLOCKS + 60 }, (_, index) =>
      ({ kind: "status", text: `note ${index}` }) satisfies JobStreamEvent));
    expect(jobBlocks(job(), flood, options)).toHaveLength(MAX_REMOTE_BLOCKS);
  });
});
