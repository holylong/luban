import { basename, isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../core/types.js";
import { buildSessionMarkdown, collectExportedEdits, defaultExportFilename, expandExportPath, summarizeEdits } from "./session-export.js";

describe("session export", () => {
  it("renders users, answers and tool summaries while skipping system and tool results", () => {
    const markdown = buildSessionMarkdown(
      [
        { role: "system", content: "You are luban" },
        { role: "user", content: "fix it" },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        { role: "tool", name: "read_file", tool_call_id: "c1", content: "contents" },
        { role: "assistant", content: "Fixed and tested." },
      ],
      { project: "myapp", workspace: "/srv/myapp", nodeName: "n1", modelId: "m", mode: "agent", running: false },
    );
    expect(markdown).toContain("# luban 会话记录 — myapp");
    expect(markdown).toContain("## 👤 用户\n\nfix it");
    expect(markdown).toContain("- `read_file`");
    expect(markdown).toContain("## 🤖 luban\n\nFixed and tested.");
    expect(markdown).not.toContain("You are luban");
    expect(markdown).not.toContain("contents");
  });

  it("includes the tool call arguments, including the full shell command", () => {
    const markdown = buildSessionMarkdown(
      [
        { role: "user", content: "run it" },
        { role: "assistant", content: "", tool_calls: [
          { id: "b1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "npm test\nnpm run build" }) } },
          { id: "r1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) } },
        ] },
      ],
      { project: "p", workspace: "/w", nodeName: "n", modelId: "m", mode: "auto", running: false },
    );
    expect(markdown).toContain("- `bash`");
    expect(markdown).toContain("npm test");
    expect(markdown).toContain("npm run build");
    expect(markdown).toContain("- `read_file` · path=src/a.ts");
  });

  it("keeps compaction summaries and pending steering", () => {
    const markdown = buildSessionMarkdown(
      [{ role: "system", content: "[luban context summary]\n- did X" }],
      { project: "", workspace: "/w", nodeName: "n", modelId: "m", mode: "auto", running: true },
      { pending: [{ id: "p1", content: "also check bar", delivery: "steer", createdAt: new Date().toISOString() }] },
    );
    expect(markdown).toContain("较早对话已压缩为摘要");
    expect(markdown).toContain("- did X");
    expect(markdown).toContain("- [steer] also check bar");
    expect(markdown).toContain("任务状态: 进行中");
  });

  it("resolves the default filename and user paths", () => {
    expect(defaultExportFilename("my app!")).toBe("luban-export-my-app.md");
    // The session id keeps repeated exports from overwriting each other.
    expect(defaultExportFilename("my app!", "20260916-abc123")).toBe("luban-export-my-app-20260916-abc123.md");
    expect(basename(expandExportPath("", "myapp"))).toBe("luban-export-myapp.md");
    expect(basename(expandExportPath("", "myapp", "20260916-abc123"))).toBe("luban-export-myapp-20260916-abc123.md");
    expect(isAbsolute(expandExportPath("~/out.md", "myapp"))).toBe(true);
    expect(expandExportPath("~/out.md", "myapp")).toContain("out.md");
    // A user-chosen name is honoured; a missing .md extension is added.
    expect(basename(expandExportPath("my-notes", "myapp"))).toBe("my-notes.md");
    expect(basename(expandExportPath("notes.md", "myapp"))).toBe("notes.md");
    expect(basename(expandExportPath("~/reports/session one", "myapp"))).toBe("session one.md");
  });
});

describe("edit records in the export", () => {
  const editPreviewText = [
    "Edited src/app.ts (+2 -1)",
    "     4  const a = 1;",
    "     5 -const b = 2;",
    "     5 +const b = 3;",
    "     6 +const c = 4;",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "user", content: "change b" },
    {
      role: "assistant", content: "editing",
      tool_calls: [{ id: "c1", type: "function", function: { name: "edit_file", arguments: "{}" } }],
    },
    { role: "tool", name: "edit_file", tool_call_id: "c1", content: "Edited src/app.ts (+2 -1)", editPreview: editPreviewText },
    { role: "assistant", content: "done" },
  ];
  const meta = { project: "myapp", workspace: "/srv/myapp", nodeName: "n1", modelId: "m", mode: "agent", running: false };

  it("includes the actual before/after content, not just the file name", () => {
    const markdown = buildSessionMarkdown(messages, meta);
    expect(markdown).toContain("const b = 2;");
    expect(markdown).toContain("const b = 3;");
    expect(markdown).toContain("const c = 4;");
    expect(markdown).toContain("const a = 1;");
  });

  it("records the file path, the added/removed counts and the line numbers", () => {
    const markdown = buildSessionMarkdown(messages, meta);
    expect(markdown).toContain("`src/app.ts` (+2 −1) · L4–L6");
    expect(markdown).toContain("| `src/app.ts` | edit_file | +2 | −1 | L4–L6 |");
    expect(markdown).toContain("文件修改: 1 个文件 · +2 −1");
    // Line numbers survive into the fenced diff.
    expect(markdown).toMatch(/^\s+5 -const b = 2;$/mu);
    expect(markdown).toMatch(/^\s+6 \+const c = 4;$/mu);
  });

  it("renders each diff exactly once", () => {
    const markdown = buildSessionMarkdown(messages, meta);
    expect(markdown.match(/const b = 2;/gu)).toHaveLength(1);
    expect(markdown.match(/const c = 4;/gu)).toHaveLength(1);
  });

  it("keeps the record when compaction dropped the tool message", () => {
    const compacted: ChatMessage[] = [
      { role: "system", content: "[luban context summary]\n- edited a file" },
      { role: "assistant", content: "done" },
    ];
    const markdown = buildSessionMarkdown(compacted, meta, { edits: [{ id: "c1", name: "edit_file", preview: editPreviewText }] });
    expect(markdown).toContain("const b = 3;");
    expect(markdown).toContain("| `src/app.ts` | edit_file | +2 | −1 | L4–L6 |");
    expect(markdown).toContain("已被上下文压缩");
  });

  it("counts distinct files even when one file is edited repeatedly", () => {
    const twice: ChatMessage[] = [
      { role: "tool", name: "edit_file", tool_call_id: "c1", content: "x", editPreview: "Edited a.ts (+1 -0)\n     1 +one" },
      { role: "tool", name: "edit_file", tool_call_id: "c2", content: "x", editPreview: "Edited a.ts (+1 -1)\n     1 -one\n     1 +two" },
      { role: "tool", name: "write_file", tool_call_id: "c3", content: "x", editPreview: "Edited b.ts (+2 -0)\n     1 +a\n     2 +b" },
    ];
    const totals = summarizeEdits(collectExportedEdits(twice));
    expect(totals).toEqual({ files: 2, added: 4, removed: 1 });
  });

  it("keeps a failed tool result so the log is not misleading", () => {
    const withFailure: ChatMessage[] = [
      { role: "tool", name: "bash", tool_call_id: "c9", content: "TOOL ERROR: exit 1\nline a\nline b" },
    ];
    const markdown = buildSessionMarkdown(withFailure, meta);
    expect(markdown).toContain("⚠️ TOOL ERROR: exit 1");
    expect(markdown).toContain("line a");
  });

  it("says nothing about edits when a session changed no files", () => {
    const markdown = buildSessionMarkdown([{ role: "user", content: "hi" }], meta);
    expect(markdown).toContain("文件修改: 0 个文件 · +0 −0");
    expect(markdown).not.toContain("## 修改记录");
  });
});

describe("plan and verification in the export", () => {
  const meta = { project: "p", workspace: "/w", nodeName: "n", modelId: "m", mode: "agent", running: false };

  it("lists the task plan with its verification gate", () => {
    const markdown = buildSessionMarkdown([{ role: "user", content: "go" }], meta, {
      plan: { explanation: "Two steps.", plan: [
        { step: "edit the file", status: "completed" },
        { step: "run tests", status: "in_progress" },
        { step: "report", status: "pending" },
      ] },
      planVerified: false,
    });
    expect(markdown).toContain("## 任务计划");
    expect(markdown).toContain("Two steps.");
    expect(markdown).toContain("- [x] edit the file");
    expect(markdown).toContain("- [→] run tests");
    expect(markdown).toContain("- [ ] report");
    expect(markdown).toContain("验证门禁: ○ 未满足");
  });

  it("lists verification records with counts and the failing output", () => {
    const markdown = buildSessionMarkdown([{ role: "user", content: "go" }], meta, {
      plan: { explanation: "", plan: [{ step: "run tests", status: "completed" }] },
      planVerified: true,
      verifications: [
        { id: "v1", command: "npm test", status: "failed", output: "1 test failed\n  expected 1 got 2", createdAt: "2026-09-15T10:00:00.000Z" },
        { id: "v2", command: "npm test", status: "passed", output: "all good", createdAt: "2026-09-15T10:05:00.000Z" },
      ],
    });
    expect(markdown).toContain("## 验证记录 (2 次 · 1 通过 · 1 失败)");
    expect(markdown).toContain("| ✓ 通过 | `npm test` | 2026-09-15 10:05:00 |");
    expect(markdown).toContain("失败输出 · `npm test`");
    expect(markdown).toContain("expected 1 got 2");
    expect(markdown).toContain("验证门禁: ✓ 已完成步骤均有通过记录");
  });

  it("omits the sections when the session has neither", () => {
    const markdown = buildSessionMarkdown([{ role: "user", content: "hi" }], meta);
    expect(markdown).not.toContain("## 任务计划");
    expect(markdown).not.toContain("## 验证记录");
  });
});
