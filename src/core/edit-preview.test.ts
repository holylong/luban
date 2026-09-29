import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editDisplayRows, editPairText, editPreview, parseEditRecord } from "./edit-preview.js";
import { createTools } from "./tools.js";
import { SessionStore } from "./session-store.js";
import type { LubanConfig } from "./types.js";

describe("inline edits", () => {
  it("shows separate hunks with actual line numbers and insertion/deletion counts", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 2\n", "new 2\nextra\n").replace("line 18", "new 18");
    const result = editPreview("a.ts", before, after);
    expect(result).toContain("Edited a.ts (+3 -2)");
    expect(result).toMatch(/2 -line 2/);
    expect(result).toMatch(/3 \+extra/);
    expect(result).toMatch(/19 \+new 18/);
    expect(result).toContain("⋮");
  });

  it("captures real preexisting content for writes without a git repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-inline-"));
    await writeFile(join(root, "a.ts"), "user's uncommitted code\n");
    const config = { home: root, workspace: root, project: "test", backendUrl: "" } as LubanConfig;
    const tools = createTools(config);
    const output = await tools.get("write_file")!.execute({ path: "a.ts", content: "new code\n" }, new AbortController().signal);
    expect(output).toContain("Edited a.ts (+1 -1)");
    expect(output).toContain("-user's uncommitted code");
    expect(output).toContain("+new code");
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("new code\n");
    await expect(tools.get("edit_file")!.execute({ path: "a.ts", old_text: "missing", new_text: "x" }, new AbortController().signal)).rejects.toThrow("not found");
  });

  it("keeps historical edit details when compacted messages are saved and reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "luban-inline-session-"));
    const store = new SessionStore(root);
    const preview = editPreview("a.ts", "old\n", "new\n");
    const session = store.create("test", root, "agent", "test", [
      { role: "user", content: "edit" },
      { role: "tool", name: "edit_file", tool_call_id: "edit-1", content: preview, editPreview: preview },
    ]);
    await store.save(session);
    session.messages = [{ role: "user", content: "continue" }];
    await store.save(session);
    expect((await store.load(session.id))?.edits).toEqual([{ id: "edit-1", name: "edit_file", preview }]);
  });
});

describe("side-by-side edit rows", () => {
  it("pairs each removal with the addition that replaces it", () => {
    const rows = parseEditRecord("Edited a.ts (+1 -1)\n     2 -old\n     2 +new");
    expect(editDisplayRows(rows)).toEqual([
      { kind: "header", text: "Edited a.ts (+1 -1)" },
      { kind: "pair", left: { kind: "remove", line: 2, text: "old" }, right: { kind: "add", line: 2, text: "new" } },
    ]);
  });

  it("pads the shorter side when a change deletes more than it inserts", () => {
    const rows = parseEditRecord("Edited a.ts (+1 -3)\n     1 -one\n     2 -two\n     3 -three\n     3 +three");
    const pairs = editDisplayRows(rows).filter(row => row.kind === "pair");
    // Top-aligned like a unified diff: the addition replaces the first removal.
    expect(pairs).toEqual([
      { kind: "pair", left: { kind: "remove", line: 1, text: "one" }, right: { kind: "add", line: 3, text: "three" } },
      { kind: "pair", left: { kind: "remove", line: 2, text: "two" }, right: { kind: "empty", text: "" } },
      { kind: "pair", left: { kind: "remove", line: 3, text: "three" }, right: { kind: "empty", text: "" } },
    ]);
  });

  it("keeps context on both sides and starts a new pair list at each header", () => {
    const rows = parseEditRecord("Edited a.ts (+1 -1)\n     1  keep\n     2 -old\n     2 +new\nEdited b.ts (+1 -0)\n     5 +only");
    expect(editDisplayRows(rows)).toEqual([
      { kind: "header", text: "Edited a.ts (+1 -1)" },
      { kind: "pair", left: { kind: "context", line: 1, text: "keep" }, right: { kind: "context", line: 1, text: "keep" } },
      { kind: "pair", left: { kind: "remove", line: 2, text: "old" }, right: { kind: "add", line: 2, text: "new" } },
      { kind: "header", text: "Edited b.ts (+1 -0)" },
      { kind: "pair", left: { kind: "empty", text: "" }, right: { kind: "add", line: 5, text: "only" } },
    ]);
  });

  it("flattens a pair to one line for text-only surfaces", () => {
    expect(editPairText({ kind: "context", line: 1, text: "same" }, { kind: "context", line: 1, text: "same" })).toBe("  same");
    expect(editPairText({ kind: "remove", line: 2, text: "old" }, { kind: "add", line: 2, text: "new" })).toBe("- old  + new");
    expect(editPairText({ kind: "empty", text: "" }, { kind: "add", line: 3, text: "only" })).toBe("+ only");
  });
});
