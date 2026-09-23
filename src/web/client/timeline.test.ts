import { describe, expect, it } from "vitest";
import { deriveTimeline, editRecordStats, liveProgress, parseEditRecord, STALL_SECONDS, toolLabel, withOutcome } from "./timeline";
import { parseUnifiedDiff } from "./preview";
import type { JobStreamRecord, MeshJob } from "./types";

const job = { id: "job-1", instruction: "fix the bug", created_at: 1_700_000_000, mode: "edits" };

function record(seq: number, event: JobStreamRecord["event"]): JobStreamRecord {
  return { seq, at: 1_700_000_000 + seq, event };
}

describe("deriveTimeline", () => {
  it("merges streamed deltas into one assistant bubble and closes it on a tool call", () => {
    const items = deriveTimeline(job, [
      record(1, { kind: "status", text: "reading workspace" }),
      record(2, { kind: "delta", text: "I will " }),
      record(3, { kind: "delta", text: "inspect the file." }),
      record(4, { kind: "tool-start", callId: "c1", name: "read_file", args: { path: "a.ts" }, summary: "a.ts" }),
      record(5, { kind: "tool-end", callId: "c1", name: "read_file", ok: true, elapsedMs: 12, preview: "line" }),
      record(6, { kind: "delta", text: "Now fixing it." }),
    ]);
    expect(items.map(item => item.kind)).toEqual(["user", "status", "assistant", "tool", "assistant"]);
    const assistants = items.filter(item => item.kind === "assistant");
    expect(assistants[0]).toMatchObject({ text: "I will inspect the file." });
    expect(assistants[1]).toMatchObject({ text: "Now fixing it." });
  });

  it("keeps a re-announced phase label out of the transcript", () => {
    // The server reports progress once per step; as a bubble the console showed
    // one identical row per step of a long job.
    const items = deriveTimeline(job, [
      record(1, { kind: "delta", text: "Checking the tests." }),
      record(2, { kind: "status", text: "Reviewing tool results", progress: true }),
      record(3, { kind: "tool-start", callId: "c7", name: "bash", args: { command: "npm test" }, summary: "npm test" }),
    ]);
    expect(items.map(item => item.kind)).toEqual(["user", "assistant", "tool"]);
    expect(items.some(item => item.kind === "status")).toBe(false);
  });

  it("keeps a tool row in place and upgrades it when the matching tool-end arrives", () => {
    const started = deriveTimeline(job, [
      record(1, { kind: "tool-start", callId: "c9", name: "edit_file", args: { path: "x.ts" }, summary: "x.ts" }),
    ]);
    expect(started[1]).toMatchObject({ kind: "tool", run: { status: "running", name: "edit_file" } });
    const finished = deriveTimeline(job, [
      record(1, { kind: "tool-start", callId: "c9", name: "edit_file", args: { path: "x.ts" }, summary: "x.ts" }),
      record(2, { kind: "tool-end", callId: "c9", name: "edit_file", ok: true, elapsedMs: 20, preview: "ok", editPreview: "Edited x.ts (+1 -1)\n     1 -old\n     1 +new" }),
    ]);
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({ kind: "tool", run: { status: "done", editPreview: expect.stringContaining("Edited x.ts") } });
  });

  it("survives a tool-end whose start was evicted from the bounded buffer", () => {
    const items = deriveTimeline(job, [
      record(40, { kind: "tool-end", callId: "gone", name: "bash", ok: false, elapsedMs: 5, preview: "boom" }),
    ]);
    expect(items[1]).toMatchObject({ kind: "tool", run: { callId: "gone", status: "failed", preview: "boom" } });
  });

  it("appends the outcome only for terminal or paused jobs", () => {
    const base = deriveTimeline(job, []);
    const running = withOutcome(base, { ...job, status: "working", result: "", error: "" } as MeshJob);
    expect(running).toHaveLength(1);
    const failed = withOutcome(base, { ...job, status: "failed", result: "", error: "boom" } as MeshJob);
    expect(failed.at(-1)).toMatchObject({ kind: "result", text: "boom", status: "failed" });
    const paused = withOutcome(base, { ...job, status: "paused", result: "half done", error: "" } as MeshJob);
    expect(paused.at(-1)).toMatchObject({ kind: "result", text: "half done", status: "paused" });
    const done = withOutcome(base, { ...job, status: "done", result: "all good", error: "" } as MeshJob);
    expect(done.at(-1)).toMatchObject({ kind: "result", text: "all good", status: "done" });
  });
});

describe("parseEditRecord", () => {
  const preview = [
    "Edited src/app.ts (+2 -1)",
    "     4  const a = 1;",
    "     5 -const b = 2;",
    "     5 +const b = 3;",
    "     6 +const c = 4;",
    "    ⋮",
  ].join("\n");

  it("preserves the file path, line numbers and before/after content", () => {
    const rows = parseEditRecord(preview);
    expect(rows[0]).toEqual({ kind: "header", text: "src/app.ts", changes: 3 });
    expect(rows[1]).toMatchObject({ kind: "context", line: 4, text: "const a = 1;" });
    expect(rows[2]).toMatchObject({ kind: "remove", line: 5, text: "const b = 2;" });
    expect(rows[3]).toMatchObject({ kind: "add", line: 5, text: "const b = 3;" });
    expect(rows.at(-1)).toEqual({ kind: "meta", text: "⋮" });
  });

  it("computes the added/removed counts and the touched line range", () => {
    const stats = editRecordStats(parseEditRecord(preview));
    expect(stats).toEqual({ path: "src/app.ts", added: 2, removed: 1, firstLine: 4, lastLine: 6 });
  });

  it("parses the record shape that edit-preview actually emits", () => {
    const rows = parseEditRecord("Edited big.txt (+1 -1)\n     1 -old line\n     1 +new line");
    expect(rows.filter(row => row.kind === "add")[0]).toMatchObject({ line: 1, text: "new line" });
    expect(rows.filter(row => row.kind === "remove")[0]).toMatchObject({ line: 1, text: "old line" });
    expect(editRecordStats(rows)).toMatchObject({ path: "big.txt", added: 1, removed: 1, firstLine: 1, lastLine: 1 });
  });

  it("keeps trailer notes visible", () => {
    const rows = parseEditRecord("Edited a.txt (+0 -0)\n    (no content change)");
    expect(rows.at(-1)).toEqual({ kind: "meta", text: "(no content change)" });
  });
});

describe("parseUnifiedDiff", () => {
  it("splits a git diff into per-file rows with add/remove classification", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " keep",
      "-gone",
      "+added",
      "+also added",
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,1 @@",
      "+hello",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files.map(file => file.path)).toEqual(["src/a.ts", "new.txt"]);
    expect(files[0]!.rows.filter(row => row.kind === "add").map(row => row.text)).toEqual(["added", "also added"]);
    expect(files[0]!.rows.filter(row => row.kind === "del").map(row => row.text)).toEqual(["gone"]);
    expect(files[0]!.rows.some(row => row.kind === "hunk")).toBe(true);
    expect(files[1]!.rows.at(-1)).toEqual({ kind: "add", text: "hello" });
  });

  it("returns nothing for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("toolLabel", () => {
  it("maps known tools and falls back to the raw name", () => {
    expect(toolLabel("edit_file")).toBe("Edit");
    expect(toolLabel("totally_new_tool")).toBe("totally_new_tool");
  });
});

describe("liveProgress", () => {
  const base = 1_700_000_000;
  const stamped = (seq: number, at: number, event: JobStreamRecord["event"]): JobStreamRecord => ({ seq, at: base + at, event });

  it("reads the phase, the step clock and the silence from the buffer tail", () => {
    const events = [
      stamped(1, 0, { kind: "status", text: "start" }),
      stamped(2, 1, { kind: "model-call", index: 2 }),
      stamped(3, 4, { kind: "thinking", text: "先读" }),
      stamped(4, 5, { kind: "thinking", text: "config.ts 的默认值" }),
    ];
    const live = liveProgress(events, base + 90);
    expect(live).toMatchObject({ label: "推理中", detail: "先读config.ts 的默认值", seconds: 89, silentSeconds: 85, stalled: true });
    expect(live!.silentSeconds).toBeGreaterThan(STALL_SECONDS);
  });

  it("keeps the answer as the detail and does not call a fresh step stalled", () => {
    const events = [
      stamped(1, 0, { kind: "model-call", index: 1 }),
      stamped(2, 2, { kind: "delta", text: "我会先" }),
      stamped(3, 3, { kind: "delta", text: "\n检查 sandbox。" }),
    ];
    expect(liveProgress(events, base + 8)).toMatchObject({ label: "生成回复", detail: "检查 sandbox。", seconds: 8, stalled: false });
  });

  it("names the running tool and never reports its quiet run as a stall", () => {
    const events = [
      stamped(1, 0, { kind: "model-call", index: 1 }),
      stamped(2, 2, { kind: "tool-start", callId: "c1", name: "bash", args: {}, summary: "Shell · npm run build" }),
    ];
    expect(liveProgress(events, base + 400)).toMatchObject({ label: "执行工具", detail: "Shell · npm run build", stalled: false, silentSeconds: 398 });
  });

  it("returns nothing before the first event", () => {
    expect(liveProgress([])).toBeNull();
  });
});
